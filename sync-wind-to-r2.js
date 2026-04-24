// Pushes every local wind/text/<YYYY-MM-DD>/<HH>.txt snapshot into R2
// via the Worker's /api/upload-wind-text endpoint, then triggers a
// timeseries rebuild. Use this once to seed historical days that the
// cron can't backfill (HKO only keeps 24h).
//
//    node sync-wind-to-r2.js

const fs = require("fs");
const path = require("path");
const https = require("https");

const WORKER = "https://j80-racing.yafo78.workers.dev";
const LOCAL_ROOT = path.join(__dirname, "wind", "text");

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

function httpPost(urlString, boundary, body) {
  const u = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.host, path: u.pathname, method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=" + boundary,
        "content-length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(txt) }); }
        catch { resolve({ status: res.statusCode, body: txt }); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function buildMultipart(fields, file) {
  const boundary = "----WindSync" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n`
  ));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

(async () => {
  if (!fs.existsSync(LOCAL_ROOT)) {
    console.log("No wind/text/ folder — nothing to sync.");
    return;
  }
  // What's already in R2? /api/wind returns the aggregated result, not the
  // raw file list — so we can't easily dedup by file. Instead we just push
  // all locals; the Worker's PUT is idempotent.
  let ok = 0, fail = 0;
  for (const date of fs.readdirSync(LOCAL_ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    for (const fn of fs.readdirSync(path.join(LOCAL_ROOT, date))) {
      const m = fn.match(/^(\d{2})\.txt$/);
      if (!m) continue;
      const hour = Number(m[1]);
      const buf = fs.readFileSync(path.join(LOCAL_ROOT, date, fn));
      const { boundary, body } = buildMultipart(
        { date, hour: String(hour) },
        { name: fn, buffer: buf },
      );
      process.stdout.write(`  ${date}/${fn} … `);
      try {
        const r = await httpPost(WORKER + "/api/upload-wind-text", boundary, body);
        if (r.status === 200) { console.log("ok"); ok++; }
        else { console.log(`FAIL ${r.status}`); fail++; }
      } catch (e) { console.log("ERR " + e.message); fail++; }
    }
  }
  console.log(`\nUploaded ${ok} snapshots, ${fail} failed.`);
  console.log("\nTriggering aggregate rebuild…");
  const rebuild = await get(WORKER + "/api/rebuild-wind");
  console.log("Rebuild:", JSON.stringify(rebuild));
})().catch((e) => { console.error(e); process.exit(1); });
