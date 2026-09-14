// Admin corrections to race start times. RHKYC result PDFs occasionally
// print the wrong gun (e.g. the scheduled start after a postponement).
// Corrections are stored in R2 — GET /api/race-overrides, edited on
// admin-races.html — keyed by race day and race title:
//   { "YYYY-MM-DD": { "Autumn 4": { start: "12:10" }, … }, … }
// The app applies them to window.RACES in place before any day renders.
// Loaded as a classic script before app.js; also require()-able for tests.
(function () {
  const HKT_OFFSET_MS = 8 * 3600 * 1000;
  const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const pad = (n) => String(n).padStart(2, "0");

  function secondsOfDay(hms) {
    const m = TIME_RE.exec(String(hms || ""));
    if (!m) return null;
    const s = +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
    return +m[1] < 24 && +m[2] < 60 && +(m[3] || 0) < 60 ? s : null;
  }
  const toHms = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;

  // Mutates `races` (the window.RACES shape). For each corrected race:
  //   start / startH / startM  → the corrected gun
  //   finishers[].elapsed      → finish clock time − corrected gun
  //   pdfStart                 → the start printed in the PDF ("HH:MM")
  // Finish clock times are untouched. Apply once per page load.
  // Returns the number of races corrected.
  function applyRaceOverrides(races, overrides) {
    let applied = 0;
    for (const [date, byTitle] of Object.entries(overrides || {})) {
      const [y, mo, d] = date.split("-").map(Number);
      for (const race of (races && races[date]) || []) {
        const o = byTitle && byTitle[race.title || race.name];
        const startSec = o ? secondsOfDay(o.start) : null;
        if (startSec == null) continue;
        race.pdfStart = `${pad(race.startH)}:${pad(race.startM)}`;
        race.start = new Date(Date.UTC(y, mo - 1, d) - HKT_OFFSET_MS + startSec * 1000).toISOString();
        race.startH = Math.floor(startSec / 3600);
        race.startM = Math.floor((startSec % 3600) / 60);
        for (const f of race.finishers || []) {
          const finishSec = secondsOfDay(f.finish);
          if (finishSec != null && finishSec >= startSec) f.elapsed = toHms(finishSec - startSec);
        }
        applied++;
      }
    }
    return applied;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { applyRaceOverrides };
  else window.applyRaceOverrides = applyRaceOverrides;
})();
