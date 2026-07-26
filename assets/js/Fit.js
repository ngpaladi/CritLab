'use strict';

/**
 * Fit.js — a real FIT (Flexible and Interoperable Data Transfer) decoder.
 *
 * Handles the parts of the spec that actually show up in head-unit files:
 * base types with correct widths and invalid sentinels, per-definition byte
 * order, array fields, scale/offset from the FIT profile, compressed timestamp
 * headers, developer data fields, and chained files (multiple headers back to
 * back). Everything runs off a DataView — no dependencies, no worker needed for
 * a 60-minute crit.
 */
const Fit = (() => {

  // Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z).
  const FIT_EPOCH = 631065600;

  // Semicircles → degrees.
  const SEMI = 180 / 2147483648;

  // ── Base types ────────────────────────────────────────────────────────────
  // Indexed by (base_type_byte & 0x1F).
  const BASE = [
    { name: 'enum',    size: 1, invalid: 0xFF,      read: (d, p) => d.getUint8(p) },
    { name: 'sint8',   size: 1, invalid: 0x7F,      read: (d, p) => d.getInt8(p) },
    { name: 'uint8',   size: 1, invalid: 0xFF,      read: (d, p) => d.getUint8(p) },
    { name: 'sint16',  size: 2, invalid: 0x7FFF,    read: (d, p, le) => d.getInt16(p, le) },
    { name: 'uint16',  size: 2, invalid: 0xFFFF,    read: (d, p, le) => d.getUint16(p, le) },
    { name: 'sint32',  size: 4, invalid: 0x7FFFFFFF,read: (d, p, le) => d.getInt32(p, le) },
    { name: 'uint32',  size: 4, invalid: 0xFFFFFFFF,read: (d, p, le) => d.getUint32(p, le) },
    { name: 'string',  size: 1, invalid: 0x00,      read: (d, p) => d.getUint8(p) },
    { name: 'float32', size: 4, invalid: null,      read: (d, p, le) => d.getFloat32(p, le) },
    { name: 'float64', size: 8, invalid: null,      read: (d, p, le) => d.getFloat64(p, le) },
    { name: 'uint8z',  size: 1, invalid: 0,         read: (d, p) => d.getUint8(p) },
    { name: 'uint16z', size: 2, invalid: 0,         read: (d, p, le) => d.getUint16(p, le) },
    { name: 'uint32z', size: 4, invalid: 0,         read: (d, p, le) => d.getUint32(p, le) },
    { name: 'byte',    size: 1, invalid: 0xFF,      read: (d, p) => d.getUint8(p) },
    { name: 'sint64',  size: 8, invalid: null,      read: (d, p, le) => Number(d.getBigInt64(p, le)) },
    { name: 'uint64',  size: 8, invalid: null,      read: (d, p, le) => Number(d.getBigUint64(p, le)) },
    { name: 'uint64z', size: 8, invalid: 0,         read: (d, p, le) => Number(d.getBigUint64(p, le)) },
  ];

  // ── Message + field profile ───────────────────────────────────────────────
  // Only the messages CritLab reads. `s` = divisor, `o` = offset subtracted
  // after scaling (FIT applies value/scale - offset).

  const MSG = {
    0:   'file_id',
    12:  'sport',
    18:  'session',
    19:  'lap',
    20:  'record',
    21:  'event',
    23:  'device_info',
    34:  'activity',
    206: 'field_description',
    207: 'developer_data_id',
  };

  const FIELDS = {
    file_id: {
      0: { n: 'type' }, 1: { n: 'manufacturer' }, 2: { n: 'product' },
      3: { n: 'serial_number' }, 4: { n: 'time_created' }, 5: { n: 'number' },
      8: { n: 'product_name' },
    },
    sport: { 0: { n: 'sport' }, 1: { n: 'sub_sport' }, 3: { n: 'name' } },
    record: {
      0:   { n: 'lat',        s: 1 / SEMI },       // stored as semicircles
      1:   { n: 'lon',        s: 1 / SEMI },
      2:   { n: 'alt',        s: 5, o: 500 },
      3:   { n: 'hr' },
      4:   { n: 'cad' },
      5:   { n: 'dist',       s: 100 },
      6:   { n: 'v',          s: 1000 },
      7:   { n: 'watts' },
      9:   { n: 'grade',      s: 100 },
      13:  { n: 'temp' },
      30:  { n: 'lr_balance' },
      53:  { n: 'frac_cad',   s: 128 },
      73:  { n: 'v',          s: 1000, pri: 1 },   // enhanced_speed beats field 6
      78:  { n: 'alt',        s: 5, o: 500, pri: 1 }, // enhanced_altitude beats field 2
      253: { n: 'timestamp' },
    },
    lap: {
      2:   { n: 'start_time' },
      3:   { n: 'start_lat',  s: 1 / SEMI },
      4:   { n: 'start_lon',  s: 1 / SEMI },
      5:   { n: 'end_lat',    s: 1 / SEMI },
      6:   { n: 'end_lon',    s: 1 / SEMI },
      7:   { n: 'elapsed',    s: 1000 },
      8:   { n: 'timer',      s: 1000 },
      9:   { n: 'distance',   s: 100 },
      11:  { n: 'calories' },
      13:  { n: 'avg_speed',  s: 1000 },
      14:  { n: 'max_speed',  s: 1000 },
      15:  { n: 'avg_hr' },
      16:  { n: 'max_hr' },
      17:  { n: 'avg_cad' },
      19:  { n: 'avg_power' },
      20:  { n: 'max_power' },
      21:  { n: 'ascent' },
      22:  { n: 'descent' },
      24:  { n: 'trigger' },
      253: { n: 'timestamp' },
      254: { n: 'index' },
    },
    session: {
      2:   { n: 'start_time' },
      3:   { n: 'start_lat',  s: 1 / SEMI },
      4:   { n: 'start_lon',  s: 1 / SEMI },
      5:   { n: 'sport' },
      6:   { n: 'sub_sport' },
      7:   { n: 'elapsed',    s: 1000 },
      8:   { n: 'timer',      s: 1000 },
      9:   { n: 'distance',   s: 100 },
      11:  { n: 'calories' },
      14:  { n: 'avg_speed',  s: 1000 },
      15:  { n: 'max_speed',  s: 1000 },
      16:  { n: 'avg_hr' },
      17:  { n: 'max_hr' },
      18:  { n: 'avg_cad' },
      20:  { n: 'avg_power' },
      21:  { n: 'max_power' },
      22:  { n: 'ascent' },
      23:  { n: 'descent' },
      34:  { n: 'np' },
      48:  { n: 'work',       s: 1 },
      253: { n: 'timestamp' },
    },
    event: {
      0: { n: 'event' }, 1: { n: 'event_type' }, 3: { n: 'data' },
      253: { n: 'timestamp' },
    },
    activity: {
      0: { n: 'total_timer_time', s: 1000 },
      1: { n: 'num_sessions' }, 2: { n: 'type' }, 3: { n: 'event' },
      4: { n: 'event_type' }, 5: { n: 'local_timestamp' },
      253: { n: 'timestamp' },
    },
    field_description: {
      0: { n: 'developer_data_index' },
      1: { n: 'field_definition_number' },
      2: { n: 'fit_base_type_id' },
      3: { n: 'field_name' },
      8: { n: 'units' },
      14: { n: 'native_mesg_num' },
      15: { n: 'native_field_num' },
    },
    developer_data_id: { 1: { n: 'application_id' }, 3: { n: 'developer_data_index' } },
  };

  // ── Header ────────────────────────────────────────────────────────────────

  function readHeader(dv, at) {
    if (at + 12 > dv.byteLength) return null;
    const size = dv.getUint8(at);
    if (size !== 12 && size !== 14) return null;
    const magic = String.fromCharCode(
      dv.getUint8(at + 8), dv.getUint8(at + 9), dv.getUint8(at + 10), dv.getUint8(at + 11)
    );
    if (magic !== '.FIT') return null;
    return {
      size,
      protocol: dv.getUint8(at + 1),
      profile: dv.getUint16(at + 2, true),
      dataSize: dv.getUint32(at + 4, true),
    };
  }

  // ── Field reading ─────────────────────────────────────────────────────────

  function readField(dv, pos, size, baseTypeByte, littleEndian) {
    const bt = BASE[baseTypeByte & 0x1F] || BASE[13];

    if (bt.name === 'string') {
      let s = '';
      for (let k = 0; k < size; k++) {
        const c = dv.getUint8(pos + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.length ? s : null;
    }

    const count = Math.max(1, Math.floor(size / bt.size));
    const out = [];
    for (let k = 0; k < count; k++) {
      const p = pos + k * bt.size;
      if (p + bt.size > dv.byteLength) { out.push(null); continue; }
      let raw;
      try { raw = bt.read(dv, p, littleEndian); } catch (_) { raw = null; }
      if (raw === null || (bt.invalid !== null && raw === bt.invalid)) raw = null;
      out.push(raw);
    }
    // Single-value fields (the overwhelming majority) unwrap to a scalar.
    return count === 1 ? out[0] : out;
  }

  function applyProfile(msgName, fieldNum, raw) {
    const spec = FIELDS[msgName] && FIELDS[msgName][fieldNum];
    if (!spec) return null;
    const pri = spec.pri || 0;
    if (raw === null || raw === undefined) return { name: spec.n, value: null, pri };
    let v = raw;
    if (typeof v === 'number') {
      if (spec.s) v = v / spec.s;
      if (spec.o) v = v - spec.o;
    }
    return { name: spec.n, value: v, pri };
  }

  // ── Decoder ───────────────────────────────────────────────────────────────

  /**
   * Decode a FIT ArrayBuffer.
   * @returns {{records:Array, laps:Array, sessions:Array, events:Array,
   *            fileId:Object|null, sport:Object|null, devFields:Object,
   *            truncated:boolean}}
   */
  function decode(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 14) throw new Error('File is too small to be a FIT file.');

    const out = {
      records: [], laps: [], sessions: [], events: [],
      fileId: null, sport: null, devFields: {}, truncated: false,
    };

    let segStart = 0;
    let segments = 0;

    while (segStart + 12 <= dv.byteLength) {
      const hdr = readHeader(dv, segStart);
      if (!hdr) {
        if (segments === 0) throw new Error('Not a FIT file (missing .FIT signature).');
        break;
      }
      segments++;

      let pos = segStart + hdr.size;
      const end = Math.min(segStart + hdr.size + hdr.dataSize, dv.byteLength);
      if (segStart + hdr.size + hdr.dataSize > dv.byteLength) out.truncated = true;

      const defs = {};          // local message type → definition
      const devDefs = {};       // "devIdx:fieldNum" → { name, baseType, scale, offset }
      let lastTimestamp = null;

      while (pos < end) {
        const h = dv.getUint8(pos++);

        // Compressed timestamp header.
        if (h & 0x80) {
          const local = (h >> 5) & 0x03;
          const offset = h & 0x1F;
          const def = defs[local];
          if (!def) break;
          if (lastTimestamp !== null) {
            const prevLow = lastTimestamp & 0x1F;
            lastTimestamp += (offset - prevLow) + (offset < prevLow ? 0x20 : 0);
          }
          const r = readDataMessage(dv, pos, def, devDefs);
          pos = r.pos;
          if (lastTimestamp !== null && r.msg && r.msg.timestamp === undefined) {
            r.msg.timestamp = lastTimestamp;
          }
          collect(out, def.msgName, r.msg, devDefs);
          continue;
        }

        // Definition message.
        if (h & 0x40) {
          const local = h & 0x0F;
          pos++;                                     // reserved
          const little = dv.getUint8(pos++) === 0;
          const globalNum = dv.getUint16(pos, little); pos += 2;
          const nFields = dv.getUint8(pos++);

          const fields = [];
          for (let f = 0; f < nFields; f++) {
            fields.push({
              num: dv.getUint8(pos), size: dv.getUint8(pos + 1), base: dv.getUint8(pos + 2),
            });
            pos += 3;
          }

          const devFields = [];
          if (h & 0x20) {
            const nDev = dv.getUint8(pos++);
            for (let f = 0; f < nDev; f++) {
              devFields.push({
                num: dv.getUint8(pos), size: dv.getUint8(pos + 1), devIdx: dv.getUint8(pos + 2),
              });
              pos += 3;
            }
          }

          defs[local] = {
            globalNum,
            msgName: MSG[globalNum] || null,
            little,
            fields,
            devFields,
          };
          continue;
        }

        // Normal data message.
        const local = h & 0x0F;
        const def = defs[local];
        if (!def) break;                             // stream desync — stop this segment
        const r = readDataMessage(dv, pos, def, devDefs);
        pos = r.pos;
        if (r.msg && typeof r.msg.timestamp === 'number') lastTimestamp = r.msg.timestamp;
        collect(out, def.msgName, r.msg, devDefs);
      }

      // Advance past this segment's data and its 2-byte CRC.
      segStart = segStart + hdr.size + hdr.dataSize + 2;
      if (segments > 32) break;                      // pathological file guard
    }

    if (!out.records.length) throw new Error('No record messages found in this FIT file.');
    return out;
  }

  function readDataMessage(dv, pos, def, devDefs) {
    const msg = def.msgName ? {} : null;
    const seenPri = msg ? {} : null;   // field name → priority of the value we kept

    for (const f of def.fields) {
      if (msg) {
        const raw = readField(dv, pos, f.size, f.base, def.little);
        const hit = applyProfile(def.msgName, f.num, raw);
        // `record` maps two field numbers onto one name (altitude vs
        // enhanced_altitude, speed vs enhanced_speed). Higher priority wins
        // regardless of definition order; a real value always beats a null.
        if (hit) {
          const cur = msg[hit.name];
          const curPri = seenPri[hit.name];
          const take = cur === undefined
            || (cur === null && hit.value !== null)
            || (hit.value !== null && hit.pri > curPri);
          if (take) { msg[hit.name] = hit.value; seenPri[hit.name] = hit.pri; }
        }
      }
      pos += f.size;
    }

    for (const f of def.devFields) {
      if (msg) {
        const key = f.devIdx + ':' + f.num;
        const spec = devDefs[key];
        if (spec) {
          const raw = readField(dv, pos, f.size, spec.baseType, def.little);
          if (raw !== null) {
            msg.dev = msg.dev || {};
            msg.dev[spec.name] = raw;
          }
        }
      }
      pos += f.size;
    }

    return { pos, msg };
  }

  function collect(out, msgName, msg, devDefs) {
    if (!msgName || !msg) return;
    switch (msgName) {
      case 'record':   out.records.push(msg); break;
      case 'lap':      out.laps.push(msg); break;
      case 'session':  out.sessions.push(msg); break;
      case 'event':    out.events.push(msg); break;
      case 'file_id':  if (!out.fileId) out.fileId = msg; break;
      case 'sport':    if (!out.sport) out.sport = msg; break;
      case 'field_description': {
        const key = msg.developer_data_index + ':' + msg.field_definition_number;
        devDefs[key] = {
          name: msg.field_name || ('dev_' + key),
          baseType: msg.fit_base_type_id != null ? msg.fit_base_type_id : 2,
          units: msg.units || '',
        };
        out.devFields[key] = devDefs[key];
        break;
      }
      default: break;
    }
  }

  // ── Normalisation ─────────────────────────────────────────────────────────

  const SPORT_NAMES = { 0: 'generic', 1: 'running', 2: 'cycling', 5: 'swimming' };

  /**
   * Turn a decoded FIT into CritLab's raw ride shape (irregular samples; the
   * RideStore resamples it onto a 1 Hz grid).
   */
  function toRide(dec, filename) {
    const recs = dec.records.filter(r => typeof r.timestamp === 'number');
    if (!recs.length) throw new Error('FIT records have no timestamps.');
    recs.sort((a, b) => a.timestamp - b.timestamp);

    const n = recs.length;
    const t = new Array(n), lat = new Array(n), lon = new Array(n);
    const alt = new Array(n), v = new Array(n), watts = new Array(n);
    const hr = new Array(n), cad = new Array(n), dist = new Array(n), temp = new Array(n);

    let anyLatLon = false, anyWatts = false, anyHr = false, anyCad = false, anyTemp = false;

    for (let i = 0; i < n; i++) {
      const r = recs[i];
      t[i] = r.timestamp;
      lat[i] = num(r.lat); lon[i] = num(r.lon);
      if (lat[i] !== null && lon[i] !== null && (lat[i] !== 0 || lon[i] !== 0)) anyLatLon = true;
      alt[i] = num(r.alt);
      v[i] = num(r.v);
      watts[i] = num(r.watts);   if (watts[i] !== null) anyWatts = true;
      hr[i] = num(r.hr);         if (hr[i] !== null) anyHr = true;
      cad[i] = num(r.cad);       if (cad[i] !== null) anyCad = true;
      dist[i] = num(r.dist);
      temp[i] = num(r.temp);     if (temp[i] !== null) anyTemp = true;
    }

    const s = dec.sessions[0] || {};
    const startUnix = t[0] + FIT_EPOCH;

    // Lap boundaries as absolute FIT timestamps; RideStore maps them to indices.
    const lapEnds = dec.laps
      .map(l => (typeof l.timestamp === 'number' ? l.timestamp : null))
      .filter(x => x !== null)
      .sort((a, b) => a - b);

    const sportNum = s.sport != null ? s.sport : (dec.sport ? dec.sport.sport : null);

    return {
      source: 'fit',
      name: (dec.sport && dec.sport.name) || guessName(filename, startUnix),
      startTime: startUnix,
      sport: SPORT_NAMES[sportNum] || 'cycling',
      n,
      t: t.map(x => x - t[0]),
      lat: anyLatLon ? lat : null,
      lon: anyLatLon ? lon : null,
      alt, v,
      watts: anyWatts ? watts : null,
      hr: anyHr ? hr : null,
      cad: anyCad ? cad : null,
      dist,
      temp: anyTemp ? temp : null,
      lapTimes: lapEnds.map(x => x - t[0]),
      device: dec.fileId ? dec.fileId.manufacturer : null,
      totals: {
        distance: num(s.distance),
        elapsed: num(s.elapsed),
        timer: num(s.timer),
        avgPower: num(s.avg_power),
        maxPower: num(s.max_power),
        np: num(s.np),
        ascent: num(s.ascent),
        calories: num(s.calories),
      },
      truncated: dec.truncated,
    };
  }

  function num(x) {
    if (x === null || x === undefined) return null;
    if (Array.isArray(x)) x = x[0];
    return typeof x === 'number' && isFinite(x) ? x : null;
  }

  function guessName(filename, startUnix) {
    const base = String(filename || 'Race').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (base && !/^\d+$/.test(base)) return base;
    return 'Race ' + new Date(startUnix * 1000).toISOString().slice(0, 10);
  }

  /** Convenience: ArrayBuffer → normalised raw ride. */
  function parse(buffer, filename) {
    return toRide(decode(buffer), filename);
  }

  return { decode, toRide, parse, FIT_EPOCH, BASE, MSG, FIELDS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Fit;
