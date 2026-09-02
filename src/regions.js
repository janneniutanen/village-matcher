// ============================================================================
// Village Matcher: Finnish place reference
//
// Everything here exists to answer one question: given a street the organizer
// typed and an area name next to it, which of the many Finnish addresses that
// fuzzy-match that street is the right one?
//
// Digitransit's geocoder is a Pelias instance over the national address
// register. It covers all of Finland, but it treats the whole query as free
// text: it will happily ignore the municipality and return a street of a
// similar name 400km away at 0.96 confidence. So the confidence score cannot
// be trusted, and the work of picking the right hit is ours.
//
// The rule this module encodes: a hit is only believable if the MUNICIPALITY
// matches. Street names repeat across Finland (Hämeenkatu exists in Tampere
// and Hyvinkää; Hirvikummuntie in Kangasala and Tervola) but they are
// effectively unique within a municipality, so the municipality is the
// disambiguator that actually works. Radius checks against hand-kept
// coordinates were the previous approach and they do not survive the move out
// of Uusimaa (see the note on COUNTRY_BOUNDS below).
//
// The coordinate tables are NOT the verification mechanism any more. They are
// used for two narrower jobs: biasing the geocoder's ranking towards the right
// part of the country, and letting the offline dev geocoder in
// local-test-server.js place people without any network calls. A place missing
// from them is not a failure; the live path resolves municipalities from the
// geocoder itself.
// ============================================================================

