// ============================================================================
// Village Matcher — pure matching engine
//
// Nothing in this file touches the DOM, localStorage, or fetch. That's
// deliberate: it means these functions can be unit tested with plain Node
// (see tests/matching-engine.test.js) and reused unchanged if the front end
// ever changes. app.js supplies a `travelTimeFn(a, b, mode)` callback that
// knows about caching/backend calls — this file just uses whatever it's
// given.
// ============================================================================

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line + assumed-speed approximation. Used as a fallback whenever
// a real routing API result isn't available (no backend configured, a call
// failed, or the pair fell outside the pre-filter buffer).
const MODE_MODEL = {
  W: { speedKmh: 4.5, overheadMin: 0 },
  D: { speedKmh: 22, overheadMin: 3 },
  P: { speedKmh: 16, overheadMin: 6 },
  B: { speedKmh: 15, overheadMin: 8 },
};

function estimateTravelTime(distanceKm, mode) {
  const m = MODE_MODEL[mode];
  if (!m) return Infinity;
  return (distanceKm / m.speedKmh) * 60 + m.overheadMin;
}

function sharedModes(a, b) {
  return a.transport.filter((m) => b.transport.includes(m));
}

function monthsSinceEpoch(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getFullYear() * 12 + d.getMonth();
}

function ageRangeMonths(members) {
  const months = members.map((m) => monthsSinceEpoch(m.dob));
  return Math.max(...months) - Math.min(...months);
}

function languageIntersection(members) {
  return members
    .map((m) => new Set(m.language))
    .reduce((acc, set) => new Set([...acc].filter((x) => set.has(x))));
}

function mostCommonNeighborhood(members) {
  const counts = {};
  members.forEach((m) => (counts[m.neighborhood] = (counts[m.neighborhood] || 0) + 1));
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function formatMonthYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}.${yy}`;
}

function groupAgeRangeLabel(members) {
  const sorted = [...members].sort((a, b) => new Date(a.dob) - new Date(b.dob));
  const earliest = formatMonthYear(sorted[0].dob);
  const latest = formatMonthYear(sorted[sorted.length - 1].dob);
  return earliest === latest ? earliest : `${earliest}\u2013${latest}`;
}

function pairwiseTravelOk(a, b, settings, travelTimeFn) {
  const  aCanTravel = a.transport.some((mode) => travelTimeFn(a, b, mode) <= a.maxTravel);
  const  bCanTravel = b.transport.some((mode) => travelTimeFn(b, a, mode) <= b.maxTravel);
  console.log("Pairwise travel", a, b);
  console.log(`Pairwise travel result ${a.id}, ${b.id}: ${aCanTravel}, ${bCanTravel}`);
  return aCanTravel && bCanTravel
}

function fitsGroup(candidate, group, settings, travelTimeFn) {
  if (languageIntersection([...group, candidate]).size === 0) return false;
  if (ageRangeMonths([...group, candidate]) > settings.maxAgeGap) return false;
  if (!group.every((m) => pairwiseTravelOk(candidate, m, settings, travelTimeFn))) return false;
  return true;
}

// Simple greedy clustering: walk through the pool (oldest baby first, for
// determinism), grow each group while candidates still fit, stop at
// maxGroupSize, keep the group only if it reached minGroupSize. This is a
// heuristic, not an optimal solver — documented as a known simplification
// in the design doc and README.
function clusterGroups(pool, settings, travelTimeFn) {
  const sorted = [...pool].sort((a, b) => new Date(a.dob) - new Date(b.dob));
  const used = new Set();
  const groups = [];

  for (const seed of sorted) {
    if (used.has(seed.id)) continue;
    const group = [seed];
    for (const cand of sorted) {
      if (cand.id === seed.id || used.has(cand.id)) continue;
      if (group.length >= settings.maxGroupSize) break;
      if (fitsGroup(cand, group, settings, travelTimeFn)) group.push(cand);
    }
    if (group.length >= settings.minGroupSize) {
      group.forEach((m) => used.add(m.id));
      groups.push(group);
    }
  }
  return groups;
}

// Ranked candidates from the unmatched pool who'd fit an existing group's
// remaining members — used for the manual "suggest replacement" flow.
function findReplacementCandidates(existingMembers, pool, settings, travelTimeFn) {
  return pool
    .filter((cand) => fitsGroup(cand, existingMembers, settings, travelTimeFn))
    .map((cand) => ({
      candidate: cand,
      totalDistance: existingMembers.reduce((sum, m) => sum + haversineKm(cand.coords, m.coords), 0),
    }))
    .sort((a, b) => a.totalDistance - b.totalDistance)
    .slice(0, 5)
    .map((r) => r.candidate);
}

const MatchingEngine = {
  haversineKm,
  MODE_MODEL,
  estimateTravelTime,
  sharedModes,
  monthsSinceEpoch,
  ageRangeMonths,
  languageIntersection,
  mostCommonNeighborhood,
  formatMonthYear,
  groupAgeRangeLabel,
  pairwiseTravelOk,
  fitsGroup,
  clusterGroups,
  findReplacementCandidates,
};

// Works as a plain global in the browser (script tag) and as a CommonJS
// export in Node (for the test suite) without needing a bundler.
if (typeof module !== "undefined" && module.exports) {
  module.exports = MatchingEngine;
}
