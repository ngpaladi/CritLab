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
    const hr = summariseHr(P, cfg, 0, P.n - 1);
    const shape = raceShape(lapRows);

    return {
      cfg, rho, wind, cda: wind.cda,
      solo, soloRaw, wattsS, soloS, ratio, yaw, wbal,
      laps: lapRows, lapBounds: laps, meanLap, turns, sectors, surges,
      headings, summary, finale, hr, shape,
      circuit: (P.lat && meanLap) ? (() => {
        let la = 0, lo = 0;
        for (let j = 0; j < meanLap.n; j++) { la += meanLap.lat[j]; lo += meanLap.lon[j]; }
        return { lat: la / meanLap.n, lon: lo / meanLap.n, lapLen: meanLap.lapLen };
      })() : null,
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

    if (!P.lat) return whole;

    // A start/finish line the rider placed themselves wins over everything.
    // It is a painted line on a road: nothing in a GPS trace identifies it, and
    // guessing from where the recording happened to begin puts it wherever the
    // head unit was switched on — the staging area, the back of the grid, the
    // car park. When the rider has said where it is, use it.
    if (cfg.startAnchor && isFinite(cfg.startAnchor.lat)) {
      const idx = nearestTrackIndex(P, cfg.startAnchor.lat, cfg.startAnchor.lon);
      if (idx >= 0) {
        const laps = lapsFromAnchor(P, idx, cfg);
        if (laps) { laps.forEach(l => { l.source = 'manual'; }); return laps; }
      }
    }

    const fromDevice = lapsFromMarkers(P);
    if (fromDevice) return fromDevice;

    // Otherwise try the start of the recording, then later points on the track.
    // The first candidate that yields a coherent set of laps wins, so lap 1
    // begins where the rider began whenever that is a place they come back to.
    for (const anchor of anchorCandidates(P)) {
      const laps = lapsFromAnchor(P, anchor, cfg);
      if (laps) return laps;
    }
    return whole;
  }

  /** Index of the moving track sample closest to a lat/lon, or -1. */
  function nearestTrackIndex(P, lat, lon) {
    if (!P.lat) return -1;
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < P.n; i++) {
      if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
      const d = Math.hypot((P.lon[i] - lon) * mLon, (P.lat[i] - lat) * mLat);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD < 120 ? best : -1;
  }

  /**
   * Anchor candidates, earliest first.
   *
   * The old heuristic scored the whole first half of the ride for a fast,
   * straight, unambiguous stretch and split laps there. That reliably found a
   * place where lap detection *works*, and just as reliably put the lap
   * boundary somewhere arbitrary — two minutes into the Sunshine Crit, so
   * "lap 1" began partway round and every lap straddled the real start.
   *
   * What a rider means by lap 1 is the lap that starts at the line. So the
   * candidates run in time order from the first moving GPS sample, and the
   * earliest one that produces coherent laps is taken. Later candidates only
   * come into play when the recording starts somewhere the rider never returns
   * to — a car park, a neutral roll-out from the race HQ — in which case the
   * first point actually on the circuit is the honest answer.
   */
  function anchorCandidates(P) {
    const out = [];
    let first = 0;
    while (first < P.n && (!P.moving[first] || (!P.lat[first] && !P.lon[first]))) first++;
    if (first >= P.n) return out;

    const limit = Math.floor(P.n * 0.6);
    const stride = Math.max(1, Math.round(3 / P.dt));
    for (let i = first; i < limit; i += stride) {
      if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Laps as repeated passes of one anchor point, gated on heading so an
   * out-and-back section cannot fire a false crossing.
   * @returns {Array|null} the laps, or null if this anchor does not describe a circuit
   */
  function lapsFromAnchor(P, anchorIdx, cfg) {
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
    if (kept.length < 3) return null;

    const laps = [];
    for (let k = 0; k < kept.length - 1; k++) {
      laps.push({ i0: kept[k], i1: kept[k + 1], source: 'gps' });
    }

    // A crit's laps are near-identical in length. If they are not, this anchor
    // is firing on something that is not a start/finish line.
    const lens = laps.map(l => P.dist[l.i1] - P.dist[l.i0]);
    const med = median(lens);
    if (!(med > 0)) return null;
    const cv = Math.sqrt(Physics.mean(lens.map(x => (x - med) * (x - med)))) / med;
    if (cv > 0.22) return null;

    // Trim laps wildly off the median (neutral roll-out, cool-down).
    const good = laps.filter(l => {
      const d = P.dist[l.i1] - P.dist[l.i0];
      return d > 0.7 * med && d < 1.4 * med;
    });
    return good.length >= 2 ? good : null;
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

  // ── Race window ───────────────────────────────────────────────────────────

  /**
   * Find where the race actually is inside the recording.
   *
   * A crit file is rarely just a crit. Typically it is: ride or roll to the
   * venue, some laps of the circuit warming up, the race, a cool-down lap or
   * two, then spin back to the car. All of it looks like riding, and analysing
   * it as one thing corrupts nearly everything — W′ drains before the start,
   * the cool-down dilutes the exposure percentages, and a soft-pedalled lap
   * drags the sector medians toward "sheltered" for reasons that have nothing
   * to do with shelter.
   *
   * Two signals, because neither is enough alone:
   *
   *   Geometry — is the rider *on the circuit* at all? This separates the
   *   approach and the ride home from everything that happened at the venue,
   *   and pace cannot do it: a 30 km/h approach and a 30 km/h warm-up lap look
   *   identical until you notice one of them is two miles away.
   *
   *   Pace — among the laps actually on the circuit, which were raced? Warm-up
   *   and cool-down laps are slower and far more variable than race laps, and
   *   geometry cannot tell them apart because they are all the same road.
   *
   * Boundaries land on lap crossings, so if a start/finish line has been placed
   * the race begins and ends exactly there rather than mid-lap.
   */
  function detectRaceWindow(P, cfg) {
    const none = {
      i0: 0, i1: P.n - 1, warmupSeconds: 0, cooldownSeconds: 0,
      approachSeconds: 0, homeSeconds: 0,
      raceLaps: 0, totalLaps: 0, found: false, basis: 'whole recording',
      phases: [], lapInfo: [], anchoredToStartLine: false,
    };

    const laps = detectLaps(P, cfg);
    if (!laps.length || laps[0].source === 'none' || laps.length < 4) return none;

    // ── Geometry: how far is each sample from the circuit? ──────────────────
    const meanLap = buildMeanLap(P, laps);
    const onCircuit = new Uint8Array(P.n);
    if (meanLap) {
      const mLat = 111320, mLon = 111320 * Math.cos(meanLap.lat[0] * Math.PI / 180);
      // Sample the mean lap coarsely — 10 m resolution is ample for an
      // on-or-off-the-circuit question and keeps this linear enough.
      const stride = Math.max(1, Math.round(10 / meanLap.step));
      const px = [], py = [];
      for (let j = 0; j < meanLap.n; j += stride) { px.push(meanLap.x[j]); py.push(meanLap.y[j]); }
      const lat0 = meanLap.lat[0], lon0 = meanLap.lon[0];
      const near2 = (cfg.circuitCorridor || 45) ** 2;
      for (let i = 0; i < P.n; i++) {
        if (!P.lat[i] && !P.lon[i]) { onCircuit[i] = onCircuit[Math.max(0, i - 1)]; continue; }
        const x = (P.lon[i] - lon0) * mLon, y = (P.lat[i] - lat0) * mLat;
        let best = Infinity;
        for (let k = 0; k < px.length; k++) {
          const dx = x - px[k], dy = y - py[k];
          const d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; if (best < near2) break; }
        }
        onCircuit[i] = best < near2 ? 1 : 0;
      }
    } else {
      onCircuit.fill(1);
    }

    // ── Stops: a hard boundary the race cannot span ─────────────────────────
    // Riders who come to a halt after the finish hand us an unambiguous end;
    // riders who roll straight into a cool-down lap do not, and for them this
    // finds nothing and costs nothing.
    const stopSecs = cfg.stopSeconds || 20;
    const stops = [];
    {
      let i = 0;
      while (i < P.n) {
        if (P.moving[i]) { i++; continue; }
        let j = i;
        while (j < P.n && !P.moving[j]) j++;
        if ((j - i) * P.dt >= stopSecs) stops.push({ i0: i, i1: j - 1 });
        i = j;
      }
    }

    // ── Pace: which laps were raced? ────────────────────────────────────────
    const lapInfo = laps.map((l, k) => {
      const secs = (l.i1 - l.i0) * P.dt;
      const dist = P.dist[l.i1] - P.dist[l.i0];
      let np = 0;
      const w = [];
      for (let i = l.i0; i <= l.i1; i++) if (P.moving[i]) w.push(P.watts[i]);
      if (w.length) np = Physics.normalizedPower(w, P.dt);
      return {
        lap: k + 1, i0: l.i0, i1: l.i1,
        seconds: secs,
        speed: secs > 0 ? dist / secs : 0,
        np,
        inRace: false,
      };
    });

    /**
     * Where the racing line is, and how far each lap strays from it.
     *
     * A rider who has finished often stops riding the course: peels into the
     * pits, cuts across, drifts wide, or leaves for the car park. When that
     * happens it is far better evidence than power — you cannot soft-pedal your
     * way onto a different road — so it is checked first.
     *
     * The line has to come from the *fast* laps only. Building it from every
     * lap would fold the cool-down into the reference and hide the very
     * deviation being looked for.
     */
    const fastIdx = lapInfo
      .map((l, k) => [l.speed, k])
      .sort((a, b) => b[0] - a[0])
      .slice(0, Math.max(3, Math.ceil(lapInfo.length * 0.5)))
      .map(x => x[1])
      .sort((a, b) => a - b);
    const line = buildMeanLap(P, fastIdx.map(k => laps[k]));

    if (line) {
      const mLat = 111320, mLon = 111320 * Math.cos(line.lat[0] * Math.PI / 180);
      const stride = Math.max(1, Math.round(6 / line.step));
      const lx = [], ly = [];
      for (let j = 0; j < line.n; j += stride) { lx.push(line.x[j]); ly.push(line.y[j]); }
      const lat0 = line.lat[0], lon0 = line.lon[0];
      const corridor = cfg.raceLineCorridor || 25;
      const corr2 = corridor * corridor;

      const devOf = i => {
        const x = (P.lon[i] - lon0) * mLon, y = (P.lat[i] - lat0) * mLat;
        let best = Infinity;
        for (let k = 0; k < lx.length; k++) {
          const dx = x - lx[k], dy = y - ly[k];
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        return best;
      };

      for (const l of lapInfo) {
        let off = 0, tot = 0, sum = 0;
        for (let i = l.i0; i <= l.i1; i++) {
          if (!P.moving[i] || (!P.lat[i] && !P.lon[i])) continue;
          const d2 = devOf(i);
          tot++;
          sum += Math.sqrt(d2);
          if (d2 > corr2) off++;
        }
        l.offLine = tot ? off / tot : 0;
        l.meanDev = tot ? sum / tot : 0;
      }
      // How far a *racing* lap typically strays, as the yardstick for "strayed".
      const raceDevs = fastIdx.map(k => lapInfo[k].meanDev).filter(isFinite).sort((a, b) => a - b);
      const typicalDev = raceDevs.length ? raceDevs[raceDevs.length >> 1] : 0;
      for (const l of lapInfo) {
        l.leftCourse = l.offLine > (cfg.offLineFrac || 0.2) ||
          (typicalDev > 0.5 && l.meanDev > typicalDev * (cfg.devMultiple || 4));
      }
    }

    const bySpeed = lapInfo.map(l => l.speed).sort((a, b) => a - b);
    const byNp = lapInfo.map(l => l.np).sort((a, b) => a - b);
    const racePace = bySpeed[Math.floor(bySpeed.length * 0.75)];
    const raceNp = byNp[Math.floor(byNp.length * 0.75)];
    if (!(racePace > 0)) return none;

    /**
     * Is this lap warm-up or cool-down rather than racing?
     *
     * The first version of this asked whether a lap was within 12% of race
     * pace, and it was wrong in a way worth recording. Races fade: on one real
     * crit the lap speeds ran 39, 41, 39, 42, 41, 40, 39, 40, 38, 35, 35, 35,
     * 34, 35, 35, 34 km/h — a smooth decline with no discontinuity anywhere.
     * A percentage-of-pace rule cut the last four off and called them a
     * cool-down, one of them at 264 W, which was *higher* than three of the
     * laps it kept. That is not a cool-down. That is the end of a hard race.
     *
     * What actually distinguishes a cool-down is that you stop pedalling hard.
     * So the test is primarily on power: a cool-down lap is soft, somewhere
     * near half your racing power, and no amount of fading gets you there while
     * still racing. Speed is kept only as a backstop for a lap so slow that
     * power cannot explain it.
     */
    // The two ends are not symmetric, because what sits at them is not the same
    // thing. After the finish you soft-pedal. Before the start you roll out
    // neutralised — slower than racing, but still in a bunch at real power, and
    // still part of the race. So the front demands much clearer evidence before
    // anything is removed.
    const soft = frac => l => (l.np > 0 && l.np < raceNp * frac);
    const crawl = frac => l => l.speed < racePace * frac;

    // Leaving the course is decisive on its own; power decides the rest.
    const isCooldown = l => l.leftCourse ||
      soft(cfg.cooldownNpFrac || 0.65)(l) || crawl(cfg.cooldownPaceFrac || 0.62)(l);
    const isWarmup = l => l.leftCourse ||
      soft(cfg.warmupNpFrac || 0.45)(l) || crawl(cfg.warmupPaceFrac || 0.55)(l);

    // Trim only from the ends. Anything in the middle is the race, however
    // slow it got — a race that fades is still a race.
    let bestA = 0, bestB = lapInfo.length - 1;
    while (bestA < bestB && isWarmup(lapInfo[bestA])) bestA++;
    while (bestB > bestA && isCooldown(lapInfo[bestB])) bestB--;
    if (bestB - bestA + 1 < 3) return none;

    // "I always start recording on the start line" — a fact about how you ride
    // that no amount of signal processing can discover, and which removes the
    // whole warm-up-detection guess when it is true.
    let startedOnLine = false;
    if (cfg.startsOnStartLine) { bestA = 0; startedOnLine = true; }
    // If the recording began on the line then the recording *is* the start:
    // there is nothing in front of it to call a warm-up, including whatever
    // sits before the first detected lap crossing.
    const forcedStart = startedOnLine ? 0 : null;

    // A sustained stop after the racing ends it, whatever the pace says next.
    let endedAtStop = false;
    const firstStopAfter = stops.find(st => st.i0 > lapInfo[bestA].i1);
    if (firstStopAfter) {
      while (bestB > bestA && lapInfo[bestB].i0 > firstStopAfter.i0) bestB--;
      endedAtStop = true;
    }

    for (let k = bestA; k <= bestB; k++) lapInfo[k].inRace = true;

    /**
     * The fragments either side of the outermost lap crossings.
     *
     * A race does not oblige you to stop on a lap boundary. Riders roll on past
     * the line and stop wherever, so there is nearly always a partial lap at
     * the end — and taking the window to the last crossing throws it away
     * whatever it contains. On one real race that discarded 2:12 ridden at
     * 278 W, which is above that race's own reference power. Partial or not,
     * that is racing.
     *
     * So a fragment is judged the same way a lap is: on power. Soft means
     * cool-down and goes; anything at racing power stays.
     */
    const fragmentIsRacing = (from, to, softFrac) => {
      const w = [];
      for (let i = Math.max(0, from); i <= Math.min(P.n - 1, to); i++) {
        if (P.moving[i]) w.push(P.watts[i]);
      }
      if (w.length * P.dt < 20) return false;         // too short to matter
      return Physics.normalizedPower(w, P.dt) >= raceNp * softFrac;
    };

    let i0 = forcedStart != null ? forcedStart : laps[bestA].i0;
    let i1 = laps[bestB].i1;

    // Keep a trailing fragment that is still being raced.
    if (bestB === lapInfo.length - 1 &&
        fragmentIsRacing(i1 + 1, P.n - 1, cfg.cooldownNpFrac || 0.65)) {
      i1 = P.n - 1;
    }
    // And a leading one, held to the stricter roll-out bar.
    if (forcedStart == null && bestA === 0 &&
        fragmentIsRacing(0, i0 - 1, cfg.warmupNpFrac || 0.45)) {
      i0 = 0;
    }

    // ── Phases ──────────────────────────────────────────────────────────────
    // Before the first lap crossing the rider is either approaching the venue
    // (off the circuit) or already warming up on it; same story afterwards.
    const movingSecs = (from, to, wantOn) => {
      let sec = 0;
      for (let i = Math.max(0, from); i <= Math.min(P.n - 1, to); i++) {
        if (!P.moving[i]) continue;
        if (wantOn == null || !!onCircuit[i] === wantOn) sec += P.dt;
      }
      return sec;
    };

    const approach = startedOnLine ? 0 : movingSecs(0, i0 - 1, false);
    const warmup = startedOnLine ? 0 : movingSecs(0, i0 - 1, true);
    const cooldown = movingSecs(i1 + 1, P.n - 1, true);
    const home = movingSecs(i1 + 1, P.n - 1, false);

    const phases = [];
    const push = (kind, from, to, laps_) => {
      const sec = movingSecs(from, to, null);
      if (sec > 5) phases.push({ kind, i0: from, i1: to, seconds: sec, laps: laps_ });
    };
    // Split the lead-in at the point the rider first reaches the circuit.
    let arrive = 0;
    while (arrive < i0 && !onCircuit[arrive]) arrive++;
    push('approach', 0, arrive - 1, 0);
    push('warmup', arrive, i0 - 1, bestA);
    push('race', i0, i1, bestB - bestA + 1);
    let leave = P.n - 1;
    while (leave > i1 && !onCircuit[leave]) leave--;
    push('cooldown', i1 + 1, leave, lapInfo.length - 1 - bestB);
    push('home', leave + 1, P.n - 1, 0);

    return {
      i0, i1,
      warmupSeconds: warmup,
      cooldownSeconds: cooldown,
      approachSeconds: approach,
      homeSeconds: home,
      raceLaps: bestB - bestA + 1,
      totalLaps: lapInfo.length,
      // Nothing worth removing at either end: the file is already just the race.
      preCropped: (bestB - bestA + 1) === lapInfo.length &&
        approach + warmup + cooldown + home < 60,
      // Which signal actually did the work, so the UI can say.
      trimmedByCourse: lapInfo.some((l, k) =>
        l.leftCourse && (k < bestA || k > bestB)),
      anyLeftCourse: lapInfo.some(l => l.leftCourse),
      keptTrailingFragment: i1 > laps[bestB].i1,
      keptLeadingFragment: forcedStart == null && i0 < laps[bestA].i0,
      firstRaceLap: bestA,
      lastRaceLap: bestB,
      lapInfo,
      phases,
      onCircuit,
      racePace, raceNp,
      anchoredToStartLine: laps[0].source === 'manual',
      startedOnLine,
      endedAtStop,
      stops: stops.length,
      found: true,
      basis: [
        startedOnLine ? 'you start on the line' : null,
        laps[0].source === 'manual' ? 'your start/finish line' : 'circuit geometry',
        lapInfo.some(l => l.leftCourse) ? 'the racing line' : null,
        'lap power',
        endedAtStop ? 'and the stop after the finish' : null,
      ].filter(Boolean).join(', '),
    };
  }

  /** Move the race window by whole laps — what the nudge buttons drive. */
  function adjustRaceWindow(win, deltaStart, deltaEnd) {
    if (!win || !win.found) return win;
    const a = Math.max(0, Math.min(win.lastRaceLap, win.firstRaceLap + deltaStart));
    const b = Math.min(win.lapInfo.length - 1, Math.max(a, win.lastRaceLap + deltaEnd));
    const out = { ...win, firstRaceLap: a, lastRaceLap: b,
      i0: win.lapInfo[a].i0, i1: win.lapInfo[b].i1,
      raceLaps: b - a + 1 };
    out.lapInfo = win.lapInfo.map((l, k) => ({ ...l, inRace: k >= a && k <= b }));
    return out;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────  // ── Turns ─────────────────────────────────────────────────────────────────

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

    numberFromStart(P, turns);

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

  /**
   * Number the corners the way a rider counts them: Turn 1 is the first one you
   * reach after rolling off the start, Turn 2 the next, and so on.
   *
   * The obvious ordering — by distance along the lap — is wrong here, because
   * "along the lap" is measured from the lap-detection anchor, and that anchor
   * is chosen for being a fast, straight, unambiguous piece of road somewhere
   * in the first half of the ride. It is a good place to detect a lap crossing
   * and an arbitrary place to start counting corners from.
   *
   * So the order comes from the track itself: for each corner, the first sample
   * in the whole recording at which the rider passes through it.
   */
  function numberFromStart(P, turns) {
    if (!turns.length) return turns;

    if (P.lat) {
      const mLat = 111320;
      const mLon = 111320 * Math.cos((P.lat[0] || 0) * Math.PI / 180);
      const near = 30;                                    // metres

      for (const t of turns) {
        t.firstSeen = Infinity;
        for (let i = 0; i < P.n; i++) {
          if (!P.moving[i]) continue;
          if (!P.lat[i] && !P.lon[i]) continue;
          const d = Math.hypot((P.lon[i] - t.lon) * mLon, (P.lat[i] - t.lat) * mLat);
          if (d < near) { t.firstSeen = i; break; }
        }
      }
      // Only trust it if every corner was actually located on the track.
      if (turns.every(t => isFinite(t.firstSeen))) {
        turns.sort((a, b) => a.firstSeen - b.firstSeen);
        turns.forEach((t, k) => { t.number = k + 1; t.name = 'Turn ' + (k + 1); });
        return turns;
      }
    }

    // No GPS, or a corner that could not be found on the raw track: fall back
    // to lap order, which at least keeps them in a consistent sequence.
    turns.sort((a, b) => (a.lapOffset || 0) - (b.lapOffset || 0));
    turns.forEach((t, k) => { t.number = k + 1; t.name = 'Turn ' + (k + 1); });
    return turns;
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
    numberFromStart(P, real);
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
        // Cadence through the corner: were you pedalling, or freewheeling and
        // then having to spin back up? A corner taken coasting costs time you
        // then buy back with watts on the exit.
        if (P.cad) {
          let cadSum = 0, cadN = 0, coast = 0, total = 0;
          for (let k = ev.i0; k <= Math.min(P.n - 1, ev.i1); k++) {
            total++;
            if (P.cad[k] > 5) { cadSum += P.cad[k]; cadN++; } else coast++;
          }
          ev.cadence = cadN ? cadSum / cadN : 0;
          ev.coastFrac = total ? coast / total : 0;
        }

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
      if (evs.some(e => e.cadence != null)) {
        turn.cadence = Physics.mean(evs.map(e => e.cadence).filter(isFinite));
        turn.coastFrac = Physics.mean(evs.map(e => e.coastFrac).filter(isFinite));
      }
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
      // Sector *geometry* still comes from position around the lap — but the
      // labels have to use each turn's real number, which is no longer the same
      // as its position order now that numbering starts from the GPS start.
      const ordered = turns.slice().sort((a, b) => a.lapOffset - b.lapOffset);
      bounds = ordered.map(t => clamp01(t.lapOffset));
      labels = ordered.map((t, k) =>
        'T' + t.number + '→T' + ordered[(k + 1) % ordered.length].number);
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

    // Elevation closure: on a circuit every lap returns to where it began, so
    // the net altitude change per lap should be ~0. It is a free check on the
    // altimeter, and it matters more than it looks — gravity enters the
    // solo-required power directly, and CdA is calibrated against a high
    // percentile of the draft ratio, where a drifting altitude signal would
    // quietly park a systematic error.
    const elevation = elevationClosure(P, laps);

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
      elevation,
      avgCadence: P.cad ? (() => {
        let sum = 0, k = 0, coast = 0, tot = 0;
        for (let i = 0; i < P.n; i++) {
          if (!P.moving[i]) continue;
          tot++;
          if (P.cad[i] > 5) { sum += P.cad[i]; k++; } else coast++;
        }
        return { rpm: k ? sum / k : NaN, coastPct: tot ? (100 * coast) / tot : NaN };
      })() : null,
    };
  }

  /**
   * How well the altitude trace closes over each lap, and how much of the
   * modelled power the gradient is responsible for.
   *
   * @returns {{netPerLap, drift, gainPerLap, gradeShare, trustworthy, note}}
   */
  function elevationClosure(P, laps) {
    const real = laps.length && laps[0].source !== 'none';

    // What fraction of the modelled resistive power comes from gravity? On a
    // flat crit this is a rounding error; on a rolling circuit it is not, and
    // the altimeter's accuracy starts to matter to the CdA fit.
    let grav = 0, total = 0;
    for (let i = 0; i < P.n; i++) {
      if (!P.moving[i]) continue;
      grav += Math.abs(Math.sin(P.theta[i])) * P.v[i];
      total += P.v[i];
    }
    const meanAbsGrade = total > 0 ? (grav / total) * 100 : 0;

    let gainPerLap = NaN, netPerLap = NaN, drift = NaN;
    if (real) {
      const nets = laps.map(l => P.alt[l.i1] - P.alt[l.i0]);
      netPerLap = median(nets);
      drift = (P.alt[laps[laps.length - 1].i1] - P.alt[laps[0].i0]) / laps.length;
      let gain = 0;
      for (let i = laps[0].i0 + 1; i <= laps[laps.length - 1].i1; i++) {
        const d = P.alt[i] - P.alt[i - 1];
        if (d > 0) gain += d;
      }
      gainPerLap = gain / laps.length;
    }

    // A lap that does not return to its own start height means the barometer
    // moved, not the road.
    const drifting = isFinite(drift) && Math.abs(drift) > 1.5;
    const hilly = meanAbsGrade > 1.5;

    let note = null;
    if (drifting) {
      note = 'the altitude trace drifts about ' + drift.toFixed(1) +
        ' m per lap on a circuit that returns to the same place each time, so ' +
        'the gradient — and the gravity term in every power estimate — is ' +
        'partly barometric weather rather than road';
    } else if (hilly) {
      note = 'this circuit is genuinely hilly (mean |gradient| ' +
        meanAbsGrade.toFixed(1) + '%), so the CdA calibration leans on the ' +
        'altitude data more than it would on a flat course';
    }

    return {
      netPerLap, drift, gainPerLap,
      meanAbsGrade,
      trustworthy: !drifting,
      hilly,
      note,
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

  // ── Heart rate ────────────────────────────────────────────────────────────

  /**
   * Aerobic decoupling: how much your heart rate drifted up relative to the
   * power it was buying.
   *
   * Split the race in half by moving time and compare the power-to-heart-rate
   * ratio of each half. A rising heart rate for the same watts is the classic
   * sign that you are running out of road — and in a crit it is the honest
   * counterweight to W′, which is a model, where this is measured.
   *
   * The convention is Pw:HR using normalised power, and positive means drift.
   */
  function summariseHr(P, cfg, i0, i1) {
    if (!P.hr) return null;

    const idx = [];
    for (let i = i0; i <= i1; i++) if (P.moving[i] && P.hr[i] > 30) idx.push(i);
    if (idx.length < 240) return null;                 // under 4 min: meaningless

    const half = Math.floor(idx.length / 2);
    const ratio = list => {
      const w = list.map(i => P.watts[i]);
      const np = Physics.normalizedPower(w, P.dt);
      const hr = Physics.mean(list.map(i => P.hr[i]));
      return hr > 0 ? np / hr : NaN;
    };
    const first = ratio(idx.slice(0, half));
    const second = ratio(idx.slice(half));
    const decoupling = isFinite(first) && first > 0 ? ((first - second) / first) * 100 : NaN;

    const hrs = idx.map(i => P.hr[i]);
    const sorted = hrs.slice().sort((a, b) => a - b);

    return {
      avg: Physics.mean(hrs),
      max: sorted[sorted.length - 1],
      p95: Physics.percentile(sorted, 0.95),
      decoupling,
      firstHalfPwHr: first,
      secondHalfPwHr: second,
      seconds: idx.length * P.dt,
    };
  }

  // ── The selection ─────────────────────────────────────────────────────────

  /**
   * The shape of the race, lap by lap.
   *
   * The first version of this looked for a changepoint — the lap where the pace
   * stepped up and stayed up. Measured against four real crits, no such step
   * exists in any of them: one declines steadily with a big final lap, one goes
   * out hard and fades, one is flat with a single enormous lap in the middle.
   * A detector that fires on nothing is worse than no detector, so this reports
   * what the laps actually do.
   *
   * Three things, each of which is a different race:
   *   trend    — did you fade, hold, or build?
   *   hardest  — which single lap was the outlier you had to cover?
   *   finish   — was the last lap your hardest, or had you nothing left?
   */
  function raceShape(lapRows) {
    if (!lapRows || lapRows.length < 5) return null;

    const np = lapRows.map(l => l.np);
    const n = np.length;
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const avg = mean(np);
    if (!(avg > 0)) return null;

    // Least-squares slope of NP against lap number, as % of average per lap.
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += np[i]; sxx += i * i; sxy += i * np[i]; }
    const den = n * sxx - sx * sx;
    const slope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
    const slopePct = (slope / avg) * 100;

    const sd = stdev(np);
    let hi = 0;
    for (let i = 1; i < n; i++) if (np[i] > np[hi]) hi = i;
    const hardest = {
      lap: lapRows[hi].lap,
      np: np[hi],
      overAvgPct: ((np[hi] - avg) / avg) * 100,
      z: sd > 0 ? (np[hi] - avg) / sd : 0,
      exposed: lapRows[hi].exposed,
    };

    const last = lapRows[n - 1];
    const finish = {
      lap: last.lap,
      np: last.np,
      overAvgPct: ((last.np - avg) / avg) * 100,
      isHardest: hi === n - 1,
    };

    const thirds = Math.max(1, Math.floor(n / 3));
    const opening = mean(np.slice(0, thirds));
    const closing = mean(np.slice(n - thirds));

    let trend;
    if (slopePct < -0.6) trend = 'fading';
    else if (slopePct > 0.6) trend = 'building';
    else trend = 'steady';

    return {
      laps: n, avgNp: avg, sd,
      slopePct, trend,
      openingNp: opening, closingNp: closing,
      openingVsClosingPct: ((opening - closing) / closing) * 100,
      hardest, finish,
    };
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  /**
   * A stable fingerprint for a circuit, so the same course ridden on different
   * days can be recognised as the same course.
   *
   * Centroid plus lap length, both robust: the centroid of a closed loop barely
   * moves between visits even if the racing line does, and lap length pins down
   * which of two nearby circuits at the same venue was used.
   */
  function circuitFingerprint(P, A) {
    if (!P.lat || !A.meanLap) return null;
    const ml = A.meanLap;
    let lat = 0, lon = 0;
    for (let j = 0; j < ml.n; j++) { lat += ml.lat[j]; lon += ml.lon[j]; }
    return { lat: lat / ml.n, lon: lon / ml.n, lapLen: ml.lapLen };
  }

  /** Were these two races ridden on the same circuit? */
  function sameCircuit(a, b) {
    if (!a || !b) return false;
    const mLat = 111320, mLon = 111320 * Math.cos(a.lat * Math.PI / 180);
    const apart = Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
    const lenRatio = a.lapLen > 0 && b.lapLen > 0
      ? Math.abs(a.lapLen - b.lapLen) / Math.max(a.lapLen, b.lapLen) : 1;
    // Within 250 m of the same centre and lap lengths within 12%.
    return apart < 250 && lenRatio < 0.12;
  }

  /** Group compare rows into circuits, most-visited first. */
  function groupByCircuit(rows) {
    const groups = [];
    for (const r of rows) {
      const hit = groups.find(g => sameCircuit(g.fingerprint, r.circuit));
      if (hit) { hit.races.push(r); }
      else groups.push({ fingerprint: r.circuit, races: [r] });
    }
    groups.sort((a, b) => b.races.length - a.races.length);
    return groups;
  }

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
      circuit: analysis.circuit || null,
      hr: analysis.hr,
      shape: analysis.shape,
      turns_: analysis.turns,
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
    run, resolveWind, detectLaps, lapsFromAnchor, anchorCandidates, nearestTrackIndex, detectTurns, buildSectors, detectSurges,
    exposureByHeading, elevationClosure, detectRaceWindow, adjustRaceWindow, summariseHr, raceShape, circuitFingerprint, sameCircuit, groupByCircuit, compareRow, angleDelta, R_EARTH,
    buildMeanLap, fitCircle, classifyTurn, numberFromStart,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Analyzer;