// City districts, with the municipality each one belongs to. The parent is the
// load-bearing half: it turns "Hervanta" into "Tampere", which is what a hit
// gets verified against.
const DISTRICTS = {
  // Helsinki
  "Kallio"        : { coords: [60.1841, 24.9502], municipality: "Helsinki" },
  "Töölö"         : { coords: [60.1756, 24.9145], municipality: "Helsinki" },
  "Kamppi"        : { coords: [60.1687, 24.9316], municipality: "Helsinki" },
  "Kruununhaka"   : { coords: [60.1710, 24.9580], municipality: "Helsinki" },
  "Punavuori"     : { coords: [60.1620, 24.9350], municipality: "Helsinki" },
  "Pasila"        : { coords: [60.1990, 24.9330], municipality: "Helsinki" },
  "Herttoniemi"   : { coords: [60.1950, 25.0300], municipality: "Helsinki" },
  "Vuosaari"      : { coords: [60.2070, 25.1440], municipality: "Helsinki" },
  "Malmi"         : { coords: [60.2510, 25.0100], municipality: "Helsinki" },
  "Munkkiniemi"   : { coords: [60.1970, 24.8750], municipality: "Helsinki" },
  "Lauttasaari"   : { coords: [60.1590, 24.8790], municipality: "Helsinki" },
  "Oulunkylä"     : { coords: [60.2270, 24.9680], municipality: "Helsinki" },
  "Itäkeskus"     : { coords: [60.2100, 25.0800], municipality: "Helsinki" },
  "Kannelmäki"    : { coords: [60.2400, 24.8770], municipality: "Helsinki" },
  "Pihlajamäki"   : { coords: [60.2380, 24.9950], municipality: "Helsinki" },
  "Pukinmäki"     : { coords: [60.2440, 24.9930], municipality: "Helsinki" },
  // Espoo
  "Espoon keskus" : { coords: [60.2052, 24.6522], municipality: "Espoo" },
  "Tapiola"       : { coords: [60.1758, 24.8043], municipality: "Espoo" },
  "Leppävaara"    : { coords: [60.2190, 24.8130], municipality: "Espoo" },
  "Matinkylä"     : { coords: [60.1600, 24.7380], municipality: "Espoo" },
  "Espoonlahti"   : { coords: [60.1490, 24.6560], municipality: "Espoo" },
  "Otaniemi"      : { coords: [60.1841, 24.8301], municipality: "Espoo" },
  "Soukka"        : { coords: [60.1420, 24.6890], municipality: "Espoo" },
  "Kauklahti"     : { coords: [60.1880, 24.6100], municipality: "Espoo" },
  // Vantaa
  "Tikkurila"     : { coords: [60.2920, 25.0400], municipality: "Vantaa" },
  "Myyrmäki"      : { coords: [60.2610, 24.8540], municipality: "Vantaa" },
  "Korso"         : { coords: [60.3520, 25.0640], municipality: "Vantaa" },
  "Aviapolis"     : { coords: [60.3120, 24.9640], municipality: "Vantaa" },
  "Hakunila"      : { coords: [60.2740, 25.0940], municipality: "Vantaa" },
  "Martinlaakso"  : { coords: [60.2760, 24.8460], municipality: "Vantaa" },
  // Tampere, the region this tool is being rolled out to next, so its
  // districts are worth having by name rather than leaning on the geocoder.
  "Keskusta"      : { coords: [61.4978, 23.7610], municipality: "Tampere" },
  "Kyttälä"       : { coords: [61.4960, 23.7720], municipality: "Tampere" },
  "Tammela"       : { coords: [61.5010, 23.7780], municipality: "Tampere" },
  "Amuri"         : { coords: [61.4990, 23.7440], municipality: "Tampere" },
  "Pyynikki"      : { coords: [61.4930, 23.7300], municipality: "Tampere" },
  "Pispala"       : { coords: [61.4950, 23.7120], municipality: "Tampere" },
  "Hervanta"      : { coords: [61.4490, 23.8500], municipality: "Tampere" },
  "Kaleva"        : { coords: [61.4970, 23.8020], municipality: "Tampere" },
  "Kaukajärvi"    : { coords: [61.4740, 23.9040], municipality: "Tampere" },
  "Linnainmaa"    : { coords: [61.4930, 23.8790], municipality: "Tampere" },
  "Atala"         : { coords: [61.5100, 23.8890], municipality: "Tampere" },
  "Messukylä"     : { coords: [61.4960, 23.8500], municipality: "Tampere" },
  "Lielahti"      : { coords: [61.5150, 23.6820], municipality: "Tampere" },
  "Tesoma"        : { coords: [61.4930, 23.6560], municipality: "Tampere" },
  "Hatanpää"      : { coords: [61.4770, 23.7740], municipality: "Tampere" },
  "Härmälä"       : { coords: [61.4610, 23.7500], municipality: "Tampere" },
  "Nekala"        : { coords: [61.4790, 23.7900], municipality: "Tampere" },
  "Vuores"        : { coords: [61.4300, 23.8100], municipality: "Tampere" },
  "Peltolammi"    : { coords: [61.4560, 23.7810], municipality: "Tampere" },
  "Lentävänniemi" : { coords: [61.5250, 23.6560], municipality: "Tampere" },
  "Kissanmaa"     : { coords: [61.5010, 23.8130], municipality: "Tampere" },
  "Petsamo"       : { coords: [61.5060, 23.7880], municipality: "Tampere" },
  "Järvensivu"    : { coords: [61.4880, 23.7960], municipality: "Tampere" },
  "Rahola"        : { coords: [61.4820, 23.6700], municipality: "Tampere" },
  "Epilä"         : { coords: [61.4980, 23.6900], municipality: "Tampere" },
  "Multisilta"    : { coords: [61.4450, 23.7900], municipality: "Tampere" },
  "Annala"        : { coords: [61.5060, 23.8420], municipality: "Tampere" },
  // Turku
  "Kaarinan keskusta": { coords: [60.4070, 22.3700], municipality: "Kaarina" },
  "Varissuo"      : { coords: [60.4530, 22.3620], municipality: "Turku" },
  "Runosmäki"     : { coords: [60.4720, 22.2530], municipality: "Turku" },
  "Hirvensalo"    : { coords: [60.4120, 22.2160], municipality: "Turku" },
  // Oulu
  "Tuira"         : { coords: [65.0250, 25.4700], municipality: "Oulu" },
  "Kaakkuri"      : { coords: [64.9600, 25.4800], municipality: "Oulu" },
};

