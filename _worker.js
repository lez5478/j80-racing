// Cloudflare Worker for the J/80 Racing app.
//
//   GET  /api/records     → live listing of R2 → { Boat: { date: [url, …] } }
//   GET  /api/wind        → live hourly wind timeseries built from R2
//   POST /api/upload      → multipart: boat, date, filename, file
//                           writes R2 at <Boat>/<date>/<filename>
//   everything else       → static assets (index.html, app.js, …)
//
//   scheduled()           → runs hourly Sat/Sun UTC → pulls past-6h HKO wind
//                           text snapshots into R2 under wind-text/<date>/<HH>.txt,
//                           then rebuilds the aggregated timeseries blob.

const BOAT_RE = /^[A-Za-z0-9 '._-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Accept Velocitek VTK + the common Garmin/export formats. Filename can be
// anything safe ending in one of the known extensions.
const FILE_RE = /^[\w.\-' ]{1,80}\.(vtk|gpx|tcx|fit|csv)$/i;
const MAX_BYTES = 30 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-token, x-upload-token",
};

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// Admin endpoints check this header against the ADMIN_TOKEN secret.
// Set the secret with: wrangler secret put ADMIN_TOKEN
function checkAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  return safeEqual(request.headers.get("x-admin-token") || "", env.ADMIN_TOKEN);
}

// Track uploads check x-upload-token against the fleet-wide UPLOAD_TOKEN
// secret (wrangler secret put UPLOAD_TOKEN). Until that secret is set,
// uploads stay open so the fleet isn't locked out mid-season.
function checkUpload(request, env) {
  if (!env.UPLOAD_TOKEN) return true;
  return safeEqual(request.headers.get("x-upload-token") || "", env.UPLOAD_TOKEN);
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    status: init.status || 200,
  });
}

