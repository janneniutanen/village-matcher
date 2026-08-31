// Run with: node --test tests/matching-engine.test.js
// No dependencies — uses Node's built-in test runner and assert module.

const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../src/matching-engine.js");

function mom(overrides) {
  return {
    id: "X",
    name: "Test",
    neighborhood: "Kallio",
    coords: [60.1841, 24.9502],
    transport: ["walk"],
    maxTravel: 15,
    language: ["Finnish"],
    dob: "2025-07-01",
    ...overrides,
  };
}

test("haversineKm: distance between two identical points is zero", () => {
  assert.equal(Engine.haversineKm([60.18, 24.95], [60.18, 24.95]), 0);
});

test("haversineKm: rough sanity check against a known Helsinki distance", () => {
  // Kallio to Espoo keskus is roughly 17-18km as the crow flies.
  const km = Engine.haversineKm([60.1841, 24.9502], [60.2052, 24.6522]);
  assert.ok(km > 14 && km < 20, `expected ~14-20km, got ${km}`);
});

test("sharedModes: returns the intersection of two transport lists", () => {
  const a = mom({ transport: ["bus", "car"] });
  const b = mom({ transport: ["car", "walk"] });
  assert.deepEqual(Engine.sharedModes(a, b), ["car"]);
});

test("sharedModes: empty when no modes overlap", () => {
  const a = mom({ transport: ["bus"] });
  const b = mom({ transport: ["car"] });
  assert.deepEqual(Engine.sharedModes(a, b), []);
});

test("ageRangeMonths: zero for same-month babies", () => {
  const a = mom({ dob: "2025-07-05" });
  const b = mom({ dob: "2025-07-20" });
  assert.equal(Engine.ageRangeMonths([a, b]), 0);
});

test("ageRangeMonths: counts full calendar months apart, not days", () => {
  const a = mom({ dob: "2025-06-30" });
  const b = mom({ dob: "2025-09-01" });
  assert.equal(Engine.ageRangeMonths([a, b]), 3);
});

test("languageIntersection: finds a language common to everyone", () => {
  const a = mom({ language: ["Finnish", "English"] });
  const b = mom({ language: ["English", "Swedish"] });
  const c = mom({ language: ["English"] });
  assert.deepEqual([...Engine.languageIntersection([a, b, c])], ["English"]);
});

test("languageIntersection: empty set when there's no common language", () => {
  const a = mom({ language: ["Finnish"] });
  const b = mom({ language: ["Swedish"] });
  assert.equal(Engine.languageIntersection([a, b]).size, 0);
});

test("groupAgeRangeLabel: single label when all same month", () => {
  const a = mom({ dob: "2025-07-05" });
  const b = mom({ dob: "2025-07-20" });
  assert.equal(Engine.groupAgeRangeLabel([a, b]), "07.25");
});

test("groupAgeRangeLabel: range label when months differ", () => {
  const a = mom({ dob: "2025-06-01" });
  const b = mom({ dob: "2025-09-01" });
  assert.equal(Engine.groupAgeRangeLabel([a, b]), "06.25\u201309.25");
});

// A stub travel-time function standing in for the real API — every pair is
// "close" (5 minutes) unless explicitly listed as "far" (60 minutes), so
// tests are deterministic and don't depend on real coordinates.
function makeStubTravelTime(farPairs = []) {
  return (a, b, mode) => {
    const isFar = farPairs.some(([x, y]) => (a.id === x && b.id === y) || (a.id === y && b.id === x));
    return isFar ? 60 : 5;
  };
}

test("fitsGroup: passes when travel time, language, and age gap all check out", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A", dob: "2025-07-01", language: ["Finnish"] })];
  const candidate = mom({ id: "B", dob: "2025-08-01", language: ["Finnish"] });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime()), true);
});

test("fitsGroup: fails when travel time exceeds the cap", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A" })];
  const candidate = mom({ id: "B" });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime([["A", "B"]])), false);
});

test("fitsGroup: passes without shared transport modes when both can travel", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A", transport: ["bus"] })];
  const candidate = mom({ id: "B", transport: ["car"] });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime()), true);
});