// Kept in the original name -> [lat, lon] shape, because the offline dev
// geocoder and the tests both index into it directly.
const DISTRICT_COORDS = Object.fromEntries(
  Object.entries(DISTRICTS).map(([name, d]) => [name, d.coords])
);

// Municipalities. Not exhaustive; Finland has 309 and hand-keeping them all
// would rot. The live geocode path resolves any municipality by name straight
// from the geocoder's own localadmin layer, so this table only needs to cover
// the offline dev geocoder and give the ranking something to bias towards.
const MUNICIPALITY_COORDS = {
  // Capital region
  "Helsinki": [60.1699, 24.9384],
  "Espoo":    [60.2055, 24.6559],
  "Vantaa":   [60.2934, 25.0378],
  "Kauniainen": [60.2110, 24.7280],
  // Rest of Uusimaa
  "Kirkkonummi": [60.1230, 24.4400],
  "Kerava":      [60.4030, 25.1030],
  "Järvenpää":   [60.4730, 25.0890],
  "Tuusula":     [60.4030, 25.0290],
  "Nurmijärvi":  [60.4640, 24.8080],
  "Hyvinkää":    [60.6310, 24.8600],
  "Porvoo":      [60.3930, 25.6650],
  "Lohja":       [60.2500, 24.0650],
  "Vihti":       [60.4170, 24.3200],
  "Sipoo":       [60.3760, 25.2680],
  "Mäntsälä":    [60.6330, 25.3170],
  "Karkkila":    [60.5340, 24.2100],
  "Raasepori":   [59.9760, 23.4360],
  "Hanko":       [59.8230, 22.9680],
  "Inkoo":       [60.0450, 24.0060],
  "Siuntio":     [60.1450, 24.2280],
  "Pornainen":   [60.4750, 25.3750],
  "Askola":      [60.5300, 25.6000],
  "Loviisa":     [60.4570, 26.2250],
  // Pirkanmaa: Tampere and its commuter belt
  "Tampere":     [61.4978, 23.7610],
  "Kangasala":   [61.4632, 24.0667],
  "Nokia":       [61.4790, 23.5080],
  "Pirkkala":    [61.4650, 23.6450],
  "Ylöjärvi":    [61.5570, 23.5970],
  "Lempäälä":    [61.3130, 23.7560],
  "Vesilahti":   [61.3070, 23.6300],
  "Orivesi":     [61.6780, 24.3570],
  "Valkeakoski": [61.2650, 24.0320],
  "Akaa":        [61.1670, 23.8670],
  "Sastamala":   [61.3400, 22.9080],
  "Ikaalinen":   [61.7700, 23.0670],
  "Hämeenkyrö":  [61.6350, 23.1980],
  "Pälkäne":     [61.3400, 24.2700],
  "Urjala":      [61.0800, 23.5500],
  "Parkano":     [62.0100, 23.0200],
  "Virrat":      [62.2400, 23.7800],
  "Mänttä-Vilppula": [62.0280, 24.6280],
  "Ruovesi":     [61.9860, 24.0730],
  "Juupajoki":   [61.7800, 24.4400],
  // Other cities the tool may be pointed at
  "Turku":        [60.4518, 22.2666],
  "Kaarina":      [60.4070, 22.3700],
  "Raisio":       [60.4860, 22.1690],
  "Naantali":     [60.4670, 21.9930],
  "Oulu":         [65.0121, 25.4651],
  "Jyväskylä":    [62.2415, 25.7209],
  "Lahti":        [60.9827, 25.6612],
  "Kuopio":       [62.8924, 27.6770],
  "Pori":         [61.4851, 21.7974],
  "Joensuu":      [62.6010, 29.7636],
  "Lappeenranta": [61.0587, 28.1887],
  "Vaasa":        [63.0951, 21.6165],
  "Kouvola":      [60.8679, 26.7042],
  "Hämeenlinna":  [60.9959, 24.4643],
  "Riihimäki":    [60.7370, 24.7730],
  "Seinäjoki":    [62.7903, 22.8403],
  "Rovaniemi":    [66.5039, 25.7294],
  "Mikkeli":      [61.6886, 27.2723],
  "Kotka":        [60.4664, 26.9458],
  "Salo":         [60.3833, 23.1333],
  "Kokkola":      [63.8384, 23.1300],
  "Rauma":        [61.1272, 21.5114],
  "Kajaani":      [64.2222, 27.7278],
  "Savonlinna":   [61.8687, 28.8814],
  "Imatra":       [61.1710, 28.7560],
  "Varkaus":      [62.3150, 27.8700],
  "Iisalmi":      [63.5610, 27.1900],
  "Kemi":         [65.7360, 24.5630],
  "Tornio":       [65.8480, 24.1440],
};

