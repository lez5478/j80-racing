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
        while (!tp.eof()) {
          const k2 = tp.varintNum();
          const f = k2 >>> 3, w = k2 & 7;
          if (f === 1 && w === 0) sec = tp.varintNum();
          else if (f === 2 && w === 0) csec = tp.varintNum();
          else if (f === 3 && w === 0) lat = tp.sint32() / 1e7;
          else if (f === 4 && w === 0) lon = tp.sint32() / 1e7;
          else if (f === 5 && w === 0) sog = tp.varintNum() / 10; // knots
          else if (f === 6 && w === 0) cog = tp.varintNum();       // degrees
          else tp.skip(w);
        }
        if (lat !== null && lon !== null) {
          const pt = { t: sec + csec / 100, lat, lon, sog, cog };
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
  const sailNo = boatName === "Meltemi" ? "HKG2231" : "";
  const cog = Math.round(sample.cog).toString().padStart(3, "0");
  const sog = sample.sog.toFixed(1);
  const sogKn = (sample.sog).toFixed(1); // VTK SOG is already in knots
  const tStr = new Date(sample.t * 1000).toLocaleTimeString();
  const subtitle = race
    ? `${race.name}${race.title ? " · " + race.title : ""}`
    : "";
  return `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; min-width: 140px; color: #fff;">
      <div style="font-weight:700; color:${track.color}; font-size:13px; text-shadow: 0 1px 2px rgba(0,0,0,0.7);">
        ${boatName}${sailNo ? ` <span style="color:#cbd5e1;font-weight:400;font-size:11px;">${sailNo}</span>` : ""}
      </div>
      ${subtitle ? `<div style="color:#cbd5e1;font-size:11px;margin-bottom:4px;text-shadow:0 1px 2px rgba(0,0,0,0.7);">${subtitle}</div>` : ""}
      <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,0.7);">
        <span style="color:#94a3b8;">SOG</span><span><b>${sogKn}</b> kn</span>
        <span style="color:#94a3b8;">COG</span><span><b>${cog}</b>°</span>
        <span style="color:#94a3b8;">Time</span><span>${tStr}</span>
      </div>
    </div>`;
}

function boatIcon(color, heading) {
  // SVG triangle pointing "up" — rotated by CSS to match heading (COG).
  // Anchor centered so the boat sits right on the track.
  const html = `
    <div class="boat-icon" style="transform: rotate(${heading}deg);">
      <svg viewBox="-12 -12 24 24">
        <polygon class="hull"
          points="0,-10 7,8 0,4 -7,8"
          fill="${color}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`;
  return L.divIcon({
    html, className: "", iconSize: [18, 18], iconAnchor: [9, 9],
  });
}

