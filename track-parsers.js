// Track-file parsers shared by the replay app: Velocitek VTK, GPX, TCX,
// Garmin FIT (decoder in fit.js) and Vakaros CSV. Every parser returns
// { points: [{ t, lat, lon, sog, cog, heel?, pitch?, hdg? }], buttons }.
// Loaded as a classic script before app.js; also require()-able for tests.

// ---------- Minimal protobuf wire-format decoder ----------
// Only what we need for Velocitek VTK: varints, length-delimited, sint32 zigzag.
function Reader(buf) {
  this.b = buf; this.p = 0;
}
Reader.prototype.eof = function () { return this.p >= this.b.length; };
Reader.prototype.varint = function () {
  let result = 0n, shift = 0n;
  while (true) {
    if (this.p >= this.b.length) throw new Error("varint EOF");
    const byte = this.b[this.p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  return result;
};
Reader.prototype.varintNum = function () { return Number(this.varint()); };
Reader.prototype.sint32 = function () {
  const n = this.varintNum();
  return (n >>> 1) ^ -(n & 1);
};
Reader.prototype.bytes = function () {
  const len = this.varintNum();
  const slice = this.b.subarray(this.p, this.p + len);
  this.p += len;
  return slice;
};
Reader.prototype.skip = function (wire) {
  if (wire === 0) this.varint();
  else if (wire === 2) this.bytes();
  else if (wire === 1) this.p += 8;
  else if (wire === 5) this.p += 4;
  else throw new Error("unsupported wire " + wire);
};

// ---------- VTK parser ----------
// File is a stream of records; each = u16 LE length + protobuf Record.
// Record has oneof: trackpoint=1, timer_event=2, button_event=16,
//                   hardware_description=17, magnetic_declination=18.
// Trackpoint fields: 1 seconds, 2 centiseconds,
//                    3 latE7 (sint32), 4 lonE7 (sint32),
//                    5 sog*10 kts, 6 cog deg, 7..10 quaternion.
// Returns { points, buttons } where buttons captures the helmsman's
// start-line marks (BUTTON_RC = committee end, BUTTON_PIN = pin end).
// Velocitek records the button type with no embedded position, so we tag
// each event with the most recent trackpoint's lat/lon/time.
const BUTTON_NAMES = ["NONE", "RC", "PIN", "LINE_CLEARED", "MAX"];
// Convert a (q1, q2, q3, q4) quaternion to heel (degrees, port −, starboard +)
// and pitch (degrees, bow up + ). Velocitek's docs say the quaternion is
// "relative to local magnetic north" but don't specify the axis convention;
// what comes out empirically matches roll/pitch when treated as standard
// (w, x, y, z) with z-up, x-forward.
function quatToHeelPitch(q1, q2, q3, q4) {
  // Treat q1=w (scalar), q2=x, q3=y, q4=z.
  const w = q1, x = q2, y = q3, z = q4;
  // Normalize defensively (Velocitek values should be unit but cheap to verify).
  const n = Math.sqrt(w * w + x * x + y * y + z * z) || 1;
  const W = w / n, X = x / n, Y = y / n, Z = z / n;
  // Standard quaternion -> Euler (ZYX intrinsic):
  //   roll  (φ) = atan2(2(WX + YZ), 1 - 2(X² + Y²))
  //   pitch (θ) = asin( clamp(2(WY - ZX), -1, 1) )
  const roll = Math.atan2(2 * (W * X + Y * Z), 1 - 2 * (X * X + Y * Y));
  const pitchSin = Math.max(-1, Math.min(1, 2 * (W * Y - Z * X)));
  const pitch = Math.asin(pitchSin);
  return { heel: roll * 180 / Math.PI, pitch: pitch * 180 / Math.PI };
}

function parseVTK(uint8) {
  const points = [];
  const buttons = [];
  let lastTrack = null;
  let i = 0;
  while (i + 2 <= uint8.length) {
    const len = uint8[i] | (uint8[i + 1] << 8);
    i += 2;
    if (len === 0 || i + len > uint8.length) break;
    const msg = uint8.subarray(i, i + len);
    i += len;

    const r = new Reader(msg);
    while (!r.eof()) {
      const key = r.varintNum();
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 1 && wire === 2) {
        // Trackpoint
        const tp = new Reader(r.bytes());
        let sec = 0, csec = 0, lat = null, lon = null, sog = 0, cog = 0;
        let q1 = null, q2 = null, q3 = null, q4 = null;
        while (!tp.eof()) {
          const k2 = tp.varintNum();
          const f = k2 >>> 3, w = k2 & 7;
          if (f === 1 && w === 0) sec = tp.varintNum();
          else if (f === 2 && w === 0) csec = tp.varintNum();
          else if (f === 3 && w === 0) lat = tp.sint32() / 1e7;
          else if (f === 4 && w === 0) lon = tp.sint32() / 1e7;
          else if (f === 5 && w === 0) sog = tp.varintNum() / 10; // knots
          else if (f === 6 && w === 0) cog = tp.varintNum();       // degrees
          else if (f === 7 && w === 0) q1 = tp.sint32() / 1000;
          else if (f === 8 && w === 0) q2 = tp.sint32() / 1000;
          else if (f === 9 && w === 0) q3 = tp.sint32() / 1000;
          else if (f === 10 && w === 0) q4 = tp.sint32() / 1000;
          else tp.skip(w);
        }
        if (lat !== null && lon !== null) {
          const pt = { t: sec + csec / 100, lat, lon, sog, cog };
          if (q1 !== null && q2 !== null && q3 !== null && q4 !== null) {
            const orient = quatToHeelPitch(q1, q2, q3, q4);
            pt.heel = orient.heel;
            pt.pitch = orient.pitch;
          }
          points.push(pt);
          lastTrack = pt;
        }
      } else if (field === 16 && wire === 2) {
        // ButtonEvent — single varint field: type
        const bt = new Reader(r.bytes());
        let type = 0;
        while (!bt.eof()) {
          const k2 = bt.varintNum();
          const f = k2 >>> 3, w = k2 & 7;
          if (f === 1 && w === 0) type = bt.varintNum();
          else bt.skip(w);
        }
        if (lastTrack && type >= 1 && type <= 3) {
          buttons.push({
            type: BUTTON_NAMES[type] || String(type),
            t: lastTrack.t,
            lat: lastTrack.lat,
            lon: lastTrack.lon,
          });
        }
      } else {
        r.skip(wire);
      }
    }
  }
  return { points, buttons };
}

// ---------- GPX / TCX / FIT parsers ----------
// Fill sog (knots) + cog (degrees) from adjacent samples (works well at 1 Hz,
// the typical Garmin rate). A sog the device already recorded (FIT speed) is
// kept; cog is always derived since these formats rarely carry heading.
function fillSogCog(points) {
  const MPS_TO_KN = 1.943844;
  for (let i = 0; i < points.length; i++) {
    const a = i === 0 ? points[0] : points[i - 1];
    const b = i === points.length - 1 ? points[points.length - 1] : points[i + 1];
    const dLat = (b.lat - a.lat) * 111_320;
    const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    const dt = Math.max(0.01, b.t - a.t);
    if (!isFinite(points[i].sog)) points[i].sog = (dist / dt) * MPS_TO_KN;
    points[i].cog = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360;
  }
  return { points, buttons: [] };
}

// Garmin Connect and many watches export GPS tracks as GPX. Structure is
// plain XML: <trkpt lat="…" lon="…"><time>…</time></trkpt>. Speed and
// heading aren't usually included.
function parseGPX(text) {
  const points = [];
  const trkptRe = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>[\s\S]*?<\/trkpt>/g;
  let m;
  while ((m = trkptRe.exec(text))) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    const t = Date.parse(m[3]) / 1000;
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) continue;
    points.push({ t, lat, lon });
  }
  return fillSogCog(points);
}