// How far a hit may sit from the centre we know for its area before the
// ranking stops treating the area as corroborating evidence. These are soft
// signals now, not filters: a false negative here used to mean an applicant
// silently vanished from the map, which is worse than a slightly odd pin.
const DISTRICT_RADIUS_KM = 12;
const MUNICIPALITY_RADIUS_KM = 22;

// Finland's bounding box, used only as a last-ditch sanity check that a
// coordinate is in the country at all. The predecessor of this constant was a
// Uusimaa-shaped rectangle passed to the geocoder as a hard `boundary.rect`,
// which is what put four of Lisa's Tampere applicants in Helsinki, Hyvinkää
// and Kouvola: Pirkanmaa was clipped out of the result set entirely, so the
// only candidates left to return were same-named streets in Uusimaa. Never
// constrain the geocoder to a sub-region again; constrain the ANSWER instead.
const COUNTRY_BOUNDS = { minLat: 59.5, maxLat: 70.2, minLon: 19.0, maxLon: 31.7 };

// ---------------------------------------------------------------------------
// Name lookup
// ---------------------------------------------------------------------------
// Tolerates how the Neighbourhood column actually gets filled in: any case,
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
function addToIndex(entry) {
  for (const key of [indexKey(entry.name), foldedKey(entry.name)]) {
    if (key && !INDEX.has(key)) INDEX.set(key, entry);
  }
}
Object.entries(DISTRICTS).forEach(([name, d]) =>
  addToIndex({ name, coords: d.coords, radiusKm: DISTRICT_RADIUS_KM, municipality: d.municipality, kind: "district" }));
Object.entries(MUNICIPALITY_COORDS).forEach(([name, coords]) =>
  addToIndex({ name, coords, radiusKm: MUNICIPALITY_RADIUS_KM, municipality: name, kind: "municipality" }));
// Spellings that come up but aren't the official form, including the Swedish
// names of bilingual municipalities.
[["Espoo keskus", "Espoon keskus"], ["Helsingfors", "Helsinki"], ["Esbo", "Espoo"],
 ["Vanda", "Vantaa"], ["Grankulla", "Kauniainen"], ["Tammerfors", "Tampere"],
 ["Åbo", "Turku"], ["Uleåborg", "Oulu"], ["Vasa", "Vaasa"], ["Borgå", "Porvoo"],
 ["Tavastehus", "Hämeenlinna"], ["Björneborg", "Pori"], ["Karis", "Raasepori"],
 ["Ekenäs", "Raasepori"], ["Kyrkslätt", "Kirkkonummi"], ["Lojo", "Lohja"],
 ["Sibbo", "Sipoo"], ["Ingå", "Inkoo"], ["Hangö", "Hanko"], ["Kervo", "Kerava"],
 ["Träskända", "Järvenpää"], ["Tusby", "Tuusula"], ["Nurmijärvi kk", "Nurmijärvi"]]
  .forEach(([alias, target]) => {
    const hit = INDEX.get(indexKey(target));
    // Through indexKey/foldedKey like every other entry, so an alias added
    // later with capitals or diacritics still resolves.
    if (hit) for (const key of [indexKey(alias), foldedKey(alias)]) {
      if (key && !INDEX.has(key)) INDEX.set(key, hit);
    }
  });

