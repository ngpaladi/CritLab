'use strict';

/**
 * app.js — UI state and orchestration.
 *
 * Owns the loaded races, the rail controls, tab switching and rendering.
 * All the actual thinking lives in Physics / Analyzer; this file binds it to
 * the DOM and keeps the two sidebars honest.
 */
(() => {

  const $ = id => document.getElementById(id);

  const state = {
    races: [],            // { id, raw, P, A, wx, wxError, compare }
    currentId: null,
    xAxis: 'dist',
    turnMetric: 'exit',
    cmpMetric: 'exposed',
    replay: { idx: 0, timer: null },
    busy: false,
    icu: { activities: [], skipped: [], filters: { race: true, power: true, gps: true, tags: new Set() }, search: '' },
  };

  // Rail controls: id suffix → { fmt, parse }
  const RAIL = {
    mass:        { fmt: v => v.toFixed(1) + ' kg' },
    cda:         { fmt: v => v.toFixed(3) + ' m²' },
    crr:         { fmt: v => v.toFixed(4) },
    yawK:        { fmt: v => v.toFixed(2) },
    ftp:         { fmt: v => Math.round(v) + ' W' },
    cp:          { fmt: v => Math.round(v) + ' W' },
    wPrime:      { fmt: v => (v / 1000).toFixed(1) + ' kJ' },
    cleanAirPct: { fmt: v => Math.round(v * 100) + '%' },
    exposedAt:   { fmt: v => v.toFixed(2) },
    shelteredAt: { fmt: v => v.toFixed(2) },
    surgeFactor: { fmt: v => v.toFixed(2) },
    windSpeed:   { fmt: v => v.toFixed(1) + ' m/s' },
    windDir:     { fmt: v => Weather.compass(v) + ' ' + Math.round(v) + '°' },
  };

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    bindRail();
    bindTabs();
    bindLoaders();
    bindReplay();
    bindWindow();
    syncRailFromSettings();
    initDates();

    try {
      const stored = await RideStore.list();
      for (const raw of stored) addRace(raw, { silent: true });
    } catch (err) {
      console.warn('Could not read stored races:', err);
    }

    renderRaceList();
    if (state.races.length) {
      await select(state.races[0].id);
    } else {
      renderEmpty();
    }
  }

  // ── Race lifecycle ────────────────────────────────────────────────────────

  function addRace(raw, { silent = false } = {}) {
    if (!raw.id) raw.id = RideStore.makeId(raw);
    const existing = state.races.findIndex(r => r.id === raw.id);
    const entry = { id: raw.id, raw, P: null, A: null, wx: null, wxError: null,
      osm: null, osmError: null, compare: false };
    if (existing >= 0) state.races[existing] = entry; else state.races.push(entry);
    state.races.sort((a, b) => (b.raw.startTime || 0) - (a.raw.startTime || 0));
    if (!silent) renderRaceList();
    return entry;
  }

  async function loadRaw(raw, opts = {}) {
    const { persist = true } = opts;
    setBusy(true, 'Preparing…');
    try {
      const entry = addRace(raw);
      entry.P = RideStore.prepare(raw, { movingSpeed: 2.5 });
      if (!entry.P.hasPower) throw new Error('No power data in this file — CritLab needs watts.');
      if (persist) {
        try { await RideStore.put(raw); } catch (err) { console.warn('Could not save race:', err); }
      }
      renderRaceList();
      await select(entry.id);
    } catch (err) {
      // Callers that show their own status (load-by-ID, the activity list)
      // pass `quiet` so the message is not delivered twice.
      if (!opts.quiet) alert(String(err.message || err));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function select(id) {
    state.currentId = id;
    stopReplay();
    state.replay.idx = 0;
    const entry = current();
    if (!entry) { renderEmpty(); return; }

    if (!entry.P) entry.P = RideStore.prepare(entry.raw, { movingSpeed: 2.5 });

    renderRaceList();
    // Both are optional network fetches; run them together rather than serially.
    await Promise.all([ensureWeather(entry), ensureOsm(entry)]);
    recompute();
  }

  function current() {
    return state.races.find(r => r.id === state.currentId) || null;
  }

  async function ensureWeather(entry, { force = false } = {}) {
    if (!force && (entry.wx || entry.wxError)) return;
    if (!Settings.get('wxAuto') && !force) return;

    const P = entry.P;
    if (!P.hasGps || !P.startTime) {
      entry.wxError = !P.hasGps ? 'no GPS in this file' : 'no start timestamp in this file';
      return;
    }

    const mid = Math.floor(P.n / 2);
    setBusy(true, 'Fetching weather…');
    try {
      entry.wx = await Weather.fetchFor({
        lat: P.lat[mid], lon: P.lon[mid],
        startUnix: P.startTime,
        endUnix: P.startTime + P.t[P.n - 1],
      });
      entry.wxError = null;
    } catch (err) {
      entry.wx = null;
      entry.wxError = String(err.message || err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fetch the OpenStreetMap basemap for this circuit. Failure is never fatal —
   * the map draws perfectly well without it, so a dead Overpass mirror should
   * cost you a backdrop, not an analysis.
   */
  async function ensureOsm(entry, { force = false } = {}) {
    if (!force && (entry.osm || entry.osmError)) return;
    if (Settings.get('osmBasemap') === false) return;
    if (!entry.P || !entry.P.hasGps) { entry.osmError = 'no GPS in this file'; return; }

    const bounds = Osm.boundsOf(entry.P);
    if (!bounds) { entry.osmError = 'no usable GPS bounds'; return; }

    setBusy(true, 'Fetching map…');
    try {
      entry.osm = await Osm.fetchFor(bounds);
      entry.osmError = null;
    } catch (err) {
      entry.osm = null;
      entry.osmError = String(err.message || err);
    } finally {
      setBusy(false);
    }
  }

  /** The basemap to draw, or null when it is off or unavailable. */
  function basemap(entry) {
    return (Settings.get('osmBasemap') !== false && entry && entry.osm) ? entry.osm : null;
  }

  /** Build the config + run the analysis for one race. */
  function analyse(entry) {
    const P = entry.P;
    const s = Settings.all();

    const cfg = RideStore.configFor(P, {});
    const dens = RideStore.airDensityFor(P, entry.wx, cfg);
    cfg.rho = dens.rho;
    cfg.conditions = dens;

    // Weather-driven wind needs weather; fall back rather than silently lying.
    if (cfg.windSource === 'weather') {
      if (entry.wx && RideStore.applyWeather(P, entry.wx, s.wxRoughness)) {
        cfg.effectiveWindSource = 'weather';
      } else {
        P.we = null; P.wn = null;
        cfg.windSource = 'fit';
        cfg.effectiveWindSource = 'fit-fallback';
      }
    } else {
      P.we = null; P.wn = null;
      cfg.effectiveWindSource = cfg.windSource;
    }

    entry.A = Analyzer.run(P, cfg);
    return entry.A;
  }

  let recomputeTimer = null;
  function recomputeSoon() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recompute, 140);
  }

  function recompute() {
    const entry = current();
    if (!entry || !entry.P) { renderEmpty(); return; }
    try {
      analyse(entry);
    } catch (err) {
      console.error(err);
      alert('Analysis failed: ' + (err.message || err));
      return;
    }
    // Comparison rows are re-analysed lazily when the Compare tab renders.
    for (const r of state.races) if (r !== entry) r.A = null;
    renderAll();
  }

  // ── Rail ──────────────────────────────────────────────────────────────────

  function bindRail() {
    for (const key of Object.keys(RAIL)) {
      const el = $('in-' + key);
      if (!el) continue;
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        $('v-' + key).textContent = RAIL[key].fmt(v);
        Settings.set({ [key]: v });
        recomputeSoon();
      });
    }

    $('in-lockCda').addEventListener('change', e => {
      Settings.set({ lockCda: e.target.checked });
      recomputeSoon();
    });

    document.querySelectorAll('[data-wind]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const src = btn.dataset.wind;
        Settings.set({ windSource: src });
        syncWindButtons();
        if (src === 'weather') {
          const entry = current();
          if (entry && !entry.wx) await ensureWeather(entry, { force: true });
        }
        recompute();
      });
    });

    $('wx-refresh').addEventListener('click', async () => {
      const entry = current();
      if (!entry) return;
      Weather.clearCache();
      entry.wx = null; entry.wxError = null;
      await ensureWeather(entry, { force: true });
      recompute();
    });

    $('reset-settings').addEventListener('click', () => {
      if (!confirm('Reset rider, model and threshold settings to defaults? Your API key is kept.')) return;
      const s = Settings.all();
      const keep = {
        icuKey: s.icuKey, icuAthlete: s.icuAthlete, icuAthleteName: s.icuAthleteName,
        wxAuto: s.wxAuto, wxRoughness: s.wxRoughness,
      };
      Settings.reset();
      Settings.set(keep);
      syncRailFromSettings();
      recompute();
    });

    $('icu-open-settings').addEventListener('click', () => $('settings-btn').click());

    window.addEventListener('critlab:settings', async e => {
      if (e.detail && e.detail.cleared) {
        state.races = [];
        state.currentId = null;
        renderRaceList();
        renderEmpty();
        return;
      }
      if (e.detail && e.detail.osm) {
        for (const r of state.races) { r.osm = null; r.osmError = null; }
        const entry = current();
        if (entry) await ensureOsm(entry, { force: true });
        renderAll();
        return;
      }
      if (e.detail && e.detail.weather) {
        for (const r of state.races) { r.wx = null; r.wxError = null; }
        const entry = current();
        if (entry) await ensureWeather(entry, { force: true });
        recompute();
      }
    });
  }

  function syncRailFromSettings() {
    const s = Settings.all();
    for (const key of Object.keys(RAIL)) {
      const el = $('in-' + key);
      if (!el) continue;
      const v = s[key] != null ? s[key] : parseFloat(el.value);
      el.value = v;
      $('v-' + key).textContent = RAIL[key].fmt(parseFloat(el.value));
    }
    $('in-lockCda').checked = !!s.lockCda;
    syncWindButtons();
  }

  function syncWindButtons() {
    const src = Settings.get('windSource');
    document.querySelectorAll('[data-wind]').forEach(b => b.classList.toggle('active', b.dataset.wind === src));
    $('wind-manual-fields').style.display = src === 'manual' ? '' : 'none';
  }

  // ── Tabs & panels ─────────────────────────────────────────────────────────

  function bindTabs() {
    document.querySelectorAll('#tabbar .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#tabbar .tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.panel').forEach(p =>
          p.classList.toggle('active', p.dataset.panelId === tab.dataset.tab));
        renderActivePanel();
      });
    });

    document.querySelectorAll('.mobile-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mobile-tab').forEach(b => b.classList.toggle('active', b === btn));
        $('app-wrap').dataset.panel = btn.dataset.mpanel;
        renderActivePanel();
      });
    });

    document.querySelectorAll('[data-x]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.xAxis = btn.dataset.x;
        document.querySelectorAll('[data-x]').forEach(b => b.classList.toggle('active', b === btn));
        renderActivePanel();
      });
    });

    document.querySelectorAll('[data-turn]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.turnMetric = btn.dataset.turn;
        document.querySelectorAll('[data-turn]').forEach(b => b.classList.toggle('active', b === btn));
        renderActivePanel();
      });
    });

    document.querySelectorAll('[data-cmp]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.cmpMetric = btn.dataset.cmp;
        document.querySelectorAll('[data-cmp]').forEach(b => b.classList.toggle('active', b === btn));
        renderActivePanel();
      });
    });
  }

  function activeTab() {
    const t = document.querySelector('#tabbar .tab.active');
    return t ? t.dataset.tab : 'overview';
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  function bindLoaders() {
    const dz = $('dropzone'), fi = $('file-input');
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { handleFiles(e.target.files); fi.value = ''; });

    ['dragenter', 'dragover'].forEach(ev =>
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-over'); }));
    dz.addEventListener('drop', e => handleFiles(e.dataTransfer.files));

    $('demo-btn').addEventListener('click', async () => {
      await loadRaw(Demo.build(), { persist: false });
    });

    $('icu-fetch').addEventListener('click', fetchIcuList);
    $('icu-id-load').addEventListener('click', loadIcuById);
    $('icu-id').addEventListener('keydown', e => { if (e.key === 'Enter') loadIcuById(); });
    $('icu-search').addEventListener('input', e => {
      state.icu.search = e.target.value;
      renderIcuResults();
    });
    $('icu-range-90').addEventListener('click', () => {
      const to = new Date();
      $('icu-to').value = to.toISOString().slice(0, 10);
      $('icu-from').value = new Date(to.getTime() - 90 * 86400000).toISOString().slice(0, 10);
      fetchIcuList();
    });
  }

  async function handleFiles(files) {
    for (const file of Array.from(files || [])) {
      try {
        if (/\.fit$/i.test(file.name)) {
          const buf = await file.arrayBuffer();
          await loadRaw(Fit.parse(buf, file.name));
        } else {
          const text = await file.text();
          await loadRaw(RideStore.fromJson(JSON.parse(text), file.name));
        }
      } catch (err) {
        console.error(err);
        alert('Could not read ' + file.name + ': ' + (err.message || err));
      }
    }
  }

  function initDates() {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400000);
    $('icu-to').value = to.toISOString().slice(0, 10);
    $('icu-from').value = from.toISOString().slice(0, 10);
  }

  async function fetchIcuList() {
    const key = Settings.get('icuKey');
    const out = $('icu-results');
    if (!key) {
      out.innerHTML = '<div class="status status-warn">No API key saved. Press <b>Key</b> above to add one.</div>';
      return;
    }
    out.innerHTML = '<div class="status status-info">Searching…</div>';
    try {
      const list = await Intervals.listActivities({
        key,
        athleteId: Settings.get('icuAthlete') || '0',
        oldest: $('icu-from').value,
        newest: $('icu-to').value,
      });
      // Anything that is not a ride gets set aside rather than dropped, so a
      // race that is missing from the list is visible as a problem instead of
      // simply not being there. intervals.icu does emit placeholder records —
      // a Strava sync that never completed, for instance — with no type, no
      // name and no metrics, and those are exactly the ones worth surfacing.
      state.icu.activities = list.filter(Intervals.isRide);
      state.icu.skipped = list.filter(a => !Intervals.isRide(a));
      $('icu-filters').style.display = state.icu.activities.length ? '' : 'none';
      renderIcuChips();
      renderIcuResults();
    } catch (err) {
      out.innerHTML = '<div class="status status-err">' + Charts.esc(err.message || err) + '</div>';
    }
  }

  /**
   * Filter chips. intervals.icu already knows which rides were races and which
   * streams each one has, so the list can be narrowed to "crits I can actually
   * analyse" before anything is downloaded — which for most people is three
   * rides out of a month of endurance miles.
   */
  function renderIcuChips() {
    const acts = state.icu.activities;
    const f = state.icu.filters;
    const chips = $('icu-chips');

    const count = pred => acts.filter(pred).length;
    const defs = [
      { key: 'race', label: 'Races', n: count(a => a.isRace) },
      { key: 'power', label: 'Power', n: count(a => a.hasPower) },
      { key: 'gps', label: 'GPS', n: count(a => a.hasGpsStream) },
    ];

    chips.innerHTML = '';
    for (const d of defs) {
      if (!d.n) continue;
      const b = document.createElement('button');
      b.className = 'chip' + (f[d.key] ? ' on' : '');
      b.innerHTML = Charts.esc(d.label) + '<span class="chip-count">' + d.n + '</span>';
      b.title = f[d.key] ? 'Showing only these — click to include everything' : 'Narrow to these';
      b.addEventListener('click', () => { f[d.key] = !f[d.key]; renderIcuChips(); renderIcuResults(); });
      chips.appendChild(b);
    }

    // User-defined tags, when the athlete uses them.
    for (const { tag, count: n } of Intervals.tagsIn(acts)) {
      const b = document.createElement('button');
      b.className = 'chip' + (f.tags.has(tag) ? ' on' : '');
      b.innerHTML = Charts.esc(tag) + '<span class="chip-count">' + n + '</span>';
      b.addEventListener('click', () => {
        if (f.tags.has(tag)) f.tags.delete(tag); else f.tags.add(tag);
        renderIcuChips(); renderIcuResults();
      });
      chips.appendChild(b);
    }
  }

  function filteredIcu() {
    const f = state.icu.filters;
    const q = state.icu.search.trim().toLowerCase();
    return state.icu.activities.filter(a => {
      if (f.race && !a.isRace) return false;
      if (f.power && !a.hasPower) return false;
      if (f.gps && !a.hasGpsStream) return false;
      if (f.tags.size && !(a.tags || []).some(t => f.tags.has(t))) return false;
      if (q && !(a.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderIcuResults() {
    const out = $('icu-results');
    const key = Settings.get('icuKey');
    const rides = filteredIcu();
    const total = state.icu.activities.length;

    if (!total) {
      out.innerHTML = '<div class="status status-warn">No rides in that window.</div>';
      return;
    }
    if (!rides.length) {
      out.innerHTML = '<div class="status status-warn">Nothing matches. ' +
        'Loosen the filters above — ' + total + ' rides were found.</div>';
      return;
    }

    out.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'hint';
    head.style.margin = '2px 0 6px';
    head.textContent = rides.length + ' of ' + total + ' rides';
    out.appendChild(head);

    // Placeholder records from intervals.icu. Never hide these silently: when
    // one of them is the ride you are looking for, an empty list is impossible
    // to diagnose from the outside.
    const skipped = state.icu.skipped || [];
    if (skipped.length) {
      const warn = document.createElement('div');
      warn.className = 'status status-warn';
      warn.style.marginBottom = '6px';
      const strava = skipped.filter(a => a.apiBlocked);
      const dates = skipped.map(a => (a.start || '').slice(0, 10)).join(', ');
      warn.innerHTML = strava.length
        ? '<b>' + strava.length + ' activit' + (strava.length === 1 ? 'y' : 'ies') +
          ' came from Strava</b> (' + dates + ') and cannot be read through the ' +
          'intervals.icu API — Strava does not allow it. If your race is missing, ' +
          'this is why. Upload the .fit to intervals.icu directly, or just drag it ' +
          'into CritLab.'
        : skipped.length + ' entr' + (skipped.length === 1 ? 'y' : 'ies') +
          ' on intervals.icu ' + (skipped.length === 1 ? 'has' : 'have') +
          ' no activity type or metrics — usually an incomplete sync. ' + dates +
          '. If a race is missing, that is probably it.';
      out.appendChild(warn);
    }

    for (const a of rides) {
      const row = document.createElement('div');
      row.className = 'ride-item';
      const warn = [];
      if (!a.hasPowerStream && !a.hasPower) warn.push('no power');
      if (!a.hasGpsStream) warn.push('no GPS');
      row.innerHTML =
        '<span class="ride-swatch"></span>' +
        '<span class="ride-body"><span class="ride-name">' +
        (a.isRace ? '<span class="ride-badge">race</span>' : '') +
        Charts.esc(a.name) + '</span>' +
        '<span class="ride-meta">' + (a.start || '').slice(0, 10) + ' · ' +
        Charts.fmtClock(a.movingTime || 0) + ' · ' + Math.round(a.avgWatts || 0) + ' W' +
        (warn.length ? ' · <span class="ride-warn">' + warn.join(', ') + '</span>' : '') +
        '</span></span>';
      row.addEventListener('click', async () => {
        const note = document.createElement('div');
        note.className = 'status status-info';
        note.textContent = 'Downloading streams…';
        out.replaceChildren(note);
        try {
          await loadRaw(await Intervals.loadRide(a.id, key));
          note.className = 'status status-ok';
          note.textContent = 'Loaded “' + a.name + '”.';
        } catch (err) {
          note.className = 'status status-err';
          note.textContent = String(err.message || err);
        }
      });
      out.appendChild(row);
    }
  }

  /**
   * Load a specific activity by id or URL.
   *
   * intervals.icu does not always list everything it holds — an activity that
   * lost a de-duplication contest is still fetchable, just invisible in the
   * date-range listing. This is the escape hatch for that.
   */
  function parseActivityRef(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const m = raw.match(/activities?\/([a-z0-9]+)/i) || raw.match(/^(i?\d+)$/i);
    return m ? m[1] : null;
  }

  async function loadIcuById() {
    const out = $('icu-id-status');
    const key = Settings.get('icuKey');
    const id = parseActivityRef($('icu-id').value);

    out.innerHTML = '';
    const say = (kind, msg) => {
      out.innerHTML = '<div class="status status-' + kind + '" style="margin-top:6px">' +
        Charts.esc(msg) + '</div>';
    };

    // Validate what was just typed before complaining about configuration: it
    // is the thing the user most recently acted on, and the check is free.
    if (!id) { say('err', 'That does not look like an activity ID or URL.'); return; }
    if (!key) { say('warn', 'No API key saved. Press Key above to add one.'); return; }

    say('info', 'Fetching ' + id + '…');
    setBusy(true, 'Fetching activity ' + id + '…');
    try {
      await loadRaw(await Intervals.loadRide(id, key));
      say('ok', 'Loaded.');
      $('icu-id').value = '';
    } catch (err) {
      say('err', String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-download a race from intervals.icu, discarding the stored copy and every
   * cached derivative. For when you have edited the activity there — fixed the
   * power source, trimmed the warm-up, corrected FTP — and want that reflected
   * here without hunting for it in the list again.
   */
  async function refreshFromIcu(entry, btn) {
    const key = Settings.get('icuKey');
    if (!key) { alert('No intervals.icu API key saved. Add one in Settings.'); return; }
    if (entry.raw.source !== 'icu' || !entry.raw.sourceId) return;

    if (btn) btn.classList.add('spinning');
    setBusy(true, 'Re-fetching from intervals.icu…');
    try {
      const fresh = await Intervals.loadRide(entry.raw.sourceId, key);
      fresh.id = entry.id;                       // keep its place in the list
      entry.raw = fresh;
      entry.P = RideStore.prepare(fresh, { movingSpeed: 2.5 });
      entry.A = null;
      entry.wx = null; entry.wxError = null;     // conditions may have moved too
      entry.osm = null; entry.osmError = null;
      Weather.clearCache();
      try { await RideStore.put(fresh); } catch (_) {}
      renderRaceList();
      if (state.currentId === entry.id) {
        await Promise.all([ensureWeather(entry), ensureOsm(entry)]);
        recompute();
      }
    } catch (err) {
      alert('Could not refresh: ' + (err.message || err));
    } finally {
      if (btn) btn.classList.remove('spinning');
      setBusy(false);
    }
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  function bindReplay() {
    $('rp-play').addEventListener('click', () => {
      if (state.replay.timer) stopReplay(); else startReplay();
    });
    $('rp-scrub').addEventListener('input', e => {
      const entry = current();
      if (!entry || !entry.P) return;
      stopReplay();
      state.replay.idx = Math.round((e.target.value / 1000) * (entry.P.n - 1));
      drawReplay();
    });
  }

  function startReplay() {
    const entry = current();
    if (!entry || !entry.A) return;
    const speed = parseFloat($('rp-speed').value);
    $('rp-play').textContent = '⏸ Pause';
    state.replay.timer = setInterval(() => {
      const e = current();
      if (!e || !e.A) { stopReplay(); return; }
      state.replay.idx += speed / 10;
      if (state.replay.idx >= e.P.n - 1) { state.replay.idx = e.P.n - 1; stopReplay(); }
      drawReplay();
    }, 100);
  }

  function stopReplay() {
    if (state.replay.timer) clearInterval(state.replay.timer);
    state.replay.timer = null;
    const btn = $('rp-play');
    if (btn) btn.textContent = '▶ Play';
  }

  function drawReplay() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, A = entry.A;
    const idx = Math.max(0, Math.min(P.n - 1, Math.round(state.replay.idx)));

    Charts.replayFrame($('rp-map'), $('rp-strip'), P, A, idx, { osm: basemap(entry) });
    const battery = Charts.wbalBattery($('rp-battery'), P, A, idx, { height: 150 });

    $('rp-scrub').value = Math.round((idx / (P.n - 1)) * 1000);
    $('rp-clock').textContent = Charts.fmtClock(P.t[idx]) + ' / ' + Charts.fmtClock(P.t[P.n - 1]);

    const lap = A.lapBounds && A.lapBounds[0] && A.lapBounds[0].source !== 'none'
      ? A.lapBounds.findIndex(l => idx >= l.i0 && idx <= l.i1) : -1;
    $('rp-sub').textContent = [
      lap >= 0 ? 'lap ' + (lap + 1) + ' of ' + A.lapBounds.length : null,
      (P.v[idx] * 3.6).toFixed(1) + ' km/h',
      Math.round(battery.frac * 100) + '% W′',
    ].filter(Boolean).join('  ·  ');
  }

  function bindWindow() {
    let t = null;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(renderActivePanel, 160);
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const DROPZONE_IDLE = 'Drop a <b>.fit</b> or <b>.json</b> file<br>or click to choose';

  /**
   * Busy state.
   *
   * Reference counted, because more than one thing runs at once — weather and
   * the basemap are fetched in parallel, and whichever finished first used to
   * clear the flag while the other was still going.
   *
   * The overlay waits a moment before appearing: most work here finishes in
   * well under that, and flashing a modal for 80 ms reads as a glitch. Past
   * that threshold the user needs to know the page is working rather than
   * broken, which is the whole point.
   */
  let busyDepth = 0, busyTimer = null, busyMsg = '', busyStart = 0, busySubTimer = null;
  const BUSY_DELAY_MS = 180;

  function setBusy(on, msg) {
    if (on) {
      busyDepth++;
      if (msg) busyMsg = msg;
    } else {
      busyDepth = Math.max(0, busyDepth - 1);
    }
    state.busy = busyDepth > 0;

    const dz = $('dropzone');
    if (dz) {
      dz.innerHTML = busyDepth > 0 && busyMsg ? Charts.esc(busyMsg) : DROPZONE_IDLE;
      dz.style.opacity = busyDepth > 0 ? '0.6' : '';
    }

    const overlay = $('busy-overlay');
    if (!overlay) return;

    if (busyDepth > 0) {
      $('busy-msg').textContent = busyMsg || 'Working…';
      if (!busyTimer && overlay.hidden) {
        busyStart = Date.now();
        busyTimer = setTimeout(() => {
          overlay.hidden = false;
          // If it drags on, say so rather than leaving a bare spinner.
          busySubTimer = setTimeout(() => {
            $('busy-sub').textContent = 'Still going — a slow network or a busy public API.';
          }, 5000);
        }, BUSY_DELAY_MS);
      }
    } else {
      clearTimeout(busyTimer); busyTimer = null;
      clearTimeout(busySubTimer); busySubTimer = null;
      overlay.hidden = true;
      $('busy-sub').textContent = '';
      busyMsg = '';
    }
  }

  function renderEmpty() {
    $('stat-row').innerHTML = '';
    $('findings').innerHTML =
      '<p class="hint">Load a <b>.fit</b> file, pull a ride from intervals.icu, or press ' +
      '<b>Load sample race</b> to see what CritLab does.</p>';
    $('overview-name').textContent = '';
    $('wx-readout').className = 'status status-info';
    $('wx-readout').textContent = 'No race loaded.';
    $('race-count').textContent = '';
  }

  function renderRaceList() {
    const list = $('race-list');
    $('race-count').textContent = state.races.length ? state.races.length + ' loaded' : '';
    if (!state.races.length) {
      list.innerHTML = '<div class="list-empty">No races yet</div>';
      return;
    }
    list.innerHTML = '';
    for (const r of state.races) {
      const row = document.createElement('div');
      row.className = 'ride-item' + (r.id === state.currentId ? ' active' : '');

      const secs = r.P ? r.P.t[r.P.n - 1] : (r.raw.totals && r.raw.totals.elapsed) || 0;
      const date = r.raw.startTime ? new Date(r.raw.startTime * 1000).toISOString().slice(0, 10) : '—';

      row.innerHTML =
        '<span class="ride-swatch"></span>' +
        '<span class="ride-body"><span class="ride-name">' + Charts.esc(r.raw.name) + '</span>' +
        '<span class="ride-meta">' + date + ' · ' + Charts.fmtClock(secs) + ' · ' +
        Charts.esc(sourceLabel(r.raw.source)) + '</span></span>';

      const cmp = document.createElement('input');
      cmp.type = 'checkbox';
      cmp.className = 'ride-cmp';
      cmp.checked = r.compare;
      cmp.title = 'Include in Compare';
      cmp.addEventListener('click', e => e.stopPropagation());
      cmp.addEventListener('change', () => {
        r.compare = cmp.checked;
        if (activeTab() === 'compare') renderActivePanel();
      });

      if (r.raw.source === 'icu' && r.raw.sourceId) {
        const ref = document.createElement('button');
        ref.className = 'ride-refresh';
        ref.innerHTML = '↻';
        ref.title = 'Re-download this activity from intervals.icu';
        ref.addEventListener('click', e => { e.stopPropagation(); refreshFromIcu(r, ref); });
        row.appendChild(ref);
      }

      const del = document.createElement('button');
      del.className = 'ride-del';
      del.innerHTML = '&times;';
      del.title = 'Remove';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        try { await RideStore.remove(r.id); } catch (_) {}
        state.races = state.races.filter(x => x !== r);
        if (state.currentId === r.id) {
          state.currentId = state.races.length ? state.races[0].id : null;
          if (state.currentId) await select(state.currentId); else renderEmpty();
        }
        renderRaceList();
      });

      row.appendChild(cmp);
      row.appendChild(del);
      row.addEventListener('click', () => select(r.id));
      list.appendChild(row);
    }
  }

  function sourceLabel(s) {
    return { fit: '.fit', icu: 'intervals.icu', json: 'json', demo: 'sample' }[s] || s || 'file';
  }

  function renderAll() {
    renderConditions();
    renderStats();
    renderFindings();
    renderActivePanel();
  }

  function renderConditions() {
    const entry = current();
    const el = $('wx-readout');
    const note = $('wind-note');
    if (!entry || !entry.A) { el.className = 'status status-info'; el.textContent = 'No race loaded.'; return; }

    const A = entry.A, c = A.cfg.conditions;
    const bits = [];

    // Lead with the structural problems, because they disable whole tabs and
    // the user is otherwise left guessing why the map is empty.
    if (!entry.P.hasGps) {
      bits.push('<b>No GPS in this file.</b> The map, laps, corners and sectors ' +
        'need position data; gradient is treated as flat.');
    } else if (!entry.P.startTime) {
      bits.push('<b>No start timestamp in this file</b>, so weather cannot be dated.');
    }

    if (entry.wx) {
      const sum = Weather.summarise(entry.wx, entry.P.startTime, entry.P.startTime + entry.P.t[entry.P.n - 1]);
      if (sum) {
        bits.push('<b>' + sum.temp.toFixed(0) + ' °C</b>, ' + Math.round(sum.humidity) + '% RH, ' +
          sum.pressure.toFixed(0) + ' hPa');
        bits.push('Wind <b>' + sum.windSpeed.toFixed(1) + ' m/s</b> from ' +
          Weather.compass(sum.windDir) + ' at 10 m' +
          (sum.windGust > sum.windSpeed * 1.4 ? ' (gusting ' + sum.windGust.toFixed(1) + ')' : ''));
        bits.push('<span style="opacity:.75">' + Charts.esc(sum.source || '') + '</span>');
      }
      el.className = 'status status-ok';
    } else if (entry.wxError) {
      if (entry.P.hasGps && entry.P.startTime) bits.push('No weather: ' + Charts.esc(entry.wxError));
      el.className = 'status status-warn';
    } else {
      bits.push('Weather not fetched.');
      el.className = 'status status-info';
    }

    bits.push('Air density <b>' + A.rho.toFixed(3) + ' kg/m³</b>' +
      (c && c.tempC != null ? ' at ' + c.tempC.toFixed(0) + ' °C' : ''));
    el.innerHTML = bits.join('<br>');

    // What the model actually used.
    const w = A.wind;
    const lines = [];
    const shelter = Weather.shelterFactor(Settings.get('wxRoughness'));
    if (w.source === 'weather' || w.source === 'manual') {
      const origin = w.source === 'weather' ? 'Measured' : 'Your';
      const from = w.reported10m != null ? w.reported10m.toFixed(1) : null;
      lines.push(origin + ' 10 m wind' + (from ? ' of ' + from + ' m/s' : '') +
        ', scaled to rider height (×' + shelter.toFixed(2) + ') → <b>' +
        w.speed.toFixed(1) + ' m/s from ' + Weather.compass(w.dirFrom) + '</b>.');
      lines.push('CdA calibrated to <b>' + A.cda.toFixed(3) + ' m²</b>.');
    } else {
      lines.push('Wind inferred from the power data: <b>' + w.speed.toFixed(1) + ' m/s from ' +
        Weather.compass(w.dirFrom) + '</b>, CdA <b>' + A.cda.toFixed(3) + ' m²</b>.');
      if (A.cfg.effectiveWindSource === 'fit-fallback') {
        lines.push('<span style="color:var(--st-warn)">Weather was unavailable, so wind was inferred instead.</span>');
      }
    }
    if (w.note) lines.push('<span style="color:var(--st-warn)">' + Charts.esc(w.note) + '</span>');
    if (Settings.get('lockCda')) lines.push('CdA is locked, so it was not calibrated.');
    note.innerHTML = lines.join(' ');
  }

  function renderStats() {
    const entry = current();
    if (!entry || !entry.A) return;
    const s = entry.A.summary, f = entry.A.finale;

    const tiles = [
      { val: fmtPct(s.exposed), label: 'In clean air', sub: fmtPct(s.sheltered) + ' sheltered',
        color: 'var(--div-warm)' },
      { val: Charts.fmt2(s.median), label: 'Median draft ratio', sub: 'p85 ' + Charts.fmt2(s.p85),
        color: Charts.ratioColor(s.median) },
      { val: s.savedKj.toFixed(0), unit: 'kJ', label: 'Saved by drafting',
        sub: fmtPct(s.savedPct) + ' of solo cost' },
      { val: Math.round(s.np), unit: 'W', label: 'Normalised power',
        sub: Math.round(s.avg) + ' W avg · VI ' + s.vi.toFixed(2) },
      { val: s.surges, label: 'Matches burned',
        sub: s.matchKj.toFixed(1) + ' kJ · ' + s.surgesFromShelter + ' from a wheel' +
          (s.cornerExitSurges ? ' · +' + s.cornerExitSurges + ' corner exits' : '') },
      { val: fmtPct(s.wbalMinPct), label: 'Lowest W′ left',
        sub: s.wbalMin.toFixed(1) + ' of ' + (entry.A.cfg.wPrime / 1000).toFixed(1) + ' kJ',
        color: s.wbalMinPct < 15 ? 'var(--st-critical)' : s.wbalMinPct < 35 ? 'var(--st-warn)' : undefined },
      { val: fmtPct(f.exposed), label: 'Exposure in the finale', sub: f.basis,
        color: f.exposed > 45 ? 'var(--st-warn)' : undefined },
      { val: s.laps || '—', label: 'Laps detected',
        sub: s.turns + ' corners · ' + (s.lapSource === 'device' ? 'lap button' : s.lapSource === 'gps' ? 'GPS' : 'none') },
    ];

    $('stat-row').innerHTML = tiles.map(t =>
      '<div class="stat"><div class="stat-val"' + (t.color ? ' style="color:' + t.color + '"' : '') + '>' +
      Charts.esc(t.val) + (t.unit ? '<span class="unit">' + t.unit + '</span>' : '') + '</div>' +
      '<div class="stat-label">' + Charts.esc(t.label) + '</div>' +
      (t.sub ? '<div class="stat-sub">' + Charts.esc(t.sub) + '</div>' : '') + '</div>'
    ).join('');
  }

  /**
   * The narrative layer. Everything here is derived from the analysis — no
   * finding is printed unless the data supports it, and each one says how
   * confident it is by saying how often the pattern repeated.
   */
  function renderFindings() {
    const entry = current();
    if (!entry || !entry.A) return;
    const A = entry.A, s = A.summary, f = A.finale;
    const out = [];

    // 1. The repeated sector leak.
    if (A.sectors && A.sectors.totals.length && A.sectors.grid.length >= 3) {
      const leak = A.sectors.leak, best = A.sectors.cheapest, dearest = A.sectors.dearest;
      const nLaps = A.sectors.grid.length;

      // Two ways to qualify. The absolute one ("you were genuinely in clean
      // air") depends on the CdA calibration; the relative one ("this stretch
      // topped your own lap, over and over") does not, and is the finding that
      // survives being wrong about CdA.
      const absolute = leak && leak.ratio >= A.cfg.exposedAt;
      const relative = leak && best && leak.worstShare >= 0.4 && leak.ratio - best.ratio >= 0.04;

      if (absolute || relative) {
        let body = 'Draft ratio there ran ' + leak.ratio.toFixed(2) + ' against ' +
          best.ratio.toFixed(2) + ' through ' + best.label + '. It was the least sheltered sector on ' +
          leak.lapsWorst + ' of ' + nLaps + ' laps, ' + Charts.fmtClock(leak.seconds) +
          ' in total, with a lap-to-lap spread of ±' + leak.sd.toFixed(2) +
          (leak.sd < 0.08 ? ' — that consistency means it is positioning, not luck.' : '.');
        if (dearest && dearest.sector !== leak.sector) {
          body += ' (' + dearest.label + ' carries a higher average, but it is short and mostly ' +
            'corner exits — that cost is priced on the Corners tab.)';
        }
        out.push({
          kind: leak.worstShare >= 0.7 ? 'critical' : 'warning',
          title: absolute
            ? 'You sat in the wind through ' + leak.label
            : leak.label + ' was your least sheltered stretch, lap after lap',
          body,
        });
      }
    }

    // 2. The most expensive corner.
    if (A.turns.length) {
      const worst = A.turns.slice().sort((a, b) => b.exitKjTotal - a.exitKjTotal)[0];
      if (worst.exitKjTotal > 0.5) {
        out.push({
          kind: worst.exitKjTotal > s.matchKj * 0.5 ? 'warning' : 'info',
          title: worst.name + ' cost you ' + worst.exitKjTotal.toFixed(1) + ' kJ over the race',
          body: 'You scrubbed ' + (worst.lossV * 3.6).toFixed(1) + ' km/h into it each lap (±' +
            (worst.lossSd * 3.6).toFixed(1) + ') and spent ' + worst.exitKj.toFixed(2) +
            ' kJ above CP getting the speed back, taking ' +
            (worst.recoverS != null ? worst.recoverS.toFixed(1) + ' s' : 'more than 30 s') +
            ' each time. Exit draft ratio ' + Charts.fmt2(worst.ratioOut) +
            (worst.ratioOut > A.cfg.exposedAt ? ' — you were accelerating in clean air.' : '.'),
        });
      }
    }

    // 3. Where the matches went.
    if (s.surges) {
      const matches = A.surges.filter(x => !x.cornerExit);
      const exposedSurges = matches.filter(x => !x.fromShelter).length;
      out.push({
        kind: exposedSurges > s.surges * 0.6 ? 'warning' : 'good',
        title: s.surges + ' matches above ' + Math.round(A.cfg.cp * A.cfg.surgeFactor) + ' W, ' +
          s.matchKj.toFixed(1) + ' kJ of W′',
        body: s.surgesFromShelter + ' were launched from a wheel and ' + exposedSurges +
          ' from the wind. ' +
          (exposedSurges > s.surges * 0.6
            ? 'Closing gaps from the wind is the expensive way to do it — the same effort from shelter costs roughly half.'
            : 'Most of your efforts started from a wheel, which is the cheap way to make them.') +
          (s.cornerExitSurges
            ? ' A further ' + s.cornerExitSurges + ' efforts (' + s.cornerExitKj.toFixed(1) +
              ' kJ) were corner exits rather than tactical decisions; they are counted on the Corners tab.'
            : ''),
      });
    }

    // 4. Finale readiness.
    if (isFinite(f.wbalAtStartPct)) {
      out.push({
        kind: f.wbalAtStartPct < 40 ? 'critical' : f.wbalAtStartPct < 65 ? 'warning' : 'good',
        title: 'You started the ' + f.basis + ' with ' + Math.round(f.wbalAtStartPct) + '% of W′',
        body: f.wbalAtStart.toFixed(1) + ' kJ in the tank after ' + f.matchesBurnedBefore +
          ' earlier matches (' + f.matchKjBefore.toFixed(1) + ' kJ). ' +
          'Exposure over the finale was ' + fmtPct(f.exposed) + ' against ' + fmtPct(s.exposed) +
          ' for the race' +
          (f.exposed > s.exposed * 1.3 ? ' — you drifted into the wind exactly when it mattered.' : '.'),
      });
    }

    // 5. Wind and the course.
    if (A.wind.speed > 1) {
      const bins = A.headings.filter(b => b.seconds > 20 && isFinite(b.ratio));
      if (bins.length >= 3) {
        const worst = bins.slice().sort((a, b) => b.ratio - a.ratio)[0];
        const best = bins.slice().sort((a, b) => a.ratio - b.ratio)[0];
        out.push({
          kind: 'info',
          title: 'The wind was ' + A.wind.speed.toFixed(1) + ' m/s from ' + Weather.compass(A.wind.dirFrom),
          body: 'Riding ' + worst.label + ' cost the most (median ratio ' + worst.ratio.toFixed(2) +
            ', ' + Charts.fmtClock(worst.seconds) + ' spent) and ' + best.label + ' the least (' +
            best.ratio.toFixed(2) + '). ' +
            (A.wind.source === 'fit'
              ? 'This wind was inferred from your power data, so treat the direction as approximate.'
              : 'Wind came from measured weather at the race location and time.'),
        });
      }
    }

    // 6. Data-quality caveats worth surfacing.
    const caveats = [];
    if (!entry.P.hasGps) caveats.push('no GPS, so gradient, heading, laps and corners are unavailable');
    if (A.wind.source === 'fit' && !A.wind.ok) caveats.push('the wind fit did not converge (' + (A.wind.note || 'weak signal') + ')');
    if (s.lapSource === 'none') caveats.push('no repeating laps were found, so the sector and corner views are empty');
    let gaps = 0;
    for (let i = 0; i < entry.P.n; i++) if (entry.P.gap[i]) gaps++;
    if (gaps > entry.P.n * 0.02) caveats.push(Charts.fmtClock(gaps * entry.P.dt) + ' of recording gaps were excluded');
    if (caveats.length) {
      out.push({ kind: 'info', title: 'Caveats for this file', body: caveats.join('; ') + '.' });
    }

    const icon = { critical: '●', warning: '●', good: '●', info: '●' };
    const color = {
      critical: 'var(--st-critical)', warning: 'var(--st-warn)',
      good: 'var(--st-good)', info: 'var(--text-muted)',
    };
    $('findings').innerHTML = out.length
      ? out.map(o =>
          '<div style="display:flex;gap:9px;margin-bottom:12px">' +
          '<span style="color:' + color[o.kind] + ';font-size:11px;line-height:1.7">' + icon[o.kind] + '</span>' +
          '<div><div style="font-weight:600;font-size:13px">' + Charts.esc(o.title) + '</div>' +
          '<div class="hint" style="margin-top:2px">' + Charts.esc(o.body) + '</div></div></div>'
        ).join('')
      : '<p class="hint">Nothing stood out in this race.</p>';

    $('findings-sub').textContent = entry.raw.startTime
      ? new Date(entry.raw.startTime * 1000).toLocaleString()
      : '';
    $('overview-name').textContent = entry.raw.name;
  }

  function renderActivePanel() {
    const entry = current();
    if (!entry || !entry.A) return;
    const P = entry.P, A = entry.A;

    switch (activeTab()) {
      case 'overview':
        Charts.timeline($('ov-timeline'), P, A, { xAxis: 'dist', height: 260 });
        Charts.ratioStrip($('ov-strip'), P, A, { xAxis: 'dist' });
        $('ov-legend').innerHTML = powerLegend() + ratioLegend();
        break;

      case 'timeline':
        Charts.timeline($('tl-main'), P, A, { xAxis: state.xAxis, height: 340 });
        Charts.ratioStrip($('tl-strip'), P, A, { xAxis: state.xAxis });
        $('tl-legend').innerHTML = powerLegend() + ratioLegend();
        break;

      case 'circuit':
        Charts.circuitMap($('map-main'), P, A, { height: 400, osm: basemap(entry) });
        Charts.exposureRose($('rose'), A, { height: 260 });
        Charts.sectorHeatmap($('heatmap'), A);
        $('map-legend').innerHTML = ratioLegend();
        $('heat-legend').innerHTML = heatLegend($('heatmap'));
        $('map-sub').textContent = mapSubtitle(entry);
        break;

      case 'laps':
        Charts.lapBars($('lap-bars'), A);
        $('lap-source').textContent = A.summary.lapSource === 'device'
          ? 'from lap-button presses'
          : A.summary.lapSource === 'gps' ? 'detected from GPS' : 'no laps found';
        renderLapTable(A);
        break;

      case 'corners':
        Charts.turnBars($('turn-bars'), A, state.turnMetric);
        renderTurnTable(A);
        break;

      case 'surges':
        Charts.wbalChart($('wbal'), P, A, { height: 220 });
        $('wbal-sub').textContent = 'CP ' + Math.round(A.cfg.cp) + ' W · W′ ' +
          (A.cfg.wPrime / 1000).toFixed(1) + ' kJ · τ ' + Math.round(A.wbal.tau) + ' s';
        $('wbal-legend').innerHTML =
          key(Charts.SERIES.wbal.color, "W′ balance", 'line') +
          key('rgba(217,89,38,.5)', 'match (corner exits not shaded)');
        $('surge-sub').textContent = A.summary.surges + ' matches + ' +
          A.summary.cornerExitSurges + ' corner exits, above ' +
          Math.round(A.cfg.cp * A.cfg.surgeFactor) + ' W';
        renderSurgeTable(A);
        break;

      case 'replay':
        drawReplay();
        break;

      case 'compare':
        renderCompare();
        break;
    }
  }

  function mapSubtitle(entry) {
    if (Settings.get('osmBasemap') === false) return 'basemap off';
    if (entry.osm) {
      const c = entry.osm.counts;
      return c.roads + ' roads · ' + c.buildings + ' buildings from OpenStreetMap';
    }
    if (entry.osmError) return 'no basemap: ' + entry.osmError;
    return '';
  }

  function powerLegend() {
    return key(Charts.SERIES.watts.color, Charts.SERIES.watts.label, 'line') +
           key(Charts.SERIES.solo.color, Charts.SERIES.solo.label, 'dash') +
           key('rgba(230,103,103,.25)', 'in clean air');
  }

  function ratioLegend() {
    const stops = Charts.ratioLegendStops();
    return '<span class="legend-item"><span>draft ratio</span>' +
      stops.map(s => '<span class="legend-key" style="background:' + s.color + '" title="' + s.r + '"></span>').join('') +
      '<span>' + stops[0].r.toFixed(2) + ' sheltered → ' + stops[stops.length - 1].r.toFixed(2) + ' in the wind</span></span>';
  }

  /**
   * The heatmap uses a scale centred on this race's own median rather than on
   * an absolute 1.0, so its legend has to say what the midpoint is — otherwise
   * "blue" reads as "sheltered" when it actually means "better than your
   * typical".
   */
  function heatLegend(canvas) {
    const s = canvas && canvas._clScale;
    if (!s) return ratioLegend();
    const stops = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map(d => ({
      d,
      color: Charts.ratioColorCentered(s.mid + d * s.halfSpan, s.mid, s.halfSpan),
    }));
    return '<span class="legend-item"><span>vs your race median (' + s.mid.toFixed(2) + ')</span>' +
      stops.map(x => '<span class="legend-key" style="background:' + x.color + '"></span>').join('') +
      '<span>−' + s.halfSpan.toFixed(2) + ' better → +' + s.halfSpan.toFixed(2) + ' worse</span></span>';
  }

  function key(color, text, shape) {
    const cls = shape === 'line' ? 'legend-key line' : shape === 'dash' ? 'legend-key dash' : 'legend-key';
    const style = shape === 'dash' ? 'color:' + color : 'background:' + color;
    return '<span class="legend-item"><span class="' + cls + '" style="' + style + '"></span>' +
      Charts.esc(text) + '</span>';
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  function renderLapTable(A) {
    if (!A.laps.length) {
      $('lap-table').innerHTML = '<div class="table-empty">No laps detected in this race.</div>';
      return;
    }
    const head = ['Lap', 'Time', 'Distance', 'Avg', 'NP', 'VI', 'Avg speed', 'Max speed',
      'Clean air', 'Sheltered', 'Median ratio', 'Draft saving', "W′ left"];
    const rows = A.laps.map(l => [
      l.lap,
      Charts.fmtClock(l.seconds),
      (l.distance / 1000).toFixed(2) + ' km',
      Math.round(l.avg) + ' W',
      Math.round(l.np) + ' W',
      l.vi.toFixed(2),
      (l.avgSpeed * 3.6).toFixed(1),
      (l.maxSpeed * 3.6).toFixed(1),
      tag(fmtPct(l.exposed), l.exposed >= 40 ? 'warm' : 'mid'),
      tag(fmtPct(l.sheltered), l.sheltered >= 50 ? 'cool' : 'mid'),
      Charts.fmt2(l.median),
      l.savedKj.toFixed(1) + ' kJ',
      l.wbalEnd.toFixed(1) + ' kJ',
    ]);
    $('lap-table').innerHTML = table(head, rows);
  }

  function renderTurnTable(A) {
    if (!A.turns.length) {
      $('turn-table').innerHTML =
        '<div class="table-empty">No repeating corners were detected. ' +
        'This needs GPS and at least two similar laps.</div>';
      return;
    }
    const head = ['Turn', 'Direction', 'Passes', 'Radius', 'Entry', 'Apex', 'Scrubbed',
      'Recovery', 'Exit peak', 'Exit cost / lap', 'Total', 'Exit ratio'];
    const rows = A.turns.map(t => [
      t.name,
      t.dir + ' ' + Math.round(t.turned) + '°',
      t.passes,
      isFinite(t.radius) ? Math.round(t.radius) + ' m' : '—',
      (t.entryV * 3.6).toFixed(1),
      (t.apexV * 3.6).toFixed(1),
      (t.lossV * 3.6).toFixed(1) + ' ±' + (t.lossSd * 3.6).toFixed(1),
      t.recoverS != null ? t.recoverS.toFixed(1) + ' s' : '>30 s',
      Math.round(t.exitPeak) + ' W',
      t.exitKj.toFixed(2) + ' kJ',
      t.exitKjTotal.toFixed(1) + ' kJ',
      tag(Charts.fmt2(t.ratioOut), t.ratioOut >= A.cfg.exposedAt ? 'warm' : t.ratioOut <= A.cfg.shelteredAt ? 'cool' : 'mid'),
    ]);
    $('turn-table').innerHTML = table(head, rows);
  }

  function renderSurgeTable(A) {
    if (!A.surges.length) {
      $('surge-table').innerHTML = '<div class="table-empty">No efforts crossed the surge threshold.</div>';
      return;
    }
    const head = ['#', 'At', 'Lap', 'Kind', 'Duration', 'Avg', 'Peak', 'W′ cost', "W′ left",
      'Ratio during', 'Launched from', 'Near'];
    const rows = A.surges.map(s => [
      s.index,
      Charts.fmtClock(s.t0),
      s.lap || '—',
      s.cornerExit ? tag('corner exit', 'mid') : tag('match', 'warm'),
      s.seconds.toFixed(0) + ' s',
      Math.round(s.avg) + ' W',
      Math.round(s.peak) + ' W',
      s.matchKj.toFixed(2) + ' kJ',
      s.wbalAfter.toFixed(1) + ' kJ',
      Charts.fmt2(s.ratio),
      s.fromShelter ? tag('a wheel', 'cool') : tag('the wind', 'warm'),
      s.nearTurn ? s.nearTurn + ' (' + Math.round(s.turnDistance) + ' m)' : '—',
    ]);
    $('surge-table').innerHTML = table(head, rows);
  }

  function renderCompare() {
    const picked = state.races.filter(r => r.compare);
    const rows = [];
    for (const r of picked) {
      try {
        if (!r.P) r.P = RideStore.prepare(r.raw, { movingSpeed: 2.5 });
        if (!r.A) analyse(r);
        rows.push(Analyzer.compareRow(r.raw, r.A));
      } catch (err) {
        console.warn('Could not analyse ' + r.raw.name + ' for comparison:', err);
      }
    }

    Charts.compareBars($('cmp-bars'), rows, state.cmpMetric);

    if (!rows.length) {
      $('cmp-table').innerHTML =
        '<div class="table-empty">Tick the checkbox next to two or more races in the sidebar.</div>';
      return;
    }
    const head = ['Race', 'Date', 'Time', 'Distance', 'Avg', 'NP', 'Laps', 'Turns',
      'Clean air', 'Sheltered', 'Median', 'Finale', 'Matches', 'Corner kJ', 'Min W′', 'Wind', 'CdA'];
    const body = rows.map(r => [
      r.name,
      r.date ? r.date.toISOString().slice(0, 10) : '—',
      Charts.fmtClock(r.minutes * 60),
      r.distanceKm.toFixed(1) + ' km',
      Math.round(r.avg) + ' W',
      Math.round(r.np) + ' W',
      r.laps || '—',
      r.turns || '—',
      tag(fmtPct(r.exposed), r.exposed >= 40 ? 'warm' : 'mid'),
      fmtPct(r.sheltered),
      Charts.fmt2(r.median),
      fmtPct(r.finaleExposed),
      r.surges + ' · ' + r.matchKj.toFixed(1) + ' kJ',
      r.cornerKj.toFixed(1) + ' kJ',
      fmtPct(r.wbalMinPct),
      r.wind.toFixed(1) + ' ' + Weather.compass(r.windDir),
      r.cda.toFixed(3),
    ]);
    $('cmp-table').innerHTML = table(head, body);
  }

  function table(head, rows) {
    return '<table class="data"><thead><tr>' +
      head.map(h => '<th>' + Charts.esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c =>
        '<td>' + (typeof c === 'string' && c.startsWith('<span class="tag') ? c : Charts.esc(c)) + '</td>'
      ).join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  function tag(text, kind) {
    return '<span class="tag tag-' + kind + '">' + Charts.esc(text) + '</span>';
  }

  function fmtPct(x) { return isFinite(x) ? Math.round(x) + '%' : '—'; }

  // ── Go ────────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.CritLab = { state, recompute, select, loadRaw };
})();
