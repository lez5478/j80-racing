// ---------- Minimal protobuf wire-format decoder ----------
// Only what we need for Velocitek VTK: varints, length-delimited, sint32 zigzag.
function Reader(buf) {
  this.b = buf; this.p = 0;
}
Reader.prototype.eof = function () { return this.p >= this.b.length; };
Reader.prototype.varint = function () {
  let result = 0n, shift = 0n;
  while (true) {
    if (this.p >= this.b.length) throw new Error("varint EOF");
    const byte = this.b[this.p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  return result;
};
Reader.prototype.varintNum = function () { return Number(this.varint()); };
Reader.prototype.sint32 = function () {
  const n = this.varintNum();
  return (n >>> 1) ^ -(n & 1);
};
Reader.prototype.bytes = function () {
  const len = this.varintNum();
  const slice = this.b.subarray(this.p, this.p + len);
  this.p += len;
  return slice;
};
Reader.prototype.skip = function (wire) {
  if (wire === 0) this.varint();
  else if (wire === 2) this.bytes();
  else if (wire === 1) this.p += 8;
  else if (wire === 5) this.p += 4;
  else throw new Error("unsupported wire " + wire);
};

// ---------- VTK parser ----------
// File is a stream of records; each = u16 LE length + protobuf Record.
// Record has oneof: trackpoint=1, timer_event=2, button_event=16,
//                   hardware_description=17, magnetic_declination=18.
// Trackpoint fields: 1 seconds, 2 centiseconds,
//                    3 latE7 (sint32), 4 lonE7 (sint32),
//                    5 sog*10 kts, 6 cog deg, 7..10 quaternion.
// Returns { points, buttons } where buttons captures the helmsman's
// start-line marks (BUTTON_RC = committee end, BUTTON_PIN = pin end).
// Velocitek records the button type with no embedded position, so we tag
// each event with the most recent trackpoint's lat/lon/time.
const BUTTON_NAMES = ["NONE", "RC", "PIN", "LINE_CLEARED", "MAX"];
// Convert a (q1, q2, q3, q4) quaternion to heel (degrees, port −, starboard +)
// and pitch (degrees, bow up + ). Velocitek's docs say the quaternion is
// "relative to local magnetic north" but don't specify the axis convention;
// what comes out empirically matches roll/pitch when treated as standard
// (w, x, y, z) with z-up, x-forward.
function quatToHeelPitch(q1, q2, q3, q4) {
  // Treat q1=w (scalar), q2=x, q3=y, q4=z.
  const w = q1, x = q2, y = q3, z = q4;
  // Normalize defensively (Velocitek values should be unit but cheap to verify).
  const n = Math.sqrt(w * w + x * x + y * y + z * z) || 1;
  const W = w / n, X = x / n, Y = y / n, Z = z / n;
  // Standard quaternion -> Euler (ZYX intrinsic):
  //   roll  (φ) = atan2(2(WX + YZ), 1 - 2(X² + Y²))
  //   pitch (θ) = asin( clamp(2(WY - ZX), -1, 1) )
  const roll = Math.atan2(2 * (W * X + Y * Z), 1 - 2 * (X * X + Y * Y));
  const pitchSin = Math.max(-1, Math.min(1, 2 * (W * Y - Z * X)));
  const pitch = Math.asin(pitchSin);
  return { heel: roll * 180 / Math.PI, pitch: pitch * 180 / Math.PI };
}

function parseVTK(uint8) {
  const points = [];
  const buttons = [];
  let lastTrack = null;
  let i = 0;
  while (i + 2 <= uint8.length) {
    const len = uint8[i] | (uint8[i + 1] << 8);
    i += 2;
    if (len === 0 || i + len > uint8.length) break;
    const msg = uint8.subarray(i, i + len);
    i += len;

    const r = new Reader(msg);
    while (!r.eof()) {
      const key = r.varintNum();
      const field = key >>> 3;
      const wire = key & 7;
      if (field === 1 && wire === 2) {
        // Trackpoint
        const tp = new Reader(r.bytes());
        let sec = 0, csec = 0, lat = null, lon = null, sog = 0, cog = 0;
        let q1 = null, q2 = null, q3 = null, q4 = null;
        while (!tp.eof()) {
          const k2 = tp.varintNum();
          const f = k2 >>> 3, w = k2 & 7;
          if (f === 1 && w === 0) sec = tp.varintNum();
          else if (f === 2 && w === 0) csec = tp.varintNum();
          else if (f === 3 && w === 0) lat = tp.sint32() / 1e7;
          else if (f === 4 && w === 0) lon = tp.sint32() / 1e7;
          else if (f === 5 && w === 0) sog = tp.varintNum() / 10; // knots
          else if (f === 6 && w === 0) cog = tp.varintNum();       // degrees
          else if (f === 7 && w === 0) q1 = tp.sint32() / 1000;
          else if (f === 8 && w === 0) q2 = tp.sint32() / 1000;
          else if (f === 9 && w === 0) q3 = tp.sint32() / 1000;
          else if (f === 10 && w === 0) q4 = tp.sint32() / 1000;
          else tp.skip(w);
        }
        if (lat !== null && lon !== null) {
          const pt = { t: sec + csec / 100, lat, lon, sog, cog };
          if (q1 !== null && q2 !== null && q3 !== null && q4 !== null) {
            const orient = quatToHeelPitch(q1, q2, q3, q4);
            pt.heel = orient.heel;
            pt.pitch = orient.pitch;
          }
          points.push(pt);
          lastTrack = pt;
        }
      } else if (field === 16 && wire === 2) {
        // ButtonEvent — single varint field: type
        const bt = new Reader(r.bytes());
        let type = 0;
        while (!bt.eof()) {
          const k2 = bt.varintNum();
          const f = k2 >>> 3, w = k2 & 7;
          if (f === 1 && w === 0) type = bt.varintNum();
          else bt.skip(w);
        }
        if (lastTrack && type >= 1 && type <= 3) {
          buttons.push({
            type: BUTTON_NAMES[type] || String(type),
            t: lastTrack.t,
            lat: lastTrack.lat,
            lon: lastTrack.lon,
          });
        }
      } else {
        r.skip(wire);
      }
    }
  }
  return { points, buttons };
}

// ---------- Map ----------
const map = L.map("map", { zoomControl: true }).setView([43.0, 141.4], 11);
// Base map choices — all free, no API key. CartoDB Positron is the
// cleanest (recommended for racing); Esri Ocean shows bathymetry; OSM is
// the busy default if you want street labels.
const BASE_LAYERS = {
  "Positron (clean)": L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd",
    attribution: "© OpenStreetMap, © CARTO",
  }),
  "Positron with labels": L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd",
    attribution: "© OpenStreetMap, © CARTO",
  }),
  "Voyager (balanced)": L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19, subdomains: "abcd",
    attribution: "© OpenStreetMap, © CARTO",
  }),
  "Esri Ocean (bathymetry)": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 13,
    attribution: "Tiles © Esri — Sources: GEBCO, NOAA, NatGeo, et al.",
  }),
  "Esri Imagery (satellite)": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles © Esri",
  }),
  "OpenStreetMap (full detail)": L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }),
};

// Default to full OpenStreetMap — the picker lets you switch any time.
const LS_BASE = "sailing.baseMap";
const savedBase = localStorage.getItem(LS_BASE);
const initialBaseName = (savedBase && BASE_LAYERS[savedBase])
  ? savedBase : "OpenStreetMap (full detail)";
BASE_LAYERS[initialBaseName].addTo(map);

// OpenSeaMap seamarks overlay (always on top of whichever base is chosen).
const seamarksLayer = L.tileLayer(
  "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
  maxZoom: 18, opacity: 1.0,
  attribution: "Seamarks © OpenSeaMap",
}).addTo(map);

// Top-right Leaflet layer control with the base + the seamarks toggle.
L.control.layers(BASE_LAYERS, { "Seamarks (OpenSeaMap)": seamarksLayer }, {
  position: "topright", collapsed: true,
}).addTo(map);

// Persist whichever base the user picks.
map.on("baselayerchange", (e) => localStorage.setItem(LS_BASE, e.name));

// ---------- Wind (HKO daily, Lamma Island) ----------
const windLayer = L.layerGroup().addTo(map);
const windEl = document.getElementById("wind");
const windBody = windEl.querySelector(".wind-body");
const KMH_TO_KN = 1 / 1.852;
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compass(deg) { return COMPASS[Math.round(((deg % 360) / 22.5)) % 16]; }

// SVG wind arrow rendered as a Leaflet divIcon. The arrow shows where the
// wind is blowing TO (downwind), so a sailor sees the wind coming from the
// arrow's tail. Length scales with speed (km/h), capped for sanity.
function windArrowIcon(dirFrom, speedKmh, color = "#6ea8ff") {
  const downwind = (dirFrom + 180) % 360;
  const len = Math.min(60, 18 + Math.min(speedKmh, 60) * 0.8); // px
  const w = len * 2 + 80;  // extra room for label
  const h = len * 2 + 20;
  const cx = len + 10, cy = len + 10;
  const labelKn = (speedKmh * KMH_TO_KN).toFixed(1);
  const label = `${compass(dirFrom)} ${dirFrom.toString().padStart(3,"0")}° · ${speedKmh.toFixed(1)} km/h (${labelKn} kn)`;
  return L.divIcon({
    className: "wind-marker",
    html: `
      <div style="position: relative; width:${w}px; height:${h}px;">
        <svg width="${w}" height="${h}" style="position:absolute; left:0; top:0;">
          <g transform="translate(${cx},${cy}) rotate(${downwind})">
            <line x1="0" y1="0" x2="0" y2="${-len}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
            <polygon points="0,${-len - 10} -6,${-len + 4} 6,${-len + 4}" fill="${color}" stroke="#fff" stroke-width="1"/>
            <circle cx="0" cy="0" r="4" fill="#fff" stroke="${color}" stroke-width="2"/>
          </g>
        </svg>
        <div class="label">${label}</div>
      </div>`,
    iconSize: [w, h],
    iconAnchor: [cx, cy],
  });
}

function renderWindForDay(dayKey) {
  windLayer.clearLayers();
  windEl.hidden = true;
  windBody.innerHTML = "";
  if (!dayKey || !window.WIND_DAILY) return;
  const w = window.WIND_DAILY[dayKey];
  if (!w || w.dir == null || w.speed == null) return;
  // The old single-value daily chart renders just at Lamma Island (its
  // source station); the live hourly layer + interpolation handles the
  // rest of the stations now.
  const coords = (window.WIND_STATION_COORDS || {})["Lamma Island"];
  if (coords) {
    L.marker([coords.lat, coords.lon], {
      icon: windArrowIcon(w.dir, w.speed),
      interactive: false,
      keyboard: false,
      zIndexOffset: 200,
    }).addTo(windLayer);
  }
  // Sidebar chip
  const dw = (w.dir + 180) % 360;
  const stName = "Lamma Island";
  windBody.innerHTML = `
    <svg class="arrow" viewBox="-16 -16 32 32">
      <g transform="rotate(${dw})">
        <line x1="0" y1="0" x2="0" y2="-12" stroke="#6ea8ff" stroke-width="2.5" stroke-linecap="round"/>
        <polygon points="0,-15 -4,-9 4,-9" fill="#6ea8ff" stroke="#fff" stroke-width="0.5"/>
      </g>
    </svg>
    <div class="nums">
      <div><strong>${compass(w.dir)} ${w.dir.toString().padStart(3,"0")}°</strong>
           <small>(from)</small></div>
      <div><strong>${w.speed.toFixed(1)} km/h</strong>
           <small>${(w.speed * KMH_TO_KN).toFixed(1)} kn · ${stName}</small></div>
    </div>`;
  windEl.hidden = false;
}

// ---------- Track management ----------
const COLORS = [
  "#ff4d4f", "#4dabff", "#52c41a", "#faad14", "#b37feb",
  "#13c2c2", "#eb2f96", "#fa8c16", "#2f54eb", "#a0d911",
];
let colorIdx = 0;
// Whose boat are we watching? Each fleet member picks their own from the
// dropdown — that boat gets highlighted in the scoreboard, drives the
// "Meltemi: P3" line in race stats, and is the "self" reference for the
// gap chart and ghost-fleet. Defaults to whatever the user picked last
// (saved in localStorage).
const MY_BOAT_KEY = "sailing.myBoat";
let MY_BOAT = { sail: "HKG2231", name: "Meltemi" }; // sensible default
try {
  const saved = JSON.parse(localStorage.getItem(MY_BOAT_KEY) || "null");
  if (saved && saved.sail && saved.name) MY_BOAT = saved;
} catch { /* corrupt storage */ }

// Stable colour per boat name — Meltemi is always red, Jelignite always
// blue, etc. — so the same boat is the same colour across R1/R2/R3 of a
// day and across multi-day comparisons.
const boatColors = new Map();
function colorForBoat(boatName) {
  if (!boatName) return COLORS[colorIdx++ % COLORS.length];
  if (!boatColors.has(boatName)) {
    boatColors.set(boatName, COLORS[boatColors.size % COLORS.length]);
  }
  return boatColors.get(boatName);
}
const tracks = []; // { id, name, layer, line, points, color, visible, boat, ... }
let selectedTrackId = null;

const tracksEl = document.getElementById("tracks");
const statusEl = document.getElementById("status");

function humanDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "";
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : `${m}m${s}s`;
}

