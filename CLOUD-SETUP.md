# Cloud setup — shared fleet folder via Dropbox

Each fleet member drops their VTK files into one shared Dropbox folder. The
app reads them off your local Dropbox-synced copy, so it stays fast and
works offline. New uploads appear after a re-scan (run `node scan-records.js`
or just relaunch with `node start.cjs`).

## One-time setup (you, the fleet admin)

1. **Create the Dropbox folder.** In Dropbox web or the desktop app, make a
   shared folder named e.g. **`RHKYC J80 Race Tracks`**.
2. **Pre-create per-boat subfolders** inside it: `Meltemi/`, `Jammin'/`,
   `Jelignite/`, etc. (Skippers will fill in date subfolders themselves.)
3. **Invite participants** via Dropbox's "Share folder" → email or link.
   Give them **edit** permission so they can upload, but **viewer** on the
   parent folder if you don't want them rearranging boats.
4. **Install Dropbox desktop** on the machine that runs the app, sign in,
   and let the shared folder sync to disk. By default it lives somewhere
   like `C:\Users\<you>\Dropbox\RHKYC J80 Race Tracks`.
5. **Symlink it into the app.** From an elevated PowerShell (run as admin):

   ```powershell
   cd "C:\Users\YaFo\Documents\Claude projects\Sailing"
   Remove-Item "Sail records" -Recurse -Force   # only if the folder already exists locally
   New-Item -ItemType SymbolicLink -Path "Sail records" `
     -Value "C:\Users\YaFo\Dropbox\RHKYC J80 Race Tracks"
   ```

   Now `Sail records/` *is* the Dropbox folder. The http-server serves files
   through the symlink transparently, so the browser fetches work as before.

## What participants do (one-time per skipper)

1. Accept the Dropbox invite. Install Dropbox desktop (or use the web).
2. After a race, drop their `SESSION_*.VTK` files into:

   ```
   <BoatName>/<YYYY-MM-DD>/SESSION_<n>.VTK
   ```

   …matching the date format the Velocitek device already uses.
3. They never touch the app.

## What happens when you launch

`node start.cjs` does this on every run:
- `npm install` first time only
- `scan-records.js` walks `Sail records/` and refreshes `records.js`
- `race-results/fetch.js` pulls any new RHKYC PDFs (skip with `--offline`)
- `race-results/parse.js` re-parses all PDFs into `races.js`
- `npx http-server` on port 5174

So the moment a participant's file finishes syncing, your next launch
picks it up and the boat appears alongside Meltemi for that race.

## Troubleshooting

- **A participant's track doesn't show up.** Confirm Dropbox finished
  syncing (check the system tray icon) and the file lives at
  `<Boat>/YYYY-MM-DD/SESSION_*.VTK`. Re-run `node scan-records.js` and
  hard-refresh the browser.
- **The day appears but no boat plays.** The race only renders if a
  participant's track overlaps the race window. If their device wasn't
  recording at the start time, you'll see them in the scoreboard but not
  on the map.
- **Storage limit.** Free Dropbox is 2 GB; one VTK is ~1 MB so you have
  headroom for ~2,000 sessions. Plus is 2 TB at ~$10/month if you scale.
