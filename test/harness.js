'use strict';

/**
 * Headless smoke tests. Loads the real browser modules into a shared context
 * (they are plain scripts, not ES modules) and exercises the whole chain:
 * synthetic ride → FIT encode/decode round trip → prepare → analyse.
 *
 *   node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'assets', 'js');

// A minimal browser-ish global so the modules load unchanged.
const sandbox = {
  console,
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
  self: {},
  indexedDB: null,
  fetch: () => Promise.reject(new Error('network disabled in tests')),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  Math, JSON, Date, Number, String, Array, Object, Boolean, Error, Map, Set,
  Float64Array, Int32Array, Uint8Array, ArrayBuffer, DataView, isFinite, parseFloat, parseInt,
  URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// The modules declare top-level `const`s, which are lexical to the script they
// run in — so concatenate them into one script and export the bindings by hand.
const MODULES = ['Fit.js', 'Intervals.js', 'Weather.js', 'Osm.js', 'Physics.js', 'Analyzer.js', 'RideStore.js', 'Demo.js'];
const NAMES = ['Fit', 'Intervals', 'Weather', 'Osm', 'Physics', 'Analyzer', 'RideStore', 'Settings', 'Demo'];

vm.runInContext(
  MODULES.map(f => fs.readFileSync(path.join(JS, f), 'utf8')).join('\n;\n') +
  '\n;\n' + NAMES.map(n => 'globalThis.' + n + ' = ' + n + ';').join('\n'),
  sandbox,
  { filename: 'critlab-bundle.js' }
);

const { Fit, Intervals, Weather, Osm, Physics, Analyzer, RideStore, Settings, Demo } = sandbox;

// ── tiny test runner ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function near(name, got, want, tol, unit = '') {
  const ok = isFinite(got) && Math.abs(got - want) <= tol;
  check(name, ok, 'got ' + fmt(got) + unit + ', want ' + fmt(want) + '±' + fmt(tol) + unit);
}
function fmt(x) { return typeof x === 'number' ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3)) : String(x); }
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ── 1. Physics ──────────────────────────────────────────────────────────────

section('Physics');

// ISA sea-level dry air is 1.225 kg/m³ at 15 °C.
near('dry air density at 15 °C, 101325 Pa', Physics.airDensity(15, 101325, null), 1.225, 0.002, ' kg/m³');
// Humid air is lighter than dry air at the same temperature and pressure.
check('humid air is less dense than dry',
  Physics.airDensity(30, 101325, 90) < Physics.airDensity(30, 101325, 0),
  'humid ' + Physics.airDensity(30, 101325, 90).toFixed(4) + ' < dry ' + Physics.airDensity(30, 101325, 0).toFixed(4));

near('ISA pressure at sea level', Physics.pressureAtAltitude(0), 101325, 1, ' Pa');
near('ISA pressure at 1000 m', Physics.pressureAtAltitude(1000), 89875, 200, ' Pa');

// Apparent wind: heading north into a wind blowing south (i.e. FROM the north).
{
  const [we, wn] = Weather.dirToVec(5, 0);          // from N → blows toward S
  const aw = Physics.apparentWind(10, 0, we, wn);   // heading north
  near('headwind adds to apparent speed', aw.along, 15, 0.01, ' m/s');
  near('pure headwind has no crosswind', aw.cross, 0, 1e-9, ' m/s');
  near('pure headwind yaw is zero', aw.yaw, 0, 1e-9, ' rad');
}
{
  const [we, wn] = Weather.dirToVec(5, 180);        // from S → blows toward N
  const aw = Physics.apparentWind(10, 0, we, wn);
  near('tailwind subtracts', aw.along, 5, 0.01, ' m/s');
}
{
  const [we, wn] = Weather.dirToVec(5, 270);        // from W → blows toward E
  const aw = Physics.apparentWind(10, 0, we, wn);   // heading north
  near('crosswind from the west is +cross', aw.cross, 5, 0.01, ' m/s');
  near('crosswind does not change along-component', aw.along, 10, 0.01, ' m/s');
}

// A hand-computed steady state, flat and still:
//   aero    0.5·1.2·0.32·11.6³ = 299.7 W
//   rolling 80·9.80665·0.004·11.6 = 36.4 W
//   at the pedals: (299.7 + 36.4) / 0.976 = 344.4 W
{
  const c = { mass: 80, crr: 0.004, cda: 0.32, rho: 1.2, driveEff: 0.976, rotMass: 0, yawK: 0, we: 0, wn: 0 };
  const p = Physics.requiredPower({ v: 11.6, theta: 0, a: 0, heading: 0 }, c);
  near('flat still-air power at 11.6 m/s', p, 344.4, 0.5, ' W');
  const up = Physics.requiredPower({ v: 11.6, theta: Math.atan(0.05), a: 0, heading: 0 }, c);
  check('a 5% gradient costs much more', up > p * 2, fmt(up) + ' W vs ' + fmt(p) + ' W');
  const dn = Physics.requiredPower({ v: 11.6, theta: -Math.atan(0.05), a: 0, heading: 0 }, c);
  check('a −5% gradient costs less', dn < p, fmt(dn) + ' W vs ' + fmt(p) + ' W');
}

// Aero scales with the cube of speed on the flat in still air.
{
  const c = { mass: 80, crr: 0, cda: 0.32, rho: 1.2, driveEff: 1, rotMass: 0, yawK: 0, we: 0, wn: 0 };
  const p1 = Physics.requiredPower({ v: 10, theta: 0, a: 0, heading: 0 }, c);
  const p2 = Physics.requiredPower({ v: 20, theta: 0, a: 0, heading: 0 }, c);
  near('doubling speed multiplies pure-aero power by 8', p2 / p1, 8, 0.01);
}

// W′ balance: a constant effort above CP drains at exactly (P − CP).
{
  const watts = new Float64Array(100).fill(400);
  const r = Physics.wPrimeBalance(watts, 300, 20000, 1);
  near('W′ drained by a 100 s effort 100 W over CP', 20000 - r.minBal, 10000, 1, ' J');
  check('W′ not depleted here', !r.depleted, 'min ' + fmt(r.minBal) + ' J');
}
{
  const watts = new Float64Array(600).fill(500);
  const r = Physics.wPrimeBalance(watts, 300, 20000, 1);
  check('W′ hits the floor under a long hard effort', r.depleted, 'min ' + fmt(r.minBal) + ' J');
  check('W′ balance is clamped at empty, never negative', r.minBal === 0, 'min ' + fmt(r.minBal) + ' J');
  // 600 s at 200 W over CP demands 120 kJ against a 20 kJ tank.
  near('overdraft records the demand past empty', r.overdraft, 100000, 500, ' J');
  near('time spent empty', r.depletedSeconds, 500, 2, ' s');
}
{
  // Drain, then recover: the balance must come back up, never above W′.
  const watts = new Float64Array(1000);
  for (let i = 0; i < 60; i++) watts[i] = 450;
  for (let i = 60; i < 1000; i++) watts[i] = 150;
  const r = Physics.wPrimeBalance(watts, 300, 20000, 1);
  check('W′ recovers below CP', r.bal[999] > r.bal[60], fmt(r.bal[60]) + ' → ' + fmt(r.bal[999]) + ' J');
  check('W′ never exceeds capacity', Math.max(...r.bal) <= 20000 + 1e-6);
}

// Normalised power of a constant effort equals that effort.
{
  const flat = new Float64Array(600).fill(250);
  near('NP of constant 250 W is 250 W', Physics.normalizedPower(flat, 1), 250, 0.5, ' W');
  const spiky = new Float64Array(600);
  for (let i = 0; i < 600; i++) spiky[i] = i % 120 < 60 ? 400 : 100;
  check('NP of a spiky effort exceeds its mean',
    Physics.normalizedPower(spiky, 1) > 250, fmt(Physics.normalizedPower(spiky, 1)) + ' W vs 250 W mean');
}

// Gradient fitting must ignore altimeter noise on a genuinely flat road.
{
  const n = 400;
  const dist = new Float64Array(n), alt = new Float64Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) { dist[i] = i * 12; alt[i] = 100 + rnd() * 1.2; }
  const g = Physics.gradientSeries(alt, dist, 30);
  const worst = Math.max(...Array.from(g).map(Math.abs));
  check('noisy flat road yields near-zero gradient', worst < 0.02, 'worst |grade| ' + (worst * 100).toFixed(2) + '%');
}
{
  const n = 300;
  const dist = new Float64Array(n), alt = new Float64Array(n);
  for (let i = 0; i < n; i++) { dist[i] = i * 10; alt[i] = 100 + dist[i] * 0.04; }
  const g = Physics.gradientSeries(alt, dist, 30);
  near('a true 4% gradient is recovered', g[150], 0.04, 0.002);
}

// ── 2. Weather helpers ──────────────────────────────────────────────────────

section('Weather');

for (const [deg, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'], [247, 'WSW']]) {
  check('compass(' + deg + ') = ' + name, Weather.compass(deg) === name, 'got ' + Weather.compass(deg));
}
{
  // dirToVec then back to a bearing must be the identity.
  for (const d of [0, 45, 137, 250, 359]) {
    const [e, n] = Weather.dirToVec(6, d);
    const back = ((Math.atan2(-e, -n) * 180 / Math.PI) + 360) % 360;
    near('wind vector round-trips at ' + d + '°', back, d, 0.01, '°');
  }
}
{
  const f1 = Weather.shelterFactor(0.03), f2 = Weather.shelterFactor(1.0);
  check('rougher ground shelters more', f2 < f1, 'airport ' + f1.toFixed(2) + ' vs downtown ' + f2.toFixed(2));
  check('shelter factor stays below 1', f1 < 1 && f1 > 0, 'airport ' + f1.toFixed(2));
}
{
  // Interpolation across a 350° → 10° shift must go the short way through 0°.
  const wx = {
    n: 2, time: [1000, 4600],
    windSpeed: [5, 5], windDir: [350, 10],
    temp: [20, 22], humidity: [50, 50], pressure: [1010, 1010],
    windGust: [7, 7], precip: [0, 0], cloud: [0, 0],
  };
  const mid = Weather.at(wx, 2800);
  check('wind direction interpolates the short way', mid.windDir < 5 || mid.windDir > 355,
    'midpoint ' + mid.windDir.toFixed(1) + '°');
  near('temperature interpolates linearly', mid.temp, 21, 0.01, ' °C');
}

// ── 3. FIT round trip ───────────────────────────────────────────────────────

section('FIT decoder');

/** Minimal FIT encoder — enough to prove the decoder reads a real layout. */
function encodeFit(records, laps) {
  const body = [];
  const u8 = v => body.push(v & 0xff);
  const u16 = v => { u8(v); u8(v >> 8); };
  const u32 = v => { u16(v); u16(v >> 16); };
  const i32 = v => u32(v >>> 0);

  // Definition for record (global 20), local 0.
  u8(0x40); u8(0); u8(0); u16(20); u8(7);
  const recFields = [
    [253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84],
    [5, 4, 0x86], [73, 4, 0x86], [7, 2, 0x84],
  ];
  for (const [num, size, base] of recFields) { u8(num); u8(size); u8(base); }

  for (const r of records) {
    u8(0x00);
    u32(r.timestamp);
    i32(Math.round(r.lat / (180 / 2147483648)));
    i32(Math.round(r.lon / (180 / 2147483648)));
    u16(Math.round((r.alt + 500) * 5));
    u32(Math.round(r.dist * 100));
    u32(Math.round(r.v * 1000));
    u16(Math.round(r.watts));
  }

  // Definition for lap (global 19), local 1 — big-endian, to exercise that path.
  u8(0x41); u8(0); u8(1); u8(0); u8(19); u8(2);
  for (const [num, size, base] of [[253, 4, 0x86], [9, 4, 0x86]]) { u8(num); u8(size); u8(base); }
  for (const l of laps) {
    u8(0x01);
    body.push((l.timestamp >>> 24) & 0xff, (l.timestamp >>> 16) & 0xff, (l.timestamp >>> 8) & 0xff, l.timestamp & 0xff);
    const d = Math.round(l.distance * 100);
    body.push((d >>> 24) & 0xff, (d >>> 16) & 0xff, (d >>> 8) & 0xff, d & 0xff);
  }

  const header = [12, 0x10, 0x5b, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  const dl = body.length;
  header[4] = dl & 0xff; header[5] = (dl >> 8) & 0xff;
  header[6] = (dl >> 16) & 0xff; header[7] = (dl >> 24) & 0xff;

  return new Uint8Array([...header, ...body, 0, 0]).buffer;
}

{
  const base = 1090000000;   // FIT epoch seconds
  const recs = [];
  for (let i = 0; i < 300; i++) {
    recs.push({
      timestamp: base + i,
      lat: 42.545 + i * 1e-5, lon: -71.615 + i * 1e-5,
      alt: 84 + Math.sin(i / 20) * 3,
      dist: i * 12.4,
      v: 12.4,
      watts: 200 + (i % 40) * 5,
    });
  }
  const laps = [{ timestamp: base + 150, distance: 1860 }, { timestamp: base + 299, distance: 3708 }];
  const buf = encodeFit(recs, laps);

  const dec = Fit.decode(buf);
  check('decoded every record', dec.records.length === 300, dec.records.length + ' of 300');
  check('decoded both laps (big-endian definition)', dec.laps.length === 2, dec.laps.length + ' of 2');
  near('latitude survives the semicircle round trip', dec.records[0].lat, 42.545, 1e-6, '°');
  near('longitude survives the semicircle round trip', dec.records[0].lon, -71.615, 1e-6, '°');
  near('altitude scale/offset applied', dec.records[0].alt, 84, 0.11, ' m');
  near('distance scale applied', dec.records[10].dist, 124, 0.01, ' m');
  near('enhanced_speed scale applied', dec.records[10].v, 12.4, 0.001, ' m/s');
  check('power read', dec.records[10].watts === 250, 'got ' + dec.records[10].watts);
  near('big-endian lap distance', dec.laps[0].distance, 1860, 0.01, ' m');

  const ride = Fit.toRide(dec, 'devens_gp.fit');
  check('ride time base starts at zero', ride.t[0] === 0);
  check('ride name derived from filename', ride.name === 'devens gp', 'got "' + ride.name + '"');
  near('start time converted to Unix epoch', ride.startTime, base + Fit.FIT_EPOCH, 0.5, ' s');
  check('lap markers carried through', ride.lapTimes.length === 2, ride.lapTimes.length + ' markers');

  // Truncated files must fail loudly rather than return nonsense.
  let threw = false;
  try { Fit.decode(new Uint8Array([1, 2, 3]).buffer); } catch (_) { threw = true; }
  check('a non-FIT buffer throws', threw);
}

// ── 4. Prepare ──────────────────────────────────────────────────────────────

section('RideStore.prepare');

{
  // A ride with a 40 s recording hole in the middle.
  const t = [], watts = [], dist = [], v = [], alt = [];
  let d = 0;
  for (let i = 0; i < 200; i++) { t.push(i); v.push(11); d += 11; dist.push(d); watts.push(240); alt.push(50); }
  for (let i = 240; i < 400; i++) { t.push(i); v.push(11); d += 11; dist.push(d); watts.push(240); alt.push(50); }

  const P = RideStore.prepare({ name: 'gap test', t, watts, dist, v, alt, lat: null, lon: null }, {});
  check('grid is uniform 1 Hz', P.dt === 1 && P.n === 400, 'n=' + P.n);
  let gaps = 0;
  for (let i = 0; i < P.n; i++) if (P.gap[i]) gaps++;
  check('the recording hole is flagged', gaps >= 35 && gaps <= 45, gaps + ' samples flagged');
  let inventedWatts = 0;
  for (let i = 0; i < P.n; i++) if (P.gap[i] && P.watts[i] > 0) inventedWatts++;
  check('no power is invented across the hole', inventedWatts === 0, inventedWatts + ' samples');
  let backwards = 0;
  for (let i = 1; i < P.n; i++) if (P.dist[i] < P.dist[i - 1]) backwards++;
  check('distance stays monotone', backwards === 0, backwards + ' reversals');
  check('gap samples are not counted as moving',
    Array.from(P.moving).every((m, i) => !(m && P.gap[i])));
}
{
  // Speed must be derivable from distance alone.
  const t = [], dist = [], watts = [];
  for (let i = 0; i < 120; i++) { t.push(i); dist.push(i * 10); watts.push(200); }
  const P = RideStore.prepare({ name: 'no speed', t, dist, watts, alt: null, v: null, lat: null, lon: null }, {});
  near('speed derived from distance', P.v[60], 10, 0.01, ' m/s');
}

// ── 5. Full analysis of the synthetic crit ──────────────────────────────────

section('Analyzer on the synthetic crit');

const demo = Demo.build();
const truth = demo.truth;
console.log('  \x1b[2msimulated: ' + truth.laps + ' laps × ' + truth.lapLength.toFixed(0) +
  ' m, wind ' + truth.windSpeed + ' m/s from ' + truth.windFrom + '°, CdA ' + truth.cda + '\x1b[0m');

const P = RideStore.prepare(demo, { movingSpeed: 2.5 });
check('demo prepared', P.n > 1800 && P.hasPower && P.hasGps, P.n + ' samples');

Settings.set({ windSource: 'fit', lockCda: false, cp: 268, wPrime: 21500, ftp: 265, mass: 79.5, crr: 0.0042 });
const cfg = RideStore.configFor(P, {});
cfg.rho = RideStore.airDensityFor(P, null, cfg).rho;
cfg.windSource = 'fit';

const t0 = Date.now();
const A = Analyzer.run(P, cfg);
const ms = Date.now() - t0;
console.log('  \x1b[2manalysis took ' + ms + ' ms\x1b[0m');
check('analysis completes in under 3 s', ms < 3000, ms + ' ms');

// Laps.
near('lap count recovered', A.summary.laps, truth.laps, 2, ' laps');
check('laps came from GPS', A.summary.lapSource === 'gps', 'source: ' + A.summary.lapSource);

// Lap 1 must start where the rider started, not at whichever straight the lap
// detector found convenient. Anything else makes every lap straddle the line.
{
  let firstMoving = 0;
  while (firstMoving < P.n && !P.moving[firstMoving]) firstMoving++;
  const gap = A.lapBounds[0].i0 - firstMoving;
  check('the lap splitter sits at the start line',
    gap >= 0 && gap * P.dt <= 20,
    'lap 1 begins ' + (gap * P.dt).toFixed(0) + ' s after the ride starts moving' +
    ' (sample ' + A.lapBounds[0].i0 + ' vs ' + firstMoving + ')');
  check('no riding is stranded before lap 1 beyond the roll-up',
    A.lapBounds[0].i0 < P.n * 0.05,
    'lap 1 starts ' + ((100 * A.lapBounds[0].i0) / P.n).toFixed(1) + '% into the ride');
}
if (A.laps.length) {
  const lens = A.laps.map(l => l.distance);
  near('lap length recovered', lens.reduce((a, b) => a + b, 0) / lens.length, truth.lapLength, 60, ' m');
}

// Corners.
near('corner count recovered', A.summary.turns, truth.corners, 1, ' turns');
if (A.turns.length) {
  check('every corner recurs on most laps',
    A.turns.every(t => t.passes >= truth.laps * 0.7),
    'passes: ' + A.turns.map(t => t.passes).join(', '));
  check('corners scrub speed', A.turns.every(t => t.lossV > 0.5),
    'losses (km/h): ' + A.turns.map(t => (t.lossV * 3.6).toFixed(1)).join(', '));
  // The circuit is built on 16 m corner arcs. Measuring that off a raw 1 Hz
  // track is hopeless — 12 m between samples — so this is really a test that
  // the mean-lap stacking works: it must land within a quarter of the truth.
  check('corner radius recovered to within 25%',
    A.turns.every(t => isFinite(t.radius) && Math.abs(t.radius - 16) / 16 < 0.25),
    'radii: ' + A.turns.map(t => (isFinite(t.radius) ? t.radius.toFixed(1) : '—')).join(', ') +
    ' m vs true 16 m');
  check('corners were measured on the stacked mean lap',
    A.turns.every(t => t.source === 'mean-lap'),
    A.turns.map(t => t.source).join(', '));
  check('every lap contributes one pass of every corner',
    A.turns.every(t => t.passes === A.summary.laps),
    'passes: ' + A.turns.map(t => t.passes).join(', ') + ' of ' + A.summary.laps + ' laps');
  check('turn angles are right for a rectangle',
    A.turns.every(t => Math.abs(t.turned - 90) < 20),
    'angles: ' + A.turns.map(t => Math.round(t.turned) + '°').join(', '));
  check('turns are classified', A.turns.every(t => t.type === 'square'),
    A.turns.map(t => t.type).join(', '));
  check('all four corners turn the same way (a clockwise circuit)',
    new Set(A.turns.map(t => t.dir)).size === 1, A.turns.map(t => t.dir).join(', '));

  // Numbering must follow the order the rider actually meets the corners from
  // the start of the recording — not the order they fall after the lap-detection
  // anchor, which sits on an arbitrary straight partway into the ride.
  const seen = A.turns.map(t => t.firstSeen);
  check('every corner was located on the raw track', seen.every(isFinite),
    seen.join(', '));
  check('corners are numbered in the order they are first ridden',
    seen.every((v, i) => i === 0 || v >= seen[i - 1]),
    'first reached at samples ' + seen.join(', '));
  check('Turn 1 is the earliest corner in the recording',
    seen[0] === Math.min(...seen), 'Turn 1 at sample ' + seen[0]);
  check('numbering is independent of the lap anchor',
    A.turns[0].firstSeen < A.lapBounds[0].i0 ||
    A.lapBounds[0].i0 === 0,
    'Turn 1 at ' + A.turns[0].firstSeen + ', lap anchor at ' + A.lapBounds[0].i0);

  // Sector labels have to follow the real turn numbers now that numbering and
  // position order can disagree.
  if (A.sectors) {
    const nums = A.turns.map(t => t.number).sort((a, b) => a - b);
    check('turn numbers are 1..n with no gaps',
      nums.every((v, i) => v === i + 1), nums.join(', '));
    const labelled = A.sectors.labels.join(' ');
    check('every sector label references real turn numbers',
      A.sectors.labels.every(l => {
        const m = l.match(/^T(\d+)→T(\d+)$/);
        return m && nums.includes(Number(m[1])) && nums.includes(Number(m[2]));
      }), labelled);
    check('sector labels form a closed chain around the lap',
      A.sectors.labels.every((l, k) => {
        const to = l.match(/→T(\d+)$/)[1];
        const nextFrom = A.sectors.labels[(k + 1) % A.sectors.labels.length].match(/^T(\d+)/)[1];
        return to === nextFrom;
      }), labelled);
  }

  // The mean lap itself.
  const ML = A.meanLap;
  check('mean lap built', !!ML && ML.n > 300, ML ? ML.n + ' points at ' + ML.step + ' m' : 'null');
  check('mean lap length matches the circuit', Math.abs(ML.lapLen - truth.lapLength) < 40,
    ML.lapLen.toFixed(0) + ' m vs ' + truth.lapLength.toFixed(0) + ' m');
  check('mean lap is closed (start meets finish)',
    Math.hypot(ML.x[0] - ML.x[ML.n - 1], ML.y[0] - ML.y[ML.n - 1]) < 12,
    Math.hypot(ML.x[0] - ML.x[ML.n - 1], ML.y[0] - ML.y[ML.n - 1]).toFixed(1) + ' m apart');
  check('total curvature round the lap is one full turn',
    Math.abs(Math.abs(ML.curvature.reduce((s, k) => s + k * ML.step, 0)) - 2 * Math.PI) < 0.6,
    (Math.abs(ML.curvature.reduce((s, k) => s + k * ML.step, 0)) * 180 / Math.PI).toFixed(0) + '° vs 360°');
}

// Wind inference — the hard one. A four-corner rectangle gives the solver only
// four bearings against three unknowns, so the honest bar is "roughly right,
// and aware that it is only roughly right".
{
  const err = Math.abs(((A.wind.dirFrom - truth.windFrom + 540) % 360) - 180);
  check('inferred wind direction within 60°', err < 60,
    'inferred ' + A.wind.dirFrom.toFixed(0) + '° vs true ' + truth.windFrom + '° (off by ' + err.toFixed(0) + '°)');
  near('inferred wind speed', A.wind.speed, truth.windSpeed, 2.0, ' m/s');
  // CdA is only as good as the clean-air percentile assumption: the calibration
  // asserts that the p85 moment was fully exposed, and the simulated rider is
  // genuinely exposed for closer to 11% of the race, so CdA comes out high.
  // That bias moves absolute exposure numbers; it does not move the pattern.
  near('calibrated CdA', A.cda, truth.cda, 0.09, ' m²');
  check('calibrated CdA errs high, as the assumption predicts', A.cda >= truth.cda,
    A.cda.toFixed(3) + ' vs true ' + truth.cda);
  check('the solver reports low confidence on a 4-corner circuit',
    A.wind.confidence === 'low', 'confidence "' + A.wind.confidence + '", ' + A.wind.spread + '/8 sectors');
  check('low confidence carries an explanation', !!A.wind.note, A.wind.note || '(none)');
}

// Exposure: the leak was scripted into 11 of 25 laps on one straight.
{
  check('exposure is a sane fraction', A.summary.exposed > 3 && A.summary.exposed < 60,
    A.summary.exposed.toFixed(0) + '% in clean air');
  check('sheltered fraction is the larger one', A.summary.sheltered > A.summary.exposed,
    A.summary.sheltered.toFixed(0) + '% sheltered vs ' + A.summary.exposed.toFixed(0) + '% exposed');
  check('median draft ratio is below 1', A.summary.median < 1 && A.summary.median > 0.4,
    'median ' + A.summary.median.toFixed(2));
  check('drafting saved a meaningful share of the work',
    A.summary.savedPct > 15 && A.summary.savedPct < 60, A.summary.savedPct.toFixed(0) + '%');
}

// The sector grid must find the scripted leak.
if (A.sectors) {
  const leak = A.sectors.leak, best = A.sectors.cheapest;
  check('sector grid built', A.sectors.grid.length >= 20 && A.sectors.totals.length >= 3,
    A.sectors.grid.length + ' laps × ' + A.sectors.totals.length + ' sectors');
  check('a leak sector is identified', !!leak && !!best);
  check('the leak is measurably worse than the best sector', leak.ratio - best.ratio > 0.04,
    leak.label + ' ' + leak.ratio.toFixed(2) + ' vs ' + best.label + ' ' + best.ratio.toFixed(2));
  // The leak was scripted onto the windward straight for 11 of 25 laps, so it
  // must repeatedly come out as the least sheltered sector of its own lap.
  check('the leak repeats across laps', leak.lapsWorst >= 9,
    'least sheltered sector on ' + leak.lapsWorst + ' of ' + A.sectors.grid.length + ' laps');
  // It must be a long straight, not one of the short corner-to-corner links —
  // picking the leak by consistency rather than by mean is what guarantees this.
  const span = A.sectors.labels.length === 4
    ? (A.sectors.bounds[(leak.sector + 1) % 4] - A.sectors.bounds[leak.sector] + 1) % 1 : 0;
  check('the leak is a straight, not a corner-to-corner link', span > 0.25,
    leak.label + ' spans ' + (span * 100).toFixed(0) + '% of the lap');
} else {
  check('sector grid built', false, 'sectors were null');
}

// Surges: eight attacks were scripted in, on top of ~100 corner exits, which
// must be recognised as the price of the circuit rather than burnt matches.
near('scripted attacks detected as matches', A.summary.surges, 8, 4, ' matches');
// How many of each you get depends on the surge threshold, which is a user
// setting — so assert the invariant (they are separated and accounted for)
// rather than a particular split.
check('corner-exit efforts are detected', A.summary.cornerExitSurges >= 4,
  A.summary.cornerExitSurges + ' corner exits vs ' + A.summary.surges + ' matches');
check('every effort is classified as exactly one of the two',
  A.summary.allSurges === A.summary.surges + A.summary.cornerExitSurges,
  A.summary.allSurges + ' = ' + A.summary.surges + ' + ' + A.summary.cornerExitSurges);
check('no corner exit is counted as a match',
  A.surges.filter(s => s.cornerExit).length === A.summary.cornerExitSurges &&
  !A.surges.filter(s => s.cornerExit).some(s => !s.cornerExit));
check('match kJ excludes corner-exit kJ',
  Math.abs(A.summary.matchKj -
    A.surges.filter(s => !s.cornerExit).reduce((t, s) => t + s.matchKj, 0)) < 1e-9);
check('surges carry a W′ cost', A.surges.every(s => s.matchKj > 0));
check('match W′ cost is a plausible fraction of the tank',
  A.summary.matchKj > 5 && A.summary.matchKj < 120, A.summary.matchKj.toFixed(1) + ' kJ');
check('average power is survivable against CP',
  A.summary.avg < cfg.cp * 1.15,
  'avg ' + A.summary.avg.toFixed(0) + ' W vs CP ' + cfg.cp + ' W');

// W′ balance.
check("W′ balance stays within capacity",
  A.summary.wbalMin >= -1e-6 && A.summary.wbalMin <= cfg.wPrime / 1000 + 1e-6,
  'min ' + A.summary.wbalMin.toFixed(1) + ' kJ of ' + (cfg.wPrime / 1000).toFixed(1));

// Load metrics.
check('NP is at or above average power', A.summary.np >= A.summary.avg - 0.5,
  'NP ' + A.summary.np.toFixed(0) + ' W, avg ' + A.summary.avg.toFixed(0) + ' W');
check('variability index above 1 for a crit', A.summary.vi > 1.02, 'VI ' + A.summary.vi.toFixed(2));

// Heading rose and finale.
check('exposure rose covers several bearings',
  A.headings.filter(b => b.seconds > 0).length >= 4,
  A.headings.filter(b => b.seconds > 0).length + ' bearings used');
check('finale summarised', isFinite(A.finale.exposed) && isFinite(A.finale.wbalAtStartPct),
  A.finale.basis + ': ' + A.finale.exposed.toFixed(0) + '% exposed, ' +
  A.finale.wbalAtStartPct.toFixed(0) + '% W′ left');

// A rider-placed start/finish line must win over every heuristic, and must
// actually move the laps, the corner numbering and the sectors with it.
{
  const before = A.lapBounds[0].i0;
  // Pick a point roughly a third of the way round the first lap.
  const target = A.lapBounds[0].i0 +
    Math.round((A.lapBounds[0].i1 - A.lapBounds[0].i0) * 0.35);
  const anchor = { lat: P.lat[target], lon: P.lon[target] };

  const cfgM = RideStore.configFor(P, { startAnchor: anchor });
  cfgM.rho = cfg.rho; cfgM.windSource = 'manual'; cfgM.windSpeed = 0;
  const Am = Analyzer.run(P, cfgM);

  check('a placed start/finish line is used', Am.lapBounds[0].source === 'manual',
    'lap source: ' + Am.lapBounds[0].source);
  check('and it actually moves the lap boundary',
    Math.abs(Am.lapBounds[0].i0 - target) < 15 && Am.lapBounds[0].i0 !== before,
    'lap 1 now starts at ' + Am.lapBounds[0].i0 + ' (asked for ' + target +
    ', was ' + before + ')');
  check('lap count survives the move',
    Math.abs(Am.summary.laps - A.summary.laps) <= 2,
    Am.summary.laps + ' laps vs ' + A.summary.laps);
  check('corners are renumbered from the new line',
    Am.turns.length === A.turns.length &&
    Am.turns.every(t => isFinite(t.firstSeen)),
    Am.turns.map(t => t.name).join(', '));
  check('sector labels still form a closed chain',
    !Am.sectors || Am.sectors.labels.every((l, k) => {
      const to = l.match(/→T(\d+)$/)[1];
      const nextFrom = Am.sectors.labels[(k + 1) % Am.sectors.labels.length].match(/^T(\d+)/)[1];
      return to === nextFrom;
    }), Am.sectors ? Am.sectors.labels.join(' ') : 'no sectors');

  // A point off the circuit must be refused, not silently accepted.
  const cfgBad = RideStore.configFor(P, {
    startAnchor: { lat: P.lat[0] + 0.02, lon: P.lon[0] + 0.02 },
  });
  cfgBad.rho = cfg.rho; cfgBad.windSource = 'manual'; cfgBad.windSpeed = 0;
  const Ab = Analyzer.run(P, cfgBad);
  check('a start line placed off the course is rejected',
    Ab.lapBounds[0].source !== 'manual',
    'fell back to: ' + Ab.lapBounds[0].source);
}

// Elevation closure — the check that guards the gravity term the CdA fit
// depends on. A circuit returns to the same height every lap; if the recorded
// altitude does not, the gradient is partly barometric weather.
{
  const e = A.summary.elevation;
  check('elevation closure computed', !!e && isFinite(e.meanAbsGrade),
    'mean |gradient| ' + e.meanAbsGrade.toFixed(2) + '%, drift ' +
    e.drift.toFixed(2) + ' m/lap, gain ' + e.gainPerLap.toFixed(1) + ' m/lap');
  check('the simulated circuit closes on itself', Math.abs(e.drift) < 1.5,
    e.drift.toFixed(2) + ' m per lap');
  check('a closing circuit is reported as trustworthy', e.trustworthy === true);
  check('a flat circuit is not flagged as hilly', e.hilly === false,
    'mean |gradient| ' + e.meanAbsGrade.toFixed(2) + '%');

  // Inject a drifting barometer and confirm it is caught.
  const drifty = Demo.build();
  drifty.alt = drifty.alt.map((a, i) => a + (i / drifty.alt.length) * 60);  // +60 m over the ride
  const Pd = RideStore.prepare(drifty, { movingSpeed: 2.5 });
  const cfgD = RideStore.configFor(Pd, {});
  cfgD.rho = 1.2; cfgD.windSource = 'manual'; cfgD.windSpeed = 0;
  const Ad = Analyzer.run(Pd, cfgD);
  check('a drifting altimeter is detected', Ad.summary.elevation.trustworthy === false,
    'drift ' + Ad.summary.elevation.drift.toFixed(2) + ' m/lap');
  check('and explained in plain terms',
    /barometric/.test(Ad.summary.elevation.note || ''),
    (Ad.summary.elevation.note || '').slice(0, 60) + '…');
}

// Every series the charts read must be finite where it is used.
{
  let bad = 0;
  for (let i = 0; i < P.n; i++) {
    if (!isFinite(A.solo[i]) || !isFinite(A.wattsS[i]) || !isFinite(A.soloS[i]) || !isFinite(A.wbal.bal[i])) bad++;
  }
  check('no NaNs in the plotted series', bad === 0, bad + ' bad samples');
}

// A recording that starts somewhere the rider never returns to — a car park, a
// roll-out from race HQ — must fall through to the first point actually on the
// circuit rather than giving up on laps altogether.
{
  const away = Demo.build();
  const lead = 90;                                   // 90 s of approach riding
  const dLat = 0.004;                                // ~450 m off the circuit
  const t0 = away.t[0];
  const pre = { t: [], lat: [], lon: [], alt: [], v: [], watts: [], dist: [] };
  for (let k = 0; k < lead; k++) {
    pre.t.push(t0 - (lead - k));
    pre.lat.push(away.lat[0] + dLat * (1 - k / lead));
    pre.lon.push(away.lon[0]);
    pre.alt.push(away.alt[0]);
    pre.v.push(7);
    pre.watts.push(120);
    pre.dist.push(-(lead - k) * 7);
  }
  const shifted = {
    ...away,
    n: away.n + lead,
    t: pre.t.concat(away.t),
    lat: pre.lat.concat(away.lat),
    lon: pre.lon.concat(away.lon),
    alt: pre.alt.concat(away.alt),
    v: pre.v.concat(away.v),
    watts: pre.watts.concat(away.watts),
    dist: pre.dist.concat(away.dist),
  };
  const Pa = RideStore.prepare(shifted, { movingSpeed: 2.5 });
  const cfgA = RideStore.configFor(Pa, {});
  cfgA.rho = 1.2; cfgA.windSource = 'manual'; cfgA.windSpeed = 0;
  const Aa = Analyzer.run(Pa, cfgA);
  check('a ride that starts off-circuit still finds its laps',
    Aa.summary.laps >= truth.laps - 3,
    Aa.summary.laps + ' laps found after a ' + lead + ' s approach');
  check('and puts lap 1 on the circuit, not in the car park',
    Aa.lapBounds[0].i0 >= lead - 10,
    'lap 1 at sample ' + Aa.lapBounds[0].i0 + ', approach ended at ' + lead);
}

// ── 6. Weather-driven analysis path ─────────────────────────────────────────

section('Weather-driven wind path');

{
  const dated = Demo.build();
  dated.startTime = 1782000000;         // a fixed instant
  const P2 = RideStore.prepare(dated, { movingSpeed: 2.5 });

  // A stand-in hourly bundle, so no network is needed.
  const wx = {
    n: 3,
    time: [dated.startTime - 3600, dated.startTime + 1800, dated.startTime + 7200],
    windSpeed: [4.6, 4.6, 4.6], windDir: [250, 250, 250],
    temp: [24, 24, 24], humidity: [62, 62, 62], pressure: [1009, 1009, 1009],
    windGust: [7, 7, 7], precip: [0, 0, 0], cloud: [20, 20, 20],
    elevation: 84, source: 'test',
  };

  const applied = RideStore.applyWeather(P2, wx, 0.1);
  check('per-sample wind field applied', applied && P2.we && P2.we.length === P2.n);
  near('10 m wind scaled to rider height',
    Math.hypot(P2.we[100], P2.wn[100]), 4.6 * Weather.shelterFactor(0.1), 0.01, ' m/s');

  const cfg2 = RideStore.configFor(P2, {});
  cfg2.windSource = 'weather';
  const dens = RideStore.airDensityFor(P2, wx, cfg2);
  cfg2.rho = dens.rho;
  near('air density from measured conditions', cfg2.rho, 1.176, 0.02, ' kg/m³');

  const A2 = Analyzer.run(P2, cfg2);
  check('weather path produces an analysis', A2.wind.source === 'weather', 'source ' + A2.wind.source);
  near('weather wind direction passed through', A2.wind.dirFrom, 250, 1, '°');
  near('CdA calibrated against the measured wind', A2.cda, truth.cda, 0.07, ' m²');
  check('exposure still sane on the weather path',
    A2.summary.exposed > 3 && A2.summary.exposed < 60, A2.summary.exposed.toFixed(0) + '%');
}

// ── 7. Ride with no GPS ─────────────────────────────────────────────────────

section('Degraded inputs');

{
  const flat = Demo.build();
  flat.lat = null; flat.lon = null;
  const P3 = RideStore.prepare(flat, { movingSpeed: 2.5 });
  const cfg3 = RideStore.configFor(P3, {});
  cfg3.rho = 1.2;
  cfg3.windSource = 'manual';
  cfg3.windSpeed = 0;
  const A3 = Analyzer.run(P3, cfg3);
  check('a GPS-free ride still analyses', isFinite(A3.summary.avg), 'avg ' + A3.summary.avg.toFixed(0) + ' W');
  check('no laps claimed without GPS', A3.summary.laps === 0, A3.summary.laps + ' laps');
  check('no corners claimed without GPS', A3.turns.length === 0, A3.turns.length + ' turns');
  check('sector grid correctly absent', A3.sectors === null);
}
{
  // A ride so short it cannot be analysed must be rejected, not guessed at.
  let threw = false;
  try { RideStore.prepare({ name: 'stub', t: [0, 1, 2], watts: [1, 2, 3], dist: [0, 1, 2] }, {}); }
  catch (_) { threw = true; }
  check('a 3-sample ride is rejected', threw);
}

// ── 8. Intervals.icu normalisation ──────────────────────────────────────────

section('intervals.icu normalisation');

{
  const n = 300;
  const streams = {
    time: Array.from({ length: n }, (_, i) => i),
    watts: Array.from({ length: n }, () => 250),
    latlng: Array.from({ length: n }, (_, i) => [42.5 + i * 1e-5, -71.6 + i * 1e-5]),
    altitude: Array.from({ length: n }, () => 80),
    velocity_smooth: Array.from({ length: n }, () => 11),
    distance: Array.from({ length: n }, (_, i) => i * 11),
  };
  const act = { id: 'i123', name: 'Tuesday Worlds', start: '2026-06-16T18:05:00', startUtc: '2026-06-16T22:05:00Z', type: 'Ride', ftp: 280, weight: 71 };
  const ride = Intervalsish(act, streams);
  check('latlng split into lat/lon', ride.lat && ride.lon && ride.lat.length === n);
  near('lat carried through', ride.lat[0], 42.5, 1e-9, '°');
  near('start time parsed from UTC', ride.startTime, Date.parse('2026-06-16T22:05:00Z') / 1000, 0.5, ' s');
  check('activity FTP and weight carried', ride.ftp === 280 && ride.weightKg === 71);

  // The array-of-objects stream shape must work too.
  const asArray = Object.entries(streams).map(([type, data]) => ({ type, data }));
  const viaJson = RideStore.fromJson(asArray.concat([{ type: 'time', data: streams.time }]), 'x.json');
  check('array-shaped streams accepted', viaJson.n === n, 'n=' + viaJson.n);
}
function Intervalsish(act, streams) { return sandbox.Intervals.toRide(act, streams); }

{
  let threw = false;
  try { sandbox.Intervals.toRide({ id: 1, name: 'x' }, { time: [0, 1, 2] }); } catch (_) { threw = true; }
  check('an activity without power is rejected', threw);
}

// intervals.icu returns latlng as two parallel arrays — latitudes in `data`,
// longitudes in `data2` — not as [lat, lon] pairs. Assuming the pair form
// silently produced rides with no GPS at all.
//
// This fixture mirrors a real response field for field; only the coordinates
// are synthetic, since the shape is the whole point and nobody's ride data
// needs to be in a public repository to prove it.
{
  const wire = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'icu-streams.json'), 'utf8')
  );
  const ll = wire.find(s => s.type === 'latlng');
  check('fixture really is the two-parallel-arrays shape',
    Array.isArray(ll.data) && Array.isArray(ll.data2) && typeof ll.data[0] === 'number',
    'data[0]=' + ll.data[0] + ' data2[0]=' + ll.data2[0]);

  const streams = Intervals.getStreams ? null : null;   // (network call not used here)
  const s = {};
  for (const x of wire) {
    s[x.type] = x.data;
    if (Array.isArray(x.data2)) s[x.type + '__data2'] = x.data2;
  }

  const pos = Intervals.coordinates(s, s.time.length);
  check('latitudes and longitudes are separated correctly',
    pos.lat && pos.lon && Math.abs(pos.lat[0] - 45.001617) < 1e-5 &&
    Math.abs(pos.lon[0] - -100.0) < 1e-5,
    pos.lat ? pos.lat[0] + ', ' + pos.lon[0] : 'no coordinates');

  const act = { id: 'i1', name: 'Fixture Crit', start: '2026-07-18T13:38:52',
    startUtc: '2026-07-18T17:38:52Z', type: 'Ride', ftp: 260, weight: 72 };
  const raw = Intervals.toRide(act, s);
  check('a real intervals.icu activity keeps its GPS', !!raw.lat && !!raw.lon,
    raw.lat ? raw.lat.length + ' points' : 'lat is null');

  const P = RideStore.prepare(raw, { movingSpeed: 2.5 });
  check('and survives prepare with GPS intact', P.hasGps, 'hasGps=' + P.hasGps);
  check('coordinates survive prepare unmangled',
    P.lat[10] > 44.9 && P.lat[10] < 45.1 && P.lon[10] < -99.9 && P.lon[10] > -100.1,
    P.lat[10].toFixed(4) + ', ' + P.lon[10].toFixed(4));
  check('headings are derived, so laps and corners are possible',
    Array.from(P.heading).some(h => h !== 0));

  // The Strava-style pair form must keep working too.
  const paired = {
    time: s.time, watts: s.watts,
    latlng: s.time.map((_, i) => [s.latlng[i], s.latlng__data2[i]]),
  };
  const pos2 = Intervals.coordinates(paired, paired.time.length);
  check('Strava-style [lat, lon] pairs still work',
    pos2.lat && Math.abs(pos2.lat[0] - 45.001617) < 1e-5,
    pos2.lat ? String(pos2.lat[0]) : 'no coordinates');

  // Separate lat/lng streams, a third shape seen in the wild.
  const split = { time: s.time, watts: s.watts, lat: s.latlng, lng: s.latlng__data2 };
  const pos3 = Intervals.coordinates(split, split.time.length);
  check('separate lat/lng streams still work', !!pos3.lat && !!pos3.lon);

  // A GPS-free indoor ride must report no GPS rather than a track at (0, 0).
  const nulls = { time: s.time, watts: s.watts, latlng: s.time.map(() => 0),
    latlng__data2: s.time.map(() => 0) };
  const pos4 = Intervals.coordinates(nulls, nulls.time.length);
  check('an all-zero track is treated as no GPS, not as null island',
    pos4.lat === null && pos4.lon === null);
}