// HTML for the boat marker's click popup. Pure inline styling so we don't
// have to add CSS rules for the .leaflet-popup contents.
function boatPopupHtml(track, sample) {
  const boatName = track.meta?.boat || track.name;
  const race = track.meta?.race;
  const sailNo = boatName === MY_BOAT.name ? MY_BOAT.sail : "";
  const cog = Math.round(sample.cog).toString().padStart(3, "0");
  const sog = sample.sog.toFixed(1);
  const sogKn = (sample.sog).toFixed(1); // VTK SOG is already in knots
  const tStr = new Date(sample.t * 1000).toLocaleTimeString();
  const subtitle = race
    ? `${race.name}${race.title ? " · " + race.title : ""}`
    : "";
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.7);">
      <div style="font-weight:700;color:${track.color};font-size:12px;">
        ${boatName}${sailNo ? ` <span style="color:#cbd5e1;font-weight:400;font-size:10px;">${sailNo}</span>` : ""}
      </div>
      <div style="font-size:11px;font-variant-numeric:tabular-nums;margin-top:2px;">
        <b>${sogKn}</b> kn · <b>${cog}</b>°
      </div>
    </div>`;
}

// Sailboat icon viewed from above — hull oriented to the boat's COG, sail
// rotated relative to the hull based on TWA so it always sits on the
// leeward side. Two nested rotations:
//   .boat-icon    rotates by COG (world frame)
//   .boat-sail    rotates by sailAngle (boat frame, relative to centerline)
//
// Sail-angle convention (looking down on the deck, bow up):
//   sailAngle > 0  → sail extending to the right (starboard side)
//   sailAngle < 0  → sail extending to the left  (port side)
//   wind from starboard → sail blown to PORT, sailAngle is NEGATIVE
//   wind from port      → sail blown to STARBOARD, sailAngle is POSITIVE
function boatIcon(color, heading) {
  const html = `
    <div class="boat-icon" style="transform: rotate(${heading}deg);">
      <svg viewBox="-12 -14 24 24">
        <!-- Hull: pointed bow at top, wider stern at bottom -->
        <path class="hull" d="M 0,-11 C 4,-6 4.5,3 3.5,7 L 0,8.5 L -3.5,7 C -4.5,3 -4,-6 0,-11 Z"
          fill="${color}" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>
        <!-- Mast (small dot) -->
        <circle cx="0" cy="-3" r="0.8" fill="#fff"/>
        <!-- Sail (rotated each frame via SVG transform attribute, pivoting at the mast 0,-3). -->
        <g class="boat-sail" transform="rotate(0 0 -3)">
          <path d="M 0,-3 Q 1.4,3 0.4,9" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.5" stroke-linecap="round"/>
        </g>
      </svg>
    </div>`;
  return L.divIcon({
    html, className: "", iconSize: [22, 22], iconAnchor: [11, 11],
  });
}

// Sail angle (degrees, signed) based on the boat's TWA. Magnitude grows
// from close-hauled (~22°) up to dead run (~90°) at TWA 180. Sign is
// chosen so the sail ends up on the leeward side.
function sailAngleFromTwa(twa) {
  if (twa == null || !isFinite(twa)) return null;
  let t = twa;
  while (t > 180) t -= 360; while (t < -180) t += 360;
  const aTwa = Math.abs(t);
  // Empirical fit for typical J/80 trim — tighter on the beat, eased
  // progressively to roughly 90° dead downwind.
  const ang = Math.max(20, Math.min(85, aTwa * 0.55));
  // Wind from starboard (TWA > 0) means sail on PORT side (negative).
  return t > 0 ? -ang : ang;
}

function addTrack(name, points, meta = {}) {
  if (!points.length) {
    statusEl.textContent = `⚠ ${name}: no GPS points`;
    return;
  }
  const color = colorForBoat(meta?.boat);
  const latlngs = points.map((p) => [p.lat, p.lon]);
  // Trail polyline starts EMPTY — points are appended as the race clock
  // advances so you actually watch the boat draw its track during playback.
  // Dotted style (round caps + zero-length dashes) so the underlying map
  // and other boats' tracks stay readable behind it.
  const line = L.polyline([latlngs[0]], {
    color, weight: 3, opacity: 0.95,
    dashArray: "6 5",
  });
  // Tooltip uses just the boat name — race context is already obvious
  // from the active race tab and start-countdown panel.
  const tipBoat = meta?.boat || name;
  const start = L.circleMarker(latlngs[0], {
    radius: 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1,
  }).bindTooltip(`Start: ${tipBoat}`);

  const maxSog = points.reduce((m, p) => Math.max(m, p.sog || 0), 0);
  const duration = points[points.length - 1].t - points[0].t;
  line.bindTooltip(
    `${tipBoat} · ${humanDuration(duration)} · max ${maxSog.toFixed(1)} kn`,
    { sticky: true }
  );

  // Boat marker positioned at the first point; updated every frame by the race clock.
  const boat = L.marker(latlngs[0], {
    icon: boatIcon(color, points[0].cog || 0),
    zIndexOffset: 500,
    riseOnHover: true,
  });
  // Lightweight live popup — name + current SOG/COG. Refreshed from
  // updateBoatsToRaceTime() while open.
  // Offset to the upper-right (instead of straight up) so the popup
  // doesn't blanket the boats clustered just behind/below this one.
  // Pointer-events disabled lets you keep clicking through to nearby
  // markers even while the popup is open.
  boat.bindPopup("", {
    offset: [20, -8],
    autoPan: false,
    className: "boat-popup",
    closeOnClick: false,
    closeButton: true,
  });

  const layerChildren = [line, start, boat];

  // If the helmsman pinged a start line for this race, render it.
  const startMarks = meta?.startMarks;
  if (startMarks && (startMarks.rc || startMarks.pin)) {
    const RC_COLOR = "#facc15";    // yellow — Race Committee
    const PIN_COLOR = "#22c55e";   // green — Pin end
    if (startMarks.rc) {
      const rcMark = L.circleMarker([startMarks.rc.lat, startMarks.rc.lon], {
        radius: 6, weight: 2, color: "#0f1924", fillColor: RC_COLOR, fillOpacity: 1,
      }).bindTooltip(`RC end · ${name}`);
      layerChildren.push(rcMark);
    }
    if (startMarks.pin) {
      const pinMark = L.circleMarker([startMarks.pin.lat, startMarks.pin.lon], {
        radius: 6, weight: 2, color: "#0f1924", fillColor: PIN_COLOR, fillOpacity: 1,
      }).bindTooltip(`Pin end · ${name}`);
      layerChildren.push(pinMark);
    }
    if (startMarks.rc && startMarks.pin) {
      const startLine = L.polyline([
        [startMarks.rc.lat, startMarks.rc.lon],
        [startMarks.pin.lat, startMarks.pin.lon],
      ], { color: "#fff", weight: 2.5, opacity: 0.9, dashArray: "6 4" })
        .bindTooltip(`Start line · ${name}`);
      layerChildren.push(startLine);
    }
  }

  const layer = L.layerGroup(layerChildren).addTo(map);

  const id = tracks.length;
  // Precompute the bounding box of the FULL race so fitAll() can frame it
  // even though the visible trail starts empty.
  const fullBounds = L.latLngBounds(latlngs);
  // Cumulative ground distance (metres) along the track — used by the
  // live legend ranking to score boats by how far they've sailed since
  // the race start.
  const cumDist = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dLat = (b.lat - a.lat) * 111_320;
    const dLon = (b.lon - a.lon) * 111_320 * Math.cos(a.lat * Math.PI / 180);
    cumDist[i] = cumDist[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
  }
  const track = {
    id, name, layer, line, points, color, visible: true,
    latlngs, fullBounds, cumDist,
    boat, maxSog,
    tStart: points[0].t, tEnd: points[points.length - 1].t,
    meta, // { race, boat, window } when set by selectDay
  };
  tracks.push(track);

  const selectFromMarker = () => selectTrack(id);
  // Clicking the track polyline both selects the track AND seeks the race
  // clock to the nearest point on that track.
  line.on("click", (e) => {
    selectFromMarker();
    seekToTrackPoint(tracks[id], e.latlng);
  });
  boat.on("click", selectFromMarker);
  // Populate the popup with current sample whenever it opens (click or
  // programmatic). Subsequent ticks update it via updateBoatsToRaceTime.
  boat.on("popupopen", () => {
    const tr = tracks[id];
    if (!tr || tr.removed) return;
    const clamped = Math.max(tr.tStart, Math.min(tr.tEnd, raceTime ?? tr.tStart));
    const s = sampleAt(tr, clamped);
    boat.setPopupContent(boatPopupHtml(tr, s));
  });

  const li = document.createElement("li");
  li.dataset.id = id;
  li.innerHTML = `
    <span class="swatch" style="background:${color}"></span>
    <span class="name" title="${name}">${name}</span>
    <span class="meta">${points.length}·${humanDuration(duration)}</span>
    <button title="Remove">✕</button>
  `;
  li.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") return;
    if (e.target.classList.contains("swatch")) return;
    selectTrack(id);
    map.fitBounds(track.fullBounds, { padding: [10, 10], maxZoom: 17 });
  });
  li.querySelector(".swatch").addEventListener("click", (e) => {
    e.stopPropagation();
    track.visible = !track.visible;
    if (track.visible) layer.addTo(map); else map.removeLayer(layer);
    li.classList.toggle("hidden", !track.visible);
    updateRaceClockBounds();
    renderTrackLegend();
    renderRaceMarksOnMap(); renderFinishLineOnMap(); refresh3DScene();
  });
  li.querySelector("button").addEventListener("click", (e) => {
    e.stopPropagation();
    map.removeLayer(layer);
    li.remove();
    track.removed = true;
    if (selectedTrackId === id) selectTrack(null);
    updateRaceClockBounds();
    renderTrackLegend();
    renderRaceMarksOnMap(); renderFinishLineOnMap(); refresh3DScene();
  });
  tracksEl.appendChild(li);

  fitAll();
  updateRaceClockBounds();
  // Place the boat at whatever the current race time is (or start).
  updateBoatsToRaceTime(raceTime ?? track.tStart);
  renderTrackLegend();
  statusEl.textContent = `Loaded ${tracks.filter((t) => !t.removed).length} track(s)`;
}

// ---------- HKO wind on the map ----------
// One marker per station with coordinates (window.WIND_STATION_COORDS).
// Each marker is a rotating arrow + speed label, updating with the race
// clock so you can watch the wind field evolve as the race plays back.

const windMapLayer = L.layerGroup().addTo(map);
const windMarkers = new Map(); // station name -> { marker, update(reading) }

function windArrowIcon(deg, speed) {
  // Beaufort-ish color ramp (km/h): light=blue, fresh=green, strong=orange, gale=red.
  const s = speed ?? 0;
  const color = s < 6 ? "#9ec5ff"
              : s < 12 ? "#6fd06b"
              : s < 20 ? "#facc15"
              : s < 30 ? "#fb923c"
                       : "#ef4444";
  // Wind blows TOWARDS deg+180 (HKO reports direction wind is FROM).
  const rot = deg != null ? (deg + 180) % 360 : 0;
  const html = `
    <div class="wm-icon" style="transform: rotate(${rot}deg);">
      <svg viewBox="-12 -12 24 24">
        <circle cx="0" cy="0" r="3" fill="${color}" stroke="#0f1924" stroke-width="0.8"/>
        ${deg != null ? `<path d="M0,-10 L4,2 L0,0 L-4,2 Z" fill="${color}" stroke="#0f1924" stroke-width="0.6"/>` : ""}
      </svg>
      <div class="wm-label" style="transform: rotate(${-rot}deg);">${s ?? "–"}</div>
    </div>`;
  return L.divIcon({
    html, className: "", iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

function ensureWindMarkers() {
  if (windMarkers.size || !window.WIND_STATION_COORDS) return;
  for (const [name, coord] of Object.entries(window.WIND_STATION_COORDS)) {
    const m = L.marker([coord.lat, coord.lon], {
      icon: windArrowIcon(null, null),
      zIndexOffset: 200,
      interactive: true,
    }).bindTooltip(name, { direction: "top", offset: [0, -8] });
    windMarkers.set(name, { marker: m, coord, last: null });
  }
}
ensureWindMarkers();

// Sample each station's reading at the current race-time hour and refresh icons.
function updateWindMap() {
  if (!windMarkers.size || !window.WIND_HOURLY) return;
  const date = activeDayKey;
  const day = window.WIND_HOURLY[date];
  if (!day) {
    // No data for this day — hide all markers AND clear cached readings
    // so the particle animation / IDW grid stop drawing yesterday's wind.
    for (const info of windMarkers.values()) {
      windMapLayer.removeLayer(info.marker);
      info.last = null;
    }
    return;
  }
  let h = null;
  if (raceTime != null) {
    const hk = new Date((raceTime + 8 * 3600) * 1000);
    h = hk.getUTCHours();
  }
  for (const [name, info] of windMarkers) {
    const series = day[name];
    if (!series || !series.length) {
      // Station has no data this day — drop it AND clear its cached reading.
      windMapLayer.removeLayer(info.marker);
      info.last = null;
      continue;
    }
    let pick = series[0];
    if (h != null) {
      for (const r of series) if (r.h <= h) pick = r;
      if (h < series[0].h) pick = series[0];
    }
    info.last = pick;
    info.marker.setIcon(windArrowIcon(pick.deg, pick.spd));
    info.marker.bindTooltip(
      `${name}<br>${pick.dir ?? "—"} ${pick.deg ?? "–"}° · ${pick.spd ?? "–"} km/h, gust ${pick.gust ?? "–"}`,
      { direction: "top", offset: [0, -8] });
    if (!map.hasLayer(info.marker)) info.marker.addTo(windMapLayer);
  }
}

// ---------- Interpolated wind field (IDW) ----------
// Builds a regular grid of wind arrows over the visible map by sampling each
// grid point from all stations using inverse-distance weighting on the wind
// vector (u, v components — handles the 359°→1° wrap correctly).
//
// Pass `power` to bias towards nearby stations: 2 (default) gives smooth
// blending; 4+ approaches "nearest station". The exclusion radius `eps`
// keeps the result finite right on top of a station.

const windGridLayer = L.layerGroup().addTo(map);
let windGridShown = true;
const IDW_POWER = 2;

// Convert one station reading into a wind-going-TO vector (u east, v north).
function readingToUV(r) {
  if (r.deg == null || r.spd == null) return null;
  const toDeg = (r.deg + 180) % 360;          // wind blows TO this bearing
  const rad = (toDeg * Math.PI) / 180;
  return { u: r.spd * Math.sin(rad), v: r.spd * Math.cos(rad), gust: r.gust };
}

function uvToReading(u, v, gust) {
  const spd = Math.sqrt(u * u + v * v);
  const toDeg = (Math.atan2(u, v) * 180) / Math.PI;
  const fromDeg = ((toDeg + 540) % 360);       // wind FROM bearing
  return { spd, deg: fromDeg, gust };
}

// Returns { spd, deg, gust } at (lat, lon) interpolated from `samples`,
// which is an array of { lat, lon, u, v, gust } points.
function idwAt(lat, lon, samples, power = IDW_POWER, eps = 1e-4) {
  if (!samples.length) return null;
  let wSum = 0, uSum = 0, vSum = 0, gSum = 0, gWSum = 0;
  for (const s of samples) {
    const dLat = lat - s.lat;
    const dLon = (lon - s.lon) * Math.cos((lat * Math.PI) / 180);
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < eps * eps) {
      // Sitting on top of a station — return its values directly.
      return uvToReading(s.u, s.v, s.gust);
    }
    const w = 1 / Math.pow(d2, power / 2);
    wSum += w; uSum += w * s.u; vSum += w * s.v;
    if (s.gust != null) { gSum += w * s.gust; gWSum += w; }
  }
  const gust = gWSum ? gSum / gWSum : null;
  return uvToReading(uSum / wSum, vSum / wSum, gust);
}

// Build the sample set for the current race time from the on-map stations.
function currentWindSamples() {
  const out = [];
  for (const [, info] of windMarkers) {
    if (!info.last || info.last.deg == null) continue;
    const uv = readingToUV(info.last);
    if (!uv) continue;
    out.push({
      lat: info.coord.lat, lon: info.coord.lon,
      u: uv.u, v: uv.v, gust: uv.gust,
    });
  }
  return out;
}

// Tiny arrow icon used for grid points (smaller, more transparent than
// station markers).
function gridArrowIcon(deg, speed) {
  const s = speed ?? 0;
  const color = s < 6 ? "#9ec5ff"
              : s < 12 ? "#6fd06b"
              : s < 20 ? "#facc15"
              : s < 30 ? "#fb923c"
                       : "#ef4444";
  const rot = (deg + 180) % 360;
  // No filled circle / no number — just a translucent arrow.
  const html = `<div class="wg-icon" style="transform: rotate(${rot}deg);">
    <svg viewBox="-8 -8 16 16">
      <path d="M0,-7 L3.5,3 L0,1 L-3.5,3 Z" fill="${color}" stroke="#0f1924" stroke-width="0.5" stroke-linejoin="round" opacity="0.85"/>
    </svg></div>`;
  return L.divIcon({ html, className: "", iconSize: [16, 16], iconAnchor: [8, 8] });
}

function renderWindGrid() {
  windGridLayer.clearLayers();
  if (!windGridShown) return;
  const samples = currentWindSamples();
  if (samples.length < 3) return;

  const b = map.getBounds();
  // Aim for ~14 columns horizontally, square-ish cells.
  const cols = 14;
  const lonStep = (b.getEast() - b.getWest()) / cols;
  // Match latitude step so cells are roughly square at this latitude.
  const midLatRad = (b.getNorth() + b.getSouth()) / 2 * Math.PI / 180;
  const latStep = lonStep * Math.cos(midLatRad);
  const rows = Math.max(1, Math.round((b.getNorth() - b.getSouth()) / latStep));

  for (let r = 0; r < rows; r++) {
    const lat = b.getSouth() + (r + 0.5) * latStep;
    for (let c = 0; c < cols; c++) {
      const lon = b.getWest() + (c + 0.5) * lonStep;
      const w = idwAt(lat, lon, samples);
      if (!w || w.spd < 0.5) continue;
      L.marker([lat, lon], {
        icon: gridArrowIcon(w.deg, w.spd),
        zIndexOffset: 50,
        interactive: false, // grid points are decorative
        keyboard: false,
      }).addTo(windGridLayer);
    }
  }
}

// Recompute when the map moves/zooms (debounced via the move-end event).
map.on("moveend zoomend", renderWindGrid);

// ---------- Particle wind animation (canvas overlay) ----------
// Spawns N particles in screen space. Every frame each particle samples the
// IDW wind field at its current lat/lon, advances in that direction, and
// draws a short line behind it. The canvas also fades each frame so older
// segments ghost out into trails. Pure 2D canvas — no WebGL, no vendor lib.

const WindParticleLayer = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    this._canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated");
    this._canvas.style.position = "absolute";
    this._canvas.style.left = "0";
    this._canvas.style.top = "0";
    this._canvas.style.pointerEvents = "none";
    this._canvas.style.zIndex = "400"; // above tiles, below markers
    m.getPanes().overlayPane.appendChild(this._canvas);
    this._resize();
    this._particles = [];
    this._running = true;
    m.on("moveend zoomend resize", this._onMapChange, this);
    this._raf = requestAnimationFrame(this._tick.bind(this));
    this._lastMs = performance.now();
    return this;
  },
  onRemove(m) {
    this._running = false;
    cancelAnimationFrame(this._raf);
    m.off("moveend zoomend resize", this._onMapChange, this);
    L.DomUtil.remove(this._canvas);
  },
  _resize() {
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._canvas.style.width = size.x + "px";
    this._canvas.style.height = size.y + "px";
    // Re-anchor canvas so it sits on top of the visible map.
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
  },
  _onMapChange() {
    this._resize();
    this._particles.length = 0; // respawn on next tick
  },
  _spawn(p) {
    p.x = Math.random() * this._canvas.width;
    p.y = Math.random() * this._canvas.height;
    p.age = 0;
    p.maxAge = 30 + Math.random() * 60; // frames before forced respawn
  },
  _tick(nowMs) {
    if (!this._running) return;
    const dt = Math.min(0.05, (nowMs - this._lastMs) / 1000);
    this._lastMs = nowMs;
    const ctx = this._canvas.getContext("2d");
    const W = this._canvas.width, H = this._canvas.height;

    // Fade previous frame.
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";

    const samples = currentWindSamples();
    const have = samples.length >= 3;

    // Maintain particle count proportional to canvas area (~1 per 5000 px²).
    const target = have ? Math.min(1500, Math.max(200, Math.round((W * H) / 5000))) : 0;
    while (this._particles.length < target) {
      const p = {};
      this._spawn(p);
      this._particles.push(p);
    }
    if (this._particles.length > target) this._particles.length = target;

    // Pixels per (km/h · second) — tune by eye. At ~15 km/h a particle
    // should drift across the screen in a few seconds at city zoom.
    const SCALE = 0.8;
    ctx.lineWidth = 1.1;
    ctx.lineCap = "round";
    for (const p of this._particles) {
      p.age++;
      const oldX = p.x, oldY = p.y;
      const ll = this._map.containerPointToLatLng([p.x, p.y]);
      const w = have ? idwAt(ll.lat, ll.lng, samples) : null;
      if (!w || w.spd < 0.2 || p.age > p.maxAge ||
          p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
        this._spawn(p); continue;
      }
      const toDeg = (w.deg + 180) % 360;
      const rad = (toDeg * Math.PI) / 180;
      p.x += w.spd * Math.sin(rad) * SCALE;
      p.y -= w.spd * Math.cos(rad) * SCALE;
      // Same Beaufort color ramp as the station markers for consistency.
      const s = w.spd;
      ctx.strokeStyle = s < 6 ? "rgba(158,197,255,0.85)"
                      : s < 12 ? "rgba(111,208,107,0.85)"
                      : s < 20 ? "rgba(250,204,21,0.9)"
                      : s < 30 ? "rgba(251,146,60,0.95)"
                               : "rgba(239,68,68,1)";
      ctx.beginPath();
      ctx.moveTo(oldX, oldY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    this._raf = requestAnimationFrame(this._tick.bind(this));
  },
});

const windParticles = new WindParticleLayer();
let windParticlesShown = true;
windParticles.addTo(map);

const windGridToggle = document.getElementById("windGridToggle");
if (windGridToggle) {
  windGridToggle.addEventListener("change", () => {
    windGridShown = windGridToggle.checked;
    renderWindGrid();
  });
}

const windParticleToggle = document.getElementById("windParticleToggle");
if (windParticleToggle) {
  windParticleToggle.addEventListener("change", () => {
    windParticlesShown = windParticleToggle.checked;
    if (windParticlesShown) windParticles.addTo(map);
    else map.removeLayer(windParticles);
  });
}

// ---------- HKO wind text panel (live, synced to race clock) ----------
// window.WIND_STATIONS : { "Lamma Island": "Lamma Island", ... }
// window.WIND_HOURLY   : { "YYYY-MM-DD": { "Lamma Island": [
//                          { h: 12, dir: "Southeast", deg: 135, spd: 7, gust: 18 }
//                        , ...] } }
const windBarbEl = document.getElementById("windBarb");
const windStationSel = document.getElementById("windStation");
const wbArrowPath = document.getElementById("wbArrowPath");
const wbDir = document.getElementById("wbDir");
const wbSpd = document.getElementById("wbSpd");
const wbGust = document.getElementById("wbGust");
const windBarbInfo = document.getElementById("windBarbInfo");

// Sailing-area stations float to the top of the dropdown.
const STATION_PRIORITY = [
  "Lamma Island", "Waglan Island", "Stanley", "Cheung Chau", "Cheung Chau Beach",
  "Hong Kong Sea School", "Green Island", "Wong Chuk Hang", "North Point",
  "Central Pier", "Star Ferry", "Chek Lap Kok",
];
const LS_KEY = "sailing.windStation";
let windCurrentDate = null;

function populateStationDropdown() {
  const all = window.WIND_STATIONS || {};
  const keys = Object.keys(all);
  if (!keys.length) return;
  const ordered = [
    ...STATION_PRIORITY.filter((s) => all[s]),
    ...keys.filter((s) => !STATION_PRIORITY.includes(s)).sort(),
  ];
  windStationSel.innerHTML = ordered.map((s) =>
    `<option value="${s}">${s}</option>`).join("");
  const saved = localStorage.getItem(LS_KEY);
  windStationSel.value = (saved && all[saved]) ? saved : "Lamma Island";
}
populateStationDropdown();

windStationSel.addEventListener("change", () => {
  localStorage.setItem(LS_KEY, windStationSel.value);
  refreshWindReadout();
});

function renderWindBarb(date) {
  windCurrentDate = date;
  refreshWindReadout();
}

// Pick the hourly reading closest to the current race time on the active
// race day. Falls back to the date's first/last reading if race time is
// outside the snapshot window.
function refreshWindReadout() {
  const date = windCurrentDate;
  const station = windStationSel.value;
  const all = window.WIND_HOURLY || {};
  const series = (all[date] || {})[station];
  if (!series || !series.length) {
    windBarbEl.hidden = true;
    return;
  }
  windBarbEl.hidden = false;

  // Race time (Unix seconds) → HK hour-of-day (0..23).
  let h = null;
  if (raceTime != null) {
    const hk = new Date((raceTime + 8 * 3600) * 1000); // "HKT" by adding offset to epoch
    h = hk.getUTCHours();
  }
  // Find the reading whose hour is closest (and ≤) to h.
  let pick = series[0];
  if (h != null) {
    for (const r of series) {
      if (r.h <= h) pick = r;
    }
    // If race is before any snapshot, just take the earliest.
    if (h < series[0].h) pick = series[0];
  }
  const dirTxt = pick.dir || "—";
  const degTxt = pick.deg != null ? String(pick.deg).padStart(3, "0") : "–";
  const spdTxt = pick.spd != null ? String(pick.spd) : "–";
  const gustTxt = pick.gust != null ? String(pick.gust) : "–";
  wbDir.textContent = `${dirTxt} ${degTxt}`;
  wbSpd.textContent = spdTxt;
  wbGust.textContent = gustTxt;
  // Arrow points to where wind is GOING (so flip 180° from "from" direction).
  if (pick.deg != null) {
    wbArrowPath.style.transform = `rotate(${(pick.deg + 180) % 360}deg)`;
    wbArrowPath.setAttribute("opacity", "1");
  } else {
    wbArrowPath.setAttribute("opacity", "0.2");
  }
  windBarbInfo.textContent = `${station} · ${String(pick.h).padStart(2, "0")}:00 HKT`;
}

// ---------- On-map track legend ----------
// A floating panel pinned to the map (bottom-left). One row per loaded
// track with its colour swatch + boat/race name. Click a row to toggle
// that track's visibility — same effect as the swatch toggle in the
// sidebar's "Tracks on map" list, but visible while you're looking at
// the chart.
const trackLegend = L.control({ position: "topleft" });
trackLegend.onAdd = function () {
  const div = L.DomUtil.create("div", "track-legend");
  // Stop map drags / wheel-zoom from firing when interacting with the legend.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  div.style.display = "none";
  return div;
};
trackLegend.addTo(map);

// Distance (metres) the boat has sailed between race-start and `t`.
// Cheap binary search over the precomputed cumDist array.
function boatProgressAt(track, t) {
  if (!track.cumDist) return 0;
  const pts = track.points;
  if (t < pts[0].t) return 0;
  const startSec = track.meta?.race ? Date.parse(track.meta.race.start) / 1000 : track.tStart;
  const cumAt = (tt) => {
    if (tt <= pts[0].t) return 0;
    if (tt >= pts[pts.length - 1].t) return track.cumDist[pts.length - 1];
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= tt) lo = mid; else hi = mid;
    }
    return track.cumDist[lo];
  };
  return Math.max(0, cumAt(t) - cumAt(startSec));
}

// Live legend: ONE row per boat, ordered top-to-bottom by current
// race progress (distance sailed since the active race's gun). Switches
// to alphabetical when no race is being played. Clicking a row toggles
// ALL of that boat's tracks (R1+R2+R3) at once.
//
// Throttled to ~3 Hz from the playback tick to avoid rebuilding DOM
// every animation frame.
function renderTrackLegend() {
  const div = trackLegend.getContainer();
  if (!div) return;

  // Group tracks by boat name.
  const byBoat = new Map();
  for (const t of tracks) {
    if (t.removed) continue;
    const boat = t.meta?.boat || t.name;
    if (!byBoat.has(boat)) byBoat.set(boat, []);
    byBoat.get(boat).push(t);
  }
  if (!byBoat.size) { div.style.display = "none"; div.innerHTML = ""; return; }
  div.style.display = "block";

  // Live ranking: which race is currently being played?
  const activeRaceName = visibleRaceForMarks();
  const isLive = activeRaceName != null && raceTime != null;

  const rows = [];
  for (const [boat, boatTracks] of byBoat) {
    const color = boatTracks[0].color;
    const visible = boatTracks.some((t) => t.visible);
    let progress = 0;
    if (isLive) {
      const raceTrack = boatTracks.find(
        (t) => t.meta?.race?.name === activeRaceName);
      if (raceTrack) progress = boatProgressAt(raceTrack, raceTime);
    }
    rows.push({ boat, color, visible, progress, tracks: boatTracks });
  }

  // Order: live → most progress first; otherwise alphabetical by boat name.
  if (isLive) rows.sort((a, b) => b.progress - a.progress);
  else rows.sort((a, b) => a.boat.localeCompare(b.boat));

  div.innerHTML = rows.map((r, i) => `
    <div class="tl-row ${r.visible ? "" : "tl-hidden"}" data-boat="${r.boat}"
         title="Click to ${r.visible ? "hide" : "show"} ${r.boat}">
      ${isLive ? `<span class="tl-rank">${i + 1}</span>` : ""}
      <span class="tl-swatch" style="background:${r.color}"></span>
      <span class="tl-name">${r.boat}</span>
    </div>`).join("");

  for (const row of div.querySelectorAll(".tl-row")) {
    row.addEventListener("click", () => {
      const boat = row.dataset.boat;
      const trs = byBoat.get(boat);
      if (!trs?.length) return;
      const newVisible = !trs.some((t) => t.visible);
      for (const tr of trs) {
        if (tr.removed) continue;
        tr.visible = newVisible;
        if (newVisible) tr.layer.addTo(map); else map.removeLayer(tr.layer);
        const li = tracksEl.querySelector(`li[data-id="${tr.id}"]`);
        if (li) li.classList.toggle("hidden", !newVisible);
      }
      row.classList.toggle("tl-hidden", !newVisible);
      // If the selected track belongs to this boat and just got hidden, drop it.
      if (selectedTrackId != null
          && trs.some((t) => t.id === selectedTrackId)
          && !newVisible) {
        selectTrack(null);
      }
      updateRaceClockBounds();
      renderRaceMarksOnMap(); renderFinishLineOnMap(); refresh3DScene();
      renderTrackLegend();
    });
  }
}

// Throttled renderer for use from the per-frame playback tick.
let _lastLegendRender = 0;
function tickTrackLegend() {
  const now = performance.now();
  if (now - _lastLegendRender < 350) return;
  _lastLegendRender = now;
  renderTrackLegend();
}

// ---------- Race-tab solo selector ----------
// "All" + one pill per race. Picking a race hides the tracks tied to the
// other races. The track-level visibility toggles still work — this is just
// a quick way to focus on one race when several share the day.
const raceTabsEl = document.getElementById("raceTabs");
let activeRaceFilter = null; // null = "All"

function setTrackVisibility(t, visible) {
  if (t.removed || t.visible === visible) return;
  t.visible = visible;
  if (visible) t.layer.addTo(map); else map.removeLayer(t.layer);
  const li = tracksEl.querySelector(`li[data-id="${t.id}"]`);
  if (li) li.classList.toggle("hidden", !visible);
}

function applyRaceFilter() {
  for (const t of tracks) {
    if (t.removed) continue;
    const matches = activeRaceFilter == null
      || t.meta?.race?.name === activeRaceFilter;
    setTrackVisibility(t, matches);
  }
  updateRaceClockBounds();
  // Re-fit to whatever's visible
  fitAll();
  // If selection got hidden, drop it
  if (selectedTrackId != null && !tracks[selectedTrackId]?.visible) {
    selectTrack(null);
  }
  renderTrackLegend();
  renderRaceMarksOnMap(); renderFinishLineOnMap(); refresh3DScene();
}

function renderRaceTabs() {
  raceTabsEl.innerHTML = "";
  // Distinct race names across the loaded tracks (preserves insertion order).
  const seen = new Map();
  for (const t of tracks) {
    if (t.removed || !t.meta?.race) continue;
    const r = t.meta.race;
    if (!seen.has(r.name)) seen.set(r.name, r.title || r.name);
  }
  if (seen.size < 2) { raceTabsEl.hidden = true; return; }
  raceTabsEl.hidden = false;
  const make = (label, value) => {
    const b = document.createElement("button");
    b.className = "race-tab" + (activeRaceFilter === value ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      activeRaceFilter = value;
      renderRaceTabs();
      applyRaceFilter();
      // Also surface the scoreboard for the picked race (or hide when "All").
      if (value == null) {
        // "All" — only keep the scoreboard if a track selection is still driving it.
        if (selectedTrackId == null) scoreboardEl.hidden = true;
      } else {
        const race = (window.RACES?.[activeDayKey] || []).find((r) => r.name === value);
        renderScoreboard(race || null, MY_BOAT.sail);
      }
    });
    raceTabsEl.appendChild(b);
  };
  make("All", null);
  for (const [name, title] of seen) make(`${name} ${title}`, name);
}

// ---------- Selection, readout, scoreboard ----------
const readoutEl = document.getElementById("readout");
const roName = readoutEl.querySelector(".ro-name");
const roSog = readoutEl.querySelector(".ro-sog");
const roCog = readoutEl.querySelector(".ro-cog");
const roTime = readoutEl.querySelector(".ro-time");
const roMax = readoutEl.querySelector(".ro-max");
const roWind = readoutEl.querySelector(".ro-wind");

const scoreboardEl = document.getElementById("scoreboard");
const sbName = scoreboardEl.querySelector(".sb-name");
const sbMeta = scoreboardEl.querySelector(".sb-meta");
const sbBody = scoreboardEl.querySelector("tbody");

// Render the full scoreboard for one race. `highlightSail` is the boat
// whose row should be highlighted (the user's selected boat).
function renderScoreboard(race, highlightSail) {
  if (!race) { scoreboardEl.hidden = true; return; }
  const title = race.title || race.name;
  sbName.textContent = title;
  const startStr = `start ${String(race.startH).padStart(2, "0")}:${String(race.startM).padStart(2, "0")}`;
  const fleet = race.finishers.length + race.dnc.length;
  sbMeta.textContent = `${startStr} · fleet ${fleet}`;

  const names = window.BOAT_NAMES || {};
  const rows = [];
  for (const f of race.finishers) {
    rows.push({
      place: f.place, sail: f.sail, name: names[f.sail] || "—",
      finish: f.finish, elapsed: f.elapsed,
      self: f.sail === highlightSail,
    });
  }
  for (const d of race.dnc) {
    rows.push({
      place: d.status, sail: d.sail, name: names[d.sail] || "—",
      finish: "—", elapsed: d.status,
      dnx: true, self: d.sail === highlightSail,
    });
  }
  sbBody.innerHTML = rows.map((r) => `
    <tr class="${r.dnx ? "sb-dnx" : ""} ${r.self ? "sb-self" : ""}">
      <td class="sb-place">${r.place}</td>
      <td class="sb-boat">${r.name}</td>
      <td class="sb-sail">${r.sail}</td>
      <td class="sb-finish">${r.finish}</td>
      <td class="sb-elapsed">${r.elapsed}</td>
    </tr>`).join("");
  scoreboardEl.hidden = false;
}

function selectTrack(id) {
  selectedTrackId = id;
  for (const li of tracksEl.querySelectorAll("li")) {
    li.classList.toggle("selected", Number(li.dataset.id) === id);
  }
  for (const t of tracks) {
    if (t.removed) continue;
    const el = t.boat.getElement()?.querySelector(".boat-icon");
    if (el) el.classList.toggle("selected", t.id === id);
  }
  if (id == null) {
    readoutEl.hidden = true;
    scoreboardEl.hidden = true;
    raceStatsEl.hidden = true;
    windShiftEl.hidden = true;
    legsEl.hidden = true;
    maneuversEl.hidden = true;
    polarPlotEl.hidden = true;
    gapChartEl.hidden = true;
    coachReportEl.hidden = true;
    markRoundingsLayer.clearLayers();
    ghostsLayer.clearLayers();
    return;
  }
  readoutEl.hidden = false;
  const t = tracks[id];
  roName.textContent = t.name;
  roName.style.color = t.color;
  roMax.textContent = t.maxSog.toFixed(1);

  // Render the full scoreboard for this race in the sidebar, with the
  // track's own boat highlighted.
  const sailNumber = t.meta?.boat === MY_BOAT.name ? MY_BOAT.sail : null;
  renderScoreboard(t.meta?.race || null, sailNumber);
  renderRaceStats(t);
  renderWindShift(t);
  setupGhostsForTrack(t);
  // After renderRaceStats has built the analysis, also render legs / maneuvers
  // / polar / gap. _activeAnalysis is set inside renderRaceStats.
  if (_activeAnalysis && _activeAnalysis.trackId === t.id) {
    renderLegs(_activeAnalysis.stats.legs);
    renderManeuvers(_activeAnalysis.stats);
    renderPolarPlot(_activeAnalysis.stats.polar);
    renderGapChart(t);
    renderCoachReport(t);
  }

  // If this track is tied to a race, show the race result row beneath
  // the live SOG/COG/time grid.
  const race = t.meta?.race;
  const boatName = t.meta?.boat;
  let raceRow = readoutEl.querySelector(".ro-race");
  if (race) {
    if (!raceRow) {
      raceRow = document.createElement("div");
      raceRow.className = "ro-race";
      readoutEl.querySelector(".readout-body").appendChild(raceRow);
    }
    const fleet = race.finishers.length + race.dnc.length;
    const myFinisher = race.finishers.find((f) => f.sail === MY_BOAT.sail);
    const myDnx = race.dnc.find((x) => x.sail === MY_BOAT.sail);
    let myLine = "";
    if (boatName === MY_BOAT.name) {
      if (myFinisher) {
        const winner = race.finishers[0];
        const gapMs = Date.parse(`${race.date}T${myFinisher.finish}`) -
                      Date.parse(`${race.date}T${winner.finish}`);
        const gap = gapMs > 0 ? `+${Math.round(gapMs / 1000)}s` : "leader";
        myLine = `${MY_BOAT.name}: P${myFinisher.place}/${fleet} · ${gap} · finish ${myFinisher.finish}`;
      } else if (myDnx) {
        myLine = `${MY_BOAT.name}: ${myDnx.status}`;
      }
    }
    raceRow.innerHTML = `
      <div class="ro-race-title">${race.title || race.name} · start ${String(race.startH).padStart(2,"0")}:${String(race.startM).padStart(2,"0")}</div>
      ${myLine ? `<div class="ro-race-me">${myLine}</div>` : ""}
      <div class="ro-race-fleet">Fleet ${fleet} · ${race.finishers.length} finished</div>
    `;
  } else if (raceRow) {
    raceRow.remove();
  }

  refreshReadout();
}

// ---------- Coach report ----------
// Synthesises the existing per-race analytics into plain-language
// feedback grouped by topic: Start, Wind/strategy, Boat handling,
// Maneuvers, Performance, Recommendations. Each section returns 0-3
// observation strings with a sentiment ("good" / "warn" / "bad" / "info").
// Persist per-race summaries for the season-trend view (#5).
function recordSeasonStat(track, stats, race) {
  if (!track?.meta?.boat || !race?.date || !race?.name) return;
  const key = `sailing.history.${track.meta.boat}`;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
  // De-dupe by (date+race).
  const id = `${race.date}/${race.name}`;
  arr = arr.filter((r) => `${r.date}/${r.race}` !== id);
  arr.push({
    date: race.date, race: race.name, title: race.title || race.name,
    polar: stats.avgPolarRatio,
    tacks: stats.tacks.length,
    gybes: stats.gybes.length,
    heelMedian: stats.heelStats?.median ?? null,
    avgLostKn: stats.tacks.length || stats.gybes.length
      ? [...stats.tacks, ...stats.gybes].filter((m) => typeof m.lostKn === "number")
          .reduce((s, m, _, a) => s + m.lostKn / a.length, 0)
      : null,
  });
  if (arr.length > 100) arr = arr.slice(-100);
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch {}
}

function loadSeasonHistory(boat) {
  if (!boat) return [];
  try { return JSON.parse(localStorage.getItem(`sailing.history.${boat}`) || "[]"); }
  catch { return []; }
}

function coachReport(track, stats, race) {
  const obs = {
    start: [], wind: [], boat: [], maneuvers: [],
    performance: [], tactics: [], fleet: [], trend: [], recs: [],
  };
  const add = (group, level, text) => obs[group].push({ level, text });

  recordSeasonStat(track, stats, race);

  // ---- Start ----
  // ONE consolidated observation: "X s late = ~Y m behind the leader".
  // The two figures relate: lateness translated into a distance gap at
  // J/80 target speed (~5 kn). Then a context clause about WHAT was
  // happening at the gun (stalled / approaching at speed / far back).
  if (stats.startLine) {
    const sl = stats.startLine;
    if (sl.ocs) {
      add("start", "bad",
        `OCS — crossed the line ${Math.abs(sl.lateBy).toFixed(1)}s before the gun.`);
    } else if (sl.lateBy != null) {
      const TARGET_KN = 5;            // J/80 close-hauled target speed
      const KN_TO_MS = 0.5144;
      // Distance you would have made AT TARGET SPEED in those late seconds
      // — i.e. the gap to a perfectly-timed boat at full speed.
      const distEquivM = sl.lateBy * TARGET_KN * KN_TO_MS;
      let level, headline;
      if (sl.lateBy < 3) {
        level = "good"; headline = `On the line (+${sl.lateBy.toFixed(1)}s)`;
      } else if (sl.lateBy < 10) {
        level = "info";
        headline = `${sl.lateBy.toFixed(0)}s late = about ${distEquivM.toFixed(0)} m behind the leader at the gun`;
      } else if (sl.lateBy < 30) {
        level = "warn";
        headline = `${sl.lateBy.toFixed(0)}s late — about ${distEquivM.toFixed(0)} m to make up vs a perfect start`;
      } else {
        level = "bad";
        headline = `Lost the start: ${sl.lateBy.toFixed(0)}s late ≈ ${distEquivM.toFixed(0)} m behind the fleet`;
      }
      // Context clause — what was going on at the gun?
      let context = "";
      const d = sl.distAtGun, s = sl.sogAtGun;
      if (d != null && s != null) {
        if (d < 20 && s < 2.5) {
          context = ` At the gun: ${d.toFixed(0)} m from the line but stalled (${s.toFixed(1)} kn) — caught in irons / over-luffing.`;
        } else if (d < 20 && s > 4) {
          context = ` At the gun: ${d.toFixed(0)} m from the line at full speed (${s.toFixed(1)} kn) — clean final approach.`;
        } else if (d > 80) {
          context = ` At the gun you were ${d.toFixed(0)} m back at ${s.toFixed(1)} kn — late approach to the line.`;
        } else {
          context = ` At the gun: ${d.toFixed(0)} m from line, ${s.toFixed(1)} kn.`;
        }
      }
      add("start", level, headline + "." + context);
    }
  } else {
    add("start", "info", "No start line pinged — can't grade the start.");
  }

  // ---- Wind / strategy ----
  // Compare upwind COG between thirds of the race to detect shifts.
  if (stats.avgWindDeg != null) {
    const startSec = race ? Date.parse(race.start) / 1000 : track.tStart;
    const endSec = race?.end ? Date.parse(race.end) / 1000 : track.tEnd;
    const dur = endSec - startSec;
    function upwindBearings(t0, t1) {
      const port = [], stbd = [];
      for (const p of track.points) {
        if (p.t < t0 || p.t > t1 || p.sog < 2.5) continue;
        let twa = p.cog - stats.avgWindDeg;
        while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
        if (Math.abs(twa) > 70) continue; // not upwind
        (twa < 0 ? port : stbd).push(p.cog);
      }
      const meanCog = (xs) => {
        if (!xs.length) return null;
        let sx = 0, sy = 0;
        for (const c of xs) { const r = c * Math.PI / 180; sx += Math.sin(r); sy += Math.cos(r); }
        return (Math.atan2(sx / xs.length, sy / xs.length) * 180 / Math.PI + 360) % 360;
      };
      return { port: meanCog(port), stbd: meanCog(stbd), n: port.length + stbd.length };
    }
    const a = upwindBearings(startSec, startSec + dur / 2);
    const b = upwindBearings(startSec + dur / 2, endSec);
    if (a.stbd != null && b.stbd != null && a.n > 60 && b.n > 30) {
      let stbdShift = b.stbd - a.stbd;
      while (stbdShift > 180) stbdShift -= 360; while (stbdShift < -180) stbdShift += 360;
      if (Math.abs(stbdShift) > 8) {
        const dir = stbdShift > 0 ? "right (clockwise)" : "left (counter-clockwise)";
        add("wind", "info",
          `Wind ${stbdShift > 0 ? "veered" : "backed"} ${Math.abs(stbdShift).toFixed(0)}° ${dir} between the first and second beat.`);
        // Did the boat tack to capture the favoured shift?
        // Simple heuristic: if the right shift was big (>10°), starboard tack got headed → port was lifted → boats should be on port.
        // Find tacks during the 2nd beat and count port-vs-starboard time spent.
        let portTime = 0, stbdTime = 0;
        for (let i = 1; i < track.points.length; i++) {
          const p = track.points[i];
          if (p.t < startSec + dur / 2 || p.t > endSec) continue;
          if (p.sog < 2.5) continue;
          let twa = p.cog - stats.avgWindDeg;
          while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
          if (Math.abs(twa) > 70) continue;
          const dt = p.t - track.points[i - 1].t;
          if (twa < 0) portTime += dt; else stbdTime += dt;
        }
        const favoured = stbdShift > 0 ? "port" : "starboard";
        const time = stbdShift > 0 ? portTime : stbdTime;
        const total = portTime + stbdTime;
        if (total > 60 && time / total < 0.4) {
          add("wind", "warn",
            `Spent only ${Math.round(time / total * 100)}% of the second beat on the favoured ${favoured} tack — tactical opportunity missed.`);
        } else if (total > 60 && time / total > 0.6) {
          add("wind", "good",
            `Caught the shift — ${Math.round(time / total * 100)}% of the second beat on the favoured ${favoured} tack.`);
        }
      } else {
        add("wind", "info", "Wind direction stayed steady between beats.");
      }
    }
  }

  // ---- Boat handling (heel) ----
  if (stats.heelStats) {
    const h = stats.heelStats;
    if (h.median > 27) add("boat", "warn", `Median heel ${h.median.toFixed(0)}° — over-heeling. Depower (ease main, flatten boat).`);
    else if (h.median > 18 && h.median <= 25) add("boat", "good", `Median heel ${h.median.toFixed(0)}° — in the J/80 sweet spot (20-25°).`);
    else if (h.median < 12) add("boat", "info", `Median heel ${h.median.toFixed(0)}° — under-heeling, light air.`);
    if (h.max > 40) add("boat", "bad", `Max heel ${h.max.toFixed(0)}° — almost knocked down. Faster easing in gusts.`);
    if (h.p90 - h.median > 18) add("boat", "warn", `Heel inconsistent (p90 ${h.p90.toFixed(0)}° vs median ${h.median.toFixed(0)}°) — gusts not being managed.`);
  }

  // ---- Maneuvers ----
  const allMan = [...stats.tacks, ...stats.gybes];
  if (allMan.length) {
    const valid = allMan.filter((m) => typeof m.lostKn === "number" && typeof m.recoverySec === "number");
    if (valid.length >= 3) {
      const avgLost = valid.reduce((s, x) => s + x.lostKn, 0) / valid.length;
      const avgRec = valid.reduce((s, x) => s + x.recoverySec, 0) / valid.length;
      if (avgLost > 0.6) add("maneuvers", "warn", `Avg ${avgLost.toFixed(1)} kn lost per maneuver — heavy. Aim for <0.4 kn.`);
      else if (avgLost < 0.3) add("maneuvers", "good", `Clean maneuvers — only ${avgLost.toFixed(1)} kn lost on average.`);
      if (avgRec > 20) add("maneuvers", "warn", `Slow recovery (${avgRec.toFixed(0)}s avg). Roll-tack technique.`);
      else if (avgRec < 10) add("maneuvers", "good", `Sharp recovery — back to speed in ${avgRec.toFixed(0)}s on average.`);
      const worst = [...valid].sort((a, b) => b.lostKn - a.lostKn)[0];
      if (worst && worst.lostKn > 1.5) {
        const tStr = new Date(worst.t * 1000).toLocaleTimeString().slice(0, 5);
        add("maneuvers", "info", `Worst maneuver at ${tStr}: lost ${worst.lostKn.toFixed(1)} kn, recovered in ${worst.recoverySec ?? "?"}s.`);
      }
    }
    if (stats.tacks.length > 18) {
      add("maneuvers", "info", `${stats.tacks.length} tacks in the race — high count, may suggest uncertain strategy.`);
    }
  }

  // ---- Performance ----
  if (stats.avgPolarRatio != null) {
    const pct = stats.avgPolarRatio * 100;
    if (pct >= 95) add("performance", "good", `Sailed ${pct.toFixed(0)}% of J/80 polar — elite pace.`);
    else if (pct >= 85) add("performance", "info", `Sailed ${pct.toFixed(0)}% of polar — solid, room to push.`);
    else if (pct >= 75) add("performance", "warn", `${pct.toFixed(0)}% of polar — speed gap of ~0.5 kn vs target.`);
    else add("performance", "bad", `${pct.toFixed(0)}% of polar — significant speed deficit. Sail trim & helming.`);
  }

  // ---- Tactics: line bias (#7), layline (#1), mark approach loss (#4) ----
  // Line bias: angle between the start line and perpendicular-to-wind.
  // Boat at the upwind end of the line gets a "free" few metres upwind.
  if (track.meta?.startMarks?.rc && track.meta?.startMarks?.pin && stats.avgWindDeg != null) {
    const rc = track.meta.startMarks.rc;
    const pin = track.meta.startMarks.pin;
    const lat0 = (rc.lat + pin.lat) / 2;
    const dLat = (pin.lat - rc.lat) * 111_320;
    const dLon = (pin.lon - rc.lon) * 111_320 * Math.cos(lat0 * Math.PI / 180);
    // Bearing from RC to PIN (the line direction, 0 = north, clockwise).
    const lineBearing = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    // Wind is FROM avgWindDeg; perpendicular-to-wind is wind ± 90°.
    let bias = lineBearing - (stats.avgWindDeg + 90);
    while (bias > 90) bias -= 180; while (bias < -90) bias += 180;
    // Convert "bias degrees" to metres of upwind advantage:
    //   one end is upwind by sin(bias) * lineLength
    const lineLen = Math.sqrt(dLat * dLat + dLon * dLon);
    const upwindAdvM = Math.abs(Math.sin(bias * Math.PI / 180)) * lineLen;
    if (Math.abs(bias) >= 5) {
      const favouredEnd = bias > 0 ? "PIN" : "RC";
      add("tactics", "info",
        `Line was biased ${Math.abs(bias).toFixed(0)}° — ${favouredEnd} end was favoured by ~${upwindAdvM.toFixed(0)}m of upwind.`);
      // Where did the boat actually start?
      const startSec = race ? Date.parse(race.start) / 1000 : track.tStart;
      const sample = sampleAt(track, startSec);
      // Project start position onto the line, get fraction RC→PIN
      const sx = (sample.lon - rc.lon) * 111_320 * Math.cos(lat0 * Math.PI / 180);
      const sy = (sample.lat - rc.lat) * 111_320;
      const proj = (sx * dLon + sy * dLat) / (lineLen * lineLen);
      const onPin = bias > 0 ? proj > 0.66 : proj < 0.33;
      const onWrong = bias > 0 ? proj < 0.33 : proj > 0.66;
      if (onPin) add("tactics", "good", `Started near the favoured ${favouredEnd} end.`);
      else if (onWrong) add("tactics", "warn", `Started at the disfavoured end — gave up ~${upwindAdvM.toFixed(0)}m at the gun.`);
      else add("tactics", "info", `Started in the middle of the line.`);
    }
  }

  // Layline analysis (#1): for each mark approach, was the last tack
  // before the rounding "on the layline" or did the boat overstand?
  // Heuristic: look at boat position 60s before the rounding. Project
  // forward at current heading. If projected line passes >25 m to the
  // upwind side of the mark, boat overstood.
  if (stats.marks && stats.marks.length) {
    let overstandCount = 0;
    for (const m of stats.marks) {
      // Find sample 60s before the closest-approach time.
      let closestT = null, closestD = Infinity;
      for (const p of track.points) {
        if (p.t > track.tEnd) break;
        const dLat = (p.lat - m.lat) * 111_320;
        const dLon = (p.lon - m.lon) * 111_320 * Math.cos(p.lat * Math.PI / 180);
        const d = Math.sqrt(dLat * dLat + dLon * dLon);
        if (d < closestD) { closestD = d; closestT = p.t; }
      }
      if (closestT == null) continue;
      const before = sampleAt(track, closestT - 60);
      // Distance to mark at -60s
      const dLat = (m.lat - before.lat) * 111_320;
      const dLon = (m.lon - before.lon) * 111_320 * Math.cos(before.lat * Math.PI / 180);
      const distToMark = Math.sqrt(dLat * dLat + dLon * dLon);
      // Bearing from boat to mark
      const bearingToMark = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
      // Difference between boat heading and bearing-to-mark
      let diff = before.cog - bearingToMark;
      while (diff > 180) diff -= 360; while (diff < -180) diff += 360;
      // If the boat had to bear OFF (head down) significantly to reach
      // the mark, they overstood.
      if (Math.abs(diff) > 18 && distToMark > 50) {
        overstandCount++;
      }
    }
    if (overstandCount > 0) {
      add("tactics", "warn", `Overstood ${overstandCount} mark${overstandCount > 1 ? "s" : ""} — sailed extra distance.`);
    } else if (stats.marks.length) {
      add("tactics", "good", "Hit laylines cleanly at every mark.");
    }
  }

  // Mark approach loss (#4): SOG drop in the 30s window before each rounding.
  if (stats.marks && stats.marks.length) {
    const losses = [];
    for (const m of stats.marks) {
      // Find time of closest approach
      let cT = null, cD = Infinity;
      for (const p of track.points) {
        const dLat = (p.lat - m.lat) * 111_320;
        const dLon = (p.lon - m.lon) * 111_320 * Math.cos(p.lat * Math.PI / 180);
        const d = Math.sqrt(dLat * dLat + dLon * dLon);
        if (d < cD) { cD = d; cT = p.t; }
      }
      if (cT == null) continue;
      const range = (a, b) => {
        let s = 0, c = 0;
        for (const p of track.points) {
          if (p.t < cT + a) continue;
          if (p.t > cT + b) break;
          s += p.sog; c++;
        }
        return c ? s / c : null;
      };
      const baseline = range(-90, -30);
      const approach = range(-30, 0);
      if (baseline != null && approach != null) {
        const loss = baseline - approach;
        if (loss > 0.4) losses.push({ label: m.label, loss });
      }
    }
    if (losses.length) {
      const worst = losses.reduce((a, b) => a.loss > b.loss ? a : b);
      add("tactics", "warn",
        `Slowed ${worst.loss.toFixed(1)} kn in the 30s before mark ${worst.label} — bad approach line / wind shadow.`);
    }
  }

  // ---- Fleet (#2 rank trajectory, #3 vs leaders, #9 boat-on-boat) ----
  const otherTracksThisRace = tracks.filter((t) =>
    !t.removed && t.id !== track.id &&
    t.meta?.race?.name === race?.name);
  if (otherTracksThisRace.length) {
    // Compute progress (cumulative metres sailed) for me and each other
    // boat at each second of the race; track rank changes.
    const startSec = race ? Date.parse(race.start) / 1000 : track.tStart;
    const endSec = race?.end ? Date.parse(race.end) / 1000 : track.tEnd;
    const all = [track, ...otherTracksThisRace];
    const passes = []; // { tSec, who, dir }   dir: "passed"|"got passed"
    let prevRanks = null;
    for (let t = startSec; t <= endSec; t += 30) {
      const progArr = all.map((tr) => ({
        boat: tr.meta?.boat || tr.name, p: boatProgressAt(tr, t),
      }));
      progArr.sort((a, b) => b.p - a.p);
      const ranks = {};
      progArr.forEach((x, i) => { ranks[x.boat] = i + 1; });
      if (prevRanks) {
        const myBoat = track.meta?.boat;
        const myPrev = prevRanks[myBoat];
        const myNow = ranks[myBoat];
        if (myNow !== myPrev) {
          // Find which boat we swapped with
          for (const o of otherTracksThisRace) {
            const ob = o.meta?.boat;
            if (prevRanks[ob] !== ranks[ob]) {
              if (myNow < myPrev) passes.push({ t, who: ob, dir: "passed" });
              else passes.push({ t, who: ob, dir: "got passed by" });
            }
          }
        }
      }
      prevRanks = ranks;
    }
    if (passes.length) {
      const summary = passes.slice(0, 3).map((p) =>
        `${p.dir} ${p.who} at ${new Date(p.t * 1000).toLocaleTimeString().slice(0, 5)}`).join("; ");
      add("fleet", "info", `Boat-on-boat: ${summary}.`);
    }
    // Tack count vs other tracks for this race.
    for (const o of otherTracksThisRace) {
      // Naive: count visible_tacks count on `o` if available — we'd need
      // to recompute. Skip if we don't have per-track stats cached.
    }
    // Final position at finish.
    const finishProg = all.map((tr) => ({
      boat: tr.meta?.boat || tr.name, p: boatProgressAt(tr, endSec),
    })).sort((a, b) => b.p - a.p);
    const finalRank = finishProg.findIndex((x) => x.boat === track.meta?.boat) + 1;
    if (finalRank > 0) {
      add("fleet", "info",
        `Finished ${finalRank} of ${all.length} boats with tracks loaded.`);
    }
  } else {
    add("fleet", "info", "Fleet comparison unavailable — no other boats' tracks loaded for this race.");
  }

  // ---- Season trend (#5) ----
  const history = loadSeasonHistory(track.meta?.boat);
  if (history.length >= 3) {
    // Average polar / tacks / heel across previous races (excluding this one).
    const id = `${race?.date}/${race?.name}`;
    const prev = history.filter((r) => `${r.date}/${r.race}` !== id);
    if (prev.length >= 2) {
      const avg = (key) => {
        const vals = prev.map((r) => r[key]).filter((v) => typeof v === "number");
        return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
      };
      const polarAvg = avg("polar");
      const tacksAvg = avg("tacks");
      const heelAvg = avg("heelMedian");
      if (polarAvg != null && stats.avgPolarRatio != null) {
        const delta = (stats.avgPolarRatio - polarAvg) * 100;
        const dir = delta > 1 ? "above" : delta < -1 ? "below" : "around";
        add("trend", delta > 0 ? "good" : delta < -3 ? "warn" : "info",
          `Polar ${(stats.avgPolarRatio * 100).toFixed(0)}% — ${dir} your ${prev.length}-race avg of ${(polarAvg * 100).toFixed(0)}%.`);
      }
      if (tacksAvg != null) {
        const tDelta = stats.tacks.length - tacksAvg;
        if (Math.abs(tDelta) > 3)
          add("trend", "info", `${stats.tacks.length} tacks vs your typical ${tacksAvg.toFixed(0)}.`);
      }
      if (heelAvg != null && stats.heelStats?.median != null) {
        const hDelta = stats.heelStats.median - heelAvg;
        if (Math.abs(hDelta) > 4)
          add("trend", "info", `Heeled ${stats.heelStats.median.toFixed(0)}° vs your typical ${heelAvg.toFixed(0)}°.`);
      }
    }
  } else {
    add("trend", "info", "Season trend builds up after 3+ races analysed for this boat.");
  }

  // ---- Recommendations (synthesise) ----
  // High-priority issues first.
  if (stats.startLine?.ocs)
    obs.recs.push({ level: "bad", text: "Practice timing the start sequence — countdown discipline." });
  if (stats.heelStats?.max > 35)
    obs.recs.push({ level: "warn", text: "Crew heel-management drills: ease the main early in gusts." });
  if (allMan.filter((m) => m.lostKn > 1).length >= 3)
    obs.recs.push({ level: "warn", text: "Tack technique: target <0.5 kn loss per tack with proper roll." });
  if (stats.avgPolarRatio != null && stats.avgPolarRatio < 0.85)
    obs.recs.push({ level: "info", text: "Compare polar curves with leaders to find underperforming wind angle." });
  if (!obs.recs.length)
    obs.recs.push({ level: "good", text: "No major issues — solid race." });

  return obs;
}

const COACH_TITLES = {
  start: "🎯 Start",
  tactics: "🧭 Tactics",
  wind: "💨 Wind & strategy",
  boat: "⛵ Boat handling",
  maneuvers: "🔄 Maneuvers",
  performance: "📈 Performance",
  fleet: "🤝 Fleet",
  trend: "📊 Season trend",
  recs: "💡 Recommendations",
};

const coachReportEl = document.getElementById("coachReport");
function renderCoachReport(track) {
  if (!track || track.removed) { coachReportEl.hidden = true; return; }
  const stats = _activeAnalysis?.stats;
  if (!stats) { coachReportEl.hidden = true; return; }
  const obs = coachReport(track, stats, track.meta?.race);
  coachReportEl.hidden = false;
  const sections = Object.keys(COACH_TITLES).map((k) => {
    if (!obs[k] || !obs[k].length) return "";
    const items = obs[k].map((o) =>
      `<li class="cr-${o.level}">${o.text}</li>`).join("");
    return `<div class="cr-sec"><div class="cr-sec-title">${COACH_TITLES[k]}</div><ul>${items}</ul></div>`;
  }).join("");
  coachReportEl.innerHTML = `<h2>Coach report · ${track.meta?.boat || ""}</h2>` +
    `<div class="cr-body">${sections}</div>`;
}

// ---------- Wind shift sparkline ----------
const windShiftEl = document.getElementById("windShift");
const windShiftSvg = document.getElementById("windShiftSvg");
const windShiftInfo = document.querySelector("#windShift .ws-info");

function renderWindShift(track) {
  if (!track || track.removed) { windShiftEl.hidden = true; return; }
  const pts = track.points;
  const samples = [];
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 100))) {
    const w = windAtBoatFn(pts[i].t, pts[i].lat, pts[i].lon);
    if (w && w.deg != null) samples.push({ t: pts[i].t, deg: w.deg, spd: w.spd });
  }
  if (samples.length < 5) { windShiftEl.hidden = true; return; }
  windShiftEl.hidden = false;

  // Compute shift relative to median wind direction (avoids 0/360 wrap chaos
  // around northerly winds — just plot signed shift from median).
  const sorted = [...samples].map((s) => s.deg).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const shifted = samples.map((s) => {
    let d = s.deg - median;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    return { t: s.t, shift: d, spd: s.spd };
  });
  const minS = Math.min(...shifted.map((x) => x.shift));
  const maxS = Math.max(...shifted.map((x) => x.shift));
  const range = Math.max(20, Math.max(Math.abs(minS), Math.abs(maxS)) * 2);
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  const W = 300, H = 70, midY = H / 2;
  const xOf = (t) => ((t - t0) / (t1 - t0)) * W;
  const yOf = (d) => midY - (d / range) * H;
  const path = shifted.map((p, i) =>
    `${i === 0 ? "M" : "L"}${xOf(p.t).toFixed(1)},${yOf(p.shift).toFixed(1)}`).join("");
  windShiftSvg.innerHTML = `
    <line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="#475569" stroke-dasharray="2 3" stroke-width="0.5"/>
    <path d="${path}" stroke="#6ea8ff" stroke-width="1.4" fill="none"/>
    <text x="2" y="10" fill="#8aa0b6" font-size="9">+${(range / 2).toFixed(0)}°</text>
    <text x="2" y="${H - 2}" fill="#8aa0b6" font-size="9">−${(range / 2).toFixed(0)}°</text>
  `;
  windShiftInfo.textContent = `Shift relative to median ${Math.round(median)}° (positive = veer right, negative = back left)`;
}

// ---------- Ghost boats from race results ----------
// We don't have other boats' GPS, but we know each finisher's elapsed
// time. Synthesise a straight-line ghost from the start line midpoint
// (or our boat's position at start) to a point in the same general
// direction we sailed, at constant SOG. Useful purely to show "where
// would Boat X have been right now if they sailed in a straight line".
const ghostsLayer = L.layerGroup().addTo(map);
let ghostsEnabled = false;
let ghostsForRace = null; // { raceName, dayKey, ghosts: [{sail, name, color, marker, startSec, endSec, lineMid}] }

function setupGhostsForTrack(track) {
  ghostsLayer.clearLayers();
  ghostsForRace = null;
  if (!ghostsEnabled || !track || !track.meta?.race) return;
  const race = track.meta.race;
  const startSec = Date.parse(race.start) / 1000;
  // Use Meltemi's actual start position as ghost spawn (best we can do).
  const sample = sampleAt(track, startSec);
  // Direction towards Meltemi's position 60 sec later (roughly first leg).
  const after = sampleAt(track, startSec + 60);
  const ghosts = [];
  const colors = ["#a3a3a3", "#94a3b8", "#cbd5e1"]; // muted greys
  for (const f of race.finishers) {
    if (f.sail === MY_BOAT.sail) continue; // skip our own boat
    const elapsed = f.elapsed.split(":").map(Number);
    const elapsedSec = elapsed[0] * 3600 + elapsed[1] * 60 + elapsed[2];
    if (!elapsedSec) continue;
    ghosts.push({
      sail: f.sail,
      name: (window.BOAT_NAMES || {})[f.sail] || f.sail,
      place: f.place,
      startSec, endSec: startSec + elapsedSec,
      origin: { lat: sample.lat, lon: sample.lon },
      bearing: bearing(sample, after),
      color: colors[ghosts.length % colors.length],
    });
  }
  ghostsForRace = { ghosts };
  // Spawn one tiny dot per ghost.
  for (const g of ghosts) {
    g.marker = L.circleMarker([g.origin.lat, g.origin.lon], {
      radius: 4, weight: 1, color: "#0f1924",
      fillColor: g.color, fillOpacity: 0.7,
    })
    .bindTooltip(`${g.name} · P${g.place}`)
    .addTo(ghostsLayer);
  }
}

function bearing(a, b) {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function destination(origin, bearingDeg, distMetres) {
  const R = 6_371_000;
  const φ1 = origin.lat * Math.PI / 180;
  const λ1 = origin.lon * Math.PI / 180;
  const θ = bearingDeg * Math.PI / 180;
  const δ = distMetres / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * 180 / Math.PI, lon: λ2 * 180 / Math.PI };
}

function tickGhosts() {
  if (!ghostsForRace || raceTime == null) return;
  for (const g of ghostsForRace.ghosts) {
    if (raceTime < g.startSec || raceTime > g.endSec) continue;
    const f = (raceTime - g.startSec) / (g.endSec - g.startSec);
    // Distance proportional to elapsed time (constant pace).
    const totalDist = 2000; // 2 km — approximate course length, just for visual
    const pos = destination(g.origin, g.bearing, f * totalDist);
    g.marker.setLatLng([pos.lat, pos.lon]);
  }
}

// ---------- Compare mode ----------
// Pick two tracks → side-by-side time-series in the readout area. For now
// it's an additive selection: shift-click a second track row to compare.
let compareTrackId = null;

// ---------- GPX export ----------
function trackToGPX(track) {
  const trkpts = track.points.map((p) =>
    `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t * 1000).toISOString()}</time><speed>${(p.sog * 0.5144).toFixed(2)}</speed><course>${p.cog}</course></trkpt>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="J/80 Racing app" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${track.name}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}
