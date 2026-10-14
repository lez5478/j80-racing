// Unit tests for track-parsers.js + fit.js, using small synthetic files
// built in-memory (real fleet tracks stay out of the repo).
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFIT } = require("../fit.js");
global.parseFIT = parseFIT; // track-parsers.js expects the browser global
const {
  parseVTK, parseGPX, parseTCX, parseVakarosCSV, parseVKX, parseTrackFile, fillSogCog,
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

// ---------- Vakaros VKX ----------
test("parseVKX reads position rows, converts units and skips other rows", () => {
  const rows = [];
  const header = new Uint8Array(8); header[0] = 0xff; header[1] = 5; rows.push(header);
  const cfg = new Uint8Array(14); cfg[0] = 0x08; rows.push(cfg);
  const pos = (ms, lat, lon, sogMs, cogRad, q) => {
    const b = new Uint8Array(45); const dv = new DataView(b.buffer);
    b[0] = 0x02;
    dv.setBigUint64(1, BigInt(ms), true);
    dv.setInt32(9, Math.round(lat * 1e7), true);
    dv.setInt32(13, Math.round(lon * 1e7), true);
    dv.setFloat32(17, sogMs, true);
    dv.setFloat32(21, cogRad, true);
    q.forEach((v, k) => dv.setFloat32(29 + k * 4, v, true));
    return b;
  };
  // 20° roll about the forward axis, yaw 90° (heading east).
  const r = 10 * Math.PI / 180, yw = 45 * Math.PI / 180;
  const q = [Math.cos(r) * Math.cos(yw), Math.sin(r) * Math.cos(yw), Math.sin(r) * Math.sin(yw), Math.cos(r) * Math.sin(yw)];
  rows.push(pos(0, 0, 0, 0, 0, [1, 0, 0, 0])); // no fix → skipped
  rows.push(pos(1788575426063, 22.236, 114.1869, 2.5, Math.PI / 2, q));
  const ping = new Uint8Array(18); const pdv = new DataView(ping.buffer);
  ping[0] = 0x05; pdv.setBigUint64(1, 1788575430000n, true); ping[9] = 1;
  pdv.setFloat32(10, 22.2, true); pdv.setFloat32(14, 114.15, true); rows.push(ping);
  const gun = new Uint8Array(14); const gdv = new DataView(gun.buffer);
  gun[0] = 0x04; gdv.setBigUint64(1, 1788581100222n, true); gun[9] = 3; rows.push(gun);
  const term = new Uint8Array(3); term[0] = 0xfe; rows.push(term);
  const bytes = new Uint8Array(rows.reduce((n, b) => n + b.length, 0));
  let o = 0; for (const b of rows) { bytes.set(b, o); o += b.length; }

  const { points, buttons } = parseTrackFile("pierre.vkx", bytes);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].type, "RC");
  assert.equal(buttons[0].t, 1788575430);
  assert.ok(Math.abs(buttons[0].lat - 22.2) < 1e-5 && Math.abs(buttons[0].lon - 114.15) < 1e-5);
  assert.deepEqual(buttons[1], { type: "TIMER", event: "RACE_START", t: 1788581100.222, timer: 0 });
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.t, 1788575426.063);
  assert.ok(Math.abs(p.lat - 22.236) < 1e-6 && Math.abs(p.lon - 114.1869) < 1e-6);
  assert.ok(Math.abs(p.sog - 2.5 * 3600 / 1852) < 1e-4);
  assert.ok(Math.abs(p.cog - 90) < 1e-3);
  assert.ok(Math.abs(p.heel - 20) < 0.01, `heel ${p.heel}`);
  assert.ok(Math.abs(p.hdg - 90) < 0.01, `hdg ${p.hdg}`);
  assert.throws(() => parseVKX(new Uint8Array([0x99, 0, 0])), /Not a VKX/);
});

// ---------- merging a boat's files ----------
test("mergeTrackSources keeps the higher-rate source where files overlap", () => {
  const { mergeTrackSources } = require("../track-parsers.js");
  const pts = (t0, t1, dt, tag) => {
    const out = [];
    for (let t = t0; t <= t1; t += dt) out.push({ t, tag });
    return out;
  };
  const fast = [...pts(100, 200, 0.25, "vtk"), ...pts(500, 600, 0.25, "vtk")]; // gap 200..500
  const slow = pts(0, 700, 1, "tcx");
  const m = mergeTrackSources([slow, fast]);
  const tagAt = (t) => m.find((p) => p.t === t).tag;
  assert.equal(tagAt(150), "vtk");
  assert.ok(!m.some((p) => p.tag === "tcx" && p.t >= 100 && p.t <= 200));
  assert.equal(tagAt(50), "tcx");  // before the fast source
  assert.equal(tagAt(300), "tcx"); // fills the fast source's gap
  assert.equal(tagAt(650), "tcx"); // after it
  for (let i = 1; i < m.length; i++) assert.ok(m[i].t >= m[i - 1].t);
  // 800k points must not blow the stack.
  const big = pts(0, 200000, 0.25, "big");
  assert.equal(mergeTrackSources([big]).length, big.length);
});
