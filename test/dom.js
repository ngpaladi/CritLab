'use strict';

/**
 * DOM smoke test. Builds the site with Jekyll, loads the real generated
 * index.html into jsdom with a recording canvas stub, then drives the UI the
 * way a user would: load the sample race, visit every tab, poke the rail
 * controls, and switch wind sources.
 *
 * The point is not pixel fidelity — it is that every code path the app takes
 * actually runs. A typo in a rarely-visited tab is invisible until something
 * clicks it.
 *
 *   node test/dom.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'critlab-site-'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mok\x1b[0m   ' + name + (detail ? '  \x1b[2m' + detail + '\x1b[0m' : '')); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ── Build ───────────────────────────────────────────────────────────────────

section('Jekyll build');
try {
  execFileSync('jekyll', ['build', '--destination', SITE], { cwd: ROOT, stdio: 'pipe' });
  check('site builds', fs.existsSync(path.join(SITE, 'index.html')));
  check('about page builds', fs.existsSync(path.join(SITE, 'about.html')));
} catch (err) {
  check('site builds', false, String(err.stderr || err.message).slice(0, 300));
  process.exit(1);
}

// ── Canvas stub ─────────────────────────────────────────────────────────────

/** Records every 2D call so the tests can prove a chart actually drew. */
function makeContext() {
  const calls = { fill: 0, stroke: 0, fillText: 0, fillRect: 0, arc: 0, lineTo: 0 };
  const noop = () => {};
  const ctx = {
    calls,
    canvas: null,
    setTransform: noop, save: noop, restore: noop, translate: noop, scale: noop,
    clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: () => calls.lineTo++,
    arc: () => calls.arc++,
    quadraticCurveTo: noop, rect: noop, clip: noop,
    fill: () => calls.fill++,
    stroke: () => calls.stroke++,
    fillRect: () => calls.fillRect++,
    strokeRect: noop,
    fillText: () => calls.fillText++,
    strokeText: noop,
    setLineDash: noop, getLineDash: () => [],
    measureText: t => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
    putImageData: noop,
    drawImage: noop,
  };
  return ctx;
}

// ── Boot ────────────────────────────────────────────────────────────────────

section('Boot');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => errors.push(e.message + '\n' + (e.stack || '')));
virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));

const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
  // The built page uses absolute /CritLab/... paths; rewrite to the temp root.
  .replace(/(src|href)="\/CritLab\//g, '$1="');

// Serve from the built directory over file://, so the rewritten relative
// script and stylesheet paths resolve against the real generated assets.
const baseUrl = require('url').pathToFileURL(path.join(SITE, 'index.html')).href;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: baseUrl,
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // jsdom has no canvas backend; a recording stub is enough to exercise the
    // drawing code and catch reference errors in it.
    window.HTMLCanvasElement.prototype.getContext = function () {
      if (!this._ctx) { this._ctx = makeContext(); this._ctx.canvas = this; }
      return this._ctx;
    };
    // Give elements a real box, since chart layout is driven off it.
    window.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 400, width: 900, height: 400 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 900, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 160, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 60, configurable: true });
    window.devicePixelRatio = 2;
    window.alert = msg => errors.push('alert(): ' + msg);
    window.confirm = () => true;
    // No network in tests: weather and intervals.icu must both fail gracefully.
    window.fetch = () => Promise.reject(new Error('network disabled'));
  },
});

const { window } = dom;
const doc = window.document;
const $ = id => doc.getElementById(id);

// The modules are declared with top-level `const`, which in a classic script
// creates a global *lexical* binding rather than a property on `window` — so
// reach them the same way the page's own code does.
const G = name => { try { return window.eval(name); } catch (_) { return undefined; } };

// jsdom resource loading is async; wait for the modules and the boot pass.
async function settle(ms = 250) {
  await new Promise(r => setTimeout(r, ms));
}