function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

// Daily coach report — printable HTML covering EVERY race of the day for
// the selected boat. Each race section: header (place, finish), stats
// grid, then the same coach-report observations the sidebar shows.
function openRaceReport(track) {
  const boatName = track.meta?.boat;
  const dayKey = activeDayKey;
  if (!boatName || !dayKey) return;
  const dayRaces = (window.RACES?.[dayKey] || []);
  // Find this boat's track for each race of the day.
  const boatTracks = tracks.filter((t) =>
    !t.removed && t.meta?.boat === boatName);
  const sections = [];
  for (const race of dayRaces) {
    const t = boatTracks.find((bt) => bt.meta?.race?.name === race.name);
    if (!t) continue; // boat didn't have a track for this race
    const stats = analyzeRace(t, race, t.meta?.startMarks, windAtBoatFn);
    const obs = coachReport(t, stats, race);
    const me = race.finishers.find((f) =>
      (window.BOAT_NAMES || {})[f.sail] === boatName);
    const meDnx = race.dnc.find((d) =>
      (window.BOAT_NAMES || {})[d.sail] === boatName);
    const result = me ? `P${me.place} / ${race.finishers.length + race.dnc.length}`
                     : meDnx ? meDnx.status : "—";
    const polarInner = polarSvgInner(stats.polar);
    const polarBlock = polarInner
      ? `<div class="polar-block">
           <div class="polar-title">Polar — your max SOG (green) vs J/80 target @ 12 kn TWS (yellow)</div>
           <svg viewBox="-115 -115 230 230" width="240" height="240" style="display:block;margin:auto;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px;">
             ${polarInner}
           </svg>
         </div>`
      : "";
    const sectionHtml = `
      <div class="race-block">
        <h2>${race.name} · ${race.title || ""}</h2>
        <div class="meta">Start ${String(race.startH).padStart(2, "0")}:${String(race.startM).padStart(2, "0")} · Result <b>${result}</b>${me ? ` · Finish ${me.finish} · Elapsed ${me.elapsed}` : ""}</div>
        <div class="grid">
          <div><span>Tacks</span><b>${stats.tacks.length}</b></div>
          <div><span>Gybes</span><b>${stats.gybes.length}</b></div>
          <div><span>Marks</span><b>${stats.marks.length}</b></div>
          <div><span>Max SOG</span><b>${t.maxSog.toFixed(1)} kn</b></div>
          <div><span>Wind dir</span><b>${stats.avgWindDeg != null ? Math.round(stats.avgWindDeg) + "°" : "—"}</b></div>
          <div><span>vs J/80 polar</span><b>${stats.avgPolarRatio != null ? (stats.avgPolarRatio * 100).toFixed(0) + "%" : "—"}</b></div>
          ${stats.heelStats ? `<div><span>Heel (med/max)</span><b>${stats.heelStats.median.toFixed(0)}° / ${stats.heelStats.max.toFixed(0)}°</b></div>` : ""}
          ${stats.startLine ? `
          <div><span>Dist at gun</span><b>${stats.startLine.distAtGun.toFixed(0)} m</b></div>
          <div><span>Crossed line</span><b>${stats.startLine.lateBy != null ? fmtSec(stats.startLine.lateBy) : "—"}${stats.startLine.ocs ? " (OCS)" : ""}</b></div>` : ""}
        </div>
        <div class="coach">
          ${Object.keys(COACH_TITLES).map((k) => {
            if (!obs[k] || !obs[k].length) return "";
            const items = obs[k].map((o) =>
              `<li class="cr-${o.level}">${o.text}</li>`).join("");
            return `<div class="cr-sec"><div class="cr-sec-title">${COACH_TITLES[k]}</div><ul>${items}</ul></div>`;
          }).join("")}
        </div>
        ${polarBlock}
      </div>`;
    sections.push(sectionHtml);
  }

  if (!sections.length) {
    alert(`No tracks for ${boatName} on ${dayKey} — load the day first.`);
    return;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${boatName} — coach report ${dayKey}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 28px; color: #111; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .day { color: #555; margin-bottom: 16px; font-size: 14px; }
  h2 { margin: 0 0 4px; font-size: 16px; color: #1d4ed8; }
  .race-block {
    border-top: 2px solid #1d4ed8; padding: 12px 0;
    page-break-inside: avoid;
  }
  .race-block:not(:first-of-type) { page-break-before: auto; }
  .meta { color: #555; font-size: 12px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
  .grid > div {
    padding: 6px 8px; background: #f3f4f6; border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  .grid span { display: block; font-size: 10px; color: #555;
    text-transform: uppercase; letter-spacing: 0.4px; }
  .grid b { display: block; font-size: 16px; }
  .coach { font-size: 12px; }
  .cr-sec { margin-bottom: 8px; }
  .cr-sec-title { font-weight: 600; color: #444; margin-bottom: 2px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  .coach ul { list-style: none; padding: 0; margin: 0; }
  .coach li { padding: 2px 0 2px 16px; position: relative; line-height: 1.35; }
  .coach li::before { position: absolute; left: 0; top: 2px; font-size: 10px; }
  .cr-good::before { content: "✓"; color: #16a34a; }
  .cr-info::before { content: "•"; color: #2563eb; }
  .cr-warn::before { content: "!"; color: #ca8a04; font-weight: 700; }
  .cr-bad::before  { content: "✗"; color: #dc2626; font-weight: 700; }
  .cr-good { color: #166534; }
  .cr-warn { color: #854d0e; }
  .cr-bad  { color: #991b1b; }
  .polar-block { margin-top: 12px; page-break-inside: avoid; }
  .polar-title { font-size: 11px; color: #555; text-align: center; margin-bottom: 4px; }
  .footer { color: #888; font-size: 10px; margin-top: 24px; }
</style></head><body>
<h1>${boatName} — coach report</h1>
<div class="day">${dayKey} · ${sections.length} race${sections.length > 1 ? "s" : ""} of the day</div>
${sections.join("")}
<div class="footer">Generated by J/80 Racing app · ${new Date().toLocaleString()} ·
  <span style="color:#aaa;">j80-racing.yafo78.workers.dev</span></div>
</body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 350);
}

// ---------- Legs / Maneuvers / Polar / Gap ----------
const legsEl = document.getElementById("legs");
const legsTbody = legsEl.querySelector("tbody");
const maneuversEl = document.getElementById("maneuvers");
const maneuversTbody = maneuversEl.querySelector("tbody");
const maneuversCount = maneuversEl.querySelector(".man-count");
const polarPlotEl = document.getElementById("polarPlot");
const polarSvg = document.getElementById("polarSvg");
const ppInfo = document.querySelector("#polarPlot .pp-info");
const gapChartEl = document.getElementById("gapChart");
const gapSvg = document.getElementById("gapSvg");
const gcOther = document.querySelector("#gapChart .gc-other");
const gcInfo = document.querySelector("#gapChart .gc-info");

function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function renderLegs(legs) {
  if (!legs || !legs.length) { legsEl.hidden = true; return; }
  legsEl.hidden = false;
  legsTbody.innerHTML = legs.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="leg-${l.type}">${l.type[0].toUpperCase() + l.type.slice(1)}</td>
      <td>${(l.distM / 1852).toFixed(2)} nm</td>
      <td>${fmtDuration(l.durationSec)}</td>
      <td>${l.avgSog.toFixed(1)} kn</td>
      <td>${l.tacks}/${l.gybes}</td>
    </tr>`).join("");
}

function renderManeuvers(stats) {
  const list = [
    ...stats.tacks.map((m) => ({ ...m, type: "Tack" })),
    ...stats.gybes.map((m) => ({ ...m, type: "Gybe" })),
  ].sort((a, b) => a.t - b.t);
  if (!list.length) { maneuversEl.hidden = true; return; }
  maneuversEl.hidden = false;
  maneuversCount.textContent = `(${stats.tacks.length} tacks, ${stats.gybes.length} gybes)`;
  maneuversTbody.innerHTML = list.map((m, i) => `
    <tr data-t="${m.t}" data-lat="${m.lat}" data-lon="${m.lon}">
      <td>${i + 1}</td>
      <td>${new Date(m.t * 1000).toLocaleTimeString().slice(0, 5)}</td>
      <td class="man-${m.type.toLowerCase()}">${m.type}</td>
      <td>${m.lostKn != null ? "−" + m.lostKn.toFixed(1) + " kn" : "—"}</td>
      <td>${m.recoverySec != null ? m.recoverySec.toFixed(0) + "s" : "—"}</td>
      <td>${m.heelBefore != null ? Math.abs(m.heelBefore).toFixed(0) + "°" : "—"}</td>
    </tr>`).join("");
  for (const tr of maneuversTbody.querySelectorAll("tr")) {
    tr.addEventListener("click", () => {
      const t = Number(tr.dataset.t);
      updateBoatsToRaceTime(t);
      map.panTo([Number(tr.dataset.lat), Number(tr.dataset.lon)]);
    });
  }
}

// Build the polar diagram as a standalone SVG content string. Used by
// renderPolarPlot for the live sidebar AND by openRaceReport for the
// printable PDF (so polars travel along with the report).
function polarSvgInner(polar) {
  if (!polar) return null;
  const angles = Object.keys(polar).map(Number).sort((a, b) => a - b);
  let totalCount = 0;
  for (const a of angles) totalCount += polar[a].port.count + polar[a].stbd.count;
  if (totalCount < 30) return null;
  let maxSog = 0;
  for (const a of angles) {
    if (polar[a].port.maxSog > maxSog) maxSog = polar[a].port.maxSog;
    if (polar[a].stbd.maxSog > maxSog) maxSog = polar[a].stbd.maxSog;
  }
  maxSog = Math.max(6, Math.ceil(maxSog));
  const r = (sog) => (sog / maxSog) * 100;
  const xy = (twa, sog, side) => {
    const sign = side === "stbd" ? 1 : -1;
    const rad = (twa * Math.PI / 180) * sign;
    return [Math.sin(rad) * r(sog), -Math.cos(rad) * r(sog)];
  };
  // Concentric rings + a numeric label per ring (knots), and TWA tick
  // labels around the perimeter so a reader can map any point to a
  // (TWA, SOG) pair without guessing.
  const ringValues = [2, 4, 6, 8, 10, 12].filter((s) => s <= maxSog);
  const rings = ringValues.map((s) =>
    `<circle cx="0" cy="0" r="${r(s)}" fill="none" stroke="#264168" stroke-width="0.5"/>` +
    `<text x="2" y="${(-r(s) + 3).toFixed(1)}" fill="#94a3b8" font-size="6">${s}</text>`
  ).join("");
  // TWA tick labels: 30°, 60°, 90°, 120°, 150° both sides.
  const twaLabels = [30, 60, 90, 120, 150].map((twa) => {
    const stbdRad = twa * Math.PI / 180;
    const portRad = -twa * Math.PI / 180;
    const sX = Math.sin(stbdRad) * 108, sY = -Math.cos(stbdRad) * 108;
    const pX = Math.sin(portRad) * 108, pY = -Math.cos(portRad) * 108;
    return `<text x="${sX.toFixed(1)}" y="${sY.toFixed(1)}" fill="#94a3b8" font-size="6" text-anchor="middle" dominant-baseline="middle">${twa}°</text>` +
           `<text x="${pX.toFixed(1)}" y="${pY.toFixed(1)}" fill="#94a3b8" font-size="6" text-anchor="middle" dominant-baseline="middle">${twa}°</text>`;
  }).join("");
  const axes = `
    <line x1="0" y1="-105" x2="0" y2="105" stroke="#475569" stroke-width="0.5" stroke-dasharray="2 2"/>
    <line x1="-105" y1="0" x2="105" y2="0" stroke="#475569" stroke-width="0.5" stroke-dasharray="2 2"/>
    <text x="0" y="-101" text-anchor="middle" fill="#8aa0b6" font-size="7">WIND</text>
    <text x="-100" y="-2" fill="#94a3b8" font-size="6">PORT</text>
    <text x="80" y="-2" fill="#94a3b8" font-size="6">STBD</text>
    ${twaLabels}`;
  const target = angles.map((a) => xy(a, polarSpeed(12, a), "stbd"))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const targetMirror = angles.map((a) => xy(a, polarSpeed(12, a), "port"))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const yours = (side) => angles.map((a) => xy(a, polar[a][side].maxSog || 0, side))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const dots = [];
  for (const a of angles) {
    for (const side of ["port", "stbd"]) {
      const b = polar[a][side];
      if (!b.count) continue;
      const avg = b.sumSog / b.count;
      const [x, y] = xy(a, avg, side);
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.min(5, 1.5 + Math.sqrt(b.count) / 4).toFixed(1)}" fill="#6ea8ff" opacity="0.7"/>`);
    }
  }
  return `${rings}${axes}
    <path d="${target}" fill="none" stroke="#facc15" stroke-width="0.7" stroke-dasharray="3 2" opacity="0.7"/>
    <path d="${targetMirror}" fill="none" stroke="#facc15" stroke-width="0.7" stroke-dasharray="3 2" opacity="0.7"/>
    <path d="${yours("stbd")}" fill="none" stroke="#6fd06b" stroke-width="1.2" opacity="0.85"/>
    <path d="${yours("port")}" fill="none" stroke="#6fd06b" stroke-width="1.2" opacity="0.85"/>
    ${dots.join("")}`;
}

function renderPolarPlot(polar) {
  const inner = polarSvgInner(polar);
  if (!inner) { polarPlotEl.hidden = true; return; }
  polarPlotEl.hidden = false;
  polarSvg.innerHTML = inner;
  ppInfo.innerHTML = `<span style="color:#6fd06b;">●</span> your max SOG &nbsp; <span style="color:#facc15;">--</span> J/80 polar @ 12 kn TWS &nbsp; <span style="color:#94a3b8;">rings = kn</span>`;
}

// Gap chart vs another visible track in the SAME race window. Picks the
// first non-self visible track as the comparison; can be expanded later
// to a chooser.
function renderGapChart(myTrack) {
  const others = tracks.filter((t) =>
    !t.removed && t.visible && t.id !== myTrack.id &&
    t.meta?.race?.name === myTrack.meta?.race?.name &&
    t.meta?.boat !== myTrack.meta?.boat);
  if (!others.length) { gapChartEl.hidden = true; return; }
  const other = others[0];
  // Use the average of the START LINE midpoint as ref, or first point.
  const ref = myTrack.meta?.startMarks?.rc && myTrack.meta?.startMarks?.pin
    ? { lat: (myTrack.meta.startMarks.rc.lat + myTrack.meta.startMarks.pin.lat) / 2,
        lon: (myTrack.meta.startMarks.rc.lon + myTrack.meta.startMarks.pin.lon) / 2 }
    : myTrack.points[0];
  const series = timeGapSeries(myTrack, other, ref);
  if (series.length < 5) { gapChartEl.hidden = true; return; }
  gapChartEl.hidden = false;
  gcOther.textContent = other.meta?.boat || other.name;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const maxAbs = Math.max(10, ...series.map((s) => Math.abs(s.gap)));
  const W = 300, H = 80, midY = H / 2;
  const xOf = (t) => ((t - t0) / (t1 - t0)) * W;
  const yOf = (g) => midY - (g / maxAbs) * (H / 2 - 5);
  const path = series.map((s, i) =>
    `${i === 0 ? "M" : "L"}${xOf(s.t).toFixed(1)},${yOf(s.gap).toFixed(1)}`).join("");
  // Shade above (gain) green, below (loss) red.
  gapSvg.innerHTML = `
    <line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="#475569" stroke-dasharray="2 3" stroke-width="0.5"/>
    <path d="${path}" stroke="#6ea8ff" stroke-width="1.4" fill="none"/>
    <text x="2" y="10" fill="#6fd06b" font-size="9">+${maxAbs.toFixed(0)}s ahead</text>
    <text x="2" y="${H - 2}" fill="#f87171" font-size="9">−${maxAbs.toFixed(0)}s behind</text>
  `;
  const final = series[series.length - 1].gap;
  gcInfo.textContent = final > 0
    ? `${myTrack.meta?.boat || "Me"} finished ${final.toFixed(0)}s ahead of ${other.meta?.boat || "them"}`
    : `${myTrack.meta?.boat || "Me"} finished ${(-final).toFixed(0)}s behind ${other.meta?.boat || "them"}`;
}

// ---------- Race-stats sidebar panel ----------
const raceStatsEl = document.getElementById("raceStats");
const rsStartGrid = document.querySelector("#rsStart .rs-grid");
const rsManeuversGrid = document.querySelector("#rsManeuvers .rs-grid");
const rsPerfGrid = document.querySelector("#rsPerf .rs-grid");
const markRoundingsLayer = L.layerGroup().addTo(map);

// Race-level mark store. Marks are physical objects in the water, NOT
// boat-specific — so we compute them once per race using ALL visible
// boats' tracks and render them while any of that race's tracks are
// visible. More boats rounding the same mark = better averaged position
// (each boat passes tangent to the mark; centroid converges).
const raceMarks = new Map(); // race.name -> [{lat, lon, label, rounded[], n}]

// Race-level finish-line store. Inferred from:
//   • RC end position (anchored committee boat = same as the start line's RC)
//   • Each finisher's GPS position at their printed finish time
// All crossings should lie on a straight line passing through the RC.
// We average the bearings from RC to each crossing → line direction;
// pin end placed at the furthest crossing along that direction + small
// buffer for visibility.
const raceFinishLines = new Map(); // race.name -> { rc, pin, crossings: [{sail, place, lat, lon}] }

// Helper: average true-wind direction across an arbitrary point series.
function avgWindFor(track, race) {
  let avg = null, sx = 0, sy = 0, c = 0;
  for (let i = 0; i < track.points.length; i += Math.max(1, Math.floor(track.points.length / 30))) {
    const p = track.points[i];
    const w = windAtBoatFn(p.t, p.lat, p.lon);
    if (!w || w.deg == null) continue;
    const r = w.deg * Math.PI / 180;
    sx += Math.sin(r); sy += Math.cos(r); c++;
  }
  if (c > 0) avg = (Math.atan2(sx / c, sy / c) * 180 / Math.PI + 360) % 360;
  if (avg == null && race?.date && window.WIND_DAILY?.[race.date]?.dir != null) {
    avg = window.WIND_DAILY[race.date].dir;
  }
  return avg;
}

// Recompute the mark cache for the currently-loaded day. Should be called
// once per day-load after all addTrack calls have run.
function computeRaceMarksForDay() {
  raceMarks.clear();
  // Group tracks by race name.
  const byRace = new Map();
  for (const t of tracks) {
    if (t.removed) continue;
    const name = t.meta?.race?.name;
    if (!name) continue;
    if (!byRace.has(name)) byRace.set(name, { race: t.meta.race, tracks: [] });
    byRace.get(name).tracks.push(t);
  }
  for (const [raceName, info] of byRace) {
    const wind = avgWindFor(info.tracks[0], info.race);
    const startSec = Date.parse(info.race.start) / 1000;
    const endSec = info.race.end ? Date.parse(info.race.end) / 1000 : null;
    const allEvents = [];
    for (const t of info.tracks) {
      const events = detectMarkRoundings(
        t.points, startSec, endSec, wind, info.race.title);
      // Tag each event with its boat so clusterMarks can require
      // cross-boat agreement before declaring a real mark.
      for (const ev of events) {
        ev.boat = t.meta?.boat || t.name;
        allEvents.push(ev);
      }
    }
    const marks = clusterMarks(allEvents, wind, 100);
    raceMarks.set(raceName, marks);
    // Also infer the finish line from boat crossings at their printed
    // finish times — uses the same anchored RC as the start line.
    const fl = computeFinishLineForRace(info.race, info.tracks);
    if (fl) raceFinishLines.set(raceName, fl);
  }
}

// Infer the finish line for one race: take the (anchored) RC end and the
// GPS positions where each loaded boat crossed at their printed finish
// time. The line passes through RC at the AVERAGE bearing to the
// crossings, extending past the furthest one for visibility.
function computeFinishLineForRace(race, raceTracks) {
  if (!race?.finishers?.length) return null;
  let rc = null;
  for (const t of raceTracks) {
    if (t.meta?.startMarks?.rc) { rc = t.meta.startMarks.rc; break; }
  }
  if (!rc) return null;
  const names = window.BOAT_NAMES || {};
  const crossings = [];
  for (const f of race.finishers) {
    const boatName = names[f.sail];
    if (!boatName) continue;
    const tr = raceTracks.find((t) => t.meta?.boat === boatName);
    if (!tr) continue;
    const finishSec = Date.parse(`${race.date}T${f.finish}+08:00`) / 1000;
    if (!isFinite(finishSec)) continue;
    if (finishSec < tr.points[0].t || finishSec > tr.points[tr.points.length - 1].t) continue;
    const s = sampleAt(tr, finishSec);
    crossings.push({ sail: f.sail, place: f.place, boat: boatName, lat: s.lat, lon: s.lon });
  }
  if (!crossings.length) return null;
  const lat0 = rc.lat;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat0 * Math.PI / 180);
  let sx = 0, sy = 0;
  for (const c of crossings) {
    const dx = (c.lon - rc.lon) * mLon;
    const dy = (c.lat - rc.lat) * mLat;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;
    sx += dx / len; sy += dy / len;
  }
  const norm = Math.sqrt(sx * sx + sy * sy);
  if (norm < 0.001) return null;
  const ux = sx / norm, uy = sy / norm;
  let maxProj = 0;
  for (const c of crossings) {
    const dx = (c.lon - rc.lon) * mLon;
    const dy = (c.lat - rc.lat) * mLat;
    const proj = dx * ux + dy * uy;
    if (proj > maxProj) maxProj = proj;
  }
  if (maxProj < 5) maxProj = 50;
  const pinM = maxProj + 8;
  const pin = {
    lat: rc.lat + uy * pinM / mLat,
    lon: rc.lon + ux * pinM / mLon,
  };
  return { rc, pin, crossings };
}

const raceFinishLineLayer = L.layerGroup().addTo(map);
let lastRenderedFinishRace = null;
function renderFinishLineOnMap() {
  const activeRaceName = visibleRaceForMarks();
  if (activeRaceName === lastRenderedFinishRace) return;
  lastRenderedFinishRace = activeRaceName;
  raceFinishLineLayer.clearLayers();
  if (!activeRaceName) return;
  const fl = raceFinishLines.get(activeRaceName);
  if (!fl) return;
  L.polyline([[fl.rc.lat, fl.rc.lon], [fl.pin.lat, fl.pin.lon]], {
    color: "#a78bfa", weight: 2.5, opacity: 0.95, dashArray: "8 4",
  }).bindTooltip(`Finish line · ${activeRaceName} · inferred from ${fl.crossings.length} boat${fl.crossings.length > 1 ? "s" : ""}`)
    .addTo(raceFinishLineLayer);
  L.circleMarker([fl.pin.lat, fl.pin.lon], {
    radius: 5, weight: 2, color: "#0f1924",
    fillColor: "#a78bfa", fillOpacity: 1,
  }).bindTooltip("Finish pin (inferred)")
    .addTo(raceFinishLineLayer);
  for (const c of fl.crossings) {
    L.circleMarker([c.lat, c.lon], {
      radius: 3, weight: 1, color: "#0f1924",
      fillColor: "#fde047", fillOpacity: 0.9,
    }).bindTooltip(`P${c.place} · ${c.boat} crossed here`)
      .addTo(raceFinishLineLayer);
  }
}

// Pick the SINGLE race whose marks should currently show.
//
//   1. The playback clock must be AFTER the race's actual gun — marks
//      can't be reached before the start, so showing them during the
//      pre-start window is misleading.
//   2. The clock must be at or before the race end + 2 min grace.
//   3. Among races meeting (1)+(2): if a race tab is selected (R1/R2/R3)
//      and that race matches, use it; otherwise use the race the clock
//      is in (handles the "All" tab case).
function visibleRaceForMarks() {
  if (raceTime == null) return null;
  let inRace = null;
  const seen = new Set();
  for (const t of tracks) {
    if (t.removed || !t.meta?.race) continue;
    const r = t.meta.race;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    const startSec = Date.parse(r.start) / 1000;
    const endSec = r.end ? Date.parse(r.end) / 1000 : startSec + 3600;
    // Strictly post-gun: no marks during the start sequence.
    if (raceTime < startSec || raceTime > endSec + 120) continue;
    if (activeRaceFilter && r.name === activeRaceFilter) return r.name;
    if (!activeRaceFilter && inRace == null) inRace = r.name;
  }
  return inRace;
}

let lastRenderedMarksRace = null;
function renderRaceMarksOnMap() {
  const activeRaceName = visibleRaceForMarks();
  if (activeRaceName === lastRenderedMarksRace) return;
  lastRenderedMarksRace = activeRaceName;
  markRoundingsLayer.clearLayers();
  if (!activeRaceName) return;
  const marks = raceMarks.get(activeRaceName) || [];
  for (const m of marks) {
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        html: `<div class="mark-icon">${m.label}</div>`,
        className: "", iconSize: [26, 26], iconAnchor: [13, 13],
      }),
      interactive: true, zIndexOffset: 300,
    })
    .bindTooltip(`${m.label} mark · ${activeRaceName} · inferred from ${m.rounded.length} rounding${m.rounded.length > 1 ? "s" : ""}`)
    .addTo(markRoundingsLayer);
  }
}

function windAtBoatFn(t, lat, lon) {
  // Walk the on-map station markers for the closest hour and IDW from there.
  const samples = [];
  if (!windMarkers.size || !window.WIND_HOURLY) return null;
  const date = activeDayKey;
  const day = window.WIND_HOURLY[date];
  if (!day) return null;
  const hk = new Date((t + 8 * 3600) * 1000);
  const h = hk.getUTCHours();
  for (const [name, info] of windMarkers) {
    const series = day[name];
    if (!series || !series.length) continue;
    let pick = series[0];
    for (const r of series) if (r.h <= h) pick = r;
    if (h < series[0].h) pick = series[0];
    if (pick.deg == null || pick.spd == null) continue;
    const uv = readingToUV(pick);
    samples.push({ lat: info.coord.lat, lon: info.coord.lon, u: uv.u, v: uv.v, gust: uv.gust });
  }
  if (samples.length < 3) return null;
  const r = idwAt(lat, lon, samples);
  return r ? { spd: r.spd, deg: r.deg } : null;
}

function fmtSec(sec) {
  if (sec == null) return "—";
  const sign = sec < 0 ? "−" : "+";
  const a = Math.abs(sec);
  const m = Math.floor(a / 60), s = a - m * 60;
  return m > 0 ? `${sign}${m}m${s.toFixed(0)}s` : `${sign}${s.toFixed(1)}s`;
}

let _activeAnalysis = null;
function renderRaceStats(track) {
  if (!track || track.removed) { raceStatsEl.hidden = true; return; }
  const stats = analyzeRace(track, track.meta?.race, track.meta?.startMarks, windAtBoatFn);
  _activeAnalysis = { trackId: track.id, stats };
  raceStatsEl.hidden = false;

  // Start
  const sanity = impliedStartCheck(track.meta?.race);
  let sanityRow = "";
  if (sanity.implied && sanity.n >= 2) {
    const cls = Math.abs(sanity.deltaSec) <= 1 ? "rs-good"
              : Math.abs(sanity.deltaSec) <= 60 ? "" : "rs-bad";
    const agreePct = Math.round(sanity.agreement * 100);
    const note = Math.abs(sanity.deltaSec) <= 1
      ? `matches ${sanity.implied} (${agreePct}% boats agree)`
      : `implied ${sanity.implied} (Δ ${fmtSec(sanity.deltaSec)}, ${agreePct}% agree)`;
    sanityRow = `<span class="rs-k">Stated start</span><span class="rs-v ${cls}">${sanity.stated.slice(0,5)} · ${note}</span>`;
  }
  if (stats.startLine) {
    const sl = stats.startLine;
    const lateClass = sl.ocs ? "rs-bad" : (sl.lateBy != null && sl.lateBy < 5 ? "rs-good" : "");
    rsStartGrid.innerHTML = `
      <span class="rs-k">Dist at gun</span><span class="rs-v">${sl.distAtGun.toFixed(0)} m</span>
      <span class="rs-k">SOG at gun</span><span class="rs-v">${sl.sogAtGun.toFixed(1)} kn</span>
      <span class="rs-k">Crossed line</span><span class="rs-v ${lateClass}">${sl.lateBy != null ? fmtSec(sl.lateBy) : "—"}${sl.ocs ? " (OCS!)" : ""}</span>
      ${sanityRow}
    `;
  } else {
    rsStartGrid.innerHTML = `<span class="rs-k" style="grid-column:1/3;">No start line pinged</span>${sanityRow}`;
  }

  // Maneuvers
  const totalRoundings = stats.marks.reduce((n, m) => n + m.rounded.length, 0);
  rsManeuversGrid.innerHTML = `
    <span class="rs-k">Tacks</span><span class="rs-v">${stats.tacks.length}</span>
    <span class="rs-k">Gybes</span><span class="rs-v">${stats.gybes.length}</span>
    <span class="rs-k">Marks (rounded)</span><span class="rs-v">${stats.marks.length} (${totalRoundings})</span>
    <span class="rs-k">Avg wind ${stats.avgWindDeg != null ? Math.round(stats.avgWindDeg) + "°" : "—"}</span>
    <span class="rs-v"></span>
  `;

  // Performance
  const polar = stats.avgPolarRatio != null
    ? `${(stats.avgPolarRatio * 100).toFixed(0)}% of polar`
    : "—";
  const polarClass = stats.avgPolarRatio == null ? "" :
                     (stats.avgPolarRatio >= 0.95 ? "rs-good" :
                      stats.avgPolarRatio < 0.75 ? "rs-bad" : "");
  const heelRow = stats.heelStats
    ? `<span class="rs-k">Heel (median/p90/max)</span><span class="rs-v">${stats.heelStats.median.toFixed(0)}° / ${stats.heelStats.p90.toFixed(0)}° / ${stats.heelStats.max.toFixed(0)}°</span>`
    : "";
  rsPerfGrid.innerHTML = `
    <span class="rs-k">vs J/80 polar</span><span class="rs-v ${polarClass}">${polar}</span>
    <span class="rs-k">Max SOG</span><span class="rs-v">${track.maxSog.toFixed(1)} kn</span>
    ${heelRow}
  `;

  // Mark icons are race-level now (rendered by renderRaceMarksOnMap),
  // not per-track — so we don't touch the map layer here.
}

function refreshReadout() {
  if (selectedTrackId == null) return;
  const t = tracks[selectedTrackId];
  if (!t || t.removed) return;
  const s = sampleAt(t, raceTime ?? t.tStart);
  roSog.textContent = s.sog.toFixed(1);
  roCog.textContent = Math.round(s.cog).toString().padStart(3, "0");
  roTime.textContent = new Date(s.t * 1000).toLocaleString();

  // Interpolated wind at the boat's current lat/lon.
  const samples = currentWindSamples();
  if (samples.length >= 3) {
    const w = idwAt(s.lat, s.lon, samples);
    if (w && w.spd >= 0.1) {
      const fromDeg = Math.round(w.deg);
      roWind.textContent = `${String(fromDeg).padStart(3, "0")}° · ${w.spd.toFixed(1)}`;
    } else {
      roWind.textContent = "–";
    }
  } else {
    roWind.textContent = "–";
  }
}

function fitAll() {
  const live = tracks.filter((t) => !t.removed && t.visible);
  if (!live.length) return;
  let bounds = null;
  for (const t of live) {
    // Use the FULL race bounds, not the (initially empty) drawn line.
    const b = t.fullBounds;
    bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }
  // Tight padding + a generous maxZoom keeps races filling the viewport
  // instead of being a tiny squiggle in the middle.
  map.fitBounds(bounds, { padding: [10, 10], maxZoom: 17 });
}

// ---------- Race clock & playback ----------
// raceTime is a Unix timestamp (seconds, fractional). The clock spans
// [raceStart, raceEnd] = union of all visible tracks' timestamps, so
// when multiple boats are loaded their cursors stay in sync.
let raceStart = null, raceEnd = null, raceTime = null;
let playing = false, speedMult = 10;
let lastFrameMs = 0;

const playbar = document.getElementById("playbar");
const playBtn = document.getElementById("playBtn");
const pbSlider = document.getElementById("pbSlider");
const pbNow = document.getElementById("pbNow");
const pbEnd = document.getElementById("pbEnd");
const pbSpeed = document.getElementById("pbSpeed");

function updateRaceClockBounds() {
  const live = tracks.filter((t) => !t.removed && t.visible);
  if (!live.length) {
    raceStart = raceEnd = raceTime = null;
    playbar.hidden = true;
    playing = false;
    playBtn.textContent = "▶";
    return;
  }
  raceStart = Math.min(...live.map((t) => t.tStart));
  raceEnd = Math.max(...live.map((t) => t.tEnd));
  if (raceTime == null || raceTime < raceStart || raceTime > raceEnd) {
    raceTime = raceStart;
  }
  playbar.hidden = false;
  pbEnd.textContent = new Date(raceEnd * 1000).toLocaleTimeString();
  syncSliderFromTime();
  updateBoatsToRaceTime(raceTime);
}

function syncSliderFromTime() {
  if (raceStart == null) return;
  const span = Math.max(1, raceEnd - raceStart);
  pbSlider.value = Math.round(((raceTime - raceStart) / span) * 1000);
  pbNow.textContent = new Date(raceTime * 1000).toLocaleTimeString();
}

// Binary search + linear interpolation on points[].t
function sampleAt(track, t) {
  const pts = track.points;
  if (t <= pts[0].t) return { ...pts[0] };
  if (t >= pts[pts.length - 1].t) return { ...pts[pts.length - 1] };
  let lo = 0, hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  // Shortest-angle interpolation for COG (handles 359°→1° wrap)
  let dc = b.cog - a.cog;
  if (dc > 180) dc -= 360;
  else if (dc < -180) dc += 360;
  let cog = a.cog + dc * f;
  if (cog < 0) cog += 360; else if (cog >= 360) cog -= 360;
  return {
    t,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    sog: a.sog + (b.sog - a.sog) * f,
    cog,
  };
}

function updateBoatsToRaceTime(t) {
  raceTime = t;
  for (const tr of tracks) {
    if (tr.removed || !tr.visible) continue;
    // If this track hasn't started yet or has already ended, park the boat at its endpoint.
    const clamped = Math.max(tr.tStart, Math.min(tr.tEnd, t));
    const s = sampleAt(tr, clamped);
    tr.boat.setLatLng([s.lat, s.lon]);
    // Update rotations on the existing DOM nodes (avoids flicker from setIcon).
    const el = tr.boat.getElement();
    if (el) {
      const inner = el.querySelector(".boat-icon");
      if (inner) inner.style.transform = `rotate(${s.cog}deg)`;
      // Sail orientation: wind from starboard → sail on port (negative).
      const sail = el.querySelector(".boat-sail");
      if (sail) {
        const w = windAtBoatFn ? windAtBoatFn(s.t, s.lat, s.lon) : null;
        let twa = null;
        if (w && w.deg != null) {
          // TWA in boat frame = wind FROM bearing - boat heading, signed.
          twa = w.deg - s.cog;
          while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
        }
        const sa = sailAngleFromTwa(twa);
        // SVG transform attribute rotates around the given pivot (mast at 0,-3),
        // which is more reliably consistent across browsers than CSS for SVG groups.
        sail.setAttribute("transform", `rotate(${sa != null ? sa : 0} 0 -3)`);
      }
    } else {
      tr.boat.setIcon(boatIcon(tr.color, s.cog));
    }
    // Extend the trail polyline up to the boat's current position.
    // Binary search the points array for the index ≤ clamped time.
    const pts = tr.points;
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= clamped) lo = mid; else hi = mid;
    }
    // tr.latlngs[i] corresponds to pts[i]; include up to lo and append the
    // interpolated boat position so the trail tip touches the moving icon.
    const trail = tr.latlngs.slice(0, lo + 1);
    trail.push([s.lat, s.lon]);
    tr.line.setLatLngs(trail);
    // If the boat's popup is open, keep its readout in sync with the clock.
    if (tr.boat.isPopupOpen()) tr.boat.setPopupContent(boatPopupHtml(tr, s));
  }
  syncSliderFromTime();
  refreshReadout();
  refreshWindReadout();
  updateWindMap();
  renderWindGrid();
  tickGhosts();
  refreshStartCountdown();
  renderRaceMarksOnMap(); renderFinishLineOnMap();
  update3DBoats(raceTime);
  tickTrackLegend();
  syncUrlState();
}

// Animation loop — advances raceTime by dt * speedMult while playing.
function tick(nowMs) {
  if (playing && raceStart != null) {
    const dt = (nowMs - lastFrameMs) / 1000;
    let next = raceTime + dt * speedMult;
    if (next >= raceEnd) { next = raceEnd; playing = false; playBtn.textContent = "▶"; }
    updateBoatsToRaceTime(next);
  }
  lastFrameMs = nowMs;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

playBtn.addEventListener("click", () => {
  if (raceStart == null) return;
  if (raceTime >= raceEnd) raceTime = raceStart;
  playing = !playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
});
pbSlider.addEventListener("input", () => {
  if (raceStart == null) return;
  const f = Number(pbSlider.value) / 1000;
  updateBoatsToRaceTime(raceStart + f * (raceEnd - raceStart));
});
pbSpeed.addEventListener("change", () => {
  speedMult = Number(pbSpeed.value);
  syncUrlState();
});

// ---------- Keyboard shortcuts ----------
// Ignore when typing in form fields so we don't hijack the day picker.
function isFormField(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
    || el.tagName === "SELECT" || el.isContentEditable);
}
const SPEEDS = [1, 5, 10, 30, 50, 100];
window.addEventListener("keydown", (e) => {
  if (isFormField(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      if (raceStart == null) return;
      if (raceTime >= raceEnd) raceTime = raceStart;
      playing = !playing;
      playBtn.textContent = playing ? "❚❚" : "▶";
      break;
    case "ArrowLeft":
      if (raceStart == null) return;
      e.preventDefault();
      updateBoatsToRaceTime(Math.max(raceStart, raceTime - (e.shiftKey ? 60 : 10)));
      break;
    case "ArrowRight":
      if (raceStart == null) return;
      e.preventDefault();
      updateBoatsToRaceTime(Math.min(raceEnd, raceTime + (e.shiftKey ? 60 : 10)));
      break;
    case ",":
      if (raceStart == null) return;
      updateBoatsToRaceTime(Math.max(raceStart, raceTime - 1));
      break;
    case ".":
      if (raceStart == null) return;
      updateBoatsToRaceTime(Math.min(raceEnd, raceTime + 1));
      break;
    case "+": case "=": {
      const i = Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speedMult) + 1);
      speedMult = SPEEDS[i];
      pbSpeed.value = String(speedMult);
      break;
    }
    case "-": case "_": {
      const i = Math.max(0, SPEEDS.indexOf(speedMult) - 1);
      speedMult = SPEEDS[i];
      pbSpeed.value = String(speedMult);
      break;
    }
    case "r": case "R":
      if (raceStart == null) return;
      updateBoatsToRaceTime(raceStart);
      break;
    case "f": case "F":
      fitAll();
      break;
  }
});

// ---------- Click-on-map to seek ----------
// Clicking a track polyline jumps the race clock to the time of the
// nearest point on that track. Each track's line gets the listener in
// addTrack(); we put the implementation here so it has access to the
// race-clock helpers.
function seekToTrackPoint(track, latlng) {
  if (!track || track.removed) return;
  // Find the point on this track closest to the click in lat/lon space
  // (cheap squared-distance — fine at HK scale).
  const pts = track.points;
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dLat = pts[i].lat - latlng.lat;
    const dLon = (pts[i].lon - latlng.lng) * Math.cos(latlng.lat * Math.PI / 180);
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  updateBoatsToRaceTime(pts[bestI].t);
}

// ---------- Shareable URL deep links ----------
// ?day=YYYY-MM-DD&race=R1&t=12:30  →  open straight to that race + time.
function syncUrlState() {
  if (!activeDayKey) return;
  const params = new URLSearchParams();
  params.set("day", activeDayKey);
  if (activeRaceFilter) params.set("race", activeRaceFilter);
  if (raceTime != null && raceStart != null && raceTime > raceStart) {
    params.set("t", new Date(raceTime * 1000).toISOString().slice(11, 19));
  }
  if (speedMult !== 10) params.set("speed", String(speedMult));
  history.replaceState(null, "", "?" + params.toString());
}

async function applyUrlStateOnLoad() {
  const params = new URLSearchParams(location.search);
  const day = params.get("day");
  if (!day || !window.RECORDS) return;
  // Wait for the day list to be populated.
  await new Promise((r) => setTimeout(r, 100));
  if (!days.has(day)) return;
  await selectDay(day);
  const race = params.get("race");
  if (race) {
    activeRaceFilter = race;
    renderRaceTabs();
    applyRaceFilter();
    const r = (window.RACES?.[day] || []).find((x) => x.name === race);
    if (r) renderScoreboard(r, MY_BOAT.sail);
  }
  const t = params.get("t");
  if (t) {
    const [h, m, s] = t.split(":").map(Number);
    const wallSec = Date.parse(`${day}T${t}+08:00`) / 1000;
    if (wallSec >= raceStart && wallSec <= raceEnd) {
      updateBoatsToRaceTime(wallSec);
    }
  }
  const sp = params.get("speed");
  if (sp && SPEEDS.includes(Number(sp))) {
    speedMult = Number(sp);
    pbSpeed.value = sp;
  }
}
// Run after autoLoadFromManifest fills the days map.
setTimeout(applyUrlStateOnLoad, 200);

// Export buttons in the race-stats panel.
document.getElementById("exportGpxBtn")?.addEventListener("click", () => {
  if (selectedTrackId == null) return;
  const t = tracks[selectedTrackId];
  downloadBlob(`${t.name.replace(/[^\w]+/g, "_")}.gpx`, "application/gpx+xml", trackToGPX(t));
});
document.getElementById("exportReportBtn")?.addEventListener("click", () => {
  if (selectedTrackId == null) return;
  openRaceReport(tracks[selectedTrackId]);
});
document.getElementById("copyLinkBtn")?.addEventListener("click", () => {
  syncUrlState();
  navigator.clipboard?.writeText(location.href).then(() => {
    const b = document.getElementById("copyLinkBtn");
    const old = b.textContent;
    b.textContent = "Copied!";
    setTimeout(() => (b.textContent = old), 1200);
  });
});

// Ghost boats: wired off by default, exposed via a small toggle.
// (Lives in the race-stats panel for now.)
const exportRow = document.getElementById("rsExport");
if (exportRow) {
  const lbl = document.createElement("label");
  lbl.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#b6c6d6;margin-left:6px;cursor:pointer;";
  lbl.innerHTML = `<input type="checkbox" id="ghostsToggle" style="accent-color:#6ea8ff;"> Ghost fleet`;
  exportRow.appendChild(lbl);
  document.getElementById("ghostsToggle").addEventListener("change", (e) => {
    ghostsEnabled = e.target.checked;
    if (selectedTrackId != null) setupGhostsForTrack(tracks[selectedTrackId]);
  });
}

// ---------- File loading (race-aware) ----------
// loadFileAsPoints just parses VTK to {boat, points}; the caller decides
// how to slice into per-race tracks.
// ---------- GPX / TCX parser ----------
// Garmin Connect and many watches export GPS tracks as GPX. Structure is
// plain XML: <trkpt lat="…" lon="…"><time>…</time></trkpt>. Speed and
// heading aren't usually included, so we compute them from consecutive
// samples (works well at 1 Hz which is the typical Garmin rate).
function parseGPX(text) {
  const points = [];
  const trkptRe = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>[\s\S]*?<\/trkpt>/g;
  let m;
  while ((m = trkptRe.exec(text))) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    const t = Date.parse(m[3]) / 1000;
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) continue;
    points.push({ t, lat, lon, sog: 0, cog: 0 });
  }
  if (points.length < 2) return { points, buttons: [] };
  // Fill sog (knots) + cog (degrees) from adjacent samples.
  const MPS_TO_KN = 1.943844;
  for (let i = 0; i < points.length; i++) {
    const a = i === 0 ? points[0] : points[i - 1];
    const b = i === points.length - 1 ? points[points.length - 1] : points[i + 1];
    const dLat = (b.lat - a.lat) * 111_320;
    const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    const dt = Math.max(0.01, b.t - a.t);
    points[i].sog = (dist / dt) * MPS_TO_KN;
    points[i].cog = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360;
  }
  return { points, buttons: [] };
}