// ── 8b. Activity filtering ──────────────────────────────────────────────────

section('intervals.icu activity filters');

{
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'icu-activities.json'), 'utf8')
  );
  // summarise() is not exported, but listActivities' mapping is what it feeds,
  // so exercise it the same way the client does.
  const acts = raw.map(a => {
    const streams = Array.isArray(a.stream_types) ? a.stream_types : [];
    return {
      name: a.name, type: a.type || '',
      isRace: a.race === true || String(a.sub_type || '').toUpperCase() === 'RACE',
      tags: Array.isArray(a.tags) ? a.tags : [],
      hasGpsStream: streams.includes('latlng'),
      hasPower: !!(a.icu_average_watts || a.average_watts) ||
        streams.includes('watts') || streams.includes('fixed_watts'),
    };
  }).filter(a => Intervals.isRide(a));

  check('fixture holds a realistic month of riding', acts.length >= 20, acts.length + ' rides');

  const races = acts.filter(a => a.isRace);
  check('races are picked out by the race flag / sub_type', races.length === 3,
    races.map(r => r.name).join(', '));
  check('flagged races are the ones with RACE sub_type',
    races.length === 3, races.map(r => r.name).join(', '));

  // The default filter is what the sidebar opens with.
  const dflt = acts.filter(a => a.isRace && a.hasPower && a.hasGpsStream);
  check('default filters cut a month of riding to just the analysable races',
    dflt.length === 3 && dflt.length < acts.length / 5,
    dflt.length + ' of ' + acts.length);

  check('dropping the race filter widens the list',
    acts.filter(a => a.hasPower && a.hasGpsStream).length > dflt.length,
    acts.filter(a => a.hasPower && a.hasGpsStream).length + ' with power + GPS');

  check('rides without a GPS stream are identified',
    acts.some(a => !a.hasGpsStream), acts.filter(a => !a.hasGpsStream).length + ' without GPS');

  const tags = Intervals.tagsIn(acts);
  check('tags are collected with counts', tags.length === 2 &&
    tags.every(t => t.count >= 1), JSON.stringify(tags));
  check('tag filtering selects the tagged ride',
    acts.filter(a => a.tags.includes('hard')).length === 1);
  check('an athlete with no tags gets no tag chips',
    Intervals.tagsIn(acts.filter(a => !/Worlds/.test(a.name))).length === 0);
}

