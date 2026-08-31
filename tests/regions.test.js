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

test("normalizeStreet: apartment, stair and care-of details are dropped", () => {
  // These make the geocoder miss entirely: "Vaasankatu 5 as 3" finds nothing
  // while "Vaasankatu 5" is exact.
  assert.equal(Regions.normalizeStreet("Vaasankatu 5 as 3"), "Vaasankatu 5");
  assert.equal(Regions.normalizeStreet("Vaasankatu 5, as. 12"), "Vaasankatu 5");
  assert.equal(Regions.normalizeStreet("Vaasankatu 5 rappu B"), "Vaasankatu 5");
  assert.equal(Regions.normalizeStreet("Museokatu 15 krs 3"), "Museokatu 15");
  assert.equal(Regions.normalizeStreet("Vaasankatu 5 c/o Virtanen"), "Vaasankatu 5");
});

test("normalizeStreet: a house-number suffix letter is kept, an apartment number is not", () => {
  assert.equal(Regions.normalizeStreet("Vaasankatu 5 A 12"), "Vaasankatu 5 A");
  assert.equal(Regions.normalizeStreet("Munkkiniemen puistotie 12 A 4"), "Munkkiniemen puistotie 12 A");
});

test("normalizeStreet: postal code and city after a comma are dropped", () => {
  assert.equal(Regions.normalizeStreet("Vaasankatu 5, 00500 Helsinki"), "Vaasankatu 5");
});

test("normalizeStreet: spacing, punctuation and ranges are tidied", () => {
  assert.equal(Regions.normalizeStreet("Vaasankatu5"), "Vaasankatu 5", "missing space is inserted");
  assert.equal(Regions.normalizeStreet("Vaasankatu  5"), "Vaasankatu 5");
  assert.equal(Regions.normalizeStreet("Vaasankatu 5."), "Vaasankatu 5");
  assert.equal(Regions.normalizeStreet("Vaasankatu 5-7"), "Vaasankatu 5", "a range keeps its first number");
});

test("normalizeStreet: multi-word street names survive intact", () => {
  assert.equal(Regions.normalizeStreet("Iso Roobertinkatu 9"), "Iso Roobertinkatu 9");
  assert.equal(Regions.normalizeStreet("Munkkiniemen puistotie 12"), "Munkkiniemen puistotie 12");
  // "Askolantie" must not be mistaken for an "as" apartment marker.
  assert.equal(Regions.normalizeStreet("Askolantie 5"), "Askolantie 5");
});

test("normalizeStreet: blank and unparseable input never throws", () => {
  assert.equal(Regions.normalizeStreet(""), "");
  assert.equal(Regions.normalizeStreet(null), "");
  assert.equal(Regions.normalizeStreet("no number here"), "no number here");
});

test("resolveDistrict: tolerates case, diacritics, postal codes and combined names", () => {
  assert.equal(Regions.resolveDistrict("kallio").name, "Kallio");
  assert.equal(Regions.resolveDistrict("KALLIO").name, "Kallio");
  assert.equal(Regions.resolveDistrict("toolo").name, "Töölö", "typed without diacritics");
  assert.equal(Regions.resolveDistrict("Nurmijarvi").name, "Nurmijärvi");
  assert.equal(Regions.resolveDistrict("00500 Helsinki").name, "Helsinki");
  assert.equal(Regions.resolveDistrict("Helsingfors").name, "Helsinki");
  assert.equal(Regions.resolveDistrict("espoon keskus").name, "Espoon keskus");
});

test("resolveDistrict: prefers the district when a district and city are both given", () => {
  // Anchoring on Kallio is tighter than anchoring on Helsinki.
  assert.equal(Regions.resolveDistrict("Helsinki, Kallio").name, "Kallio");
  assert.equal(Regions.resolveDistrict("Kallio (Helsinki)").name, "Kallio");
  assert.equal(Regions.resolveDistrict("Kallio, Helsinki").radiusKm, Regions.DISTRICT_RADIUS_KM);
});

test("resolveDistrict: a city alone resolves, with a wider radius than a district", () => {
  const city = Regions.resolveDistrict("Helsinki");
  assert.equal(city.name, "Helsinki");
  assert.ok(city.radiusKm > Regions.DISTRICT_RADIUS_KM);
});

test("resolveDistrict: an unknown place stays unresolved rather than guessing", () => {
  assert.equal(Regions.resolveDistrict("Atlantis"), null);
  assert.equal(Regions.resolveDistrict(""), null);
  assert.equal(Regions.resolveDistrict(null), null);
});

test("streetNameMatches: an abbreviated street matches the expanded name", () => {
  assert.equal(Regions.streetNameMatches("Vaasank. 5", "Vaasankatu 5 F, Helsinki"), true);
  // Prefix leniency must not accept an unrelated street.
  assert.equal(Regions.streetNameMatches("Sellonkuja 4", "Elonkuja 4, Helsinki"), false);
});

test("streetNameMatches: messy input is sanitised before comparison", () => {
  assert.equal(Regions.streetNameMatches("Vaasankatu 5 as 3", "Vaasankatu 5, Helsinki"), true);
  assert.equal(Regions.streetNameMatches("Vaasankatu5", "Vaasankatu 5 F, Helsinki"), true);
  assert.equal(Regions.streetNameMatches("Vaasankatu 5, 00500 Helsinki", "Vaasankatu 5, Helsinki"), true);
});
