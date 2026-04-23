// Downloads HKO hourly "Past 24-Hours Regional Weather" text snapshots
// from https://www.hko.gov.hk/dps/wxinfo/ts/tsarchive/text_readings_*.txt
// (one file per hour, snapshot of 10-minute mean wind at HH:00 HKT).
//
// By default backfills the last 24 hours (which is HKO's full archive on
// this endpoint). Pass --hours=N to fetch a different window (e.g. the
// 39-hour Sat 07:00 → Sun 22:00 race weekend).
//
// Files land in wind/text/<YYYY-MM-DD>/<HH>.txt and are skipped if
// already on disk (HKO doesn't update past hours).

const fs = require("fs");
const path = require("path");
const https = require("https");

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "sailing-tracks/0.1" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(get(res.headers.location));
      }
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// HKT (UTC+8 year-round). Returns { y, m, d, h } for `date` in HKT.
function hkParts(date) {
  const hkMs = date.getTime() + 8 * 3600 * 1000;
  const hk = new Date(hkMs);
  return {
    y: hk.getUTCFullYear(),
    m: hk.getUTCMonth() + 1,
    d: hk.getUTCDate(),
    h: hk.getUTCHours(),
  };
}

function pad(n) { return String(n).padStart(2, "0"); }

async function runOnce() {
  const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? Number(hoursArg.slice(8)) : 24;

  // Step backwards from this exact HKT hour-on-the-hour for `hours` snapshots.
  const now = new Date();
  const cur = hkParts(now);
  // Walk back hour by hour. Use a UTC ms cursor to stay sane around DST-free HKT.
  // Anchor at the most recent hour on the hour (HKT).
  const anchorUtcMs = Date.UTC(cur.y, cur.m - 1, cur.d, cur.h, 0, 0) - 8 * 3600 * 1000;

  console.log(`Fetching last ${hours} hourly snapshots ending ${cur.y}-${pad(cur.m)}-${pad(cur.d)} ${pad(cur.h)}:00 HKT`);
  let saved = 0, skipped = 0, missing = 0;
  for (let i = 0; i < hours; i++) {
    const cursor = hkParts(new Date(anchorUtcMs - i * 3600 * 1000));
    const stamp = `${cursor.y}${pad(cursor.m)}${pad(cursor.d)}${pad(cursor.h)}0000`;
    const dateDir = path.join(__dirname, "text", `${cursor.y}-${pad(cursor.m)}-${pad(cursor.d)}`);
    const outFile = path.join(dateDir, `${pad(cursor.h)}.txt`);
    if (fs.existsSync(outFile)) { skipped++; continue; }
    const url = `https://www.hko.gov.hk/dps/wxinfo/ts/tsarchive/text_readings_${stamp}e.txt`;
    try {
      const buf = await get(url);
      if (!buf) { missing++; continue; }
      fs.mkdirSync(dateDir, { recursive: true });
      fs.writeFileSync(outFile, buf);
      saved++;
    } catch (e) {
      console.warn(`  ✗ ${stamp}: ${e.message}`);
    }
  }
  console.log(`Done — ${saved} saved, ${skipped} already had, ${missing} not yet published`);
}

module.exports = { runOnce };

if (require.main === module) {
  runOnce().catch((e) => { console.error(e); process.exit(1); });
}