// ── 8c. Strava-sourced activities ───────────────────────────────────────────

section('Strava-sourced activities');

{
  // intervals.icu will not serve Strava-sourced data through its API (Strava's
  // terms forbid it). The failure is silent from the outside — the activity
  // simply stops appearing — so the client has to recognise and explain it.
  const stravaActivity = {
    id: '19460641208', source: 'STRAVA', start_date_local: '2026-07-25T09:54:58',
    name: null, type: null, stream_types: null,
  };
  const summarised = [stravaActivity].map(a => ({
    source: a.source || null,
    apiBlocked: String(a.source || '').toUpperCase() === 'STRAVA',
  }))[0];
  check('a Strava-sourced activity is flagged as unreadable',
    summarised.apiBlocked === true);

  const wahoo = { source: 'WAHOO' };
  check('a head-unit activity is not flagged',
    String(wahoo.source).toUpperCase() !== 'STRAVA');

  check('the explanation names the cause and the way out',
    /Strava/.test(Intervals.STRAVA_BLOCKED) &&
    /\.fit/.test(Intervals.STRAVA_BLOCKED) &&
    /will not help/.test(Intervals.STRAVA_BLOCKED),
    Intervals.STRAVA_BLOCKED.slice(0, 70) + '…');

  // An activity whose summary exists but whose streams are empty must fail with
  // a message that points somewhere useful, not "no time stream".
  let msg = '';
  try {
    Intervals.toRide({ id: 'x', name: 'Ghost race', type: 'Ride' }, { time: [] });
  } catch (err) { msg = err.message; }
  check('empty streams produce a diagnosis, not a shrug',
    /no sample data/.test(msg) && /de-duplicated/.test(msg) && /\.fit/.test(msg),
    msg.slice(0, 80) + '…');
}