// Resolves the Neighbourhood cell to a known place. Tries the whole value
// first, then each comma- or slash-separated part, so "Helsinki, Kallio"
// resolves to Kallio (the more specific of the two).
function resolveDistrict(neighborhood) {
  if (!neighborhood) return null;
  const lookup = (value) => INDEX.get(indexKey(value)) || INDEX.get(foldedKey(value));

  const whole = lookup(neighborhood);
  if (whole) return whole;

  // "Helsinki, Kallio" and "Kallio (Helsinki)" both name two places; take each
  // in turn and prefer the district, since it says more about where they live.
  const parts = splitAreaParts(neighborhood);
  const hits = parts.map(lookup).filter(Boolean);
  if (hits.length) return hits.find((h) => h.kind === "district") || hits[0];

  // Nothing separated by punctuation matched, so fall back to individual
  // words: a real cell reads "Pirkkala Kyösti", and Pirkkala is the answer.
  const wordHits = areaLookupCandidates(neighborhood).map(lookup).filter(Boolean);
  return wordHits.find((h) => h.kind === "district") || wordHits[0] || null;
}

// True when the street cell holds a place name and no street at all, e.g. "Tampere"
// in the Street address column. Worth naming precisely, because it is a
// different fix for the organizer than a misspelled street.
function looksLikePlaceNameOnly(street) {
  const cleaned = String(street || "").trim();
  if (!cleaned || /\d/.test(cleaned)) return false;
  return !!resolveDistrict(cleaned);
}

function splitAreaParts(value) {
  return String(value || "").split(/[,/|()]/).map((p) => p.trim()).filter(Boolean);
}

// Every reading of the Neighbourhood cell worth trying, most specific first.
// The cell is free text and gets filled in as "Pirkkala Kyösti" or "Hervanta
// Tampere" as readily as with a comma, so a separator-only split misses the
// city that is sitting right there. Short tokens are dropped: they are
// prepositions and abbreviations, not place names.
function areaLookupCandidates(value) {
  const whole = String(value || "").trim();
  const parts = splitAreaParts(value);
  const words = parts.flatMap((part) => part.split(/\s+/)).filter((w) => w.length >= 4);
  return [...new Set([whole, ...parts, ...words].filter(Boolean))];
}

function districtCentre(neighborhood) {
  const hit = resolveDistrict(neighborhood);
  return hit ? hit.coords : null;
}

// The municipality an area name belongs to, when we happen to know it. Returns
// null rather than guessing; the live path then asks the geocoder instead.
function municipalityOf(neighborhood) {
  const hit = resolveDistrict(neighborhood);
  return hit ? hit.municipality : null;
}

// ---------------------------------------------------------------------------
// Street cleaning
// ---------------------------------------------------------------------------
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

// Same great-circle formula the matching engine uses. Kept as one
// implementation rather than two copies that have to stay in step; this module
// is only ever loaded in Node, so the require is safe.
const distanceKm = require("./matching-engine.js").haversineKm;

// Takes the whole anchor rather than just its centre, because a municipality
// anchor is coarser than a district one and needs its own radius.
function withinAnchor(anchor, point) {
  if (!anchor || !anchor.coords) return false;
  const radius = anchor.radiusKm || DISTRICT_RADIUS_KM;
  return distanceKm(anchor.coords, point) <= radius;
}

