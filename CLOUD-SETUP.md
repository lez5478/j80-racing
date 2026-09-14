# Cloud setup

The app runs as one Cloudflare Worker (`j80-racing`, see `wrangler.jsonc`)
that serves the static files and a small API, backed by the R2 bucket
`sail-records`.

- Live site: https://j80-racing.yafo78.workers.dev
- Track files are also served straight from the bucket's public URL
  (`R2_BASE_URL` in `app.js`).

## How changes reach the site

| What | How it updates |
| --- | --- |
| Code (`app.js`, `_worker.js`, …) | Push to `main` → Cloudflare **Workers Builds** deploys automatically. |
| Race results (`race-results/races.js`) | GitHub Action `refresh-races.yml` runs every Monday 08:00 HKT (or by hand), re-parses the RHKYC PDFs and pushes → auto-deploy. |
| Fleet tracks | Skippers upload on `/upload.html` → R2 `<Boat>/<YYYY-MM-DD>/<file>`. Visible on the next page load via `/api/records`. |
| HKO wind | Worker cron, every hour: archives the HKO text snapshot to R2 `wind-text/<date>/<HH>.txt` and merges it into `timeseries.json` (served by `/api/wind`). |

## Secrets

Set in the Cloudflare dashboard (Worker → Settings → Variables and Secrets)
or with `npx wrangler secret put <NAME>`:

- `UPLOAD_TOKEN` — the **fleet upload code**. Share it with skippers; the
  upload page asks for it once and remembers it. If unset, uploads are open
  to anyone.
- `ADMIN_TOKEN` — for `admin-marks.html` and the wind maintenance endpoints
  below. If unset, those endpoints are disabled.

Uploads never overwrite: re-sending the identical file is a no-op, and a
different file under an existing name is refused (409).

## API

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /api/records` | public | `{ Boat: { date: [path, …] } }` listing of R2 tracks |
| `POST /api/upload` | fleet code | multipart `boat`, `date`, `filename`, `file` (VTK/GPX/TCX/FIT/CSV, ≤ 30 MB) |
| `GET /api/wind` | public | aggregated hourly HKO wind |
| `GET /api/marks?date=` / `POST /api/marks` | public | canonical marks / submit a proposal |
| `GET /api/marks-history`, `POST /api/marks-promote` | admin | review and promote mark proposals |
| `GET /api/race-overrides` | public | corrected race start times, applied by the app on load |
| `POST /api/race-overrides` | admin | `{ date, title, start: "HH:MM" \| null }` — edit on `admin-races.html` |
| `GET /api/refresh-wind?hours=24` | admin | pull the last N (≤ 48) HKO hours now |
| `GET /api/rebuild-wind?from=&to=` | admin | re-merge archived snapshots for ≤ 14 days |
| `POST /api/upload-wind-text` | admin | push one historical snapshot (`date`, `hour`, `file`) |

Admin calls send the token in the `x-admin-token` header, e.g.

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" "https://j80-racing.yafo78.workers.dev/api/rebuild-wind?from=2026-06-02&to=2026-06-15"
```

## Local scripts

- `node start.cjs` — local-only mode: scans `Sail records/`, refreshes race
  results and serves the folder on http://127.0.0.1:5174 (no Worker API;
  the app falls back to `records.js`).
- `npx wrangler dev --local --test-scheduled --persist-to ../.wrangler-sailing-state`
  — run the Worker locally (also the `worker` entry in `.claude/launch.json`).
  Keep `--persist-to` outside the project: the Worker serves the project
  folder as static assets, and state written inside it makes wrangler
  reload in a loop. Trigger the cron with `curl http://localhost:8787/__scheduled`.
- `UPLOAD_TOKEN=… node sync-to-r2.js` — push local `Sail records/` VTKs that R2 lacks.
- `ADMIN_TOKEN=… node sync-wind-to-r2.js` — push local `wind/text/` snapshots and merge them.
- `node what-is-new.js` — list tracks in R2 that aren't in your local folder.
- `npm test` — unit tests for the track parsers and match-race metrics.

## Troubleshooting

- **A track doesn't show up.** The file must be under
  `<Boat>/<YYYY-MM-DD>/` for a date that has RHKYC results, and the
  recording must overlap the race window.
- **Wind data looks stale.** Check `/api/wind` for the latest date and the
  Worker's cron logs. Hours still in R2 can be re-merged with
  `/api/rebuild-wind`; HKO itself only keeps the last 24 hours.
