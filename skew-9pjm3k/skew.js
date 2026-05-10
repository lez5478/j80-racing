// Skew — private one-screen course-bias detector for HK waters.
// Three independent metrics:
//   1. Windward-mark side bias  (CB + Pin + W vs TWD): is W left or right
//      of the start-line midpoint's wind axis? Tells you which tack to
//      take off the start to get to the favoured side first.
//   2. Start-line bias          (CB + Pin vs TWD):     which end of the
//      line is closer to the wind? Start there.
//   3. Course skew              (L + W vs TWD):        is the upwind axis
//      square or biased? Race-officer perspective.

const LS_KEY = "skew.pins.v2";
const RHKYC = [22.288, 114.183];
const PINS = ["CB", "P", "W", "L"];

// ---------- Map ----------
const map = L.map("map", {
  zoomControl: true, attributionControl: false,
}).setView(RHKYC, 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", { maxZoom: 19, opacity: 0.85 }).addTo(map);

// ---------- State ----------
let pins = loadPins();   // { CB, P, W, L: {lat,lon} | null }
let twd = null;          // wind FROM bearing
let twdSpd = null;
let twdSource = "—";

const markers = { CB: null, P: null, W: null, L: null };
const startLine    = L.polyline([], { color: "#facc15", weight: 3, opacity: 0.9 }).addTo(map);
const courseLine   = L.polyline([], { color: "#a78bfa", weight: 2, dashArray: "6 4" }).addTo(map);
const idealAxis    = L.polyline([], { color: "#22c55e", weight: 2, dashArray: "2 6", opacity: 0.7 }).addTo(map);
const wmAxis       = L.polyline([], { color: "#fb923c", weight: 1.5, dashArray: "4 4", opacity: 0.55 }).addTo(map);

function loadPins() {
  try {
    const obj = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return PINS.reduce((acc, k) => { acc[k] = obj[k] || null; return acc; }, {});
  } catch { return PINS.reduce((acc, k) => { acc[k] = null; return acc; }, {}); }
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

function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function distance(a, b) {
  const R = 6371000;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const dφ = toRad(b.lat - a.lat), dλ = toRad(b.lon - a.lon);
  const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
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
function midpoint(a, b) { return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }; }
function signedAngle(a, b) {
  // Smallest signed angle a → b in (-180, 180].
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------- Analyses ----------
function analyseStartLine() {
  if (!pins.CB || !pins.P || twd == null) return null;
  // Line bearing CB → Pin. Square = perpendicular to wind = TWD ± 90°.
  const lineBrg = bearing(pins.CB, pins.P);
  const idealLineBrg = (twd + 90) % 360; // perpendicular to wind, one of two
  const otherIdeal = (twd + 270) % 360;
  // Pick whichever ideal is closer to the actual line bearing.
  const skewA = signedAngle(idealLineBrg, lineBrg);
  const skewB = signedAngle(otherIdeal, lineBrg);
  const skew = Math.abs(skewA) <= Math.abs(skewB) ? skewA : skewB;
  const lineLen = distance(pins.CB, pins.P);
  // The favoured end is the one further upwind. Project each end onto the
  // upwind axis (TWD direction) and compare.
  const cb = projectOntoUpwindAxis(pins.CB, pins.CB, twd);
  const pn = projectOntoUpwindAxis(pins.P, pins.CB, twd);
  let favoured = "square";
  if (Math.abs(cb - pn) > 1) favoured = pn > cb ? "Pin end" : "CB end";
  return { skew, lineBrg, lineLen, favoured };
}
function projectOntoUpwindAxis(point, origin, twdDeg) {
  // Returns metres "upwind from origin" along the TWD axis.
  const brg = bearing(origin, point);
  const dist = distance(origin, point);
  const angle = signedAngle(twdDeg, brg);
  return dist * Math.cos(toRad(angle));
}
function analyseWmSideBias() {
  if (!pins.CB || !pins.P || !pins.W || twd == null) return null;
  const mid = midpoint(pins.CB, pins.P);
  // Bearing from start mid to W. Compare with the ideal upwind bearing (TWD).
  const wBrg = bearing(mid, pins.W);
  const skew = signedAngle(twd, wBrg);
  const beatLen = distance(mid, pins.W);
  // Lateral offset of W from the wind-axis through start mid.
  const offsetM = beatLen * Math.sin(toRad(skew));
  // Sign convention: positive skew = W is to the right of TWD when looking
  // upwind = port-tack favoured (boats need to go right).
  const side = Math.abs(skew) < 2 ? "centred"
              : skew > 0 ? "Pin / right side favoured (port-tack approach)"
              : "CB / left side favoured (starboard-tack approach)";
  return { skew, beatLen, offsetM, side, mid, wBrg };
}
function analyseCourseSkew() {
  if (!pins.L || !pins.W || twd == null) return null;
  const courseBrg = bearing(pins.L, pins.W);
  const idealBeat = (twd + 180) % 360;
  const skew = signedAngle(idealBeat, courseBrg);
  const beatLen = distance(pins.L, pins.W);
  const offsetM = Math.abs(beatLen * Math.sin(toRad(skew)));
  return { skew, courseBrg, beatLen, offsetM };
}

function colourForSkew(absSkew) {
  if (absSkew < 2) return "green";
  if (absSkew < 5) return "amber";
  return "red";
}

// ---------- Wind ----------
async function fetchHkoWind() {
  try {
    const r = await fetch("/api/wind");
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    const today = new Date().toISOString().slice(0, 10);
    const byStation = data.hourly?.[today];
    if (!byStation) return null;
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
    if (w) { twd = w.deg; twdSpd = w.spd; twdSource = w.src; }
    else twdSource = "HKO unavailable";
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
const fmtBrg = (d) => d == null ? "—" : `${Math.round(d)}°`;
const fmtDist = (m) => {
  if (m == null) return "—";
  const nm = m / 1852;
  return nm < 0.5 ? `${Math.round(m)} m` : `${nm.toFixed(2)} nm`;
};
const fmtSkew = (d) => d == null ? "—°" : `${d > 0 ? "+" : ""}${d.toFixed(1)}°`;

function setCard(numId, tagId, signedDeg, tagText, fallback) {
  const numEl = document.getElementById(numId);
  const tagEl = document.getElementById(tagId);
  if (signedDeg == null) {
    numEl.className = "value gray";
    numEl.textContent = "—°";
    tagEl.textContent = fallback;
    return;
  }
  numEl.className = "value " + colourForSkew(Math.abs(signedDeg));
  numEl.textContent = fmtSkew(signedDeg);
  tagEl.textContent = tagText;
}

function recompute() {
  for (const k of PINS) renderPin(k);
  document.getElementById("wind-src").textContent =
    twd != null ? `wind: ${Math.round(twd)}° ${twdSpd ? "· " + twdSpd.toFixed(0) + " kn" : ""} (${twdSource})`
                : `wind: ${twdSource}`;

  const wms = analyseWmSideBias();
  const line = analyseStartLine();
  const course = analyseCourseSkew();

  setCard("wmsBias", "wmsTag",
    wms?.skew, wms ? wms.side : "",
    !pins.CB ? "pin CB" : !pins.P ? "pin Pin end" : !pins.W ? "pin W" : "waiting for wind");
  setCard("lineBias", "lineTag",
    line?.skew, line ? `${Math.abs(line.skew) < 2 ? "square" : line.favoured + " favoured"} · ${fmtDist(line.lineLen)}` : "",
    !pins.CB ? "pin CB" : !pins.P ? "pin Pin end" : "waiting for wind");
  setCard("courseSkew", "courseTag",
    course?.skew, course ? `course ${fmtBrg(course.courseBrg)} · ${fmtDist(course.beatLen)}` : "",
    !pins.L ? "pin L" : !pins.W ? "pin W" : "waiting for wind");

  // Suggested action: prioritise the windward-mark side bias if it's set,
  // otherwise the start-line bias if just CB/Pin, else course skew.
  let advice = "—";
  if (wms && Math.abs(wms.skew) >= 2) {
    const m = Math.round(Math.abs(wms.offsetM));
    advice = `W is offset ${m} m to the ${wms.skew > 0 ? "Pin" : "CB"} side. ` +
             `Get to the ${wms.skew > 0 ? "right" : "left"} side off the start.`;
  } else if (line && Math.abs(line.skew) >= 2) {
    advice = `Start line skewed — ${line.favoured} is favoured.`;
  } else if (course && Math.abs(course.skew) >= 2) {
    const m = Math.round(course.offsetM);
    advice = `Course is skewed ${course.skew > 0 ? "right" : "left"} by ${m} m at the W mark.`;
  } else if (wms || line || course) {
    advice = "Course / line are square ✓";
  }
  document.getElementById("suggested").textContent = advice;

  // Map overlays.
  startLine.setLatLngs(pins.CB && pins.P
    ? [[pins.CB.lat, pins.CB.lon], [pins.P.lat, pins.P.lon]]
    : []);
  courseLine.setLatLngs(pins.L && pins.W
    ? [[pins.L.lat, pins.L.lon], [pins.W.lat, pins.W.lon]]
    : []);
  // Ideal upwind axis from the start-line mid (or L if no line) — green dashes.
  if (twd != null) {
    const origin = (pins.CB && pins.P) ? midpoint(pins.CB, pins.P) : pins.L;
    if (origin) {
      const len = wms ? wms.beatLen : (course ? course.beatLen : 600);
      const tip = project(origin, twd, len);
      idealAxis.setLatLngs([[origin.lat, origin.lon], [tip.lat, tip.lon]]);
    } else idealAxis.setLatLngs([]);
  } else idealAxis.setLatLngs([]);
  // Actual axis from start-line mid → W (orange dashes).
  if (wms) {
    wmAxis.setLatLngs([[wms.mid.lat, wms.mid.lon], [pins.W.lat, pins.W.lon]]);
  } else wmAxis.setLatLngs([]);

  // Frame all set pins.
  const placedLLs = PINS.filter((k) => pins[k]).map((k) => [pins[k].lat, pins[k].lon]);
  if (placedLLs.length >= 2) {
    map.fitBounds(L.latLngBounds(placedLLs), { padding: [40, 40], maxZoom: 16 });
  }
}

// ---------- UI wiring ----------
function pinHere(label, btn) {
  if (!navigator.geolocation) { alert("No GPS"); return; }
  const orig = btn.textContent;
  btn.textContent = "📍 …";
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      pins[label] = { lat: p.coords.latitude, lon: p.coords.longitude };
      savePins(); recompute();
      btn.textContent = `✓ ${label}`;
      btn.classList.add("pinned");
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("pinned"); }, 2000);
    },
    (err) => {
      alert(`GPS failed: ${err.message}`);
      btn.textContent = orig; btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
  );
}
for (const [label, id] of [["CB", "pinCB"], ["P", "pinP"], ["W", "pinW"], ["L", "pinL"]]) {
  document.getElementById(id).onclick = (e) => pinHere(label, e.target);
}

document.getElementById("locate").onclick = () => {
  const placed = PINS.filter((k) => pins[k]).map((k) => [pins[k].lat, pins[k].lon]);
  if (placed.length >= 2) {
    map.fitBounds(L.latLngBounds(placed), { padding: [40, 40] });
  } else if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 15),
      () => map.setView(RHKYC, 13),
    );
  }
};
document.getElementById("reset").onclick = () => {
  if (!confirm("Clear all pins?")) return;
  pins = PINS.reduce((acc, k) => { acc[k] = null; return acc; }, {});
  savePins(); recompute();
};

// Tap map to place the next un-pinned mark in priority order CB → P → W → L.
map.on("click", (e) => {
  for (const k of PINS) {
    if (!pins[k]) {
      pins[k] = { lat: e.latlng.lat, lon: e.latlng.lng };
      savePins(); recompute();
      return;
    }
  }
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

refreshWind();
setInterval(() => { if (windSrcSel.value === "hko") refreshWind(); }, 5 * 60 * 1000);

recompute();

if ("wakeLock" in navigator) {
  let wl = null;
  const acquire = async () => { try { wl = await navigator.wakeLock.request("screen"); } catch {} };
  acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") acquire();
  });
}