test("fitsGroup: passes when each candidate has one viable mode among multiple", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A", transport: ["P", "W"], maxTravel: 30 })];
  const candidate = mom({ id: "B", transport: ["B", "W"], maxTravel: 15 });
  const travelTime = (a, b, mode) => {
    if (a.id === "A" && b.id === "B" && mode === "P") return 6;
    if (a.id === "B" && b.id === "A" && mode === "B") return 13;
    return 60;
  };

  assert.equal(Engine.fitsGroup(candidate, group, settings, travelTime), true);
});

test("fitsGroup: fails when no language is shared with the whole group", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A", language: ["Finnish"] })];
  const candidate = mom({ id: "B", language: ["Swedish"] });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime()), false);
});

test("fitsGroup: fails when age gap exceeds the configured maximum", () => {
  const settings = { maxAgeGap: 3 };
  const group = [mom({ id: "A", dob: "2025-01-01" })];
  const candidate = mom({ id: "B", dob: "2025-09-01" });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime()), false);
});

test("clusterGroups: forms one group of 3 from 3 mutually compatible moms", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 4, maxAgeGap: 6 };
  const pool = [
    mom({ id: "A", dob: "2025-07-01" }),
    mom({ id: "B", dob: "2025-07-15" }),
    mom({ id: "C", dob: "2025-08-01" }),
  ];
  const groups = Engine.clusterGroups(pool, settings, makeStubTravelTime());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});

test("clusterGroups: leaves people unmatched rather than forming an under-sized group", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 4, maxAgeGap: 6 };
  const pool = [mom({ id: "A" }), mom({ id: "B" })]; // only 2 — below minGroupSize
  const groups = Engine.clusterGroups(pool, settings, makeStubTravelTime());
  assert.equal(groups.length, 0);
});

test("clusterGroups: respects maxGroupSize even with more compatible people available", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 3, maxAgeGap: 6 };
  const pool = ["A", "B", "C", "D", "E"].map((id) => mom({ id, dob: "2025-07-01" }));
  const groups = Engine.clusterGroups(pool, settings, makeStubTravelTime());
  assert.equal(groups[0].length, 3, "first group should stop at maxGroupSize");
  assert.equal(groups.length, 1, "the leftover 2 people are below minGroupSize, so no second group forms");
});

test("clusterGroups: a person incompatible with the group (far away) is excluded from it", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 4, maxAgeGap: 6 };
  const pool = [mom({ id: "A" }), mom({ id: "B" }), mom({ id: "C" }), mom({ id: "D" })];
  // D is far from A specifically — should be excluded from A's group.
  const groups = Engine.clusterGroups(pool, settings, makeStubTravelTime([["A", "D"]]));
  assert.equal(groups.length, 1);
  assert.ok(!groups[0].some((m) => m.id === "D"), "D should not have joined A's group");
});

test("clusterGroups: adjustable min/max size changes the outcome (e.g. min 3 / max 6)", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 6, maxAgeGap: 6 };
  const pool = ["A", "B", "C", "D", "E", "F"].map((id) => mom({ id, dob: "2025-07-01" }));
  const groups = Engine.clusterGroups(pool, settings, makeStubTravelTime());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 6, "should grow all the way to the configured max of 6");
});

// Travel times keyed by the unordered pair, so a stub can grade pairs as
// "close" vs "just barely acceptable" rather than only pass/fail.
function makeGradedTravelTime(minutesByPair, fallback = 5) {
  return (a, b) => {
    const key = [a.id, b.id].sort().join("-");
    return key in minutesByPair ? minutesByPair[key] : fallback;
  };
}

test("travelScore: a group everyone can reach quickly beats a strained one", () => {
  const close   = [mom({ id: "A" }), mom({ id: "B" })];
  const strained = [mom({ id: "C" }), mom({ id: "D" })];
  const travel  = makeGradedTravelTime({ "A-B": 3, "C-D": 14 });
  assert.ok(
    Engine.travelScore(close, travel) > Engine.travelScore(strained, travel),
    "the closer pair should score higher"
  );
});

test("travelScore: measures each leg against that member's own limit", () => {
  // Same 10-minute journey, but B allows 60 minutes and D allows 12.
  const generous = [mom({ id: "A", maxTravel: 60 }), mom({ id: "B", maxTravel: 60 })];
  const tight    = [mom({ id: "C", maxTravel: 12 }), mom({ id: "D", maxTravel: 12 })];
  const travel   = makeGradedTravelTime({ "A-B": 10, "C-D": 10 });
  assert.ok(Engine.travelScore(generous, travel) > Engine.travelScore(tight, travel));
});