// TCX (Garmin Training Center) is similar XML with <Trackpoint> wrapping
// <Time>, <Position><LatitudeDegrees/LongitudeDegrees>, and sometimes
// <Extensions> carrying speed. Same post-processing for sog/cog.
function parseTCX(text) {
  const points = [];
  const pointRe = /<Trackpoint>[\s\S]*?<Time>([^<]+)<\/Time>[\s\S]*?<LatitudeDegrees>([-\d.]+)<\/LatitudeDegrees>[\s\S]*?<LongitudeDegrees>([-\d.]+)<\/LongitudeDegrees>[\s\S]*?<\/Trackpoint>/g;
  let m;
  while ((m = pointRe.exec(text))) {
    const t = Date.parse(m[1]) / 1000;
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) continue;
    points.push({ t, lat, lon, sog: 0, cog: 0 });
  }
  // Same sog/cog fill as parseGPX — no duplication for brevity; reuse:
  if (points.length < 2) return { points, buttons: [] };
  const MPS_TO_KN = 1.943844;
  for (let i = 0; i < points.length; i++) {
    const a = i === 0 ? points[0] : points[i - 1];
    const b = i === points.length - 1 ? points[points.length - 1] : points[i + 1];
    const dLat = (b.lat - a.lat) * 111_320;
    const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    const dt = Math.max(0.01, b.t - a.t);
    points[i].sog = (dist / dt) * MPS_TO_KN;
    points[i].cog = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360;
  }
  return { points, buttons: [] };
}

