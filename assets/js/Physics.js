'use strict';

/**
 * Physics.js — the cycling power model CritLab reasons with, plus the
 * calibration and fatigue maths built on top of it.
 *
 * The central quantity is the *solo-required power*: for every second of the
 * race, how many watts would it have taken to hold your measured speed on your
 * measured gradient in the measured wind, alone. Dividing your actual power by
 * that gives the draft ratio — around 1.0 means you were paying full freight,
 * well under 1.0 means somebody else was punching the hole.
 */
const Physics = (() => {

  const G = 9.80665;
  const R_DRY = 287.058;      // J/(kg·K), dry air
  const R_VAPOUR = 461.495;   // J/(kg·K), water vapour

  // ── Air ───────────────────────────────────────────────────────────────────

  /**
   * Humid-air density. Water vapour is lighter than dry air, so a muggy
   * evening crit is measurably faster than the dry-air formula suggests
   * (~1% at 30 °C and 90% RH — worth about 3 W at crit speeds).
   *
   * @param {number} tempC
   * @param {number} pressurePa   station-level pressure
   * @param {number} rhPct        relative humidity 0–100 (null → treat as dry)
   */
  function airDensity(tempC, pressurePa, rhPct) {
    const T = (tempC == null ? 20 : tempC) + 273.15;
    const p = pressurePa || 101325;
    if (rhPct == null) return p / (R_DRY * T);

    // Tetens saturation vapour pressure, hPa → Pa.
    const es = 6.1078 * Math.pow(10, (7.5 * (tempC || 0)) / ((tempC || 0) + 237.3)) * 100;
    const pv = clamp(rhPct, 0, 100) / 100 * es;
    const pd = Math.max(0, p - pv);
    return pd / (R_DRY * T) + pv / (R_VAPOUR * T);
  }

  /** ISA barometric pressure at a geometric altitude, in Pa. */
  function pressureAtAltitude(altM) {
    return 101325 * Math.pow(1 - 2.25577e-5 * (altM || 0), 5.25588);
  }

  // ── Apparent wind ─────────────────────────────────────────────────────────

  /**
   * Resolve ground speed + wind vector into the rider's frame.
   * @param {number} v        ground speed, m/s
   * @param {number} heading  direction of travel, radians clockwise from north
   * @param {number} we       wind vector east component, m/s (direction it blows TO)
   * @param {number} wn       wind vector north component, m/s
   * @returns {{along:number, cross:number, speed:number, yaw:number}}
   *          `along` is the headwind component (positive = into the wind),
   *          `yaw` is the apparent-wind angle in radians.
   */
  function apparentWind(v, heading, we, wn) {
    const hE = Math.sin(heading), hN = Math.cos(heading);
    const tail = we * hE + wn * hN;        // wind pushing you along
    const cross = we * hN - wn * hE;       // wind from the side
    const along = v - tail;
    return {
      along,
      cross,
      speed: Math.hypot(along, cross),
      yaw: Math.atan2(cross, along),
    };
  }

  /**
   * Power at the pedals required to hold this state.
   *
   * @param {Object} s  sample state: v, theta (radians), a (m/s²), heading (rad)
   * @param {Object} c  configuration: mass, crr, cda, rho, driveEff, rotMass,
   *                    yawK, we, wn
   */
  function requiredPower(s, c) {
    return powerCore(
      s.v, s.theta || 0, s.a || 0, s.heading || 0,
      c.mass, c.crr, c.cda, c.rho, c.driveEff || 0.976, c.rotMass || 0, c.yawK || 0,
      c.we || 0, c.wn || 0
    );
  }

  /**
   * The same model with a flat signature and no allocation. The calibration
   * search calls this a few million times, and one object per call was the
   * difference between an instant answer and a four-second stall.
   */
  function powerCore(v, theta, a, heading, mass, crr, cda, rho, driveEff, rotMass, yawK, we, wn) {
    if (!(v > 0.1)) return 0;

    const hE = Math.sin(heading), hN = Math.cos(heading);
    const along = v - (we * hE + wn * hN);
    const cross = we * hN - wn * hE;
    const appSpeed = Math.sqrt(along * along + cross * cross);

    // Yaw widens the effective frontal area. yawK = 0 disables the correction;
    // ~0.15 is a reasonable road setup, deep sections can be lower or negative.
    let cdaEff = cda;
    if (yawK && appSpeed > 1e-6) {
      const sy = cross / appSpeed;          // sin(yaw)
      cdaEff = cda * (1 + yawK * sy * sy);
    }

    const cosT = Math.cos(theta);
    const fGravity = mass * G * Math.sin(theta);
    const fRolling = mass * G * crr * cosT;
    const fAero    = 0.5 * rho * cdaEff * appSpeed * along;
    const fInertia = (mass + rotMass) * a;

    return ((fGravity + fRolling + fAero + fInertia) * v) / driveEff;
  }

  // ── Series helpers ────────────────────────────────────────────────────────

  /** Centred moving average over a fixed sample window. */
  function smooth(a, w) {
    const n = a.length;
    const out = new Float64Array(n);
    if (w <= 1) { for (let i = 0; i < n; i++) out[i] = a[i]; return out; }

    // Prefix sums keep this O(n) regardless of window size.
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isFinite(a[i]) ? a[i] : 0);
    const half = Math.floor(w / 2);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    return out;
  }

  /** Trailing (causal) moving average — what a head unit shows as "3 s power". */
  function smoothTrailing(a, w) {
    const n = a.length;
    const out = new Float64Array(n);
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (isFinite(a[i]) ? a[i] : 0);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w + 1);
      out[i] = (pre[i + 1] - pre[lo]) / (i - lo + 1);
    }
    return out;
  }

  /** Central-difference derivative of y with respect to x. */
  function derivative(y, x) {
    const n = y.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const dx = x[i1] - x[i0];
      out[i] = dx !== 0 ? (y[i1] - y[i0]) / dx : 0;
      if (!isFinite(out[i])) out[i] = 0;
    }
    return out;
  }

  /**
   * Road gradient by least-squares fit of altitude against distance over a
   * ±`halfWindowM` metre window. Barometric altimeters are noisy at the
   * one-second scale; differentiating them naively produces gradient spikes
   * that show up as phantom watts.
   */
  function gradientSeries(alt, dist, halfWindowM = 35, minPoints = 9) {
    const n = alt.length;
    const out = new Float64Array(n);
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (lo < i && dist[i] - dist[lo] > halfWindowM) lo++;
      if (hi < i) hi = i;
      while (hi < n - 1 && dist[hi + 1] - dist[i] <= halfWindowM) hi++;

      // A rider at 45 km/h covers 12 m per sample, so a fixed metre window can
      // hold too few points to average altimeter noise away — and a short,
      // noisy fit invents gradients, which the power model reads as watts.
      // Widen symmetrically until there is enough to regress against.
      while (hi - lo + 1 < minPoints && (lo > 0 || hi < n - 1)) {
        if (lo > 0) lo--;
        if (hi < n - 1) hi++;
      }

      const m = hi - lo + 1;
      if (m < 3) { out[i] = 0; continue; }

      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = lo; k <= hi; k++) {
        const x = dist[k] - dist[i], y = alt[k];
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const den = m * sxx - sx * sx;
      const slope = Math.abs(den) > 1e-9 ? (m * sxy - sx * sy) / den : 0;
      out[i] = clamp(isFinite(slope) ? slope : 0, -0.25, 0.25);
    }
    return out;
  }

  /** Bearing of travel in radians clockwise from north, from a lat/lon track. */
  function headingSeries(lat, lon, n) {
    const out = new Float64Array(n);
    if (!lat || !lon) return out;
    const D = Math.PI / 180;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
      const dLat = (lat[i1] - lat[i0]) * D;
      const dLon = (lon[i1] - lon[i0]) * D;
      const x = Math.cos(lat[i] * D) * dLon;
      if (Math.abs(x) < 1e-12 && Math.abs(dLat) < 1e-12) { out[i] = last; continue; }
      last = Math.atan2(x, dLat);
      out[i] = last;
    }
    return out;
  }

  /**
   * Wind at sample `i`. A prepared ride carries per-sample `we`/`wn` arrays
   * when the wind comes from weather data (it can shift mid-race); the scalar
   * `cfg.we`/`cfg.wn` is the fallback for a fixed or fitted wind.
   */
  function windAt(P, cfg, i) {
    return P.we
      ? { we: P.we[i], wn: P.wn[i] }
      : { we: cfg.we || 0, wn: cfg.wn || 0 };
  }

  function percentile(sortedAsc, p) {
    const n = sortedAsc.length;
    if (!n) return NaN;
    const idx = clamp(p, 0, 1) * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  // ── Calibration ───────────────────────────────────────────────────────────

  /**
   * Choose the cohort of samples that could plausibly be clean-air riding:
   * moving fast, holding a steady speed, going straight, actually pedalling.
   *
   * The tightness matters more than it looks. Calibration keys on a high
   * percentile of this cohort's draft ratio, so anything that inflates the
   * upper tail biases CdA — and therefore every exposure number in the report —
   * high. Acceleration transients are the worst offender: a second of hard
   * pedalling against a small modelled requirement produces a ratio of 3 or 9,
   * and a handful of those drag the 85th percentile up by 15%. Corner samples
   * do the same thing more quietly.
   *
   * Measured against a simulated crit with a known CdA, the loose version of
   * this filter put the p85 ratio at 1.13 where truth was 1.0 (a 13–30% CdA
   * error); the strict version puts it at 0.98.
   */
  function cleanAirCohort(P, cfg) {
    const strict = collect(0.15, 1 / 80);
    // A tight, twisty circuit can starve the strict filter. Relax rather than
    // give up, but only then — and the caller can see which was used.
    if (strict.length >= 250) { strict.relaxed = false; return strict; }
    const loose = collect(0.3, 1 / 30);
    loose.relaxed = true;
    return loose.length > strict.length ? loose : strict;

    function collect(accelMax, curvMax) {
      const idx = [];
      for (let i = 0; i < P.n; i++) {
        if (!P.moving[i]) continue;
        if (P.gap && P.gap[i]) continue;
        if (P.v[i] < 6.5) continue;
        if (Math.abs(P.accel[i]) > accelMax) continue;
        if (P.watts[i] < 0.45 * cfg.cp) continue;
        if (P.curvature && Math.abs(P.curvature[i]) > curvMax) continue;
        idx.push(i);
      }
      return idx;
    }
  }

  /**
   * Solve for CdA given a fixed wind, by asserting that the `pct` percentile of
   * the draft ratio equals 1.0 — i.e. "in your least-sheltered moments you were
   * paying full price". Ratio falls monotonically as CdA rises, so bisection is
   * exact and cheap.
   *
   * This is an assumption, not a measurement, and it is the single knob that
   * moves the absolute exposure numbers. The *pattern* across the lap is far
   * less sensitive to it.
   */
  function solveCdA(P, cfg, cohort, pct = 0.85) {
    if (cohort.length < 30) return { cda: cfg.cda, ok: false };

    const m = cohort.length;
    const perSampleWind = !!P.we;
    const cwe = cfg.we || 0, cwn = cfg.wn || 0;
    const scratch = new Float64Array(m);
    // Ignore samples whose modelled requirement is small: dividing real watts
    // by a near-zero requirement manufactures the huge ratios that poison the
    // percentile this whole method rests on.
    const needFloor = Math.max(40, 0.5 * cfg.cp);

    const evaluate = (cda) => {
      let k = 0;
      for (let j = 0; j < m; j++) {
        const i = cohort[j];
        const need = powerCore(
          P.v[i], P.theta[i], P.accel[i], P.heading[i],
          cfg.mass, cfg.crr, cda, cfg.rho, cfg.driveEff || 0.976, cfg.rotMass || 0, cfg.yawK || 0,
          perSampleWind ? P.we[i] : cwe, perSampleWind ? P.wn[i] : cwn
        );
        if (need > needFloor) scratch[k++] = P.watts[i] / need;
      }
      if (k < 20) return NaN;
      const slice = scratch.subarray(0, k);
      slice.sort();
      return percentile(slice, pct);
    };

    let lo = 0.16, hi = 0.60;
    const rLo = evaluate(lo), rHi = evaluate(hi);
    if (!isFinite(rLo) || !isFinite(rHi)) return { cda: cfg.cda, ok: false };
    // Target of 1.0 must be bracketed, otherwise clamp to the nearer bound.
    if (rLo < 1) return { cda: lo, ok: false, clamped: 'low' };
    if (rHi > 1) return { cda: hi, ok: false, clamped: 'high' };

    // 18 halvings take a 0.44 m² bracket below 2e-6 — far finer than the model.
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (evaluate(mid) > 1) lo = mid; else hi = mid;
    }
    return { cda: (lo + hi) / 2, ok: true };
  }

  /**
   * Solve for the wind vector *and* CdA together, when no weather is available.
   *
   * The signal being exploited: with the wrong wind assumed, apparent exposure
   * becomes a function of which way you are pointing — the north-bound straight
   * looks systematically harder than the south-bound one. The right wind
   * flattens that. So the score is the spread of the high-percentile draft
   * ratio across heading octants, and we pick the wind that minimises it.
   */
  function solveWind(P, cfg, pct = 0.85) {
    const cohort = cleanAirCohort(P, cfg);
    if (cohort.length < 120) {
      return { we: 0, wn: 0, cda: cfg.cda, ok: false, reason: 'not enough steady riding to fit wind' };
    }

    // Subsample so the grid search stays interactive.
    const step = Math.max(1, Math.floor(cohort.length / 450));
    const sample = cohort.filter((_, k) => k % step === 0);

    // A wind fit needs the rider to have pointed in several directions.
    const spread = headingSpread(P, sample);
    if (spread < 4) {
      return { we: 0, wn: 0, cda: cfg.cda, ok: false, reason: 'course is too directional to separate wind from CdA' };
    }

    const score = (we, wn) => {
      const c0 = { ...cfg, we, wn };
      const sol = solveCdA(P, c0, sample, pct);
      const c = { ...c0, cda: sol.cda };

      // Per-octant high-percentile ratio.
      const bins = [[], [], [], [], [], [], [], []];
      for (const i of sample) {
        const need = powerCore(
          P.v[i], P.theta[i], P.accel[i], P.heading[i],
          c.mass, c.crr, c.cda, c.rho, c.driveEff || 0.976, c.rotMass || 0, c.yawK || 0, we, wn
        );
        if (!(need > Math.max(40, 0.5 * cfg.cp))) continue;
        const b = Math.floor((((P.heading[i] * 180 / Math.PI) % 360 + 360) % 360) / 45) % 8;
        bins[b].push(P.watts[i] / need);
      }

      let sw = 0, swx = 0, swxx = 0;
      for (const b of bins) {
        if (b.length < 12) continue;
        b.sort((a, z) => a - z);
        const q = percentile(b, pct);
        const w = b.length;
        sw += w; swx += w * q; swxx += w * q * q;
      }
      if (sw < 60) return { cost: Infinity, cda: sol.cda };
      const mean = swx / sw;
      return { cost: swxx / sw - mean * mean, cda: sol.cda };
    };

    let best = { cost: Infinity, we: 0, wn: 0, cda: cfg.cda };
    for (let we = -7; we <= 7; we += 1) {
      for (let wn = -7; wn <= 7; wn += 1) {
        const r = score(we, wn);
        if (r.cost < best.cost) best = { cost: r.cost, we, wn, cda: r.cda };
      }
    }
    for (const [span, step] of [[1, 0.25], [0.3, 0.1]]) {
      const c0 = best;
      for (let we = c0.we - span; we <= c0.we + span + 1e-9; we += step) {
        for (let wn = c0.wn - span; wn <= c0.wn + span + 1e-9; wn += step) {
          const r = score(we, wn);
          if (r.cost < best.cost) best = { cost: r.cost, we, wn, cda: r.cda };
        }
      }
    }

    // How well-posed was this? Separating a wind vector from CdA needs the
    // rider to have pointed in several directions. A four-corner circuit gives
    // four bearings against three unknowns — solvable, but the direction can
    // still land tens of degrees out, and the UI should say so rather than
    // print a confident number.
    const confidence = spread >= 7 ? 'high' : spread >= 6 ? 'medium' : 'low';

    return {
      we: best.we, wn: best.wn, cda: best.cda,
      speed: Math.hypot(best.we, best.wn),
      dirFrom: ((Math.atan2(-best.we, -best.wn) * 180 / Math.PI) + 360) % 360,
      ok: isFinite(best.cost),
      residual: best.cost,
      spread, confidence,
    };
  }

  /**
   * How many 45° heading octants the rider *meaningfully* used (max 8).
   *
   * Counting distinct octants is not enough: a second of GPS jitter on a
   * straight throws a sample into a neighbouring octant, so a plain four-corner
   * rectangle "uses" all eight and the wind fit reports false confidence. An
   * octant only counts when it holds a real share of the riding.
   */
  function headingSpread(P, idx, minShare = 0.05) {
    if (!idx.length) return 0;
    const bins = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const i of idx) {
      bins[Math.floor((((P.heading[i] * 180 / Math.PI) % 360 + 360) % 360) / 45) % 8]++;
    }
    return bins.filter(c => c / idx.length >= minShare).length;
  }

  // ── Fatigue ───────────────────────────────────────────────────────────────

  /**
   * W′ balance, Skiba's differential form with Clarke's recovery expression.
   * Above CP the tank drains at (P − CP); below it, it refills toward W′ with
   * a time constant set by how far below CP you are recovering.
   *
   * The reported balance is clamped to [0, W′] — "how much is left" cannot be
   * negative. Demand beyond empty is not discarded, though: it accumulates in
   * `overdraft`, which is the honest signal that the modelled W′ is too small
   * for this rider or that they were riding well past what the model allows.
   *
   * @returns {{bal:Float64Array, tau:number, minBal:number, minAt:number,
   *            spent:number, overdraft:number, depleted:boolean,
   *            depletedSeconds:number}}
   */
  function wPrimeBalance(watts, cp, wPrime, dt = 1) {
    const n = watts.length;
    const bal = new Float64Array(n);

    // Mean shortfall below CP sets the recovery time constant.
    let sum = 0, k = 0;
    for (let i = 0; i < n; i++) if (watts[i] < cp) { sum += cp - watts[i]; k++; }
    const dcp = k ? sum / k : 0;
    const tau = 546 * Math.exp(-0.01 * dcp) + 316;

    let b = wPrime;
    let minBal = wPrime, minAt = 0, spent = 0, overdraft = 0, emptyFor = 0;
    for (let i = 0; i < n; i++) {
      const p = isFinite(watts[i]) ? watts[i] : 0;
      if (p > cp) {
        const drain = (p - cp) * dt;
        spent += drain;
        b -= drain;
        if (b < 0) { overdraft -= b; b = 0; }
      } else {
        b = wPrime - (wPrime - b) * Math.exp(-dt / tau);
      }
      b = Math.max(0, Math.min(wPrime, b));
      bal[i] = b;
      if (b <= 0) emptyFor += dt;
      if (b < minBal) { minBal = b; minAt = i; }
    }

    return {
      bal, tau, minBal, minAt, spent, overdraft,
      depleted: minBal <= 0, depletedSeconds: emptyFor,
    };
  }

  /** Normalised power: 30 s rolling average, fourth-power mean, fourth root. */
  function normalizedPower(watts, dt = 1) {
    const w = Math.max(1, Math.round(30 / dt));
    if (watts.length < w) return mean(watts);
    const roll = smoothTrailing(watts, w);
    let s = 0, k = 0;
    for (let i = w - 1; i < roll.length; i++) { s += Math.pow(roll[i], 4); k++; }
    return k ? Math.pow(s / k, 0.25) : mean(watts);
  }

  /** Classic training-stress summary for a ride segment. */
  function loadMetrics(watts, ftp, dt = 1) {
    const np = normalizedPower(watts, dt);
    const avg = mean(watts);
    const seconds = watts.length * dt;
    const intensity = ftp > 0 ? np / ftp : 0;
    return {
      avg,
      np,
      intensity,
      variability: avg > 0 ? np / avg : 0,
      tss: ftp > 0 ? (seconds * np * intensity) / (ftp * 3600) * 100 : 0,
      kj: (avg * seconds) / 1000,
      seconds,
    };
  }

  function mean(a) {
    let s = 0, k = 0;
    for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; k++; }
    return k ? s / k : 0;
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  return {
    G, airDensity, pressureAtAltitude,
    apparentWind, requiredPower, powerCore,
    smooth, smoothTrailing, derivative, gradientSeries, headingSeries, percentile,
    cleanAirCohort, solveCdA, solveWind, headingSpread, windAt,
    wPrimeBalance, normalizedPower, loadMetrics, mean, clamp,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