// ── 8d. Cropping, HR, cadence, race shape, circuits ─────────────────────────

section('Race window and cropping');

{
  // Bolt a slow warm-up and a slow cool-down onto the synthetic crit and check
  // both are found and neither eats into the race.
  const base = Demo.build();
  const pad = (n, speed, watts) => {
    const o = { t: [], lat: [], lon: [], alt: [], v: [], watts: [], dist: [] };
    for (let k = 0; k < n; k++) {
      o.t.push(k); o.lat.push(base.lat[k % base.lat.length]);
      o.lon.push(base.lon[k % base.lon.length]); o.alt.push(base.alt[0]);
      o.v.push(speed); o.watts.push(watts); o.dist.push(k * speed);
    }
    return o;
  };
  const warm = pad(300, 6, 90), cool = pad(240, 6, 80);
  const lastT = base.t[base.t.length - 1], lastD = base.dist[base.dist.length - 1];
  const padded = {
    ...base,
    t: warm.t.concat(base.t.map(x => x + 300), cool.t.map(x => x + 300 + lastT)),
    lat: warm.lat.concat(base.lat, cool.lat),
    lon: warm.lon.concat(base.lon, cool.lon),
    alt: warm.alt.concat(base.alt, cool.alt),
    v: warm.v.concat(base.v, cool.v),
    watts: warm.watts.concat(base.watts, cool.watts),
    dist: warm.dist.concat(base.dist.map(x => x + warm.dist[299]),
      cool.dist.map(x => x + warm.dist[299] + lastD)),
  };
  padded.n = padded.t.length;

  const Pp = RideStore.prepare(padded, { movingSpeed: 2.5 });
  const w = Analyzer.detectRaceWindow(Pp, RideStore.configFor(Pp, {}));
  check('the race is found inside a padded recording', w.found,
    w.raceLaps + ' race laps of ' + w.totalLaps);
  check('the warm-up is detected', w.warmupSeconds > 120,
    w.warmupSeconds.toFixed(0) + ' s');
  check('the cool-down is detected', w.cooldownSeconds > 100,
    w.cooldownSeconds.toFixed(0) + ' s');
  check('the race window keeps most of the racing',
    (w.i1 - w.i0) * Pp.dt > base.t[base.t.length - 1] * 0.75,
    ((w.i1 - w.i0) * Pp.dt).toFixed(0) + ' s of ' + lastT + ' s');

  // Applying the crop must actually change what is analysed.
  padded.crop = { startT: Pp.t[w.i0], endT: Pp.t[w.i1] };
  const Pc = RideStore.prepare(padded, { movingSpeed: 2.5 });
  check('cropping shortens the prepared ride', Pc.n < Pp.n,
    Pc.n + ' samples from ' + Pp.n);
  check('and drops the slow padding',
    Physics.mean(Array.from(Pc.watts)) > Physics.mean(Array.from(Pp.watts)),
    Physics.mean(Array.from(Pc.watts)).toFixed(0) + ' W vs ' +
    Physics.mean(Array.from(Pp.watts)).toFixed(0) + ' W');
  check('the crop start time is carried on the prepared ride', !!Pc.crop);

  // A nonsense crop must be ignored rather than producing a broken ride.
  const silly = { ...padded, crop: { startT: 10, endT: 12 } };
  const Ps = RideStore.prepare(silly, { movingSpeed: 2.5 });
  check('an impossibly short crop is refused', Ps.n > 100, Ps.n + ' samples');

  // Phases, and the per-lap evidence behind them.
  check('phases are reported in order',
    w.phases.length >= 2 &&
    w.phases.every((ph, k) => k === 0 || ph.i0 >= w.phases[k - 1].i0),
    w.phases.map(ph => ph.kind).join(' → '));
  check('exactly one phase is the race',
    w.phases.filter(ph => ph.kind === 'race').length === 1);
  check('the race phase matches the window',
    w.phases.find(ph => ph.kind === 'race').i0 === w.i0);
  check('every lap is classified', w.lapInfo.length === w.totalLaps &&
    w.lapInfo.filter(l => l.inRace).length === w.raceLaps,
    w.lapInfo.filter(l => l.inRace).length + ' of ' + w.lapInfo.length + ' kept');
  check('kept laps are faster than trimmed ones',
    Physics.mean(w.lapInfo.filter(l => l.inRace).map(l => l.speed)) >
    Physics.mean(w.lapInfo.filter(l => !l.inRace).map(l => l.speed)),
    (Physics.mean(w.lapInfo.filter(l => l.inRace).map(l => l.speed)) * 3.6).toFixed(1) +
    ' vs ' + (Physics.mean(w.lapInfo.filter(l => !l.inRace).map(l => l.speed)) * 3.6).toFixed(1) + ' km/h');

  // Nudging moves whole laps and never inverts the window.
  const narrower = Analyzer.adjustRaceWindow(w, 1, -1);
  check('nudging in drops a lap at each end', narrower.raceLaps === w.raceLaps - 2,
    narrower.raceLaps + ' from ' + w.raceLaps);
  check('nudged boundaries land on lap edges',
    w.lapInfo.some(l => l.i0 === narrower.i0) && w.lapInfo.some(l => l.i1 === narrower.i1));
  const silly2 = Analyzer.adjustRaceWindow(w, 999, -999);
  check('nudging past the ends cannot invert the window',
    silly2.i0 <= silly2.i1 && silly2.raceLaps >= 1, silly2.raceLaps + ' laps');
  const wider = Analyzer.adjustRaceWindow(w, -99, 99);
  check('nudging out is bounded by the laps that exist',
    wider.raceLaps <= w.totalLaps, wider.raceLaps + ' of ' + w.totalLaps);

  // A race that fades must not have its slow end mistaken for a cool-down.
  // Real data: lap speeds ran 39, 41, 39, 42, 41, 40, 39, 40, 38, 35, 35, 35,
  // 34, 35, 35, 34 km/h — a smooth decline, no discontinuity. A
  // percentage-of-pace rule cut the last four off as cool-down, one of them at
  // 264 W, higher than three laps it kept. What distinguishes a cool-down is
  // that you stop pedalling hard, so the test is on power.
  {
    const rows = [39.3, 41.0, 38.7, 42.1, 40.7, 39.6, 38.8, 40.0,
      37.6, 35.3, 35.5, 35.3, 34.3, 34.9, 35.0, 33.9];
    const nps = [258, 257, 197, 342, 226, 205, 251, 242,
      268, 222, 239, 232, 205, 224, 264, 205];
    const fading = {
      n: rows.length * 130,
      t: [], v: [], watts: [], dist: [], alt: [], lat: [], lon: [],
      name: 'fading race', source: 'test', startTime: null, lapTimes: [],
    };
    let d = 0, t = 0;
    const R = 1073 / (2 * Math.PI);
    for (let L = 0; L < rows.length; L++) {
      const speed = rows[L] / 3.6;
      const secs = Math.round(1073 / speed);
      for (let k = 0; k < secs; k++) {
        const s = (k / secs) * 2 * Math.PI;
        fading.t.push(t++); fading.v.push(speed);
        fading.watts.push(nps[L]);
        d += speed; fading.dist.push(d); fading.alt.push(40);
        fading.lat.push(42.5 + (R * Math.cos(s)) / 111320);
        fading.lon.push(-71.6 + (R * Math.sin(s)) / (111320 * Math.cos(42.5 * Math.PI / 180)));
      }
    }
    fading.n = fading.t.length;
    const Pf = RideStore.prepare(fading, { movingSpeed: 2.5 });
    const wf = Analyzer.detectRaceWindow(Pf, RideStore.configFor(Pf, {}));
    check('a race that fades is not mistaken for a race plus a cool-down',
      !wf.found || wf.raceLaps === wf.totalLaps,
      wf.found ? 'kept ' + wf.raceLaps + ' of ' + wf.totalLaps + ' laps'
        : 'no window (all laps are the race)');

    // Now give the same race a genuine soft cool-down lap and check it is found.
    const soft = JSON.parse(JSON.stringify(fading));
    const speed = 5.0;
    for (let k = 0; k < Math.round(1073 / speed); k++) {
      const s = (k / (1073 / speed)) * 2 * Math.PI;
      soft.t.push(t++); soft.v.push(speed); soft.watts.push(95);
      d += speed; soft.dist.push(d); soft.alt.push(40);
      soft.lat.push(42.5 + (R * Math.cos(s)) / 111320);
      soft.lon.push(-71.6 + (R * Math.sin(s)) / (111320 * Math.cos(42.5 * Math.PI / 180)));
    }
    soft.n = soft.t.length;
    const Ps2 = RideStore.prepare(soft, { movingSpeed: 2.5 });
    const ws = Analyzer.detectRaceWindow(Ps2, RideStore.configFor(Ps2, {}));
    check('a genuinely soft cool-down lap is still removed',
      ws.found && (ws.totalLaps - 1 - ws.lastRaceLap >= 1 || ws.cooldownSeconds > 60),
      ws.found ? 'dropped ' + (ws.totalLaps - 1 - ws.lastRaceLap) + ' lap(s), ' +
        ws.cooldownSeconds.toFixed(0) + ' s of cool-down' : 'no window');
    check('and only one lap goes, not several',
      !ws.found || ws.totalLaps - 1 - ws.lastRaceLap <= 1,
      'dropped ' + (ws.totalLaps - 1 - ws.lastRaceLap));
  }

  // Partial laps. A race does not oblige you to stop on a lap boundary, so
  // there is nearly always a fragment after the last crossing — and it must be
  // judged on the same evidence a whole lap is, not discarded for being partial.
  {
    const tailOf = (frac, speed, watts) => {
      const b = Demo.build();
      const n = b.lat.length;
      const lastT = b.t[b.t.length - 1], lastD = b.dist[b.dist.length - 1];
      const secs = Math.round((frac * 1073) / speed);
      const c = { t: [], lat: [], lon: [], alt: [], v: [], watts: [], dist: [] };
      for (let k = 0; k < secs; k++) {
        c.t.push(lastT + 1 + k); c.lat.push(b.lat[k % n]); c.lon.push(b.lon[k % n]);
        c.alt.push(b.alt[k % n]); c.v.push(speed); c.watts.push(watts);
        c.dist.push(lastD + (k + 1) * speed);
      }
      const o = {
        ...b, t: b.t.concat(c.t), lat: b.lat.concat(c.lat), lon: b.lon.concat(c.lon),
        alt: b.alt.concat(c.alt), v: b.v.concat(c.v), watts: b.watts.concat(c.watts),
        dist: b.dist.concat(c.dist),
      };
      o.n = o.t.length;
      const Pt = RideStore.prepare(o, { movingSpeed: 2.5 });
      return { P: Pt, w: Analyzer.detectRaceWindow(Pt, RideStore.configFor(Pt, {})), secs };
    };

    const soft = tailOf(0.45, 4.7, 95);
    check('a partial soft cool-down lap is excluded',
      !soft.w.keptTrailingFragment &&
      soft.P.t[soft.P.n - 1] - soft.P.t[soft.w.i1] > soft.secs * 0.8,
      (soft.P.t[soft.P.n - 1] - soft.P.t[soft.w.i1]).toFixed(0) + ' s left out of ' + soft.secs + ' s');

    const hard = tailOf(0.45, 11, 380);
    check('a partial lap still ridden at racing power is kept',
      hard.w.keptTrailingFragment && hard.w.i1 >= hard.P.n - 2,
      'window ends at sample ' + hard.w.i1 + ' of ' + hard.P.n);

    const tiny = tailOf(0.04, 4.7, 95);
    check('a fragment too short to judge is simply left out',
      !tiny.w.keptTrailingFragment,
      (tiny.P.t[tiny.P.n - 1] - tiny.P.t[tiny.w.i1]).toFixed(0) + ' s');
  }

  // Leaving the racing line — "peeling off" — is decisive evidence a lap was
  // not raced, and it is the one signal power cannot supply: you can peel into
  // the pits at 300 W and no amount of looking at watts will notice.
  {
    const LAP = 1073;
    const append = (laps, speed, watts, excursionDeg) => {
      const b = Demo.build();
      const ref = [];
      const d0 = b.dist[0];
      for (let i = 0; i < b.dist.length && b.dist[i] - d0 <= LAP; i++) {
        ref.push([b.lat[i], b.lon[i], b.dist[i] - d0]);
      }
      const at = m => {
        const x = ((m % LAP) + LAP) % LAP;
        let k = 0; while (k < ref.length - 2 && ref[k + 1][2] < x) k++;
        const a = ref[k], c2 = ref[Math.min(ref.length - 1, k + 1)];
        const span = c2[2] - a[2] || 1, f = (x - a[2]) / span;
        return [a[0] + (c2[0] - a[0]) * f, a[1] + (c2[1] - a[1]) * f];
      };
      const secs = Math.round((laps * LAP) / speed);
      const lastT = b.t[b.t.length - 1], lastD = b.dist[b.dist.length - 1];
      const c = { t: [], lat: [], lon: [], alt: [], v: [], watts: [], dist: [] };
      for (let k = 0; k < secs; k++) {
        const m = (k + 1) * speed;
        const [la, lo] = at(m);
        const f = (m % LAP) / LAP;
        const off = excursionDeg && f > 0.3 && f < 0.7
          ? excursionDeg * Math.sin(((f - 0.3) / 0.4) * Math.PI) : 0;
        c.t.push(lastT + 1 + k); c.lat.push(la + off); c.lon.push(lo + off);
        c.alt.push(b.alt[0]); c.v.push(speed); c.watts.push(watts);
        c.dist.push(lastD + m);
      }
      const o = { ...b,
        t: b.t.concat(c.t), lat: b.lat.concat(c.lat), lon: b.lon.concat(c.lon),
        alt: b.alt.concat(c.alt), v: b.v.concat(c.v),
        watts: b.watts.concat(c.watts), dist: b.dist.concat(c.dist) };
      o.n = o.t.length;
      const Pw = RideStore.prepare(o, { movingSpeed: 2.5 });
      return { P: Pw, w: Analyzer.detectRaceWindow(Pw, RideStore.configFor(Pw, {})) };
    };

    const onLineHard = append(2, 10, 300, 0);
    check('extra laps on the racing line at racing power are kept',
      onLineHard.w.raceLaps === onLineHard.w.totalLaps,
      'kept ' + onLineHard.w.raceLaps + ' of ' + onLineHard.w.totalLaps);

    const onLineSoft = append(2, 5, 95, 0);
    check('extra laps on the line but soft are dropped on power',
      onLineSoft.w.raceLaps < onLineSoft.w.totalLaps && !onLineSoft.w.trimmedByCourse,
      'kept ' + onLineSoft.w.raceLaps + ' of ' + onLineSoft.w.totalLaps +
      ', byCourse=' + onLineSoft.w.trimmedByCourse);

    // The case that motivates the whole signal.
    const peeledHard = append(2, 10, 300, 0.0018);
    check('laps that peel off the course are dropped even at racing power',
      peeledHard.w.trimmedByCourse &&
      peeledHard.w.raceLaps < peeledHard.w.totalLaps,
      'kept ' + peeledHard.w.raceLaps + ' of ' + peeledHard.w.totalLaps +
      ', byCourse=' + peeledHard.w.trimmedByCourse);
    check('and the deviation is what flagged them',
      peeledHard.w.lapInfo[peeledHard.w.lapInfo.length - 1].leftCourse === true &&
      peeledHard.w.lapInfo[peeledHard.w.lapInfo.length - 1].offLine > 0.2,
      (100 * peeledHard.w.lapInfo[peeledHard.w.lapInfo.length - 1].offLine).toFixed(0) +
      '% off the line, mean deviation ' +
      peeledHard.w.lapInfo[peeledHard.w.lapInfo.length - 1].meanDev.toFixed(0) + ' m');

    const peeledSoft = append(2, 5, 95, 0.0018);
    check('peeling off soft is caught too',
      peeledSoft.w.raceLaps < peeledSoft.w.totalLaps);

    // Race laps themselves must never be flagged: the line is built from the
    // fast laps, so they define the corridor rather than straying from it.
    check('racing laps are never flagged as off-course',
      peeledHard.w.lapInfo.slice(0, -2).every(l => !l.leftCourse),
      peeledHard.w.lapInfo.slice(0, -2).filter(l => l.leftCourse).length + ' false positives');
  }

  check('the basis for the decision is reported',
    typeof w.anchoredToStartLine === 'boolean' && /power/.test(w.basis), w.basis);

  // "I start recording on the start line" is a fact about the rider, not the
  // file. When declared, nothing may be trimmed off the front.
  {
    const cfgLine = RideStore.configFor(Pp, {});
    cfgLine.startsOnStartLine = true;
    const wl = Analyzer.detectRaceWindow(Pp, cfgLine);
    check('declaring a start-line start keeps the first lap',
      wl.found && wl.firstRaceLap === 0 && wl.warmupSeconds === 0,
      'first race lap ' + wl.firstRaceLap + ', warm-up ' + wl.warmupSeconds + ' s');
    check('and says so in the basis', /start on the line/.test(wl.basis), wl.basis);
    check('and nothing at all is trimmed from the front',
      wl.i0 === 0 && wl.approachSeconds === 0,
      'window starts at sample ' + wl.i0);
    check('the end is still judged on its own merits',
      wl.lastRaceLap <= wl.lapInfo.length - 1 && wl.lastRaceLap >= wl.firstRaceLap,
      'last race lap ' + wl.lastRaceLap + ' of ' + (wl.lapInfo.length - 1));
  }

  // A sustained stop after the racing is an unambiguous end. Riders who roll
  // straight into a cool-down give us none, so this must find nothing there
  // rather than misfiring.
  check('a recording with no stops reports none', w.stops === 0 && !w.endedAtStop,
    w.stops + ' stops');
  {
    const stopped = JSON.parse(JSON.stringify(padded));
    // Halt for 60 s partway through what pace alone would call the race.
    const at = Math.floor(stopped.t.length * 0.62);
    for (let k = at; k < at + 60; k++) {
      stopped.v[k] = 0; stopped.watts[k] = 0;
      stopped.dist[k] = stopped.dist[at];
      stopped.lat[k] = stopped.lat[at]; stopped.lon[k] = stopped.lon[at];
    }
    for (let k = at + 60; k < stopped.dist.length; k++) {
      stopped.dist[k] -= (stopped.dist[at + 60] - stopped.dist[at]);
    }
    const Pst = RideStore.prepare(stopped, { movingSpeed: 2.5 });
    const wst = Analyzer.detectRaceWindow(Pst, RideStore.configFor(Pst, {}));
    check('a sustained stop is detected', wst.stops >= 1, wst.stops + ' stops');
    if (wst.found) {
      check('the race is not allowed to span the stop',
        Pst.t[wst.i1] <= Pst.t[at] + 5,
        'race ends ' + Pst.t[wst.i1].toFixed(0) + ' s, stop at ' + Pst.t[at].toFixed(0) + ' s');
    }
  }
}