function addTrack(name, points, meta = {}) {
  if (!points.length) {
    statusEl.textContent = `⚠ ${name}: no GPS points`;
    return;
  }
  const color = COLORS[colorIdx++ % COLORS.length];
  const latlngs = points.map((p) => [p.lat, p.lon]);
  // Trail polyline starts EMPTY — points are appended as the race clock
  // advances so you actually watch the boat draw its track during playback.
  const line = L.polyline([latlngs[0]], { color, weight: 3, opacity: 0.9 });
  const start = L.circleMarker(latlngs[0], {
    radius: 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1,
  }).bindTooltip(`Start: ${name}`);

  const maxSog = points.reduce((m, p) => Math.max(m, p.sog || 0), 0);
  const duration = points[points.length - 1].t - points[0].t;
  line.bindTooltip(
    `${name}<br>${points.length} pts · ${humanDuration(duration)} · max ${maxSog.toFixed(1)} kn`,
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
  boat.bindPopup("", { offset: [0, -8], autoPan: false, className: "boat-popup" });

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
  const track = {
    id, name, layer, line, points, color, visible: true,
    latlngs, fullBounds,
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
  });
  li.querySelector("button").addEventListener("click", (e) => {
    e.stopPropagation();
    map.removeLayer(layer);
    li.remove();
    track.removed = true;
    if (selectedTrackId === id) selectTrack(null);
    updateRaceClockBounds();
  });
  tracksEl.appendChild(li);

  fitAll();
  updateRaceClockBounds();
  // Place the boat at whatever the current race time is (or start).
  updateBoatsToRaceTime(raceTime ?? track.tStart);
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
    // No data for this day — hide all markers.
    for (const { marker } of windMarkers.values()) windMapLayer.removeLayer(marker);
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
      windMapLayer.removeLayer(info.marker);
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
        renderScoreboard(race || null, "HKG2231");
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
  const sailNumber = t.meta?.boat === "Meltemi" ? "HKG2231" : null;
  renderScoreboard(t.meta?.race || null, sailNumber);
  renderRaceStats(t);
  renderWindShift(t);
  setupGhostsForTrack(t);

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
    const myFinisher = race.finishers.find((f) => f.sail === "HKG2231");
    const myDnx = race.dnc.find((x) => x.sail === "HKG2231");
    let myLine = "";
    if (boatName === "Meltemi") {
      if (myFinisher) {
        const winner = race.finishers[0];
        const gapMs = Date.parse(`${race.date}T${myFinisher.finish}`) -
                      Date.parse(`${race.date}T${winner.finish}`);
        const gap = gapMs > 0 ? `+${Math.round(gapMs / 1000)}s` : "leader";
        myLine = `Meltemi: P${myFinisher.place}/${fleet} · ${gap} · finish ${myFinisher.finish}`;
      } else if (myDnx) {
        myLine = `Meltemi: ${myDnx.status}`;
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
    if (f.sail === "HKG2231") continue; // skip our own boat
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

// Race report — opens a printable HTML window the user can save as PDF.
function openRaceReport(track, stats) {
  const race = track.meta?.race;
  const me = race?.finishers.find((f) => f.sail === "HKG2231");
  const mePlace = me ? `P${me.place}/${race.finishers.length + race.dnc.length}` : "—";
  const html = `<!doctype html><html><head><meta charset="utf-8">
  <title>${track.name} — race report</title>
  <style>
    body { font-family: -apple-system, Segoe UI, sans-serif; margin: 32px; color: #111; }
    h1 { margin: 0 0 4px 0; font-size: 22px; }
    h2 { margin-top: 24px; font-size: 14px; text-transform: uppercase; color: #555; letter-spacing: 0.6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; font-variant-numeric: tabular-nums; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; }
    .grid > div { padding: 6px; background: #f3f4f6; border-radius: 4px; }
    .grid b { display: block; font-size: 18px; }
  </style></head><body>
  <h1>${race?.title || track.name}</h1>
  <div>${race?.date || ""} · start ${race ? String(race.startH).padStart(2,"0") + ":" + String(race.startM).padStart(2,"0") : ""} · ${mePlace}</div>
  <h2>Race stats</h2>
  <div class="grid">
    <div><span>Tacks</span><b>${stats.tacks.length}</b></div>
    <div><span>Gybes</span><b>${stats.gybes.length}</b></div>
    <div><span>Marks rounded</span><b>${stats.marks.length}</b></div>
    <div><span>Max SOG</span><b>${track.maxSog.toFixed(1)} kn</b></div>
    <div><span>Avg wind dir</span><b>${stats.avgWindDeg != null ? Math.round(stats.avgWindDeg) + "°" : "—"}</b></div>
    <div><span>vs J/80 polar</span><b>${stats.avgPolarRatio != null ? (stats.avgPolarRatio * 100).toFixed(0) + "%" : "—"}</b></div>
    ${stats.startLine ? `
    <div><span>Dist at gun</span><b>${stats.startLine.distAtGun.toFixed(0)} m</b></div>
    <div><span>Crossed line</span><b>${stats.startLine.lateBy != null ? fmtSec(stats.startLine.lateBy) : "—"}${stats.startLine.ocs ? " (OCS)" : ""}</b></div>` : ""}
  </div>
  <h2>Scoreboard</h2>
  <table><thead><tr><th>P</th><th>Boat</th><th>Sail</th><th>Finish</th><th>Elapsed</th></tr></thead><tbody>
  ${(race?.finishers || []).map((f) => {
    const name = (window.BOAT_NAMES || {})[f.sail] || "—";
    const self = f.sail === "HKG2231" ? "background:#fff7d6;" : "";
    return `<tr style="${self}"><td>${f.place}</td><td>${name}</td><td>${f.sail}</td><td>${f.finish}</td><td>${f.elapsed}</td></tr>`;
  }).join("")}
  </tbody></table>
  <p style="color:#888;font-size:11px;margin-top:24px;">Generated by J/80 Racing app · ${new Date().toLocaleString()}</p>
  </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 250);
}

// ---------- Race-stats sidebar panel ----------
const raceStatsEl = document.getElementById("raceStats");
const rsStartGrid = document.querySelector("#rsStart .rs-grid");
const rsManeuversGrid = document.querySelector("#rsManeuvers .rs-grid");
const rsPerfGrid = document.querySelector("#rsPerf .rs-grid");
const markRoundingsLayer = L.layerGroup().addTo(map);

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
  if (stats.startLine) {
    const sl = stats.startLine;
    const lateClass = sl.ocs ? "rs-bad" : (sl.lateBy != null && sl.lateBy < 5 ? "rs-good" : "");
    rsStartGrid.innerHTML = `
      <span class="rs-k">Dist at gun</span><span class="rs-v">${sl.distAtGun.toFixed(0)} m</span>
      <span class="rs-k">SOG at gun</span><span class="rs-v">${sl.sogAtGun.toFixed(1)} kn</span>
      <span class="rs-k">Crossed line</span><span class="rs-v ${lateClass}">${sl.lateBy != null ? fmtSec(sl.lateBy) : "—"}${sl.ocs ? " (OCS!)" : ""}</span>
    `;
  } else {
    rsStartGrid.innerHTML = `<span class="rs-k" style="grid-column:1/3;">No start line pinged</span>`;
  }

  // Maneuvers
  rsManeuversGrid.innerHTML = `
    <span class="rs-k">Tacks</span><span class="rs-v">${stats.tacks.length}</span>
    <span class="rs-k">Gybes</span><span class="rs-v">${stats.gybes.length}</span>
    <span class="rs-k">Mark roundings</span><span class="rs-v">${stats.marks.length}</span>
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
  rsPerfGrid.innerHTML = `
    <span class="rs-k">vs J/80 polar</span><span class="rs-v ${polarClass}">${polar}</span>
    <span class="rs-k">Max SOG</span><span class="rs-v">${track.maxSog.toFixed(1)} kn</span>
  `;

  // Plot mark roundings as numbered map circles.
  markRoundingsLayer.clearLayers();
  stats.marks.forEach((m, i) => {
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        html: `<div class="mark-icon">${i + 1}</div>`,
        className: "", iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      interactive: true, zIndexOffset: 300,
    })
    .bindTooltip(`Mark ${i + 1} · ${new Date(m.t * 1000).toLocaleTimeString()} · ${Math.round(m.angle)}° turn`)
    .addTo(markRoundingsLayer);
  });
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
    // Update the rotation on the existing DOM node (avoids flicker from setIcon).
    const el = tr.boat.getElement();
    if (el) {
      const inner = el.querySelector(".boat-icon");
      if (inner) inner.style.transform = `rotate(${s.cog}deg)`;
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
const SPEEDS = [5, 10, 30, 50, 100];
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
    if (r) renderScoreboard(r, "HKG2231");
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
  const t = tracks[selectedTrackId];
  if (!_activeAnalysis || _activeAnalysis.trackId !== t.id) renderRaceStats(t);
  openRaceReport(t, _activeAnalysis.stats);
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

// Dispatch by file extension.
function parseTrackFile(name, bytes) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "vtk") return parseVTK(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  if (ext === "gpx") return parseGPX(text);
  if (ext === "tcx") return parseTCX(text);
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
      const races = window.RACES[k];
      const n = races.length;
      const meltemiRaced = races.some((r) =>
        r.finishers.some((f) => f.sail === "HKG2231"));
      const tag = meltemiRaced ? "" : " · no Meltemi";
      return `<option value="${k}">${k} · ${n} race${n > 1 ? "s" : ""}${tag}</option>`;
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
  const PAD = 15 * 60; // 15 minutes
  const windows = races.map((r) => {
    const startSec = Date.parse(r.start) / 1000;
    const endSec = r.end ? Date.parse(r.end) / 1000 : startSec + 60 * 60;
    return {
      race: r,
      actualStart: startSec,
      actualEnd: endSec,
      windowStart: startSec - PAD,
      windowEnd: endSec + PAD,
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
  let added = 0;
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    for (const [boat, slot] of byBoat) {
      const slice = sliceByTime(slot.points, w.windowStart, w.windowEnd);
      if (slice.length < 2) continue;
      const meltemi = w.race.finishers.find((f) => f.sail === "HKG2231");
      const dnx = w.race.dnc.find((x) => x.sail === "HKG2231");
      const tag = boat === "Meltemi"
        ? (meltemi ? `P${meltemi.place}` : (dnx ? dnx.status : "-"))
        : "";
      const name = `${w.race.name}${w.race.title ? " " + w.race.title : ""} · ${boat}${tag ? " (" + tag + ")" : ""}`;
      const startMarks = startLinesByBoat.get(boat)[wi];
      addTrack(name, slice, { race: w.race, boat, window: w, startMarks });
      added++;
    }
  }

  renderRaceTabs();

  // Default the scoreboard to the first race of the day so opening a day
  // immediately shows results alongside the track(s).
  const firstRace = (window.RACES?.[key] || [])[0];
  if (firstRace) renderScoreboard(firstRace, "HKG2231");

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

// Detect tacks and gybes by walking the smoothed COG and finding
// reversals through the wind axis (≥60° heading change).
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
  const tacks = [], gybes = [];
  let lastT = 0;
  for (let i = 5; i < n - 5; i++) {
    let delta = cog[i + 5] - cog[i - 5];
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    if (Math.abs(delta) < 60) continue;
    if (points[i].t - lastT < 8) continue;
    if (windDeg != null) {
      let twa = cog[i - 5] - windDeg;
      while (twa > 180) twa -= 360;
      while (twa < -180) twa += 360;
      (Math.abs(twa) < 90 ? tacks : gybes).push({
        t: points[i].t, lat: points[i].lat, lon: points[i].lon, angle: Math.abs(delta),
      });
    } else {
      tacks.push({ t: points[i].t, lat: points[i].lat, lon: points[i].lon, angle: Math.abs(delta) });
    }
    lastT = points[i].t;
  }
  return { tacks, gybes };
}

// Detect mark roundings on a windward-leeward course (RHKYC course 8).
// A real mark rounding flips the boat between UPWIND mode (~45° off the
// wind, tacking through ~90°) and DOWNWIND mode (~135-180° off the wind,
// gybing through ~60°). 90° course changes during the beat are TACKS,
// not marks — those happen every ~30-90 seconds and don't change the
// upwind/downwind mode.
//
// The trick: average heading over a 90-second window BEFORE the candidate
// point, and another 90 seconds AFTER. Real mark roundings cause the
// average heading to reverse by ≥150°. Tacks/gybes only swing the
// instantaneous heading, not the long-window average.
function detectMarkRoundings(points, raceStartSec, raceEndSec) {
  if (points.length < 30) return [];
  const WINDOW_SEC = 90;
  const MIN_REVERSAL_DEG = 155;
  const MIN_GAP_SEC = 180;

  // Helper: circular-mean COG over points in [tFrom, tTo].
  function meanCog(tFrom, tTo) {
    let sx = 0, sy = 0, c = 0;
    // Linear scan — points are sorted by time and short.
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
  // Only scan inside the actual race window — pre-start sail-trim and the
  // post-race sail-back to mooring produce lots of 180° flips that aren't
  // course marks.
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
    // Snap to the actual rounding time — find the local SOG minimum
    // inside [t-30, t+30].
    let bestSog = Infinity, bestP = null;
    for (const p of points) {
      if (p.t < t - 30) continue;
      if (p.t > t + 30) break;
      if (p.sog < bestSog) { bestSog = p.sog; bestP = p; }
    }
    if (!bestP) continue;
    out.push({ t: bestP.t, lat: bestP.lat, lon: bestP.lon, angle: Math.abs(delta) });
    // Use the candidate scan time `t` (not bestP.t) for the gap so adjacent
    // 5-sec scans of the same true rounding don't all fire.
    lastT = t;
  }
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

  // Average true-wind direction across the race for tack/gybe disambiguation.
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

  const { tacks, gybes } = detectTacksGybes(pts, avgWindDeg);
  const raceEndSec = race?.end ? Date.parse(race.end) / 1000 : null;
  const marks = detectMarkRoundings(pts, startSec, raceEndSec);

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

  return { startLine, tacks, gybes, marks, avgPolarRatio, avgWindDeg };
}

// Carry start-line marks across a day's races. Domain knowledge from the
// fleet: the committee boat is anchored after race 1, so the same RC/PIN
// is reused for race 2 / 3 unless the helmsman re-pings (common when the
// RC moves the line for a wind shift). We walk all button events in order
// and snapshot the running (rc, pin) at each race's start + 1-minute grace.
// Returns an array of { rc, pin } | null aligned with `raceStartsSec`.
function startLinesForDay(buttons, raceStartsSec) {
  const out = [];
  let rc = null, pin = null;
  let evIdx = 0;
  for (const start of raceStartsSec) {
    const cutoff = start + 60; // 1-min grace past the gun
    while (evIdx < buttons.length && buttons[evIdx].t <= cutoff) {
      const ev = buttons[evIdx++];
      if (ev.type === "RC") rc = ev;
      else if (ev.type === "PIN") pin = ev;
      else if (ev.type === "LINE_CLEARED") { rc = null; pin = null; }
    }
    out.push((rc || pin) ? { rc, pin } : null);
  }
  return out;
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
  const files = Array.from(fileList).filter((f) => /\.(vtk|gpx|tcx)$/i.test(f.name));
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
}

// Optional file-picker / drop UI (only present if elements exist in HTML).
const pickFiles = document.getElementById("pickFiles");
const pickDir = document.getElementById("pickDir");
const clearBtn = document.getElementById("clearBtn");
const dropEl = document.getElementById("drop");
if (pickFiles) pickFiles.addEventListener("change", (e) => indexFiles(e.target.files));
if (pickDir) pickDir.addEventListener("change", (e) => indexFiles(e.target.files));

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
    if (data && data.hourly && Object.keys(data.hourly).length) {
      window.WIND_HOURLY = data.hourly;
      if (data.stations && Object.keys(data.stations).length) {
        window.WIND_STATIONS = data.stations;
        populateStationDropdown();
      }
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
