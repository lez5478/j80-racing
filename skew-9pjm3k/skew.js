// Skew — private one-screen tool to detect biased windward-leeward courses
// in HK waters. Runs entirely in the browser; state in localStorage.

const LS_KEY = "skew.pins.v1";
const RHKYC = [22.288, 114.183];

// ---------- Map setup ----------
const map = L.map("map", {
  zoomControl: true, attributionControl: false,
}).setView(RHKYC, 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
}).addTo(map);
L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 19, opacity: 0.85,
}).addTo(map);

// ---------- State ----------
let pins = loadPins();   // { L: {lat,lon} | null, W: {lat,lon} | null }
let twd = null;          // degrees, wind FROM bearing
let twdSpd = null;       // kn (just for display)
let twdSource = "—";

const markers = { L: null, W: null };
const courseLine = L.polyline([], { color: "#a78bfa", weight: 2, dashArray: "6 4" }).addTo(map);
const idealLine = L.polyline([], { color: "#22c55e", weight: 2, dashArray: "2 6", opacity: 0.7 }).addTo(map);

function loadPins() {
  try {
    const obj = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { L: obj.L || null, W: obj.W || null };
  } catch { return { L: null, W: null }; }
}
function savePins() { localStorage.setItem(LS_KEY, JSON.stringify(pins)); }

function renderPin(label) {
  if (markers[label]) { markers[label].remove(); markers[label] = null; }
  const p = pins[label];
  if (!p) return;
  markers[label] = L.marker([p.lat, p.lon], {
    icon: L.divIcon({
      html: `<div class="pin-marker ${label}">${label}</div>`,
      className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    }),
    draggable: true,
  }).addTo(map);
  markers[label].on("dragend", (e) => {
    const ll = e.target.getLatLng();
    pins[label] = { lat: ll.lat, lon: ll.lng };
    savePins();
    recompute();
  });
}

// ---------- Geometry ----------
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