test("travelScore: scored on the worst pair, not the average", () => {
  const members = [mom({ id: "A" }), mom({ id: "B" }), mom({ id: "C" })];
  // A-B and A-C are instant, but B-C is a 30-minute door-to-door journey,
  // so each of them travels 15 minutes to meet — exactly their limit.
  const travel  = makeGradedTravelTime({ "A-B": 0, "A-C": 0, "B-C": 30 });
  assert.equal(Engine.travelScore(members, travel), 0);
});

test("meetingLegMinutes: halves the journey, since both sides travel to meet", () => {
  // 'walk' isn't a mode code, so there's no fixed overhead to preserve.
  assert.equal(Engine.meetingLegMinutes(30, "walk"), 15);
  assert.equal(Engine.meetingLegMinutes(0, "walk"), 0);
  assert.equal(Engine.meetingLegMinutes(Infinity, "walk"), Infinity);
});

test("meetingLegMinutes: fixed overhead is not halved", () => {
  // Public transport carries a 6-minute overhead: you walk to the stop and
  // wait for the bus whether you ride two stops or ten.
  assert.equal(Engine.meetingLegMinutes(30, "P"), 6 + 12);
  assert.equal(Engine.meetingLegMinutes(6, "P"), 6, "a journey no longer than the overhead can't shrink");
  assert.equal(Engine.meetingLegMinutes(4, "P"), 4, "nor can a shorter one");
  // Walking has no overhead, so it halves cleanly.
  assert.equal(Engine.meetingLegMinutes(30, "W"), 15);
});

// Door-to-door minutes that depend on the mode, the way real routing does:
// the same trip takes a walker much longer than a bus rider.
function makeModalTravelTime(minutesByMode) {
  return (a, b, mode) => (mode in minutesByMode ? minutesByMode[mode] : 60);
}

test("pairwiseTravelOk: different modes pair when each can reach the midpoint", () => {
  // Lisa's case: one mother walks up to 30 minutes, the other takes public
  // transport for up to 15. About 4km apart — a 53-minute walk or a 21-minute
  // bus ride door-to-door, so 27 minutes walking and 14 minutes riding to meet
  // halfway. Both inside their own limits, despite sharing no transport mode.
  const walker = mom({ id: "W1", transport: ["W"], maxTravel: 30 });
  const rider  = mom({ id: "P1", transport: ["P"], maxTravel: 15 });
  const travel = makeModalTravelTime({ W: 53, P: 21 });
  assert.equal(Engine.pairwiseTravelOk(walker, rider, {}, travel), true);
  // The old door-to-door rule rejected this: a 53-minute walk exceeded 30.
});

test("pairwiseTravelOk: still rejects a pair when one side can't reach halfway", () => {
  const walker = mom({ id: "W1", transport: ["W"], maxTravel: 30 });
  const rider  = mom({ id: "P1", transport: ["P"], maxTravel: 15 });
  // ~6km: an 80-minute walk is still 40 minutes to the midpoint.
  const travel = makeModalTravelTime({ W: 80, P: 28 });
  assert.equal(Engine.pairwiseTravelOk(walker, rider, {}, travel), false);
});

test("ageScore: a tighter age spread scores higher than one at the limit", () => {
  const settings = { maxAgeGap: 6 };
  const tight = [mom({ id: "A", dob: "2025-07-01" }), mom({ id: "B", dob: "2025-08-01" })];
  const wide  = [mom({ id: "C", dob: "2025-01-01" }), mom({ id: "D", dob: "2025-07-01" })];
  assert.ok(Engine.ageScore(tight, settings) > Engine.ageScore(wide, settings));
  assert.equal(Engine.ageScore(wide, settings), 0, "a group exactly at maxAgeGap scores 0");
});

test("languageScore: full overlap scores 1, a single common language out of two scores less", () => {
  const full = [
    mom({ id: "A", language: ["Finnish", "English"] }),
    mom({ id: "B", language: ["Finnish", "English"] }),
  ];
  const partial = [
    mom({ id: "C", language: ["Finnish", "English"] }),
    mom({ id: "D", language: ["Finnish", "Swedish"] }),
  ];
  assert.equal(Engine.languageScore(full), 1);
  assert.ok(Engine.languageScore(partial) < 1);
});

