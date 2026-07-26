'use strict';

/**
 * Renders CritLab's charts to real PNGs so a human (or a model) can look at
 * them. The DOM test proves the drawing code runs; this proves it produces a
 * legible picture.
 *
 *   node test/render.js [outputDir]
 *
 * Not part of `npm test` — it needs @napi-rs/canvas, which is a dev-only
 * convenience and never loaded by the site itself.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createCanvas } = require('@napi-rs/canvas');

const JS = path.join(__dirname, '..', 'assets', 'js');
const OUT = process.argv[2] || path.join(__dirname, '..', 'reference', 'render');
fs.mkdirSync(OUT, { recursive: true });

// ── Load the modules ────────────────────────────────────────────────────────

const sandbox = {
  console, Math, JSON, Date, Number, String, Array, Object, Boolean, Error, Map, Set,
  Float64Array, Int32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView,
  isFinite, parseFloat, parseInt, URLSearchParams, Set, Promise,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  fetch: () => Promise.reject(new Error('offline')),
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
  devicePixelRatio: 2,
  getComputedStyle: () => ({ position: 'relative', getPropertyValue: () => '' }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const MODULES = ['Fit.js', 'Intervals.js', 'Weather.js', 'Osm.js', 'Physics.js', 'Analyzer.js',
  'RideStore.js', 'Charts.js', 'Demo.js'];
const NAMES = ['Fit', 'Intervals', 'Weather', 'Osm', 'Physics', 'Analyzer', 'RideStore',
  'Settings', 'Charts', 'Demo'];
vm.runInContext(
  MODULES.map(f => fs.readFileSync(path.join(JS, f), 'utf8')).join('\n;\n') +
  '\n;\n' + NAMES.map(n => 'globalThis.' + n + ' = ' + n + ';').join('\n'),
  sandbox, { filename: 'critlab-bundle.js' }
);
const { Charts, Analyzer, RideStore, Settings, Demo, Osm } = sandbox;

// ── A canvas that behaves enough like the DOM one ───────────────────────────

function fakeCanvas(cssW, cssH) {
  const dpr = 2;
  const real = createCanvas(Math.round(cssW * dpr), Math.round(cssH * dpr));
  const ctx = real.getContext('2d');
  const el = {
    _real: real,
    dataset: {},
    style: {},
    width: real.width,
    height: real.height,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: cssW, height: cssH, left: 0, top: 0, right: cssW, bottom: cssH }),
    // Enough of a parent for the hover layer to attach to without a DOM.
    parentElement: {
      clientWidth: cssW,
      style: {},
      querySelector: () => ({ className: '', style: {}, innerHTML: '', offsetWidth: 0, offsetHeight: 0 }),
      appendChild: () => {},
    },
    closest: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Charts.setup writes canvas.width/height in device pixels; keep them in sync
  // with the real backing store.
  Object.defineProperty(el, 'width', {
    get: () => real.width,
    set: v => { real.width = v; },
  });
  Object.defineProperty(el, 'height', {
    get: () => real.height,
    set: v => { real.height = v; },
  });
  return el;
}

function save(el, name, bg = '#161b22') {
  const real = el._real;
  // Composite onto the page surface so transparent regions read correctly.
  const out = createCanvas(real.width, real.height);
  const g = out.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, real.width, real.height);
  g.drawImage(real, 0, 0);
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, out.toBuffer('image/png'));
  console.log('  ' + name.padEnd(22) + real.width + '×' + real.height +
    '  ' + (fs.statSync(file).size / 1024).toFixed(0) + ' kB');
}

// ── Build the sample analysis ───────────────────────────────────────────────

console.log('Rendering CritLab charts → ' + OUT + '\n');

const demo = Demo.build();
const P = RideStore.prepare(demo, { movingSpeed: 2.5 });
Settings.set({ windSource: 'fit', cp: 268, wPrime: 21500, ftp: 265, mass: 79.5, crr: 0.0042 });
const cfg = RideStore.configFor(P, {});
cfg.rho = RideStore.airDensityFor(P, null, cfg).rho;
cfg.windSource = 'fit';
const A = Analyzer.run(P, cfg);

console.log('  \x1b[2m' + A.summary.laps + ' laps, ' + A.summary.turns + ' turns, ' +
  A.summary.exposed.toFixed(0) + '% clean air, median ratio ' + A.summary.median.toFixed(2) +
  ', wind ' + A.wind.speed.toFixed(1) + ' m/s\x1b[0m\n');

// ── Render ──────────────────────────────────────────────────────────────────

{
  const c = fakeCanvas(940, 300);
  Charts.timeline(c, P, A, { xAxis: 'dist', height: 300 });
  save(c, 'timeline');
}
{
  const c = fakeCanvas(940, 92);
  Charts.ratioStrip(c, P, A, { xAxis: 'dist' });
  save(c, 'ratio-strip');
}
{
  const c = fakeCanvas(560, 420);
  Charts.circuitMap(c, P, A, { height: 420 });
  save(c, 'circuit-map');
}
{
  const c = fakeCanvas(320, 260);
  Charts.exposureRose(c, A, { height: 260 });
  save(c, 'exposure-rose');
}
{
  const c = fakeCanvas(940, 600);
  Charts.sectorHeatmap(c, A);
  save(c, 'sector-heatmap');
}
{
  const c = fakeCanvas(940, 220);
  Charts.wbalChart(c, P, A, { height: 220 });
  save(c, 'wbal');
}
for (const metric of ['exit', 'loss', 'apex', 'recover']) {
  const c = fakeCanvas(620, 220);
  Charts.turnBars(c, A, metric);
  save(c, 'turns-' + metric);
}
{
  const c = fakeCanvas(620, 600);
  Charts.lapBars(c, A);
  save(c, 'lap-bars');
}
{
  const rows = [Analyzer.compareRow(demo, A)];
  // A second, contrived row so the comparison chart has something to compare.
  const alt = { ...rows[0], id: 'x', name: 'Wells Ave (windy)', exposed: 41, sheltered: 44,
    median: 0.88, finaleExposed: 58, matchKj: 31.4, cornerKj: 18.2 };
  const c = fakeCanvas(760, 200);
  Charts.compareBars(c, [rows[0], alt], 'exposed');
  save(c, 'compare');
}
{
  const map = fakeCanvas(360, 300);
  const strip = fakeCanvas(560, 220);
  Charts.replayFrame(map, strip, P, A, Math.floor(P.n * 0.62));
  save(map, 'replay-map');
  save(strip, 'replay-strip');
}

// The W' battery at four states of charge, so the whole ramp is visible.
{
  const wp = A.cfg.wPrime;
  const targets = [0.9, 0.55, 0.3, 0.05];
  for (const want of targets) {
    let best = 0, bestErr = Infinity;
    for (let i = 0; i < P.n; i++) {
      const e = Math.abs(A.wbal.bal[i] / wp - want);
      if (e < bestErr) { bestErr = e; best = i; }
    }
    const c = fakeCanvas(420, 150);
    Charts.wbalBattery(c, P, A, best, { height: 150 });
    save(c, 'battery-' + Math.round(want * 100));
  }
}

// Colour ramp reference, so the diverging scale can be eyeballed directly.
{
  const c = fakeCanvas(760, 80);
  const { g, w, h } = Charts.setup(c, 80);
  for (let x = 0; x < w; x++) {
    const r = 0.5 + (x / w) * 0.9;
    g.fillStyle = Charts.ratioColor(r);
    g.fillRect(x, 16, 1, 34);
  }
  g.fillStyle = '#8b949e';
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  for (const r of [0.6, 0.75, 0.9, 1.0, 1.1, 1.25, 1.35]) {
    const x = ((r - 0.5) / 0.9) * w;
    g.fillRect(x, 50, 1, 4);
    g.fillText(r.toFixed(2), x, 68);
  }
  g.textAlign = 'left';
  g.fillText('sheltered', 2, 11);
  g.textAlign = 'right';
  g.fillText('in the wind', w - 2, 11);
  save(c, 'ratio-ramp');
}

console.log('\nDone.');
