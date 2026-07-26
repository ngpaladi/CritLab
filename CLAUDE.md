# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Commands

```bash
bundle install
bundle exec jekyll serve --livereload    # http://localhost:4000/CritLab/

npm install                              # jsdom, for the DOM test
npm test                                 # unit + DOM, offline
npm run test:unit                        # node test/harness.js
npm run test:dom                         # node test/dom.js
npm run test:live                        # hits the network; ICU_KEY optional
```

GitHub Pages builds Jekyll on push. There is no other build step.

## Architecture

**Jekyll + vanilla JS static site.** No framework, no bundler, no runtime
dependencies. Nine plain scripts loaded in order by `_layouts/default.html`.

```
Fit.js         FIT binary decoder
Intervals.js   intervals.icu v1 client
Weather.js     Open-Meteo client + wind-profile maths
Osm.js         OpenStreetMap basemap via Overpass
Physics.js     power model, calibration, W′ balance
Analyzer.js    laps, corners, sectors, surges, summary
Charts.js      canvas rendering
RideStore.js   normalisation, derived series, IndexedDB, Settings
Demo.js        synthetic sample race
app.js         UI orchestration
```

Each module is an IIFE assigned to a top-level `const`. That creates a global
**lexical** binding, not a property on `window` — `window.Physics` is undefined
while bare `Physics` works. Test harnesses have to account for this (see the
`G()` helper in `test/dom.js`).

`Intervals.js` and `RideStore.js` load on every page, because the settings
drawer lives in the layout and uses both. The rest load only where
`page.app` is true.

### Load-order dependencies

`RideStore.curvatureSeries` calls `Analyzer.angleDelta`, and
`Analyzer.exposureByHeading` calls `Weather.compass`. Nothing runs at load time,
so the order in the layout only has to be right by the time `app.js` boots — but
do not reorder casually.

## The data model

Everything downstream of `RideStore.prepare` is a `Float64Array` on a **uniform
1 Hz grid**. Index `i` is the same instant in every series. A prepared ride `P`
carries:

| field | meaning |
|---|---|
| `t, dist, alt, v, watts, hr, cad, temp` | measured, resampled |
| `lat, lon` | degrees, or `null` when the file has no GPS |
| `theta, slope` | road gradient, from a distance-windowed regression |
| `accel` | from smoothed speed |
| `heading` | radians clockwise from north |
| `curvature` | signed 1/radius, positive = turning right |
| `moving` | `Uint8Array`, speed above threshold and not in a gap |
| `gap` | `Uint8Array`, sample synthesised across a recording hole |
| `we, wn` | per-sample wind at rider height, or `null` |

**Recording gaps are never interpolated across.** Distance holds, speed and
power go to zero, `gap[i]` is set, and the analyser skips them. Filling a hole
with invented watts puts phantom efforts in the surge ledger.

## Conventions that matter

- **Angles**: radians clockwise from north internally, degrees at the edges.
- **Wind vectors** are `[east, north]` components of the direction the wind
  blows *toward*. Wind *direction* is always the bearing it blows *from*.
  `Weather.dirToVec` converts; it round-trips, and there is a test for that.
- **Wind speed** is reported at rider height everywhere in the analysis, not at
  the 10 m reference. Both the weather path and the manual path apply
  `Weather.shelterFactor`. Skipping it on one path silently doubles the wind.
- **Chart colour follows the entity, never the rank.** Solo-required power is
  always `--series-1` blue; actual power always `--series-2` orange. Filtering
  must never repaint a series.
- **Draft ratio uses a diverging ramp around 1.0**, interpolated in OKLab, since
  1.0 means something physical: exactly the solo price.
- **One value axis per chart.** Never two y-scales.
- The categorical palette in `main.css` is validated (lightness band, chroma
  floor, CVD separation, contrast) against surface `#161b22`. If you change a
  series colour, re-validate rather than eyeballing it.

## Corner detection

Corners are **not** found by thresholding the raw track's curvature. At 43 km/h
a 1 Hz recorder samples every 12 m, so a 16 m corner is two or three points and
the heading noise between them rivals the turn. That approach reported 31 m
radii for 16 m corners and dropped passes.

Instead `buildMeanLap` stacks every lap onto a shared lap-distance grid and
takes the **median** position at each point — robust to the one lap you took
wide, and noise falls as √n. Corners are detected once on that clean 2 m grid
(with circular wrapping, since start/finish often sits mid-corner), the radius
comes from a least-squares circle fit, and each lap contributes one instance by
construction rather than by hoping the threshold fires again.

`turnsFromTrack` is the fallback for GPS-but-no-laps. Its radii are not
trustworthy and it says so via `turn.source`.

If you change this, the harness asserts the recovered radius against the
simulated circuit's known 16 m arcs — that number is the regression guard.

## Network services

Three, all optional, all CORS-verified in `test/live.js`:

| Service | Used for | Failure mode |
|---|---|---|
| intervals.icu | activities + streams | needs a key; errors surface in the drawer |
| Open-Meteo | historical weather | falls back to inferring wind |
| Overpass | OSM basemap | map draws without a backdrop |

**Overpass is a shared volunteer service.** `overpass-api.de` rejects
non-browser clients with HTTP 406, so it is not the first mirror tried; 429 rate
limiting is routine and handled with a plain-English message. Never add retry
loops against it.

**intervals.icu returns `latlng` as two parallel arrays** — latitudes in `data`,
longitudes in `data2` — not as `[lat, lon]` pairs. Assuming the pair form
silently yields rides with no GPS. `Intervals.coordinates` handles all three
shapes seen in the wild and `test/fixtures/icu-streams.json` is a real captured
response guarding it.

## The central assumption

CritLab does not know the rider's CdA. `Physics.solveCdA` bisects for the CdA
that puts the `cleanAirPct` percentile (default 85th) of the draft ratio at
exactly 1.0 — i.e. "in your least sheltered moments you were paying full price".

This is an assumption, and it is the one knob that moves the absolute exposure
numbers. Consequences to respect when adding features:

- **Never build a user-facing finding on an absolute ratio threshold alone.**
  Findings should also qualify on a *relative* criterion that survives being
  wrong about CdA — e.g. `sectors.leak` is the sector that most often came out
  worst on its own lap, which needs no threshold at all.
- Sector ratios are **medians** across laps, not means, so one attack cannot
  rebrand a stretch as a positioning problem.
- When the model is uncertain, say so. `Physics.solveWind` returns a
  `confidence` derived from how many compass sectors were actually ridden, and
  the UI prints the caveat.

## Testing

`test/harness.js` runs the modules against a **simulated** crit from `Demo.js` —
generated forward through the same power model the analyser runs in reverse,
with known wind, known CdA, four corners, and a positioning leak planted on the
windward straight for 11 of 25 laps. Changes to the physics or the analyser
should be judged on whether the simulated truth still comes back out.

If you change `Demo.js`, remember it is load-bearing: it is the sample race *and*
the test fixture. Keep it physically plausible — the acceleration limit is
derived from a power budget for exactly this reason.

`test/dom.js` builds the site and drives the real page in jsdom with a recording
canvas stub. It catches reference errors in rarely-visited tabs, which nothing
else does.

## Storage keys

| key | where | what |
|---|---|---|
| `cl-settings` | localStorage | all preferences, including the API key |
| `cl-wx-*` | localStorage | cached Open-Meteo bundles, 30-day TTL |
| `critlab` / `rides` | IndexedDB | raw rides, keyed by `id` |

Only the **raw** ride is stored. Derived series are recomputed by `prepare` on
load, which is cheap and avoids stale-schema problems.
