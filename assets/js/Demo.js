'use strict';

/**
 * Demo.js — a synthetic crit, generated rather than recorded.
 *
 * The ride is simulated forward through the *same* power model the analyser
 * uses in reverse: a rounded-rectangle circuit, a braking/accelerating speed
 * profile that respects corner radii, a real wind, and a draft factor that is
 * deliberately made to leak in one place. That makes it both a demo and a
 * round-trip check — the analyser should recover the corners, the wind and the
 * leak that were put in.
 *
 * It carries no start timestamp on purpose: with no date there is no weather to
 * fetch, so the app falls back to inferring the wind from the power data, which
 * is exactly the case worth demonstrating.
 */
const Demo = (() => {

  // Circuit: 380 m × 170 m rounded rectangle, long axis on an ENE/WSW bearing,
  // so one straight runs straight into the wind.
  const A_HALF = 190, B_HALF = 85, CORNER_R = 16;
  const BEARING = 70 * Math.PI / 180;
  const ORIGIN = { lat: 42.5450, lon: -71.6150 };

  const LAPS = 25;
  const V_STRAIGHT = 11.9;      // m/s on the straights when the pace is on (~43 km/h)
  const A_LAT = 6.2;            // m/s² cornering limit
  const A_DECEL = 3.4;          // braking is limited by grip, not by fitness

  // Acceleration is *not* limited by a constant: it is limited by what the
  // rider on the front can actually produce. A fixed 2 m/s² at 13 m/s would
  // demand well over 2 kW. So the sim caps the group's power instead and
  // solves for the acceleration that power buys.
  const P_GROUP_MAX = 620;      // W the rider on the front is willing to hold
  const P_GROUP_CRUISE = 430;

  // Truth values the analyser is meant to find again.
  const TRUE_WIND_SPEED = 2.6;  // m/s at rider height
  const TRUE_WIND_FROM = 250;   // WSW — straight down the back straight
  const TRUE_CDA = 0.318;
  const TRUE_CRR = 0.0042;
  const MASS = 79.5;
  // The simulated rider averages ~275 W for 40 minutes with an NP around 320.
  // CP has to sit above that average or W′ drains monotonically to zero in the
  // first ten minutes and stays pinned there, which is neither survivable nor a
  // useful illustration of the fatigue model.
  const CP = 300;

  /** Deterministic PRNG so the sample race is the same every time. */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Circuit geometry ──────────────────────────────────────────────────────

  /** Sample the circuit at ~1 m spacing: local x/y, heading, curvature. */
  function buildPath() {
    const pts = [];
    const push = (x, y, heading, curv) => pts.push({ x, y, heading, curv });

    const sx = A_HALF - CORNER_R, sy = B_HALF - CORNER_R;
    const straight = (x0, y0, x1, y1) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.round(len));
      const hd = Math.atan2(x1 - x0, y1 - y0);
      for (let i = 0; i < n; i++) {
        const f = i / n;
        push(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, hd, 0);
      }
    };
    const arc = (cx, cy, from, to) => {
      const span = to - from;
      const len = Math.abs(span) * CORNER_R;
      const n = Math.max(2, Math.round(len));
      for (let i = 0; i < n; i++) {
        const th = from + span * (i / n);
        const x = cx + Math.cos(th) * CORNER_R;
        const y = cy + Math.sin(th) * CORNER_R;
        // Travelling clockwise, heading is tangent rotated −90°.
        const hd = Math.atan2(Math.cos(th) * Math.sign(span), -Math.sin(th) * Math.sign(span));
        push(x, y, hd, Math.sign(span) * -1 / CORNER_R);
      }
    };

    // Clockwise: top straight (+x), T1, right side (−y), T2, bottom (−x), T3,
    // left side (+y), T4.
    straight(-sx, B_HALF, sx, B_HALF);
    arc(sx, sy, Math.PI / 2, 0);
    straight(A_HALF, sy, A_HALF, -sy);
    arc(sx, -sy, 0, -Math.PI / 2);
    straight(sx, -B_HALF, -sx, -B_HALF);
    arc(-sx, -sy, -Math.PI / 2, -Math.PI);
    straight(-A_HALF, -sy, -A_HALF, sy);
    arc(-sx, sy, Math.PI, Math.PI / 2);

    // Arc-length coordinate and true heading between consecutive points.
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const d = Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      pts[i].s = s;
      pts[i].ds = d;
      pts[i].heading = Math.atan2(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
      s += d;
    }
    return { pts, length: s };
  }

  /** Corner-limited speed with a backward braking pass. */
  function speedProfile(path) {
    const { pts } = path;
    const n = pts.length;
    const lim = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.abs(pts[i].curv);
      lim[i] = k > 1e-6 ? Math.min(V_STRAIGHT, Math.sqrt(A_LAT / k)) : V_STRAIGHT;
    }
    // Two wrapped backward passes so braking zones reach back into the straight.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const j = (k + 1) % n;
        const cap = Math.sqrt(lim[j] * lim[j] + 2 * A_DECEL * pts[k].ds);
        if (cap < lim[k]) lim[k] = cap;
      }
    }
    return lim;
  }

  // ── Simulation ────────────────────────────────────────────────────────────

  function build() {
    const path = buildPath();
    const lim = speedProfile(path);
    const L = path.length;
    const rand = rng(20260726);

    const [we, wn] = Weather.dirToVec(TRUE_WIND_SPEED, TRUE_WIND_FROM);
    const rho = Physics.airDensity(24, 100900, 62);

    // Where the leak lives: the WSW straight, into the wind — roughly the
    // stretch between turns 2 and 3 in lap-fraction terms.
    const leakFrom = 0.52, leakTo = 0.76;
    const leakLaps = new Set([3, 4, 8, 9, 13, 17, 18, 22, 23, 24, 25]);

    // Scripted efforts: [lap, lap-fraction, seconds, watts]
    const attacks = [
      [6, 0.05, 14, 610], [10, 0.30, 11, 585], [12, 0.78, 18, 520],
      [16, 0.10, 13, 640], [19, 0.55, 22, 505], [21, 0.02, 12, 600],
      [24, 0.62, 16, 575], [25, 0.80, 26, 640],
    ];

    const t = [], lat = [], lon = [], alt = [], v = [], watts = [], dist = [];
    const mLat = 111320, mLon = 111320 * Math.cos(ORIGIN.lat * Math.PI / 180);

    let s = 0, speed = 6, elapsed = 0, prevSpeed = 6;
    const totalLen = L * LAPS;
    let guard = 0;

    while (s < totalLen && guard++ < 20000) {
      const lap = Math.floor(s / L) + 1;
      const sLap = s % L;
      const frac = sLap / L;

      // Nearest path point.
      let pi = 0;
      { // path points are ~1 m apart, so index ≈ arc length
        pi = Math.min(path.pts.length - 1, Math.max(0, Math.round(sLap)));
        while (pi > 0 && path.pts[pi].s > sLap) pi--;
        while (pi < path.pts.length - 1 && path.pts[pi + 1].s <= sLap) pi++;
      }
      const p = path.pts[pi];

      // Race pace: neutral first lap, a lift for the last three.
      let pace = 1;
      if (lap === 1) pace = 0.86;
      else if (lap >= LAPS - 2) pace = 1.06;
      pace *= 0.985 + 0.03 * rand();

      const target = lim[pi] * pace;
      const ds = Math.max(0.5, speed);
      const theta = Math.atan(gradeAt(frac));
      const model = { mass: MASS, crr: TRUE_CRR, cda: TRUE_CDA, rho, driveEff: 0.976, rotMass: 1.2, yawK: 0.15, we, wn };

      if (speed < target) {
        // Power the group is putting out, minus what holding this speed costs,
        // is what is left over to accelerate with.
        const hold = Physics.requiredPower({ v: speed, theta, a: 0, heading: p.heading }, model);
        const budget = (speed > target * 0.93 ? P_GROUP_CRUISE : P_GROUP_MAX);
        const spare = Math.max(0, (budget - hold)) * 0.976 / Math.max(1, speed);
        const aMax = spare / (MASS + 1.2);
        speed = Math.min(target, speed + aMax);
      } else {
        speed = Math.max(target, Math.sqrt(Math.max(0, speed * speed - 2 * A_DECEL * ds)));
      }

      const accel = speed - prevSpeed;
      prevSpeed = speed;

      // Elevation: a gentle rise and fall so the gradient model has work to do.
      const elev = 84 + 2.6 * Math.sin((frac * 2 * Math.PI) + 0.7);

      // What it would cost alone, right now.
      const solo = Math.max(0, Physics.requiredPower(
        { v: speed, theta, a: accel, heading: p.heading }, model
      ));

      // Draft factor: deep in the bunch most of the time (a wheel is worth
      // roughly 40–45% at these speeds); exposed on the windward straight on
      // the laps where the positioning slipped.
      let draft = 0.55 + 0.06 * rand();
      const inLeak = frac >= leakFrom && frac <= leakTo;
      if (inLeak && leakLaps.has(lap)) draft = 0.92 + 0.08 * rand();
      if (lap >= LAPS - 2) draft += 0.12;                  // front of the race late on
      if (Math.abs(p.curv) > 1e-6) draft = Math.min(1.02, draft + 0.08);  // less shelter mid-corner

      let w = solo * draft;

      // Coasting into the corners. Out of them you are on the wheel in front,
      // so you pay the group's accelerating power rather than a multiple of it.
      if (accel < -0.9) w *= 0.12;
      if (accel > 0.25 && Math.abs(p.curv) < 1e-6) w = Math.max(w, solo * Math.min(1.0, draft + 0.10));

      // Scripted attacks and chases.
      for (const [aLap, aFrac, aSec, aW] of attacks) {
        if (lap === aLap) {
          const startS = aFrac * L;
          const dS = sLap - startS;
          if (dS >= 0 && dS < aSec * speed) w = aW * (0.92 + 0.16 * rand());
        }
      }

      w = Math.max(0, w * (0.95 + 0.1 * rand()));

      t.push(elapsed);
      dist.push(s);
      v.push(speed);
      watts.push(Math.round(w));
      alt.push(elev);
      lat.push(ORIGIN.lat + rot(p.x, p.y).n / mLat + jitter(rand));
      lon.push(ORIGIN.lon + rot(p.x, p.y).e / mLon + jitter(rand));

      s += speed;
      elapsed += 1;
    }

    // Roll-out and a short cool-down so the moving/stopped logic gets exercised.
    for (let k = 0; k < 25; k++) {
      const decay = Math.max(0, 8 - k * 0.4);
      t.push(elapsed++);
      dist.push(s += decay);
      v.push(decay);
      watts.push(Math.round(40 * (decay / 8)));
      alt.push(84);
      lat.push(lat[lat.length - 1]);
      lon.push(lon[lon.length - 1]);
    }

    return {
      id: 'demo-sample-crit',
      source: 'demo',
      name: 'Sample crit (synthetic)',
      startTime: null,          // no date → no weather → wind gets inferred
      sport: 'cycling',
      n: t.length,
      t, lat, lon, alt, v, watts, dist,
      hr: null, cad: null, temp: null,
      lapTimes: [],
      ftp: 265,
      weightKg: 70.5,
      cp: CP,
      wPrime: 21500,
      totals: {},
      truth: {                  // what was actually simulated, for reference
        windSpeed: TRUE_WIND_SPEED, windFrom: TRUE_WIND_FROM,
        cda: TRUE_CDA, crr: TRUE_CRR, mass: MASS, laps: LAPS,
        lapLength: L, corners: 4,
      },
    };
  }

  function rot(x, y) {
    return {
      e: x * Math.sin(BEARING) - y * Math.cos(BEARING),
      n: x * Math.cos(BEARING) + y * Math.sin(BEARING),
    };
  }

  function gradeAt(frac) {
    // Derivative of the elevation sinusoid with respect to distance.
    return (2.6 * 2 * Math.PI * Math.cos(frac * 2 * Math.PI + 0.7)) / 1072;
  }

  function jitter(rand) { return (rand() - 0.5) * 1.2e-5; }   // ~±0.7 m of GPS noise

  return { build, buildPath, speedProfile, ORIGIN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Demo;
