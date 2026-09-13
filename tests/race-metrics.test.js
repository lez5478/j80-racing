// Unit tests for race-metrics.js on synthetic tracks (wind from due north,
// so "upwind" = north and course progress = metres gained north/south).
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCourseProgress, officialFinishElapsed, liveTimeGap } = require("../race-metrics.js");

const ORIGIN = { lat: 22.28, lon: 114.18 };
const WIND = 0;
const T0 = Date.parse("2026-09-05T04:00:00Z") / 1000;
const M_PER_DEG_LAT = 111_320;
let nextId = 1;

// northOf(t) → metres north of origin at t; eastOf(t) optional lateral.
function makeTrack(boat, duration, northOf, eastOf = () => 0, meta = {}) {
  const points = [];
  const mLon = M_PER_DEG_LAT * Math.cos(ORIGIN.lat * Math.PI / 180);
  for (let s = 0; s <= duration; s++) {
    points.push({
      t: T0 + s,
      lat: ORIGIN.lat + northOf(s) / M_PER_DEG_LAT,
      lon: ORIGIN.lon + eastOf(s) / mLon,
    });
  }
  return { id: nextId++, name: boat, points, tStart: T0, tEnd: T0 + duration, meta: { boat, ...meta } };
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("course progress is monotonic over a windward-leeward and ignores small wobbles", () => {
  // 60 s idle, beat 600 m north at 2 m/s with a ±30 m (below hysteresis)
  // oscillation, then run 600 m back south.
  const track = makeTrack("A", 720, (s) => {
    if (s < 60) return 0;
    if (s < 360) return (s - 60) * 2 + 30 * Math.sin((s - 60) / 20) * ((s - 60) / 300);
    return Math.max(0, 600 - (s - 360) * 2);
  });
  const cum = getCourseProgress(track, WIND, ORIGIN);
  for (let i = 1; i < cum.length; i++) assert.ok(cum[i] >= cum[i - 1], `non-decreasing at ${i}`);
  near(cum[359], 600, 40, "top of beat");
  near(cum[cum.length - 1], 1200, 60, "after the run");
});

test("liveTimeGap measures a 10 s lead up the beat", () => {
  const beat = (delay) => (s) => Math.max(0, s - 60 - delay) * 2;
  const a = makeTrack("Alpha", 600, beat(0));
  const b = makeTrack("Bravo", 600, beat(10), () => 50);
  const r = liveTimeGap(a, b, T0 + 300, WIND, ORIGIN);
  assert.equal(r.leader, "Alpha");
  near(r.gapSec, 10, 0.5, "gap seconds");
  assert.equal(r.legSign, 1);
  near(r.lateralM, 0, 0.5, "A is on the rhumb line");

  const flipped = liveTimeGap(b, a, T0 + 300, WIND, ORIGIN);
  near(flipped.gapSec, -10, 0.5, "sign flips with argument order");
  near(flipped.lateralM, 50, 0.5, "B is 50 m right of the rhumb");
});

test("liveTimeGap needs wind + origin unless both boats have finished", () => {
  const a = makeTrack("Alpha", 100, (s) => s);
  const b = makeTrack("Bravo", 100, (s) => s);
  assert.equal(liveTimeGap(a, b, T0 + 50, null, ORIGIN), null);
});

test("liveTimeGap freezes to the committee result once both boats finish", () => {
  globalThis.BOAT_NAMES = { HKG1: "Alpha", HKG2: "Bravo" };
  const race = {
    start: new Date(T0 * 1000).toISOString(),
    finishers: [
      { place: 1, sail: "HKG1", elapsed: "00:40:00" },
      { place: 2, sail: "HKG2", elapsed: "00:40:25" },
    ],
  };
  const a = makeTrack("Alpha", 3000, (s) => s, () => 0, { race });
  const b = makeTrack("Bravo", 3000, (s) => s, () => 0, { race });
  assert.equal(officialFinishElapsed(a), 2400);
  const after = liveTimeGap(a, b, T0 + 2500, null, null);
  assert.deepEqual(after, { gapSec: 25, leader: "Alpha", lateralM: null, legSign: 0, official: true });
  // Before Bravo finishes, the live metric is used (needs wind).
  assert.equal(liveTimeGap(a, b, T0 + 2410, null, null), null);
  delete globalThis.BOAT_NAMES;
});