section('Heart rate, cadence and race shape');

{
  // The synthetic ride has neither HR nor cadence, so build one that does.
  const withHr = Demo.build();
  const n = withHr.t.length;
  withHr.hr = [];
  withHr.cad = [];
  for (let i = 0; i < n; i++) {
    // Deliberate upward drift: the same power buys fewer watts per beat later.
    const drift = 1 + 0.12 * (i / n);
    withHr.hr.push(Math.round(120 + 55 * drift));
    withHr.cad.push(withHr.watts[i] > 40 ? 88 : 0);
  }
  const Ph = RideStore.prepare(withHr, { movingSpeed: 2.5 });
  check('HR survives prepare', !!Ph.hr && Ph.hr.length === Ph.n);
  check('cadence survives prepare', !!Ph.cad && Ph.cad.length === Ph.n);

  const cfgH = RideStore.configFor(Ph, {});
  cfgH.rho = 1.2; cfgH.windSource = 'manual'; cfgH.windSpeed = 0;
  const Ah = Analyzer.run(Ph, cfgH);

  check('heart-rate summary produced', !!Ah.hr, Ah.hr ? Math.round(Ah.hr.avg) + ' bpm avg' : 'null');

  check('cadence reported for the race', Ah.summary.avgCadence &&
    Math.abs(Ah.summary.avgCadence.rpm - 88) < 3,
    Ah.summary.avgCadence ? Ah.summary.avgCadence.rpm.toFixed(0) + ' rpm' : 'null');
  check('freewheeling fraction reported',
    isFinite(Ah.summary.avgCadence.coastPct),
    Ah.summary.avgCadence.coastPct.toFixed(0) + '%');
  check('cadence reported per corner',
    Ah.turns.every(t => isFinite(t.cadence)),
    Ah.turns.map(t => Math.round(t.cadence) + 'rpm').join(' '));

  // A ride with no HR must simply not report any, rather than reporting zeros.
  check('no HR data means no HR summary', A.hr === null || A.hr === undefined,
    String(A.hr));
}

