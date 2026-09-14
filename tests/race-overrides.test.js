const test = require("node:test");
const assert = require("node:assert/strict");
const { applyRaceOverrides } = require("../race-overrides.js");

function sampleRaces() {
  return {
    "2026-09-12": [
      {
        title: "Autumn 4", name: "R1", date: "2026-09-12",
        start: "2026-09-12T04:05:00.000Z", end: "2026-09-12T05:08:43.000Z",
        startH: 12, startM: 5,
        finishers: [
          { place: 1, sail: "HKG1001", finish: "12:59:38", elapsed: "00:54:38" },
          { place: 2, sail: "HKG1002", finish: "13:08:43", elapsed: "01:03:43" },
        ],
        dnc: [],
      },
      {
        title: "Autumn 5", name: "R2", date: "2026-09-12",
        start: "2026-09-12T05:20:00.000Z", startH: 13, startM: 20,
        finishers: [{ place: 1, sail: "HKG1001", finish: "13:53:40", elapsed: "00:33:40" }],
        dnc: [],
      },
    ],
  };
}

test("corrects the gun and recomputes elapsed from finish times", () => {
  const races = sampleRaces();
  const n = applyRaceOverrides(races, { "2026-09-12": { "Autumn 4": { start: "12:10" } } });
  assert.equal(n, 1);
  const r = races["2026-09-12"][0];
  assert.equal(r.start, "2026-09-12T04:10:00.000Z");
  assert.deepEqual([r.startH, r.startM, r.pdfStart], [12, 10, "12:05"]);
  assert.deepEqual(r.finishers.map((f) => [f.finish, f.elapsed]), [
    ["12:59:38", "00:49:38"],
    ["13:08:43", "00:58:43"],
  ]);
  assert.equal(r.end, "2026-09-12T05:08:43.000Z");
  // Other races that day are untouched.
  assert.equal(races["2026-09-12"][1].start, "2026-09-12T05:20:00.000Z");
  assert.equal(races["2026-09-12"][1].pdfStart, undefined);
});

test("accepts seconds and ignores invalid or unknown entries", () => {
  const races = sampleRaces();
  const n = applyRaceOverrides(races, {
    "2026-09-12": { "Autumn 4": { start: "12:09:30" }, "Autumn 5": { start: "25:00" }, "Autumn 9": { start: "14:00" } },
    "2026-09-19": { "Autumn 7": { start: "12:00" } },
  });
  assert.equal(n, 1);
  assert.equal(races["2026-09-12"][0].start, "2026-09-12T04:09:30.000Z");
  assert.equal(races["2026-09-12"][0].finishers[0].elapsed, "00:50:08");
  assert.equal(races["2026-09-12"][1].startM, 20);
});

test("keeps the PDF elapsed for a finish before the corrected start", () => {
  const races = sampleRaces();
  applyRaceOverrides(races, { "2026-09-12": { "Autumn 4": { start: "13:00" } } });
  const [first, second] = races["2026-09-12"][0].finishers;
  assert.equal(first.elapsed, "00:54:38");
  assert.equal(second.elapsed, "00:08:43");
});

test("no overrides is a no-op", () => {
  const races = sampleRaces();
  assert.equal(applyRaceOverrides(races, {}), 0);
  assert.equal(applyRaceOverrides(races, null), 0);
  assert.deepEqual(races, sampleRaces());
});