// Vakaros (and similar) CSV export. Header form:
//   timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim
// Native heel + trim → no quaternion conversion needed.
function parseVakarosCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { points: [], buttons: [] };
  const header = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const idx = (n) => header.indexOf(n);
  const iT = idx("timestamp");
  const iLat = idx("latitude");
  const iLon = idx("longitude");
  const iSog = idx("sog_kts") >= 0 ? idx("sog_kts") : idx("sog");
  const iCog = idx("cog");
  const iHdg = idx("hdg_true") >= 0 ? idx("hdg_true") : idx("heading");
  const iHeel = idx("heel");
  const iTrim = idx("trim") >= 0 ? idx("trim") : idx("pitch");
  if (iT < 0 || iLat < 0 || iLon < 0) {
    throw new Error("CSV missing timestamp/latitude/longitude columns");
  }
  const points = [];
  for (let row = 1; row < lines.length; row++) {
    const line = lines[row];
    if (!line) continue;
    const cols = line.split(",");
    const t = Date.parse(cols[iT]) / 1000;
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) continue;
    const p = { t, lat, lon };
    p.sog = iSog >= 0 ? Number(cols[iSog]) : 0;
    p.cog = iCog >= 0 ? Number(cols[iCog]) : 0;
    if (iHdg >= 0) {
      const h = Number(cols[iHdg]);
      if (isFinite(h)) p.hdg = h;
    }
    if (iHeel >= 0) {
      const h = Number(cols[iHeel]);
      if (isFinite(h)) p.heel = h;
    }
    if (iTrim >= 0) {
      const p2 = Number(cols[iTrim]);
      if (isFinite(p2)) p.pitch = p2;
    }
    points.push(p);
  }
  return { points, buttons: [] };
}

