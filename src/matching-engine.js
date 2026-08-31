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
  W: { speedKmh: 4.5, overheadMin: 0 }, // Walk
  D: { speedKmh: 22, overheadMin: 3 }, // Drive/car/taxi
  P: { speedKmh: 16, overheadMin: 6 }, // Public transport
  B: { speedKmh: 15, overheadMin: 8 }, // Bicycle
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

// A group meets at a café or a park, not at each other's flats, so neither
// person travels the full door-to-door distance — each covers roughly half of
// it. Requiring the whole journey from both sides was halving the practical
// radius and rejecting pairs that can comfortably meet: a mother willing to
// walk 30 minutes and one willing to take a bus for 15 could only be paired
// within 2km, when meeting midway puts them 4km apart.
//
// Fixed costs don't halve. You still walk to the stop and wait for the bus
// whether you ride two stops or ten, so only the moving part is divided.
function meetingLegMinutes(fullMinutes, mode) {
  if (!isFinite(fullMinutes)) return fullMinutes;
  const model    = MODE_MODEL[mode];
  const overhead = model ? Math.min(model.overheadMin, fullMinutes) : 0;
  return overhead + (fullMinutes - overhead) / 2;
}

// Directional: each person must be able to reach the meeting point using one
// of their own transport modes, within their own max travel time. A shared
// mode is not required.
function pairwiseTravelOk(a, b, settings, travelTimeFn) {
  const aCanTravel = a.transport.some((mode) => meetingLegMinutes(travelTimeFn(a, b, mode), mode) <= a.maxTravel);
  const bCanTravel = b.transport.some((mode) => meetingLegMinutes(travelTimeFn(b, a, mode), mode) <= b.maxTravel);
  return aCanTravel && bCanTravel;
}

// ---------------------------------------------------------------------------
// Group quality scoring
//
// fitsGroup answers "is this group allowed?" — a yes/no against the hard
// constraints. scoreGroup answers "how good is it?", so that groups can be
// grown best-first and presented strongest-first rather than in whatever
// order the pool happened to be iterated.
// ---------------------------------------------------------------------------

// Travel dominates because a group that is awkward to reach won't actually
// meet; age and language affect how well it gels once it does.
const SCORE_WEIGHTS = { travel: 0.5, age: 0.3, language: 0.2 };

function clamp01(n) {
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Scored on the worst pair rather than the average: a group is only as
// reachable as its most burdened member. Each leg is measured against that
// member's own stated limit, matching the directional rule in
// pairwiseTravelOk.
function travelScore(members, travelTimeFn) {
  if (members.length < 2) return 1;
  let worstRatio = 0;
  for (const a of members) {
    for (const b of members) {
      if (a.id === b.id) continue;
      if (!a.transport.length || !a.maxTravel) return 0;
      // Same journey pairwiseTravelOk checks, so the score and the constraint
      // can't disagree about how far someone is actually travelling.
      const best = Math.min(...a.transport.map((mode) => meetingLegMinutes(travelTimeFn(a, b, mode), mode)));
      worstRatio = Math.max(worstRatio, best / a.maxTravel);
    }
  }
  return clamp01(1 - worstRatio);
}

// Rewards a tight age spread rather than merely staying under maxAgeGap.
function ageScore(members, settings) {
  if (!settings.maxAgeGap) return 1;
  return clamp01(1 - ageRangeMonths(members) / settings.maxAgeGap);
}

// How much of the members' language repertoires is actually common ground.
// 1.0 means every language the narrowest-speaking member has is shared by
// the whole group, so nobody has to fall back to a second language.
function languageScore(members) {
  const narrowest = Math.min(...members.map((m) => m.language.length));
  if (!narrowest) return 0;
  return clamp01(languageIntersection(members).size / narrowest);
}

function scoreGroup(members, settings, travelTimeFn) {
  const travel   = travelScore(members, travelTimeFn);
  const age      = ageScore(members, settings);
  const language = languageScore(members);
  return {
    travel,
    age,
    language,
    total: SCORE_WEIGHTS.travel * travel + SCORE_WEIGHTS.age * age + SCORE_WEIGHTS.language * language,
  };
}

function fitsGroup(candidate, group, settings, travelTimeFn) {
  if (languageIntersection([...group, candidate]).size === 0) return false;
  if (ageRangeMonths([...group, candidate]) > settings.maxAgeGap) return false;
  if (!group.every((m) => pairwiseTravelOk(candidate, m, settings, travelTimeFn))) return false;
  return true;
}

// Greedy best-fit clustering: walk through the pool (oldest baby first, for
// determinism) and grow each group by repeatedly adding whichever eligible
// candidate produces the highest-scoring group. Stop at maxGroupSize, keep
// the group only if it reached minGroupSize, and return groups strongest
// first. Still a heuristic, not an optimal solver — seeds are claimed in
// order, so an early group can take someone a later group needed more.
// How many others each person could travel to meet. Someone reachable by only
// two people has to be seeded before a well-connected person absorbs one of
// them, or they end up unmatched through no fault of their own.
function travelPartnerCounts(pool, settings, travelTimeFn) {
  const counts = new Map(pool.map((p) => [p.id, 0]));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pairwiseTravelOk(pool[i], pool[j], settings, travelTimeFn)) {
        counts.set(pool[i].id, counts.get(pool[i].id) + 1);
        counts.set(pool[j].id, counts.get(pool[j].id) + 1);
      }
    }
  }
  return counts;
}

