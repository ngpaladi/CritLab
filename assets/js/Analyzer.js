'use strict';

/**
 * Analyzer.js — turns a prepared ride into a crit race report.
 *
 * Everything here assumes a *circuit*: the same corners, the same wind, over
 * and over. That repetition is what makes the analysis possible — a leak that
 * shows up once is noise, a leak that shows up on lap 3, 4, 5, 6 and 7 in the
 * same 200 metres of road is a positioning habit.
 */
const Analyzer = (() => {

  const R_EARTH = 6371000;

  // ── Entry point ───────────────────────────────────────────────────────────

  /**
   * @param {Object} P    prepared ride (see RideStore.prepare)
   * @param {Object} cfg  rider + model configuration
   * @returns {Object}    the full analysis
   */
  function run(P, cfg) {
    const wind = resolveWind(P, cfg);
    const rho = cfg.rho;

    // Solo-required power, second by second.
    const base = {
      mass: cfg.mass, crr: cfg.crr, cda: wind.cda, rho,
      driveEff: cfg.driveEff, rotMass: cfg.rotMass, yawK: cfg.yawK,
      we: wind.we, wn: wind.wn,
    };
    // Solo-required power is kept *unclamped* here. Braking legitimately makes
    // it negative, and zeroing those samples before smoothing would inflate the
    // window average — which in a crit, where every corner is a brake-and-
    // sprint, biases the whole draft ratio upward.
    const soloRaw = new Float64Array(P.n);
    const yaw = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      const w = Physics.windAt(P, base, i);
      base.we = w.we; base.wn = w.wn;
      const s = { v: P.v[i], theta: P.theta[i], a: P.accel[i], heading: P.heading[i] };
      soloRaw[i] = Physics.requiredPower(s, base);
      yaw[i] = Physics.apparentWind(P.v[i], P.heading[i], w.we, w.wn).yaw;
    }

    // Ratio is computed on smoothed series: a one-second power spike against a
    // one-second speed reading is mostly drivetrain lag and GPS jitter.
    const win = Math.max(1, Math.round(cfg.ratioWindow / P.dt));
    const wattsS = Physics.smooth(P.watts, win);
    const soloS = Physics.smooth(soloRaw, win);

    // The clamped copy is what gets plotted and what "kJ saved" is measured
    // against — you cannot save negative work by sitting on a wheel.
    const solo = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) solo[i] = Math.max(0, soloRaw[i]);

    const ratio = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      ratio[i] = soloS[i] > cfg.ratioFloor ? wattsS[i] / soloS[i] : NaN;
    }

    const wbal = Physics.wPrimeBalance(P.watts, cfg.cp, cfg.wPrime, P.dt);

    const laps = detectLaps(P, cfg);
    const meanLap = buildMeanLap(P, laps);
    const turns = detectTurns(P, laps, cfg, meanLap);
    annotateTurns(P, turns, ratio, cfg);
    const sectors = buildSectors(P, laps, turns, ratio, cfg);
    const lapRows = summariseLaps(P, laps, ratio, solo, wbal, cfg);
    const surges = detectSurges(P, ratio, wbal, laps, turns, cfg);
    const headings = exposureByHeading(P, ratio);
    const summary = summarise(P, ratio, solo, wbal, laps, surges, turns, cfg);
    const finale = summariseFinale(P, ratio, wbal, laps, surges, cfg);

    return {
      cfg, rho, wind, cda: wind.cda,
      solo, soloRaw, wattsS, soloS, ratio, yaw, wbal,
      laps: lapRows, lapBounds: laps, meanLap, turns, sectors, surges,
      headings, summary, finale,
    };
  }

  // ── Wind resolution ───────────────────────────────────────────────────────

  /**
   * Decide what wind and CdA to analyse with. Three sources, in decreasing
   * order of trustworthiness:
   *
   *   weather — a measured wind, so only CdA has to be inferred (1 unknown)
   *   manual  — the rider's own reading, same deal
   *   fit     — infer wind and CdA together from the power data (3 unknowns)
   */
  function resolveWind(P, cfg) {
    if (cfg.windSource === 'fit') {
      P.we = null; P.wn = null;
      const sol = Physics.solveWind(P, cfg, cfg.cleanAirPct);
      return {
        source: 'fit',
        we: sol.we, wn: sol.wn,
        speed: Math.hypot(sol.we, sol.wn),
        dirFrom: sol.dirFrom != null ? sol.dirFrom : 0,
        cda: cfg.lockCda ? cfg.cda : sol.cda,
        ok: sol.ok,
        confidence: sol.confidence || 'low',
        spread: sol.spread || 0,
        note: sol.reason || (sol.confidence === 'low'
          ? 'only ' + (sol.spread || 0) + ' of 8 compass sectors were ridden, so the ' +
            'inferred direction could be tens of degrees out'
          : null),
      };
    }

    // weather (per sample) or manual (constant). Either way the reported speed
    // is the one the model uses — at rider height, not the 10 m reference —
    // so the three sources are directly comparable.
    let speed, dirFrom, reported10m = null;
    let we = 0, wn = 0;

    if (cfg.windSource === 'weather' && P.we) {
      // P.we / P.wn were filled in by the caller from the hourly series and are
      // already scaled to rider height.
      let e = 0, n = 0;
      for (let i = 0; i < P.n; i++) { e += P.we[i]; n += P.wn[i]; }
      e /= P.n; n /= P.n;
      speed = Math.hypot(e, n);
      dirFrom = speed < 1e-6 ? 0 : ((Math.atan2(-e, -n) * 180 / Math.PI) + 360) % 360;
    } else {
      P.we = null; P.wn = null;
      // A manually entered wind is a 10 m reading too — the number you'd get
      // from a forecast — so it needs the same profile correction the weather
      // path gets, or the manual mode would silently model twice the wind.
      reported10m = cfg.windSpeed;
      const vec = Weather.windVector(cfg.windSpeed, cfg.windDir, cfg.roughness);
      we = vec[0]; wn = vec[1];
      speed = Math.hypot(we, wn);
      dirFrom = cfg.windDir;
    }

    const c = { ...cfg, we, wn };
    const cohort = Physics.cleanAirCohort(P, c);
    const sol = cfg.lockCda ? { cda: cfg.cda, ok: true } : Physics.solveCdA(P, c, cohort, cfg.cleanAirPct);

    return {
      source: cfg.windSource,
      we: c.we, wn: c.wn,
      speed, dirFrom, reported10m,
      cda: sol.cda,
      ok: sol.ok !== false,
      note: sol.clamped ? 'CdA hit its ' + sol.clamped + ' bound — check mass and speed data' : null,
      cohortSize: cohort.length,
    };
  }

  // ── Laps ──────────────────────────────────────────────────────────────────

  /**
   * Find circuit laps. Head-unit lap markers are used when they look like a
   * circuit; otherwise laps come from repeated passes of a start anchor,
   * gated on heading so an out-and-back section does not fire a false lap.
   *
   * @returns {Array<{i0:number, i1:number, source:string}>}
   */
  function detectLaps(P, cfg) {
    const whole = [{ i0: 0, i1: P.n - 1, source: 'none' }];

    const fromDevice = lapsFromMarkers(P);
    if (fromDevice) return fromDevice;
    if (!P.lat) return whole;

    const anchorIdx = pickAnchor(P);
    if (anchorIdx < 0) return whole;

    const la0 = P.lat[anchorIdx], lo0 = P.lon[anchorIdx], h0 = P.heading[anchorIdx];
    const mLat = 111320;
    const mLon = 111320 * Math.cos(la0 * Math.PI / 180);

    const radius = cfg.lapRadius || 30;
    const near = new Uint8Array(P.n);
    const dist2 = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      if (!P.lat[i] && !P.lon[i]) { dist2[i] = Infinity; continue; }
      const dx = (P.lon[i] - lo0) * mLon, dy = (P.lat[i] - la0) * mLat;
      const d = Math.hypot(dx, dy);
      dist2[i] = d;
      near[i] = (d < radius && angleDiff(P.heading[i], h0) < 1.22) ? 1 : 0;  // within 70°
    }

    // One crossing per contiguous near-run: the closest approach.
    const crossings = [];
    let i = 0;
    while (i < P.n) {
      if (!near[i]) { i++; continue; }
      let j = i, bestK = i, bestD = dist2[i];
      while (j < P.n && near[j]) { if (dist2[j] < bestD) { bestD = dist2[j]; bestK = j; } j++; }
      crossings.push(bestK);
      i = j;
    }

    // Drop crossings too close together to be a real lap.
    const minLap = cfg.minLapMetres || 400;
    const kept = [];
    for (const k of crossings) {
      if (!kept.length || P.dist[k] - P.dist[kept[kept.length - 1]] > minLap) kept.push(k);
    }
    if (kept.length < 3) return whole;

    const laps = [];
    for (let k = 0; k < kept.length - 1; k++) {
      laps.push({ i0: kept[k], i1: kept[k + 1], source: 'gps' });
    }

    // A crit's laps are near-identical in length. If they are not, the anchor
    // is firing on something that is not a start/finish line.
    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const med = median(lens);
    if (!(med > 0)) return whole;
    const cv = Math.sqrt(Physics.mean(lens.map(x => (x - med) * (x - med)))) / med;
    if (cv > 0.22) return whole;

    // Trim laps that are wildly off the median (neutral roll-out, cool-down).
    const good = laps.filter(l => {
      const d = P.dist[l.i1] - P.dist[l.i0];
      return d > 0.7 * med && d < 1.4 * med;
    });
    return good.length >= 2 ? good : whole;
  }

  function lapsFromMarkers(P) {
    const marks = P.lapIndices;
    if (!marks || marks.length < 4) return null;
    const laps = [];
    for (let k = 0; k < marks.length - 1; k++) {
      if (marks[k + 1] - marks[k] > 20) laps.push({ i0: marks[k], i1: marks[k + 1], source: 'device' });
    }
    if (laps.length < 3) return null;
    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const med = median(lens);
    if (!(med > 300)) return null;
    const cv = Math.sqrt(Physics.mean(lens.map(x => (x - med) * (x - med)))) / med;
    if (cv > 0.15) return null;         // not a circuit — probably interval laps
    return laps.filter(l => {
      const d = P.dist[l.i1] - P.dist[l.i0];
      return d > 0.75 * med && d < 1.35 * med;
    });
  }

  /** A start anchor on a fast, straight, moving stretch early in the ride. */
  function pickAnchor(P) {
    const from = Math.floor(P.n * 0.08);
    let best = -1, bestScore = -Infinity;
    for (let i = from; i < Math.floor(P.n * 0.45); i++) {
      if (!P.moving[i] || (P.gap && P.gap[i])) continue;
      if (!P.lat[i] && !P.lon[i]) continue;
      const straight = 1 - Math.min(1, Math.abs(P.curvature ? P.curvature[i] : 0) * 40);
      const score = P.v[i] * straight;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  /**
   * Corner detection.
   *
   * The naive approach — threshold the per-sample curvature of the raw GPS
   * track — fights physics it cannot win. At 43 km/h a 1 Hz recorder puts a
   * sample every 12 metres, so a 16 m crit corner is two or three points, and
   * the heading noise between them is comparable to the turn itself. That is
   * why the first version of this reported ~31 m radii for corners that were
   * actually 16 m, and missed a pass here and there.
   *
   * But a crit is the same corner twenty times over. Stacking every lap onto a
   * common lap-distance grid and taking the *median* line cuts positional noise
   * by roughly √n while preserving the racing line, and the corner can then be
   * measured on a clean 2 m grid instead of a ragged 12 m one. Corners are
   * found once, on that mean lap, and each lap contributes one instance by
   * construction rather than by hoping the threshold fires again.
   */
  function detectTurns(P, laps, cfg, meanLap) {
    if (!P.lat) return [];
    const mean = meanLap !== undefined ? meanLap : buildMeanLap(P, laps);
    if (mean) {
      const turns = turnsFromMeanLap(P, laps, mean, cfg);
      if (turns.length) return turns;
    }
    return turnsFromTrack(P, laps, cfg);
  }

  /**
   * Resample every lap onto a shared lap-distance grid and take the median
   * across laps at each point.
   *
   * Median rather than mean: it is robust to the one lap where you took a wide
   * line to come past somebody, and to the GPS excursion under the finish-line
   * gantry.
   *
   * @returns {{n, step, lapLen, laps, s, lat, lon, x, y, v, watts, heading,
   *            curvature}|null}
   */
  function buildMeanLap(P, laps) {
    if (!laps || laps.length < 3 || laps[0].source === 'none') return null;

    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const lapLen = median(lens);
    if (!(lapLen > 150)) return null;

    const step = 2;                                   // metres between grid points
    const m = Math.max(48, Math.min(4000, Math.round(lapLen / step)));

    const cols = { lat: [], lon: [], v: [], watts: [] };
    for (let j = 0; j < m; j++) { cols.lat.push([]); cols.lon.push([]); cols.v.push([]); cols.watts.push([]); }

    for (const lap of laps) {
      const d0 = P.dist[lap.i0];
      const len = P.dist[lap.i1] - d0;
      if (!(len > 0)) continue;
      let i = lap.i0;
      for (let j = 0; j < m; j++) {
        // Match by fraction of the lap, so laps of slightly different measured
        // length still line up corner-for-corner.
        const target = d0 + (j / m) * len;
        while (i < lap.i1 && P.dist[i + 1] < target) i++;
        const a = i, b = Math.min(lap.i1, i + 1);
        const span = P.dist[b] - P.dist[a];
        const f = span > 1e-9 ? (target - P.dist[a]) / span : 0;
        if (!P.lat[a] && !P.lat[b]) continue;
        cols.lat[j].push(P.lat[a] + (P.lat[b] - P.lat[a]) * f);
        cols.lon[j].push(P.lon[a] + (P.lon[b] - P.lon[a]) * f);
        cols.v[j].push(P.v[a] + (P.v[b] - P.v[a]) * f);
        cols.watts[j].push(P.watts[a] + (P.watts[b] - P.watts[a]) * f);
      }
    }

    const lat = new Float64Array(m), lon = new Float64Array(m);
    const v = new Float64Array(m), watts = new Float64Array(m), s = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      if (cols.lat[j].length < 3) return null;        // too sparse to trust
      lat[j] = median(cols.lat[j]);
      lon[j] = median(cols.lon[j]);
      v[j] = median(cols.v[j]);
      watts[j] = median(cols.watts[j]);
      s[j] = (j / m) * lapLen;
    }

    // Local planar coordinates in metres, so geometry is Euclidean.
    const lat0 = lat[0], mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
    const x = new Float64Array(m), y = new Float64Array(m);
    for (let j = 0; j < m; j++) { x[j] = (lon[j] - lon[0]) * mLon; y[j] = (lat[j] - lat0) * mLat; }

    // Heading and curvature over a fixed metre window, wrapping round the lap.
    const half = Math.max(1, Math.round(5 / step));    // ±5 m
    const heading = new Float64Array(m), curvature = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const a = (j - half + m) % m, b = (j + half) % m;
      heading[j] = Math.atan2(x[b] - x[a], y[b] - y[a]);
    }
    for (let j = 0; j < m; j++) {
      const a = (j - half + m) % m, b = (j + half) % m;
      const ds = 2 * half * step;
      curvature[j] = angleDelta(heading[a], heading[b]) / ds;
    }

    return {
      n: m, step, lapLen, laps: laps.length,
      s, lat, lon, x, y, v, watts,
      heading, curvature: circularSmooth(curvature, 3),
    };
  }

  /** Moving average that wraps, for series defined on a closed circuit. */
  function circularSmooth(a, w) {
    const n = a.length, out = new Float64Array(n), half = Math.floor(w / 2);
    for (let i = 0; i < n; i++) {
      let sum = 0, k = 0;
      for (let d = -half; d <= half; d++) { sum += a[(i + d + n) % n]; k++; }
      out[i] = sum / k;
    }
    return out;
  }

  /**
   * Least-squares circle through a set of planar points (Kåsa's algebraic fit).
   * Gives a far better radius than arc-length ÷ turn-angle, which is thrown off
   * by where exactly the corner is judged to start and stop.
   */
  function fitCircle(xs, ys) {
    const n = xs.length;
    if (n < 4) return { radius: NaN, cx: NaN, cy: NaN };
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;

    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (let i = 0; i < n; i++) {
      const u = xs[i] - mx, v = ys[i] - my;
      suu += u * u; svv += v * v; suv += u * v;
      suuu += u * u * u; svvv += v * v * v;
      suvv += u * v * v; svuu += v * u * u;
    }
    const det = 2 * (suu * svv - suv * suv);
    if (Math.abs(det) < 1e-9) return { radius: NaN, cx: NaN, cy: NaN };
    const c1 = suuu + suvv, c2 = svvv + svuu;
    const uc = (svv * c1 - suv * c2) / det;
    const vc = (suu * c2 - suv * c1) / det;
    const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
    return { radius, cx: uc + mx, cy: vc + my };
  }

  /** Corners found on the clean mean lap, then instantiated per lap. */
  function turnsFromMeanLap(P, laps, mean, cfg) {
    const m = mean.n, step = mean.step;
    const kIn = 1 / (cfg.cornerRadius || 45);
    const kOut = 1 / ((cfg.cornerRadius || 45) * 1.7);
    const minTurn = (cfg.minCornerDeg || 30) * Math.PI / 180;

    // Seed from every point over the entry threshold, then grow each seed out
    // to the shoulder threshold. Wrapping matters: a start/finish line often
    // sits mid-corner-exit.
    const used = new Uint8Array(m);
    const regions = [];
    for (let j = 0; j < m; j++) {
      if (used[j] || Math.abs(mean.curvature[j]) < kIn) continue;
      const sign = Math.sign(mean.curvature[j]);
      let a = j, b = j, guard = 0;
      while (guard++ < m) {
        const prev = (a - 1 + m) % m;
        if (Math.abs(mean.curvature[prev]) > kOut && Math.sign(mean.curvature[prev]) === sign && !used[prev]) a = prev;
        else break;
      }
      guard = 0;
      while (guard++ < m) {
        const next = (b + 1) % m;
        if (Math.abs(mean.curvature[next]) > kOut && Math.sign(mean.curvature[next]) === sign && !used[next]) b = next;
        else break;
      }
      const idx = [];
      for (let k = a; ; k = (k + 1) % m) { idx.push(k); used[k] = 1; if (k === b) break; if (idx.length > m) break; }
      const turned = Math.abs(angleDelta(mean.heading[a], mean.heading[b]));
      if (turned >= minTurn && idx.length * step >= 4) regions.push({ a, b, idx, sign, turned });
    }
    if (!regions.length) return [];

    regions.sort((p, q) => p.a - q.a);

    const turns = regions.map(r => {
      const xs = r.idx.map(k => mean.x[k]);
      const ys = r.idx.map(k => mean.y[k]);
      const circle = fitCircle(xs, ys);

      // Apex = slowest point on the mean speed profile, searched a little wider
      // than the geometric corner because riders brake late and apex late.
      const pad = Math.round(8 / step);
      let apexK = r.idx[0], vmin = Infinity;
      for (let d = -pad; d < r.idx.length + pad; d++) {
        const k = (r.a + d + m * 2) % m;
        if (mean.v[k] < vmin) { vmin = mean.v[k]; apexK = k; }
      }

      const lengthM = r.idx.length * step;
      const turnedDeg = r.turned * 180 / Math.PI;
      return {
        idx: r.idx,
        entryS: mean.s[r.a],
        exitS: mean.s[r.b],
        apexS: mean.s[apexK],
        apexK,
        lat: mean.lat[apexK],
        lon: mean.lon[apexK],
        lapOffset: mean.s[apexK] / mean.lapLen,
        turned: turnedDeg,
        dir: r.sign > 0 ? 'right' : 'left',
        radius: isFinite(circle.radius) && circle.radius < 400 ? circle.radius : lengthM / r.turned,
        lengthM,
        type: classifyTurn(turnedDeg),
        meanApexV: mean.v[apexK],
        source: 'mean-lap',
      };
    });

    turns.sort((a, b) => a.lapOffset - b.lapOffset);
    turns.forEach((t, k) => { t.number = k + 1; t.name = 'Turn ' + (k + 1); });

    // One instance per lap, located by lap fraction rather than by re-detecting.
    for (const t of turns) {
      t.events = [];
      const fEntry = t.entryS / mean.lapLen;
      const fExit = t.exitS / mean.lapLen;
      const fApex = t.apexS / mean.lapLen;
      for (const lap of laps) {
        const ev = instanceAt(P, lap, fEntry, fExit, fApex);
        if (ev) { ev.turned = t.turned; ev.dir = t.dir; t.events.push(ev); }
      }
    }
    return turns.filter(t => t.events.length >= 2);
  }

  function classifyTurn(deg) {
    if (deg >= 140) return 'hairpin';
    if (deg >= 60) return 'square';
    if (deg >= 35) return 'sweeper';
    return 'kink';
  }

  /** Locate one pass of a corner inside a single lap, by lap fraction. */
  function instanceAt(P, lap, fEntry, fExit, fApex) {
    const d0 = P.dist[lap.i0];
    const len = P.dist[lap.i1] - d0;
    if (!(len > 0)) return null;

    const at = f => {
      const target = d0 + ((f % 1) + 1) % 1 * len;
      let lo = lap.i0, hi = lap.i1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (P.dist[mid] < target) lo = mid + 1; else hi = mid;
      }
      return Math.max(lap.i0, Math.min(lap.i1, lo));
    };

    let i0 = at(fEntry), i1 = at(fExit);
    if (i1 < i0) i1 = Math.min(lap.i1, i0 + 2);       // corner straddles the line
    // Apex: slowest sample in a small window about the expected position.
    const centre = at(fApex);
    const pad = 3;
    let apex = centre, vmin = Infinity;
    for (let k = Math.max(lap.i0, centre - pad); k <= Math.min(lap.i1, centre + pad); k++) {
      if (P.v[k] < vmin) { vmin = P.v[k]; apex = k; }
    }
    return { i0, i1, apex, lap };
  }

  /**
   * Fallback for rides with GPS but no usable laps: detect corners directly on
   * the raw track. Noisier, and the radii should not be taken too seriously.
   */
  function turnsFromTrack(P, laps, cfg) {
    if (!P.curvature) return [];
    const kIn = 1 / (cfg.cornerRadius || 45);
    const kOut = 1 / ((cfg.cornerRadius || 45) * 1.8);
    const minTurnRad = (cfg.minCornerDeg || 30) * Math.PI / 180;

    const events = [];
    let i = 1;
    while (i < P.n - 1) {
      if (Math.abs(P.curvature[i]) < kIn || !P.moving[i]) { i++; continue; }
      const sign = Math.sign(P.curvature[i]);
      let a = i, b = i;
      while (a > 0 && Math.abs(P.curvature[a - 1]) > kOut && Math.sign(P.curvature[a - 1]) === sign) a--;
      while (b < P.n - 1 && Math.abs(P.curvature[b + 1]) > kOut && Math.sign(P.curvature[b + 1]) === sign) b++;

      const turned = Math.abs(angleDelta(P.heading[a], P.heading[b]));
      if (turned >= minTurnRad && P.dist[b] - P.dist[a] > 4) {
        let apex = a, vmin = Infinity;
        for (let k = Math.max(0, a - 2); k <= Math.min(P.n - 1, b + 2); k++) {
          if (P.v[k] < vmin) { vmin = P.v[k]; apex = k; }
        }
        events.push({ i0: a, i1: b, apex, turned: turned * 180 / Math.PI, dir: sign > 0 ? 'right' : 'left' });
      }
      i = b + 1;
    }
    if (!events.length) return [];

    // Cluster by position — the same corner on every lap.
    const mLat = 111320;
    const mLon = 111320 * Math.cos((P.lat[events[0].apex] || 0) * Math.PI / 180);
    const clusters = [];
    for (const ev of events) {
      const la = P.lat[ev.apex], lo = P.lon[ev.apex];
      let hit = null;
      for (const c of clusters) {
        if (Math.hypot((lo - c.lon) * mLon, (la - c.lat) * mLat) < (cfg.turnClusterM || 35)) { hit = c; break; }
      }
      if (hit) {
        hit.events.push(ev);
        hit.lat = (hit.lat * (hit.events.length - 1) + la) / hit.events.length;
        hit.lon = (hit.lon * (hit.events.length - 1) + lo) / hit.events.length;
      } else {
        clusters.push({ lat: la, lon: lo, events: [ev] });
      }
    }

    const minPasses = Math.max(2, Math.floor(laps.length * 0.5));
    const real = clusters.filter(c => c.events.length >= Math.min(minPasses, 2));
    if (!real.length) return [];

    const lapLen = laps.length ? median(laps.map(l => P.dist[l.i1] - P.dist[l.i0])) : 0;
    for (const c of real) {
      const ev = c.events[0];
      const lap = laps.find(l => ev.apex >= l.i0 && ev.apex <= l.i1);
      c.lapOffset = lap && lapLen > 0 ? (P.dist[ev.apex] - P.dist[lap.i0]) / lapLen : P.dist[ev.apex];
      c.source = 'track';
    }
    real.sort((a, b) => a.lapOffset - b.lapOffset);
    real.forEach((c, k) => { c.number = k + 1; c.name = 'Turn ' + (k + 1); });
    return real;
  }

  /** Per-pass cost of each corner: speed lost, and what it took to get it back. */
  function annotateTurns(P, turns, ratio, cfg) {
    const backS = Math.round(8 / P.dt);
    const maxRecover = Math.round(30 / P.dt);

    for (const turn of turns) {
      for (const ev of turn.events) {
        const apex = ev.apex;

        let entry = 0;
        for (let k = Math.max(0, apex - backS); k < apex; k++) entry = Math.max(entry, P.v[k]);
        const apexV = P.v[apex];

        // Recovery: back to within 3% of entry speed.
        let rec = -1;
        const target = entry * 0.97;
        for (let k = apex + 1; k <= Math.min(P.n - 1, apex + maxRecover); k++) {
          if (P.v[k] >= target) { rec = k; break; }
        }
        const recEnd = rec < 0 ? Math.min(P.n - 1, apex + maxRecover) : rec;

        // Cost of the exit: work above CP between apex and recovery.
        let above = 0, peak = 0;
        for (let k = apex; k <= recEnd; k++) {
          above += Math.max(0, P.watts[k] - cfg.cp) * P.dt;
          peak = Math.max(peak, P.watts[k]);
        }

        ev.entryV = entry;
        ev.apexV = apexV;
        ev.lossV = entry - apexV;
        ev.recoverS = rec < 0 ? null : (rec - apex) * P.dt;
        ev.exitKj = above / 1000;
        ev.exitPeak = peak;
        ev.ratioIn = meanFinite(ratio, Math.max(0, apex - backS), apex);
        ev.ratioOut = meanFinite(ratio, apex, recEnd);
        ev.radius = ev.turned > 0 ? (P.dist[ev.i1] - P.dist[ev.i0]) / (ev.turned * Math.PI / 180) : null;
      }

      const evs = turn.events;
      turn.passes = evs.length;
      // Geometry measured on the mean lap is strictly better than a median of
      // per-lap estimates from a 12-metre sample spacing, so keep it when it is
      // there and only fall back to per-pass figures for the raw-track path.
      if (turn.source !== 'mean-lap') {
        turn.turned = median(evs.map(e => e.turned));
        turn.dir = evs[0].dir;
        turn.radius = median(evs.map(e => e.radius).filter(isFinite));
        turn.type = classifyTurn(turn.turned);
      }
      turn.entryV = Physics.mean(evs.map(e => e.entryV));
      turn.apexV = Physics.mean(evs.map(e => e.apexV));
      turn.lossV = Physics.mean(evs.map(e => e.lossV));
      turn.exitKj = Physics.mean(evs.map(e => e.exitKj));
      turn.exitKjTotal = evs.reduce((s, e) => s + e.exitKj, 0);
      turn.exitPeak = Physics.mean(evs.map(e => e.exitPeak));
      const recs = evs.map(e => e.recoverS).filter(x => x != null);
      turn.recoverS = recs.length ? Physics.mean(recs) : null;
      turn.ratioOut = Physics.mean(evs.map(e => e.ratioOut).filter(isFinite));
      // Spread across laps: a corner you take inconsistently is one you are
      // arriving at in a different position each time.
      turn.lossSd = stdev(evs.map(e => e.lossV));
    }
    return turns;
  }

  // ── Sectors ───────────────────────────────────────────────────────────────

  /**
   * A lap × sector grid of draft ratio. Sector boundaries are the corners when
   * we found some, otherwise equal slices of lap distance. This is the view
   * that exposes a repeated positioning leak.
   */
  function buildSectors(P, laps, turns, ratio, cfg) {
    if (laps.length < 2 || laps[0].source === 'none') return null;

    const lapLen = median(laps.map(l => P.dist[l.i1] - P.dist[l.i0]));
    if (!(lapLen > 0)) return null;

    let bounds, labels;
    if (turns.length >= 3) {
      bounds = turns.map(t => clamp01(t.lapOffset));
      bounds.sort((a, b) => a - b);
      labels = bounds.map((_, k) => 'T' + (k + 1) + '→T' + ((k + 1) % bounds.length + 1));
    } else {
      const k = cfg.sectorCount || 8;
      bounds = Array.from({ length: k }, (_, j) => j / k);
      labels = bounds.map((b, j) => Math.round(b * 100) + '–' + Math.round((j + 1 === k ? 1 : bounds[j + 1]) * 100) + '%');
    }

    const nSec = bounds.length;
    const grid = [];
    for (const lap of laps) {
      const row = { lap: laps.indexOf(lap) + 1, cells: [] };
      const acc = Array.from({ length: nSec }, () => ({ sum: 0, k: 0, w: 0, sec: 0 }));
      for (let i = lap.i0; i <= lap.i1; i++) {
        if (!P.moving[i]) continue;
        const f = clamp01((P.dist[i] - P.dist[lap.i0]) / lapLen);
        let s = nSec - 1;
        for (let j = 0; j < nSec; j++) {
          const hi = j + 1 < nSec ? bounds[j + 1] : 1.0001;
          if (f >= bounds[j] && f < hi) { s = j; break; }
        }
        if (f < bounds[0]) s = nSec - 1;   // before the first turn = last sector
        const a = acc[s];
        a.sec += P.dt;
        a.w += P.watts[i];
        if (isFinite(ratio[i])) { a.sum += ratio[i]; a.k++; }
      }
      row.cells = acc.map((a, j) => ({
        sector: j,
        label: labels[j],
        ratio: a.k ? a.sum / a.k : NaN,
        watts: a.sec > 0 ? a.w / (a.sec / P.dt) : NaN,
        seconds: a.sec,
      }));
      grid.push(row);
    }

    // Per-lap median across sectors, so a sector can be judged against the rest
    // of its own lap rather than an absolute threshold. Absolute exposure moves
    // with the CdA calibration; "this stretch was worse than the rest of the
    // lap, again" does not.
    const lapMedians = grid.map(r => {
      const v = r.cells.map(c => c.ratio).filter(isFinite).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : NaN;
    });

    // Which sector was the least sheltered one on each individual lap. Rank is
    // the sharpest repeated-leak signal available: it needs no threshold and no
    // faith in the CdA calibration, only that one stretch keeps coming out on
    // top of its own lap.
    const worstOfLap = grid.map(r => {
      let best = -1, bestV = -Infinity;
      r.cells.forEach((c, j) => { if (isFinite(c.ratio) && c.ratio > bestV) { bestV = c.ratio; best = j; } });
      return best;
    });

    const totals = labels.map((label, j) => {
      const vals = grid.map(r => r.cells[j].ratio).filter(isFinite);
      const secs = grid.reduce((s, r) => s + r.cells[j].seconds, 0);
      let lapsWorse = 0, lapsWorst = 0;
      grid.forEach((r, k) => {
        const c = r.cells[j].ratio;
        if (isFinite(c) && isFinite(lapMedians[k]) && c > lapMedians[k] + 0.02) lapsWorse++;
        if (worstOfLap[k] === j) lapsWorst++;
      });
      return {
        sector: j, label,
        // Median across laps, not mean: one attack up the inside of a sector
        // should not rebrand the whole stretch as a positioning problem.
        ratio: vals.length ? median(vals) : NaN,
        mean: vals.length ? Physics.mean(vals) : NaN,
        sd: stdev(vals),
        seconds: secs,
        laps: vals.length,
        lapsWorse,
        lapsWorst,
        worseShare: vals.length ? lapsWorse / vals.length : 0,
        worstShare: vals.length ? lapsWorst / vals.length : 0,
      };
    });

    // The leak is the sector that keeps coming out worst, not the one with the
    // highest average. Those differ: a short corner-to-corner sector carries a
    // high average simply because it is mostly acceleration, while a genuine
    // positioning leak shows up as the same stretch topping lap after lap.
    const usable = totals.filter(t => isFinite(t.ratio) && t.laps >= 2);
    const leak = usable.length
      ? usable.slice().sort((a, b) => (b.lapsWorst - a.lapsWorst) || (b.ratio - a.ratio))[0]
      : null;
    const dearest = usable.length ? usable.slice().sort((a, b) => b.ratio - a.ratio)[0] : null;
    const cheapest = usable.length ? usable.slice().sort((a, b) => a.ratio - b.ratio)[0] : null;

    return { bounds, labels, grid, totals, lapMedians, worstOfLap, leak, dearest, cheapest, lapLen };
  }

  // ── Surges ────────────────────────────────────────────────────────────────

  /**
   * Efforts that cost real matches: sustained power well above CP. Each one is
   * tagged with where it happened and — the part that matters tactically —
   * whether it was launched from shelter or from the wind.
   */
  function detectSurges(P, ratio, wbal, laps, turns, cfg) {
    const thresh = cfg.cp * (cfg.surgeFactor || 1.4);
    const w3 = Physics.smooth(P.watts, Math.max(1, Math.round(3 / P.dt)));
    const minLen = Math.max(2, Math.round((cfg.minSurgeSeconds || 4) / P.dt));
    const gapLen = Math.max(1, Math.round(3 / P.dt));

    const regions = [];
    let i = 0;
    while (i < P.n) {
      if (w3[i] <= thresh || !P.moving[i]) { i++; continue; }
      let j = i;
      while (j < P.n && w3[j] > thresh) j++;
      if (j - i >= minLen) {
        const last = regions[regions.length - 1];
        if (last && i - last.i1 <= gapLen) last.i1 = j - 1;   // merge near-adjacent kicks
        else regions.push({ i0: i, i1: j - 1 });
      }
      i = j;
    }

    // A crit sits above any fixed watts threshold constantly; what makes an
    // effort a *match* is that it took a real bite out of W′. Anything cheaper
    // than `minMatchKj` is just the rhythm of the race, not a burnt match.
    const minKj = cfg.minMatchKj != null ? cfg.minMatchKj : 1.0;

    // Apexes, so an effort can be recognised as "getting back up to speed out
    // of turn 3" rather than "attacking". Both cost W′, but only one of them is
    // a tactical decision — and the Corners tab already prices the other.
    const apexes = [];
    for (const t of turns) for (const ev of t.events) apexes.push(ev.apex);
    apexes.sort((a, b) => a - b);
    const exitWindow = Math.round(7 / P.dt);
    const preWindow = Math.round(2 / P.dt);
    const isCornerExit = i0 => apexes.some(a => i0 >= a - preWindow && i0 <= a + exitWindow);

    const backS = Math.round(10 / P.dt);
    return regions.map((r, k) => {
      let sum = 0, peak = 0, above = 0;
      for (let x = r.i0; x <= r.i1; x++) {
        sum += P.watts[x];
        peak = Math.max(peak, P.watts[x]);
        above += Math.max(0, P.watts[x] - cfg.cp) * P.dt;
      }
      const nS = r.i1 - r.i0 + 1;
      const before = meanFinite(ratio, Math.max(0, r.i0 - backS), r.i0);
      const lapIdx = laps.findIndex(l => r.i0 >= l.i0 && r.i0 <= l.i1);
      const turn = nearestTurn(P, turns, r.i0);

      return {
        i0: r.i0, i1: r.i1,
        t0: P.t[r.i0],
        seconds: nS * P.dt,
        avg: sum / nS,
        peak,
        matchKj: above / 1000,
        km: P.dist[r.i0] / 1000,
        lap: lapIdx >= 0 ? lapIdx + 1 : null,
        ratio: meanFinite(ratio, r.i0, r.i1),
        ratioBefore: before,
        fromShelter: isFinite(before) && before < 0.88,
        wbalDrop: (wbal.bal[r.i0] - wbal.bal[Math.min(P.n - 1, r.i1)]) / 1000,
        wbalAfter: wbal.bal[Math.min(P.n - 1, r.i1)] / 1000,
        nearTurn: turn ? turn.name : null,
        turnDistance: turn ? turn.distance : null,
        cornerExit: isCornerExit(r.i0),
      };
    })
      .filter(s => s.matchKj >= minKj)
      .map((s, k) => { s.index = k + 1; return s; });
  }

  function nearestTurn(P, turns, i) {
    if (!turns.length || !P.lat) return null;
    const la = P.lat[i], lo = P.lon[i];
    if (la == null) return null;
    const mLat = 111320, mLon = 111320 * Math.cos(la * Math.PI / 180);
    let best = null, bestD = Infinity;
    for (const t of turns) {
      const d = Math.hypot((lo - t.lon) * mLon, (la - t.lat) * mLat);
      if (d < bestD) { bestD = d; best = t; }
    }
    return bestD < 150 ? { name: best.name, distance: bestD } : null;
  }

  // ── Aggregates ────────────────────────────────────────────────────────────

  function summariseLaps(P, laps, ratio, solo, wbal, cfg) {
    if (laps[0] && laps[0].source === 'none') return [];
    return laps.map((lap, k) => {
      const w = [];
      let secs = 0, exposed = 0, sheltered = 0, counted = 0;
      let vmax = 0, saved = 0;
      const rs = [];
      for (let i = lap.i0; i <= lap.i1; i++) {
        if (!P.moving[i]) continue;
        secs += P.dt;
        w.push(P.watts[i]);
        vmax = Math.max(vmax, P.v[i]);
        saved += Math.max(0, solo[i] - P.watts[i]) * P.dt;
        if (isFinite(ratio[i])) {
          counted++;
          rs.push(ratio[i]);
          if (ratio[i] >= cfg.exposedAt) exposed++;
          if (ratio[i] <= cfg.shelteredAt) sheltered++;
        }
      }
      if (!w.length) return null;
      rs.sort((a, b) => a - b);
      const m = Physics.loadMetrics(w, cfg.ftp, P.dt);
      return {
        lap: k + 1,
        seconds: secs,
        distance: P.dist[lap.i1] - P.dist[lap.i0],
        avg: m.avg,
        np: m.np,
        vi: m.variability,
        kj: m.kj,
        maxSpeed: vmax,
        avgSpeed: secs > 0 ? (P.dist[lap.i1] - P.dist[lap.i0]) / secs : 0,
        exposed: counted ? (100 * exposed) / counted : NaN,
        sheltered: counted ? (100 * sheltered) / counted : NaN,
        median: rs.length ? Physics.percentile(rs, 0.5) : NaN,
        savedKj: saved / 1000,
        wbalEnd: wbal.bal[lap.i1] / 1000,
      };
    }).filter(Boolean);
  }

  function exposureByHeading(P, ratio) {
    const bins = Array.from({ length: 16 }, (_, k) => ({
      bin: k,
      dir: k * 22.5,
      label: Weather.compass(k * 22.5),
      seconds: 0,
      vals: [],
    }));
    for (let i = 0; i < P.n; i++) {
      if (!P.moving[i] || !isFinite(ratio[i])) continue;
      const deg = (((P.heading[i] * 180 / Math.PI) % 360) + 360) % 360;
      const b = Math.round(deg / 22.5) % 16;
      bins[b].seconds += P.dt;
      bins[b].vals.push(ratio[i]);
    }
    for (const b of bins) {
      b.vals.sort((x, y) => x - y);
      b.ratio = b.vals.length ? Physics.percentile(b.vals, 0.5) : NaN;
      b.p85 = b.vals.length ? Physics.percentile(b.vals, 0.85) : NaN;
      delete b.vals;
    }
    return bins;
  }

  function summarise(P, ratio, solo, wbal, laps, surges, turns, cfg) {
    const w = [];
    let secs = 0, exposed = 0, sheltered = 0, counted = 0, saved = 0, soloKj = 0;
    const rs = [];
    for (let i = 0; i < P.n; i++) {
      if (!P.moving[i]) continue;
      secs += P.dt;
      w.push(P.watts[i]);
      saved += Math.max(0, solo[i] - P.watts[i]) * P.dt;
      soloKj += solo[i] * P.dt;
      if (isFinite(ratio[i])) {
        counted++;
        rs.push(ratio[i]);
        if (ratio[i] >= cfg.exposedAt) exposed++;
        if (ratio[i] <= cfg.shelteredAt) sheltered++;
      }
    }
    rs.sort((a, b) => a - b);
    const m = Physics.loadMetrics(w, cfg.ftp, P.dt);

    // Loop rather than Math.max(...P.v): spreading a long ride's samples as
    // arguments blows the call stack somewhere north of 60k of them.
    let vMax = 0;
    for (let i = 0; i < P.n; i++) if (P.v[i] > vMax) vMax = P.v[i];

    const cornerKj = turns.reduce((s, t) => s + t.exitKjTotal, 0);
    // "Matches" excludes corner-exit accelerations — those are the price of the
    // circuit, not of a tactical decision, and they are priced on the Corners tab.
    const matches = surges.filter(x => !x.cornerExit);
    const matchKj = matches.reduce((s, x) => s + x.matchKj, 0);

    return {
      movingSeconds: secs,
      distance: P.dist[P.n - 1] - P.dist[0],
      avgSpeed: secs > 0 ? (P.dist[P.n - 1] - P.dist[0]) / secs : 0,
      maxSpeed: vMax,
      avg: m.avg, np: m.np, vi: m.variability, tss: m.tss,
      intensity: m.intensity, kj: m.kj,
      exposed: counted ? (100 * exposed) / counted : NaN,
      sheltered: counted ? (100 * sheltered) / counted : NaN,
      median: rs.length ? Physics.percentile(rs, 0.5) : NaN,
      p85: rs.length ? Physics.percentile(rs, 0.85) : NaN,
      savedKj: saved / 1000,
      soloKj: soloKj / 1000,
      savedPct: soloKj > 0 ? (100 * saved) / soloKj : NaN,
      laps: laps[0] && laps[0].source !== 'none' ? laps.length : 0,
      lapSource: laps[0] ? laps[0].source : 'none',
      turns: turns.length,
      cornerKj,
      surges: matches.length,
      matchKj,
      surgesFromShelter: matches.filter(s => s.fromShelter).length,
      cornerExitSurges: surges.length - matches.length,
      cornerExitKj: surges.filter(s => s.cornerExit).reduce((s2, x) => s2 + x.matchKj, 0),
      allSurges: surges.length,
      wbalMin: wbal.minBal / 1000,
      wbalMinPct: cfg.wPrime > 0 ? (100 * wbal.minBal) / cfg.wPrime : NaN,
      wbalSpent: wbal.spent / 1000,
      wbalOverdraft: wbal.overdraft / 1000,
      wbalEmptySeconds: wbal.depletedSeconds,
      wbalTau: wbal.tau,
    };
  }

  /**
   * The last laps decide the race. This isolates them so the readout answers
   * "what did you have left, and were you spending it in the wind?".
   */
  function summariseFinale(P, ratio, wbal, laps, surges, cfg) {
    const nLaps = cfg.finaleLaps || 3;
    let i0;
    if (laps.length >= nLaps + 1 && laps[0].source !== 'none') {
      i0 = laps[laps.length - nLaps].i0;
    } else {
      const cutoff = P.t[P.n - 1] - (cfg.finaleSeconds || 300);
      i0 = 0;
      while (i0 < P.n - 1 && P.t[i0] < cutoff) i0++;
    }

    let secs = 0, exposed = 0, counted = 0;
    const w = [];
    for (let i = i0; i < P.n; i++) {
      if (!P.moving[i]) continue;
      secs += P.dt;
      w.push(P.watts[i]);
      if (isFinite(ratio[i])) {
        counted++;
        if (ratio[i] >= cfg.exposedAt) exposed++;
      }
    }

    const matches = surges.filter(s => !s.cornerExit);
    const inFinale = matches.filter(s => s.i0 >= i0);
    const before = matches.filter(s => s.i0 < i0);

    return {
      i0,
      basis: laps.length >= nLaps + 1 && laps[0].source !== 'none' ? 'last ' + nLaps + ' laps' : 'last 5 min',
      seconds: secs,
      avg: w.length ? Physics.mean(w) : NaN,
      exposed: counted ? (100 * exposed) / counted : NaN,
      wbalAtStart: wbal.bal[i0] / 1000,
      wbalAtStartPct: cfg.wPrime > 0 ? (100 * wbal.bal[i0]) / cfg.wPrime : NaN,
      surges: inFinale.length,
      surgeKj: inFinale.reduce((s, x) => s + x.matchKj, 0),
      matchesBurnedBefore: before.length,
      matchKjBefore: before.reduce((s, x) => s + x.matchKj, 0),
    };
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  /** Reduce an analysis to the row shown in the Compare tab. */
  function compareRow(ride, analysis) {
    const s = analysis.summary;
    return {
      id: ride.id,
      name: ride.name,
      date: ride.startTime ? new Date(ride.startTime * 1000) : null,
      minutes: s.movingSeconds / 60,
      distanceKm: s.distance / 1000,
      avg: s.avg,
      np: s.np,
      exposed: s.exposed,
      sheltered: s.sheltered,
      median: s.median,
      savedPct: s.savedPct,
      laps: s.laps,
      turns: s.turns,
      surges: s.surges,
      matchKj: s.matchKj,
      cornerKj: s.cornerKj,
      wbalMinPct: s.wbalMinPct,
      finaleExposed: analysis.finale.exposed,
      wind: analysis.wind.speed,
      windDir: analysis.wind.dirFrom,
      windSource: analysis.wind.source,
      cda: analysis.cda,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function median(a) {
    const x = a.filter(isFinite).slice().sort((p, q) => p - q);
    if (!x.length) return NaN;
    const m = Math.floor(x.length / 2);
    return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
  }

  function stdev(a) {
    const x = a.filter(isFinite);
    if (x.length < 2) return 0;
    const mu = Physics.mean(x);
    return Math.sqrt(Physics.mean(x.map(v => (v - mu) * (v - mu))));
  }

  function meanFinite(a, i0, i1) {
    let s = 0, k = 0;
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++) {
      if (isFinite(a[i])) { s += a[i]; k++; }
    }
    return k ? s / k : NaN;
  }

  /** Smallest absolute difference between two bearings, in radians. */
  function angleDiff(a, b) { return Math.abs(angleDelta(a, b)); }

  /** Signed difference b − a wrapped to (−π, π]. */
  function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  return {
    run, resolveWind, detectLaps, detectTurns, buildSectors, detectSurges,
    exposureByHeading, compareRow, angleDelta, R_EARTH,
    buildMeanLap, fitCircle, classifyTurn,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Analyzer;
