'use strict';

/**
 * Osm.js — an OpenStreetMap basemap for the circuit, as vectors.
 *
 * Roads and buildings come from the Overpass API rather than raster tiles.
 * That is a deliberate choice for this app:
 *
 *   · Standard OSM tiles are a light cartography that fights a dark UI, and
 *     recolouring raster tiles convincingly is not possible.
 *   · One request per circuit, cached, instead of a dozen tile fetches — and
 *     the OSM tile usage policy discourages app traffic anyway.
 *   · Vectors can be styled to sit *underneath* the exposure colours without
 *     competing with them, which is the whole point of a basemap here.
 *   · Building footprints are not decoration: on a town-centre circuit they
 *     are the reason one straight is sheltered and another is not.
 *
 * Data © OpenStreetMap contributors, ODbL. Attribution is drawn on the map.
 */
const Osm = (() => {

  // Overpass instances, tried in order. The main overpass-api.de endpoint
  // rejects some clients outright (HTTP 406), so it is not first.
  const MIRRORS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  const ATTRIBUTION = '© OpenStreetMap contributors';

  const CACHE_PREFIX = 'cl-osm-';
  const CACHE_TTL_MS = 60 * 24 * 3600 * 1000;   // OSM changes slowly
  const MAX_DIAGONAL_KM = 15;                   // refuse to map a road race
  const TIMEOUT_MS = 25000;

  // Highway values grouped by how prominently they should be drawn.
  const ROAD_CLASS = {
    motorway: 'major', motorway_link: 'major', trunk: 'major', trunk_link: 'major',
    primary: 'major', primary_link: 'major',
    secondary: 'medium', secondary_link: 'medium', tertiary: 'medium', tertiary_link: 'medium',
    residential: 'minor', unclassified: 'minor', living_street: 'minor',
    service: 'minor', road: 'minor',
    footway: 'path', path: 'path', cycleway: 'path', track: 'path',
    bridleway: 'path', steps: 'path', pedestrian: 'path', corridor: 'path',
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────

  /**
   * @param {{minLat, minLon, maxLat, maxLon}} bbox
   * @returns {Promise<Object>} basemap bundle
   */
  async function fetchFor(bbox, { padFrac = 0.25 } = {}) {
    const b = pad(bbox, padFrac);
    const diag = haversineKm(b.minLat, b.minLon, b.maxLat, b.maxLon);
    if (!isFinite(diag)) throw new Error('This ride has no usable GPS bounds.');
    if (diag > MAX_DIAGONAL_KM) {
      throw new Error('The course spans ' + diag.toFixed(0) + ' km — too large for a basemap.');
    }

    const key = CACHE_PREFIX + [b.minLat, b.minLon, b.maxLat, b.maxLon]
      .map(v => v.toFixed(4)).join('_');
    const hit = readCache(key);
    if (hit) { hit.cached = true; return hit; }

    const query = buildQuery(b);
    let lastErr = null;
    for (const mirror of MIRRORS) {
      try {
        const body = await post(mirror, query);
        const bundle = parse(body, b);
        bundle.mirror = mirror;
        writeCache(key, bundle);
        return bundle;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No Overpass mirror responded.');
  }

  function buildQuery(b) {
    const box = [b.minLat, b.minLon, b.maxLat, b.maxLon].map(v => v.toFixed(5)).join(',');
    return '[out:json][timeout:' + Math.round(TIMEOUT_MS / 1000) + '];(' +
      'way["highway"](' + box + ');' +
      'way["building"](' + box + ');' +
      'way["natural"="water"](' + box + ');' +
      'way["waterway"="riverbank"](' + box + ');' +
      'way["leisure"~"^(park|pitch|track)$"](' + box + ');' +
      ');out geom;';
  }

  async function post(url, query) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS + 5000) : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller ? controller.signal : undefined,
      });
      // Overpass is a free, shared, volunteer-run service and it says no when
      // it is busy. Both of these are normal and neither is worth a stack trace.
      if (res.status === 429) throw new Error('Overpass is rate-limiting — try again in a minute.');
      if (res.status === 504) throw new Error('Overpass timed out on this area.');
      if (!res.ok) throw new Error('Overpass returned HTTP ' + res.status);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Reduce the Overpass payload to just the geometry the map draws. */
  function parse(body, bbox) {
    const roads = [], buildings = [], water = [], areas = [];
    const els = (body && body.elements) || [];

    for (const el of els) {
      const g = el.geometry;
      if (!Array.isArray(g) || g.length < 2) continue;
      const tags = el.tags || {};
      const pts = g.map(p => [round6(p.lat), round6(p.lon)]);

      if (tags.highway) {
        const cls = ROAD_CLASS[tags.highway];
        if (!cls) continue;
        roads.push({ cls, name: tags.name || null, pts });
      } else if (tags.building) {
        buildings.push(pts);
      } else if (tags.natural === 'water' || tags.waterway === 'riverbank') {
        water.push(pts);
      } else if (tags.leisure) {
        areas.push({ kind: tags.leisure, pts });
      }
    }

    return {
      roads, buildings, water, areas, bbox,
      counts: { roads: roads.length, buildings: buildings.length, water: water.length, areas: areas.length },
      points: roads.reduce((s, r) => s + r.pts.length, 0) +
              buildings.reduce((s, p) => s + p.length, 0),
      attribution: ATTRIBUTION,
      fetchedAt: Date.now(),
    };
  }

  // ── Geometry helpers ──────────────────────────────────────────────────────

  /** Bounding box of a prepared ride's track, or null when there is no GPS. */
  function boundsOf(P) {
    if (!P.lat) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < P.n; i++) {
      const la = P.lat[i], lo = P.lon[i];
      if (!la && !lo) continue;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
    return isFinite(minLat) ? { minLat, minLon, maxLat, maxLon } : null;
  }

  function pad(b, frac) {
    const dLat = Math.max(0.0008, (b.maxLat - b.minLat) * frac);
    const dLon = Math.max(0.0010, (b.maxLon - b.minLon) * frac);
    return {
      minLat: b.minLat - dLat, maxLat: b.maxLat + dLat,
      minLon: b.minLon - dLon, maxLon: b.maxLon + dLon,
    };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, D = Math.PI / 180;
    const dLat = (lat2 - lat1) * D, dLon = (lon2 - lon1) * D;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  // ── Cache ─────────────────────────────────────────────────────────────────

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || !v.fetchedAt || Date.now() - v.fetchedAt > CACHE_TTL_MS) return null;
      return v;
    } catch (_) { return null; }
  }

  function writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_) { /* quota — the map simply refetches next time */ }
  }

  function clearCache() {
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) doomed.push(k);
      }
      doomed.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
  }

  return {
    fetchFor, boundsOf, parse, buildQuery, clearCache,
    MIRRORS, ATTRIBUTION, ROAD_CLASS, MAX_DIAGONAL_KM,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Osm;