// Dispatch by file extension.
function parseTrackFile(name, bytes) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "vtk") return parseVTK(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  if (ext === "gpx") return parseGPX(text);
  if (ext === "tcx") return parseTCX(text);
  if (ext === "csv") return parseVakarosCSV(text);
  throw new Error(`Unsupported file format: .${ext}`);
}

// ---------- IndexedDB cache for parsed VTKs ----------
// Re-parsing 70 MB of protobuf on every day-switch is wasteful. Cache the
// parsed { points, buttons } per file URL + size so repeat loads are
// effectively instant.
const VTK_DB_NAME = "sailing-tracks";
const VTK_STORE = "vtk-parsed";
let _vtkDb = null;
function vtkDb() {
  if (_vtkDb) return _vtkDb;
  _vtkDb = new Promise((resolve, reject) => {
    const req = indexedDB.open(VTK_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VTK_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _vtkDb;
}
async function vtkCacheGet(key) {
  try {
    const db = await vtkDb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(VTK_STORE, "readonly");
      const r = tx.objectStore(VTK_STORE).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
}
async function vtkCachePut(key, value) {
  try {
    const db = await vtkDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(VTK_STORE, "readwrite");
      const r = tx.objectStore(VTK_STORE).put(value, key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  } catch { /* ignore — cache is best-effort */ }
}

async function loadFileAsPoints(file) {
  const rel = file.webkitRelativePath || file.name;
  const parts = rel.split(/[\\/]/);
  const boat = parts[parts.length - 3] || "Boat";

  // Try cache first — keyed by URL+size when available.
  const cacheKey = file.url ? `${file.url}#?` : `local:${rel}`;
  const cached = await vtkCacheGet(cacheKey);
  if (cached && cached.boat === boat) {
    return { boat, points: cached.points, buttons: cached.buttons, rel };
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const { points, buttons } = parseTrackFile(file.name, buf);
  vtkCachePut(cacheKey, { boat, points, buttons, savedAt: Date.now() });
  return { boat, points, buttons, rel };
}

// A "day" groups the files under one YYYY-MM-DD folder.
const days = new Map(); // key "YYYY-MM-DD" -> File[]
const daysEl = document.getElementById("daysPicker");
let activeDayKey = null;
daysEl.addEventListener("change", () => {
  if (daysEl.value) selectDay(daysEl.value);
});

function dayKeyFor(file) {
  const rel = file.webkitRelativePath || file.name;
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  }
  return null;
}

// Also extend the VTK filter on the client side — accept GPX / TCX too.
// indexFiles checks file.name regex so add a permissive pattern.

function isRaceDay(key) {
  return !!(window.RACES && window.RACES[key] && window.RACES[key].length);
}

function renderDayList() {
  // Only show days that are BOTH (a) on a race calendar and (b) have VTK
  // recordings — practice days are hidden, fleet race days with no recording
  // are too (until someone uploads a track for them).
  const keys = [...days.keys()].filter(isRaceDay).sort().reverse();
  daysEl.innerHTML = `<option value="">— pick a race day (${keys.length}) —</option>` +
    keys.map((k) => {
      const n = window.RACES[k].length;
      return `<option value="${k}">${k} · ${n} race${n > 1 ? "s" : ""}</option>`;
    }).join("");
  daysEl.value = activeDayKey || "";
  if (keys.length) {
    statusEl.textContent = `${keys.length} race day(s) — pick one`;
  } else {
    statusEl.textContent = "No race days with recordings yet.";
  }
}

// Build [start, end] windows in Unix seconds for each race on `date`,
// resolving overlaps between adjacent races (e.g. R2 starts 5 min after
// R1's last finisher → 15-min pads can collide).
function raceWindowsFor(date) {
  const races = (window.RACES?.[date] || []).slice()
    .sort((a, b) => a.start.localeCompare(b.start));
  // Pre-race pad: 8 min — covers the start sequence (warning + prep gun).
  // Post-race pad: 15 min — gives time after the last finisher to coast back.
  const PRE_PAD = 8 * 60;
  const POST_PAD = 15 * 60;
  const windows = races.map((r) => {
    const startSec = Date.parse(r.start) / 1000;
    const endSec = r.end ? Date.parse(r.end) / 1000 : startSec + 60 * 60;
    return {
      race: r,
      actualStart: startSec,
      actualEnd: endSec,
      windowStart: startSec - PRE_PAD,
      windowEnd: endSec + POST_PAD,
    };
  });
  // Resolve overlaps: if A.windowEnd > B.windowStart, split at the midpoint
  // between A.actualEnd and B.actualStart.
  for (let i = 0; i + 1 < windows.length; i++) {
    const a = windows[i], b = windows[i + 1];
    if (a.windowEnd > b.windowStart) {
      const mid = (a.actualEnd + b.actualStart) / 2;
      a.windowEnd = mid;
      b.windowStart = mid;
    }
  }
  return windows;
}

async function selectDay(key) {
  if (activeDayKey === key) return;
  clearTracks();
  activeDayKey = key;
  renderDayList();
  renderWindForDay(key);
  renderWindBarb(key);
  // Refresh wind-station markers to reflect the new day BEFORE any tracks
  // load — otherwise yesterday's arrows linger on the map until the first
  // boat rendering triggers updateBoatsToRaceTime → updateWindMap.
  updateWindMap();
  renderWindGrid();

  const files = days.get(key) || [];
  files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  statusEl.textContent = `Loading ${files.length} session(s) from ${key}…`;

  // Parse all VTKs for this day → grouped by boat.
  const byBoat = new Map(); // boat -> { points: [], buttons: [] }
  for (const f of files) {
    try {
      const { boat, points, buttons } = await loadFileAsPoints(f);
      if (!byBoat.has(boat)) byBoat.set(boat, { points: [], buttons: [] });
      const slot = byBoat.get(boat);
      slot.points.push(...points);
      slot.buttons.push(...buttons);
    } catch (e) {
      console.error(`Failed to read ${f.name}:`, e);
    }
  }
  // Sort each boat's data by time.
  for (const slot of byBoat.values()) {
    slot.points.sort((a, b) => a.t - b.t);
    slot.buttons.sort((a, b) => a.t - b.t);
  }

  // Carve into per-race tracks.
  const windows = raceWindowsFor(key);
  // Per-boat, compute the start-line for each race window, carrying the
  // committee boat's anchor across races until/unless re-pinged.
  const startLinesByBoat = new Map();
  for (const [boat, slot] of byBoat) {
    startLinesByBoat.set(
      boat,
      startLinesForDay(slot.buttons, windows.map((w) => w.actualStart)),
    );
  }
  // Race-level start line — the start line is a physical thing in the
  // water, the same for every boat. So if ANY boat in this day pinged
  // it, share that line with every other boat for the same race.
  const sharedStartLines = windows.map((_, wi) => {
    let rc = null, pin = null;
    for (const lines of startLinesByBoat.values()) {
      const sm = lines[wi];
      if (sm?.rc && !rc) rc = sm.rc;
      if (sm?.pin && !pin) pin = sm.pin;
      if (rc && pin) break;
    }
    return (rc || pin) ? { rc, pin } : null;
  });
  let added = 0;
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    for (const [boat, slot] of byBoat) {
      const slice = sliceByTime(slot.points, w.windowStart, w.windowEnd);
      if (slice.length < 2) continue;
      const myFin = w.race.finishers.find((f) => f.sail === MY_BOAT.sail);
      const myDnx = w.race.dnc.find((x) => x.sail === MY_BOAT.sail);
      const tag = boat === MY_BOAT.name
        ? (myFin ? `P${myFin.place}` : (myDnx ? myDnx.status : "-"))
        : "";
      const name = `${w.race.name}${w.race.title ? " " + w.race.title : ""} · ${boat}${tag ? " (" + tag + ")" : ""}`;
      // Prefer this boat's own ping if it has one (most accurate for
      // its skipper), else fall back to the shared race-level line.
      const startMarks = startLinesByBoat.get(boat)[wi] || sharedStartLines[wi];
      addTrack(name, slice, { race: w.race, boat, window: w, startMarks });
      added++;
    }
  }

  renderRaceTabs();

  // Compute marks per race using ALL boats' tracks combined, then render
  // them on the map. Marks persist while their race is visible.
  computeRaceMarksForDay();
  renderRaceMarksOnMap(); renderFinishLineOnMap(); refresh3DScene();

  // Default the scoreboard to the first race of the day so opening a day
  // immediately shows results alongside the track(s).
  const firstRace = (window.RACES?.[key] || [])[0];
  if (firstRace) renderScoreboard(firstRace, MY_BOAT.sail);

  const haveWind = window.WIND_DAILY && window.WIND_DAILY[key];
  statusEl.textContent = `${key}: ${added} race-track(s)`
    + (haveWind ? "" : " · no wind data");
}

// ---------- Race analytics ----------
// Convert lat/lon distance to metres (small-angle equirectangular — fine
// at HK scale, accurate to ~1 cm over a few km).
function metres(a, b) {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// Signed perpendicular distance from point P to line AB (in metres).
function distanceToLine(p, a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat0 * Math.PI / 180);
  const ax = a.lon * mLon, ay = a.lat * mLat;
  const bx = b.lon * mLon, by = b.lat * mLat;
  const px = p.lon * mLon, py = p.lat * mLat;
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return metres(p, a);
  return ((px - ax) * dy - (py - ay) * dx) / len;
}

// J/80 polar (typical class polar table — TWS in kn, TWA in deg → SOG in kn).
const J80_POLAR_TWS = [6, 8, 10, 12, 14, 16, 20];
const J80_POLAR_TWA = {
   36: [3.7, 4.4, 4.9, 5.2, 5.4, 5.5, 5.6],
   45: [4.5, 5.2, 5.7, 6.0, 6.2, 6.3, 6.4],
   52: [4.8, 5.5, 5.9, 6.2, 6.3, 6.4, 6.5],
   60: [5.0, 5.8, 6.2, 6.4, 6.5, 6.6, 6.7],
   75: [5.3, 6.0, 6.4, 6.6, 6.7, 6.8, 7.0],
   90: [5.4, 6.2, 6.6, 6.8, 7.0, 7.1, 7.4],
  110: [5.0, 6.0, 6.6, 7.0, 7.3, 7.5, 7.9],
  135: [3.8, 5.0, 6.0, 6.7, 7.1, 7.4, 7.8],
  150: [3.0, 4.2, 5.3, 6.1, 6.6, 7.0, 7.5],
  180: [2.5, 3.5, 4.4, 5.1, 5.6, 6.0, 6.6],
};
function polarSpeed(twsKn, twaDeg) {
  const a = Math.abs(twaDeg);
  const angles = Object.keys(J80_POLAR_TWA).map(Number).sort((x, y) => x - y);
  let aLo = angles[0], aHi = angles[angles.length - 1];
  for (let i = 0; i + 1 < angles.length; i++)
    if (a >= angles[i] && a <= angles[i + 1]) { aLo = angles[i]; aHi = angles[i + 1]; break; }
  const fA = aHi === aLo ? 0 : (a - aLo) / (aHi - aLo);
  let sLo = J80_POLAR_TWS[0], sHi = J80_POLAR_TWS[J80_POLAR_TWS.length - 1];
  for (let i = 0; i + 1 < J80_POLAR_TWS.length; i++)
    if (twsKn >= J80_POLAR_TWS[i] && twsKn <= J80_POLAR_TWS[i + 1])
      { sLo = J80_POLAR_TWS[i]; sHi = J80_POLAR_TWS[i + 1]; break; }
  const fS = sHi === sLo ? 0 : (twsKn - sLo) / (sHi - sLo);
  const lerp = (lo, hi) => lo + (hi - lo) * fS;
  const r1 = lerp(J80_POLAR_TWA[aLo][J80_POLAR_TWS.indexOf(sLo)],
                  J80_POLAR_TWA[aLo][J80_POLAR_TWS.indexOf(sHi)]);
  const r2 = lerp(J80_POLAR_TWA[aHi][J80_POLAR_TWS.indexOf(sLo)],
                  J80_POLAR_TWA[aHi][J80_POLAR_TWS.indexOf(sHi)]);
  return r1 + (r2 - r1) * fA;
}

// Detect tacks and gybes, with per-maneuver telemetry (entry/min/exit
// speed, recovery time to 90% of entry SOG, heel before vs during).
function detectTacksGybes(points, windDeg) {
  const n = points.length;
  if (n < 12) return { tacks: [], gybes: [] };
  // Smooth COG with a 5-point circular average.
  const cog = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      const r = points[j].cog * Math.PI / 180;
      sx += Math.sin(r); sy += Math.cos(r); c++;
    }
    cog[i] = (Math.atan2(sx / c, sy / c) * 180 / Math.PI + 360) % 360;
  }

  // Helper: average SOG / heel over a sample window centered around index i.
  const avg = (i, windowSec, key) => {
    const t0 = points[i].t - windowSec, t1 = points[i].t + windowSec;
    let s = 0, c = 0;
    for (const p of points) {
      if (p.t < t0) continue;
      if (p.t > t1) break;
      const v = p[key];
      if (typeof v === "number") { s += v; c++; }
    }
    return c ? s / c : null;
  };

  const enrich = (i, angle) => {
    // Look back ~30 sec for entry SOG / heel.
    const entrySog = avg(i, -30) ?? points[i].sog;
    // Actually use a directional avg — last 30s before, next 30s after:
    const t = points[i].t;
    const range = (a, b, key) => {
      let s = 0, c = 0;
      for (const p of points) {
        if (p.t < t + a) continue;
        if (p.t > t + b) break;
        const v = p[key];
        if (typeof v === "number") { s += v; c++; }
      }
      return c ? s / c : null;
    };
    const entry = range(-30, -5, "sog") ?? points[i].sog;
    const exit = range(5, 30, "sog") ?? points[i].sog;
    // Find local SOG minimum within ±15s of the maneuver center.
    let minSog = Infinity, minIdx = i;
    for (const p of points) {
      if (p.t < t - 15) continue;
      if (p.t > t + 15) break;
      if (p.sog < minSog) { minSog = p.sog; minIdx = points.indexOf(p); }
    }
    // Recovery: time after the minimum until SOG ≥ 90% of entry.
    const target = entry * 0.9;
    let recoveryT = null;
    for (let j = minIdx; j < points.length && points[j].t < t + 60; j++) {
      if (points[j].sog >= target) { recoveryT = points[j].t - points[minIdx].t; break; }
    }
    const heelBefore = range(-30, -5, "heel");
    const heelAfter = range(5, 30, "heel");
    return {
      t, lat: points[i].lat, lon: points[i].lon, angle,
      entrySog: entry, minSog, exitSog: exit, recoverySec: recoveryT,
      lostKn: Math.max(0, entry - exit),
      heelBefore, heelAfter,
    };
  };

  const tacks = [], gybes = [];
  let lastT = 0;
  for (let i = 5; i < n - 5; i++) {
    let delta = cog[i + 5] - cog[i - 5];
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    if (Math.abs(delta) < 60) continue;
    if (points[i].t - lastT < 8) continue;
    const ev = enrich(i, Math.abs(delta));
    if (windDeg != null) {
      let twa = cog[i - 5] - windDeg;
      while (twa > 180) twa -= 360;
      while (twa < -180) twa += 360;
      (Math.abs(twa) < 90 ? tacks : gybes).push(ev);
    } else {
      tacks.push(ev);
    }
    lastT = points[i].t;
  }
  return { tacks, gybes };
}

// Split points into legs at each mark rounding. Returns:
//   [{ name, tStart, tEnd, points, type: "beat"|"run"|"reach"|"transit",
//      distM, durationSec, avgSog, vmg, polarRatio, tacks, gybes }]
function buildLegs(points, marks, windDeg, polarFn, tacks, gybes) {
  if (!points.length) return [];
  const splits = [points[0].t, ...marks.map((m) => m.t), points[points.length - 1].t];
  const legs = [];
  for (let i = 0; i + 1 < splits.length; i++) {
    const t0 = splits[i], t1 = splits[i + 1];
    const slice = points.filter((p) => p.t >= t0 && p.t <= t1);
    if (slice.length < 5) continue;
    let dist = 0;
    for (let j = 1; j < slice.length; j++) {
      const a = slice[j - 1], b = slice[j];
      const dLat = (b.lat - a.lat) * 111_320;
      const dLon = (b.lon - a.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      dist += Math.sqrt(dLat * dLat + dLon * dLon);
    }
    const duration = t1 - t0;
    const avgSog = slice.reduce((s, p) => s + p.sog, 0) / slice.length;
    // Average TWA over the leg → classify upwind/downwind/reach.
    let twaSum = 0, twaN = 0;
    if (windDeg != null) {
      for (const p of slice) {
        let twa = p.cog - windDeg;
        while (twa > 180) twa -= 360;
        while (twa < -180) twa += 360;
        twaSum += Math.abs(twa); twaN++;
      }
    }
    const avgTwa = twaN ? twaSum / twaN : null;
    let type = "transit";
    if (avgTwa != null) {
      if (avgTwa < 70) type = "beat";
      else if (avgTwa > 110) type = "run";
      else type = "reach";
    }
    let vmgSum = 0, vmgN = 0, polarSum = 0, polarN = 0;
    if (windDeg != null && polarFn) {
      for (const p of slice) {
        let twa = p.cog - windDeg;
        while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
        const vmg = p.sog * Math.cos(twa * Math.PI / 180);
        vmgSum += Math.abs(vmg); vmgN++;
        const target = polarFn(p.sog, twa); // not used; need wind speed
      }
    }
    const tacksHere = tacks.filter((m) => m.t >= t0 && m.t <= t1).length;
    const gybesHere = gybes.filter((m) => m.t >= t0 && m.t <= t1).length;
    legs.push({
      name: `Leg ${i + 1}`,
      type,
      tStart: t0, tEnd: t1,
      distM: dist,
      durationSec: duration,
      avgSog,
      avgTwa,
      vmg: vmgN ? vmgSum / vmgN : null,
      tacks: tacksHere,
      gybes: gybesHere,
    });
  }
  return legs;
}

// Polar plot data: bin (TWA, SOG) pairs across the race.
//   binsByTwa: { 30: { count, avgSog, maxSog }, 45: …, … }
function polarPlotData(points, windAtBoatFn) {
  const bins = {};
  for (const t of [30, 45, 60, 75, 90, 110, 135, 150, 180]) {
    bins[t] = { port: { count: 0, sumSog: 0, maxSog: 0 },
                stbd: { count: 0, sumSog: 0, maxSog: 0 } };
  }
  if (!windAtBoatFn) return bins;
  const angles = Object.keys(bins).map(Number);
  for (let i = 0; i < points.length; i += 4) {
    const p = points[i];
    const w = windAtBoatFn(p.t, p.lat, p.lon);
    if (!w || w.deg == null) continue;
    let twa = p.cog - w.deg;
    while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
    const side = twa < 0 ? "port" : "stbd";
    const aTwa = Math.abs(twa);
    let nearest = angles[0];
    for (const a of angles) if (Math.abs(a - aTwa) < Math.abs(nearest - aTwa)) nearest = a;
    const bin = bins[nearest][side];
    bin.count++; bin.sumSog += p.sog;
    if (p.sog > bin.maxSog) bin.maxSog = p.sog;
  }
  return bins;
}

// Compare two boats in the same race window. For each ~5-second bin,
// compute boat A's distance from a chosen reference (the first mark or
// the start) and find when boat B reached that same distance. The gap is
// (t_B − t_A) seconds, positive = A ahead.
function timeGapSeries(trackA, trackB, refLatLng) {
  const t0 = Math.max(trackA.tStart, trackB.tStart);
  const t1 = Math.min(trackA.tEnd, trackB.tEnd);
  if (t1 <= t0) return [];
  const distFromRef = (p) => {
    const dLat = (p.lat - refLatLng.lat) * 111_320;
    const dLon = (p.lon - refLatLng.lon) * 111_320 * Math.cos(p.lat * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  };
  const sampledA = [], sampledB = [];
  for (let t = t0; t <= t1; t += 5) {
    sampledA.push({ t, d: distFromRef(sampleAt(trackA, t)) });
    sampledB.push({ t, d: distFromRef(sampleAt(trackB, t)) });
  }
  // For each A point, find the latest B sample with d ≤ A's d (B reaches same distance).
  const out = [];
  for (const a of sampledA) {
    let bMatchT = null;
    for (let j = sampledB.length - 1; j >= 0; j--) {
      if (sampledB[j].d <= a.d) { bMatchT = sampledB[j].t; break; }
    }
    if (bMatchT == null) continue;
    out.push({ t: a.t, gap: bMatchT - a.t });
  }
  return out;
}

// Detect mark roundings on RHKYC geometric courses (windward-leeward).
// Skips Passage races (point-to-point — no marks).
//
// Wind-aware logic per fleet domain knowledge:
//   • The start line is perpendicular to the wind, first leg is upwind.
//   • The boat sails INTO the wind (TWA < 90°) on the beat, then ROUNDS
//     the windward mark and sails AWAY from the wind (TWA > 90°).
//   • The leeward mark is the reverse transition: downwind → upwind.
//   • Always rounded to port — the mark sits on the inside of the curve.
//
// We classify each point by its True Wind Angle (TWA) and look for the
// moment the smoothed TWA crosses 90°. Each crossing is one rounding.
// A 2-lap W-L course produces 4 events: W, L, W, L; clusterMarks() then
// merges them into 2 unique marker pins.
//
// Falls back to the old heading-reversal detector when wind data is
// missing (so old race days without HKO snapshots still get a best-effort
// mark guess).
function detectMarkRoundings(points, raceStartSec, raceEndSec, windDeg, raceTitle) {
  if (raceTitle && /passage/i.test(raceTitle)) return [];   // not geometric
  if (points.length < 30) return [];
  if (windDeg == null) return detectMarkRoundingsLegacy(points, raceStartSec, raceEndSec);

  // |TWA| per point — 0 means dead upwind, 180 means dead downwind.
  const twa = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    let a = points[i].cog - windDeg;
    while (a > 180) a -= 360;
    while (a < -180) a += 360;
    twa[i] = Math.abs(a);
  }
  // Rolling 30-sec average TWA so a single tack doesn't look like a leg
  // change. Two-pointer sliding window.
  const SMOOTH = 30;
  const smoothed = new Array(points.length);
  let lo = 0, sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += twa[i];
    while (points[lo].t < points[i].t - SMOOTH) { sum -= twa[lo++]; }
    smoothed[i] = sum / (i - lo + 1);
  }

  // Walk and find transitions where smoothed TWA crosses 90°.
  // Two stricter checks vs the naive "any single crossing" approach:
  //   * CONFIRM the new state holds for ≥ 60 s of subsequent samples —
  //     drops tactical wobbles that briefly look like leg flips.
  //   * DEEP CROSSING — the new state must reach ≥ 50° away from the 90°
  //     line (i.e. truly upwind/downwind, not just a reach segment).
  const tStart = raceStartSec ?? points[0].t;
  const tEnd = raceEndSec ?? points[points.length - 1].t;
  const MIN_GAP = 90;
  const CONFIRM_SEC = 60;
  const DEEP_SWING_DEG = 50;
  const out = [];
  let lastEvent = -Infinity;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t < tStart) continue;
    if (points[i].t > tEnd) break;
    if (points[i].t - lastEvent < MIN_GAP) continue;
    const prev = smoothed[i - 1], curr = smoothed[i];
    if ((prev < 90) === (curr < 90)) continue;     // not a crossing
    // Stickiness test — does the new state hold? And does it go DEEP?
    const newUp = curr < 90;
    let stable = true, peak = 0;
    for (let j = i + 1; j < points.length; j++) {
      if (points[j].t > points[i].t + CONFIRM_SEC) break;
      if ((smoothed[j] < 90) !== newUp) { stable = false; break; }
      const dev = newUp ? (90 - smoothed[j]) : (smoothed[j] - 90);
      if (dev > peak) peak = dev;
    }
    if (!stable) continue;
    if (peak < DEEP_SWING_DEG) continue;
    const isWindward = prev < 90;                  // upwind to downwind = W mark
    // Refine the rounding position: average GPS over ±10 s around the
    // crossing, plus a 5 m port-side nudge for the mark's inside-of-curve.
    const cT = points[i].t;
    let cLat = 0, cLon = 0, n = 0, bestSog = Infinity, bestP = points[i];
    for (const p of points) {
      if (p.t < cT - 10) continue;
      if (p.t > cT + 10) break;
      cLat += p.lat; cLon += p.lon; n++;
      if (p.sog < bestSog) { bestSog = p.sog; bestP = p; }
    }
    if (n < 4) continue;
    cLat /= n; cLon /= n;
    const cogRad = bestP.cog * Math.PI / 180;
    const dLatPort = -Math.cos(cogRad) * 5 / 111_320;
    const dLonPort = Math.sin(cogRad) * 5 / (111_320 * Math.cos(cLat * Math.PI / 180));
    out.push({
      t: bestP.t,
      lat: cLat + dLatPort,
      lon: cLon + dLonPort,
      angle: Math.abs(curr - prev) * 2,            // "swing" in TWA terms
      isWindward,                                  // drives W/L labelling later
      bearingBefore: 0, bearingAfter: 0,
    });
    lastEvent = cT;
  }
  return out;
}

