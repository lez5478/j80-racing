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

// ---------- beat-implied wind ----------
test("impliedWindFromBeat bisects the two tacks, whatever the seed", () => {
  const { impliedWindFromBeat } = require("../race-metrics.js");
  const twd = 100, half = 42;
  const mk = (id, startTack) => {
    const points = [];
    for (let t = 0; t < 600; t++) {
      // 2-minute tacks with a little heading noise; a slow tack every 120 s.
      const tackIdx = Math.floor(t / 120) + startTack;
      const inTack = t % 120 < 5;
      const cog = (twd + (tackIdx % 2 ? half : -half) + Math.sin(t) * 3 + 360) % 360;
      points.push({ t, lat: 22.2, lon: 114.2, cog, sog: inTack ? 1.5 : 5 });
    }
    return { id, points };
  };
  const r = impliedWindFromBeat([mk(1, 0), mk(2, 1)], 0, 1000, null, 85);
  assert.ok(Math.abs(r.deg - twd) < 1, `deg ${r.deg}`);
  assert.ok(Math.abs(r.tackAngle - 2 * half) < 2, `tack ${r.tackAngle}`);
  // Downwind-only data has no clean two-tack beat → null.
  const run = [{ id: 3, points: Array.from({ length: 600 }, (_, t) => ({ t, lat: 22.2, lon: 114.2, cog: 280, sog: 6 })) }];
  assert.equal(impliedWindFromBeat(run, 0, 1000, null, 85), null);
  assert.equal(impliedWindFromBeat([mk(1, 0)], 0, 1000, null, null), null);
});

// ---------- wind strength from boat speed ----------
test("boatWindSamples reads TWS back from the polar and skips turns", () => {
  const { invertPolar, boatWindSamples, normalizeBoatWind } = require("../race-metrics.js");
  // Toy polar: speed grows with wind, slower close to the wind.
  const polar = (tws, twa) => tws * 0.5 * Math.min(1, Math.abs(twa) / 90);
  assert.ok(Math.abs(invertPolar(polar, 5, 90) - 10) < 0.01);
  assert.equal(invertPolar(polar, 0.1, 90), 4);  // clamped low
  assert.equal(invertPolar(polar, 50, 90), 20);  // clamped high
  // Beam reach (COG 0°, wind from 90°) at 5 kn → 10 kn of wind; a tack at
  // t = 200–210 s is skipped, as is a stretch pointing into the wind.
  const pts = [];
  for (let t = 0; t <= 400; t++) {
    const cog = t >= 200 && t < 210 ? (t - 200) * 18 : t > 300 ? 80 : 0;
    pts.push({ t, lat: 22.2, lon: 114.2, cog, sog: 5 });
  }
  const s = boatWindSamples({ points: pts }, 90, polar, 0, 400);
  assert.ok(s.length > 10);
  for (const x of s) {
    assert.ok(!(x.t > 200 && x.t < 240), `turn sample at ${x.t}`);
    assert.ok(x.t <= 300, `head-to-wind sample at ${x.t}`);
    assert.ok(Math.abs(x.tws - 10) < 0.01);
  }
  // Pace normalisation: a boat always 20% slower reads the same wind.
  const fast = [{ tws: 10 }, { tws: 12 }, { tws: 14 }];
  const slow = [{ tws: 8 }, { tws: 9.6 }, { tws: 11.2 }];
  normalizeBoatWind([fast, slow]);
  assert.ok(Math.abs(slow[1].tws - fast[1].tws) < 1.5);
  assert.ok(slow[2].tws > slow[0].tws); // spatial contrast kept
  // Point-of-sail bias: runs read high, beats low for the same wind; after
  // normalising, the gust (14 vs 10) shows in both bands.
  const up = [{ twa: 45, tws: 8 }, { twa: 45, tws: 8 }, { twa: 45, tws: 11.2 }];
  const run = [{ twa: 160, tws: 12 }, { twa: 160, tws: 12 }, { twa: 160, tws: 16.8 }];
  normalizeBoatWind([[...up, ...run]]);
  assert.ok(Math.abs(up[0].tws - run[0].tws) < 0.01);
  assert.ok(up[2].tws / up[0].tws > 1.3 && run[2].tws / run[0].tws > 1.3);
});
