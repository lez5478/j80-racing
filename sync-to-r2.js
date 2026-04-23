// Pushes every local VTK that isn't already in R2 up via /api/upload.
// Run on your laptop:   node sync-to-r2.js
//
// The endpoint is public (CORS *, no auth) so this works from any machine
// with an internet connection.

const fs = require("fs");
const path = require("path");
const https = require("https");

const WORKER = "https://j80-racing.yafo78.workers.dev";
const ROOT = path.join(__dirname, "Sail records");

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

function httpPost(urlString, boundary, bodyBuf) {
  const u = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.host, path: u.pathname, method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=" + boundary,
        "content-length": bodyBuf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// Build a multipart body by hand — keeps dependency count at zero.
function buildMultipart(fields, file) {
  const boundary = "----SailSync" + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

(async () => {
  console.log("Fetching current R2 inventory…");
  const inR2 = await get(WORKER + "/api/records");
  const haveInR2 = new Set();
  for (const boat of Object.keys(inR2 || {})) {
    for (const date of Object.keys(inR2[boat])) {
      for (const url of inR2[boat][date]) {
        const name = url.split("/").pop();
        haveInR2.add(`${boat}/${date}/${name.toUpperCase()}`);
      }
    }
  }
  console.log(`R2 has ${haveInR2.size} files`);

  const todo = [];
  for (const boat of fs.readdirSync(ROOT).filter((d) =>
      fs.statSync(path.join(ROOT, d)).isDirectory())) {
    const boatDir = path.join(ROOT, boat);
    for (const date of fs.readdirSync(boatDir).filter((d) =>
        /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.statSync(path.join(boatDir, d)).isDirectory())) {
      const dayDir = path.join(boatDir, date);
      for (const file of fs.readdirSync(dayDir).filter((f) => /\.vtk$/i.test(f))) {
        const key = `${boat}/${date}/${file.toUpperCase()}`;
        if (!haveInR2.has(key)) todo.push({ boat, date, file, abs: path.join(dayDir, file) });
      }
    }
  }
  console.log(`Missing from R2: ${todo.length} file(s)`);
  if (!todo.length) { console.log("Already in sync ✓"); return; }

  let ok = 0, fail = 0;
  for (const item of todo) {
    const buf = fs.readFileSync(item.abs);
    const { boundary, body } = buildMultipart(
      { boat: item.boat, date: item.date, filename: item.file.toUpperCase() },
      { name: item.file, buffer: buf });
    process.stdout.write(`  ${item.boat}/${item.date}/${item.file} … `);
    try {
      const r = await httpPost(WORKER + "/api/upload", boundary, body);
      if (r.status === 200) { console.log("ok"); ok++; }
      else { console.log(`FAIL ${r.status} ${JSON.stringify(r.body)}`); fail++; }
    } catch (e) { console.log("ERR " + e.message); fail++; }
  }
  console.log(`\nDone — ${ok} uploaded, ${fail} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