// Legacy heading-reversal detector — used only when wind direction is
// unavailable for the race (no HKO snapshots for that day).
function detectMarkRoundingsLegacy(points, raceStartSec, raceEndSec) {
  if (points.length < 30) return [];
  const WINDOW_SEC = 90, MIN_REVERSAL_DEG = 155, MIN_GAP_SEC = 180;
  function meanCog(tFrom, tTo) {
    let sx = 0, sy = 0, c = 0;
    for (const p of points) {
      if (p.t < tFrom) continue;
      if (p.t > tTo) break;
      const r = p.cog * Math.PI / 180;
      sx += Math.sin(r); sy += Math.cos(r); c++;
    }
    if (c === 0) return null;
    return (Math.atan2(sx / c, sy / c) * 180 / Math.PI + 360) % 360;
  }
  const out = [];
  let lastT = 0;
  const tStart = Math.max(points[0].t + WINDOW_SEC, raceStartSec ?? -Infinity);
  const tEnd = Math.min(points[points.length - 1].t - WINDOW_SEC, raceEndSec ?? Infinity);
  for (let t = tStart; t <= tEnd; t += 5) {
    if (t - lastT < MIN_GAP_SEC) continue;
    const before = meanCog(t - WINDOW_SEC, t - 5);
    const after = meanCog(t + 5, t + WINDOW_SEC);
    if (before == null || after == null) continue;
    let delta = after - before;
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    if (Math.abs(delta) < MIN_REVERSAL_DEG) continue;
    const turnPoints = points.filter((p) => p.t >= t - 15 && p.t <= t + 15);
    if (turnPoints.length < 4) continue;
    let cLat = 0, cLon = 0, bestSog = Infinity, bestP = turnPoints[0];
    for (const p of turnPoints) {
      cLat += p.lat; cLon += p.lon;
      if (p.sog < bestSog) { bestSog = p.sog; bestP = p; }
    }
    cLat /= turnPoints.length; cLon /= turnPoints.length;
    const cogRad = bestP.cog * Math.PI / 180;
    const dLatPort = -Math.cos(cogRad) * 5 / 111_320;
    const dLonPort = Math.sin(cogRad) * 5 / (111_320 * Math.cos(cLat * Math.PI / 180));
    out.push({
      t: bestP.t,
      lat: cLat + dLatPort,
      lon: cLon + dLonPort,
      angle: Math.abs(delta),
      bearingBefore: before, bearingAfter: after,
    });
    lastT = t;
  }
  return out;
}

// Cluster rounding events into unique physical marks. Two roundings within
// `radius` metres of each other are the same mark; their positions average.
// Returns [{ lat, lon, label, rounded: [eventIndex, …] }].
function clusterMarks(events, windDeg, radius = 120) {
  if (!events.length) return [];
  const dist = (a, b) => {
    const dLat = (a.lat - b.lat) * 111_320;
    const dLon = (a.lon - b.lon) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  };
  // Start with one cluster per event.
  let clusters = events.map((e, i) => ({
    lat: e.lat, lon: e.lon, rounded: [i], label: "",
  }));
  // Iteratively merge the closest pair while it's within `radius`.
  // Hierarchical agglomerative — guarantees borderline pairs collapse
  // even when scanned in unfortunate order.
  while (clusters.length > 1) {
    let bestI = -1, bestJ = -1, bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist(clusters[i], clusters[j]);
        if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
      }
    }
    if (bestD > radius) break;
    const a = clusters[bestI], b = clusters[bestJ];
    const total = a.rounded.length + b.rounded.length;
    a.lat = (a.lat * a.rounded.length + b.lat * b.rounded.length) / total;
    a.lon = (a.lon * a.rounded.length + b.lon * b.rounded.length) / total;
    a.rounded = [...a.rounded, ...b.rounded];
    clusters.splice(bestJ, 1);
  }
  // Label W vs L. Prefer the wind-aware `isWindward` flag set by the
  // wind-relative detector; fall back to bearing-based check for legacy
  // events (no wind data).
  for (const c of clusters) {
    const firstEv = events[c.rounded[0]];
    if (firstEv.isWindward != null) {
      c.label = firstEv.isWindward ? "W" : "L";
    } else if (windDeg != null && firstEv.bearingBefore != null) {
      let twa = firstEv.bearingBefore - windDeg;
      while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
      c.label = Math.abs(twa) < 90 ? "W" : "L";
    } else {
      c.label = `M${clusters.indexOf(c) + 1}`;
    }
  }
  // The detector itself already enforces strong evidence per rounding
  // (smoothed TWA crosses 90°, state holds for ≥60 s, TWA reaches ≥50°
  // away from 90°), so we don't need an extra consensus filter on top.
  // Multi-boat / multi-lap data still helps centroid accuracy, but a
  // single solid rounding is sufficient to display a mark.
  const supported = clusters;

  // If two surviving clusters got the same W/L label, suffix them with a
  // counter (rare — happens when a course has two windward marks).
  const counts = {};
  for (const c of supported) counts[c.label] = (counts[c.label] || 0) + 1;
  const seen = {};
  for (const c of supported) {
    if (counts[c.label] > 1) {
      seen[c.label] = (seen[c.label] || 0) + 1;
      c.label = `${c.label}${seen[c.label]}`;
    }
  }
  return supported;
}

// Sanity check on the printed J/80 Start time. Each finisher reports its
// own finish + elapsed; subtracting gives an implied start for that boat.
// If every boat agrees on the same implied start, that's the truth — and
// it should match the printed start to the second. Discrepancies usually
// mean the PDF printout was rounded or pulled from the postponed time.
//
// Returns { stated: "HH:MM:SS", implied: "HH:MM:SS" or null,
//           impliedSecondsOfDay: number, deltaSec: number, agreement: 0..1 }
// where agreement = fraction of finishers that share the median implied start.
function impliedStartCheck(race) {
  const out = { stated: null, implied: null, impliedSecondsOfDay: null,
                deltaSec: null, agreement: 0, n: 0 };
  if (!race) return out;
  const stated = race.startH * 3600 + race.startM * 60;
  out.stated = `${String(race.startH).padStart(2,"0")}:${String(race.startM).padStart(2,"0")}:00`;
  const parts = (s) => s.split(":").map(Number);
  const implied = [];
  for (const f of race.finishers || []) {
    const [fh, fm, fs] = parts(f.finish);
    const [eh, em, es] = parts(f.elapsed);
    const fSec = fh * 3600 + fm * 60 + fs;
    const eSec = eh * 3600 + em * 60 + es;
    if (eSec <= 0) continue;
    implied.push(fSec - eSec);
  }
  if (!implied.length) return out;
  implied.sort((a, b) => a - b);
  const median = implied[Math.floor(implied.length / 2)];
  const matching = implied.filter((s) => Math.abs(s - median) <= 1).length;
  out.impliedSecondsOfDay = median;
  out.implied = `${String(Math.floor(median / 3600)).padStart(2,"0")}:${String(Math.floor((median % 3600) / 60)).padStart(2,"0")}:${String(median % 60).padStart(2,"0")}`;
  out.deltaSec = median - stated;
  out.agreement = matching / implied.length;
  out.n = implied.length;
  return out;
}

// Per-race summary. windAtBoatFn(t, lat, lon) -> {spd_kmh, deg} | null.
function analyzeRace(track, race, startMarks, windAtBoatFn) {
  const pts = track.points;
  const startSec = race ? Date.parse(race.start) / 1000 : pts[0].t;

  // Start-line metrics
  let startLine = null;
  if (startMarks?.rc && startMarks?.pin) {
    const sample = sampleAt(track, startSec);
    const distAtGun = Math.abs(distanceToLine(sample, startMarks.rc, startMarks.pin));
    let crossingT = null, prevD = null;
    for (const p of pts) {
      if (p.t < startSec - 60 || p.t > startSec + 120) continue;
      const d = distanceToLine(p, startMarks.rc, startMarks.pin);
      if (prevD != null && Math.sign(d) !== Math.sign(prevD) && d !== 0) {
        crossingT = p.t; break;
      }
      prevD = d;
    }
    const lateBy = crossingT != null ? crossingT - startSec : null;
    startLine = {
      distAtGun,
      crossingT,
      lateBy,
      ocs: lateBy != null && lateBy < -0.1,
      sogAtGun: sample.sog,
    };
  }

  // Average true-wind direction across the race for tack/gybe + mark
  // detection. Try the IDW interpolation from on-map stations first
  // (covers days where we have hourly HKO snapshots in R2/timeseries).
  let avgWindDeg = null;
  if (windAtBoatFn) {
    let sx = 0, sy = 0, c = 0;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 30))) {
      const w = windAtBoatFn(pts[i].t, pts[i].lat, pts[i].lon);
      if (!w || w.deg == null) continue;
      const r = w.deg * Math.PI / 180;
      sx += Math.sin(r); sy += Math.cos(r); c++;
    }
    if (c > 0) avgWindDeg = (Math.atan2(sx / c, sy / c) * 180 / Math.PI + 360) % 360;
  }
  // Fallback: the daily Lamma chip in window.WIND_DAILY covers many older
  // race days that the hourly snapshots don't. Same direction = same mark
  // classification logic.
  if (avgWindDeg == null && race?.date && window.WIND_DAILY?.[race.date]?.dir != null) {
    avgWindDeg = window.WIND_DAILY[race.date].dir;
  }

  const { tacks, gybes } = detectTacksGybes(pts, avgWindDeg);
  const raceEndSec = race?.end ? Date.parse(race.end) / 1000 : null;
  const markEvents = detectMarkRoundings(pts, startSec, raceEndSec, avgWindDeg, race?.title);
  const marks = clusterMarks(markEvents, avgWindDeg);
  const legs = buildLegs(pts, markEvents, avgWindDeg, polarSpeed, tacks, gybes);
  const polar = polarPlotData(pts, windAtBoatFn);

  // VMG + polar performance (sampled every ~1 sec).
  const polarSamples = [];
  let avgPolarRatio = null;
  if (windAtBoatFn && avgWindDeg != null) {
    for (let i = 0; i < pts.length; i += 4) {
      const p = pts[i];
      const w = windAtBoatFn(p.t, p.lat, p.lon);
      if (!w || w.spd == null) continue;
      let twa = p.cog - w.deg;
      while (twa > 180) twa -= 360;
      while (twa < -180) twa += 360;
      const target = polarSpeed(w.spd / 1.852, twa);
      if (target > 0) polarSamples.push(p.sog / target);
    }
    if (polarSamples.length)
      avgPolarRatio = polarSamples.reduce((s, x) => s + x, 0) / polarSamples.length;
  }

  // Heel statistics from quaternion-derived heel field (VTK only).
  let heelStats = null;
  const withHeel = pts.filter((p) => typeof p.heel === "number");
  if (withHeel.length >= 10) {
    const heels = withHeel.map((p) => Math.abs(p.heel));
    heels.sort((a, b) => a - b);
    heelStats = {
      median: heels[Math.floor(heels.length / 2)],
      max: heels[heels.length - 1],
      p90: heels[Math.floor(heels.length * 0.9)],
    };
  }

  return { startLine, tacks, gybes, marks, legs, polar, heelStats,
           avgPolarRatio, avgWindDeg };
}

// Carry start-line marks across a day's races. Domain knowledge from the
// fleet: the committee boat is anchored once and stays put (it might
// shift slightly between races for a wind change, but the same line is
// reused unless re-pinged).
//
// Two passes:
//   1. FORWARD — at each race, snapshot the latest RC/PIN that fired
//      before the race's gun (with a 1-minute grace). Race 1 might have
//      neither yet if the helmsman pinged after the start sequence.
//   2. BACKWARD FILL — for any race still missing rc/pin, borrow from
//      the NEXT race that has it. The anchored committee boat hasn't
//      moved, so a ping before R3 is just as valid for R1 and R2.
//
// Returns an array of { rc, pin } | null aligned with raceStartsSec.
function startLinesForDay(buttons, raceStartsSec) {
  const out = [];
  let rc = null, pin = null, evIdx = 0;
  for (const start of raceStartsSec) {
    const cutoff = start + 60;
    while (evIdx < buttons.length && buttons[evIdx].t <= cutoff) {
      const ev = buttons[evIdx++];
      if (ev.type === "RC") rc = ev;
      else if (ev.type === "PIN") pin = ev;
      else if (ev.type === "LINE_CLEARED") { rc = null; pin = null; }
    }
    out.push({ rc, pin });
  }
  // Backward fill — race i borrows rc/pin from race i+1 if missing.
  for (let i = out.length - 2; i >= 0; i--) {
    if (!out[i].rc && out[i + 1].rc) out[i].rc = out[i + 1].rc;
    if (!out[i].pin && out[i + 1].pin) out[i].pin = out[i + 1].pin;
  }
  return out.map((s) => (s.rc || s.pin) ? s : null);
}

// Binary-search slice of points where windowStart ≤ t ≤ windowEnd.
function sliceByTime(points, t0, t1) {
  if (!points.length) return [];
  // Find first index ≥ t0
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t0) lo = mid + 1; else hi = mid;
  }
  const start = lo;
  // Find first index > t1
  lo = start; hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t1) lo = mid + 1; else hi = mid;
  }
  return points.slice(start, lo);
}

function indexFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.(vtk|gpx|tcx|csv)$/i.test(f.name));
  if (!files.length) {
    statusEl.textContent = "No .VTK files found.";
    return;
  }
  for (const f of files) {
    const k = dayKeyFor(f);
    if (!k) continue;
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(f);
  }
  renderDayList();
}

function clearTracks() {
  for (const t of tracks) if (!t.removed) map.removeLayer(t.layer);
  tracks.length = 0;
  tracksEl.innerHTML = "";
  colorIdx = 0;
  selectedTrackId = null;
  readoutEl.hidden = true;
  scoreboardEl.hidden = true;
  raceTime = null;
  updateRaceClockBounds();
  windLayer.clearLayers();
  windEl.hidden = true;
  windBarbEl.hidden = true;
  activeRaceFilter = null;
  raceTabsEl.hidden = true;
  raceTabsEl.innerHTML = "";
  startCountdownEl.hidden = true;
  raceMarks.clear();
  raceFinishLines.clear();
  markRoundingsLayer.clearLayers();
  raceFinishLineLayer.clearLayers();
  lastRenderedMarksRace = null;
  lastRenderedFinishRace = null;
  renderTrackLegend();
}

// Optional file-picker / drop UI (only present if elements exist in HTML).
const pickFiles = document.getElementById("pickFiles");
const pickDir = document.getElementById("pickDir");
const clearBtn = document.getElementById("clearBtn");
const dropEl = document.getElementById("drop");
if (pickFiles) pickFiles.addEventListener("change", (e) => indexFiles(e.target.files));
if (pickDir) pickDir.addEventListener("change", (e) => indexFiles(e.target.files));

// ---------- Start countdown + time-to-line predictor ----------
const startCountdownEl = document.getElementById("startCountdown");

// Time (seconds) for a boat at (lat, lon) moving sog kn at cog° to cross
// the line A-B. Returns { distance, eta } in metres / seconds, or null
// if not moving toward the line. Signed perpendicular trick: compute the
// line normal, then divide signed distance-to-line by velocity component
// along that normal.
function timeToLinePredict(boat, sog, cogDeg, line) {
  const a = line.rc, b = line.pin;
  const lat0 = (a.lat + b.lat) / 2;
  const mLat = 111_320, mLon = 111_320 * Math.cos(lat0 * Math.PI / 180);
  const ax = a.lon * mLon, ay = a.lat * mLat;
  const bx = b.lon * mLon, by = b.lat * mLat;
  const px = boat.lon * mLon, py = boat.lat * mLat;
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;
  const distSigned = ((px - ax) * dy - (py - ay) * dx) / len;
  const speedMps = sog * 0.5144444;
  const cogRad = cogDeg * Math.PI / 180;
  const vx = Math.sin(cogRad) * speedMps;
  const vy = Math.cos(cogRad) * speedMps;
  const vPerp = (vx * dy - vy * dx) / len;
  if (Math.abs(vPerp) < 0.05) return { distance: Math.abs(distSigned), eta: null };
  const eta = -distSigned / vPerp;
  if (eta < 0) return { distance: Math.abs(distSigned), eta: null };
  return { distance: Math.abs(distSigned), eta };
}

// Identify which race the playback clock is currently in the start
// sequence for: any visible track whose race.start is within the next
// 5 minutes, or the most recent gun (within 30s past).
function activeRaceForCountdown() {
  if (raceTime == null) return null;
  let best = null, bestAbs = Infinity;
  const seen = new Set();
  for (const t of tracks) {
    if (t.removed || !t.visible || !t.meta?.race?.start) continue;
    const r = t.meta.race;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    const startSec = Date.parse(r.start) / 1000;
    const delta = startSec - raceTime;       // +ve = start is in future
    if (delta > 5 * 60 || delta < -30) continue;
    if (Math.abs(delta) < bestAbs) { bestAbs = Math.abs(delta); best = { race: r, track: t }; }
  }
  return best;
}