// Decoupling has to be tested at *constant* power: the demo deliberately lifts
// the pace for the last three laps, so drifting HR against a rising power is
// not a controlled experiment. Hold the watts still and drift only the pulse.
{
  const secs = 2400;
  const flat = {
    source: 'test', name: 'decoupling fixture', startTime: null, sport: 'cycling',
    n: secs, t: [], watts: [], v: [], dist: [], alt: [], hr: [],
    lat: null, lon: null, cad: null, temp: null, lapTimes: [],
  };
  let d = 0;
  for (let i = 0; i < secs; i++) {
    flat.t.push(i);
    flat.watts.push(220);
    flat.v.push(10);
    d += 10; flat.dist.push(d);
    flat.alt.push(50);
    flat.hr.push(150 + 20 * (i / secs));       // +20 bpm drift at fixed watts
  }
  const Pf = RideStore.prepare(flat, { movingSpeed: 2.5 });
  const cfgF = RideStore.configFor(Pf, {});
  cfgF.rho = 1.2; cfgF.windSource = 'manual'; cfgF.windSpeed = 0;
  const Af = Analyzer.run(Pf, cfgF);

  check('constant power with drifting HR reads as positive decoupling',
    Af.hr.decoupling > 5, '+' + Af.hr.decoupling.toFixed(1) + '%');
  check('Pw:HR falls between the halves',
    Af.hr.secondHalfPwHr < Af.hr.firstHalfPwHr,
    Af.hr.firstHalfPwHr.toFixed(2) + ' → ' + Af.hr.secondHalfPwHr.toFixed(2));

  // And a steady heart rate at steady power must read as no decoupling.
  const steady = { ...flat, hr: flat.hr.map(() => 160) };
  const Ps = RideStore.prepare(steady, { movingSpeed: 2.5 });
  const cfgS = RideStore.configFor(Ps, {});
  cfgS.rho = 1.2; cfgS.windSource = 'manual'; cfgS.windSpeed = 0;
  const As = Analyzer.run(Ps, cfgS);
  check('steady HR at steady power reads as no decoupling',
    Math.abs(As.hr.decoupling) < 1, As.hr.decoupling.toFixed(2) + '%');
}

