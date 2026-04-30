// Prints everything in R2 that isn't in your local Sail records/ folder —
// i.e. what the fleet has added since your last pull.
//
// Usage:   node what-is-new.js

const fs = require("fs");
const path = require("path");
const https = require("https");

const WORKER = "https://j80-racing.yafo78.workers.dev";
const LOCAL_ROOT = path.join(__dirname, "Sail records");

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function haveLocally(boat, date, name) {
  const p = path.join(LOCAL_ROOT, boat, date, name);
  return fs.existsSync(p);
}

(async () => {
  const recs = await get(WORKER + "/api/records");
  let newCount = 0, total = 0;
  const byBoat = {};
  for (const boat of Object.keys(recs).sort()) {
    for (const date of Object.keys(recs[boat]).sort()) {
      for (const url of recs[boat][date]) {
        total++;
        const name = url.split("/").pop();
        if (!haveLocally(boat, date, name)) {
          newCount++;
          byBoat[boat] = byBoat[boat] || [];
          byBoat[boat].push(`${date}/${name}`);
        }
      }
    }
  }
  if (newCount === 0) {
    console.log(`Nothing new — all ${total} files already on your laptop.`);
    return;
  }
  console.log(`${newCount} of ${total} files in R2 are NOT on your laptop:\n`);
  for (const boat of Object.keys(byBoat).sort()) {
    console.log(`${boat} (${byBoat[boat].length}):`);
    for (const p of byBoat[boat]) console.log(`  ${p}`);
    console.log("");
  }
})().catch((e) => { console.error(e); process.exit(1); });
