// Minimal Garmin FIT decoder — just enough to pull GPS track points out of
// "record" messages. Shared by the replay app (app.js) and upload.html.
//
//   parseFIT(Uint8Array) → [{ t, lat, lon, sog? }, …]   (t = Unix seconds)
//
// FIT layout: a 12/14-byte file header, then a stream of records. Each record
// is either a definition message (declares the field layout for a "local
// message type" 0–15) or a data message using the latest definition for its
// local type. Compressed-timestamp headers pack a 5-bit time offset into the
// record header. Several FIT files may be chained back to back.
// Spec: https://developer.garmin.com/fit/protocol/
(function () {
  const FIT_EPOCH = 631065600;          // 1989-12-31T00:00:00Z in Unix seconds
  const SEMI_TO_DEG = 180 / 2 ** 31;
  const MPS_TO_KN = 1.943844;
  const MSG_RECORD = 20;
  const F_TIMESTAMP = 253, F_LAT = 0, F_LON = 1, F_SPEED = 6, F_ENH_SPEED = 73;

  function parseFIT(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = [];
    let off = 0;
    while (off + 12 <= bytes.length) {
      const headerSize = bytes[off];
      const dataSize = dv.getUint32(off + 4, true);
      const magic = String.fromCharCode(bytes[off + 8], bytes[off + 9], bytes[off + 10], bytes[off + 11]);
      if (magic !== ".FIT" || headerSize < 12) {
        if (!points.length && off === 0) throw new Error("Not a FIT file");
        break;
      }
      const end = Math.min(bytes.length, off + headerSize + dataSize);
      readRecords(dv, off + headerSize, end, points);
      off = end + 2;                     // skip the 2-byte file CRC
    }
    points.sort((a, b) => a.t - b.t);
    return points;
  }

  function readRecords(dv, p, end, points) {
    const defs = new Array(16);
    let lastTs = 0;
    while (p < end) {
      const hdr = dv.getUint8(p++);
      let local, compressedOffset = -1;
      if (hdr & 0x80) {                  // compressed timestamp data message
        local = (hdr >> 5) & 0x03;
        compressedOffset = hdr & 0x1f;
      } else {
        local = hdr & 0x0f;
        if (hdr & 0x40) {                // definition message
          const bigEndian = dv.getUint8(p + 1) === 1;
          const global = dv.getUint16(p + 2, !bigEndian);
          const nFields = dv.getUint8(p + 4);
          p += 5;
          const fields = [];
          let size = 0;
          for (let i = 0; i < nFields; i++, p += 3) {
            const f = { num: dv.getUint8(p), size: dv.getUint8(p + 1), offset: size };
            fields.push(f);
            size += f.size;
          }
          if (hdr & 0x20) {              // developer fields: count their bytes only
            const nDev = dv.getUint8(p++);
            for (let i = 0; i < nDev; i++, p += 3) size += dv.getUint8(p + 1);
          }
          defs[local] = { global, little: !bigEndian, fields, size };
          continue;
        }
      }
      const def = defs[local];
      if (!def) throw new Error(`FIT data message before its definition at byte ${p - 1}`);
      if (p + def.size > end) break;

      let ts = null, lat = null, lon = null, speed = null, enhSpeed = null;
      for (const f of def.fields) {
        const at = p + f.offset;
        if (f.num === F_TIMESTAMP && f.size === 4) ts = uint32(dv, at, def.little);
        else if (def.global !== MSG_RECORD) continue;
        else if (f.num === F_LAT && f.size === 4) lat = sint32(dv, at, def.little);
        else if (f.num === F_LON && f.size === 4) lon = sint32(dv, at, def.little);
        else if (f.num === F_SPEED && f.size === 2) speed = uint16(dv, at, def.little);
        else if (f.num === F_ENH_SPEED && f.size === 4) enhSpeed = uint32(dv, at, def.little);
      }
      p += def.size;

      if (ts != null) lastTs = ts;
      else if (compressedOffset >= 0) {
        ts = (lastTs & ~0x1f) + compressedOffset;
        if (compressedOffset < (lastTs & 0x1f)) ts += 0x20;
        lastTs = ts;
      }
      if (def.global !== MSG_RECORD || ts == null || lat == null || lon == null) continue;
      const pt = { t: ts + FIT_EPOCH, lat: lat * SEMI_TO_DEG, lon: lon * SEMI_TO_DEG };
      const mmps = enhSpeed != null ? enhSpeed : speed;
      if (mmps != null) pt.sog = (mmps / 1000) * MPS_TO_KN;
      points.push(pt);
    }
  }

  // Readers return null for FIT's "invalid" sentinel values.
  function uint16(dv, at, little) {
    const v = dv.getUint16(at, little);
    return v === 0xffff ? null : v;
  }
  function uint32(dv, at, little) {
    const v = dv.getUint32(at, little);
    return v === 0xffffffff ? null : v;
  }
  function sint32(dv, at, little) {
    const v = dv.getInt32(at, little);
    return v === 0x7fffffff ? null : v;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseFIT };
  else window.parseFIT = parseFIT;
})();