function withinCountry(point) {
  if (!Array.isArray(point) || typeof point[0] !== "number" || typeof point[1] !== "number") return false;
  const [lat, lon] = point;
  return lat >= COUNTRY_BOUNDS.minLat && lat <= COUNTRY_BOUNDS.maxLat
      && lon >= COUNTRY_BOUNDS.minLon && lon <= COUNTRY_BOUNDS.maxLon;
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
// Every street name a label offers. Renamed streets are carried in the
// register with the former name in brackets ("Vanha Helsingintie 11
// (Latokartanontie 11)"), and a resident who writes the old name is not
// wrong, so both spellings count as the same street.
function labelStreetNames(resolvedLabel) {
  const first = String(resolvedLabel || "").split(",")[0];
  const names = [streetName(first.replace(/\s*\([^)]*\)/g, " "))];
  for (const match of first.matchAll(/\(([^)]+)\)/g)) names.push(streetName(match[1]));
  return names.filter(Boolean);
}

// "Vaasank." is a normal way to write Vaasankatu. An abbreviation is visible
// in the text: a letter followed by a full stop. The digit case ("3. linja")
// is an ordinal street name, not a truncation, so it is excluded.
function looksAbbreviated(street) {
  return /[a-zäöå]\./i.test(String(street || ""));
}

function streetNameMatches(requested, resolvedLabel) {
  const cleaned = normalizeStreet(requested);
  const want    = streetName(cleaned);
  if (want === "") return false;

  // Prefix leniency is only extended to a request that is visibly an
  // abbreviation. It used to apply to any pair sharing a five-character stem
  // in either direction, which in a country full of compound street names
  // accepted outright different streets: "Kauppatori 5" matched
  // "Kauppatorinkatu 5", "Rantatie 10" matched "Rantatiensuu 10". Those are
  // wrong pins in the right city, which is the failure this module exists to
  // stop. Raised in review; the previous rule was never exercised by a real
  // address in either the sample or the live sheet.
  const abbreviated = looksAbbreviated(cleaned);

  return labelStreetNames(resolvedLabel).some((got) => {
    if (want === got) return true;
    // One direction only: the address register spells names out in full, so
    // it is always the request that may be the truncated one.
    return abbreviated && want.length >= 5 && got.startsWith(want);
  });
}

// The house number, as a number, from a street or a geocoder label. Takes the
// LAST number in the first segment, so "3. linja 5" reads as 5 and not 3.
function houseNumber(value) {
  const segment = String(value || "").split(",")[0];
  const numbers = segment.match(/\d+/g);
  if (!numbers) return null;
  return Number(numbers[numbers.length - 1]);
}

// Compares two place names the same tolerant way the index does, so "Ylojarvi"
// from a form matches "Ylöjärvi" from the geocoder.
function placeNameMatches(a, b) {
  if (!a || !b) return false;
  return foldedKey(a) === foldedKey(b);
}

