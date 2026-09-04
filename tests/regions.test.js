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

test("withinAnchor: accepts nearby points, rejects far ones", () => {
  const kallio = Regions.resolveDistrict("Kallio");
  assert.equal(Regions.withinAnchor(kallio, [60.19, 24.95]), true);
  // Joensuu, ~400km away — the kind of match the geocoder returns at 0.96
  // confidence when it ignores the municipality.
  assert.equal(Regions.withinAnchor(kallio, [62.60, 29.76]), false);
  assert.equal(Regions.withinAnchor(null, [60.19, 24.95]), false, "no anchor means nothing to verify against");
});

test("withinAnchor: a municipality anchor uses its own wider radius", () => {
  // Vuosaari is ~13km from Helsinki centre: outside a district radius, but
  // inside Helsinki, so "Helsinki" as the neighbourhood must still accept it.
  const city = Regions.resolveDistrict("Helsinki");
  const district = Regions.resolveDistrict("Kallio");
  const vuosaari = Regions.DISTRICT_COORDS["Vuosaari"];
  assert.equal(Regions.withinAnchor(city, vuosaari), true, "city radius should reach Vuosaari");
  assert.equal(Regions.withinAnchor(district, [59.90, 23.50]), false, "district radius must stay tight");
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

test("normalizeStreet: numbered and ordinal street names survive", () => {
  // Kallio has "Kolmas linja" and neighbours; people also write these as
  // ordinals, and the leading number must not be read as a house number.
  assert.equal(Regions.normalizeStreet("Kolmas linja 5"), "Kolmas linja 5");
  assert.equal(Regions.normalizeStreet("3. linja 5"), "3. linja 5");
  assert.equal(Regions.normalizeStreet("3. linja 5 as 2"), "3. linja 5");
  assert.equal(Regions.streetNameMatches("Kolmas linja 5", "Kolmas linja 7, Helsinki"), true);
});

// ---------------------------------------------------------------------------
// Candidate verification: the logic that replaced the Uusimaa radius check.
// These are the cases Lisa hit when the tool was pointed at Tampere.
// ---------------------------------------------------------------------------

function candidate(label, fields = {}) {
  return {
    lat: fields.lat ?? 61.4978, lon: fields.lon ?? 23.7610,
    label,
    localadmin: fields.localadmin ?? null,
    locality: fields.locality ?? null,
    neighbourhood: fields.neighbourhood ?? null,
    borough: fields.borough ?? null,
    confidence: fields.confidence ?? 0.9,
  };
}

test("pickBestCandidate: the same street in another city is rejected", () => {
  // Hämeenkatu is in Tampere, Turku and Hyvinkää.
  const hyvinkaa = candidate("Hämeenkatu 12, Hyvinkää", { localadmin: "Hyvinkää", confidence: 1 });
  const tampere  = candidate("Hämeenkatu 12, Tampere",  { localadmin: "Tampere", confidence: 0.8 });

  const request = { street: "Hämeenkatu 12", area: "Tampere", municipality: "Tampere" };
  assert.equal(Regions.scoreCandidate(request, hyvinkaa), null);
  assert.equal(Regions.pickBestCandidate(request, [hyvinkaa, tampere]).label, "Hämeenkatu 12, Tampere");
});

test("pickBestCandidate: a fuzzy street match inside the right city is still rejected", () => {
  // The geocoder answered Hirvikummuntie with Hirvikatu, a real street in the
  // right municipality.
  const request = { street: "Hirvikummuntie 5", area: "Tampere", municipality: "Tampere" };
  const wrongStreet = candidate("Hirvikatu 5, Tampere", { localadmin: "Tampere", confidence: 0.94 });
  assert.equal(Regions.pickBestCandidate(request, [wrongStreet]), null);
});

test("pickBestCandidate: the postal town does not stand in for the municipality", () => {
  // Parts of Kangasala carry a Tampere postal town, so `locality` disagrees
  // with `localadmin`. Trusting locality put them on the map as Tampere.
  const kangasala = candidate("Holvastintie 6, Kangasala", { localadmin: "Kangasala", locality: "Tampere" });
  const request = { street: "Holvastintie 6", area: "Linnainmaa", municipality: "Tampere" };
  assert.equal(Regions.pickBestCandidate(request, [kangasala]), null);

  const asked = { street: "Holvastintie 6", area: "Kangasala", municipality: "Kangasala" };
  assert.ok(Regions.pickBestCandidate(asked, [kangasala]));
});

test("pickBestCandidate: a district with no known municipality verifies on its own name", () => {
  // Not a municipality, but the hit carries it as a neighbourhood.
  const request = { street: "Insinöörinkatu 60", area: "Hervanta", municipality: null };
  const right = candidate("Insinöörinkatu 60, Tampere", { localadmin: "Tampere", neighbourhood: "Hervanta" });
  const wrong = candidate("Insinöörinkatu 16, Helsinki", { localadmin: "Helsinki", neighbourhood: "Herttoniemi" });
  assert.equal(Regions.pickBestCandidate(request, [wrong]), null);
  assert.equal(Regions.pickBestCandidate(request, [right, wrong]).label, "Insinöörinkatu 60, Tampere");
});

test("pickBestCandidate: nothing to verify against means no answer, not a guess", () => {
  const nowhere = candidate("Hämeenkatu 12, Hyvinkää", { localadmin: "Hyvinkää" });
  assert.equal(Regions.pickBestCandidate({ street: "Hämeenkatu 12", area: "", municipality: null }, [nowhere]), null);
});

test("pickBestCandidate: the closest house number on the right street wins", () => {
  // Pelias ranks by text similarity and offered house 9 for a request for 59,
  // the right street 700m away.
  const request = { street: "Munkkiniemen puistotie 59", area: "Munkkiniemi", municipality: "Helsinki" };
  const nine = candidate("Munkkiniemen puistotie 9, Helsinki",  { localadmin: "Helsinki", confidence: 0.96, lat: 60.1970, lon: 24.8750 });
  const fifty = candidate("Munkkiniemen puistotie 57, Helsinki", { localadmin: "Helsinki", confidence: 0.90, lat: 60.1970, lon: 24.8750 });
  assert.equal(Regions.pickBestCandidate(request, [nine, fifty]).label, "Munkkiniemen puistotie 57, Helsinki");
});

test("pickBestCandidate: an exact house number reports itself as exact", () => {
  const request = { street: "Hämeenkatu 12", area: "Tampere", municipality: "Tampere" };
  const best = Regions.pickBestCandidate(request, [candidate("Hämeenkatu 12, Tampere", { localadmin: "Tampere" })]);
  assert.equal(best.exactHouseNumber, true);
  assert.equal(best.houseDelta, 0);
});

test("pickBestCandidate: a coordinate outside Finland is never believed", () => {
  const request = { street: "Hämeenkatu 12", area: "Tampere", municipality: "Tampere" };
  const abroad = candidate("Hämeenkatu 12, Tampere", { localadmin: "Tampere", lat: 52.5, lon: 13.4 });
  assert.equal(Regions.pickBestCandidate(request, [abroad]), null);
});

test("municipalityOf: a district resolves to its city, an unknown place to null", () => {
  assert.equal(Regions.municipalityOf("Hervanta"), "Tampere");
  assert.equal(Regions.municipalityOf("Kaleva"), "Tampere");
  assert.equal(Regions.municipalityOf("Kallio"), "Helsinki");
  assert.equal(Regions.municipalityOf("Tapiola"), "Espoo");
  assert.equal(Regions.municipalityOf("Kangasala"), "Kangasala");
  assert.equal(Regions.municipalityOf("Atlantis"), null);
});

test("placeNameMatches: diacritics typed away still match", () => {
  assert.equal(Regions.placeNameMatches("Ylojarvi", "Ylöjärvi"), true);
  assert.equal(Regions.placeNameMatches("TAMPERE", "Tampere"), true);
  assert.equal(Regions.placeNameMatches("Tampere", "Kangasala"), false);
  assert.equal(Regions.placeNameMatches("Tampere", null), false);
});

test("houseNumber: reads the house number, not a number in the street name", () => {
  assert.equal(Regions.houseNumber("Hämeenkatu 12"), 12);
  assert.equal(Regions.houseNumber("3. linja 5"), 5);
  assert.equal(Regions.houseNumber("Hämeenkatu 12, Tampere"), 12);
  assert.equal(Regions.houseNumber("Hämeenkatu"), null);
});

test("the geocoder is never constrained to one region", () => {
  // A Uusimaa bounding box handed to the geocoder as a hard filter is what put
  // Tampere applicants in Helsinki. Only national bounds may be exposed.
  assert.equal(Regions.REGION_BOUNDS, undefined);
  assert.ok(Regions.COUNTRY_BOUNDS.maxLat > 69, "must reach Lapland");
  assert.ok(Regions.withinCountry([61.4978, 23.7610]), "Tampere is in Finland");
  assert.ok(Regions.withinCountry([65.0121, 25.4651]), "Oulu is in Finland");
  assert.equal(Regions.withinCountry([59.4370, 24.7536]), false, "Tallinn is not");
});

test("the sample dataset spans more than one municipality", () => {
  // A sample covering only Uusimaa would let the regression back in unnoticed.
  const fs = require("fs");
  const path = require("path");
  const csv = fs.readFileSync(path.join(__dirname, "..", "mock-applicants.csv"), "utf8");
  const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
  const idx = rows[0].indexOf("Neighbourhood");
  const cities = new Set(rows.slice(1)
    .map((r) => Regions.municipalityOf((r[idx] || "").trim()))
    .filter(Boolean));
  assert.ok(cities.size >= 10, `sample covers only ${cities.size} municipalities: ${[...cities].join(", ")}`);
  assert.ok(cities.has("Tampere"), "Tampere is the region this was reported from");
  assert.ok(cities.has("Helsinki"), "the original region must stay covered");
});

test("streetNameMatches: a renamed street matches its former name in brackets", () => {
  // The register keeps the old name alongside the new one. Refusing this
  // dropped a real applicant off the map.
  assert.equal(
    Regions.streetNameMatches("Latokartanontie 12", "Vanha Helsingintie 11 (Latokartanontie 11), Helsinki"),
    true
  );
  assert.equal(
    Regions.streetNameMatches("Vanha Helsingintie 11", "Vanha Helsingintie 11 (Latokartanontie 11), Helsinki"),
    true
  );
  assert.equal(
    Regions.streetNameMatches("Sellonkuja 4", "Vanha Helsingintie 11 (Latokartanontie 11), Helsinki"),
    false
  );
});

test("pickBestCandidate: a hit with no municipality field is not verified against the postal town", () => {
  // The check used to read `localadmin || locality`, so a hit missing
  // `localadmin` fell back to the postal town.
  const postalOnly = candidate("Holvastintie 6, Kangasala", { localadmin: null, locality: "Tampere" });
  const request = { street: "Holvastintie 6", area: "Linnainmaa", municipality: "Tampere" };
  assert.equal(Regions.pickBestCandidate(request, [postalOnly]), null);
});

test("pickBestCandidate: a hit with no municipality field can still match on its area name", () => {
  // Degrading to the area-name check is intended, so a sparse feature does
  // not drop someone off the map.
  const sparse = candidate("Insinöörinkatu 60, Tampere", { localadmin: null, neighbourhood: "Hervanta" });
  const matching = { street: "Insinöörinkatu 60", area: "Hervanta", municipality: "Tampere" };
  assert.ok(Regions.pickBestCandidate(matching, [sparse]), "the area name on the hit is evidence enough");

  const mismatching = { street: "Insinöörinkatu 60", area: "Kaleva", municipality: "Tampere" };
  assert.equal(Regions.pickBestCandidate(mismatching, [sparse]), null, "a different district is not evidence");
});

test("streetNameMatches: prefix leniency does not accept a different compound street", () => {
  // Finnish street names compound heavily, and the old five-character-stem
  // rule accepted outright different streets in the right city.
  assert.equal(Regions.streetNameMatches("Kauppatori 5", "Kauppatorinkatu 5, Turku"), false);
  assert.equal(Regions.streetNameMatches("Rantatie 10", "Rantatiensuu 10, Nokia"), false);
  assert.equal(Regions.streetNameMatches("Hämeenkatu 12", "Hämeenkatuaukio 12, Tampere"), false);
  assert.equal(Regions.streetNameMatches("Puistotie 4", "Puistotienhaara 4, Espoo"), false);
  // The reverse direction too.
  assert.equal(Regions.streetNameMatches("Kauppatorinkatu 5", "Kauppatori 5, Turku"), false);
});

test("streetNameMatches: an abbreviation is still expanded", () => {
  assert.equal(Regions.streetNameMatches("Vaasank. 5", "Vaasankatu 5 F, Helsinki"), true);
  assert.equal(Regions.streetNameMatches("Mannerheimint. 10", "Mannerheimintie 10, Helsinki"), true);
});

test("looksAbbreviated: a truncation, not an ordinal", () => {
  assert.equal(Regions.looksAbbreviated("Vaasank. 5"), true);
  assert.equal(Regions.looksAbbreviated("Vaasankatu 5"), false);
  // "3. linja" is a real street name, not a shortened one.
  assert.equal(Regions.looksAbbreviated("3. linja 5"), false);
  assert.equal(Regions.looksAbbreviated(""), false);
});
