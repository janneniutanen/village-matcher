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

test("fitsGroup: fails when there's no shared transport mode", () => {
  const settings = { maxAgeGap: 6 };
  const group = [mom({ id: "A", transport: ["bus"] })];
  const candidate = mom({ id: "B", transport: ["car"] });
  assert.equal(Engine.fitsGroup(candidate, group, settings, makeStubTravelTime()), false);
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