// ---------------------------------------------------------------------------
// Choosing between the geocoder's candidates
// ---------------------------------------------------------------------------
// A candidate is { lat, lon, label, localadmin, locality, neighbourhood,
// borough, confidence }: the fields Pelias returns that say where a hit is
// administratively, rather than just geometrically.
//
// The request is { street, area, municipality } where `municipality` is what
// we managed to establish for the area, and may be null.
//
// Returns the best believable candidate with a `score` and `reasons`, or null
// if none of them can be verified. Refusing to answer is a valid outcome: a
// flagged row the organizer can fix beats a pin in the wrong city.
function scoreCandidate(request, candidate) {
  const { street, area, municipality } = request;
  if (!candidate || typeof candidate.lat !== "number" || typeof candidate.lon !== "number") return null;
  if (!withinCountry([candidate.lat, candidate.lon])) return null;
  if (!streetNameMatches(street, candidate.label)) return null;

  const areaFields = [candidate.neighbourhood, candidate.borough, candidate.locality, candidate.localadmin];
  // `localadmin` is the municipality proper; `locality` is the postal town,
  // which is NOT the same thing. Parts of Kangasala have a Tampere postal
  // town, so accepting either field let a Kangasala street verify as Tampere,
  // the exact class of error this whole module exists to prevent.
  //
  // So `locality` is never consulted for the municipality check, not even
  // when `localadmin` is missing. Falling back to it in that case would
  // quietly reopen the same hole for whichever hits happen to lack the field.
  // Digitransit populates `localadmin` on every Finnish address and street
  // feature observed, so this costs nothing in practice; if a feature ever
  // arrives without it, the hit drops to the area-name check below rather
  // than being verified against the wrong kind of place.
  const cityField = candidate.localadmin;
  const reasons = [];

  // The municipality is the disambiguator. When we know it, a hit in a
  // different municipality is wrong however good its street match looks.
  if (municipality && cityField) {
    if (!placeNameMatches(municipality, cityField)) return null;
    reasons.push(`in ${municipality}`);
  } else if (area) {
    // No municipality established, so the area name itself has to appear
    // somewhere in the hit's administrative fields.
    const matched = areaFields.find((f) => placeNameMatches(area, f));
    if (!matched) return null;
    reasons.push(`area name matches "${matched}"`);
  } else {
    // Nothing at all to verify against. Don't guess.
    return null;
  }

  let score = 100;

  // A district-level name match is stronger evidence than the municipality
  // alone: it says the hit is in the right part of a big city.
  if (area && !placeNameMatches(area, municipality) && areaFields.some((f) => placeNameMatches(area, f))) {
    score += 25;
    reasons.push("district matches");
  }

  // The house number. An exact match is the strongest single signal; a near
  // miss is normal (the register only knows numbers that exist), but a hit
  // 50 houses away is a different part of the street.
  const wantNum = houseNumber(normalizeStreet(street));
  const gotNum  = houseNumber(candidate.label);
  let houseDelta = null;
  if (wantNum !== null && gotNum !== null) {
    houseDelta = Math.abs(wantNum - gotNum);
    if (houseDelta === 0) { score += 50; reasons.push("exact house number"); }
    else score -= Math.min(houseDelta, 40);
  }

  // An exact street-name equality beats a prefix match.
  if (streetName(normalizeStreet(street)) === streetName(String(candidate.label).split(",")[0])) score += 10;

  // Corroboration from the coordinates we happen to keep for this area. A
  // bonus only, never a filter, so a missing or stale centre cannot make an
  // applicant disappear.
  const anchor = resolveDistrict(area);
  if (anchor && withinAnchor(anchor, [candidate.lat, candidate.lon])) {
    score += 15;
    reasons.push(`near ${anchor.name}`);
  }

  score += (Number(candidate.confidence) || 0) * 10;

  return { ...candidate, score, reasons, houseDelta, exactHouseNumber: houseDelta === 0 };
}

// Picks the highest-scoring believable candidate out of everything the query
// ladder turned up. Duplicates across queries are fine; they score the same.
function pickBestCandidate(request, candidates) {
  let best = null;
  for (const candidate of candidates || []) {
    const scored = scoreCandidate(request, candidate);
    if (scored && (!best || scored.score > best.score)) best = scored;
  }
  return best;
}

const Regions = {
  DISTRICTS,
  DISTRICT_COORDS,
  MUNICIPALITY_COORDS,
  DISTRICT_RADIUS_KM,
  MUNICIPALITY_RADIUS_KM,
  COUNTRY_BOUNDS,
  districtCentre,
  resolveDistrict,
  municipalityOf,
  splitAreaParts,
  areaLookupCandidates,
  looksLikePlaceNameOnly,
  normalizeStreet,
  distanceKm,
  withinAnchor,
  withinCountry,
  streetName,
  looksAbbreviated,
  labelStreetNames,
  streetNameMatches,
  houseNumber,
  placeNameMatches,
  scoreCandidate,
  pickBestCandidate,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Regions;
}
