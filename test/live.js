'use strict';

/**
 * Live integration checks. These hit the real network, so they are kept out of
 * the default test run.
 *
 *   node test/live.js                  # Open-Meteo only
 *   ICU_KEY=xxxx node test/live.js     # also exercise intervals.icu
 *
 * What they prove that the offline tests cannot: that the endpoints still
 * exist, still return the shapes the clients expect, and still send the CORS
 * headers a browser needs — the whole app depends on those last two.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'assets', 'js');

const sandbox = {
  console, fetch, Math, JSON, Date, Number, String, Array, Object, Boolean,
  Error, Map, Set, Float64Array, Int32Array, Uint8Array, ArrayBuffer, DataView,
  isFinite, parseFloat, parseInt, URLSearchParams,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  self: {}, indexedDB: null,
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k),
      key: i => Array.from(m.keys())[i],
      get length() { return m.size; },
    };
  })(),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const MODULES = ['Fit.js', 'Intervals.js', 'Weather.js', 'Physics.js', 'Analyzer.js', 'RideStore.js', 'Demo.js'];
const NAMES = ['Fit', 'Intervals', 'Weather', 'Physics', 'Analyzer', 'RideStore', 'Settings', 'Demo'];
vm.runInContext(
  MODULES.map(f => fs.readFileSync(path.join(JS, f), 'utf8')).join('\n;\n') +
  '\n;\n' + NAMES.map(n => 'globalThis.' + n + ' = ' + n + ';').join('\n'),
  sandbox, { filename: 'critlab-bundle.js' }
);
const { Weather, Intervals, RideStore, Analyzer, Settings, Demo } = sandbox;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

const ORIGIN = 'https://noahpaladino.com';

(async () => {

  // ── CORS ──────────────────────────────────────────────────────────────────
  // The entire premise of a frontend-only app is that these two hosts let a
  // browser talk to them. If that ever stops being true, everything else here
  // is moot, so it is checked first and explicitly.

  section('CORS preflight');

  try {
    const res = await fetch('https://intervals.icu/api/v1/athlete/0/activities', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    const allow = res.headers.get('access-control-allow-origin');
    const allowHdr = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    check('intervals.icu allows this origin', allow === ORIGIN || allow === '*', 'got ' + allow);
    check('intervals.icu allows the Authorization header', allowHdr.includes('authorization'), allowHdr);
  } catch (err) {
    check('intervals.icu preflight', false, String(err.message));
  }

  try {
    const res = await fetch(
      'https://archive-api.open-meteo.com/v1/archive?latitude=42.5&longitude=-71.6' +
      '&start_date=2026-06-01&end_date=2026-06-01&hourly=wind_speed_10m',
      { headers: { Origin: ORIGIN } }
    );
    check('Open-Meteo allows any origin',
      res.headers.get('access-control-allow-origin') === '*',
      'got ' + res.headers.get('access-control-allow-origin'));
  } catch (err) {
    check('Open-Meteo preflight', false, String(err.message));
  }

  // ── Weather ───────────────────────────────────────────────────────────────

  section('Open-Meteo');

  // An old date, so it goes to the ERA5 archive rather than the recent window.
  const oldStart = Math.floor(Date.parse('2026-06-10T18:00:00Z') / 1000);
  let archive = null;
  try {
    archive = await Weather.fetchFor({
      lat: 42.5450, lon: -71.6150, startUnix: oldStart, endUnix: oldStart + 3600,
    });
    check('archive fetch returns hourly data', archive.n >= 3, archive.n + ' hours');
    check('archive names its source', /ERA5|forecast/.test(archive.source || ''), archive.source);
    check('wind speed is present and plausible',
      archive.windSpeed.every(v => v === null || (v >= 0 && v < 60)),
      'max ' + Math.max(...archive.windSpeed.filter(v => v !== null)).toFixed(1) + ' m/s');
    check('wind direction is a bearing',
      archive.windDir.every(v => v === null || (v >= 0 && v <= 360)));
    check('pressure is plausible',
      archive.pressure.every(v => v === null || (v > 850 && v < 1100)),
      archive.pressure[0] + ' hPa');
    check('humidity is a percentage',
      archive.humidity.every(v => v === null || (v >= 0 && v <= 100)));
    check('elevation returned for the site',
      archive.elevation != null && archive.elevation > -100 && archive.elevation < 5000,
      archive.elevation + ' m');
  } catch (err) {
    check('archive fetch', false, String(err.message));
  }

  // A recent date, which must route to the forecast endpoint instead.
  const recentStart = Math.floor(Date.now() / 1000) - 3 * 86400;
  try {
    const recent = await Weather.fetchFor({
      lat: 42.5450, lon: -71.6150, startUnix: recentStart, endUnix: recentStart + 3600,
    });
    check('a three-day-old race still finds weather', recent.n >= 3,
      recent.n + ' hours from ' + recent.source);
  } catch (err) {
    check('recent-date fetch', false, String(err.message));
  }

  // ── End to end ────────────────────────────────────────────────────────────

  section('End to end with real weather');

  if (archive && archive.n) {
    const demo = Demo.build();
    demo.startTime = oldStart;
    const P = RideStore.prepare(demo, { movingSpeed: 2.5 });

    check('weather applies to the ride', RideStore.applyWeather(P, archive, 0.1));

    const cfg = RideStore.configFor(P, {});
    cfg.windSource = 'weather';
    const dens = RideStore.airDensityFor(P, archive, cfg);
    cfg.rho = dens.rho;
    check('air density from real conditions is plausible',
      cfg.rho > 1.0 && cfg.rho < 1.32, cfg.rho.toFixed(3) + ' kg/m³ at ' + dens.tempC.toFixed(1) + ' °C');

    const A = Analyzer.run(P, cfg);
    check('analysis runs on real weather', A.wind.source === 'weather');
    check('exposure is in range', A.summary.exposed >= 0 && A.summary.exposed <= 100,
      A.summary.exposed.toFixed(0) + '% clean air, wind ' + A.wind.speed.toFixed(1) +
      ' m/s from ' + Weather.compass(A.wind.dirFrom));
    check('laps still detected with real weather', A.summary.laps > 15, A.summary.laps + ' laps');
  }

  // ── intervals.icu ─────────────────────────────────────────────────────────

  section('intervals.icu');

  const key = process.env.ICU_KEY;
  if (!key) {
    console.log('  \x1b[2mskipped — set ICU_KEY to run these\x1b[0m');
  } else {
    try {
      const athlete = await Intervals.testKey(key, '0');
      check('key authenticates', !!athlete.id, 'athlete ' + athlete.id + ' (' + athlete.name + ')');

      const to = new Date();
      const from = new Date(to.getTime() - 120 * 86400000);
      const list = await Intervals.listActivities({
        key, athleteId: '0',
        oldest: from.toISOString().slice(0, 10),
        newest: to.toISOString().slice(0, 10),
      });
      check('activity list returns', Array.isArray(list), list.length + ' activities');

      const ride = list.find(a => Intervals.isRide(a) && a.hasPower);
      if (!ride) {
        console.log('  \x1b[2mno ride with power in the last 120 days — stream test skipped\x1b[0m');
      } else {
        const streams = await Intervals.getStreams(ride.id, key);
        check('streams returned', !!streams.time && streams.time.length > 10,
          Object.keys(streams).join(', '));
        const raw = Intervals.toRide(ride, streams);
        check('streams normalise to a ride', raw.n === streams.time.length, raw.n + ' samples');
        const P = RideStore.prepare(raw, { movingSpeed: 2.5 });
        check('a real activity prepares', P.n > 60,
          P.n + ' samples, GPS ' + (P.hasGps ? 'yes' : 'no'));
        const cfg = RideStore.configFor(P, {});
        cfg.rho = RideStore.airDensityFor(P, null, cfg).rho;
        cfg.windSource = 'fit';
        const A = Analyzer.run(P, cfg);
        check('a real activity analyses', isFinite(A.summary.avg),
          '"' + ride.name + '": ' + A.summary.avg.toFixed(0) + ' W avg, ' +
          A.summary.laps + ' laps, ' + A.summary.turns + ' turns, ' +
          A.summary.exposed.toFixed(0) + '% clean air');
      }
    } catch (err) {
      check('intervals.icu flow', false, String(err.message));
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log(failed === 0
    ? '\x1b[32m' + passed + ' checks passed\x1b[0m'
    : '\x1b[31m' + failed + ' failed\x1b[0m, ' + passed + ' passed');
  if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  · ' + f)); }
  process.exit(failed ? 1 : 0);
})();