function refreshStartCountdown() {
  const active = activeRaceForCountdown();
  if (!active) { startCountdownEl.hidden = true; return; }
  const startSec = Date.parse(active.race.start) / 1000;
  const tToGun = startSec - raceTime;
  startCountdownEl.hidden = false;
  // Format T-MM:SS / T+SS
  const sign = tToGun >= 0 ? "T-" : "T+";
  const abs = Math.abs(tToGun);
  const mm = Math.floor(abs / 60);
  const ss = Math.floor(abs % 60);
  const cdText = tToGun >= 0
    ? `${sign}${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `🟢 GUN +${ss}s`;
  let cdClass = "cd-yellow";
  if (tToGun < 0) cdClass = "cd-go";
  else if (tToGun < 60) cdClass = "cd-red";
  else if (tToGun < 120) cdClass = "cd-orange";

  // Time-to-line, only when MY_BOAT has a track in this race AND a start line.
  let tlInfo = "";
  const myTrack = tracks.find((t) =>
    !t.removed && t.visible &&
    t.meta?.boat === MY_BOAT.name &&
    t.meta?.race?.name === active.race.name);
  const sm = myTrack?.meta?.startMarks;
  if (myTrack && sm?.rc && sm?.pin) {
    const sample = sampleAt(myTrack, raceTime);
    const ttl = timeToLinePredict(sample, sample.sog, sample.cog, sm);
    if (ttl) {
      const etaTxt = ttl.eta == null
        ? `<span style="color:#94a3b8;">drifting</span>`
        : `ETA <b>${ttl.eta.toFixed(0)}s</b>`;
      let bufTxt = "";
      if (ttl.eta != null && tToGun > 0) {
        const buffer = tToGun - ttl.eta; // +ve = late, -ve = early
        const cls = buffer < -2 ? "cd-buf-early"
                  : buffer > 5 ? "cd-buf-late" : "cd-buf-ok";
        const sign = buffer < 0 ? "" : "+";
        const word = buffer < -2 ? "early"
                   : buffer > 5 ? "late" : "on time";
        bufTxt = ` · <span class="${cls}">${sign}${buffer.toFixed(0)}s ${word}</span>`;
      }
      tlInfo = `<div class="cd-tl">${MY_BOAT.name}: DTL <b>${ttl.distance.toFixed(0)}m</b> · ${etaTxt}${bufTxt}</div>`;
    }
  }

  startCountdownEl.innerHTML = `
    <div class="cd-label ${cdClass}">${cdText}</div>
    <div class="cd-race">${active.race.title || active.race.name}</div>
    ${tlInfo}`;
}

// ---------- "My boat" picker ----------
// Populates from window.BOATS / window.BOAT_NAMES once races.js loads.
const myBoatPicker = document.getElementById("myBoatPicker");
function populateMyBoatPicker() {
  if (!myBoatPicker) return;
  const names = window.BOAT_NAMES || {};
  const sails = Object.keys(names).sort((a, b) =>
    (names[a] || a).localeCompare(names[b] || b));
  if (!sails.length) {
    myBoatPicker.innerHTML = `<option value="${MY_BOAT.sail}">${MY_BOAT.name}</option>`;
    return;
  }
  myBoatPicker.innerHTML = sails.map((sail) => {
    const name = names[sail] || sail;
    return `<option value="${sail}|${name}" ${sail === MY_BOAT.sail ? "selected" : ""}>${name} (${sail})</option>`;
  }).join("");
}
populateMyBoatPicker();
myBoatPicker?.addEventListener("change", () => {
  const [sail, name] = myBoatPicker.value.split("|");
  MY_BOAT = { sail, name };
  localStorage.setItem(MY_BOAT_KEY, JSON.stringify(MY_BOAT));
  // Re-render everything that depends on MY_BOAT.
  renderDayList();
  if (activeDayKey) {
    const k = activeDayKey;
    activeDayKey = null;
    selectDay(k);
  }
});

// ---------- Record-demo auto-tour ----------
// Walks through a fixed storyboard so the user can screen-record without
// manually clicking. Default day = 2026-03-28 R3 Frostbite 12. Drives the
// existing UI affordances (dropdown, race tab, play, scrub) so nothing is
// special-cased — what the viewer sees is the real app.
//
// Storyboard captions live in DEMO_STEPS; the runner times them, advances
// the playback clock, then shows a final upload-CTA card.
const DEMO_STEPS = [
  { atSec: 0,  caption: "<strong>RHKYC J/80 Race Replay</strong>Pick a race day &mdash; we'll watch <em>R3 Frostbite 12</em>, 28 March 2026." },
  { atSec: 3,  caption: "<strong>Race scoreboard</strong>Live results pulled from the RHKYC PDF, with your boat highlighted." },
  { atSec: 6,  caption: "<strong>Boat trail draws as the race unfolds</strong>Press play, watch the dashed track grow behind the boat." },
  { atSec: 14, caption: "<strong>Live wind</strong>Real HKO wind across 30 stations interpolated to your position." },
  { atSec: 22, caption: "<strong>Click any boat</strong>Translucent popup shows live SOG / COG / time." },
  { atSec: 30, caption: "<strong>Race stats sidebar</strong>Tacks, gybes, mark roundings, polar %, heel, time-to-line." },
];
const DEMO_DAY = "2026-03-28";
const DEMO_RACE = "R3";

let demoOverlay = null;
function showDemoOverlay(html) {
  if (!demoOverlay) {
    demoOverlay = document.createElement("div");
    demoOverlay.id = "demoOverlay";
    document.body.appendChild(demoOverlay);
  }
  demoOverlay.innerHTML = html;
  demoOverlay.style.display = "block";
}
function hideDemoOverlay() {
  if (demoOverlay) demoOverlay.style.display = "none";
}

let demoRunning = false;
async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  try {
    // 1. Make sure the right day is loaded.
    if (activeDayKey !== DEMO_DAY) {
      const sel = document.getElementById("daysPicker");
      sel.value = DEMO_DAY;
      sel.dispatchEvent(new Event("change"));
      // Wait for tracks to land.
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && tracks.filter((t) => !t.removed).length === 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // 2. Switch to the demo race tab.
    const pill = [...document.querySelectorAll(".race-tab")]
      .find((b) => b.textContent.trim().startsWith(DEMO_RACE));
    if (pill) pill.click();
    await new Promise((r) => setTimeout(r, 600));
    // 3. Reset clock to start, ensure 10× speed, press play.
    if (raceStart != null) updateBoatsToRaceTime(raceStart);
    speedMult = 10;
    pbSpeed.value = "10";
    if (!playing) {
      playing = true;
      playBtn.textContent = "❚❚";
    }
    // 4. Step through captions in real time. The race plays at 10× so a
    // ~6-min real race takes ~36 sec of recording.
    const startMs = performance.now();
    for (const step of DEMO_STEPS) {
      const wait = startMs + step.atSec * 1000 - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!demoRunning) return;
      showDemoOverlay(step.caption);
    }
    // 5. Wait for the race to finish (clock reaches raceEnd) or 60 s cap.
    const cap = startMs + 60_000;
    while (performance.now() < cap && playing) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // 6. End card.
    showDemoOverlay(
      `<strong>Want to see your boat next to mine?</strong>` +
      `Drop your VTK / GPX / TCX / Vakaros CSV at` +
      `<div class="demo-cta">j80-racing.yafo78.workers.dev/upload</div>`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    demoRunning = false;
    setTimeout(hideDemoOverlay, 800);
  }
}

document.getElementById("demoBtn")?.addEventListener("click", () => {
  if (demoRunning) { demoRunning = false; hideDemoOverlay(); return; }
  runDemo();
});

// ---------- 3D MapLibre view ----------
// Toggle that switches the map area between the existing 2D Leaflet view
// and a 3D MapLibre view (tilted, rotatable, perspective-projected).
// The 2D Leaflet map and all its existing logic stay untouched; the 3D
// view mirrors the same data — tracks, marks, start/finish lines, boat
// markers — and rides on the same race-time clock so playback works
// identically.
let _mlMap = null;
let _mlReady = false;
const _mlBoatMarkers = new Map();   // trackId -> maplibregl.Marker
const _mlMarkMarkers = [];          // all course-mark markers
const _mlLineMarkers = [];          // start/finish line geometry markers

function init3DMap() {
  if (_mlMap) return;
  const c = map.getCenter();
  const z = Math.max(11, map.getZoom() - 1);
  _mlMap = new maplibregl.Map({
    container: "map3d",
    style: {
      version: 8,
      sources: {
        // Esri World Imagery — free satellite tiles, no API key, looks
        // dramatic at tilted angles.
        sat: {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics",
        },
        // Optional faint OSM labels overlay so place names are readable
        // over the satellite (dimmed via opacity).
        labels: {
          type: "raster",
          tiles: ["https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 17,
        },
        seamarks: {
          type: "raster",
          tiles: ["https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 18,
        },
      },
      layers: [
        { id: "sat", type: "raster", source: "sat" },
        { id: "seamarks", type: "raster", source: "seamarks", paint: { "raster-opacity": 0.9 } },
      ],
    },
    center: [c.lng, c.lat],
    zoom: z,
    pitch: 55,
    bearing: 0,
    maxPitch: 85,
  });
  _mlMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  _mlMap.on("load", () => {
    _mlReady = true;
    refresh3DScene();
  });
}

function trackToGeoJSON(track) {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: track.latlngs.map(([lat, lon]) => [lon, lat]),
    },
    properties: { color: track.color, id: track.id },
  };
}

// Wipe and rebuild all dynamic layers (tracks, marks, lines, boats).
function refresh3DScene() {
  if (!_mlMap || !_mlReady) return;
  // Track lines: remove existing then add per-visible-track.
  const style = _mlMap.getStyle();
  for (const layer of style.layers) {
    if (layer.id.startsWith("track-line-")) _mlMap.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(style.sources)) {
    if (sourceId.startsWith("track-source-")) _mlMap.removeSource(sourceId);
  }
  for (const t of tracks) {
    if (t.removed || !t.visible) continue;
    const sId = `track-source-${t.id}`;
    const lId = `track-line-${t.id}`;
    _mlMap.addSource(sId, { type: "geojson", data: trackToGeoJSON(t) });
    _mlMap.addLayer({
      id: lId, type: "line", source: sId,
      paint: {
        "line-color": t.color,
        "line-width": 3,
        "line-dasharray": [2, 2],
        "line-opacity": 0.95,
      },
    });
  }
  // Boat meshes are rendered by the Three.js custom layer below — no
  // HTML markers needed. Initialize the layer (idempotent) and rebuild
  // its boat meshes for whatever tracks are visible.
  init3DBoats();
  refresh3DBoatMeshes();
  // Course marks (from the active race)
  for (const m of _mlMarkMarkers) m.remove();
  _mlMarkMarkers.length = 0;
  const activeRaceName = visibleRaceForMarks();
  if (activeRaceName) {
    const marks = raceMarks.get(activeRaceName) || [];
    for (const mk of marks) {
      const el = document.createElement("div");
      el.className = "m3d-mark";
      el.textContent = mk.label;
      const m = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([mk.lon, mk.lat])
        .addTo(_mlMap);
      _mlMarkMarkers.push(m);
    }
  }
  // Start + finish lines
  for (const m of _mlLineMarkers) m.remove();
  _mlLineMarkers.length = 0;
  for (const layer of _mlMap.getStyle().layers) {
    if (layer.id === "start-line" || layer.id === "finish-line") _mlMap.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(_mlMap.getStyle().sources)) {
    if (sourceId === "start-line-source" || sourceId === "finish-line-source") _mlMap.removeSource(sourceId);
  }
  // Build lines from any visible track in the active race that has marks pinged.
  if (activeRaceName) {
    const t = tracks.find((x) => !x.removed && x.visible && x.meta?.race?.name === activeRaceName);
    const sm = t?.meta?.startMarks;
    if (sm?.rc && sm?.pin) {
      _mlMap.addSource("start-line-source", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString",
          coordinates: [[sm.rc.lon, sm.rc.lat], [sm.pin.lon, sm.pin.lat]] }, properties: {} },
      });
      _mlMap.addLayer({ id: "start-line", type: "line", source: "start-line-source",
        paint: { "line-color": "#fff", "line-width": 2.5, "line-dasharray": [3, 2], "line-opacity": 0.9 } });
    }
    const fl = raceFinishLines.get(activeRaceName);
    if (fl) {
      _mlMap.addSource("finish-line-source", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString",
          coordinates: [[fl.rc.lon, fl.rc.lat], [fl.pin.lon, fl.pin.lat]] }, properties: {} },
      });
      _mlMap.addLayer({ id: "finish-line", type: "line", source: "finish-line-source",
        paint: { "line-color": "#a78bfa", "line-width": 2.5, "line-dasharray": [4, 2], "line-opacity": 0.95 } });
    }
  }
  // Initial fit
  fit3DToTracks();
  update3DBoats(raceTime);
}

function fit3DToTracks() {
  if (!_mlMap) return;
  const live = tracks.filter((t) => !t.removed && t.visible);
  if (!live.length) return;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const t of live) {
    for (const [lat, lon] of t.latlngs) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    }
  }
  _mlMap.fitBounds([[minLon, minLat], [maxLon, maxLat]],
    { padding: 60, pitch: 55, duration: 600 });
}

// ---------- Three.js procedural boat meshes ----------
// Custom MapLibre layer that hosts a Three.js scene with one Group per
// visible boat. Each Group contains:
//   - hull   (extruded boat-shape, low-poly, coloured to the boat)
//   - mast   (cylinder, vertical)
//   - boom   (cylinder, horizontal at deck height)
//   - sail   (triangular plane; rotates around the mast based on TWA)
//
// Each boat's world-space position is its (lat, lon) offset in metres
// from a fixed reference point at the HK racing area; the layer's
// `render()` ties the scene into the map's projection matrix. The
// race-time clock drives position / heading / sail trim every frame.
const _3D_REF_LAT = 22.21, _3D_REF_LON = 114.18;
let _three = null; // { scene, camera, renderer, layer, boats: Map }

function makeBoatMesh(colorHex) {
  const HULL_LEN = 7.5, HULL_BEAM = 2.6, HULL_DEPTH = 0.9;
  const halfL = HULL_LEN / 2, halfB = HULL_BEAM / 2;

  const group = new THREE.Group();

  // Hull — extruded shape, top-down boat outline. Bow at +X, stern at -X.
  const hullShape = new THREE.Shape();
  hullShape.moveTo(halfL, 0);
  hullShape.bezierCurveTo(halfL * 0.7,  halfB,
                          -halfL * 0.5, halfB * 0.95,
                          -halfL * 0.95, halfB * 0.7);
  hullShape.lineTo(-halfL,  halfB * 0.4);
  hullShape.lineTo(-halfL, -halfB * 0.4);
  hullShape.lineTo(-halfL * 0.95, -halfB * 0.7);
  hullShape.bezierCurveTo(-halfL * 0.5, -halfB * 0.95,
                          halfL * 0.7, -halfB,
                          halfL, 0);
  const hullGeom = new THREE.ExtrudeGeometry(hullShape, {
    steps: 1, depth: HULL_DEPTH,
    bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.18, bevelSegments: 2,
  });
  hullGeom.rotateX(-Math.PI / 2);          // lay flat (Y up)
  hullGeom.translate(0, -HULL_DEPTH / 2, 0); // sit waterline at Y=0
  const hullMat = new THREE.MeshLambertMaterial({ color: colorHex });
  group.add(new THREE.Mesh(hullGeom, hullMat));

  // White deck cap
  const deckShape = hullShape.clone();
  const deckGeom = new THREE.ShapeGeometry(deckShape);
  deckGeom.rotateX(-Math.PI / 2);
  deckGeom.translate(0, HULL_DEPTH * 0.45, 0);
  const deckMat = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
  group.add(new THREE.Mesh(deckGeom, deckMat));

  // Mast: vertical cylinder (J/80 ~6 m tall above deck)
  const mastMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
  const mastGeom = new THREE.CylinderGeometry(0.07, 0.07, 6, 8);
  const mast = new THREE.Mesh(mastGeom, mastMat);
  mast.position.set(0.4, HULL_DEPTH * 0.45 + 3, 0);
  group.add(mast);

  // Sail group — pivots at the gooseneck (mast base on deck).
  // Children: boom + triangular mainsail.
  const sailGroup = new THREE.Group();
  sailGroup.position.set(0.4, HULL_DEPTH * 0.45 + 0.5, 0);

  // Boom (along local -X by default)
  const boomGeom = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
  boomGeom.rotateZ(Math.PI / 2);
  const boom = new THREE.Mesh(boomGeom, mastMat);
  boom.position.set(-1.5, 0, 0);
  sailGroup.add(boom);

  // Mainsail — triangle in the X-Y plane, attached at:
  //   tack (0, 0)        = gooseneck (mast base + boom)
  //   head (0, 5.5)      = top of mast
  //   clew (-3.0, 0.15)  = boom end (stern direction in local frame)
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0);
  sailShape.lineTo(0, 5.5);
  sailShape.lineTo(-3, 0.15);
  sailShape.lineTo(0, 0);
  const sailGeom = new THREE.ShapeGeometry(sailShape);
  // Slight billowing: bend the centre by displacing vertices a touch in -Z.
  const pos = sailGeom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    if (x < -0.1 && y > 0.3 && y < 5) {
      pos.setZ(i, -0.25 * Math.sin(Math.PI * y / 5.5)); // gentle curve
    }
  }
  pos.needsUpdate = true;
  sailGeom.computeVertexNormals();
  const sailMat = new THREE.MeshLambertMaterial({
    color: 0xfafafa, side: THREE.DoubleSide,
  });
  sailGroup.add(new THREE.Mesh(sailGeom, sailMat));

  group.add(sailGroup);
  group.userData.sailGroup = sailGroup;
  return group;
}

function init3DBoats() {
  if (_three || typeof THREE === "undefined" || !_mlMap) return;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(0.4, 1, 0.6).normalize();
  scene.add(sun);
  const camera = new THREE.Camera();

  const layer = {
    id: "three-boats",
    type: "custom",
    renderingMode: "3d",
    onAdd(map, gl) {
      _three.renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(), context: gl, antialias: true,
      });
      _three.renderer.autoClear = false;
    },
    render(gl, matrix) {
      const ref = maplibregl.MercatorCoordinate.fromLngLat(
        [_3D_REF_LON, _3D_REF_LAT], 0);
      const scale = ref.meterInMercatorCoordinateUnits();
      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(ref.x, ref.y, ref.z)
        .scale(new THREE.Vector3(scale, -scale, scale))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = m.multiply(l);
      _three.renderer.resetState();
      _three.renderer.render(scene, camera);
      _mlMap.triggerRepaint();
    },
  };
  _three = { scene, camera, renderer: null, layer, boats: new Map() };
  if (_mlReady) _mlMap.addLayer(layer);
  else _mlMap.on("load", () => _mlMap.addLayer(layer));
}

function refresh3DBoatMeshes() {
  if (!_three) return;
  for (const [, mesh] of _three.boats) _three.scene.remove(mesh);
  _three.boats.clear();
  for (const t of tracks) {
    if (t.removed || !t.visible) continue;
    const colorHex = parseInt(t.color.replace("#", ""), 16);
    const mesh = makeBoatMesh(colorHex);
    _three.scene.add(mesh);
    _three.boats.set(t.id, mesh);
  }
}

// Same shape as the 2D boatIcon, exposed as a string for MapLibre HTML
// markers. Hull pointed-bow up, mast at (0,-3), sail group rotates each
// frame from update3DBoats based on TWA.
function sailboatSvg(color) {
  return `<svg viewBox="-12 -14 24 24" class="m3d-svg" overflow="visible">
    <path class="hull" d="M 0,-11 C 4,-6 4.5,3 3.5,7 L 0,8.5 L -3.5,7 C -4.5,3 -4,-6 0,-11 Z"
      fill="${color}" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>
    <circle cx="0" cy="-3" r="0.8" fill="#fff"/>
    <g class="boat-sail" transform="rotate(0 0 -3)">
      <path d="M 0,-3 Q 1.4,3 0.4,9" fill="none"
        stroke="rgba(255,255,255,0.92)" stroke-width="1.5" stroke-linecap="round"/>
    </g>
  </svg>`;
}

// Update Three.js boats each frame: position (lat/lon → metres from ref),
// heading (rotation around vertical axis = COG), sail trim (rotation
// around mast = TWA-derived angle), heel (roll on bow-stern axis from
// VTK quaternion / Vakaros heel column).
function update3DBoats(t) {
  if (!_three || t == null) return;
  const cosRef = Math.cos(_3D_REF_LAT * Math.PI / 180);
  for (const tr of tracks) {
    if (tr.removed) continue;
    const mesh = _three.boats.get(tr.id);
    if (!mesh) continue;
    const clamped = Math.max(tr.tStart, Math.min(tr.tEnd, t));
    const s = sampleAt(tr, clamped);

    // Position relative to reference (X = east, Z = south, Y = sea level)
    mesh.position.x = (s.lon - _3D_REF_LON) * 111_320 * cosRef;
    mesh.position.z = -(s.lat - _3D_REF_LAT) * 111_320;
    mesh.position.y = 0;

    // Heading: bow at boat-local +X. To make bow point along COG (CW from
    // north), rotate around Y by (90° - COG).
    const headingRad = (90 - s.cog) * Math.PI / 180;

    // Heel from Velocitek/Vakaros (degrees, port −, starboard +). Convert
    // to a roll about the boat's local forward axis, then combine with
    // heading in a quaternion.
    let heelDeg = 0;
    if (typeof s.heel === "number" && isFinite(s.heel)) {
      heelDeg = Math.max(-50, Math.min(50, s.heel));
    } else if (tr.points.length) {
      // Interpolate heel between adjacent samples if available.
      const i = tr.points.findIndex((p) => p.t >= clamped);
      const a = tr.points[Math.max(0, i - 1)], b = tr.points[Math.max(0, i)];
      if (a && b && typeof a.heel === "number" && typeof b.heel === "number") {
        const f = b.t === a.t ? 0 : (clamped - a.t) / (b.t - a.t);
        heelDeg = Math.max(-50, Math.min(50, a.heel + (b.heel - a.heel) * f));
      }
    }
    // Build orientation: yaw (heading) then roll about local +X (bow axis).
    mesh.rotation.set(0, headingRad, 0);
    mesh.rotateX(heelDeg * Math.PI / 180);

    // Sail trim — rotate sail group around its local Y. Positive sail
    // angle = sail to starboard (matches 2D convention).
    const sailGroup = mesh.userData.sailGroup;
    if (sailGroup) {
      const w = windAtBoatFn ? windAtBoatFn(s.t, s.lat, s.lon) : null;
      let twa = null;
      if (w && w.deg != null) {
        twa = w.deg - s.cog;
        while (twa > 180) twa -= 360; while (twa < -180) twa += 360;
      }
      const sa = sailAngleFromTwa(twa);
      sailGroup.rotation.y = sa != null ? sa * Math.PI / 180 : 0;
    }
  }
}

const toggle3dBtn = document.getElementById("toggle3d");
toggle3dBtn?.addEventListener("click", () => {
  const on = !document.body.classList.contains("is-3d");
  document.body.classList.toggle("is-3d", on);
  toggle3dBtn.textContent = on ? "2D" : "3D";
  if (on) {
    init3DMap();
    setTimeout(() => { _mlMap?.resize(); refresh3DScene(); }, 100);
  }
});

// ---------- Mobile adjustments ----------
// Small screens / touch devices: skip the particle animation and static
// wind grid by default — both are heavy and purely decorative. User can
// still toggle them on manually from the sidebar.
const IS_MOBILE = matchMedia("(max-width: 768px), (pointer: coarse)").matches;
if (IS_MOBILE) {
  windGridShown = false;
  windParticlesShown = false;
  if (map.hasLayer(windParticles)) map.removeLayer(windParticles);
  if (windGridToggle) windGridToggle.checked = false;
  if (windParticleToggle) windParticleToggle.checked = false;
  renderWindGrid(); // clears existing grid arrows
}

// Hamburger drawer (only visible on mobile per CSS).
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarScrim = document.getElementById("sidebarScrim");
function closeSidebar() { document.body.classList.remove("sidebar-open"); }
function toggleSidebar() { document.body.classList.toggle("sidebar-open"); }
sidebarToggle?.addEventListener("click", toggleSidebar);
sidebarScrim?.addEventListener("click", closeSidebar);
// Auto-close after a race-day is picked so the user sees the map.
document.getElementById("daysPicker")?.addEventListener("change", () => {
  if (IS_MOBILE) closeSidebar();
});

// ---------- Auto-load from server-side manifest ----------
// records.js (generated by scan-records.js) populates window.RECORDS:
//   { Boat: { "YYYY-MM-DD": ["Sail records/Boat/YYYY-MM-DD/SESSION_1.VTK", ...] } }
// We wrap each URL in an object that quacks like a File (name,
// webkitRelativePath, arrayBuffer()) so the existing pipeline handles it.
//
// Rewriting: when deployed, VTK files live in Cloudflare R2 at
// R2_BASE_URL/Meltemi/<date>/SESSION_*.VTK. The manifest uses the
// local-relative "Sail records/..." prefix so dev mode still works from
// the http-server; RemoteVtkFile swaps the prefix at fetch time.
const R2_BASE_URL = "https://pub-1aedaddf302345d592d9d1ffce4550bd.r2.dev";
class RemoteVtkFile {
  constructor(url) {
    this.name = url.split("/").pop();
    this.webkitRelativePath = url;   // path includes the YYYY-MM-DD segment
    // "Sail records/Meltemi/..." → "<R2>/Meltemi/..." when the constant is set,
    // or leave the relative path for local dev (http-server serves the folder).
    this.url = R2_BASE_URL
      ? url.replace(/^Sail records\//, R2_BASE_URL.replace(/\/$/, "") + "/")
      : url;
  }
  async arrayBuffer() {
    const r = await fetch(encodeURI(this.url));
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${this.url}`);
    return r.arrayBuffer();
  }
}

// Live wind: fetch the latest timeseries from the Worker (rebuilt by the
// weekend cron job) and replace whatever was committed in timeseries.js.
// Falls back silently if the endpoint isn't available (local dev).
async function loadLiveWind() {
  try {
    const r = await fetch("/api/wind", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    // MERGE rather than replace: the baked timeseries.js holds historical
    // days (e.g. last weekend's race) that /api/wind doesn't cover because
    // HKO's archive only keeps 24 hours and the cron hadn't started yet.
    // Live data wins per-date; older committed dates stay.
    if (data && data.hourly) {
      window.WIND_HOURLY = { ...(window.WIND_HOURLY || {}), ...data.hourly };
    }
    if (data && data.stations && Object.keys(data.stations).length) {
      window.WIND_STATIONS = { ...(window.WIND_STATIONS || {}), ...data.stations };
      populateStationDropdown();
    }
  } catch { /* offline or local dev */ }
}
loadLiveWind();

// Load the day index. In production we try the live /api/records Worker
// endpoint first (reflects any freshly-uploaded VTK immediately); if that
// 404s (local dev via http-server) we fall back to the records.js manifest
// that was committed at last scan time.
async function autoLoadFromManifest() {
  let recs = null;
  try {
    const r = await fetch("/api/records", { cache: "no-store" });
    if (r.ok) recs = await r.json();
  } catch { /* worker not up; use the static manifest */ }
  if (!recs || !Object.keys(recs).length) recs = window.RECORDS;
  if (!recs || !Object.keys(recs).length) {
    statusEl.textContent = "No records — upload a VTK file.";
    return;
  }
  const files = [];
  for (const boat of Object.keys(recs)) {
    for (const day of Object.keys(recs[boat])) {
      for (const url of recs[boat][day]) files.push(new RemoteVtkFile(url));
    }
  }
  indexFiles(files);
}
autoLoadFromManifest();
if (clearBtn) clearBtn.addEventListener("click", () => {
  clearTracks();
  days.clear();
  activeDayKey = null;
  daysEl.innerHTML = "";
  statusEl.textContent = "";
});
