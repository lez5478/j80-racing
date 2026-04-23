// Parse all RHKYC J/80 race-result PDFs in this folder into a single
// races.js file consumed by the app. We use the J/80-only PDFs (not the
// "-combined" variants) — they carry the same race data but are simpler
// to parse and J/80-only.
//
// Output (window.RACES) groups races by date:
//   { "YYYY-MM-DD": [
//       { name, start, end, finishers: [{place, sail, finish}], dnc: [sail, ...] },
//       ...
//     ] }
//
// `start` and `end` are full ISO timestamps in Asia/Hong_Kong (no DST).

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const ROOT = __dirname;
const HKT_OFFSET_MIN = 8 * 60; // Hong Kong is UTC+8 year-round

function listPdfs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listPdfs(full));
    else if (/\.pdf$/i.test(e.name) && !/-combined\.pdf$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// Build a UTC Date from a HK-local Y/M/D + HH:MM[:SS]
function hkToISO(y, m, d, h, mi, s = 0) {
  const utcMs = Date.UTC(y, m - 1, d, h, mi, s) - HKT_OFFSET_MIN * 60_000;
  return new Date(utcMs).toISOString();
}

// PDFs come out of pdf-parse as a single text blob. Race sections look like:
//   J/80 Start: HH:MM   ... finisher rows ...
//   Timestamp: HH:MM:SS DD/MM/YYYY
// Finisher rows: "place HKG#### ... HH:MM:SS HH:MM:SS place"
// DNC rows: "- DNC HKG####"
// The series scoreboard at the top of each PDF lists every boat with its
// name and sail number, e.g. "1Jammin' (HKG2261)Frederic AzemardRHKYC...".
// Returns { sail: name } for everything we recognise.
function parseBoatNames(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\d+(.+?)\s*\((HKG\d{3,5})\)/);
    if (m) out[m[2]] = m[1].trim();
  }
  return out;
}

function parseText(text, sourceName) {
  // pdf-parse strips spacing; rows come out concatenated like:
  //   "Frostbite 1 (24/01/2026) - Scratch Results"
  //   "J/80Start: 12:05"
  //   "1HKG2261Jammin'Frederic AzemardRHKYC12:53:3100:48:311"
  //   "-DNCHKG2262AlchemistAmbrose WongRHKYC--21"
  //   "Timestamp: 14:48:57 24/01/2026"
  const lines = text.split(/\r?\n/);
  const races = [];

  const titleRe = /^(.+?)\s+\((\d{2})\/(\d{2})\/(\d{4})\)\s*-/;
  const tsRe = /Timestamp:\s*(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/;
  const startRe = /^\s*J\/80\s*Start:\s*(\d{1,2}):(\d{2})/;
  // place / sail / (text) / finish HH:MM:SS / elapsed HH:MM:SS / points
  const finRe = /^(\d{1,3})(HKG\d{3,5}).*?(\d{1,2}):(\d{2}):(\d{2})(\d{1,2}):(\d{2}):(\d{2})\d+\s*$/;
  // DNC / DNF / OCS / RDG / DSQ / UFD / BFD / DNS
  const dnxRe = /^-\s*(DNC|DNF|OCS|RDG|DSQ|UFD|BFD|DNS)(HKG\d{3,5})/i;

  let cur = null;
  let pendingTitle = null; // race name from the title line, e.g. "Frostbite 1"
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let m;
    if ((m = L.match(titleRe))) {
      pendingTitle = m[1].trim();
      // Title also carries the date; remember it as a fallback.
      pendingTitle = { name: m[1].trim(), d: +m[2], mo: +m[3], y: +m[4] };
    } else if ((m = L.match(startRe))) {
      if (cur) races.push(cur);
      cur = {
        startH: +m[1], startM: +m[2],
        finishers: [], dnc: [],
        title: pendingTitle?.name || null,
        dateY: pendingTitle?.y || null,
        dateM: pendingTitle?.mo || null,
        dateD: pendingTitle?.d || null,
      };
      pendingTitle = null;
    } else if (cur && (m = L.match(finRe))) {
      const [, place, sail, fh, fm, fs, eh, em, es] = m;
      cur.finishers.push({
        place: +place, sail,
        finish: { h: +fh, m: +fm, s: +fs },
        elapsed: { h: +eh, m: +em, s: +es },
      });
    } else if (cur && (m = L.match(dnxRe))) {
      cur.dnc.push({ status: m[1].toUpperCase(), sail: m[2] });
    } else if (cur && (m = L.match(tsRe))) {
      // Use timestamp date only if we didn't already get one from the title.
      if (!cur.dateY) {
        cur.dateY = +m[6]; cur.dateM = +m[5]; cur.dateD = +m[4];
      }
      races.push(cur);
      cur = null;
    }
  }
  if (cur) races.push(cur);
  // Some PDFs have a leading "series scoreboard" with no J/80 Start; the
  // walk above ignores it because cur stays null until a Start is seen.

  // Filter out any race we couldn't date (no Timestamp follow-up) or that
  // had no finishers AND no DNC (looks like a section without J/80 entries).
  return races
    .filter((r) => r.dateY && (r.finishers.length || r.dnc.length))
    .map((r, i) => {
      const lastFinisher = r.finishers.length
        ? r.finishers[r.finishers.length - 1]
        : null;
      const startISO = hkToISO(r.dateY, r.dateM, r.dateD, r.startH, r.startM);
      const endISO = lastFinisher
        ? hkToISO(r.dateY, r.dateM, r.dateD,
            lastFinisher.finish.h, lastFinisher.finish.m, lastFinisher.finish.s)
        : null;
      return {
        source: path.basename(sourceName, ".pdf"),
        title: r.title || null,                       // e.g. "Frostbite 1"
        name: `R${i + 1}`,                            // re-numbered per day below
        date: `${r.dateY}-${String(r.dateM).padStart(2, "0")}-${String(r.dateD).padStart(2, "0")}`,
        start: startISO,
        end: endISO,
        startH: r.startH,
        startM: r.startM,
        finishers: r.finishers.map((f) => ({
          place: f.place,
          sail: f.sail,
          finish: `${String(f.finish.h).padStart(2, "0")}:${String(f.finish.m).padStart(2, "0")}:${String(f.finish.s).padStart(2, "0")}`,
          elapsed: `${String(f.elapsed.h).padStart(2, "0")}:${String(f.elapsed.m).padStart(2, "0")}:${String(f.elapsed.s).padStart(2, "0")}`,
        })),
        dnc: r.dnc.slice(),
      };
    });
}

