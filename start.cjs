// Single-command launcher. On every launch:
//   1. ensure deps are installed
//   2. (re)scan VTK records          → records.js
//   3. download new race result PDFs → race-results/<season>/*.pdf
//   4. parse all PDFs                → race-results/races.js
//   5. start the static http-server.
//
// Steps 3 and 4 only run if --offline is NOT passed and the network is up.
// If the network call fails the app still starts with whatever races.js
// already exists locally, so you can use it on a boat with no Wi-Fi.
const { spawnSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const offline = process.argv.includes("--offline");

function step(label, args, opts = {}) {
  console.log(`\n→ ${label}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit", ...opts });
  if (r.status !== 0 && !opts.allowFail) process.exit(r.status || 1);
  return r.status === 0;
}

if (!fs.existsSync(path.join(__dirname, "node_modules", "pdf-parse"))) {
  console.log("Installing dependencies (one-time)…");
  const inst = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--silent"], { stdio: "inherit", cwd: __dirname, shell: true });
  if (inst.status !== 0) process.exit(inst.status || 1);
}

step("Scanning VTK records", [path.join(__dirname, "scan-records.js")]);

if (!offline) {
  step("Downloading race-result PDFs (network)",
    [path.join(__dirname, "race-results", "fetch.js")],
    { allowFail: true });
}

step("Parsing race-result PDFs",
  [path.join(__dirname, "race-results", "parse.js")]);

if (!offline) {
  step("Fetching HKO wind text snapshots (last 24h)",
    [path.join(__dirname, "wind", "fetch-text.js")],
    { allowFail: true });
}

step("Indexing wind text snapshots",
  [path.join(__dirname, "wind", "scan-text.js")]);

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? portArg.slice(7) : (process.env.PORT || "5174");
console.log(`Serving Sailing/ on http://127.0.0.1:${port}`);
const server = spawn("npx",
  ["--yes", "http-server", ".", "-p", port, "-c-1", "--cors"],
  { stdio: "inherit", cwd: __dirname, shell: true });
server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
