// Match-race metrics: wind-axis course progress with leg detection and the
// live time gap between two boats. Pure functions over track objects
// ({ id, points, tStart, tEnd, meta }). Loaded as a classic script before
// app.js; also require()-able for tests.

// Cache of per-point wind-axis projections. Float64Array of metres "upwind
// from origin" for each track sample. Keyed by track + wind + origin so
// it only rebuilds when something changes.
const _windProgressCache = new Map();
function getWindProgress(track, windDeg, origin) {
  const key = `${track.id}|${windDeg.toFixed(1)}|${origin.lat.toFixed(5)}|${origin.lon.toFixed(5)}`;
  const cached = _windProgressCache.get(key);
  if (cached) return cached;
  const windRad = windDeg * Math.PI / 180;
  const upE = Math.sin(windRad), upN = Math.cos(windRad);
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos(origin.lat * Math.PI / 180);
  const arr = new Float64Array(track.points.length);
  for (let i = 0; i < track.points.length; i++) {
    const p = track.points[i];
    const dE = (p.lon - origin.lon) * mLon;
    const dN = (p.lat - origin.lat) * mLat;
    arr[i] = dE * upE + dN * upN;
  }
  _windProgressCache.set(key, arr);
  return arr;
}

// MONOTONIC course progress with proper leg detection.
//
// Tactical sailing (tacks, headers, lay-line corrections) causes small
// wind-axis oscillations that inflate cumulative-abs metrics. Instead we
// detect actual legs by tracking peaks/troughs in the smoothed wind-axis
// projection: a leg ends when the projection reverses by more than a
// hysteresis distance from its peak. Each completed leg contributes its
// peak-to-start range to the total — tactical loops add ZERO.
//
// Within the current leg we use the rolling max excursion from the leg
// start, so the metric is non-decreasing across the entire race.
const _courseProgressCache = new Map();
const LEG_HYSTERESIS_M = 80;   // must "fall back" 80 m before counting a flip
const SMOOTH_HALF_W = 15;       // ±15 samples ≈ ±30 s smoothing
function getCourseProgress(track, windDeg, origin) {
  const key = `${track.id}|${windDeg.toFixed(1)}|${origin.lat.toFixed(5)}|${origin.lon.toFixed(5)}`;
  const cached = _courseProgressCache.get(key);
  if (cached) return cached;
  const raw = getWindProgress(track, windDeg, origin);
  const n = raw.length;
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - SMOOTH_HALF_W), hi = Math.min(n - 1, i + SMOOTH_HALF_W);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += raw[j];
    smooth[i] = sum / (hi - lo + 1);
  }
  const cum = new Float64Array(n);
  let legStartVal = smooth[0];
  let legPeakVal = smooth[0];
  let legDir = 0; // 0 = undetermined, 1 = upwind, -1 = downwind
  let cumLegs = 0;
  let runningMaxInLeg = 0;
  for (let i = 1; i < n; i++) {
    const v = smooth[i];
    if (legDir === 0) {
      if (Math.abs(v - legStartVal) > 20) {
        legDir = v > legStartVal ? 1 : -1;
        legPeakVal = v;
      }
    } else {
      // Track peak (max excursion in legDir).
      if ((v - legPeakVal) * legDir > 0) legPeakVal = v;
      runningMaxInLeg = Math.max(runningMaxInLeg, Math.abs(legPeakVal - legStartVal));
      // Reversal: have we fallen back > HYSTERESIS from the peak?
      if ((legPeakVal - v) * legDir > LEG_HYSTERESIS_M) {
        // Commit completed leg.
        cumLegs += runningMaxInLeg;
        runningMaxInLeg = 0;
        legStartVal = legPeakVal;
        legPeakVal = v;
        legDir = -legDir;
      }
    }
    cum[i] = cumLegs + runningMaxInLeg;
  }
  _courseProgressCache.set(key, cum);
  return cum;
}

function _idxAtTime(track, t) {
  let lo = 0, hi = track.points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (track.points[mid].t <= t) lo = mid; else hi = mid;
  }
  return lo;
}