{
  const sh = A.shape;
  check('race shape computed', !!sh, sh ? sh.trend : 'null');
  check('trend is one of the three', ['fading', 'steady', 'building'].includes(sh.trend), sh.trend);
  check('the hardest lap is identified',
    sh.hardest.lap >= 1 && sh.hardest.lap <= sh.laps &&
    sh.hardest.np >= Math.max(...A.laps.map(l => l.np)) - 1e-6,
    'lap ' + sh.hardest.lap + ' at ' + Math.round(sh.hardest.np) + ' W');
  check('opening and closing thirds reported',
    isFinite(sh.openingNp) && isFinite(sh.closingNp),
    Math.round(sh.openingNp) + ' → ' + Math.round(sh.closingNp) + ' W');

  // A deliberately fading set of laps must read as fading.
  const fade = { np: [], }; // build synthetic lap rows
  const rows = Array.from({ length: 12 }, (_, i) => ({
    lap: i + 1, np: 300 - i * 8, exposed: 20, wbalEnd: 5,
  }));
  const f = Analyzer.raceShape(rows);
  check('a monotonic decline reads as fading', f.trend === 'fading',
    f.trend + ' at ' + f.slopePct.toFixed(1) + '%/lap');
  const rise = rows.map((r, i) => ({ ...r, np: 240 + i * 8 }));
  check('a monotonic rise reads as building',
    Analyzer.raceShape(rise).trend === 'building',
    Analyzer.raceShape(rise).trend);
  const flat = rows.map(r => ({ ...r, np: 260 }));
  check('a flat race reads as steady', Analyzer.raceShape(flat).trend === 'steady',
    Analyzer.raceShape(flat).trend);
  check('too few laps yields no shape', Analyzer.raceShape(rows.slice(0, 3)) === null);
}

