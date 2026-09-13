// Unit tests for track-parsers.js + fit.js, using small synthetic files
// built in-memory (real fleet tracks stay out of the repo).
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFIT } = require("../fit.js");
global.parseFIT = parseFIT; // track-parsers.js expects the browser global
const {
  parseVTK, parseGPX, parseTCX, parseVakarosCSV, parseTrackFile, fillSogCog,
} = require("../track-parsers.js");

const T0 = Date.parse("2026-09-05T04:00:00Z") / 1000;
const LAT0 = 22.28, LON0 = 114.18;
const M_PER_DEG_LAT = 111_320;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---------- VTK (length-prefixed protobuf) ----------
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const zigzag = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
const field = (num, wire, payload) => [...varint((num << 3) | wire), ...payload];
const lenDelim = (num, bytes) => field(num, 2, [...varint(bytes.length), ...bytes]);
function vtkRecord(body) {
  return [body.length & 0xff, body.length >> 8, ...body];
}

test("parseVTK decodes trackpoints, heel and button events", () => {
  const tp = [
    ...field(1, 0, varint(T0)), ...field(2, 0, varint(50)),
    ...field(3, 0, varint(zigzag(Math.round(LAT0 * 1e7)))),
    ...field(4, 0, varint(zigzag(Math.round(LON0 * 1e7)))),
    ...field(5, 0, varint(65)), ...field(6, 0, varint(270)),
    // identity quaternion → heel 0, pitch 0
    ...field(7, 0, varint(zigzag(1000))), ...field(8, 0, varint(0)),
    ...field(9, 0, varint(0)), ...field(10, 0, varint(0)),
  ];
  const bytes = Uint8Array.from([
    ...vtkRecord(lenDelim(1, tp)),
    ...vtkRecord(lenDelim(16, field(1, 0, varint(2)))), // BUTTON_PIN
  ]);
  const { points, buttons } = parseVTK(bytes);
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.t, T0 + 0.5);
  near(p.lat, LAT0, 1e-7, "lat");
  near(p.lon, LON0, 1e-7, "lon");
  assert.equal(p.sog, 6.5);
  assert.equal(p.cog, 270);
  near(p.heel, 0, 1e-9, "heel");
  assert.deepEqual(buttons, [{ type: "PIN", t: p.t, lat: p.lat, lon: p.lon }]);
});

// ---------- GPX / TCX ----------
// 11 samples, 1 Hz, due north at 1 m/s → SOG 1.944 kn, COG 0°.
const northTrack = Array.from({ length: 11 }, (_, i) => ({
  t: T0 + i, lat: LAT0 + i / M_PER_DEG_LAT, lon: LON0,
}));
const iso = (t) => new Date(t * 1000).toISOString();

