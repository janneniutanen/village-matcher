// ============================================================================
// Village Matcher — input validation
//
// The sheet is hand-editable, so any field can end up malformed: a typo'd
// transport mode, a date pasted in the wrong format, a phone number missing
// digits, a blank cell. None of that should crash the matching engine or
// silently produce wrong groups — it should get flagged so the organizer can
// fix the sheet, and the person stays out of the matching pool until then.
//
// Pure functions, no DOM — testable the same way as matching-engine.js.
// ============================================================================

const KNOWN_MODES = {
  walk: "W", walking: "W", foot: "W", "on foot": "W",
  car: "D", driving: "D", drive: "D", taxi: "D", "take taxi": "D",
  "bicycle": "B", "bike": "B",
  bus: "P", transit: "P", "public transport": "P", train: "P", tram: "P",
};

function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).trim().replace(/[\s-()]/g, "");
  if (cleaned === "") return null;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return "+" + cleaned.slice(2);
  if (cleaned.startsWith("0")) return "+358" + cleaned.slice(1);
  if (/^\d{6,9}$/.test(cleaned)) return "+358" + cleaned;
  if (!cleaned.startsWith("+")) return "+" + cleaned;
  return cleaned;
}

function isPlausiblePhone(phone) {
  return typeof phone === "string" && /^\+\d{7,15}$/.test(phone);
}

function parseTransport(raw) {
  if (!raw) return { modes: [], unknown: [] };
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,/]/);
  const modes = [];
  const unknown = [];
  parts
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .forEach((p) => {
      const known = KNOWN_MODES[p];
      if (known) {
        if (!modes.includes(known)) modes.push(known);
      } else {
        unknown.push(p);
      }
    });
  return { modes, unknown };
}

function parseLanguages(raw) {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,/]/);
  const seen = new Set();
  const result = [];
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((p) => {
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(p);
      }
    });
  return result;
}

// A rolling application, so a "youngest child" can be a couple of years old by
// the time a group forms.
const DOB_MAX_YEARS_PAST = 5;

// Mothers are matched before the birth on purpose, so this column holds a due
// date as often as a birthday. Ten months covers a full pregnancy while still
// catching a fat-finger year like "2205".
const DOB_MAX_MONTHS_AHEAD = 10;

// Accepts a JS Date, ISO "YYYY-MM-DD", "DD.MM.YYYY", or "DD/MM/YYYY". Returns a Date or null.
// Note: both dot- and slash-separated formats are treated as DD/MM/YYYY
// (Finnish convention), not MM/DD/YYYY (US convention).
function parseDob(raw) {
  if (!raw) return null;
  let d = null;
  if (raw instanceof Date) {
    d = raw;
  } else {
    const s = String(raw).trim();
    const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy || dmySlash) {
      const [, day, month, year] = (dmy || dmySlash).map(Number);
      const candidate = new Date(year, month - 1, day);
      // JS Date silently rolls over out-of-range values (e.g. day 32 becomes
      // the 1st/2nd of the next month) instead of erroring — check the
      // round-trip matches what was actually typed before accepting it.
      if (candidate.getDate() === day && candidate.getMonth() === month - 1 && candidate.getFullYear() === year) {
        d = candidate;
      }
    } else {
      const parsed = new Date(s);
      if (!isNaN(parsed.getTime())) d = parsed;
    }
  }
  if (!d || isNaN(d.getTime())) return null;

  const now = new Date();
  const earliest = new Date(now.getFullYear() - DOB_MAX_YEARS_PAST, now.getMonth(), now.getDate());
  const latest   = new Date(now.getFullYear(), now.getMonth() + DOB_MAX_MONTHS_AHEAD, now.getDate());
  if (d < earliest || d > latest) return null;

  return d;
}

// A due date rather than a birthday. The matching engine needs no special case
// (it compares months between members either side of today), but a coordinator
// writing to someone does.
function isExpecting(dob, now = new Date()) {
  if (!(dob instanceof Date) || isNaN(dob.getTime())) return false;
  return dob.getTime() > now.getTime();
}

// Nobody is realistically travelling more than three hours to a peer-support
// meetup, so anything above this is treated as a typo rather than an answer.
const MAX_TRAVEL_MINUTES = 180;

// Reads a duration out of free text and returns whole minutes, or null if
// there's no number to work with. The field is free-form in the form, so it
// sees "20", "about 20 min", "1,5 hours", "2 hours" and "1 h 30" alike.
//
// Both decimal separators are accepted because the sheet gets both: Finnish
// locale writes 1,5 and an English-locale browser writes 1.5.
function travelTextToMinutes(text) {
  const s = String(text).toLowerCase().replace(/,(\d)/g, ".$1");
  const HOURS   = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/;
  const MINUTES = /(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)(?![a-z])/;

  const hours = s.match(HOURS);
  if (hours) {
    let minutes = parseFloat(hours[1]) * 60;
    const rest = s.slice(hours.index + hours[0].length);
    const tail = rest.match(MINUTES) || rest.match(/^\D*(\d+(?:\.\d+)?)/);
    if (tail) minutes += parseFloat(tail[1]);
    return minutes;
  }

  const mins = s.match(MINUTES);
  if (mins) return parseFloat(mins[1]);

  const bare = s.match(/-?\d+(?:\.\d+)?/);
  return bare ? parseFloat(bare[0]) : null;
}