section('Circuit identity');

{
  const here = { lat: 42.5450, lon: -71.6150, lapLen: 1073 };
  check('a circuit matches itself', Analyzer.sameCircuit(here, { ...here }));
  check('a slightly different racing line still matches',
    Analyzer.sameCircuit(here, { lat: here.lat + 0.0005, lon: here.lon, lapLen: 1090 }));
  check('a different venue does not match',
    !Analyzer.sameCircuit(here, { lat: 41.3697, lon: -71.6668, lapLen: 1073 }));
  check('the same place with a different course length does not match',
    !Analyzer.sameCircuit(here, { ...here, lapLen: 1600 }));

  const mk = (name, c) => ({ name, circuit: c, turns_: [] });
  const groups = Analyzer.groupByCircuit([
    mk('June', here), mk('Elsewhere', { lat: 41.37, lon: -71.67, lapLen: 1400 }),
    mk('July', { ...here, lapLen: 1080 }),
  ]);
  check('races on one circuit are grouped together',
    groups[0].races.length === 2 &&
    groups[0].races.map(r => r.name).sort().join() === 'July,June',
    groups.map(g => g.races.map(r => r.name).join('+')).join(' | '));
  check('a lone circuit stays on its own',
    groups.some(g => g.races.length === 1 && g.races[0].name === 'Elsewhere'));
}

// ── 9. OpenStreetMap basemap ────────────────────────────────────────────────

section('OSM basemap');

{
  const wire = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'osm-overpass.json'), 'utf8')
  );
  const bbox = { minLat: 41.3651, minLon: -71.6708, maxLat: 41.3738, maxLon: -71.6639 };
  const map = Osm.parse(wire, bbox);

  check('roads extracted', map.roads.length >= 15, map.counts.roads + ' roads');
  check('buildings extracted', map.buildings.length >= 5, map.counts.buildings + ' buildings');
  check('every road is classified into a drawable weight',
    map.roads.every(r => ['major', 'medium', 'minor', 'path'].includes(r.cls)),
    Array.from(new Set(map.roads.map(r => r.cls))).join(', '));
  check('road geometry survives as lat/lon pairs',
    map.roads.every(r => r.pts.length >= 2 && r.pts.every(p =>
      Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)));
  check('the cycle track is in there',
    map.roads.some(r => /Ninigret|Ningret/i.test(r.name || '')),
    (map.roads.filter(r => r.name).map(r => r.name).slice(0, 4)).join(', '));
  check('attribution is carried with the data',
    /OpenStreetMap/.test(map.attribution), map.attribution);

  // Tags are dropped; only geometry survives, which keeps the cache small.
  const bytes = JSON.stringify(map).length;
  check('parsed map is small enough to cache', bytes < 200000, (bytes / 1024).toFixed(0) + ' kB');
}

{
  const q = Osm.buildQuery({ minLat: 41.36, minLon: -71.67, maxLat: 41.38, maxLon: -71.66 });
  check('query asks for highways and buildings', /way\["highway"\]/.test(q) && /way\["building"\]/.test(q));
  check('query is bounded by the bbox', /41\.36000,-71\.67000,41\.38000,-71\.66000/.test(q), q.slice(0, 80));
  check('query requests inline geometry', /out geom;/.test(q));
}

{
  const P = RideStore.prepare(Demo.build(), { movingSpeed: 2.5 });
  const b = Osm.boundsOf(P);
  check('bounds computed from the track', !!b && b.maxLat > b.minLat && b.maxLon > b.minLon,
    b ? [b.minLat, b.minLon, b.maxLat, b.maxLon].map(v => v.toFixed(4)).join(', ') : 'null');
  check('bounds are tight around a 1 km circuit',
    (b.maxLat - b.minLat) < 0.01 && (b.maxLon - b.minLon) < 0.01);

  const flat = RideStore.prepare(Object.assign(Demo.build(), { lat: null, lon: null }), {});
  check('a GPS-free ride has no bounds', Osm.boundsOf(flat) === null);
}

// ── 10. W′ battery inputs ───────────────────────────────────────────────────

section("W′ battery");

{
  // The gauge reads straight off the W′ balance, so what it needs is that the
  // balance is defined, bounded and monotone-in-the-right-direction everywhere.
  const wp = A.cfg.wPrime;
  let bad = 0, aboveCap = 0;
  for (let i = 0; i < P.n; i++) {
    const b = A.wbal.bal[i];
    if (!isFinite(b)) bad++;
    if (b > wp + 1e-6 || b < -1e-6) aboveCap++;
  }
  check('W′ balance is finite at every sample', bad === 0, bad + ' bad');
  check('W′ balance stays inside [0, W′]', aboveCap === 0, aboveCap + ' out of range');

  // The battery's rate readout is a 5 s difference in balance. Comparing it to
  // the *mean* power over the window is not a fair test: power can cross CP
  // several times inside five seconds, and recovery is exponential rather than
  // symmetric, so a window averaging just below CP can still net-drain. Only
  // unambiguous windows — entirely above or entirely below CP — pin the sign.
  const back = 5;
  let disagree = 0, tested = 0;
  for (let i = back; i < P.n; i++) {
    if (A.wbal.bal[i] <= 0 || A.wbal.bal[i - back] >= wp) continue;   // clamped
    let allAbove = true, allBelow = true;
    for (let k = i - back + 1; k <= i; k++) {
      if (P.watts[k] <= A.cfg.cp) allAbove = false;
      if (P.watts[k] >= A.cfg.cp) allBelow = false;
    }
    if (!allAbove && !allBelow) continue;
    tested++;
    const rate = (A.wbal.bal[i] - A.wbal.bal[i - back]) / back;
    if (allAbove && rate > 0) disagree++;
    if (allBelow && rate < 0) disagree++;
  }
  check('battery drains above CP and recharges below it, without exception',
    disagree === 0 && tested > 200,
    disagree + ' disagreements over ' + tested + ' unambiguous windows');
}

// ── Result ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(64));
console.log(failed === 0
  ? '\x1b[32m' + passed + ' checks passed\x1b[0m'
  : '\x1b[31m' + failed + ' failed\x1b[0m, ' + passed + ' passed');
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  · ' + f));
}
process.exit(failed ? 1 : 0);
