'use strict';

/**
 * Settings — small persistent preference bag in localStorage.
 * Loaded on every page, because the settings drawer lives in the layout.
 */
const Settings = (() => {
  const KEY = 'cl-settings';

  // The intervals.icu key is deliberately NOT part of the settings blob.
  //
  // Keeping it in its own slot means it can be given its own lifetime (session
  // or persistent), purged on its own, and never ride along in a settings
  // export or a debug dump of `cl-settings`. There is no CritLab server, so
  // this browser is the only place the key exists — which makes where exactly
  // it lives worth being deliberate about.
  const ICU_KEY_STORE = 'cl-icu-key';

  const DEFAULTS = {
    // intervals.icu (the key itself lives in ICU_KEY_STORE, not here)
    icuAthlete: '', icuAthleteName: '',
    icuKeyPersist: 'local',        // 'local' = remembered · 'session' = until the tab closes

    // weather
    wxAuto: true, wxRoughness: 0.1,

    // map
    osmBasemap: true,

    // recording habits — things only the rider knows
    startsOnStartLine: false,

    // rider + machine
    mass: 78, crr: 0.004, cda: 0.32, lockCda: false,
    driveEff: 0.976, rotMass: 1.2, yawK: 0.15,
    ftp: 250, cp: 250, wPrime: 20000,

    // model
    windSource: 'weather', windSpeed: 0, windDir: 0,
    cleanAirPct: 0.85,
    exposedAt: 0.95, shelteredAt: 0.75,
    surgeFactor: 1.4,
    finaleLaps: 3,
  };

  let cache = null;

  function store(kind) {
    try { return kind === 'session' ? sessionStorage : localStorage; } catch (_) { return null; }
  }

  /** Read the key from wherever it was put. Session wins — it is the fresher one. */
  function getIcuKey() {
    try {
      const s = store('session'), l = store('local');
      return (s && s.getItem(ICU_KEY_STORE)) || (l && l.getItem(ICU_KEY_STORE)) || '';
    } catch (_) { return ''; }
  }

  /**
   * @param {string} key   the API key, or '' to forget it
   * @param {string} [persist] 'local' to remember across sessions, 'session' to
   *        drop it when the tab closes. Defaults to the saved preference.
   */
  function setIcuKey(key, persist) {
    const how = persist || get('icuKeyPersist') || 'local';
    // Always clear both first, so switching modes never leaves a stale copy
    // sitting in the store the user thinks they stopped using.
    try { const l = store('local'); if (l) l.removeItem(ICU_KEY_STORE); } catch (_) {}
    try { const s = store('session'); if (s) s.removeItem(ICU_KEY_STORE); } catch (_) {}
    if (!key) return;
    try {
      const target = store(how === 'session' ? 'session' : 'local');
      if (target) target.setItem(ICU_KEY_STORE, key);
    } catch (_) {}
  }

  function forgetIcuKey() { setIcuKey(''); }

  function all() {
    if (cache) return cache;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}

    // Migration: earlier builds kept the key inside the settings blob. Move it
    // to its own slot and scrub it from the blob on the way past.
    if (stored.icuKey) {
      const legacy = stored.icuKey;
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
      setIcuKey(legacy, cache.icuKeyPersist);
    } else {
      delete stored.icuKey;
      cache = { ...DEFAULTS, ...stored };
    }
    return cache;
  }

  function get(k) {
    // all() first even for the key: it is what performs the one-time migration
    // out of the legacy settings blob, and reading the key is usually the first
    // thing that happens on a page.
    const s = all();
    return k === 'icuKey' ? getIcuKey() : s[k];
  }

  function set(patch) {
    const next = { ...patch };
    if ('icuKey' in next) {
      setIcuKey(next.icuKey, next.icuKeyPersist || get('icuKeyPersist'));
      delete next.icuKey;
    }
    cache = { ...all(), ...next };
    delete cache.icuKey;                       // never let it back into the blob
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
    // Re-home the key if the persistence preference just changed.
    if (next.icuKeyPersist) {
      const existing = getIcuKey();
      if (existing) setIcuKey(existing, next.icuKeyPersist);
    }
    return cache;
  }

  function reset() {
    cache = null;
    try { localStorage.removeItem(KEY); } catch (_) {}
    return all();
  }

  return { all, get, set, reset, DEFAULTS, getIcuKey, setIcuKey, forgetIcuKey, ICU_KEY_STORE };
})();