(async () => {
  const pdfs = listPdfs(ROOT);
  console.log(`Parsing ${pdfs.length} PDFs…`);

  const byDate = {};
  const boatNames = {};
  for (const p of pdfs) {
    const buf = fs.readFileSync(p);
    let data;
    try { data = await pdfParse(buf); }
    catch (e) { console.warn(`  ✗ ${path.relative(ROOT, p)}: ${e.message}`); continue; }
    Object.assign(boatNames, parseBoatNames(data.text));
    const races = parseText(data.text, p);
    for (const r of races) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    }
    if (races.length) {
      console.log(`  ✓ ${path.relative(ROOT, p)} → ${races.length} races`);
    } else {
      console.log(`  · ${path.relative(ROOT, p)} → no races (probably a championship summary)`);
    }
  }

  // Within each date, sort races by start time and re-number R1..RN.
  for (const date of Object.keys(byDate)) {
    byDate[date].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    byDate[date].forEach((r, i) => { r.name = `R${i + 1}`; });
  }

  // Boats roster — distinct sail numbers seen across all results, with
  // their boat name (from scoreboard) and race count.
  const boats = {};
  for (const date of Object.keys(byDate)) {
    for (const r of byDate[date]) {
      for (const f of r.finishers) {
        boats[f.sail] = boats[f.sail] || { sail: f.sail, name: boatNames[f.sail] || null, races: 0 };
        boats[f.sail].races++;
      }
    }
  }

  const out = `// Auto-generated by race-results/parse.js — do not edit by hand.
// Source: RHKYC J/80 race result PDFs.
window.RACES = ${JSON.stringify(byDate)};
window.BOATS = ${JSON.stringify(boats)};
window.BOAT_NAMES = ${JSON.stringify(boatNames)};
`;
  fs.writeFileSync(path.join(ROOT, "races.js"), out);
  console.log(`Wrote races.js — ${Object.keys(byDate).length} race days, ${Object.values(byDate).reduce((n, x) => n + x.length, 0)} races, ${Object.keys(boats).length} boats, ${Object.keys(boatNames).length} named`);
})().catch((e) => { console.error(e); process.exit(1); });