function clusterGroups(pool, settings, travelTimeFn) {
  const sorted = [...pool].sort((a, b) => new Date(a.dob) - new Date(b.dob));

  // Seeds are taken most-constrained-first rather than in sheet or
  // date-of-birth order. Sheet order is arbitrary, and it meant whoever
  // happened to be near the top of the spreadsheet claimed the people that
  // someone with fewer options needed. Candidates within a group are still
  // considered in date-of-birth order, so ties break the same way every run.
  const partnerCounts = travelPartnerCounts(pool, settings, travelTimeFn);
  const seedOrder = [...sorted].sort(
    (a, b) =>
      partnerCounts.get(a.id) - partnerCounts.get(b.id) ||
      new Date(a.dob) - new Date(b.dob) ||
      String(a.id).localeCompare(String(b.id))
  );

  const used = new Set();
  const groups = [];

  for (const seed of seedOrder) {
    if (used.has(seed.id)) continue;
    const group = [seed];

    while (group.length < settings.maxGroupSize) {
      let best = null;
      let bestScore = -Infinity;
      for (const cand of sorted) {
        if (used.has(cand.id) || group.some((m) => m.id === cand.id)) continue;
        if (!fitsGroup(cand, group, settings, travelTimeFn)) continue;
        // Strict > keeps ties with the earlier candidate in `sorted`, so
        // repeated runs over the same pool give the same groups.
        const score = scoreGroup([...group, cand], settings, travelTimeFn).total;
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      if (!best) break;
      group.push(best);
    }

    if (group.length >= settings.minGroupSize) {
      group.forEach((m) => used.add(m.id));
      groups.push(group);
    }
  }

  // Strongest first, so the coordinator reviews the most convincing matches
  // at the top of the list instead of in seed order.
  return groups
    .map((members) => ({ members, score: scoreGroup(members, settings, travelTimeFn).total }))
    .sort((a, b) => b.score - a.score)
    .map((g) => g.members);
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
  meetingLegMinutes,
  travelPartnerCounts,
  SCORE_WEIGHTS,
  travelScore,
  ageScore,
  languageScore,
  scoreGroup,
  fitsGroup,
  clusterGroups,
  findReplacementCandidates,
};

// Works as a plain global in the browser (script tag) and as a CommonJS
// export in Node (for the test suite) without needing a bundler.
if (typeof module !== "undefined" && module.exports) {
  module.exports = MatchingEngine;
}
