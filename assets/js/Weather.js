'use strict';

/**
 * Weather.js — historical conditions for a race, from Open-Meteo.
 *
 * Open-Meteo is keyless and serves `Access-Control-Allow-Origin: *`, so this
 * works from a static page. Two endpoints are used:
 *
 *   - api.open-meteo.com/v1/forecast   — covers the last ~92 days at high
 *     resolution (a crit from last weekend lands here).
 *   - archive-api.open-meteo.com/v1/archive — ERA5 reanalysis, complete but
 *     roughly five days behind, so it takes everything older.
 *
 * Either way we keep the *hourly series*, not a single number: a 60-minute crit
 * can straddle a wind shift, and the analyser interpolates per sample.
 */
const Weather = (() => {

  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const ARCHIVE_URL  = 'https://archive-api.open-meteo.com/v1/archive';

  const HOURLY = [
    'temperature_2m',
    'relative_humidity_2m',
    'surface_pressure',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    'precipitation',
    'cloud_cover',
  ];

  // Rider torso/head height used for the wind-profile correction.
  const RIDER_HEIGHT_M = 1.3;

  const CACHE_PREFIX = 'cl-wx-';
  const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

  // ── Fetch ─────────────────────────────────────────────────────────────────

  /**
   * @param {{lat:number, lon:number, startUnix:number, endUnix:number}} o
   * @returns {Promise<Object>} weather bundle (see `shape` below)
   */
  async function fetchFor({ lat, lon, startUnix, endUnix }) {
    if (!isFinite(lat) || !isFinite(lon)) {
      throw new Error('This race has no GPS data, so weather cannot be located.');
    }
    if (!isFinite(startUnix)) {
      throw new Error('This race has no start timestamp, so weather cannot be dated.');
    }

    // Pad an hour either side so interpolation always has a bracket.
    const from = new Date((startUnix - 3600) * 1000);
    const to   = new Date((endUnix + 3600) * 1000);
    const startDate = iso(from), endDate = iso(to);

    const key = CACHE_PREFIX + [lat.toFixed(2), lon.toFixed(2), startDate, endDate].join('_');
    const hit = readCache(key);
    if (hit) return hit;

    const ageDays = (Date.now() / 1000 - startUnix) / 86400;
    const order = ageDays < 10 ? [FORECAST_URL, ARCHIVE_URL] : [ARCHIVE_URL, FORECAST_URL];

    let lastErr = null;
    for (const url of order) {
      try {
        const bundle = await query(url, lat, lon, startDate, endDate);
        if (bundle && bundle.n > 0) {
          bundle.source = url === ARCHIVE_URL ? 'ERA5 reanalysis' : 'Open-Meteo forecast archive';
          writeCache(key, bundle);
          return bundle;
        }
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Open-Meteo returned no data for this place and date.');
  }

  async function query(url, lat, lon, startDate, endDate) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      start_date: startDate,
      end_date: endDate,
      hourly: HOURLY.join(','),
      wind_speed_unit: 'ms',
      temperature_unit: 'celsius',
      timezone: 'UTC',
    });

    let res;
    try {
      res = await fetch(url + '?' + q.toString());
    } catch (_) {
      throw new Error('Could not reach Open-Meteo.');
    }
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).reason || ''; } catch (_) {}
      throw new Error('Open-Meteo returned HTTP ' + res.status + (reason ? ': ' + reason : ''));
    }

    const body = await res.json();
    const h = body.hourly;
    if (!h || !Array.isArray(h.time)) throw new Error('Open-Meteo response had no hourly block.');

    const times = h.time.map(s => Math.round(Date.parse(s + 'Z') / 1000));
    const keep = [];
    for (let i = 0; i < times.length; i++) {
      if (h.wind_speed_10m && h.wind_speed_10m[i] != null) keep.push(i);
    }

    return {
      lat: body.latitude,
      lon: body.longitude,
      elevation: numOrNull(body.elevation),
      n: keep.length,
      time:      keep.map(i => times[i]),
      temp:      keep.map(i => num(h.temperature_2m, i)),
      humidity:  keep.map(i => num(h.relative_humidity_2m, i)),
      pressure:  keep.map(i => num(h.surface_pressure, i)),      // hPa at station level
      windSpeed: keep.map(i => num(h.wind_speed_10m, i)),        // m/s at 10 m
      windDir:   keep.map(i => num(h.wind_direction_10m, i)),    // degrees FROM
      windGust:  keep.map(i => num(h.wind_gusts_10m, i)),
      precip:    keep.map(i => num(h.precipitation, i)),
      cloud:     keep.map(i => num(h.cloud_cover, i)),
      fetchedAt: Date.now(),
    };
  }

  // ── Sampling ──────────────────────────────────────────────────────────────

  /**
   * Interpolate the hourly bundle to an instant.
   * Wind direction is interpolated as a vector so 350° → 10° does not sweep
   * backwards through 180°.
   * @returns {{temp, humidity, pressure, windSpeed, windDir, windGust, precip}}
   */
  function at(wx, unixSeconds) {
    if (!wx || !wx.n) return null;
    const T = wx.time;
    let i = 0;
    while (i < wx.n - 1 && T[i + 1] <= unixSeconds) i++;
    const j = Math.min(wx.n - 1, i + 1);
    const span = T[j] - T[i];
    const f = span > 0 ? clamp((unixSeconds - T[i]) / span, 0, 1) : 0;

    // Wind as a vector, so speed and direction stay consistent.
    const [ei, ni] = dirToVec(wx.windSpeed[i], wx.windDir[i]);
    const [ej, nj] = dirToVec(wx.windSpeed[j], wx.windDir[j]);
    const e = ei + (ej - ei) * f;
    const nn = ni + (nj - ni) * f;
    const speed = Math.hypot(e, nn);
    const dir = speed < 1e-6 ? (wx.windDir[i] || 0) : ((Math.atan2(-e, -nn) * 180 / Math.PI) + 360) % 360;

    return {
      temp:      lerp(wx.temp[i], wx.temp[j], f),
      humidity:  lerp(wx.humidity[i], wx.humidity[j], f),
      pressure:  lerp(wx.pressure[i], wx.pressure[j], f),
      windSpeed: speed,
      windDir:   dir,
      windGust:  lerp(wx.windGust[i], wx.windGust[j], f),
      precip:    lerp(wx.precip[i], wx.precip[j], f),
      cloud:     lerp(wx.cloud[i], wx.cloud[j], f),
    };
  }

  /** Mean conditions across the race window — what the rail displays. */
  function summarise(wx, startUnix, endUnix) {
    if (!wx || !wx.n) return null;
    const step = Math.max(60, (endUnix - startUnix) / 12);
    let e = 0, n = 0, k = 0;
    let temp = 0, hum = 0, pres = 0, gust = 0, precip = 0, cloud = 0;
    for (let ts = startUnix; ts <= endUnix; ts += step) {
      const s = at(wx, ts);
      if (!s) continue;
      const [ve, vn] = dirToVec(s.windSpeed, s.windDir);
      e += ve; n += vn;
      temp += s.temp; hum += s.humidity; pres += s.pressure;
      gust = Math.max(gust, s.windGust || 0);
      precip += s.precip || 0;
      cloud += s.cloud || 0;
      k++;
    }
    if (!k) return null;
    e /= k; n /= k;
    const speed = Math.hypot(e, n);
    return {
      windSpeed: speed,
      windDir: speed < 1e-6 ? 0 : ((Math.atan2(-e, -n) * 180 / Math.PI) + 360) % 360,
      windGust: gust,
      temp: temp / k,
      humidity: hum / k,
      pressure: pres / k,
      precip: precip / k,
      cloud: cloud / k,
      elevation: wx.elevation,
      source: wx.source,
    };
  }

  // ── Wind profile ──────────────────────────────────────────────────────────

  /**
   * Scale a 10 m reported wind down to rider height with the logarithmic wind
   * profile, u(z) = u10 · ln(z/z0) / ln(10/z0).
   *
   * The roughness length z0 is the single biggest lever on how much wind a
   * course actually sees: an airport crit and a downtown office-block crit with
   * identical METAR readings are not the same race.
   */
  function shelterFactor(z0) {
    const r = clamp(Number(z0) || 0.1, 0.005, 2);
    const f = Math.log(RIDER_HEIGHT_M / r) / Math.log(10 / r);
    return clamp(f, 0.08, 1);
  }

  /** Signed wind vector in m/s at rider height: [east, north] components. */
  function windVector(speed10, dirFrom, z0) {
    const s = (speed10 || 0) * shelterFactor(z0);
    return dirToVec(s, dirFrom);
  }

  /** A wind FROM `dirFrom` blows TOWARD dirFrom+180. Returns [east, north]. */
  function dirToVec(speed, dirFrom) {
    const s = speed || 0;
    const r = ((dirFrom || 0) * Math.PI) / 180;
    return [-s * Math.sin(r), -s * Math.cos(r)];
  }

  const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  function compass(deg) {
    return COMPASS[Math.round((((deg || 0) % 360) + 360) % 360 / 22.5) % 16];
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || !v.fetchedAt || Date.now() - v.fetchedAt > CACHE_TTL_MS) return null;
      return v;
    } catch (_) { return null; }
  }

  function writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota */ }
  }

  function clearCache() {
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) doomed.push(k);
      }
      doomed.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function iso(d) { return d.toISOString().slice(0, 10); }
  function num(a, i) { const x = a && a[i]; return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function numOrNull(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function lerp(a, b, f) {
    if (a === null && b === null) return null;
    if (a === null) return b;
    if (b === null) return a;
    return a + (b - a) * f;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  return {
    fetchFor, at, summarise,
    shelterFactor, windVector, dirToVec, compass,
    clearCache, RIDER_HEIGHT_M, HOURLY,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Weather;
