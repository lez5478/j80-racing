// Unit tests for race-results/parse.js on text shaped like pdf-parse output
// of RHKYC result PDFs (boat and skipper names are made up).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseText, parseBoatNames } = require("../race-results/parse.js");

const COMPACT = `J/80 - Class Series 2026-2027
Autumn 1 (05/09/2026) - Scratch Results
Division: J/80
PlaceSail No.NameSkipperClubFinishElapsedPoints
J/80Start: 12:05
1HKG1001AlphaAnna AdamsRHKYC12:43:4600:38:461
2HKG1002BravoBen BrownRHKYC12:44:2000:39:202
10HKG1010Juliet Jr.Jo JonesRHKYC12:49:0600:44:0610
-DNCHKG1003CharlieCara CoxRHKYC--16
Timestamp: 14:12:34 05/09/2026
`;

// Re-issued results (e.g. after a redress hearing) come out spaced, with a
// penalty code between place and sail number and fractional points.
const SPACED = `J/80 - Class Series 2026-2027
Autumn 2 (05/09/2026) - Scratch Results
Division: J/80
PlaceSail No.NameSkipperClub Finish Elapsed Points
J/80Start: 13:08
1HKG1001  AlphaAnna AdamsRHKYC  13:46:43  00:38:43   1
5CPP  HKG1002  BravoBen BrownRHKYC  13:49:03  00:41:03   6.5
10HKG1010  Juliet Jr.Jo Jones    RHKYC  13:51:58  00:43:58   10
-DNC HKG1003  CharlieCara CoxRHKYC    --16
-RET HKG1004  DeltaDan DaleRHKYC    --16
Timestamp: 10:40:49 08/09/2026
`;

test("parses the compact result layout", () => {
  const [race] = parseText(COMPACT, "J802026-27Autumn.pdf");
  assert.equal(race.title, "Autumn 1");
  assert.equal(race.date, "2026-09-05");
  assert.equal(race.start, "2026-09-05T04:05:00.000Z");
  assert.equal(race.end, "2026-09-05T04:49:06.000Z");
  assert.deepEqual(race.finishers.map((f) => [f.place, f.sail, f.finish, f.elapsed]), [
    [1, "HKG1001", "12:43:46", "00:38:46"],
    [2, "HKG1002", "12:44:20", "00:39:20"],
    [10, "HKG1010", "12:49:06", "00:44:06"],
  ]);
  assert.deepEqual(race.dnc, [{ status: "DNC", sail: "HKG1003" }]);
});

test("parses the spaced layout with penalty codes and fractional points", () => {
  const [race] = parseText(SPACED, "J802026-27Autumn.pdf");
  // Date comes from the title (race day), not the later re-issue timestamp.
  assert.equal(race.date, "2026-09-05");
  assert.equal(race.start, "2026-09-05T05:08:00.000Z");
  assert.deepEqual(race.finishers.map((f) => [f.place, f.sail, f.finish, f.elapsed]), [
    [1, "HKG1001", "13:46:43", "00:38:43"],
    [5, "HKG1002", "13:49:03", "00:41:03"],
    [10, "HKG1010", "13:51:58", "00:43:58"],
  ]);
  assert.deepEqual(race.dnc, [
    { status: "DNC", sail: "HKG1003" },
    { status: "RET", sail: "HKG1004" },
  ]);
});

test("keeps every race when layouts are mixed in one PDF", () => {
  const races = parseText(COMPACT + "\n" + SPACED, "J802026-27Autumn.pdf");
  assert.deepEqual(races.map((r) => r.title), ["Autumn 1", "Autumn 2"]);
});

test("reads boat names from the series scoreboard", () => {
  const names = parseBoatNames("1   Alpha’s Boat (HKG1001)Anna AdamsRHKYC1111\n=   Bravo (HKG1002)Ben BrownRHKYC171717");
  assert.deepEqual(names, { HKG1001: "Alpha’s Boat" });
});