// Initial bearing from a → b, degrees 0–360.
function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Great-circle distance, metres.
function distance(a, b) {
  const R = 6371000;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const dφ = toRad(b.lat - a.lat), dλ = toRad(b.lon - a.lon);
  const x = Math.sin(dφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Project from origin along bearing for distance metres → new lat/lon.
function project(origin, brgDeg, distM) {
  const R = 6371000;
  const δ = distM / R;
  const θ = toRad(brgDeg);
  const φ1 = toRad(origin.lat), λ1 = toRad(origin.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

// ---------- Skew analysis ----------
function skewAnalysis() {
  if (!pins.L || !pins.W || twd == null) return null;
  const courseBrg = bearing(pins.L, pins.W);   // pin → windward
  const idealBeat = (twd + 180) % 360;         // direction the boats want to go
  let skew = courseBrg - idealBeat;
  while (skew > 180) skew -= 360;
  while (skew < -180) skew += 360;
  const beatLen = distance(pins.L, pins.W);
  // Lateral offset of the windward mark from the "square" position:
  // perpendicular distance ≈ beatLen × sin(skew).
  const offsetM = Math.abs(beatLen * Math.sin(toRad(skew)));
  return {
    skewDeg: skew, courseBrg, idealBeat, beatLen,
    offsetM,
    favoured: Math.abs(skew) < 2 ? "square"
            : skew > 0 ? "right side / port-tack first"
            : "left side / starboard-tack first",
  };
}

function colourForSkew(absSkew) {
  if (absSkew < 2) return "green";
  if (absSkew < 5) return "amber";
  return "red";
}

// ---------- Wind ----------
async function fetchHkoWind() {
  // Reuse the parent app's API. Same origin, no CORS issues.
  try {
    const r = await fetch("/api/wind");
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    const today = new Date().toISOString().slice(0, 10);
    const byStation = data.hourly?.[today];
    if (!byStation) return null;
    // Average across stations using vector sum, weighted equally.
    let sx = 0, sy = 0, sumSpd = 0, n = 0;
    for (const series of Object.values(byStation)) {
      const last = series[series.length - 1];
      if (!last || last.deg == null || last.spd == null) continue;
      const r = (last.deg * Math.PI) / 180;
      sx += Math.sin(r); sy += Math.cos(r);
      sumSpd += last.spd; n++;
    }
    if (n === 0) return null;
    const deg = (Math.atan2(sx / n, sy / n) * 180 / Math.PI + 360) % 360;
    return { deg, spd: sumSpd / n, src: `HKO ${n} stns` };
  } catch (e) {
    console.warn("HKO wind fetch failed:", e);
    return null;
  }
}

async function refreshWind() {
  const src = document.getElementById("windSrc").value;
  if (src === "hko") {
    const w = await fetchHkoWind();
    if (w) {
      twd = w.deg; twdSpd = w.spd; twdSource = w.src;
    } else {
      twdSource = "HKO unavailable";
    }
  } else if (src === "manual") {
    const td = parseFloat(document.getElementById("manualTwd").value);
    const ts = parseFloat(document.getElementById("manualSpd").value);
    if (!isNaN(td)) twd = ((td % 360) + 360) % 360;
    if (!isNaN(ts)) twdSpd = ts;
    twdSource = "manual";
  }
  recompute();
}

// ---------- Render ----------
function fmtBrg(d) { return d == null ? "—" : `${Math.round(d)}°`; }
function fmtDist(m) {
  if (m == null) return "—";
  const nm = m / 1852;
  return nm < 0.5 ? `${Math.round(m)} m` : `${nm.toFixed(2)} nm`;
}

function recompute() {
  for (const k of ["L", "W"]) renderPin(k);
  document.getElementById("wind-src").textContent =
    twd != null ? `wind: ${Math.round(twd)}° ${twdSpd ? "· " + twdSpd.toFixed(0) + " kn" : ""} (${twdSource})`
                : `wind: ${twdSource}`;

  const a = skewAnalysis();
  const numEl = document.getElementById("skew-num");
  const tagEl = document.getElementById("skew-tag");
  if (!a) {
    numEl.className = "skew-num gray";
    numEl.textContent = "—°";
    tagEl.textContent = !pins.L ? "tap 'Pin L' at the leeward mark"
                       : !pins.W ? "tap 'Pin W' at the windward mark"
                       : "waiting for wind direction";
    document.getElementById("courseBrg").textContent = "—";
    document.getElementById("twdVal").textContent = twd != null ? fmtBrg(twd) : "—";
    document.getElementById("beatLen").textContent = "—";
    document.getElementById("suggested").textContent = "—";
    courseLine.setLatLngs([]);
    idealLine.setLatLngs([]);
    return;
  }

  const abs = Math.abs(a.skewDeg);
  numEl.className = "skew-num " + colourForSkew(abs);
  numEl.textContent = `${a.skewDeg > 0 ? "+" : ""}${a.skewDeg.toFixed(1)}°`;
  tagEl.textContent = a.favoured;

  document.getElementById("courseBrg").textContent = fmtBrg(a.courseBrg);
  document.getElementById("twdVal").textContent = fmtBrg(twd);
  document.getElementById("beatLen").textContent = fmtDist(a.beatLen);

  // Suggested move: how far + which direction to walk W to make the course square.
  let move = "Course is square ✓";
  if (abs >= 2) {
    const moveM = Math.round(a.offsetM);
    const moveBrg = (a.idealBeat + (a.skewDeg > 0 ? -90 : 90) + 360) % 360;
    move = `Move W mark ~${moveM} m on bearing ${Math.round(moveBrg)}°`;
  }
  document.getElementById("suggested").textContent = move;

  // Map overlays: pin → W actual + ideal-beat ghost from L.
  courseLine.setLatLngs([[pins.L.lat, pins.L.lon], [pins.W.lat, pins.W.lon]]);
  const ghost = project(pins.L, a.idealBeat, a.beatLen);
  idealLine.setLatLngs([[pins.L.lat, pins.L.lon], [ghost.lat, ghost.lon]]);

  // Frame both pins.
  if (pins.L && pins.W) {
    map.fitBounds(L.latLngBounds([
      [pins.L.lat, pins.L.lon], [pins.W.lat, pins.W.lon], [ghost.lat, ghost.lon],
    ]), { padding: [40, 40] });
  }
}

// ---------- UI wiring ----------
function pinHere(label, btn) {
  if (!navigator.geolocation) { alert("No GPS"); return; }
  btn.textContent = "📍 …";
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      pins[label] = { lat: p.coords.latitude, lon: p.coords.longitude };
      savePins();
      recompute();
      btn.textContent = `✓ ${label} pinned`;
      btn.classList.add("pinned");
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = `📍 Pin ${label}`;
        btn.classList.remove("pinned");
      }, 2000);
    },
    (err) => {
      alert(`GPS failed: ${err.message}`);
      btn.textContent = `📍 Pin ${label}`;
      btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
  );
}

document.getElementById("pinL").onclick = (e) => pinHere("L", e.target);
document.getElementById("pinW").onclick = (e) => pinHere("W", e.target);
document.getElementById("locate").onclick = () => {
  if (pins.L && pins.W) {
    map.fitBounds(L.latLngBounds([[pins.L.lat, pins.L.lon], [pins.W.lat, pins.W.lon]]), { padding: [40, 40] });
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 15),
      () => map.setView(RHKYC, 13),
    );
  }
};
document.getElementById("reset").onclick = () => {
  if (!confirm("Clear both pins?")) return;
  pins = { L: null, W: null };
  savePins();
  recompute();
};

// Allow tap-to-place if no pin yet for that label (long-press or just sequential).
let nextPin = null;
map.on("click", (e) => {
  if (!pins.L) nextPin = "L";
  else if (!pins.W) nextPin = "W";
  else return;
  pins[nextPin] = { lat: e.latlng.lat, lon: e.latlng.lng };
  savePins();
  recompute();
});

const windSrcSel = document.getElementById("windSrc");
const manTwd = document.getElementById("manualTwd");
const manSpd = document.getElementById("manualSpd");
windSrcSel.onchange = () => {
  const isManual = windSrcSel.value === "manual";
  manTwd.hidden = !isManual;
  manSpd.hidden = !isManual;
  refreshWind();
};
manTwd.oninput = () => refreshWind();
manSpd.oninput = () => refreshWind();

// Refresh HKO wind every 5 min while the page is open.
refreshWind();
setInterval(() => {
  if (windSrcSel.value === "hko") refreshWind();
}, 5 * 60 * 1000);

// Initial render to show whatever's persisted.
recompute();

// Keep screen awake while in use (modern browsers).
if ("wakeLock" in navigator) {
  let wl = null;
  const acquire = async () => {
    try { wl = await navigator.wakeLock.request("screen"); } catch {}
  };
  acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") acquire();
  });
}
