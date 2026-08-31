// ============================================================================
// Village Matcher — Uusimaa district reference
//
// Centre coordinates for the districts and municipalities that appear in the
// Neighbourhood column. Two things need these:
//
//   1. Geocoding. Digitransit's geocoder happily ignores the municipality in
//      a query and fuzzy-matches the street name anywhere in Finland — asking
//      for "Jokikatu 11, Porvoo" returns Jokikatu 11 in Joensuu, 400km away,
//      at 0.96 confidence. Anchoring the search to the district centre and
//      rejecting anything outside a radius around it is what makes the result
//      trustworthy. Measured on a sample of 12 addresses: 9/9 correct when
//      anchored per district, 7/12 with a single region-wide anchor.
//   2. The offline dev geocoder in local-test-server.js, which places people
//      in roughly the right part of the map without any network calls.
//
// A district missing from this table is not a failure: geocoding falls back to
// the regional anchor and the result is flagged as unverified rather than
// silently trusted.
// ============================================================================

const DISTRICT_COORDS = {
  "Kallio"        : [60.1841, 24.9502],
  "Töölö"         : [60.1756, 24.9145],
  "Kamppi"        : [60.1687, 24.9316],
  "Kruununhaka"   : [60.1710, 24.9580],
  "Punavuori"     : [60.1620, 24.9350],
  "Pasila"        : [60.1990, 24.9330],
  "Herttoniemi"   : [60.1950, 25.0300],
  "Vuosaari"      : [60.2070, 25.1440],
  "Malmi"         : [60.2510, 25.0100],
  "Munkkiniemi"   : [60.1970, 24.8750],
  "Lauttasaari"   : [60.1590, 24.8790],
  "Oulunkylä"     : [60.2270, 24.9680],
  "Itäkeskus"     : [60.2100, 25.0800],
  "Kannelmäki"    : [60.2400, 24.8770],
  "Pihlajamäki"   : [60.2380, 24.9950],
  "Pukinmäki"     : [60.2440, 24.9930],
  "Espoon keskus" : [60.2052, 24.6522],
  "Tapiola"       : [60.1758, 24.8043],
  "Leppävaara"    : [60.2190, 24.8130],
  "Matinkylä"     : [60.1600, 24.7380],
  "Espoonlahti"   : [60.1490, 24.6560],
  "Otaniemi"      : [60.1841, 24.8301],
  "Soukka"        : [60.1420, 24.6890],
  "Kauklahti"     : [60.1880, 24.6100],
  "Kauniainen"    : [60.2110, 24.7280],
  "Tikkurila"     : [60.2920, 25.0400],
  "Myyrmäki"      : [60.2610, 24.8540],
  "Korso"         : [60.3520, 25.0640],
  "Aviapolis"     : [60.3120, 24.9640],
  "Hakunila"      : [60.2740, 25.0940],
  "Martinlaakso"  : [60.2760, 24.8460],
  "Kirkkonummi"   : [60.1230, 24.4400],
  "Kerava"        : [60.4030, 25.1030],
  "Järvenpää"     : [60.4730, 25.0890],
  "Tuusula"       : [60.4030, 25.0290],
  "Nurmijärvi"    : [60.4640, 24.8080],
  "Hyvinkää"      : [60.6310, 24.8600],
  "Porvoo"        : [60.3930, 25.6650],
  "Lohja"         : [60.2500, 24.0650],
  "Vihti"         : [60.4170, 24.3200],
  "Sipoo"         : [60.3760, 25.2680],
  "Mäntsälä"      : [60.6330, 25.3170],
  "Karkkila"      : [60.5340, 24.2100],
  "Raasepori"     : [59.9760, 23.4360],
  "Hanko"         : [59.8230, 22.9680],
  "Inkoo"         : [60.0450, 24.0060],
  "Siuntio"       : [60.1450, 24.2280],
  "Pornainen"     : [60.4750, 25.3750],
  "Askola"        : [60.5300, 25.6000],
  "Loviisa"       : [60.4570, 26.2250],
};

// Fallback anchor and outer bound for addresses whose district isn't listed.
const REGION_CENTRE = [60.1699, 24.9384];
const REGION_BOUNDS = { minLat: 59.78, maxLat: 60.72, minLon: 22.85, maxLon: 26.35 };

// How far a geocoded address may sit from its district centre before we stop
// believing it. Generous enough for large municipalities like Nurmijärvi,
// where the measured spread between centre and a real address was 8.9km.
const DISTRICT_RADIUS_KM = 12;

// Municipality-level anchors, for when the Neighbourhood column holds a city
// rather than a district — "Helsinki" instead of "Kallio". Coarser than a
// district, so they get a wider radius.
const MUNICIPALITY_COORDS = {
  "Helsinki": [60.1699, 24.9384],
  "Espoo":    [60.2055, 24.6559],
  "Vantaa":   [60.2934, 25.0378],
};
const MUNICIPALITY_RADIUS_KM = 22;