// ---------- HKO wind ----------
const HKO_ARCHIVE = "https://www.hko.gov.hk/dps/wxinfo/ts/tsarchive/text_readings_";
const DIR_DEG = {
  "North": 0, "Northeast": 45, "East": 90, "Southeast": 135,
  "South": 180, "Southwest": 225, "West": 270, "Northwest": 315,
};
const WIND_ROW_RE = /^([A-Z][\w' ]+?)\s{2,}(N\/A|North|Northeast|East|Southeast|South|Southwest|West|Northwest|Variable)\s+(\d+|N\/A)\s+(\d+|N\/A)\s*$/;

function parseHkoText(text) {
  const plain = text.replace(/<[^>]+>/g, "");
  const m = plain.match(/10-Minute Mean Wind Direction[^\n]*\n([\s\S]*?)\n\s*\n/);
  if (!m) return null;
  const rows = {};
  for (const line of m[1].split(/\r?\n/)) {
    const r = line.match(WIND_ROW_RE);
    if (!r) continue;
    rows[r[1].trim()] = {
      dir: r[2] === "N/A" ? null : r[2],
      deg: DIR_DEG[r[2]] ?? null,
      spd: r[3] === "N/A" ? null : Number(r[3]),
      gust: r[4] === "N/A" ? null : Number(r[4]),
    };
  }
  return rows;
}

function pad(n) { return String(n).padStart(2, "0"); }

// Fetch the HKO snapshot for a specific HKT hour and archive it in R2 if
// it's not already there. Returns { saved | skipped | missing, key }; a
// saved result also carries date, h and the snapshot text so the caller can
// merge it without reading it back from R2.
async function pullWindHour(env, y, m, d, h) {
  const stamp = `${y}${pad(m)}${pad(d)}${pad(h)}0000`;
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const key = `wind-text/${date}/${pad(h)}.txt`;
  if (await env.SAIL_RECORDS.head(key)) return { skipped: true, key };
  try {
    const r = await fetch(`${HKO_ARCHIVE}${stamp}e.txt`);
    if (!r.ok) return { missing: true, key, status: r.status };
    const body = await r.arrayBuffer();
    if (body.byteLength < 200) return { missing: true, key, status: "empty" };
    await env.SAIL_RECORDS.put(key, body, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    return { saved: true, key, date, h, text: new TextDecoder().decode(body) };
  } catch (e) {
    return { missing: true, key, error: String(e) };
  }
}

// The aggregate lives in timeseries.json at the bucket root:
//   { stations: { name: name }, hourly: { date: { station: [ {h,dir,deg,spd,gust} ] } } }
// It is updated incrementally. Rebuilding it from every wind-text/* file on
// each run costs one R2 read per snapshot, and once the archive passed ~1000
// snapshots (early June 2026) that blew the per-invocation subrequest limit,
// so the cron silently stopped refreshing it.
async function loadTimeseries(env) {
  const blob = await env.SAIL_RECORDS.get("timeseries.json");
  if (!blob) return { stations: {}, hourly: {} };
  // Let a parse error throw: saving over a corrupt read would wipe history.
  const agg = JSON.parse(await blob.text());
  agg.stations = agg.stations || {};
  agg.hourly = agg.hourly || {};
  return agg;
}

async function saveTimeseries(env, agg) {
  const stations = {};
  for (const s of Object.keys(agg.stations).sort()) stations[s] = s;
  await env.SAIL_RECORDS.put("timeseries.json", JSON.stringify({ stations, hourly: agg.hourly }), {
    httpMetadata: { contentType: "application/json" },
  });
  return { days: Object.keys(agg.hourly).length, stations: Object.keys(stations).length };
}

// Merge one hourly snapshot into the aggregate, replacing any existing row
// for the same station + hour. Returns false if the text didn't parse.
function mergeSnapshot(agg, date, h, text) {
  const rows = parseHkoText(text);
  if (!rows) return false;
  const day = (agg.hourly[date] = agg.hourly[date] || {});
  for (const [st, vals] of Object.entries(rows)) {
    agg.stations[st] = st;
    const series = (day[st] = day[st] || []);
    const row = { h, ...vals };
    const i = series.findIndex((r) => r.h === h);
    if (i >= 0) series[i] = row;
    else { series.push(row); series.sort((a, b) => a.h - b.h); }
  }
  return true;
}

// Re-merge every wind-text/<date>/*.txt for dates in [from, to] into the
// aggregate. Bounded to MAX_REBUILD_DAYS per call (≤ ~25 R2 ops per day) so
// a backfill stays well inside the subrequest limit — call it in chunks.
const MAX_REBUILD_DAYS = 14;
async function rebuildDays(env, from, to) {
  const dates = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const agg = await loadTimeseries(env);
  let snapshots = 0;
  for (const date of dates) {
    const list = await env.SAIL_RECORDS.list({ prefix: `wind-text/${date}/`, limit: 100 });
    for (const obj of list.objects) {
      const hm = obj.key.split("/")[2]?.match(/^(\d{2})\.txt$/);
      if (!hm) continue;
      const body = await env.SAIL_RECORDS.get(obj.key);
      if (body && mergeSnapshot(agg, date, Number(hm[1]), await body.text())) snapshots++;
    }
  }
  return { from, to, snapshots, ...(await saveTimeseries(env, agg)) };
}

// Merge the snapshots a batch of pullWindHour calls just saved.
async function mergePulled(env, results) {
  const saved = results.filter((r) => r.saved);
  if (!saved.length) return null;
  const agg = await loadTimeseries(env);
  for (const r of saved) mergeSnapshot(agg, r.date, r.h, r.text);
  return saveTimeseries(env, agg);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    // ---------- GET /api/records ----------
    if (url.pathname === "/api/records" && request.method === "GET") {
      const records = {};
      let cursor;
      do {
        const list = await env.SAIL_RECORDS.list({ cursor, limit: 1000 });
        for (const obj of list.objects) {
          // Only entries that look like Boat/YYYY-MM-DD/SESSION_*.VTK.
          const parts = obj.key.split("/");
          if (parts.length !== 3) continue;
          const [boat, date, name] = parts;
          if (!BOAT_RE.test(boat) || !DATE_RE.test(date) || !FILE_RE.test(name)) continue;
          records[boat] = records[boat] || {};
          records[boat][date] = records[boat][date] || [];
          records[boat][date].push(`Sail records/${obj.key}`);
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      return json(records);
    }

    // ---------- GET /api/wind ----------
    if (url.pathname === "/api/wind" && request.method === "GET") {
      const blob = await env.SAIL_RECORDS.get("timeseries.json");
      if (!blob) return json({ stations: {}, hourly: {} });
      return new Response(blob.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
          ...CORS_HEADERS,
        },
      });
    }

    // ---------- POST /api/upload ----------
    if (url.pathname === "/api/upload" && request.method === "POST") {
      if (!checkUpload(request, env)) return json({ error: "Wrong fleet upload code" }, { status: 401 });
      let form;
      try { form = await request.formData(); }
      catch { return json({ error: "Expected multipart/form-data" }, { status: 400 }); }

      const boat = (form.get("boat") || "").trim();
      const date = (form.get("date") || "").trim();
      const filename = (form.get("filename") || "").trim().toUpperCase();
      const file = form.get("file");

      if (!BOAT_RE.test(boat)) return json({ error: "Invalid boat name" }, { status: 400 });
      if (!DATE_RE.test(date)) return json({ error: "Invalid date (need YYYY-MM-DD)" }, { status: 400 });
      if (!FILE_RE.test(filename)) return json({ error: "Invalid filename (expect SESSION_*.VTK)" }, { status: 400 });
      if (!file || typeof file === "string") return json({ error: "No file attached" }, { status: 400 });
      if (file.size > MAX_BYTES) return json({ error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, { status: 413 });
      if (file.size < 64) return json({ error: "File too small — not a VTK" }, { status: 400 });

      // Never overwrite someone's track: re-uploading the identical file is
      // a no-op, a different file under the same name is refused.
      const key = `${boat}/${date}/${filename}`;
      const existing = await env.SAIL_RECORDS.head(key);
      if (existing) {
        if (existing.size === file.size) return json({ ok: true, key, bytes: file.size, duplicate: true });
        return json({ error: "A different file with this name is already uploaded for that boat and day" }, { status: 409 });
      }
      try {
        await env.SAIL_RECORDS.put(key, file.stream(), {
          httpMetadata: { contentType: "application/octet-stream" },
        });
      } catch (e) {
        return json({ error: "R2 write failed: " + String(e) }, { status: 500 });
      }
      return json({ ok: true, key, bytes: file.size });
    }

    // ---------- POST /api/upload-wind-text ----------
    // Accepts one wind-text snapshot (one hourly .txt). Used by the local
    // sync script to push historical snapshots that pre-date the cron
    // (HKO only keeps 24h so we can't re-fetch them from their server).
    //   fields: date (YYYY-MM-DD), hour (0-23), file        (admin)
    if (url.pathname === "/api/upload-wind-text" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      let form;
      try { form = await request.formData(); }
      catch { return json({ error: "multipart expected" }, { status: 400 }); }
      const date = (form.get("date") || "").trim();
      const hour = Number(form.get("hour"));
      const file = form.get("file");
      if (!DATE_RE.test(date)) return json({ error: "bad date" }, { status: 400 });
      if (!Number.isInteger(hour) || hour < 0 || hour > 23)
        return json({ error: "bad hour" }, { status: 400 });
      if (!file || typeof file === "string")
        return json({ error: "no file" }, { status: 400 });
      if (file.size > 1024 * 1024) return json({ error: "too large" }, { status: 413 });
      const key = `wind-text/${date}/${String(hour).padStart(2, "0")}.txt`;
      await env.SAIL_RECORDS.put(key, file.stream(), {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
      return json({ ok: true, key });
    }

    // ---------- GET /api/rebuild-wind?from=YYYY-MM-DD&to=YYYY-MM-DD ----------
    // Re-merge the wind-text/ snapshots for that date range into
    // timeseries.json (at most MAX_REBUILD_DAYS per call; `to` defaults to
    // `from`). Use after bulk-uploading historical snapshots.       (admin)
    if (url.pathname === "/api/rebuild-wind" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      const from = (url.searchParams.get("from") || "").trim();
      const to = (url.searchParams.get("to") || from).trim();
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) {
        return json({ error: "need from=YYYY-MM-DD[&to=YYYY-MM-DD]" }, { status: 400 });
      }
      const span = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
      if (span > MAX_REBUILD_DAYS) {
        return json({ error: `range too long (max ${MAX_REBUILD_DAYS} days per call)` }, { status: 400 });
      }
      return json(await rebuildDays(env, from, to));
    }

    // ---------- GET /api/refresh-wind ----------
    // Manual trigger to pull the last 24h (max 48) and merge what's new.
    // Admin only — each call makes up to 48 requests to HKO.
    if (url.pathname === "/api/refresh-wind" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      const hours = Math.min(48, Math.max(1, Number(url.searchParams.get("hours") || 24)));
      const now = new Date();
      const hk = new Date(now.getTime() + 8 * 3600 * 1000);
      const results = [];
      for (let i = 0; i < hours; i++) {
        const cur = new Date(hk.getTime() - i * 3600 * 1000);
        results.push(await pullWindHour(env,
          cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate(), cur.getUTCHours()));
      }
      const summary = await mergePulled(env, results);
      return json({ pulled: results.filter((r) => r.saved).length,
                    skipped: results.filter((r) => r.skipped).length,
                    missing: results.filter((r) => r.missing).length,
                    ...summary });
    }

    // ---------- GET /api/marks ----------
    // Returns canonical per-day manually-placed course marks shared by all
    // users. Shape: { <raceName>: [ { lat, lon, label }, … ] }.
    // Empty object if no overrides have been saved for that day yet.
    if (url.pathname === "/api/marks" && request.method === "GET") {
      const date = (url.searchParams.get("date") || "").trim();
      if (!DATE_RE.test(date)) return json({ error: "bad date" }, { status: 400 });
      const blob = await env.SAIL_RECORDS.get(`marks/${date}.json`);
      if (!blob) return json({});
      return new Response(blob.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-cache",
          ...CORS_HEADERS,
        },
      });
    }

    // ---------- POST /api/marks (append-only revision) ----------
    // Body (JSON): { date, race, marks: [{lat,lon,label}, …], ua? }
    // Appends a new revision under marks-history/<date>/<race>/<ISO>-<rand>.json.
    // Does NOT mutate the canonical marks/<date>.json — an admin must promote
    // the revision (POST /api/marks-promote) for everyone to see it. The
    // submitter still sees their proposed marks locally via localStorage.
    if (url.pathname === "/api/marks" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "JSON expected" }, { status: 400 }); }
      const date = (body.date || "").trim();
      const race = (body.race || "").trim();
      const marks = Array.isArray(body.marks) ? body.marks : null;
      if (!DATE_RE.test(date)) return json({ error: "bad date" }, { status: 400 });
      if (!race || race.length > 64 || !/^[\w .'-]+$/.test(race)) {
        return json({ error: "bad race" }, { status: 400 });
      }
      if (!marks || marks.length > 32) return json({ error: "bad marks" }, { status: 400 });
      const clean = [];
      for (const m of marks) {
        const lat = Number(m.lat), lon = Number(m.lon);
        const label = String(m.label || "").toUpperCase().slice(0, 4);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        if (!label) continue;
        clean.push({ lat, lon, label });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rand = Math.random().toString(36).slice(2, 8);
      // Race name may contain spaces — keep readable, just URL-encode.
      const id = `${ts}-${rand}`;
      const key = `marks-history/${date}/${encodeURIComponent(race)}/${id}.json`;
      const payload = {
        marks: clean,
        ts: Date.now(),
        ua: String(request.headers.get("user-agent") || "").slice(0, 200),
        ip: request.headers.get("cf-connecting-ip") || null,
      };
      await env.SAIL_RECORDS.put(key, JSON.stringify(payload), {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ ok: true, status: "submitted-for-review", date, race, id, count: clean.length });
    }

    // ---------- GET /api/marks-history?date=YYYY-MM-DD (admin) ----------
    // Lists every proposed revision for that day, grouped by race.
    if (url.pathname === "/api/marks-history" && request.method === "GET") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      const date = (url.searchParams.get("date") || "").trim();
      if (!DATE_RE.test(date)) return json({ error: "bad date" }, { status: 400 });
      const out = {};
      let cursor;
      do {
        const list = await env.SAIL_RECORDS.list({
          prefix: `marks-history/${date}/`, cursor, limit: 1000,
        });
        for (const obj of list.objects) {
          const parts = obj.key.split("/"); // marks-history / <date> / <race> / <id>.json
          if (parts.length !== 4) continue;
          const race = decodeURIComponent(parts[2]);
          const id = parts[3].replace(/\.json$/, "");
          const blob = await env.SAIL_RECORDS.get(obj.key);
          if (!blob) continue;
          const payload = JSON.parse(await blob.text());
          (out[race] = out[race] || []).push({ id, ...payload });
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      // Newest revision first per race.
      for (const race of Object.keys(out)) out[race].sort((a, b) => b.ts - a.ts);
      // Also include current canonical for context.
      const canonBlob = await env.SAIL_RECORDS.get(`marks/${date}.json`);
      const canonical = canonBlob ? JSON.parse(await canonBlob.text()) : {};
      return json({ date, canonical, revisions: out });
    }

    // ---------- POST /api/marks-promote (admin) ----------
    // Body: { date, race, id }      → promote revision <id> to canonical
    //   or: { date, race, clear:true } → remove canonical entry for race
    if (url.pathname === "/api/marks-promote" && request.method === "POST") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "JSON expected" }, { status: 400 }); }
      const date = (body.date || "").trim();
      const race = (body.race || "").trim();
      if (!DATE_RE.test(date)) return json({ error: "bad date" }, { status: 400 });
      if (!race) return json({ error: "bad race" }, { status: 400 });
      const canonKey = `marks/${date}.json`;
      const existing = await env.SAIL_RECORDS.get(canonKey);
      const all = existing ? JSON.parse(await existing.text()) : {};
      if (body.clear) {
        delete all[race];
      } else {
        const id = (body.id || "").trim();
        if (!id) return json({ error: "id required" }, { status: 400 });
        const revKey = `marks-history/${date}/${encodeURIComponent(race)}/${id}.json`;
        const revBlob = await env.SAIL_RECORDS.get(revKey);
        if (!revBlob) return json({ error: "revision not found" }, { status: 404 });
        const rev = JSON.parse(await revBlob.text());
        if (!Array.isArray(rev.marks) || !rev.marks.length) {
          return json({ error: "revision has no marks (use clear:true to remove)" }, { status: 400 });
        }
        all[race] = rev.marks;
      }
      await env.SAIL_RECORDS.put(canonKey, JSON.stringify(all), {
        httpMetadata: { contentType: "application/json" },
      });
      return json({ ok: true, date, race, canonical: all[race] || null });
    }

    return env.ASSETS.fetch(request);
  },

  // Cloudflare runs this on the cron schedule in wrangler.jsonc:
  //   "0 * * * *"  = every hour, every day
  // so the wind archive has no gaps (HKO itself only keeps 24 hours).
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    const hk = new Date(now.getTime() + 8 * 3600 * 1000);
    // Backfill the past 6 hours in case earlier triggers missed (Cloudflare
    // occasionally coalesces overlapping runs). HKO's endpoint only keeps
    // the last 24 hours anyway, so our window is tight.
    const results = [];
    for (let i = 0; i < 6; i++) {
      const cur = new Date(hk.getTime() - i * 3600 * 1000);
      results.push(await pullWindHour(env,
        cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate(), cur.getUTCHours()));
    }
    // Only rewrite the big JSON if something new actually landed.
    const summary = await mergePulled(env, results);
    if (summary) {
      const saved = results.filter((r) => r.saved).length;
      console.log(`Wind cron: merged ${saved}, timeseries has ${summary.days} days`);
    } else {
      console.log("Wind cron: no new snapshots");
    }
  },
};
