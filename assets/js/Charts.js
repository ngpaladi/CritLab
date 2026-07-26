'use strict';

/**
 * Charts.js — canvas chart primitives and the eight views CritLab draws.
 *
 * Conventions, held to across every chart here:
 *   · one value axis per chart — never two y-scales
 *   · colour follows the entity (solo-required is always blue, actual power
 *     always orange), never the rank, so filtering never repaints a series
 *   · draft ratio uses a diverging ramp around 1.0, because 1.0 means
 *     something: you were paying exactly the solo price
 *   · grid and axes stay recessive; labels are selective, never per-point
 *   · every plotted chart carries a hover layer
 */
const Charts = (() => {

  const SERIES = {
    solo:  { color: '#3987e5', label: 'Solo-required power' },
    watts: { color: '#d95926', label: 'Your power' },
    wbal:  { color: '#199e70', label: "W′ balance" },
    speed: { color: '#c98500', label: 'Speed' },
    hr:    { color: '#d55181', label: 'Heart rate' },
  };

  const INK = {
    text: '#e6edf3',
    muted: '#8b949e',
    grid: '#2c313a',
    axis: '#3a424d',
    surface: '#161b22',
    surface2: '#21262d',
  };

  const DIVERGE = { cool: '#6da7ec', mid: '#4a4a47', warm: '#e66767' };

  // ── OKLab colour interpolation ────────────────────────────────────────────
  // RGB interpolation through a neutral produces muddy, uneven ramps. OKLab is
  // perceptually uniform, so equal steps in ratio look like equal steps in
  // colour — which is the whole point of a diverging scale.

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, v * 255)));
  }
  function hexToOklab(hex) {
    const h = hex.replace('#', '');
    const r = srgbToLinear(parseInt(h.slice(0, 2), 16));
    const g = srgbToLinear(parseInt(h.slice(2, 4), 16));
    const b = srgbToLinear(parseInt(h.slice(4, 6), 16));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }
  function oklabToCss([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    const r = linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bb = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    return 'rgb(' + r + ',' + g + ',' + bb + ')';
  }

  const _cool = hexToOklab(DIVERGE.cool);
  const _mid = hexToOklab(DIVERGE.mid);
  const _warm = hexToOklab(DIVERGE.warm);
  const _rampCache = new Map();

  /**
   * Draft ratio → colour. 1.0 is the neutral midpoint and means "exactly the
   * power you'd have needed alone"; blue is shelter, red is paying over the
   * odds (in the wind, or accelerating).
   */
  function ratioColor(r) {
    if (!isFinite(r)) return '#3d444d';
    const key = Math.round(r * 100);
    const hit = _rampCache.get(key);
    if (hit) return hit;

    const x = Math.max(0.55, Math.min(1.35, r));
    let out;
    if (x < 1) {
      const f = (x - 0.55) / 0.45;
      out = oklabToCss(_cool.map((c, i) => c + (_mid[i] - c) * f));
    } else {
      const f = (x - 1) / 0.35;
      out = oklabToCss(_mid.map((c, i) => c + (_warm[i] - c) * f));
    }
    _rampCache.set(key, out);
    return out;
  }

  /** Legend swatches for the ratio ramp. */
  function ratioLegendStops() {
    return [0.6, 0.75, 0.9, 1.0, 1.1, 1.25].map(r => ({ r, color: ratioColor(r) }));
  }

  /**
   * Diverging colour about an arbitrary midpoint.
   *
   * The absolute ramp above is anchored at 1.0, which is the right midpoint
   * when a value carries its own meaning — a point on the map genuinely either
   * was or was not clean air. It is the wrong midpoint for a chart whose job is
   * comparing cells to each other: a rider who sat in the bunch all race has
   * every sector between 0.55 and 0.85, and the absolute ramp renders that as a
   * uniform wall of blue with the leak invisible inside it.
   *
   * Centring on the race's own median, with arms scaled to the observed spread,
   * keeps a meaningful zero ("typical for you, today") and uses the full ramp.
   */
  function ratioColorCentered(r, mid, halfSpan) {
    if (!isFinite(r)) return '#3d444d';
    const span = Math.max(0.02, halfSpan);
    const d = Math.max(-1, Math.min(1, (r - mid) / span));
    const pole = d < 0 ? _cool : _warm;
    const f = Math.abs(d);
    return oklabToCss(_mid.map((c, i) => c + (pole[i] - c) * f));
  }

  /**
   * Pick the midpoint and arm length for a centred scale. Percentiles rather
   * than min/max, so one attack does not flatten everything else to grey.
   */
  function centredScale(values) {
    const v = values.filter(isFinite).slice().sort((a, b) => a - b);
    if (!v.length) return { mid: 1, halfSpan: 0.2 };
    const p = q => {
      const i = Math.max(0, Math.min(v.length - 1, q * (v.length - 1)));
      const lo = Math.floor(i), hi = Math.ceil(i);
      return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
    };
    const mid = p(0.5);
    const halfSpan = Math.max(0.05, mid - p(0.05), p(0.95) - mid);
    return { mid, halfSpan };
  }

  // ── Canvas plumbing ───────────────────────────────────────────────────────

  /** Size a canvas to its CSS box at device resolution and return a context. */
  function setup(canvas, cssHeight) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, rect.width || canvas.parentElement.clientWidth || 600);
    const h = cssHeight || parseInt(canvas.dataset.h || '260', 10);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function box(w, h, pad) {
    const p = { l: 46, r: 12, t: 12, b: 26, ...pad };
    return { ...p, x0: p.l, x1: w - p.r, y0: p.t, y1: h - p.b, w: w - p.l - p.r, h: h - p.t - p.b };
  }

  function scale(d0, d1, r0, r1) {
    const span = d1 - d0 || 1;
    const f = x => r0 + ((x - d0) / span) * (r1 - r0);
    f.invert = y => d0 + ((y - r0) / (r1 - r0 || 1)) * span;
    f.domain = [d0, d1];
    return f;
  }

  /** "Nice" tick values covering [lo, hi] with about `count` steps. */
  function ticks(lo, hi, count = 5) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return out;
  }

  function gridY(g, b, y, vals, fmt) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of vals) {
      const yy = Math.round(y(v)) + 0.5;
      if (yy < b.y0 - 1 || yy > b.y1 + 1) continue;
      g.strokeStyle = INK.grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(b.x0, yy); g.lineTo(b.x1, yy); g.stroke();
      g.fillStyle = INK.muted;
      g.fillText(fmt ? fmt(v) : String(v), b.x0 - 6, yy);
    }
    g.restore();
  }

  function axisX(g, b, x, vals, fmt) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.strokeStyle = INK.axis;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(b.x0, b.y1 + 0.5); g.lineTo(b.x1, b.y1 + 0.5); g.stroke();
    for (const v of vals) {
      const xx = Math.round(x(v)) + 0.5;
      if (xx < b.x0 - 1 || xx > b.x1 + 1) continue;
      g.strokeStyle = INK.grid;
      g.beginPath(); g.moveTo(xx, b.y0); g.lineTo(xx, b.y1); g.stroke();
      g.fillStyle = INK.muted;
      g.fillText(fmt ? fmt(v) : String(v), xx, b.y1 + 5);
    }
    g.restore();
  }

  function line(g, b, xs, ys, x, y, color, opts = {}) {
    g.save();
    g.beginPath();
    g.rect(b.x0, b.y0 - 2, b.w, b.h + 4);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = opts.width || 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (opts.dash) g.setLineDash(opts.dash);
    g.beginPath();
    let started = false;
    const stride = Math.max(1, Math.floor(xs.length / (b.w * 2)));
    for (let i = 0; i < xs.length; i += stride) {
      const v = ys[i];
      if (!isFinite(v)) { started = false; continue; }
      const px = x(xs[i]), py = y(v);
      if (!started) { g.moveTo(px, py); started = true; } else { g.lineTo(px, py); }
    }
    g.stroke();
    g.restore();
  }

  function label(g, text, px, py, color, align = 'left') {
    g.save();
    g.font = '600 11px system-ui, -apple-system, sans-serif';
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = INK.surface;
    g.strokeText(text, px, py);
    g.fillStyle = color;
    g.fillText(text, px, py);
    g.restore();
  }

  // ── Hover layer ───────────────────────────────────────────────────────────

  function tooltipFor(canvas) {
    const wrap = canvas.closest('.chart-wrap') || canvas.parentElement;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    let tip = wrap.querySelector(':scope > .tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tooltip';
      wrap.appendChild(tip);
    }
    return { wrap, tip };
  }

  /**
   * Attach a hover handler. `handler(px, py, api)` returns tooltip HTML or null;
   * `api.redraw(px)` lets the chart paint its own crosshair.
   */
  function onHover(canvas, handler) {
    const { wrap, tip } = tooltipFor(canvas);
    if (canvas._clHover) canvas.removeEventListener('pointermove', canvas._clHover);
    if (canvas._clLeave) canvas.removeEventListener('pointerleave', canvas._clLeave);

    const move = ev => {
      const r = canvas.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const html = handler(px, py);
      if (!html) { tip.style.display = 'none'; return; }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let lx = px + 14, ly = py - th - 10;
      if (lx + tw > wrap.clientWidth - 4) lx = px - tw - 14;
      if (ly < 2) ly = py + 16;
      tip.style.left = Math.max(2, lx) + 'px';
      tip.style.top = Math.max(2, ly) + 'px';
    };
    const leave = () => {
      tip.style.display = 'none';
      if (canvas._clOnLeave) canvas._clOnLeave();
    };

    canvas._clHover = move;
    canvas._clLeave = leave;
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
  }

  function ttRows(title, rows) {
    return '<div class="tt-title">' + esc(title) + '</div>' +
      rows.filter(Boolean).map(r =>
        '<div class="tt-row">' +
        (r.color ? '<span class="tt-key" style="background:' + r.color + '"></span>' : '') +
        '<span class="tt-name">' + esc(r.name) + '</span><span>' + esc(r.value) + '</span></div>'
      ).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ── 1. Timeline: power vs solo-required ───────────────────────────────────

  /**
   * The core view. Two power series on one watts axis (same unit, so one axis
   * is correct), with the stretches you spent in clean air shaded behind them.
   */
  function timeline(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 300);
    const b = box(w, h, { l: 46, r: 14, b: 28 });
    const useTime = opts.xAxis === 'time';
    const xs = useTime ? P.t : P.dist;
    const xMax = xs[P.n - 1] || 1;
    const x = scale(0, xMax, b.x0, b.x1);

    let pMax = 0;
    for (let i = 0; i < P.n; i++) pMax = Math.max(pMax, A.wattsS[i], A.soloS[i]);
    pMax = Math.max(300, pMax * 1.08);
    const y = scale(0, pMax, b.y1, b.y0);

    // Exposure shading behind everything.
    g.save();
    g.fillStyle = 'rgba(230,103,103,.12)';
    let i = 0;
    while (i < P.n) {
      if (!(P.moving[i] && A.ratio[i] >= A.cfg.exposedAt)) { i++; continue; }
      let j = i;
      while (j < P.n && P.moving[j] && A.ratio[j] >= A.cfg.exposedAt) j++;
      if ((j - i) * P.dt >= 5) g.fillRect(x(xs[i]), b.y0, Math.max(1, x(xs[j - 1]) - x(xs[i])), b.h);
      i = j;
    }
    g.restore();

    // Lap boundaries.
    if (A.lapBounds && A.lapBounds.length > 1 && A.lapBounds[0].source !== 'none') {
      g.save();
      g.strokeStyle = INK.axis;
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      for (const lap of A.lapBounds) {
        const px = Math.round(x(xs[lap.i0])) + 0.5;
        g.beginPath(); g.moveTo(px, b.y0); g.lineTo(px, b.y1); g.stroke();
      }
      g.restore();
    }

    gridY(g, b, y, ticks(0, pMax, 5), v => Math.round(v));
    axisX(g, b, x, ticks(0, xMax, 6), v => useTime ? fmtClock(v) : (v / 1000).toFixed(1));

    line(g, b, xs, A.soloS, x, y, SERIES.solo.color, { dash: [5, 4], width: 2 });
    line(g, b, xs, A.wattsS, x, y, SERIES.watts.color, { width: 2 });

    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(useTime ? 'elapsed' : 'km', b.x1, h - 2);
    g.textAlign = 'left';
    g.fillText('W', 4, b.y0 + 8);
    g.restore();

    let crosshair = -1;
    const paintCrosshair = () => {
      if (crosshair < 0) return;
      g.save();
      g.strokeStyle = INK.muted;
      g.lineWidth = 1;
      g.globalAlpha = 0.6;
      const px = Math.round(x(xs[crosshair])) + 0.5;
      g.beginPath(); g.moveTo(px, b.y0); g.lineTo(px, b.y1); g.stroke();
      g.globalAlpha = 1;
      for (const [arr, col] of [[A.soloS, SERIES.solo.color], [A.wattsS, SERIES.watts.color]]) {
        g.fillStyle = col;
        g.strokeStyle = INK.surface;
        g.lineWidth = 2;
        g.beginPath(); g.arc(px, y(arr[crosshair]), 4, 0, 7); g.fill(); g.stroke();
      }
      g.restore();
    };

    onHover(canvas, (px) => {
      if (px < b.x0 - 4 || px > b.x1 + 4) return null;
      const target = x.invert(Math.min(b.x1, Math.max(b.x0, px)));
      const idx = nearestIndex(xs, target, P.n);
      if (idx < 0) return null;
      crosshair = idx;
      redraw();
      if (opts.onIndex) opts.onIndex(idx);
      const r = A.ratio[idx];
      return ttRows(
        (useTime ? fmtClock(P.t[idx]) : (P.dist[idx] / 1000).toFixed(2) + ' km') +
        (A.lapBounds ? lapLabel(A, idx) : ''),
        [
          { color: SERIES.watts.color, name: 'Your power', value: Math.round(A.wattsS[idx]) + ' W' },
          { color: SERIES.solo.color, name: 'Solo needed', value: Math.round(A.soloS[idx]) + ' W' },
          { color: ratioColor(r), name: 'Draft ratio', value: isFinite(r) ? r.toFixed(2) : '—' },
          { name: 'Speed', value: (P.v[idx] * 3.6).toFixed(1) + ' km/h' },
          P.hr ? { name: 'Heart rate', value: Math.round(P.hr[idx]) + ' bpm' } : null,
        ]
      );
    });

    canvas._clOnLeave = () => { crosshair = -1; redraw(); if (opts.onIndex) opts.onIndex(-1); };

    // Cheap redraw: repaint from a cached bitmap plus the crosshair.
    let snapshot = null;
    try { snapshot = g.getImageData(0, 0, canvas.width, canvas.height); } catch (_) {}
    function redraw() {
      if (snapshot) g.putImageData(snapshot, 0, 0);
      paintCrosshair();
    }

    return { redraw };
  }

  function lapLabel(A, idx) {
    if (!A.lapBounds || A.lapBounds[0].source === 'none') return '';
    const k = A.lapBounds.findIndex(l => idx >= l.i0 && idx <= l.i1);
    return k >= 0 ? '  ·  lap ' + (k + 1) : '';
  }

  // ── 2. Ratio strip ────────────────────────────────────────────────────────

  /** A thin band under the timeline: draft ratio as a filled diverging area. */
  function ratioStrip(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 92);
    const b = box(w, h, { l: 46, r: 14, t: 8, b: 18 });
    const xs = opts.xAxis === 'time' ? P.t : P.dist;
    const x = scale(0, xs[P.n - 1] || 1, b.x0, b.x1);
    const rLo = 0.5, rHi = 1.4;
    const y = scale(rLo, rHi, b.y1, b.y0);
    const yMid = y(1);

    // Column per pixel, coloured by the ratio there — reads as a heat strip.
    const cols = Math.floor(b.w);
    for (let c = 0; c < cols; c++) {
      const t0 = x.invert(b.x0 + c), t1 = x.invert(b.x0 + c + 1);
      let s = 0, k = 0;
      for (let i = nearestIndex(xs, t0, P.n); i < P.n && xs[i] <= t1; i++) {
        if (P.moving[i] && isFinite(A.ratio[i])) { s += A.ratio[i]; k++; }
      }
      if (!k) continue;
      const r = s / k;
      const yy = y(Math.max(rLo, Math.min(rHi, r)));
      g.fillStyle = ratioColor(r);
      g.fillRect(b.x0 + c, Math.min(yy, yMid), 1, Math.max(1, Math.abs(yy - yMid)));
    }

    g.save();
    g.strokeStyle = INK.axis;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(b.x0, Math.round(yMid) + 0.5); g.lineTo(b.x1, Math.round(yMid) + 0.5); g.stroke();
    g.setLineDash([2, 3]);
    g.strokeStyle = INK.grid;
    for (const r of [A.cfg.shelteredAt, A.cfg.exposedAt]) {
      const yy = Math.round(y(r)) + 0.5;
      g.beginPath(); g.moveTo(b.x0, yy); g.lineTo(b.x1, yy); g.stroke();
    }
    g.setLineDash([]);
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.fillStyle = INK.muted;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText('1.00', b.x0 - 6, yMid);
    g.fillText(A.cfg.shelteredAt.toFixed(2), b.x0 - 6, y(A.cfg.shelteredAt));
    g.fillText(A.cfg.exposedAt.toFixed(2), b.x0 - 6, y(A.cfg.exposedAt));
    g.restore();
  }

  // ── 3. Circuit map ────────────────────────────────────────────────────────

  function projector(P, w, h, pad, i0 = 0, i1 = null) {
    const end = i1 == null ? P.n - 1 : i1;
    let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
    for (let i = i0; i <= end; i++) {
      const la = P.lat[i], lo = P.lon[i];
      if (!la && !lo) continue;
      if (la < mnLat) mnLat = la; if (la > mxLat) mxLat = la;
      if (lo < mnLon) mnLon = lo; if (lo > mxLon) mxLon = lo;
    }
    if (!isFinite(mnLat)) return null;
    const ar = Math.cos(((mnLat + mxLat) / 2) * Math.PI / 180);
    const sw = Math.max(1e-9, (mxLon - mnLon) * ar), sh = Math.max(1e-9, mxLat - mnLat);
    const s = Math.min((w - 2 * pad) / sw, (h - 2 * pad) / sh);
    const ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
    const f = i => [ox + (P.lon[i] - mnLon) * ar * s, h - (oy + (P.lat[i] - mnLat) * s)];
    f.point = (la, lo) => [ox + (lo - mnLon) * ar * s, h - (oy + (la - mnLat) * s)];
    f.metresPerPx = 1 / (s / 111320);
    return f;
  }

  // ── OSM basemap ───────────────────────────────────────────────────────────

  /**
   * Styling for the basemap. Everything here is deliberately low-contrast: the
   * map exists to tell you *where* you were, and the moment it competes with
   * the exposure ramp for attention it has stopped doing its job.
   */
  const BASEMAP = {
    water:      '#152532',
    park:       '#17251c',
    building:   '#1b212a',
    buildingEdge: '#242c37',
    road: {
      major:  { color: '#39424f', width: 5 },
      medium: { color: '#333b47', width: 3.5 },
      minor:  { color: '#2b323c', width: 2.2 },
      path:   { color: '#272d36', width: 1.4, dash: [4, 3] },
    },
  };

  /** Draw roads, buildings and water under the track. */
  function drawBasemap(g, b, pr, osm) {
    if (!osm) return;
    g.save();
    g.beginPath();
    g.rect(b.x0, b.y0, b.w, b.h);
    g.clip();

    const poly = pts => {
      g.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pr.point(pts[i][0], pts[i][1]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    };

    for (const pts of (osm.water || [])) { poly(pts); g.closePath(); g.fillStyle = BASEMAP.water; g.fill(); }

    for (const a of (osm.areas || [])) {
      if (a.kind !== 'park' && a.kind !== 'pitch' && a.kind !== 'track') continue;
      poly(a.pts); g.closePath(); g.fillStyle = BASEMAP.park; g.fill();
    }

    for (const pts of (osm.buildings || [])) {
      poly(pts); g.closePath();
      g.fillStyle = BASEMAP.building; g.fill();
      g.strokeStyle = BASEMAP.buildingEdge; g.lineWidth = 1; g.stroke();
    }

    // Paths first, then increasingly prominent roads on top.
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const cls of ['path', 'minor', 'medium', 'major']) {
      const style = BASEMAP.road[cls];
      g.strokeStyle = style.color;
      g.lineWidth = style.width;
      g.setLineDash(style.dash || []);
      for (const r of (osm.roads || [])) {
        if (r.cls !== cls) continue;
        poly(r.pts);
        g.stroke();
      }
    }
    g.setLineDash([]);
    g.restore();
  }

  function drawAttribution(g, w, h, text) {
    g.save();
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const pad = 4;
    const tw = g.measureText(text).width;
    g.fillStyle = 'rgba(13,17,23,.72)';
    g.fillRect(2, h - 15, tw + pad * 2, 14);
    g.fillStyle = INK.muted;
    g.fillText(text, 2 + pad, h - 3);
    g.restore();
  }

  /** The circuit, every metre of it coloured by how exposed you were there. */
  function circuitMap(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 420);
    if (!P.lat) {
      emptyState(g, w, h, 'No GPS data in this ride');
      return null;
    }
    const pr = projector(P, w, h, 26);
    if (!pr) { emptyState(g, w, h, 'No usable GPS points'); return null; }

    if (opts.osm) drawBasemap(g, { x0: 0, y0: 0, w, h, x1: w, y1: h }, pr, opts.osm);

    // Ghost of the whole track underneath, so gaps in colour read as gaps.
    g.save();
    g.strokeStyle = '#262c35';
    g.lineWidth = 7;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (let i = 0; i < P.n; i++) {
      if (!P.lat[i] && !P.lon[i]) { started = false; continue; }
      const [px, py] = pr(i);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
    g.restore();

    g.lineWidth = 4;
    g.lineCap = 'round';
    for (let i = 1; i < P.n; i++) {
      if ((!P.lat[i] && !P.lon[i]) || (!P.lat[i - 1] && !P.lon[i - 1])) continue;
      if (!P.moving[i]) continue;
      const a = pr(i - 1), c = pr(i);
      g.strokeStyle = ratioColor(A.ratio[i]);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke();
    }

    // Turn markers.
    for (const turn of (A.turns || [])) {
      const [px, py] = pr.point(turn.lat, turn.lon);
      g.save();
      g.fillStyle = INK.surface;
      g.strokeStyle = INK.muted;
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, py, 9, 0, 7); g.fill(); g.stroke();
      g.fillStyle = INK.text;
      g.font = '600 10px system-ui, -apple-system, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(turn.number), px, py + 0.5);
      g.restore();
    }

    // Start/finish, drawn as a line across the road rather than a cross on it —
    // it is a line on the ground, and showing it as one makes it obvious which
    // way round the lap starts and whether it is in the right place.
    if (A.lapBounds && A.lapBounds[0] && A.lapBounds[0].source !== 'none') {
      const i0 = A.lapBounds[0].i0;
      const [px, py] = pr(i0);
      const manual = A.lapBounds[0].source === 'manual';
      const h = P.heading[i0];
      const nx = Math.cos(h), ny = Math.sin(h);        // perpendicular to travel
      const L = 13;
      g.save();
      g.strokeStyle = manual ? '#fab219' : INK.text;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(px - nx * L, py - ny * L);
      g.lineTo(px + nx * L, py + ny * L);
      g.stroke();
      g.fillStyle = manual ? '#fab219' : INK.text;
      g.font = '600 9px system-ui, -apple-system, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.strokeStyle = INK.surface;
      g.lineWidth = 3;
      const label = manual ? 'START/FINISH' : 'lap split';
      g.strokeText(label, px, py - L - 3);
      g.fillText(label, px, py - L - 3);
      g.restore();
    }

    // Wind arrow, drawn in the corner pointing the way the wind blows.
    if (A.wind && A.wind.speed > 0.3) drawWindArrow(g, w, h, A.wind);
    if (opts.osm) drawAttribution(g, w, h, opts.osm.attribution || '© OpenStreetMap contributors');

    // Click-to-place the start/finish line.
    if (canvas._clPick) canvas.removeEventListener('click', canvas._clPick);
    if (opts.onPick) {
      canvas.style.cursor = 'crosshair';
      canvas._clPick = ev => {
        const r = canvas.getBoundingClientRect();
        const px = ev.clientX - r.left, py = ev.clientY - r.top;
        let best = -1, bestD = 40;
        for (let i = 0; i < P.n; i++) {
          if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
          const [ax, ay] = pr(i);
          const d = Math.hypot(ax - px, ay - py);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) opts.onPick({ lat: P.lat[best], lon: P.lon[best], index: best });
      };
      canvas.addEventListener('click', canvas._clPick);
    } else {
      canvas._clPick = null;
      canvas.style.cursor = '';
    }

    onHover(canvas, (px, py) => {
      let best = -1, bestD = 18;
      for (let i = 0; i < P.n; i += 2) {
        if (!P.lat[i] && !P.lon[i]) continue;
        const [ax, ay] = pr(i);
        const d = Math.hypot(ax - px, ay - py);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) return null;
      if (opts.onIndex) opts.onIndex(best);
      const r = A.ratio[best];
      return ttRows(fmtClock(P.t[best]) + lapLabel(A, best), [
        { color: ratioColor(r), name: 'Draft ratio', value: isFinite(r) ? r.toFixed(2) : '—' },
        { color: SERIES.watts.color, name: 'Power', value: Math.round(P.watts[best]) + ' W' },
        { name: 'Speed', value: (P.v[best] * 3.6).toFixed(1) + ' km/h' },
        { name: 'Heading', value: Weather.compass(P.heading[best] * 180 / Math.PI) },
      ]);
    });

    return pr;
  }

  function drawWindArrow(g, w, h, wind) {
    const cx = w - 46, cy = 44, R = 26;
    const to = ((wind.dirFrom + 180) * Math.PI) / 180;
    const dx = Math.sin(to), dy = -Math.cos(to);
    g.save();
    // Opaque backing: with a basemap underneath, roads would otherwise run
    // straight through the dial and the arrow becomes unreadable.
    g.fillStyle = 'rgba(13,17,23,.82)';
    g.beginPath(); g.arc(cx, cy, R + 3, 0, 7); g.fill();
    g.strokeStyle = INK.axis;
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();

    g.strokeStyle = SERIES.solo.color;
    g.fillStyle = SERIES.solo.color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx - dx * R * 0.75, cy - dy * R * 0.75);
    g.lineTo(cx + dx * R * 0.55, cy + dy * R * 0.55);
    g.stroke();
    g.beginPath();
    g.moveTo(cx + dx * R * 0.85, cy + dy * R * 0.85);
    g.lineTo(cx + dx * R * 0.35 - dy * 7, cy + dy * R * 0.35 + dx * 7);
    g.lineTo(cx + dx * R * 0.35 + dy * 7, cy + dy * R * 0.35 - dx * 7);
    g.closePath(); g.fill();

    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText(wind.speed.toFixed(1) + ' m/s ' + Weather.compass(wind.dirFrom), cx, cy + R + 4);
    g.restore();
  }

  // ── 4. Lap × sector heatmap ───────────────────────────────────────────────

  /**
   * The positioning-leak view: one row per lap, one column per sector of the
   * circuit. A column that is red all the way down is a place you were in the
   * wind every single lap.
   */
  function sectorHeatmap(canvas, A, opts = {}) {
    const S = A.sectors;
    const rows = S ? S.grid.length : 0;
    const cols = S ? S.labels.length : 0;
    const h = Math.max(120, 34 + rows * 22 + 26);
    const { g, w } = setup(canvas, h);
    if (!S || !rows || !cols) {
      emptyState(g, w, h, 'Needs at least two detected laps');
      return;
    }

    const padL = 62, padR = 12, padT = 30, padB = 24;
    const cw = (w - padL - padR) / cols;
    const ch = (h - padT - padB) / rows;

    // Scale to this race's own spread — see ratioColorCentered.
    const cells = [];
    for (const row of S.grid) for (const c of row.cells) cells.push(c.ratio);
    const scale = centredScale(cells);
    const col = r => ratioColorCentered(r, scale.mid, scale.halfSpan);

    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';

    // Column headers.
    g.save();
    g.fillStyle = INK.muted;
    g.textAlign = 'center';
    for (let c = 0; c < cols; c++) {
      g.fillText(shorten(S.labels[c], Math.floor(cw / 6)), padL + cw * (c + 0.5), padT - 12);
    }
    g.restore();

    for (let r = 0; r < rows; r++) {
      g.save();
      g.fillStyle = INK.muted;
      g.textAlign = 'right';
      g.fillText('Lap ' + S.grid[r].lap, padL - 8, padT + ch * (r + 0.5));
      g.restore();

      for (let c = 0; c < cols; c++) {
        const cell = S.grid[r].cells[c];
        // 2px surface gap between fills keeps adjacent cells legible.
        const x0 = padL + cw * c + 1, y0 = padT + ch * r + 1;
        g.fillStyle = isFinite(cell.ratio) ? col(cell.ratio) : INK.surface2;
        roundRect(g, x0, y0, Math.max(1, cw - 2), Math.max(1, ch - 2), 3);
        g.fill();
      }
    }

    // Aggregate strip along the bottom, so the repeated pattern is explicit.
    g.save();
    g.fillStyle = INK.muted;
    g.textAlign = 'right';
    g.fillText('all laps', padL - 8, padT + ch * rows + 11);
    g.restore();
    for (let c = 0; c < cols; c++) {
      const tot = S.totals[c];
      const x0 = padL + cw * c + 1;
      g.fillStyle = isFinite(tot.ratio) ? col(tot.ratio) : INK.surface2;
      roundRect(g, x0, padT + ch * rows + 4, Math.max(1, cw - 2), 14, 3);
      g.fill();
      if (cw > 34 && isFinite(tot.ratio)) {
        label(g, tot.ratio.toFixed(2), x0 + (cw - 2) / 2, padT + ch * rows + 11, INK.text, 'center');
      }
    }

    canvas._clScale = scale;

    onHover(canvas, (px, py) => {
      const c = Math.floor((px - padL) / cw);
      if (c < 0 || c >= cols) return null;
      const r = Math.floor((py - padT) / ch);
      if (py > padT + ch * rows && py < padT + ch * rows + 20) {
        const tot = S.totals[c];
        return ttRows(tot.label + ' — every lap', [
          { color: col(tot.ratio), name: 'Median draft ratio', value: fmt2(tot.ratio) },
          { name: 'Lap-to-lap spread', value: '±' + fmt2(tot.sd) },
          { name: 'Least sheltered on', value: tot.lapsWorst + ' of ' + rows + ' laps' },
          { name: 'Time here', value: fmtClock(tot.seconds) },
        ]);
      }
      if (r < 0 || r >= rows) return null;
      const cell = S.grid[r].cells[c];
      return ttRows('Lap ' + S.grid[r].lap + ' · ' + cell.label, [
        { color: col(cell.ratio), name: 'Draft ratio', value: fmt2(cell.ratio) },
        { name: 'vs your race median', value: (cell.ratio >= scale.mid ? '+' : '') +
          (cell.ratio - scale.mid).toFixed(2) },
        { name: 'Average power', value: isFinite(cell.watts) ? Math.round(cell.watts) + ' W' : '—' },
        { name: 'Time', value: fmtClock(cell.seconds) },
      ]);
    });
  }

  // ── 5. W′ balance ─────────────────────────────────────────────────────────

  /** How much of the anaerobic tank was left, and where it went. */
  function wbalChart(canvas, P, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 220);
    const b = box(w, h, { l: 46, r: 14, b: 26 });
    const x = scale(0, P.t[P.n - 1] || 1, b.x0, b.x1);
    const wp = A.cfg.wPrime;
    const y = scale(0, wp / 1000, b.y1, b.y0);

    // Matches as background bands. Corner exits are deliberately not shaded —
    // there is one every few seconds on a crit circuit, and banding them all
    // turns the chart into a solid block that says nothing.
    g.save();
    g.fillStyle = 'rgba(217,89,38,.20)';
    for (const s of A.surges) {
      if (s.cornerExit) continue;
      g.fillRect(x(P.t[s.i0]), b.y0, Math.max(1.5, x(P.t[s.i1]) - x(P.t[s.i0])), b.h);
    }
    g.restore();

    gridY(g, b, y, ticks(0, wp / 1000, 4), v => v.toFixed(1));
    axisX(g, b, x, ticks(0, P.t[P.n - 1] || 1, 6), fmtClock);

    const kj = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) kj[i] = A.wbal.bal[i] / 1000;
    line(g, b, P.t, kj, x, y, SERIES.wbal.color, { width: 2 });

    // Direct-label the low point — the one number that matters here.
    const mi = A.wbal.minAt;
    g.save();
    g.fillStyle = SERIES.wbal.color;
    g.strokeStyle = INK.surface;
    g.lineWidth = 2;
    g.beginPath(); g.arc(x(P.t[mi]), y(kj[mi]), 4.5, 0, 7); g.fill(); g.stroke();
    g.restore();
    // The low point is usually on the floor, so lift the label clear of both
    // the trace and the axis, and flip it inboard near the right edge.
    const lx = x(P.t[mi]), nearRight = lx > b.x1 - 90;
    label(g, 'low: ' + kj[mi].toFixed(1) + ' kJ',
      lx + (nearRight ? -8 : 8), Math.max(b.y0 + 8, y(kj[mi]) - 14),
      INK.text, nearRight ? 'right' : 'left');

    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText('kJ', 4, b.y0 + 8);
    g.restore();

    onHover(canvas, px => {
      if (px < b.x0 - 4 || px > b.x1 + 4) return null;
      const tt = x.invert(Math.min(b.x1, Math.max(b.x0, px)));
      const idx = Math.max(0, Math.min(P.n - 1, Math.round(tt / P.dt)));
      const surge = A.surges.find(s => idx >= s.i0 && idx <= s.i1);
      return ttRows(fmtClock(P.t[idx]) + lapLabel(A, idx), [
        { color: SERIES.wbal.color, name: "W′ left", value: kj[idx].toFixed(1) + ' kJ' },
        { name: 'of capacity', value: Math.round((100 * kj[idx] * 1000) / wp) + '%' },
        { color: SERIES.watts.color, name: 'Power', value: Math.round(P.watts[idx]) + ' W' },
        surge ? { name: 'In surge', value: '#' + surge.index + ' · ' + Math.round(surge.avg) + ' W' } : null,
      ]);
    });
  }

  // ── 6. Per-turn bars ──────────────────────────────────────────────────────

  /**
   * One horizontal bar per corner. `metric` picks what is measured; bars are
   * anchored at the baseline with rounded data-ends and direct value labels.
   */
  function turnBars(canvas, A, metric, opts = {}) {
    const turns = A.turns || [];
    const h = Math.max(110, 24 + turns.length * 26 + 22);
    const { g, w } = setup(canvas, h);
    if (!turns.length) { emptyState(g, w, h, 'No repeating corners detected'); return; }

    const spec = {
      loss:   { get: t => t.lossV * 3.6, unit: ' km/h', title: 'Speed scrubbed', dec: 1 },
      exit:   { get: t => t.exitKj,      unit: ' kJ',   title: 'Exit cost per lap', dec: 2 },
      apex:   { get: t => t.apexV * 3.6, unit: ' km/h', title: 'Apex speed', dec: 1 },
      recover:{ get: t => t.recoverS,    unit: ' s',    title: 'Time to regain speed', dec: 1 },
    }[metric] || { get: t => t.exitKj, unit: ' kJ', title: 'Exit cost', dec: 2 };

    const vals = turns.map(spec.get);
    const vMax = Math.max(0.0001, ...vals.filter(isFinite)) * 1.25;
    const padL = 56, padR = 14, padT = 20, padB = 20;
    const x = scale(0, vMax, padL, w - padR);
    const bh = (h - padT - padB) / turns.length;

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const v = vals[i];
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.muted;
      g.textAlign = 'right';
      g.fillText(t.name, padL - 8, cy);
      g.restore();

      if (!isFinite(v)) continue;
      // Bar coloured by how exposed the exit was — same ramp as everywhere else.
      g.fillStyle = ratioColor(t.ratioOut);
      const bw = Math.max(2, x(v) - padL);
      roundRect(g, padL, cy - bh * 0.28, bw, bh * 0.56, 4, true);
      g.fill();
      label(g, v.toFixed(spec.dec) + spec.unit, padL + bw + 6, cy, INK.text);
    }

    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(spec.title, padL, 4);
    g.restore();

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= turns.length || px < padL - 50) return null;
      const t = turns[i];
      return ttRows(t.name + ' · ' + t.dir + ' ' + Math.round(t.turned) + '°', [
        { name: 'Passes', value: t.passes },
        { name: 'Entry → apex', value: (t.entryV * 3.6).toFixed(1) + ' → ' + (t.apexV * 3.6).toFixed(1) + ' km/h' },
        { name: 'Scrubbed', value: (t.lossV * 3.6).toFixed(1) + ' km/h (±' + (t.lossSd * 3.6).toFixed(1) + ')' },
        { name: 'Exit cost', value: t.exitKj.toFixed(2) + ' kJ/lap · ' + t.exitKjTotal.toFixed(1) + ' kJ total' },
        { name: 'Back to speed', value: t.recoverS != null ? t.recoverS.toFixed(1) + ' s' : 'never' },
        { color: ratioColor(t.ratioOut), name: 'Exit draft ratio', value: fmt2(t.ratioOut) },
      ]);
    });
  }

  // ── 7. Exposure rose ──────────────────────────────────────────────────────

  /**
   * Draft ratio by direction of travel, as a polar plot. With a real wind this
   * should lean: the bearing pointing into the wind is where the work is.
   */
  function exposureRose(canvas, A, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 250);
    const cx = w / 2, cy = h / 2 + 4;
    const R = Math.min(w, h) / 2 - 26;
    const bins = A.headings.filter(b => b.seconds > 0);

    g.save();
    g.strokeStyle = INK.grid;
    g.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) {
      g.beginPath(); g.arc(cx, cy, R * f, 0, 7); g.stroke();
    }
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const [lbl, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      g.fillText(lbl, cx + dx * (R + 13), cy + dy * (R + 13));
    }
    g.restore();

    // Radius encodes time spent on that bearing; colour encodes exposure.
    const maxSec = Math.max(1, ...bins.map(b => b.seconds));
    const half = (22.5 * Math.PI) / 180 / 2;
    for (const b of bins) {
      const ang = (b.dir * Math.PI) / 180 - Math.PI / 2;
      const rad = R * Math.sqrt(b.seconds / maxSec);
      g.fillStyle = ratioColor(b.ratio);
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, rad, ang - half + 0.012, ang + half - 0.012);
      g.closePath();
      g.fill();
    }

    if (A.wind && A.wind.speed > 0.3) {
      const from = ((A.wind.dirFrom - 90) * Math.PI) / 180;
      g.save();
      g.strokeStyle = INK.text;
      g.lineWidth = 2;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(cx + Math.cos(from) * R * 1.1, cy + Math.sin(from) * R * 1.1);
      g.lineTo(cx, cy);
      g.stroke();
      g.restore();
      label(g, 'wind', cx + Math.cos(from) * (R + 6), cy + Math.sin(from) * (R + 6), INK.text, 'center');
    }

    onHover(canvas, (px, py) => {
      const dx = px - cx, dy = py - cy;
      const rr = Math.hypot(dx, dy);
      if (rr > R + 4) return null;
      const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      const b = A.headings[Math.round(deg / 22.5) % 16];
      if (!b || !b.seconds) return null;
      return ttRows('Heading ' + b.label + ' (' + Math.round(b.dir) + '°)', [
        { color: ratioColor(b.ratio), name: 'Median ratio', value: fmt2(b.ratio) },
        { name: 'Least sheltered (p85)', value: fmt2(b.p85) },
        { name: 'Time on this bearing', value: fmtClock(b.seconds) },
      ]);
    });
  }

  // ── 8. Per-lap bars ───────────────────────────────────────────────────────

  function lapBars(canvas, A, opts = {}) {
    const laps = A.laps || [];
    const h = Math.max(110, 22 + laps.length * 22 + 22);
    const { g, w } = setup(canvas, h);
    if (!laps.length) { emptyState(g, w, h, 'No laps detected'); return; }

    const padL = 46, padR = 14, padT = 18, padB = 20;
    const x = scale(0, 100, padL, w - padR);
    const bh = (h - padT - padB) / laps.length;

    g.save();
    g.strokeStyle = INK.grid;
    g.lineWidth = 1;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.fillStyle = INK.muted;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of [0, 25, 50, 75, 100]) {
      const xx = Math.round(x(v)) + 0.5;
      g.beginPath(); g.moveTo(xx, padT); g.lineTo(xx, h - padB); g.stroke();
      g.fillText(v + '%', xx, h - padB + 4);
    }
    g.restore();

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < laps.length; i++) {
      const l = laps[i];
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.muted; g.textAlign = 'right';
      g.fillText(String(l.lap), padL - 8, cy);
      g.restore();
      if (!isFinite(l.exposed)) continue;
      g.fillStyle = DIVERGE.warm;
      const bw = Math.max(2, x(l.exposed) - padL);
      roundRect(g, padL, cy - bh * 0.26, bw, bh * 0.52, 4, true);
      g.fill();
      label(g, Math.round(l.exposed) + '%', padL + bw + 6, cy, INK.text);
    }

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= laps.length) return null;
      const l = laps[i];
      return ttRows('Lap ' + l.lap, [
        { color: DIVERGE.warm, name: 'In clean air', value: fmtPct(l.exposed) },
        { color: DIVERGE.cool, name: 'Sheltered', value: fmtPct(l.sheltered) },
        { name: 'Median ratio', value: fmt2(l.median) },
        { color: SERIES.watts.color, name: 'Average power', value: Math.round(l.avg) + ' W' },
        { name: 'Lap time', value: fmtClock(l.seconds) },
        { name: 'Saved by drafting', value: l.savedKj.toFixed(1) + ' kJ' },
      ]);
    });
  }

  // ── 9. Compare ────────────────────────────────────────────────────────────

  function compareBars(canvas, rows, metric, opts = {}) {
    const h = Math.max(120, 26 + rows.length * 30 + 22);
    const { g, w } = setup(canvas, h);
    if (!rows.length) { emptyState(g, w, h, 'Tick two or more races in the sidebar'); return; }

    const spec = {
      exposed:  { get: r => r.exposed,   unit: '%',  title: 'Time in clean air', dec: 0, max: 100 },
      median:   { get: r => r.median,    unit: '',   title: 'Median draft ratio', dec: 2, max: null },
      matchKj:  { get: r => r.matchKj,   unit: ' kJ',title: 'Matches burned', dec: 1, max: null },
      cornerKj: { get: r => r.cornerKj,  unit: ' kJ',title: 'Spent on corner exits', dec: 1, max: null },
      finale:   { get: r => r.finaleExposed, unit: '%', title: 'Exposure in the finale', dec: 0, max: 100 },
    }[metric] || { get: r => r.exposed, unit: '%', title: 'Time in clean air', dec: 0, max: 100 };

    const vals = rows.map(spec.get);
    const vMax = spec.max || Math.max(0.001, ...vals.filter(isFinite)) * 1.2;
    const padL = Math.min(180, Math.max(90, w * 0.28)), padR = 14, padT = 22, padB = 20;
    const x = scale(0, vMax, padL, w - padR);
    const bh = (h - padT - padB) / rows.length;

    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cy = padT + bh * (i + 0.5);
      g.save();
      g.fillStyle = INK.muted; g.textAlign = 'right';
      g.fillText(shorten(r.name, Math.floor((padL - 12) / 6)), padL - 8, cy - 6);
      g.font = '10px system-ui, -apple-system, sans-serif';
      g.fillText(r.date ? r.date.toISOString().slice(0, 10) : '', padL - 8, cy + 7);
      g.restore();

      const v = spec.get(r);
      if (!isFinite(v)) continue;
      g.fillStyle = metric === 'median' ? ratioColor(v) : DIVERGE.warm;
      const bw = Math.max(2, x(v) - padL);
      roundRect(g, padL, cy - bh * 0.24, bw, bh * 0.48, 4, true);
      g.fill();
      label(g, v.toFixed(spec.dec) + spec.unit, padL + bw + 6, cy, INK.text);
    }

    g.save();
    g.fillStyle = INK.muted;
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(spec.title, padL, 5);
    g.restore();

    onHover(canvas, (px, py) => {
      const i = Math.floor((py - padT) / bh);
      if (i < 0 || i >= rows.length) return null;
      const r = rows[i];
      return ttRows(r.name, [
        { name: 'Clean air', value: fmtPct(r.exposed) },
        { name: 'Sheltered', value: fmtPct(r.sheltered) },
        { name: 'Median ratio', value: fmt2(r.median) },
        { name: 'Laps · turns', value: r.laps + ' · ' + r.turns },
        { name: 'Matches', value: r.surges + ' (' + r.matchKj.toFixed(1) + ' kJ)' },
        { name: 'Wind', value: r.wind.toFixed(1) + ' m/s ' + Weather.compass(r.windDir) + ' (' + r.windSource + ')' },
        { name: 'CdA used', value: r.cda.toFixed(3) + ' m²' },
      ]);
    });
  }

  // ── 10. Replay ────────────────────────────────────────────────────────────

  function replayFrame(mapCanvas, stripCanvas, P, A, idx, opts = {}) {
    // Map with a comet tail.
    {
      const { g, w, h } = setup(mapCanvas, opts.mapHeight || 300);
      if (P.lat) {
        const pr = projector(P, w, h, 18);
        if (pr) {
          if (opts.osm) drawBasemap(g, { x0: 0, y0: 0, w, h, x1: w, y1: h }, pr, opts.osm);
          g.save();
          g.strokeStyle = '#262c35';
          g.lineWidth = 3;
          g.lineJoin = 'round';
          g.beginPath();
          let started = false;
          for (let k = 0; k < P.n; k++) {
            if (!P.lat[k] && !P.lon[k]) { started = false; continue; }
            const p = pr(k);
            if (!started) { g.moveTo(p[0], p[1]); started = true; } else g.lineTo(p[0], p[1]);
          }
          g.stroke();
          g.restore();

          g.lineWidth = 4;
          g.lineCap = 'round';
          for (let k = Math.max(1, idx - 90); k <= idx; k++) {
            if ((!P.lat[k] && !P.lon[k]) || (!P.lat[k - 1] && !P.lon[k - 1])) continue;
            const a = pr(k - 1), c = pr(k);
            g.globalAlpha = 0.25 + 0.75 * ((k - Math.max(1, idx - 90)) / 90);
            g.strokeStyle = ratioColor(A.ratio[k]);
            g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(c[0], c[1]); g.stroke();
          }
          g.globalAlpha = 1;

          for (const turn of (A.turns || [])) {
            const [px, py] = pr.point(turn.lat, turn.lon);
            g.fillStyle = INK.axis;
            g.beginPath(); g.arc(px, py, 3, 0, 7); g.fill();
          }

          const p = pr(idx);
          g.fillStyle = ratioColor(A.ratio[idx]);
          g.strokeStyle = '#fff';
          g.lineWidth = 2;
          g.beginPath(); g.arc(p[0], p[1], 6, 0, 7); g.fill(); g.stroke();
        }
      } else {
        emptyState(g, w, h, 'No GPS data');
      }
    }

    // A moving window of the two power series.
    {
      const { g, w, h } = setup(stripCanvas, 220);
      const b = box(w, h, { l: 42, r: 12, b: 22, t: 24 });
      const win = 90;
      const lo = Math.max(0, idx - win), hi = Math.min(P.n - 1, idx + win);
      let pMax = 300;
      for (let k = lo; k <= hi; k++) pMax = Math.max(pMax, A.wattsS[k], A.soloS[k]);
      pMax *= 1.1;
      const x = scale(P.t[lo], P.t[hi], b.x0, b.x1);
      const y = scale(0, pMax, b.y1, b.y0);

      gridY(g, b, y, ticks(0, pMax, 4), v => Math.round(v));
      axisX(g, b, x, ticks(P.t[lo], P.t[hi], 4), fmtClock);

      const xs = [], solo = [], watts = [];
      for (let k = lo; k <= hi; k++) { xs.push(P.t[k]); solo.push(A.soloS[k]); watts.push(A.wattsS[k]); }
      line(g, b, xs, solo, x, y, SERIES.solo.color, { dash: [5, 4] });
      line(g, b, xs, watts, x, y, SERIES.watts.color);

      g.save();
      g.strokeStyle = INK.muted;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(Math.round(x(P.t[idx])) + 0.5, b.y0);
      g.lineTo(Math.round(x(P.t[idx])) + 0.5, b.y1);
      g.stroke();
      g.restore();

      const r = A.ratio[idx];
      g.save();
      g.font = '600 12px system-ui, -apple-system, sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillStyle = INK.text;
      g.fillText(Math.round(P.watts[idx]) + ' W', b.x0, 4);
      g.fillStyle = INK.muted;
      g.font = '11px system-ui, -apple-system, sans-serif';
      g.fillText('· ' + (P.v[idx] * 3.6).toFixed(1) + ' km/h · ' +
        (A.wbal.bal[idx] / 1000).toFixed(1) + ' kJ left' + lapLabel(A, idx),
        b.x0 + g.measureText(Math.round(P.watts[idx]) + ' W ').width + 10, 5);
      g.fillStyle = ratioColor(r);
      g.textAlign = 'right';
      g.fillText('ratio ' + fmt2(r), b.x1, 5);
      g.restore();
    }
  }

  // ── W′ battery ────────────────────────────────────────────────────────────

  /**
   * A battery gauge for W′, for the replay.
   *
   * The W′ chart on the Surges tab answers "where did it go?" over the whole
   * race. This answers a different question, the one you actually have while
   * watching a replay: *right now, how much have I got, and is it going up or
   * down?* Hence a charge level, an instantaneous drain rate, and a short
   * trailing history — not another full-race line chart.
   *
   * The segmented fill is deliberate: a continuous bar invites reading a
   * precision the model does not have, whereas ten cells read as "about
   * six-tenths left", which is the right resolution for an estimate whose
   * underlying W′ is itself uncertain.
   */
  function wbalBattery(canvas, P, A, idx, opts = {}) {
    const { g, w, h } = setup(canvas, opts.height || 168);
    const wp = A.cfg.wPrime;
    const bal = A.wbal.bal[idx];
    const frac = wp > 0 ? Math.max(0, Math.min(1, bal / wp)) : 0;

    // Net rate over the last few seconds: what the tank is doing, not what it did.
    const back = Math.max(1, Math.round(5 / P.dt));
    const from = Math.max(0, idx - back);
    const rate = (A.wbal.bal[idx] - A.wbal.bal[from]) / ((idx - from) * P.dt || 1);   // J/s

    // Colour by state of charge — a reserved status ramp rather than a series
    // colour, because this is a state, and it always ships with a word beside it.
    const state = frac > 0.5 ? 'good' : frac > 0.25 ? 'warning' : frac > 0.08 ? 'serious' : 'critical';
    const colour = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' }[state];
    const stateLabel = { good: 'fresh', warning: 'working', serious: 'deep', critical: 'empty' }[state];

    const padX = 14;
    const bodyW = Math.max(120, Math.min(w - padX * 2 - 10, 300));
    const bodyH = 44;
    const bx = padX, by = 42;
    const capW = 5, capH = 16;
    const right = bx + bodyW + capW;

    /**
     * Put a primary label left and a secondary right on the same baseline, and
     * drop the secondary rather than let them overlap. Font metrics vary enough
     * between platforms that "it fits on my machine" is not a layout.
     */
    const pair = (y, leftText, leftColour, rightText, rightColour, font) => {
      g.save();
      g.font = font;
      g.textBaseline = 'middle';
      const lw = g.measureText(leftText).width;
      const rw = rightText ? g.measureText(rightText).width : 0;
      g.textAlign = 'left';
      g.fillStyle = leftColour;
      g.fillText(leftText, bx, y);
      if (rightText && lw + rw + 16 <= right - bx) {
        g.textAlign = 'right';
        g.fillStyle = rightColour;
        g.fillText(rightText, right, y);
      }
      g.restore();
    };

    // ── Headline ────────────────────────────────────────────────────────────
    g.save();
    g.textBaseline = 'middle';
    g.font = '600 21px system-ui, -apple-system, sans-serif';
    g.fillStyle = INK.text;
    g.textAlign = 'left';
    const kjText = (bal / 1000).toFixed(1);
    g.fillText(kjText, bx, 18);
    const kjW = g.measureText(kjText).width;

    g.font = '12px system-ui, -apple-system, sans-serif';
    g.fillStyle = INK.muted;
    g.fillText('kJ of ' + (wp / 1000).toFixed(1), bx + kjW + 7, 20);

    g.textAlign = 'right';
    g.font = '600 13px system-ui, -apple-system, sans-serif';
    g.fillStyle = colour;
    g.fillText(Math.round(frac * 100) + '%  ' + stateLabel, right, 18);
    g.restore();

    // ── Casing ──────────────────────────────────────────────────────────────
    g.save();
    g.fillStyle = INK.surface2;
    roundRect(g, bx, by, bodyW, bodyH, 7);
    g.fill();
    g.strokeStyle = INK.axis;
    g.lineWidth = 2;
    roundRect(g, bx, by, bodyW, bodyH, 7);
    g.stroke();
    g.fillStyle = INK.axis;
    roundRect(g, bx + bodyW + 2, by + (bodyH - capH) / 2, capW, capH, 2);
    g.fill();
    g.restore();

    // Ten cells, filled proportionally. Discrete rather than a smooth bar: the
    // underlying W′ is an estimate, and a continuous fill invites reading a
    // precision that is not there. The partial cell fades instead of clipping.
    const cells = 10, gap = 3;
    const innerX = bx + 5, innerY = by + 5;
    const innerW = bodyW - 10, innerH = bodyH - 10;
    const cw = (innerW - gap * (cells - 1)) / cells;
    for (let i = 0; i < cells; i++) {
      const cellFrac = Math.max(0, Math.min(1, frac * cells - i));
      if (cellFrac <= 0) continue;
      g.save();
      g.globalAlpha = cellFrac >= 1 ? 1 : 0.3 + 0.5 * cellFrac;
      g.fillStyle = colour;
      roundRect(g, innerX + i * (cw + gap), innerY, cw, innerH, 2);
      g.fill();
      g.restore();
    }

    // The lowest point of the whole race, as a notch on the casing. Skipped when
    // it sits on the end stop, where the label has nowhere to go and the fact
    // that the race bottomed out is already obvious from the gauge.
    if (wp > 0) {
      const lowFrac = Math.max(0, Math.min(1, A.wbal.minBal / wp));
      if (lowFrac > 0.06 && lowFrac < 0.97) {
        const lx = innerX + lowFrac * innerW;
        g.save();
        g.strokeStyle = INK.muted;
        g.setLineDash([2, 2]);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(lx, by - 6); g.lineTo(lx, by + bodyH + 3); g.stroke();
        g.restore();
        label(g, 'race low', lx + (lowFrac > 0.6 ? -4 : 4), by - 10, INK.muted,
          lowFrac > 0.6 ? 'right' : 'left');
      }
    }

    // ── Rate ────────────────────────────────────────────────────────────────
    const watts = Math.abs(rate);
    let rateText, rateTone;
    if (rate < -1) { rateText = '▼ burning ' + Math.round(watts) + ' W over CP'; rateTone = '#e66767'; }
    else if (rate > 1) { rateText = '▲ recovering ' + Math.round(watts) + ' W'; rateTone = '#6da7ec'; }
    else { rateText = '— holding steady'; rateTone = INK.muted; }
    pair(by + bodyH + 16, rateText, rateTone,
      Math.round(P.watts[idx]) + ' W · CP ' + Math.round(A.cfg.cp), INK.muted,
      '12px system-ui, -apple-system, sans-serif');

    // ── Trailing history ────────────────────────────────────────────────────
    const sy = by + bodyH + 32;
    // Leave room under the baseline for the caption: the trace can sit anywhere
    // in the plot area, so there is no safe place to put text inside it.
    const sh = h - sy - 18;
    if (sh > 14) {
      const win = Math.round(120 / P.dt);
      const lo = Math.max(0, idx - win);
      const sw = right - bx;
      g.save();
      g.strokeStyle = INK.grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(bx, sy + sh); g.lineTo(bx + sw, sy + sh); g.stroke();

      g.beginPath();
      for (let k = lo; k <= idx; k++) {
        const x = bx + ((k - lo) / Math.max(1, idx - lo)) * sw;
        const y = sy + sh - (A.wbal.bal[k] / (wp || 1)) * sh;
        if (k === lo) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = colour;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();

      g.fillStyle = INK.muted;
      g.font = '10px system-ui, -apple-system, sans-serif';
      g.textBaseline = 'top';
      g.textAlign = 'left';
      g.fillText('last ' + Math.round(Math.min(120, (idx - lo) * P.dt)) + ' s', bx, sy + sh + 4);
      g.textAlign = 'right';
      g.fillText('now', bx + sw, sy + sh + 4);
      g.restore();
    }

    return { frac, state, rate, colour, label: stateLabel };
  }

  // ── Shared bits ───────────────────────────────────────────────────────────

  function roundRect(g, x, y, w, h, r, endOnly = false) {
    const rr = Math.min(r, h / 2, w);
    g.beginPath();
    if (endOnly) {
      // Square at the baseline, rounded at the data end — the mark spec for bars.
      g.moveTo(x, y);
      g.lineTo(x + w - rr, y);
      g.quadraticCurveTo(x + w, y, x + w, y + rr);
      g.lineTo(x + w, y + h - rr);
      g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      g.lineTo(x, y + h);
    } else {
      g.moveTo(x + rr, y);
      g.lineTo(x + w - rr, y);
      g.quadraticCurveTo(x + w, y, x + w, y + rr);
      g.lineTo(x + w, y + h - rr);
      g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
      g.lineTo(x + rr, y + h);
      g.quadraticCurveTo(x, y + h, x, y + h - rr);
      g.lineTo(x, y + rr);
      g.quadraticCurveTo(x, y, x + rr, y);
    }
    g.closePath();
  }

  function emptyState(g, w, h, msg) {
    g.save();
    g.fillStyle = INK.muted;
    g.font = '12px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(msg, w / 2, h / 2);
    g.restore();
  }

  function nearestIndex(xs, target, n) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(xs[lo - 1] - target) < Math.abs(xs[lo] - target)) lo--;
    return lo;
  }

  function shorten(s, max) {
    s = String(s);
    return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + '…';
  }

  function fmtClock(sec) {
    if (!isFinite(sec)) return '—';
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
             : m + ':' + String(ss).padStart(2, '0');
  }
  function fmt2(x) { return isFinite(x) ? x.toFixed(2) : '—'; }
  function fmtPct(x) { return isFinite(x) ? Math.round(x) + '%' : '—'; }

  return {
    SERIES, INK, DIVERGE,
    ratioColor, ratioLegendStops, ratioColorCentered, centredScale,
    setup, box, scale, ticks, line, label, onHover, ttRows, projector,
    timeline, ratioStrip, circuitMap, sectorHeatmap, wbalChart,
    turnBars, exposureRose, lapBars, compareBars, replayFrame,
    wbalBattery, drawBasemap, drawAttribution, BASEMAP,
    fmtClock, fmt2, fmtPct, esc, shorten,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Charts;
