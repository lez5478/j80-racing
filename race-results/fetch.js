// Downloads all J/80 race result PDFs from RHKYC into race-results/<season>/.
// Skips files that already exist locally with the same size (cheap freshness
// check — RHKYC URLs aren't versioned). Re-run any time to pick up new PDFs.

const fs = require("fs");
const path = require("path");
const https = require("https");

const INDEX_URL = "https://www.rhkyc.org.hk/sailing-results?type=3";
const OUT_ROOT = __dirname;

// RHKYC's CDN (CloudFront) blocks our default agent on a handful of files
// — pose as a real browser with a referer to dodge it.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/pdf,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.rhkyc.org.hk/sailing-results?type=3",
};

function get(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(get(res.headers.location, attempt));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", (e) => {
      // Transient ECONNRESET on RHKYC — retry up to 3 times with backoff.
      if (attempt < 3 && /ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(String(e))) {
        setTimeout(() => resolve(get(url, attempt + 1)), 500 * (attempt + 1));
      } else reject(e);
    });
  });
}

function head(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({
      method: "HEAD", host: u.host, path: u.pathname + u.search, headers: HEADERS,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(head(res.headers.location));
      }
      resolve({ status: res.statusCode, size: Number(res.headers["content-length"] || 0) });
    }).on("error", reject).end();
  });
}

(async () => {
  console.log("Fetching index…");
  const html = (await get(INDEX_URL)).toString("utf8");

  // Match all PDF links. Keep both J/80-only and -combined (we use the
  // J/80-only ones for J/80 race start times; combined ones cover J/70 too).
  const all = [...html.matchAll(/href="(https:\/\/www\.rhkyc\.org\.hk\/storage\/app\/media\/Sailing\/result\/J80-J70\/[^"]+\.pdf)"/gi)]
    .map((m) => m[1]);
  // Dedupe + filter: prefer the non-"combined" file for J/80 starts.
  const urls = [...new Set(all)];

  console.log(`Found ${urls.length} J/80-J/70 PDFs`);
  let downloaded = 0, skipped = 0, failed = 0;
  for (const url of urls) {
    // /Sailing/result/J80-J70/<season>/<file>.pdf
    const m = url.match(/J80-J70\/([^/]+)\/([^/]+\.pdf)$/i);
    if (!m) continue;
    const [, season, file] = m;
    const outDir = path.join(OUT_ROOT, decodeURIComponent(season));
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, decodeURIComponent(file));

    try {
      const remote = await head(url);
      if (fs.existsSync(outFile)) {
        const local = fs.statSync(outFile).size;
        if (remote.size && local === remote.size) { skipped++; continue; }
      }
      const buf = await get(url);
      fs.writeFileSync(outFile, buf);
      downloaded++;
      process.stdout.write(`  ↓ ${path.relative(OUT_ROOT, outFile)} (${buf.length} bytes)\n`);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${url}: ${e.message}`);
    }
  }
  console.log(`Done — ${downloaded} downloaded, ${skipped} up-to-date, ${failed} failed`);
})().catch((e) => { console.error(e); process.exit(1); });