(async () => {
  for (let i = 0; i < 40 && !window.CritLab; i++) await settle(100);

  const missing = ['Fit', 'Intervals', 'Weather', 'Physics', 'Analyzer', 'Charts',
    'RideStore', 'Settings', 'Demo'].filter(n => !G(n));
  check('all modules loaded', missing.length === 0, missing.join(', '));
  check('app booted', !!window.CritLab, window.CritLab ? '' : 'window.CritLab missing');
  if (!window.CritLab) { report(); return; }

  check('empty state shown before any race is loaded',
    /Load a/.test($('findings').textContent), $('findings').textContent.trim().slice(0, 60));

  // ── Load the sample race ──────────────────────────────────────────────────

  section('Sample race');

  $('demo-btn').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 60 && !window.CritLab.state.races.length; i++) await settle(100);
  await settle(600);

  const entry = window.CritLab.state.races[0];
  check('race added to the list', !!entry, window.CritLab.state.races.length + ' races');
  check('race is analysed', !!(entry && entry.A));
  check('sidebar lists it', /Sample crit/.test($('race-list').textContent));

  const A = entry.A;
  check('wind fell back to inference (no date, no weather)',
    A.wind.source === 'fit', 'source: ' + A.wind.source);
  check('conditions readout explains the fallback',
    /infer/i.test($('wind-note').textContent), $('wind-note').textContent.slice(0, 90));

  // ── Overview ──────────────────────────────────────────────────────────────

  section('Overview');

  const tiles = $('stat-row').querySelectorAll('.stat');
  check('stat tiles rendered', tiles.length === 8, tiles.length + ' tiles');
  check('no tile shows NaN or undefined',
    !/NaN|undefined/.test($('stat-row').textContent),
    $('stat-row').textContent.replace(/\s+/g, ' ').slice(0, 120));

  const findings = $('findings').textContent;
  check('findings generated', findings.length > 200, findings.length + ' chars');
  check('findings name the leak sector', /least sheltered stretch|sat in the wind/i.test(findings));
  check('findings cover the corners', /Turn \d/.test(findings));
  check('findings cover the finale', /finale|last \d laps/i.test(findings));
  check('no NaN in findings', !/NaN|undefined/.test(findings),
    (findings.match(/.{0,40}(NaN|undefined).{0,40}/) || [''])[0]);

  check('overview timeline drew', drew($('ov-timeline')), calls($('ov-timeline')));
  check('ratio strip drew', drew($('ov-strip')), calls($('ov-strip')));
  check('legend rendered', $('ov-legend').children.length >= 3,
    $('ov-legend').children.length + ' legend items');

  // ── Every tab ─────────────────────────────────────────────────────────────

  section('Tabs');

  const tabs = Array.from(doc.querySelectorAll('#tabbar .tab'));
  check('all eight tabs present', tabs.length === 8, tabs.length + ' tabs');

  for (const tab of tabs) {
    const before = errors.length;
    tab.dispatchEvent(new window.Event('click'));
    await settle(120);
    check('tab "' + tab.dataset.tab + '" renders without error',
      errors.length === before, errors.slice(before).join(' | ').slice(0, 200));
  }

  // Tab-specific content.
  clickTab('circuit'); await settle(150);
  check('circuit map drew', drew($('map-main')), calls($('map-main')));
  check('exposure rose drew', drew($('rose')), calls($('rose')));
  check('sector heatmap drew', drew($('heatmap')), calls($('heatmap')));

  // The basemap is an optional network fetch; with fetch disabled the map must
  // still draw and the UI must say why there is no basemap.
  check('map still drew without a basemap', drew($('map-main')));
  check('the map subtitle explains the missing basemap',
    /no basemap|basemap off/.test($('map-sub').textContent) || $('map-sub').textContent === '',
    $('map-sub').textContent);

  clickTab('laps'); await settle(150);
  const lapRows = $('lap-table').querySelectorAll('tbody tr');
  check('lap table populated', lapRows.length >= 20, lapRows.length + ' rows');
  check('lap table has no NaN', !/NaN|undefined/.test($('lap-table').textContent));
  check('lap source reported', /GPS|lap-button/i.test($('lap-source').textContent),
    $('lap-source').textContent);

  clickTab('corners'); await settle(150);
  const turnRows = $('turn-table').querySelectorAll('tbody tr');
  check('turn table populated', turnRows.length === 4, turnRows.length + ' rows');
  check('turn table reports plausible radii (mean-lap detection)',
    /1[4-9] m|2[0-4] m/.test($('turn-table').textContent),
    ($('turn-table').textContent.match(/\d+ m/g) || []).slice(0, 4).join(', '));
  check('turn table has no NaN', !/NaN|undefined/.test($('turn-table').textContent),
    (($('turn-table').textContent.match(/.{0,30}(NaN|undefined).{0,30}/)) || [''])[0]);
  check('turn bars drew', drew($('turn-bars')), calls($('turn-bars')));

  for (const metric of ['loss', 'apex', 'recover', 'exit']) {
    const before = errors.length;
    doc.querySelector('[data-turn="' + metric + '"]').dispatchEvent(new window.Event('click'));
    await settle(80);
    check('turn metric "' + metric + '" renders', errors.length === before,
      errors.slice(before).join(' | ').slice(0, 160));
  }

  clickTab('surges'); await settle(150);
  const surgeRows = $('surge-table').querySelectorAll('tbody tr');
  check('surge table populated', surgeRows.length >= 5, surgeRows.length + ' rows');
  check('surge table distinguishes matches from corner exits',
    /corner exit/.test($('surge-table').textContent) && /match/.test($('surge-table').textContent));
  check("W′ chart drew", drew($('wbal')), calls($('wbal')));
  check("W′ subtitle reports CP, W′ and tau", /CP \d+ W.*W′.*τ/.test($('wbal-sub').textContent),
    $('wbal-sub').textContent);

  clickTab('replay'); await settle(150);
  check('replay map drew', drew($('rp-map')), calls($('rp-map')));
  check('replay strip drew', drew($('rp-strip')), calls($('rp-strip')));
  check('W′ battery drew', drew($('rp-battery')), calls($('rp-battery')));
  // Scrub into the race first: at t=0 the rider is before the first detected
  // lap crossing, so there is legitimately no lap number to show.
  $('rp-scrub').value = '500';
  $('rp-scrub').dispatchEvent(new window.Event('input'));
  await settle(120);
  check('replay subtitle reports lap, speed and charge',
    /lap \d+ of \d+.*km\/h.*% W/.test($('rp-sub').textContent), $('rp-sub').textContent);
  check('subtitle omits the lap before the first crossing, rather than showing lap 0',
    !/lap 0\b/.test($('rp-sub').textContent));
  {
    const before = errors.length;
    $('rp-scrub').value = '500';
    $('rp-scrub').dispatchEvent(new window.Event('input'));
    await settle(80);
    check('scrubbing the replay works', errors.length === before && /\d+:\d\d/.test($('rp-clock').textContent),
      $('rp-clock').textContent);
    $('rp-play').dispatchEvent(new window.Event('click'));
    await settle(260);
    check('replay plays', $('rp-play').textContent.includes('Pause'), $('rp-play').textContent);
    $('rp-play').dispatchEvent(new window.Event('click'));
    await settle(60);
    check('replay pauses', $('rp-play').textContent.includes('Play'), $('rp-play').textContent);
  }

  // The battery must actually track the scrubber, not render once and freeze.
  {
    const readCharge = () => {
      const m = $('rp-sub').textContent.match(/(\d+)% W/);
      return m ? Number(m[1]) : null;
    };
    $('rp-scrub').value = '20';
    $('rp-scrub').dispatchEvent(new window.Event('input'));
    await settle(120);
    const early = readCharge();
    $('rp-scrub').value = '980';
    $('rp-scrub').dispatchEvent(new window.Event('input'));
    await settle(120);
    const late = readCharge();
    check('battery charge is read at every scrub position',
      early !== null && late !== null, early + '% → ' + late + '%');
    check('W′ is lower at the end of the race than near the start',
      late <= early, early + '% early vs ' + late + '% late');
  }

  // ── Compare ───────────────────────────────────────────────────────────────

  section('Compare');

  clickTab('compare'); await settle(120);
  check('compare is empty until races are ticked',
    /Tick/.test($('cmp-table').textContent), $('cmp-table').textContent.trim().slice(0, 50));

  const cmpBox = $('race-list').querySelector('.ride-cmp');
  cmpBox.checked = true;
  cmpBox.dispatchEvent(new window.Event('change'));
  await settle(400);
  check('compare table populates when a race is ticked',
    $('cmp-table').querySelectorAll('tbody tr').length === 1,
    $('cmp-table').querySelectorAll('tbody tr').length + ' rows');
  check('compare table has no NaN', !/NaN|undefined/.test($('cmp-table').textContent));
  check('compare bars drew', drew($('cmp-bars')), calls($('cmp-bars')));

  for (const metric of ['finale', 'matchKj', 'cornerKj', 'exposed']) {
    const before = errors.length;
    doc.querySelector('[data-cmp="' + metric + '"]').dispatchEvent(new window.Event('click'));
    await settle(80);
    check('compare metric "' + metric + '" renders', errors.length === before,
      errors.slice(before).join(' | ').slice(0, 160));
  }

  // ── Rail controls ─────────────────────────────────────────────────────────

  section('Rail controls');

  clickTab('overview'); await settle(120);

  {
    const before = $('stat-row').textContent;
    const el = $('in-mass');
    el.value = '92';
    el.dispatchEvent(new window.Event('input'));
    await settle(1400);
    check('mass slider updates its readout', $('v-mass').textContent === '92.0 kg', $('v-mass').textContent);
    check('changing mass re-runs the analysis', $('stat-row').textContent !== before);
    check('mass persisted to settings', G('Settings').get('mass') === 92, String(G('Settings').get('mass')));
  }

  {
    const el = $('in-exposedAt');
    el.value = '1.05';
    el.dispatchEvent(new window.Event('input'));
    await settle(1400);
    check('threshold slider updates its readout', $('v-exposedAt').textContent === '1.05', $('v-exposedAt').textContent);
    check('a stricter clean-air threshold lowers reported exposure',
      window.CritLab.state.races[0].A.summary.exposed <= A.summary.exposed + 0.001,
      window.CritLab.state.races[0].A.summary.exposed.toFixed(1) + '% vs ' + A.summary.exposed.toFixed(1) + '%');
  }

  {
    const before = errors.length;
    $('in-lockCda').checked = true;
    $('in-lockCda').dispatchEvent(new window.Event('change'));
    await settle(1400);
    check('locking CdA renders without error', errors.length === before);
    check('locked CdA is respected',
      Math.abs(window.CritLab.state.races[0].A.cda - G('Settings').get('cda')) < 1e-6,
      window.CritLab.state.races[0].A.cda.toFixed(3) + ' vs ' + G('Settings').get('cda'));
    check('the rail says CdA is locked', /locked/i.test($('wind-note').textContent));
    $('in-lockCda').checked = false;
    $('in-lockCda').dispatchEvent(new window.Event('change'));
    await settle(1400);
  }

  // ── Wind sources ──────────────────────────────────────────────────────────

  section('Wind sources');

  {
    const before = errors.length;
    $('wind-manual').dispatchEvent(new window.Event('click'));
    await settle(1200);
    check('manual wind mode renders', errors.length === before,
      errors.slice(before).join(' | ').slice(0, 160));
    check('manual wind fields become visible', $('wind-manual-fields').style.display === '');
    $('in-windSpeed').value = '5.5';
    $('in-windSpeed').dispatchEvent(new window.Event('input'));
    $('in-windDir').value = '250';
    $('in-windDir').dispatchEvent(new window.Event('input'));
    await settle(1400);
    const w = window.CritLab.state.races[0].A.wind;
    check('manual wind reaches the analysis',
      w.source === 'manual' && Math.abs(w.dirFrom - 250) < 1, w.source + ' ' + w.dirFrom.toFixed(0) + '°');
    check('manual direction readout uses a compass point',
      /WSW/.test($('v-windDir').textContent), $('v-windDir').textContent);
  }

  {
    // Weather mode with no network must degrade, not explode.
    const before = errors.filter(e => !/network disabled/.test(e)).length;
    $('wind-weather').dispatchEvent(new window.Event('click'));
    await settle(1500);
    const after = errors.filter(e => !/network disabled/.test(e)).length;
    check('weather mode degrades gracefully with no network', after === before,
      errors.filter(e => !/network disabled/.test(e)).slice(before).join(' | ').slice(0, 200));
    check('the UI says why weather is unavailable',
      /No weather|not fetched|no start timestamp/i.test($('wx-readout').textContent),
      $('wx-readout').textContent.replace(/\s+/g, ' ').slice(0, 90));
    check('analysis still produced', !!window.CritLab.state.races[0].A);
  }

  // ── Settings drawer ───────────────────────────────────────────────────────

  section('Settings drawer');

  {
    $('settings-btn').dispatchEvent(new window.Event('click'));
    await settle(60);
    check('drawer opens', $('settings-modal').style.display !== 'none');
    check('API key field is a password field', $('icu-key').type === 'password');
    $('settings-close').dispatchEvent(new window.Event('click'));
    await settle(60);
    check('drawer closes', $('settings-modal').style.display === 'none');
  }

  {
    // Saving a key with no network must surface an error, not hang or throw.
    $('settings-btn').dispatchEvent(new window.Event('click'));
    await settle(50);
    $('icu-key').value = 'not-a-real-key';
    $('icu-save').dispatchEvent(new window.Event('click'));
    await settle(400);
    check('a failing key test reports an error to the user',
      $('icu-status').className.includes('status-err'), $('icu-status').textContent.slice(0, 80));
    $('icu-clear').dispatchEvent(new window.Event('click'));
    await settle(50);
    check('forgetting the key clears it', !G('Settings').get('icuKey'));
    $('settings-close').dispatchEvent(new window.Event('click'));
  }

  {
    $('settings-btn').dispatchEvent(new window.Event('click'));
    await settle(50);
    const osmBox = $('osm-enabled');
    check('basemap toggle present and on by default', osmBox && osmBox.checked === true);
    const before = errors.filter(e => !/network disabled/.test(e)).length;
    osmBox.checked = false;
    osmBox.dispatchEvent(new window.Event('change'));
    await settle(400);
    check('turning the basemap off re-renders cleanly',
      errors.filter(e => !/network disabled/.test(e)).length === before);
    check('basemap setting persisted', G('Settings').get('osmBasemap') === false);
    $('osm-clear').dispatchEvent(new window.Event('click'));
    await settle(300);
    check('clearing cached map data works',
      /cleared/i.test($('osm-status').textContent), $('osm-status').textContent);
    osmBox.checked = true;
    osmBox.dispatchEvent(new window.Event('change'));
    await settle(400);
    $('settings-close').dispatchEvent(new window.Event('click'));
  }

  {
    // The filter UI stays hidden until a search has actually returned rides.
    check('filter chips hidden before any search',
      $('icu-filters').style.display === 'none', $('icu-filters').style.display);
    check('search box present', !!$('icu-search'));
    check('90-day shortcut present', !!$('icu-range-90'));
    check('load-by-ID escape hatch present', !!$('icu-id') && !!$('icu-id-load'));
  }

  {
    // Load-by-ID must validate before it hits the network.
    $('icu-id').value = 'not an id';
    $('icu-id-load').dispatchEvent(new window.Event('click'));
    await settle(200);
    check('a malformed activity reference is rejected clearly',
      /does not look like/.test($('icu-id-status').textContent),
      $('icu-id-status').textContent.slice(0, 60));

    // A full intervals.icu URL must be accepted and reduced to its id.
    $('icu-id').value = 'https://intervals.icu/activities/i169128502';
    $('icu-id-load').dispatchEvent(new window.Event('click'));
    await settle(300);
    check('a full URL is parsed past validation (then blocked on the missing key)',
      /No API key/.test($('icu-id-status').textContent),
      $('icu-id-status').textContent.slice(0, 70));
  }

  {
    // The loading overlay: hidden at rest, shown while work is in flight.
    const overlay = $('busy-overlay');
    check('loading overlay exists and is hidden at rest', overlay && overlay.hidden === true);

    // Driving it through a real load is the only honest test of the counter.
    const seen = { shown: false };
    const obs = setInterval(() => { if (!overlay.hidden) seen.shown = true; }, 20);
    $('demo-btn').dispatchEvent(new window.Event('click'));
    for (let i = 0; i < 40 && !window.CritLab.state.races.length; i++) await settle(50);
    await settle(600);
    clearInterval(obs);
    check('overlay is hidden again once work finishes', overlay.hidden === true);
    check('busy counter unwound to zero', window.CritLab.state.busy === false);
  }

  {
    // Force-refresh only makes sense for rides that came from intervals.icu;
    // the sample race is synthetic and must not offer it.
    check('no refresh button on a non-intervals.icu race',
      !$('race-list').querySelector('.ride-refresh'));
  }

  {
    // Searching intervals.icu without a key must say so rather than fail.
    $('icu-fetch').dispatchEvent(new window.Event('click'));
    await settle(200);
    check('searching with no key explains what to do',
      /No API key/i.test($('icu-results').textContent), $('icu-results').textContent.slice(0, 70));
  }

  // ── Mobile layout ─────────────────────────────────────────────────────────

  section('Mobile panels');

  for (const p of ['rides', 'setup', 'analysis']) {
    const before = errors.length;
    doc.querySelector('[data-mpanel="' + p + '"]').dispatchEvent(new window.Event('click'));
    await settle(100);
    check('mobile panel "' + p + '" switches cleanly',
      errors.length === before && $('app-wrap').dataset.panel === p, $('app-wrap').dataset.panel);
  }

  // ── Removal ───────────────────────────────────────────────────────────────

  section('Removing a race');

  {
    const del = $('race-list').querySelector('.ride-del');
    del.dispatchEvent(new window.Event('click'));
    await settle(400);
    check('race removed', window.CritLab.state.races.length === 0,
      window.CritLab.state.races.length + ' left');
    check('empty state returns', /Load a/.test($('findings').textContent));
  }

  report();

  function clickTab(name) {
    doc.querySelector('#tabbar .tab[data-tab="' + name + '"]').dispatchEvent(new window.Event('click'));
  }
  function ctxOf(canvas) { return canvas && canvas._ctx; }
  function drew(canvas) {
    const c = ctxOf(canvas);
    if (!c) return false;
    const k = c.calls;
    return (k.stroke + k.fill + k.fillRect + k.fillText + k.arc + k.lineTo) > 4;
  }
  function calls(canvas) {
    const c = ctxOf(canvas);
    return c ? JSON.stringify(c.calls) : 'no context';
  }

  function report() {
    const real = errors.filter(e => !/network disabled/.test(e));
    section('Uncaught errors');
    check('no uncaught errors during the whole session', real.length === 0,
      real.slice(0, 3).join('\n').slice(0, 600));

    console.log('\n' + '─'.repeat(64));
    console.log(failed === 0
      ? '\x1b[32m' + passed + ' checks passed\x1b[0m'
      : '\x1b[31m' + failed + ' failed\x1b[0m, ' + passed + ' passed');
    if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  · ' + f)); }
    try { fs.rmSync(SITE, { recursive: true, force: true }); } catch (_) {}
    process.exit(failed ? 1 : 0);
  }
})();