test("parseGPX derives SOG/COG from positions", () => {
  const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${northTrack.map((p) =>
    `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>0</ele><time>${iso(p.t)}</time></trkpt>`).join("")}</trkseg></trk></gpx>`;
  const { points } = parseGPX(gpx);
  assert.equal(points.length, 11);
  for (const p of points) {
    near(p.sog, 1.943844, 0.01, "sog");
    near(p.cog, 0, 0.01, "cog");
  }
});

test("parseTCX reads Trackpoints", () => {
  const tcx = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>${northTrack.map((p) =>
    `<Trackpoint><Time>${iso(p.t)}</Time><Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position></Trackpoint>`).join("")}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const { points } = parseTCX(tcx);
  assert.equal(points.length, 11);
  near(points[5].sog, 1.943844, 0.01, "sog");
});

test("fillSogCog keeps a device-recorded SOG and handles single points", () => {
  const pts = northTrack.slice(0, 3).map((p) => ({ ...p, sog: 7 }));
  fillSogCog(pts);
  assert.ok(pts.every((p) => p.sog === 7));
  near(pts[1].cog, 0, 0.01, "cog");
  const one = [{ t: T0, lat: LAT0, lon: LON0 }];
  fillSogCog(one);
  assert.equal(one[0].sog, 0);
});

// ---------- Vakaros CSV ----------
test("parseVakarosCSV reads native heel/trim and skips bad rows", () => {
  const csv = [
    "timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim",
    "2026-03-28T10:07:35.050+0800,22.2359548,114.1868919,0.4,77.9,111.4,-0.2,3",
    "garbage,row",
    "2026-03-28T10:07:35.540+0800,22.235957,114.1868951,0.3,255.5,111.1,0.5,2.9",
    "",
  ].join("\n");
  const { points } = parseVakarosCSV(csv);
  assert.equal(points.length, 2);
  assert.equal(points[0].t, Date.parse("2026-03-28T02:07:35.050Z") / 1000);
  assert.deepEqual([points[1].sog, points[1].cog, points[1].hdg, points[1].heel, points[1].pitch],
    [0.3, 255.5, 111.1, 0.5, 2.9]);
  assert.throws(() => parseVakarosCSV("a,b,c\n1,2,3"), /missing timestamp/);
});

// ---------- FIT ----------
// Minimal FIT file: a record definition with a timestamp, one with a
// compressed-timestamp layout, plus an invalid-position record to skip.
function fitFile(messages) {
  const data = Uint8Array.from(messages.flat());
  const header = new Uint8Array(14);
  const dv = new DataView(header.buffer);
  header[0] = 14; header[1] = 0x20;
  dv.setUint16(2, 2195, true);
  dv.setUint32(4, data.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  return Uint8Array.from([...header, ...data, 0, 0]);
}
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const semis = (deg) => u32(Math.round(deg * 2 ** 31 / 180) >>> 0);
const FIT_EPOCH = 631065600;

test("parseFIT reads record messages incl. compressed timestamps", () => {
  const fitT0 = T0 - FIT_EPOCH;
  const def0 = [0x40, 0, 0, ...u16(20), 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 6, 2, 0x84];
  const def1 = [0x41, 0, 0, ...u16(20), 3, 0, 4, 0x85, 1, 4, 0x85, 6, 2, 0x84];
  const rec = (t, lat, lon, mmps) => [0x00, ...u32(t), ...semis(lat), ...semis(lon), ...u16(mmps)];
  // local type 1, 5-bit time offset; offset below the last timestamp's low
  // 5 bits means the counter rolled over.
  const compressed = (offset, lat, lon, mmps) => [0x80 | (1 << 5) | offset, ...semis(lat), ...semis(lon), ...u16(mmps)];
  const lowBits = fitT0 & 0x1f;
  const bytes = fitFile([
    def0,
    rec(fitT0, LAT0, LON0, 3000),
    [0x00, ...u32(fitT0 + 1), ...u32(0x7fffffff), ...u32(0x7fffffff), ...u16(0xffff)], // no GPS fix
    def1,
    compressed((lowBits + 2) & 0x1f, LAT0 + 0.001, LON0, 3500),
  ]);
  const points = parseFIT(bytes);
  assert.equal(points.length, 2);
  assert.equal(points[0].t, T0);
  near(points[0].lat, LAT0, 1e-6, "lat");
  near(points[0].sog, 3 * 1.943844, 1e-6, "sog");
  assert.equal(points[1].t, T0 + 2);
  near(points[1].lat, LAT0 + 0.001, 1e-6, "lat2");

  const viaDispatch = parseTrackFile("ACTIVITY.FIT", bytes);
  assert.equal(viaDispatch.points.length, 2);
  near(viaDispatch.points[0].sog, 3 * 1.943844, 1e-6, "device sog kept");
  near(viaDispatch.points[0].cog, 0, 0.01, "cog derived");
});

test("parseFIT rejects non-FIT data", () => {
  assert.throws(() => parseFIT(new Uint8Array(20)), /Not a FIT file/);
});

test("parseTrackFile rejects unknown extensions", () => {
  assert.throws(() => parseTrackFile("track.kml", new Uint8Array(0)), /Unsupported/);
});
