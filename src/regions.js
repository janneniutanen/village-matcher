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

function districtCentre(neighborhood) {
  if (!neighborhood) return null;
  return DISTRICT_COORDS[String(neighborhood).trim()] || null;
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
  const want = streetName(requested);
  const got  = streetName(String(resolvedLabel || "").split(",")[0]);
  return want !== "" && got !== "" && want === got;
}

const Regions = {
  DISTRICT_COORDS,
  REGION_CENTRE,
  REGION_BOUNDS,
  DISTRICT_RADIUS_KM,
  districtCentre,
  distanceKm,
  withinDistrict,
  streetName,
  streetNameMatches,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Regions;
}
