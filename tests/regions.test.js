// Run with: node --test tests/regions.test.js
// Pure functions, no network — the live-API behaviour these guard against is
// documented in src/regions.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const Regions = require("../src/regions.js");

test("districtCentre: known districts resolve, unknown ones return null", () => {
  assert.deepEqual(Regions.districtCentre("Kallio"), [60.1841, 24.9502]);
  assert.deepEqual(Regions.districtCentre("  Kallio  "), [60.1841, 24.9502], "surrounding space is tolerated");
  assert.equal(Regions.districtCentre("Atlantis"), null);
  assert.equal(Regions.districtCentre(""), null);
  assert.equal(Regions.districtCentre(null), null);
});

test("districtCentre: covers every neighbourhood in the sample dataset", () => {
  const fs = require("fs");
  const path = require("path");
  const csv = fs.readFileSync(path.join(__dirname, "..", "mock-applicants.csv"), "utf8");
  const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
  const idx = rows[0].indexOf("Neighbourhood");
  const missing = [...new Set(rows.slice(1).map((r) => (r[idx] || "").trim()))]
    .filter((n) => n && !Regions.districtCentre(n));
  assert.deepEqual(missing, [], `districts without coordinates: ${missing.join(", ")}`);
});

test("withinDistrict: accepts nearby points, rejects far ones", () => {
  const kallio = Regions.districtCentre("Kallio");
  assert.equal(Regions.withinDistrict(kallio, [60.19, 24.95]), true);
  // Joensuu, ~400km away — the kind of match the geocoder returns at 0.96
  // confidence when it ignores the municipality.
  assert.equal(Regions.withinDistrict(kallio, [62.60, 29.76]), false);
  assert.equal(Regions.withinDistrict(null, [60.19, 24.95]), false, "no centre means nothing to verify against");
});

test("distanceKm: zero for identical points, sane for a known pair", () => {
  assert.equal(Regions.distanceKm([60.18, 24.95], [60.18, 24.95]), 0);
  const km = Regions.distanceKm([60.1841, 24.9502], [60.2052, 24.6522]);
  assert.ok(km > 14 && km < 20, `Kallio to Espoo keskus should be ~17km, got ${km}`);
});

test("streetName: house numbers and suffix letters are stripped", () => {
  assert.equal(Regions.streetName("Vaasankatu 5"), "vaasankatu");
  assert.equal(Regions.streetName("Vaasankatu 5 F"), "vaasankatu");
  assert.equal(Regions.streetName("Asematie 4 A"), "asematie");
  assert.equal(Regions.streetName("Munkkiniemen puistotie 12"), "munkkiniemen puistotie");
  assert.equal(Regions.streetName("Iso Roobertinkatu 9-11"), "iso roobertinkatu");
});

test("streetNameMatches: same street with a different number still matches", () => {
  // The geocoder returns the nearest known house number, which is fine.
  assert.equal(Regions.streetNameMatches("Kirkkojärventie 12", "Kirkkojärventie 10, Espoo"), true);
  assert.equal(Regions.streetNameMatches("Vaasankatu 5", "Vaasankatu 5 F, Helsinki"), true);
  assert.equal(Regions.streetNameMatches("Mosaiikkitori 3", "Mosaiikkitori 2, Helsinki"), true);
});

test("streetNameMatches: a fuzzy match to a different street is rejected", () => {
  // Regression: "Sellonkuja 4" resolved to "Elonkuja 4" — a real street inside
  // the right district, so the radius check alone let it through.
  assert.equal(Regions.streetNameMatches("Sellonkuja 4", "Elonkuja 4, Helsinki"), false);
  assert.equal(Regions.streetNameMatches("", "Elonkuja 4, Helsinki"), false);
  assert.equal(Regions.streetNameMatches("Sellonkuja 4", ""), false);
});
