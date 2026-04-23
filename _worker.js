// Cloudflare Worker for the J/80 Racing app.
//
//   GET  /api/records     → live listing of R2 → { Boat: { date: [url, …] } }
//   POST /api/upload      → multipart: boat, date, filename, file
//                           writes R2 at <Boat>/<date>/<filename>
//   everything else       → static assets (index.html, app.js, …)
//
// No auth, no tokens — whoever has the upload page URL can contribute.
// That's the chosen security model ("any sailor picks boat from dropdown").
//
// Safety rails applied on upload:
//   · filename must match SESSION_*.VTK
//   · boat must match ^[A-Za-z0-9 '._-]{1,32}$ (no path traversal)
//   · date must be YYYY-MM-DD
//   · file size ≤ 30 MB (Velocitek VTKs are ~1-2 MB — 30 is plenty)

const BOAT_RE = /^[A-Za-z0-9 '._-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^SESSION_\d+\.VTK$/i;
const MAX_BYTES = 30 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    status: init.status || 200,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---------- GET /api/records ----------
    // Walks the R2 bucket and returns the same shape as the local
    // records.js generator. Called by the app at startup; replaces the
    // baked-in records.js as soon as this endpoint is live.
    if (url.pathname === "/api/records" && request.method === "GET") {
      const records = {};
      let cursor;
      do {
        const list = await env.SAIL_RECORDS.list({ cursor, limit: 1000 });
        for (const obj of list.objects) {
          // Key layout: Boat/YYYY-MM-DD/SESSION_*.VTK
          const parts = obj.key.split("/");
          if (parts.length !== 3) continue;
          const [boat, date, name] = parts;
          if (!BOAT_RE.test(boat) || !DATE_RE.test(date) || !FILE_RE.test(name)) continue;
          records[boat] = records[boat] || {};
          records[boat][date] = records[boat][date] || [];
          // Path kept in "Sail records/…" form so the existing RemoteVtkFile
          // rewriter swaps it for the R2 public URL.
          records[boat][date].push(`Sail records/${obj.key}`);
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      return json(records);
    }

    // ---------- POST /api/upload ----------
    if (url.pathname === "/api/upload" && request.method === "POST") {
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

      const key = `${boat}/${date}/${filename}`;
      try {
        await env.SAIL_RECORDS.put(key, file.stream(), {
          httpMetadata: { contentType: "application/octet-stream" },
        });
      } catch (e) {
        return json({ error: "R2 write failed: " + String(e) }, { status: 500 });
      }
      return json({ ok: true, key, bytes: file.size });
    }

    // Fallback → serve static assets.
    return env.ASSETS.fetch(request);
  },
};