// TCX (Garmin Training Center) is similar XML with <Trackpoint> wrapping
// <Time>, <Position><LatitudeDegrees/LongitudeDegrees>, and sometimes
// <Extensions> carrying speed.
function parseTCX(text) {
  const points = [];
  const pointRe = /<Trackpoint>[\s\S]*?<Time>([^<]+)<\/Time>[\s\S]*?<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>[\s\S]*?<LongitudeDegrees>([-\d.]+)<\/LongitudeDegrees>[\s\S]*?<\/Trackpoint>/g;
  let m;
  while ((m = pointRe.exec(text))) {
    const t = Date.parse(m[1]) / 1000;
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) continue;
    points.push({ t, lat, lon });
  }
  return fillSogCog(points);
}

// Vakaros (and similar) CSV export. Header form:
//   timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim
// Native heel + trim → no quaternion conversion needed.
function parseVakarosCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { points: [], buttons: [] };
  const header = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const idx = (n) => header.indexOf(n);
  const iT = idx("timestamp");
  const iLat = idx("latitude");
  const iLon = idx("longitude");
  const iSog = idx("sog_kts") >= 0 ? idx("sog_kts") : idx("sog");
  const iCog = idx("cog");
  const iHdg = idx("hdg_true") >= 0 ? idx("hdg_true") : idx("heading");
  const iHeel = idx("heel");
  const iTrim = idx("trim") >= 0 ? idx("trim") : idx("pitch");
  if (iT < 0 || iLat < 0 || iLon < 0) {
    throw new Error("CSV missing timestamp/latitude/longitude columns");
  }
  const points = [];
  for (let row = 1; row < lines.length; row++) {
    const line = lines[row];
    if (!line) continue;
    const cols = line.split(",");
    const t = Date.parse(cols[iT]) / 1000;
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) continue;
    const p = { t, lat, lon };
    p.sog = iSog >= 0 ? Number(cols[iSog]) : 0;
    p.cog = iCog >= 0 ? Number(cols[iCog]) : 0;
    if (iHdg >= 0) {
      const h = Number(cols[iHdg]);
      if (isFinite(h)) p.hdg = h;
    }
    if (iHeel >= 0) {
      const h = Number(cols[iHeel]);
      if (isFinite(h)) p.heel = h;
    }
    if (iTrim >= 0) {
      const p2 = Number(cols[iTrim]);
      if (isFinite(p2)) p.pitch = p2;
    }
    points.push(p);
  }
  return { points, buttons: [] };
}

// Dispatch by file extension.
function parseTrackFile(name, bytes) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "vtk") return parseVTK(bytes);
  if (ext === "fit") return fillSogCog(parseFIT(bytes)); // fit.js
  const text = new TextDecoder("utf-8").decode(bytes);
  if (ext === "gpx") return parseGPX(text);
  if (ext === "tcx") return parseTCX(text);
  if (ext === "csv") return parseVakarosCSV(text);
  throw new Error(`Unsupported file format: .${ext}`);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseVTK, parseGPX, parseTCX, parseVakarosCSV, parseTrackFile, fillSogCog, quatToHeelPitch };
}
