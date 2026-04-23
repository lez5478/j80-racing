// Scans every Sail records/<Boat>/<YYYY-MM-DD>/SESSION_*.VTK and prints any
// BUTTON_RC / BUTTON_PIN / BUTTON_LINE_CLEARED events found. Velocitek
// records these when the helmsman pings the two ends of the start line, so
// the trackpoint immediately surrounding each event gives the line's
// coordinates.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "Sail records");
const TYPE_NAMES = ["NONE", "RC", "PIN", "LINE_CLEARED", "MAX"];

// Minimal protobuf wire-format reader (varints + length-delimited).
function readVarint(buf, p) {
  let r = 0n, s = 0n, b;
  do {
    b = buf[p++];
    r |= BigInt(b & 0x7f) << s;
    s += 7n;
  } while (b & 0x80);
  return [Number(r), p];
}

function parseRecord(msg) {
  // Returns { kind, trackpoint?, button? }
  let p = 0;
  while (p < msg.length) {
    const [key, np] = readVarint(msg, p);
    p = np;
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 2) {
      const [len, np2] = readVarint(msg, p);
      p = np2;
      const sub = msg.subarray(p, p + len);
      p += len;
      if (field === 1) return { kind: "trackpoint", data: parseTrackpoint(sub) };
      if (field === 16) return { kind: "button", data: parseButton(sub) };
      // ignore other oneof variants
      return { kind: "other", field };
    } else {
      // skip
      if (wire === 0) { const [, np2] = readVarint(msg, p); p = np2; }
      else if (wire === 1) p += 8;
      else if (wire === 5) p += 4;
    }
  }
  return null;
}

function parseTrackpoint(sub) {
  // Only need timestamp + lat/lon
  let p = 0; const out = {};
  while (p < sub.length) {
    const [key, np] = readVarint(sub, p); p = np;
    const f = key >>> 3, w = key & 7;
    if (w === 0) {
      const [v, np2] = readVarint(sub, p); p = np2;
      if (f === 1) out.sec = v;
      else if (f === 2) out.csec = v;
      else if (f === 3) out.lat = ((v >>> 1) ^ -(v & 1)) / 1e7;
      else if (f === 4) out.lon = ((v >>> 1) ^ -(v & 1)) / 1e7;
    } else if (w === 2) {
      const [len, np2] = readVarint(sub, p); p = np2 + len;
    } else if (w === 1) p += 8; else if (w === 5) p += 4;
  }
  return out;
}

function parseButton(sub) {
  let p = 0; let type = 0;
  while (p < sub.length) {
    const [key, np] = readVarint(sub, p); p = np;
    const f = key >>> 3, w = key & 7;
    if (f === 1 && w === 0) {
      const [v, np2] = readVarint(sub, p); p = np2;
      type = v;
    } else {
      if (w === 0) { const [, np2] = readVarint(sub, p); p = np2; }
      else if (w === 2) { const [len, np2] = readVarint(sub, p); p = np2 + len; }
      else if (w === 1) p += 8; else if (w === 5) p += 4;
    }
  }
  return type;
}

function* walkVtk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkVtk(full);
    else if (/\.vtk$/i.test(e.name)) yield full;
  }
}

let totalFiles = 0, totalEvents = 0;
const filesWith = [];
for (const file of walkVtk(ROOT)) {
  totalFiles++;
  const buf = fs.readFileSync(file);
  let i = 0;
  let lastTrack = null;
  const events = [];
  while (i + 2 <= buf.length) {
    const len = buf[i] | (buf[i + 1] << 8);
    i += 2;
    if (len === 0 || i + len > buf.length) break;
    const r = parseRecord(buf.subarray(i, i + len));
    i += len;
    if (!r) continue;
    if (r.kind === "trackpoint") lastTrack = r.data;
    else if (r.kind === "button") {
      events.push({
        type: TYPE_NAMES[r.data] || `?${r.data}`,
        // Use the last trackpoint as the position (button doesn't carry lat/lon).
        sec: lastTrack?.sec ?? null,
        lat: lastTrack?.lat ?? null,
        lon: lastTrack?.lon ?? null,
      });
    }
  }
  if (events.length) {
    totalEvents += events.length;
    filesWith.push({ file: path.relative(ROOT, file), events });
  }
}

console.log(`Scanned ${totalFiles} VTK files — ${totalEvents} button events in ${filesWith.length} files`);
for (const f of filesWith) {
  console.log(`\n${f.file}`);
  for (const ev of f.events) {
    const t = ev.sec ? new Date(ev.sec * 1000).toISOString() : "?";
    console.log(`  ${ev.type.padEnd(15)} ${t}  ${ev.lat?.toFixed(6) ?? "?"}, ${ev.lon?.toFixed(6) ?? "?"}`);
  }
}