test("scoreGroup: total stays within 0..1 and combines all three signals", () => {
  const settings = { maxAgeGap: 6 };
  const members  = [mom({ id: "A" }), mom({ id: "B" })];
  const score    = Engine.scoreGroup(members, settings, makeGradedTravelTime({}));
  assert.ok(score.total >= 0 && score.total <= 1, `total out of range: ${score.total}`);
  const weights = Engine.SCORE_WEIGHTS;
  const expected =
    weights.travel * score.travel + weights.age * score.age + weights.language * score.language;
  assert.ok(Math.abs(score.total - expected) < 1e-9);
});

test("clusterGroups: best-fit picks the stronger candidate, not the first that fits", () => {
  const settings = { minGroupSize: 2, maxGroupSize: 2, maxAgeGap: 6 };
  const pool = [
    mom({ id: "A", dob: "2025-07-01" }),
    mom({ id: "B", dob: "2025-07-10" }), // earlier in iteration order, but far
    mom({ id: "C", dob: "2025-07-20" }), // later, but much closer
  ];
  // Both fit under the 15-minute cap; C is the better match.
  const travel = makeGradedTravelTime({ "A-B": 14, "A-C": 3 });
  const groups = Engine.clusterGroups(pool, settings, travel);
  assert.equal(groups[0].length, 2);
  assert.deepEqual(
    groups[0].map((m) => m.id).sort(),
    ["A", "C"],
    "A should pair with C, not with the first candidate that merely fits"
  );
});

test("clusterGroups: returns groups strongest first, not in seed order", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 3, maxAgeGap: 6 };
  // D/E/F seed first (earlier dobs) but are a strained group; A/B/C are tight.
  const pool = [
    mom({ id: "D", dob: "2025-06-01" }),
    mom({ id: "E", dob: "2025-06-05" }),
    mom({ id: "F", dob: "2025-06-10" }),
    mom({ id: "A", dob: "2025-07-01" }),
    mom({ id: "B", dob: "2025-07-05" }),
    mom({ id: "C", dob: "2025-07-10" }),
  ];
  const travel = makeGradedTravelTime(
    { "D-E": 14, "D-F": 14, "E-F": 14, "A-B": 2, "A-C": 2, "B-C": 2 },
    60 // any cross-cluster pair is unreachable, so the two groups stay separate
  );
  const groups = Engine.clusterGroups(pool, settings, travel);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((m) => m.id).sort(), ["A", "B", "C"], "tight group ranks first");
  assert.deepEqual(groups[1].map((m) => m.id).sort(), ["D", "E", "F"]);
});

test("clusterGroups: repeated runs over the same pool give the same result", () => {
  const settings = { minGroupSize: 3, maxGroupSize: 3, maxAgeGap: 6 };
  const pool = ["A", "B", "C", "D", "E", "F"].map((id) => mom({ id, dob: "2025-07-01" }));
  const ids = () =>
    Engine.clusterGroups(pool, settings, makeStubTravelTime()).map((g) => g.map((m) => m.id));
  assert.deepEqual(ids(), ids());
});

test("findReplacementCandidates: ranks and limits to 5 fitting candidates", () => {
  const settings = { maxAgeGap: 6 };
  const existingMembers = [mom({ id: "A", coords: [60.18, 24.95] })];
  const pool = ["B", "C", "D", "E", "F", "G"].map((id) =>
    mom({ id, coords: [60.18 + Math.random() * 0.01, 24.95 + Math.random() * 0.01] })
  );
  const results = Engine.findReplacementCandidates(existingMembers, pool, settings, makeStubTravelTime());
  assert.ok(results.length <= 5, "should never return more than 5 suggestions");
});

test("findReplacementCandidates: excludes candidates who don't actually fit", () => {
  const settings = { maxAgeGap: 6 };
  const existingMembers = [mom({ id: "A", language: ["Finnish"] })];
  const pool = [mom({ id: "B", language: ["Swedish"] })]; // no shared language
  const results = Engine.findReplacementCandidates(existingMembers, pool, settings, makeStubTravelTime());
  assert.equal(results.length, 0);
});
