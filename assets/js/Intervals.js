'use strict';

/**
 * Intervals.js — browser client for the intervals.icu v1 API.
 *
 * intervals.icu serves permissive CORS headers (it reflects the calling origin
 * and allows the Authorization header), so this runs entirely client side: the
 * key never leaves the browser except in the request to intervals.icu itself.
 *
 * Auth is HTTP Basic with the literal username "API_KEY" and the athlete's key
 * as the password. Athlete id "0" resolves to the key's own athlete.
 */
const Intervals = (() => {

  const BASE = 'https://intervals.icu/api/v1';

  /**
   * Strava's API terms do not let intervals.icu pass Strava-sourced activity
   * data on through its own API, so those activities are readable in the
   * intervals.icu web UI but not by any API client — this one included.
   *
   * The trap is that an activity uploaded from a head unit can *become*
   * Strava-sourced later: if a Strava copy of the same ride arrives, the two
   * are de-duplicated and the Strava record can end up the canonical one. The
   * original then vanishes from the activity list and its streams come back
   * empty, with nothing anywhere saying why.
   */
  const STRAVA_BLOCKED =
    'This activity reached intervals.icu from Strava, and Strava does not permit ' +
    'intervals.icu to serve its data through the API — so no API client can read ' +
    'it, including this one. Resyncing from Strava will not help. Either upload ' +
    'the original .fit to intervals.icu directly (so the copy there is not ' +
    'Strava-sourced), or simply drag the .fit file into CritLab.';

  const STREAM_TYPES = [
    'time', 'watts', 'fixed_watts', 'heartrate', 'cadence',
    'distance', 'altitude', 'latlng', 'velocity_smooth', 'temp',
  ];

  function authHeader(key) {
    return 'Basic ' + btoa('API_KEY:' + key);
  }

  async function request(path, key, opts = {}) {
    if (!key) throw new Error('No intervals.icu API key saved. Add one in Settings.');

    let res;
    try {
      res = await fetch(BASE + path, {
        method: 'GET',
        headers: { Authorization: authHeader(key), Accept: 'application/json' },
        ...opts,
      });
    } catch (err) {
      throw new Error(
        'Could not reach intervals.icu. Check your connection, or whether a ' +
        'browser extension is blocking the request.'
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error('intervals.icu rejected the API key (HTTP ' + res.status + ').');
    }
    if (res.status === 404) {
      throw new Error('Not found on intervals.icu (HTTP 404).');
    }
    if (res.status === 429) {
      throw new Error('intervals.icu rate limit hit. Wait a few minutes and try again.');
    }
    if (res.status === 422) {
      // intervals.icu refuses to re-serve Strava-sourced activities through its
      // own API — Strava's terms forbid it. Nothing about the key or the
      // request is wrong, and no amount of retrying or resyncing from Strava
      // will help; the data has to reach intervals.icu by another route.
      let body = '';
      try { body = await res.text(); } catch (_) {}
      if (/strava/i.test(body)) throw new Error(STRAVA_BLOCKED);
      throw new Error('intervals.icu rejected the request (HTTP 422)' +
        (body ? ': ' + body.slice(0, 160) : '.'));
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch (_) {}
      throw new Error('intervals.icu returned HTTP ' + res.status + (detail ? ': ' + detail : ''));
    }

    return res.json();
  }

  // ── Athlete ───────────────────────────────────────────────────────────────

  /** Verify a key and return a small athlete summary. Throws on failure. */
  async function testKey(key, athleteId = '0') {
    const a = await request('/athlete/' + encodeURIComponent(athleteId || '0'), key);
    let ftp = null;
    try {
      const settings = await request(
        '/athlete/' + encodeURIComponent(athleteId || '0') + '/sport-settings', key
      );
      const ride = (settings || []).find(s =>
        (s.types || []).some(t => /^(Ride|VirtualRide|GravelRide|MountainBikeRide)$/i.test(t))
      ) || (settings || [])[0];
      if (ride && ride.ftp) ftp = ride.ftp;
    } catch (_) { /* sport-settings is optional */ }

    return {
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name || a.email || String(a.id),
      weight: numOrNull(a.icu_weight),
      ftp,
    };
  }

  // ── Activities ────────────────────────────────────────────────────────────

  /**
   * List activities in a date window.
   * @param {{key:string, athleteId?:string, oldest:string, newest:string}} o
   *        Dates are YYYY-MM-DD (local to the athlete).
   */
  async function listActivities({ key, athleteId = '0', oldest, newest }) {
    const q = new URLSearchParams({ oldest, newest });
    const list = await request(
      '/athlete/' + encodeURIComponent(athleteId || '0') + '/activities?' + q.toString(), key
    );
    return (Array.isArray(list) ? list : []).map(summarise);
  }

  function summarise(a) {
    const streams = Array.isArray(a.stream_types) ? a.stream_types : [];
    return {
      id: a.id,
      name: a.name || 'Untitled',
      type: a.type || a.icu_activity_type || '',
      // intervals.icu flags races two ways and users tag on top of that. All
      // three matter for finding the crit among a month of endurance rides.
      isRace: a.race === true || String(a.sub_type || '').toUpperCase() === 'RACE',
      subType: a.sub_type || null,
      tags: Array.isArray(a.tags) ? a.tags : [],
      commute: a.commute === true,
      trainer: a.trainer === true,
      // The activity list already says which streams exist, so a ride that
      // cannot be analysed can be filtered out before it is ever clicked.
      streamTypes: streams,
      hasGpsStream: streams.includes('latlng'),
      hasPowerStream: streams.includes('watts') || streams.includes('fixed_watts'),
      device: a.device_name || null,
      source: a.source || null,
      // A Strava-sourced record is a dead end for the API, whatever else it says.
      apiBlocked: String(a.source || '').toUpperCase() === 'STRAVA',
      start: a.start_date_local || a.start_date || null,
      startUtc: a.start_date || null,
      movingTime: numOrNull(a.moving_time),
      elapsedTime: numOrNull(a.elapsed_time),
      distance: numOrNull(a.distance),
      avgWatts: numOrNull(a.icu_average_watts != null ? a.icu_average_watts : a.average_watts),
      np: numOrNull(a.icu_weighted_avg_watts),
      ftp: numOrNull(a.icu_ftp),
      weight: numOrNull(a.icu_weight),
      cp: numOrNull(a.icu_pm_cp),
      wPrime: numOrNull(a.icu_pm_w_prime),
      hasPower: !!(a.icu_average_watts || a.average_watts) ||
        streams.includes('watts') || streams.includes('fixed_watts'),
      raw: a,
    };
  }

  /** Every distinct tag across a list, most used first — for filter chips. */
  function tagsIn(activities) {
    const counts = new Map();
    for (const a of activities) for (const t of (a.tags || [])) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([tag, count]) => ({ tag, count }));
  }

  const RIDE_TYPES = /^(Ride|VirtualRide|GravelRide|MountainBikeRide|EBikeRide|Velomobile)$/i;
  function isRide(a) { return RIDE_TYPES.test(a.type || ''); }

  async function getActivity(id, key) {
    return summarise(await request('/activity/' + encodeURIComponent(id), key));
  }

  // ── Streams ───────────────────────────────────────────────────────────────

  /**
   * Fetch activity streams and normalise them to { type: array }.
   *
   * Two shapes have to be handled, and one trap.
   *
   * The wire shape is `[{type, name, data, data2, ...}]`, though an object
   * keyed by type also turns up, so both are accepted.
   *
   * The trap is `latlng`. Strava-derived APIs return it as an array of
   * `[lat, lon]` pairs, and that is the obvious assumption — but intervals.icu
   * returns *two parallel arrays*: latitudes in `data`, longitudes in `data2`.
   * Reading only `data` yields a stream of bare latitudes, which fails the
   * "is this a coordinate pair?" check further down and silently produces a
   * ride with no GPS at all. So `data2` is preserved here and the pairing
   * happens in `toRide`.
   */
  async function getStreams(id, key, types = STREAM_TYPES) {
    const q = new URLSearchParams({ types: types.join(',') });
    const body = await request(
      '/activity/' + encodeURIComponent(id) + '/streams.json?' + q.toString(), key
    );

    const out = {};
    const take = (type, s) => {
      if (!type || !s) return;
      if (Array.isArray(s)) { out[type] = s; return; }
      const data = s.data || s.values || null;
      if (!data) return;
      out[type] = data;
      if (Array.isArray(s.data2)) out[type + '__data2'] = s.data2;
    };

    if (Array.isArray(body)) {
      for (const s of body) take(s && s.type, s);
    } else if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) take(k, v);
    }
    return out;
  }

  // ── Normalisation ─────────────────────────────────────────────────────────

  /** Build CritLab's raw ride shape from an activity summary + its streams. */
  function toRide(activity, streams) {
    const time = streams.time;
    if (!Array.isArray(time) || !time.length) {
      // An activity can exist on intervals.icu as a summary with no sample data
      // behind it — most often when a duplicate arrived from another source and
      // the streams were dropped during de-duplication. The summary still
      // reports `stream_types`, so this is not detectable before asking.
      throw new Error(
        'intervals.icu has the summary for this activity but no sample data — ' +
        'the streams come back empty. This usually means it was de-duplicated ' +
        'against a Strava copy of the same ride, which the API is not allowed ' +
        'to serve. Upload the original .fit to intervals.icu, or drag it into ' +
        'CritLab directly.'
      );
    }
    const n = time.length;

    const watts = pick(streams, ['watts', 'fixed_watts']);
    if (!watts) {
      throw new Error('This activity has no power data — CritLab needs watts.');
    }

    const pos = coordinates(streams, n);
    const lat = pos.lat, lon = pos.lon;

    const startUnix = activity.start
      ? Math.round(Date.parse(fixLocalIso(activity.startUtc || activity.start)) / 1000)
      : null;

    return {
      source: 'icu',
      sourceId: String(activity.id),
      name: activity.name || 'intervals.icu activity',
      startTime: startUnix,
      sport: (activity.type || 'Ride').toLowerCase(),
      n,
      t: time.map(Number),
      lat, lon,
      alt: arr(streams.altitude, n),
      v: arr(streams.velocity_smooth, n),
      watts: arr(watts, n),
      hr: arr(streams.heartrate, n),
      cad: arr(streams.cadence, n),
      dist: arr(streams.distance, n),
      temp: arr(streams.temp, n),
      lapTimes: [],
      ftp: activity.ftp,
      weightKg: activity.weight,
      cp: activity.cp,
      wPrime: activity.wPrime,
      totals: {
        distance: activity.distance,
        elapsed: activity.elapsedTime,
        timer: activity.movingTime,
        avgPower: activity.avgWatts,
        np: activity.np,
      },
    };
  }

  /** Fetch + normalise in one call. */
  async function loadRide(activityId, key) {
    const activity = await getActivity(activityId, key);
    if (activity.apiBlocked) throw new Error(STRAVA_BLOCKED);
    const streams = await getStreams(activityId, key);
    return toRide(activity, streams);
  }

  /**
   * Pull latitude and longitude out of whatever position representation the
   * payload used.
   *
   *   1. intervals.icu native — `latlng.data` is latitudes, `latlng.data2` is
   *      longitudes, as two parallel arrays.
   *   2. Strava-style        — `latlng` is an array of `[lat, lon]` pairs.
   *   3. Separate streams    — `lat` / `lng` (or `lon`, `longitude`).
   *
   * Returns nulls rather than a half-filled track if nothing usable is found,
   * so callers can say "no GPS" honestly instead of drawing a dot at (0, 0).
   */
  function coordinates(streams, n) {
    const none = { lat: null, lon: null };

    let lat = null, lon = null;
    const ll = streams.latlng;
    const ll2 = streams.latlng__data2;

    if (Array.isArray(ll) && ll.length) {
      if (Array.isArray(ll2) && ll2.length) {
        lat = ll.slice(0, n); lon = ll2.slice(0, n);            // intervals.icu
      } else if (Array.isArray(ll[0])) {
        lat = new Array(n); lon = new Array(n);                  // Strava pairs
        for (let i = 0; i < n; i++) {
          const p = ll[i];
          const ok = Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]);
          lat[i] = ok ? p[0] : null;
          lon[i] = ok ? p[1] : null;
        }
      }
    }

    if (!lat) {
      const la = streams.lat || streams.latitude;
      const lo = streams.lng || streams.lon || streams.longitude;
      if (Array.isArray(la) && Array.isArray(lo)) { lat = la.slice(0, n); lon = lo.slice(0, n); }
    }

    if (!lat || !lon) return none;

    // Normalise and sanity-check: a valid fix is in range and not the null
    // island at (0, 0) that head units emit before they lock on.
    let usable = 0;
    for (let i = 0; i < n; i++) {
      const a = Number(lat[i]), b = Number(lon[i]);
      const ok = isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 &&
        !(a === 0 && b === 0);
      lat[i] = ok ? a : null;
      lon[i] = ok ? b : null;
      if (ok) usable++;
    }
    return usable >= Math.max(10, n * 0.05) ? { lat, lon } : none;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function pick(obj, names) {
    for (const nm of names) if (Array.isArray(obj[nm]) && obj[nm].length) return obj[nm];
    return null;
  }

  function arr(a, n) {
    if (!Array.isArray(a) || !a.length) return null;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = a[i];
      out[i] = (typeof x === 'number' && isFinite(x)) ? x : null;
    }
    return out;
  }

  function numOrNull(x) {
    return (typeof x === 'number' && isFinite(x)) ? x : null;
  }

  /** intervals.icu returns "2026-07-25T09:14:03" for local times — treat as UTC-naive. */
  function fixLocalIso(s) {
    if (typeof s !== 'string') return s;
    return /[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z';
  }

  return {
    BASE, STREAM_TYPES,
    testKey, listActivities, getActivity, getStreams, toRide, loadRide, isRide, coordinates, tagsIn, STRAVA_BLOCKED,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Intervals;