// Live single-value time gap between two boats at one instant, using
// **wind-axis ladder progress** as the metric — not total distance
// sailed. Boat that is furthest up the ladder (on upwind legs) or down
// it (on downwind legs) is "ahead". To convert metres of ladder lead
// into seconds, look back through the leader's history for when it had
// the trailing boat's CURRENT ladder progress — that delta is the gap.
//
// Leg sign auto-detected from recent wind-axis velocity of both boats.
// Lateral offset = projection of selected boat onto axis perpendicular
// to wind (positive = right of rhumb when looking upwind).
// Look up a track's OFFICIAL elapsed time from the committee-boat results
// (race.finishers from race-results/races.js). Returns seconds elapsed
// since the gun, or null if the boat didn't finish / no result yet.
function officialFinishElapsed(track) {
  const race = track.meta?.race;
  if (!race?.finishers || !track.meta?.boat) return null;
  const names = globalThis.BOAT_NAMES || {};
  const fin = race.finishers.find((f) => names[f.sail] === track.meta.boat);
  if (!fin?.elapsed) return null;
  const parts = String(fin.elapsed).split(":").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function liveTimeGap(trackA, trackB, atSec, windDeg, origin) {
  if (!trackA?.points?.length || !trackB?.points?.length) return null;
  // ---------- Frozen post-finish gap from committee results ----------
  // Once BOTH boats have crossed the line per the official elapsed times,
  // lock the gap to (trailing.elapsed − leading.elapsed). No more live
  // re-projection, no drift from extra metres sailed celebrating.
  const elA = officialFinishElapsed(trackA);
  const elB = officialFinishElapsed(trackB);
  const raceStartSec = trackA.meta?.race?.start
    ? Date.parse(trackA.meta.race.start) / 1000 : null;
  if (elA != null && elB != null && raceStartSec != null) {
    const finA = raceStartSec + elA;
    const finB = raceStartSec + elB;
    if (atSec >= Math.max(finA, finB)) {
      const gap = elB - elA; // positive = A finished sooner / ahead
      return {
        gapSec: gap,
        leader: gap > 0 ? (trackA.meta?.boat || trackA.name)
                        : (trackB.meta?.boat || trackB.name),
        lateralM: null,
        legSign: 0,
        official: true,
      };
    }
  }
  if (windDeg == null || !origin) return null;
  const aT = Math.max(trackA.tStart, Math.min(trackA.tEnd, atSec));
  const bT = Math.max(trackB.tStart, Math.min(trackB.tEnd, atSec));
  const courseA = getCourseProgress(trackA, windDeg, origin);
  const courseB = getCourseProgress(trackB, windDeg, origin);
  const rawA = getWindProgress(trackA, windDeg, origin);
  const iA = _idxAtTime(trackA, aT);
  const iB = _idxAtTime(trackB, bT);
  // Leg sign for the selected boat (display only): direction of recent
  // raw wind-axis motion. Positive = upwind, negative = downwind.
  const back = 30;
  const iAprev = _idxAtTime(trackA, Math.max(trackA.tStart, aT - back));
  const dtA = Math.max(1, aT - trackA.points[iAprev].t);
  const vA = (rawA[iA] - rawA[iAprev]) / dtA;
  const sign = vA >= 0 ? 1 : -1;
  // Lateral offset of trackA from the rhumb through origin along wind axis.
  const windRad = windDeg * Math.PI / 180;
  const perpE = Math.cos(windRad), perpN = -Math.sin(windRad);
  const pA = trackA.points[iA];
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos(origin.lat * Math.PI / 180);
  const dE = (pA.lon - origin.lon) * mLon;
  const dN = (pA.lat - origin.lat) * mLat;
  const lateralM = dE * perpE + dN * perpN;
  // Time gap from monotonic course progress (handles leg transitions).
  const cA = courseA[iA];
  const cB = courseB[iB];
  if (Math.abs(cA - cB) < 1) {
    return { gapSec: 0, leader: null, lateralM, legSign: sign };
  }
  const lead = cA > cB ? trackA : trackB;
  const leadCourse = cA > cB ? courseA : courseB;
  const trail = cA > cB ? trackB : trackA;
  const trailNow = cA > cB ? cB : cA;
  // Course progress is monotonic → walk lead's history backward until
  // it drops below the trailing boat's CURRENT course progress. Linear
  // interpolate for sub-step resolution.
  const leadIdxNow = lead === trackA ? iA : iB;
  let crossT = null;
  for (let j = leadIdxNow; j > 0; j--) {
    if (leadCourse[j] < trailNow) {
      const p0 = leadCourse[j], p1 = leadCourse[j + 1];
      const t0 = lead.points[j].t, t1 = lead.points[j + 1].t;
      const frac = p1 === p0 ? 0 : (trailNow - p0) / (p1 - p0);
      crossT = t0 + (t1 - t0) * frac;
      break;
    }
  }
  if (crossT == null) return { gapSec: null, leader: null, lateralM, legSign: sign };
  const trailTimeNow = trail === trackA ? aT : bT;
  const gapAbs = trailTimeNow - crossT;
  const signedGap = (lead === trackA) ? gapAbs : -gapAbs;
  return {
    gapSec: signedGap,
    leader: lead.meta?.boat || lead.name,
    lateralM,
    legSign: sign,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getWindProgress, getCourseProgress, officialFinishElapsed, liveTimeGap };
}
