# CritLab

Criterium race analysis in the browser. Load a `.fit` file or pull a ride
straight from intervals.icu, and CritLab works out — second by second — how much
of the race you spent doing your own work and how much you spent on somebody
else's wheel, then shows you where on the circuit you kept getting it wrong.

**[Open the tool →](https://noahpaladino.com/CritLab/)**

No server, no account, no upload. Races live in your browser's IndexedDB.

## Features

- **Draft ratio** — your power against the watts it would have taken to hold the
  same speed, on the same gradient, in the same wind, alone. Around 1.0 you were
  paying full price; 0.6 means someone else was punching the hole.
- **Real weather** — historical temperature, humidity, pressure, wind speed and
  direction for the race's location and hour, from Open-Meteo, interpolated per
  sample and corrected from the 10 m reference height down to rider height.
- **intervals.icu** — browse and load rides directly with an API key. **CritLab
  never receives your key.** There is no CritLab server: the only place it is
  ever sent is intervals.icu itself, straight from your browser. You choose
  whether it is remembered in this browser or dropped when the tab closes.
- **Lap × sector heatmap** — one row per lap, one column per stretch of circuit.
  A column that stays red top to bottom is a positioning habit, not bad luck.
- **Corner ledger** — corners are found on a *median mean lap* stacked from
  every lap of the race, which cuts GPS noise by roughly √n and makes a 1 Hz
  track good enough to measure a 16 m radius. Each corner gets a type, a turn
  angle, a fitted radius, entry and apex speed, speed scrubbed, time to recover
  it, and the work above CP the exit cost you.
- **OpenStreetMap basemap** — roads and buildings drawn under the track as
  vectors (via Overpass, cached), styled for the dark theme. Buildings are not
  decoration: on a town-centre circuit they are why one straight is sheltered.
- **W′ battery** — a live gauge on the replay showing the anaerobic reserve at
  that instant, whether it is draining or refilling, and how it compares to the
  low point of the race.
- **Match ledger and W′ balance** — Skiba's differential model, with efforts
  classified by whether they were launched from a wheel or from the wind, and
  corner-exit accelerations separated from tactical decisions.
- **Circuit map, exposure rose, replay, and race-to-race comparison.**

## Running locally

Requires Ruby and Bundler for the site, Node for the tests.

```bash
bundle install
bundle exec jekyll serve --livereload
# → http://localhost:4000/CritLab/
```

## Tests

```bash
npm install        # jsdom, for the DOM test
npm test           # unit + DOM, no network

npm run test:unit  # physics, FIT round trip, analyser against a synthetic crit
npm run test:dom   # builds the site, boots it in jsdom, drives every tab
npm run test:live  # hits Open-Meteo and intervals.icu for real
```

`test/harness.js` checks the model against a **simulated** crit: 25 laps of a
1.07 km four-corner circuit generated forward through the same power model the
analyser runs in reverse, with a known wind, known CdA, and a positioning leak
deliberately planted on the windward straight for 11 of the 25 laps. The tests
assert that the analyser gets them back.

`test/live.js` needs the network. It verifies that intervals.icu and Open-Meteo
still send the CORS headers a browser needs — the whole frontend-only premise
rests on that — and runs a real ERA5 fetch end to end. Set `ICU_KEY` to also
exercise the intervals.icu list/streams path against your own account.

## Architecture

Jekyll static site on GitHub Pages. No build step beyond Jekyll, no framework,
no bundler, no runtime dependencies.

```
assets/js/
  Fit.js         — FIT binary decoder (base types, endianness, arrays,
                   scale/offset, compressed timestamps, developer fields)
  Intervals.js   — intervals.icu v1 client (Basic auth, activities, streams)
  Weather.js     — Open-Meteo archive + forecast, log wind profile, caching
  Osm.js         — OpenStreetMap basemap via Overpass, with mirror fallback
  Physics.js     — power model, humid air, CdA/wind calibration, W′ balance
  Analyzer.js    — laps, corners, sectors, surges, exposure, findings
  Charts.js      — canvas charts with hover, OKLab diverging ramps
  RideStore.js   — normalisation to a 1 Hz grid, derived series, IndexedDB
  Demo.js        — the synthetic sample race
  app.js         — UI state, events, rendering
index.html       — the analyser
about.html       — what it computes, and what it assumes
```

Loading order matters: `app.js` last, and `Analyzer` before `RideStore` uses it.
The layout wires this up.

### Data flow

1. A `.fit`, an intervals.icu activity, or a JSON dump becomes a **raw ride** —
   irregular samples, arbitrary holes.
2. `RideStore.prepare` resamples it onto a uniform 1 Hz grid and derives
   gradient, heading, curvature and acceleration. Recording gaps are flagged and
   excluded rather than interpolated across, so no power is invented.
3. `Weather` fetches the hourly series and `RideStore.applyWeather` turns it into
   a per-sample wind field at rider height.
4. `Physics` calibrates CdA (and, with no weather, the wind vector too).
5. `Analyzer.run` produces the report; `Charts` draws it; `app.js` narrates it.

### Conventions

- All series are `Float64Array` on a 1 Hz grid. Index `i` means the same instant
  everywhere.
- Angles are radians clockwise from north internally, degrees at the edges.
- Wind vectors are `[east, north]` components of the direction the wind blows
  **toward**; wind *direction* is always the bearing it blows **from**.
- Chart colour follows the entity, never the rank: solo-required power is always
  blue, actual power always orange. Draft ratio uses a diverging ramp around
  1.0, interpolated in OKLab.

## What it assumes

CritLab does not know your CdA. It calibrates one by assuming that in your least
sheltered moments — by default the 85th percentile of steady, fast, pedalling
seconds — you were in clean air, and picking the CdA that puts that moment at a
ratio of exactly 1.0.

That assumption moves the absolute numbers, and the slider for it is in the
rail. It barely moves the *pattern*, which is why findings are ranked by how
often a stretch came out worst on its own lap rather than against an absolute
threshold. See [about.html](about.html) for the full statement of what is
modelled and what is guessed.

## Privacy

CritLab is a static page. No server, no backend, no database, no account, no
analytics — which is what makes the following true by construction rather than
by promise:

- **Your intervals.icu API key never reaches CritLab**, because there is nothing
  to reach. It is sent only to `intervals.icu`, directly from your browser, in
  the `Authorization` header of the request that fetches your rides. No proxy,
  no third party, no intermediary.
- It is kept in its own storage entry — never inside the general settings blob —
  and you choose `localStorage` (remembered) or `sessionStorage` (gone when the
  tab closes). **Forget key** erases both. Keys can also be revoked outright at
  intervals.icu, which invalidates them everywhere.
- **Your rides** live in this browser's IndexedDB and are never uploaded.
- **Open-Meteo** is sent the rounded coordinates and date of a race; **Overpass**
  is sent the bounding box of the circuit. Neither is told who you are, because
  CritLab does not know.

No build step, no minification: open devtools and watch the network tab. Three
hosts, no others.

## License

MIT