// Lookup index that tolerates how the column is actually filled in: any case,
// stray punctuation, a postal code, or a district and city written together.
const INDEX = new Map();
function indexKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\b\d{5}\b/g, " ")   // postal code
    .replace(/[.,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Scandinavian letters are routinely typed without their diacritics, so
// "toolo" has to find Töölö. Both spellings are indexed.
function foldedKey(value) {
  return indexKey(value).replace(/[äå]/g, "a").replace(/ö/g, "o");
}
function addToIndex(name, coords, radiusKm) {
  const entry = { name, coords, radiusKm };
  for (const key of [indexKey(name), foldedKey(name)]) {
    if (key && !INDEX.has(key)) INDEX.set(key, entry);
  }
}
Object.entries(DISTRICT_COORDS).forEach(([name, coords]) => addToIndex(name, coords, DISTRICT_RADIUS_KM));
Object.entries(MUNICIPALITY_COORDS).forEach(([name, coords]) => addToIndex(name, coords, MUNICIPALITY_RADIUS_KM));
// A couple of spellings that come up but aren't the official form.
[["espoo keskus", "Espoon keskus"], ["helsingfors", "Helsinki"], ["esbo", "Espoo"], ["vanda", "Vantaa"]]
  .forEach(([alias, target]) => {
    const hit = INDEX.get(indexKey(target));
    if (hit) INDEX.set(alias, hit);
  });

// Resolves the Neighbourhood cell to something to anchor the geocoder on.
// Tries the whole value first, then each comma- or slash-separated part, so
// "Helsinki, Kallio" anchors on Kallio (the more specific of the two) rather
// than the city centre.
function resolveDistrict(neighborhood) {
  if (!neighborhood) return null;
  const lookup = (value) => INDEX.get(indexKey(value)) || INDEX.get(foldedKey(value));

  const whole = lookup(neighborhood);
  if (whole) return whole;

  // "Helsinki, Kallio" and "Kallio (Helsinki)" both name two places; take each
  // in turn and prefer the district, since it anchors more tightly.
  const parts = String(neighborhood).split(/[,/|()]/).map((p) => p.trim()).filter(Boolean);
  const hits = parts.map(lookup).filter(Boolean);
  return hits.find((h) => h.radiusKm === DISTRICT_RADIUS_KM) || hits[0] || null;
}

function districtCentre(neighborhood) {
  const hit = resolveDistrict(neighborhood);
  return hit ? hit.coords : null;
}

// Apartment, stair and care-of markers. Everything from here on is about who
// lives there, not where the building is, and including it makes the geocoder
// miss — "Vaasankatu 5 as 3" finds nothing while "Vaasankatu 5" is exact.
const APARTMENT_MARKER = /\b(as|asunto|asuinto|bst|bostad|lgh|rappu|rp|huoneisto|huon|kerros|krs)\b\.?/i;
const CARE_OF_MARKER = /\bc\s*[/\\]\s*o\b|\bc\.o\.|\bco\b/i;

// Reduces a messy cell to just the street and house number the geocoder can
// use. The original is never overwritten — the organizer still sees what she
// typed; only the query is cleaned.
function normalizeStreet(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  // A postal code and city, or an apartment written after a comma, both land
  // in later segments. The street is always first.
  s = s.split(",")[0];
  s = s.replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();

  for (const marker of [CARE_OF_MARKER, APARTMENT_MARKER]) {
    const m = s.match(marker);
    if (m) s = s.slice(0, m.index).trim();
  }

  // "Vaasankatu5" -> "Vaasankatu 5"
  s = s.replace(/([a-zäöåA-ZÄÖÅ])(\d)/g, "$1 $2");

  // Keep the street name, the house number, and a single suffix letter.
  // Anything after that is a range end or an apartment number.
  const m = s.match(/^(.*?)\s+(\d+)\s*([a-zäöå])?(?![a-zäöå0-9])/i);
  if (m) {
    const [, name, number, letter] = m;
    const kept = letter ? `${name} ${number} ${letter.toUpperCase()}` : `${name} ${number}`;
    return kept.replace(/\s+/g, " ").trim();
  }
  return s.replace(/[.\s]+$/, "");
}

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function withinDistrict(centre, point) {
  return !!centre && distanceKm(centre, point) <= DISTRICT_RADIUS_KM;
}

// Strips the house number so two spellings of the same street compare equal:
// "Vaasankatu 5" and "Vaasankatu 5 F" both reduce to "vaasankatu".
function streetName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+\d+\s*[a-zäöå]?(\s*[-–]\s*\d+)?(\s+\d+)?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The geocoder also fuzzy-matches street names, so a request for a street that
// doesn't exist can come back as a different, real street inside the right
// district — "Sellonkuja 4" resolving to "Elonkuja 4". Being in the right area
// isn't enough; the street has to be the one that was asked for. Differing
// house numbers are fine, since the geocoder returns the nearest known number.
function streetNameMatches(requested, resolvedLabel) {
  const want = streetName(normalizeStreet(requested));
  const got  = streetName(String(resolvedLabel || "").split(",")[0]);
  if (want === "" || got === "") return false;
  if (want === got) return true;

  // "Vaasank. 5" is a normal way to write Vaasankatu, and the geocoder expands
  // it correctly, so an abbreviated request may match the full name by prefix.
  // Requiring five characters keeps this from accepting unrelated streets:
  // "Elonkuja" is still not a prefix of "Sellonkuja".
  const [shorter, longer] = want.length <= got.length ? [want, got] : [got, want];
  return shorter.length >= 5 && longer.startsWith(shorter);
}

const Regions = {
  DISTRICT_COORDS,
  REGION_CENTRE,
  REGION_BOUNDS,
  DISTRICT_RADIUS_KM,
  districtCentre,
  resolveDistrict,
  normalizeStreet,
  MUNICIPALITY_COORDS,
  MUNICIPALITY_RADIUS_KM,
  distanceKm,
  withinDistrict,
  streetName,
  streetNameMatches,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Regions;
}