/**
 * RideStore — normalisation, derived series, and persistence.
 *
 * Rides arrive from three places (a FIT file, intervals.icu, a JSON export) in
 * three shapes, at irregular sample rates, with different holes in them. Every
 * one is flattened here into a single 1 Hz grid with the derived series the
 * analyser expects, so nothing downstream has to care where it came from.
 */
const RideStore = (() => {

  const DB_NAME = 'critlab';
  const DB_VERSION = 1;
  const STORE = 'rides';

  // ── Normalisation ─────────────────────────────────────────────────────────

  /**
   * Resample a raw ride onto a uniform 1 Hz grid and compute derived series.
   *
   * Recording gaps (auto-pause at a stoplight, a dropped connection) are not
   * interpolated across: distance holds, speed and power go to zero, and the
   * samples are flagged so the analyser can exclude them. Inventing watts to
   * fill a hole would put phantom efforts in the surge ledger.
   */
  function prepare(raw, cfg) {
    let src = raw.t.map(Number);
    let raw0 = 0, rawN = src.length;

    // A crop is applied here, before anything is derived, so that every
    // downstream number — laps, W′, exposure, sector medians — is computed on
    // the race alone. Trimming afterwards would leave W′ already drained by the
    // warm-up and the percentages diluted by the cool-down.
    if (raw.crop && isFinite(raw.crop.startT) && isFinite(raw.crop.endT)) {
      const t0abs = src[0];
      while (raw0 < src.length - 1 && src[raw0] - t0abs < raw.crop.startT) raw0++;
      rawN = raw0;
      while (rawN < src.length && src[rawN] - t0abs <= raw.crop.endT) rawN++;
      if (rawN - raw0 < 10) { raw0 = 0; rawN = src.length; }   // nonsense crop
      src = src.slice(raw0, rawN);
    }
    const clip = a => (Array.isArray(a) || ArrayBuffer.isView(a)) ? Array.prototype.slice.call(a, raw0, rawN) : a;

    const nSrc = src.length;
    if (nSrc < 10) throw new Error('This ride has too few samples to analyse.');

    const dt = 1;
    const t0 = src[0], t1 = src[nSrc - 1];
    const n = Math.floor((t1 - t0) / dt) + 1;
    if (n < 10) throw new Error('This ride is too short to analyse.');
    if (n > 200000) throw new Error('This ride is longer than CritLab handles (>55 h).');

    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i * dt;

    // Which source samples bracket each grid point.
    const lo = new Int32Array(n), hi = new Int32Array(n);
    const frac = new Float64Array(n);
    const gap = new Uint8Array(n);
    {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const want = t0 + i * dt;
        while (s < nSrc - 2 && src[s + 1] <= want) s++;
        const a = s, b = Math.min(nSrc - 1, s + 1);
        lo[i] = a; hi[i] = b;
        const span = src[b] - src[a];
        frac[i] = span > 0 ? Math.min(1, Math.max(0, (want - src[a]) / span)) : 0;
        if (span > 3) gap[i] = 1;               // recording hole
      }
    }

    const resample = (series, { hold = false } = {}) => {
      if (!series) return null;
      const out = new Float64Array(n);
      let lastGood = 0;
      for (let i = 0; i < n; i++) {
        const a = series[lo[i]], b = series[hi[i]];
        let v;
        if (gap[i]) {
          // Don't invent values across a hole: hold the last real reading, or zero.
          v = hold ? (a != null && isFinite(a) ? a : lastGood) : 0;
        } else if (a == null && b == null) {
          v = lastGood;
        } else if (a == null) { v = b; }
        else if (b == null) { v = a; }
        else { v = a + (b - a) * frac[i]; }
        if (!isFinite(v)) v = lastGood;
        out[i] = v;
        lastGood = v;
      }
      return out;
    };

    // Position and altitude hold through a gap (you were parked, not teleported).
    const lat = raw.lat ? resampleGeo(clip(raw.lat), n, lo, hi, frac, gap) : null;
    const lon = raw.lon ? resampleGeo(clip(raw.lon), n, lo, hi, frac, gap) : null;
    const alt = resample(clip(raw.alt), { hold: true }) || new Float64Array(n);
    const hr = resample(clip(raw.hr), { hold: true });
    const cad = resample(clip(raw.cad));
    const temp = resample(clip(raw.temp), { hold: true });
    const watts = resample(clip(raw.watts)) || new Float64Array(n);

    // Distance is monotone and holds across gaps.
    let dist = resample(clip(raw.dist), { hold: true });
    let v = resample(clip(raw.v));

    if (!dist && !v) throw new Error('This ride has neither speed nor distance data.');

    if (!dist) {
      dist = new Float64Array(n);
      for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.max(0, v[i]) * dt;
    } else {
      // Enforce monotonicity — interpolation across a reset can go backwards.
      for (let i = 1; i < n; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
    }

    if (!v) {
      v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        v[i] = Math.max(0, (dist[i1] - dist[i0]) / ((i1 - i0) * dt));
      }
    }
    for (let i = 0; i < n; i++) {
      if (gap[i]) { v[i] = 0; watts[i] = 0; }
      if (!(v[i] >= 0)) v[i] = 0;
      if (!(watts[i] >= 0)) watts[i] = 0;
    }

    // Derived series.
    const movingSpeed = cfg && cfg.movingSpeed != null ? cfg.movingSpeed : 2.5;
    const moving = new Uint8Array(n);
    for (let i = 0; i < n; i++) moving[i] = (v[i] > movingSpeed && !gap[i]) ? 1 : 0;

    const altS = Physics.smooth(alt, 9);
    const slope = Physics.gradientSeries(altS, dist, 30);
    const theta = new Float64Array(n);
    for (let i = 0; i < n; i++) theta[i] = Math.atan(slope[i]);

    const accel = Physics.derivative(Physics.smooth(v, 5), t);
    for (let i = 0; i < n; i++) {
      if (!isFinite(accel[i]) || Math.abs(accel[i]) > 6) accel[i] = 0;
    }

    const heading = Physics.headingSeries(lat, lon, n);
    const curvature = curvatureSeries(heading, dist, n, lat);

    // Device lap markers → grid indices.
    let lapIndices = null;
    if (Array.isArray(raw.lapTimes) && raw.lapTimes.length) {
      const set = new Set([0]);
      for (const lt of raw.lapTimes) {
        // lapTimes are relative to the *uncropped* start, so shift them by
        // however much the crop removed from the front.
        const idx = Math.round((lt - (src[0] - raw.t[0])) / dt);
        if (idx > 0 && idx < n) set.add(idx);
      }
      set.add(n - 1);
      lapIndices = Array.from(set).sort((a, b) => a - b);
      if (lapIndices.length < 4) lapIndices = null;
    }

    return {
      id: raw.id, name: raw.name, source: raw.source, sourceId: raw.sourceId || null,
      startTime: raw.startTime ? raw.startTime + (src[0] - raw.t[0]) : null,
      sport: raw.sport || 'cycling',
      n, dt, t,
      lat, lon, alt: altS, v, watts, hr, cad, dist, temp,
      moving, gap, theta, slope, accel, heading, curvature,
      lapIndices,
      crop: raw.crop || null,
      croppedFrom: raw.t.length,
      ftp: raw.ftp || null, weightKg: raw.weightKg || null,
      cp: raw.cp || null, wPrime: raw.wPrime || null,
      totals: raw.totals || {},
      hasPower: watts.some(x => x > 0),
      hasGps: !!lat,
    };
  }

  /** Lat/lon need their own resampler: nulls must not average toward zero. */
  function resampleGeo(series, n, lo, hi, frac, gap) {
    const out = new Float64Array(n);
    let last = null;
    for (let i = 0; i < n; i++) {
      const a = series[lo[i]], b = series[hi[i]];
      const aOk = a != null && isFinite(a) && a !== 0;
      const bOk = b != null && isFinite(b) && b !== 0;
      let v;
      if (gap[i]) v = aOk ? a : (last != null ? last : 0);
      else if (aOk && bOk) v = a + (b - a) * frac[i];
      else if (aOk) v = a;
      else if (bOk) v = b;
      else v = last != null ? last : 0;
      out[i] = v;
      if (v !== 0) last = v;
    }
    return out;
  }

  /**
   * Signed curvature (1/radius, positive = turning right) from heading change
   * per metre travelled. Smoothed, because raw GPS heading at 1 Hz is jittery
   * enough to invent corners on a straight.
   */
  function curvatureSeries(heading, dist, n, lat) {
    const out = new Float64Array(n);
    if (!lat) return out;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
      const ds = dist[i1] - dist[i0];
      if (ds < 2) { out[i] = 0; continue; }
      out[i] = Analyzer.angleDelta(heading[i0], heading[i1]) / ds;
    }
    return Physics.smooth(out, 3);
  }

  /** Attach a per-sample wind field from an hourly weather bundle. */
  function applyWeather(P, wx, roughness) {
    if (!wx || !P.startTime) { P.we = null; P.wn = null; return false; }
    const we = new Float64Array(P.n), wn = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      const s = Weather.at(wx, P.startTime + P.t[i]);
      if (!s) { we[i] = 0; wn[i] = 0; continue; }
      const [e, n] = Weather.windVector(s.windSpeed, s.windDir, roughness);
      we[i] = e; wn[i] = n;
    }
    P.we = we; P.wn = wn;
    return true;
  }

  /** Air density for this ride, preferring measured conditions over defaults. */
  function airDensityFor(P, wx, cfg) {
    let tempC = cfg.temp, rh = null, pressurePa = null;

    if (wx && P.startTime) {
      const mid = Weather.at(wx, P.startTime + P.t[Math.floor(P.n / 2)]);
      if (mid) {
        if (mid.temp != null) tempC = mid.temp;
        rh = mid.humidity;
        if (mid.pressure != null) pressurePa = mid.pressure * 100;
      }
    }
    // A head unit's own temperature sensor beats a grid cell, when present.
    if (P.temp) {
      let s = 0, k = 0;
      for (let i = 0; i < P.n; i++) if (isFinite(P.temp[i])) { s += P.temp[i]; k++; }
      if (k > P.n * 0.5) tempC = s / k;
    }
    if (pressurePa == null) {
      const meanAlt = Physics.mean(Array.from(P.alt));
      pressurePa = Physics.pressureAtAltitude(isFinite(meanAlt) ? meanAlt : (cfg.altitude || 0));
    }
    return { rho: Physics.airDensity(tempC, pressurePa, rh), tempC, rh, pressurePa };
  }

  // ── JSON import ───────────────────────────────────────────────────────────

  /** Accept CritLab's own export, an intervals.icu stream dump, or a Strava-ish blob. */
  function fromJson(json, filename) {
    if (json && json.t && (json.watts || json.v || json.dist)) {
      return {
        source: json.source || 'json',
        name: json.name || stripExt(filename),
        startTime: json.startTime || null,
        n: json.t.length,
        t: json.t, lat: json.lat || null, lon: json.lon || null,
        alt: json.alt || null, v: json.v || null, watts: json.watts || null,
        hr: json.hr || null, cad: json.cad || null, dist: json.dist || null,
        temp: json.temp || null, lapTimes: json.lapTimes || [],
        ftp: json.ftp || null, weightKg: json.weightKg || null,
        cp: json.cp || null, wPrime: json.wPrime || null,
        totals: json.totals || {},
      };
    }

    // An array of {type, data} stream objects, or an object keyed by type.
    // `data2` must survive: it is where intervals.icu keeps longitudes.
    const s = {};
    const take = (k, val) => {
      if (!k || !val) return;
      if (Array.isArray(val)) { s[k] = val; return; }
      const data = val.data || val.samples || val.values;
      if (!Array.isArray(data)) return;
      s[k] = data;
      if (Array.isArray(val.data2)) s[k + '__data2'] = val.data2;
    };

    if (Array.isArray(json)) {
      for (const x of json) take(x && x.type, x);
    } else if (json && typeof json === 'object') {
      const src = json.streams || json;
      for (const [k, val] of Object.entries(src)) take(k, val);
    }
    if (!s.time) throw new Error('Could not find a time stream in this JSON file.');

    return Intervals.toRide(
      {
        id: json.id || null,
        name: json.name || stripExt(filename),
        start: json.start_date_local || json.start_date || null,
        startUtc: json.start_date || null,
        type: json.type || 'Ride',
        ftp: json.icu_ftp || null, weight: json.icu_weight || null,
        cp: json.icu_pm_cp || null, wPrime: json.icu_pm_w_prime || null,
      },
      s
    );
  }

  function stripExt(name) {
    return String(name || 'Race').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Race';
  }

  // ── Persistence (IndexedDB) ───────────────────────────────────────────────

  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!self.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' }).createIndex('startTime', 'startTime');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open IndexedDB.'));
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted.'));
    });
  }

  async function put(ride) {
    if (!ride.id) ride.id = makeId(ride);
    await tx('readwrite', s => s.put(stripForStorage(ride)));
    return ride.id;
  }

  async function list() {
    const rows = await tx('readonly', s => s.getAll());
    const all = Array.isArray(rows) ? rows : [];
    all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    return all;
  }

  async function get(id) { return tx('readonly', s => s.get(id)); }
  async function remove(id) { return tx('readwrite', s => s.delete(id)); }
  async function clear() { return tx('readwrite', s => s.clear()); }

  /** Store the raw ride, not the derived arrays — prepare() is cheap to redo. */
  function stripForStorage(ride) {
    const keep = [
      'id', 'name', 'source', 'sourceId', 'startTime', 'sport', 'n',
      't', 'lat', 'lon', 'alt', 'v', 'watts', 'hr', 'cad', 'dist', 'temp',
      'lapTimes', 'ftp', 'weightKg', 'cp', 'wPrime', 'totals', 'device', 'savedAt',
      'startAnchor', 'crop',
    ];
    const out = {};
    for (const k of keep) if (ride[k] !== undefined) out[k] = toPlain(ride[k]);
    out.savedAt = Date.now();
    return out;
  }

  function toPlain(x) {
    return ArrayBuffer.isView(x) ? Array.from(x) : x;
  }

  function makeId(ride) {
    if (ride.source === 'icu' && ride.sourceId) return 'icu-' + ride.sourceId;
    const stamp = ride.startTime || Math.floor(Date.now() / 1000);
    const slug = String(ride.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
    return [ride.source || 'file', stamp, slug].join('-').replace(/-+$/, '');
  }

  // ── Config assembly ───────────────────────────────────────────────────────

  /**
   * Merge saved settings with whatever the ride itself knows (intervals.icu
   * ships FTP, weight, CP and W′ per activity) into one analyser config.
   */
  function configFor(P, overrides) {
    const s = Settings.all();
    const ftp = pickNum(overrides && overrides.ftp, P.ftp, s.ftp);
    const riderKg = pickNum(overrides && overrides.riderKg, P.weightKg, s.mass - 9);
    const cp = pickNum(overrides && overrides.cp, P.cp, s.cp, ftp);

    return {
      mass: pickNum(overrides && overrides.mass, s.mass),
      riderKg,
      crr: pickNum(overrides && overrides.crr, s.crr),
      cda: pickNum(overrides && overrides.cda, s.cda),
      lockCda: !!(overrides && overrides.lockCda !== undefined ? overrides.lockCda : s.lockCda),
      driveEff: s.driveEff, rotMass: s.rotMass,
      yawK: pickNum(overrides && overrides.yawK, s.yawK),

      ftp, cp,
      wPrime: pickNum(overrides && overrides.wPrime, P.wPrime, s.wPrime),

      startAnchor: (overrides && overrides.startAnchor) || null,
      startsOnStartLine: !!s.startsOnStartLine,
      stopSeconds: 20,
      windSource: (overrides && overrides.windSource) || s.windSource,
      windSpeed: pickNum(overrides && overrides.windSpeed, s.windSpeed),
      windDir: pickNum(overrides && overrides.windDir, s.windDir),
      roughness: pickNum(overrides && overrides.roughness, s.wxRoughness),

      cleanAirPct: pickNum(overrides && overrides.cleanAirPct, s.cleanAirPct),
      exposedAt: pickNum(overrides && overrides.exposedAt, s.exposedAt),
      shelteredAt: pickNum(overrides && overrides.shelteredAt, s.shelteredAt),
      surgeFactor: pickNum(overrides && overrides.surgeFactor, s.surgeFactor),
      finaleLaps: pickNum(overrides && overrides.finaleLaps, s.finaleLaps),

      // Fixed model constants — exposed here so they are all in one place.
      ratioWindow: 15, ratioFloor: 50, minSurgeSeconds: 4, minMatchKj: 1.0,
      cornerRadius: 40, minCornerDeg: 35, turnClusterM: 35,
      lapRadius: 30, minLapMetres: 400, sectorCount: 8,
      finaleSeconds: 300, movingSpeed: 2.5,
      temp: 20, altitude: 0,
      rho: 1.2041,
      ...(overrides && overrides.rho ? { rho: overrides.rho } : {}),
    };
  }

  function pickNum(...vals) {
    for (const v of vals) if (typeof v === 'number' && isFinite(v) && v !== 0) return v;
    for (const v of vals) if (typeof v === 'number' && isFinite(v)) return v;
    return 0;
  }

  return {
    prepare, applyWeather, airDensityFor, fromJson, configFor,
    put, list, get, remove, clear, makeId,
    DB_NAME, STORE,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RideStore, Settings };
}