function parseMaxTravel(raw) {
  if (raw === null || raw === undefined) return null;

  let minutes;
  if (typeof raw === "number") {
    minutes = raw;
  } else {
    const s = String(raw).trim();
    if (s === "") return null;
    if (s.includes("Doesn't matter")) return MAX_TRAVEL_MINUTES;
    minutes = travelTextToMinutes(s);
  }

  // The range check has to come after the unit conversion, or an answer like
  // "4 hours" slips through as 240.
  if (minutes === null || !isFinite(minutes) || minutes <= 0 || minutes > MAX_TRAVEL_MINUTES) return null;
  return Math.round(minutes);
}

function parseNonEmptyString(raw) {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  return s === "" ? null : s;
}

function invalidValue(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "(blank)";
  if (Array.isArray(raw)) return raw.join(", ");
  return String(raw);
}

// Deterministic fallback id for rows whose id field is missing. Using a
// stable hash (rather than Math.random) means the same bad row always gets
// the same id across reloads and syncs, so it can be stably referenced in
// error messages and won't re-appear as a "new" problem row after each sync.
function stableId_(raw) {
  const key = [raw.name, raw.neighborhood, raw.dob].join("|");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return "MISSING-" + h.toString(36);
}

// Runs a raw sheet-shaped row through all the above and returns a
// normalized applicant plus a list of problems. The applicant is always
// returned (never throws) so one bad row never blocks the rest of the
// sheet from loading. `eligibleForMatching` is false if anything required
// for the matching logic itself is missing/invalid.
function normalizeApplicant(raw) {
  const errors = [];

  const id = parseNonEmptyString(raw.id);
  if (!id) errors.push(`Missing identity number: ${invalidValue(raw.id)}`);

  const name = parseNonEmptyString(raw.name) || "(no name)";
  if (!parseNonEmptyString(raw.name)) errors.push(`Missing name: ${invalidValue(raw.name)}`);

  const neighborhood = parseNonEmptyString(raw.neighborhood);
  if (!neighborhood) errors.push(`Missing neighborhood: ${invalidValue(raw.neighborhood)}`);

  const street = parseNonEmptyString(raw.street);
  if (!street) errors.push(`Missing street address: ${invalidValue(raw.street)}`);

  const { modes: transport, unknown: unknownModes } = parseTransport(raw.transport);
  if (transport.length === 0) errors.push(`No recognizable transport mode: ${invalidValue(raw.transport)}`);
  if (unknownModes.length > 0) errors.push(`Unrecognized transport value(s): ${unknownModes.join(", ")}`);

  const language = parseLanguages(raw.language);
  if (language.length === 0) errors.push(`Missing language(s): ${invalidValue(raw.language)}`);

  const maxTravel = parseMaxTravel(raw.maxTravel);
  if (maxTravel === null) errors.push(`Missing or invalid max travel time: ${invalidValue(raw.maxTravel)}`);

  const dob = parseDob(raw.dob);
  if (dob === null) errors.push(`Missing or invalid birth date or due date: ${invalidValue(raw.dob)}`);

  const phone = normalizePhone(raw.phone);
  if (!isPlausiblePhone(phone)) errors.push(`Missing or invalid phone number: ${invalidValue(raw.phone)}`);

  const applicant = {
    id: id || stableId_(raw),
    name,
    neighborhood: neighborhood || "(unknown)",
    street: street || "",
    transport,
    language,
    maxTravel,
    dob,
    expecting: isExpecting(dob),
    phone: phone || "",
    hasDataIssues: errors.length > 0,
    dataIssues: errors,
    eligibleForMatching: errors.length === 0,
    village: parseNonEmptyString(raw.village),
    status: parseNonEmptyString(raw.status),
    villageStatus: parseNonEmptyString(raw.villageStatus),
    myNotes: parseNonEmptyString(raw.myNotes),
  };
  return applicant;
}

const Validation = {
  KNOWN_MODES,
  normalizePhone,
  isPlausiblePhone,
  parseTransport,
  parseLanguages,
  parseDob,
  isExpecting,
  DOB_MAX_YEARS_PAST,
  DOB_MAX_MONTHS_AHEAD,
  parseMaxTravel,
  travelTextToMinutes,
  MAX_TRAVEL_MINUTES,
  parseNonEmptyString,
  invalidValue,
  normalizeApplicant,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Validation;
}
