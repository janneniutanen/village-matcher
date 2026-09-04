'use strict';

// Village Matcher backend.
//
// The organizer runs the tool locally with `node server.js`, which imports
// this handler directly. The Netlify Function wrapper is kept for the hosted
// path, but the local server is what is actually used, so nothing here is
// designed around a Lambda invocation limit.
//
// Handles all backend actions: Google Sheets read/write (via service account),
// geocoding and travel times (Digitransit), and meeting-place lookup
// (OpenStreetMap via Overpass). All credentials come from environment
// variables, never from the browser.
//
// Environment variables required:
//   MATCHER_PASSWORD           — password the organizer enters in the UI
//   GOOGLE_SERVICE_ACCOUNT_JSON — full contents of the service account JSON key file
//   SPREADSHEET_ID             — Google Sheet ID (the long string in the sheet URL)
//   SOURCE_TAB                 — sheet tab name containing applicant data
//   DIGITRANSIT_API_KEY        - from portal.digitransit.fi

const { google } = require('googleapis');
const fs         = require('fs');
const Validation = require('../../src/validation.js');
const Regions    = require('../../src/regions.js');

// ---------------------------------------------------------------------------
// Module-level cache — warm Lambda instances reuse the Sheets client and
// skip the helper-tab check after the first request.
// ---------------------------------------------------------------------------
let _sheets        = null;
let _sourceTab     = null;
let _helperTabsOk  = false;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GROUPS_TAB    = 'Groups';
const TEMPLATES_TAB = 'Message Templates';
const SETTINGS_TAB  = 'Settings';
const HELPER_TABS   = new Set([GROUPS_TAB, TEMPLATES_TAB, SETTINGS_TAB]);

const COL = {
  id: 'Identity number', name: 'Name', neighborhood: 'Neighbourhood',
  street: 'Street address', transport: 'Transport', language: 'Language',
  maxTravel: 'travel time', dob: 'Date of birth', phone: 'Phone number',
  village: 'Village', villageStatus: 'Village status',
  status: "Mum's status",
  matchStatus: 'Match Status', matchGroupId: 'Match Group ID',
  olderSiblingBirthMonth: 'Older child',
  worries: 'worries', hopes: 'hopes', questions: 'questions',
  source: 'source', amountOfChildren: 'amount of children',
  myNotes: 'My notes'
};

// ---------------------------------------------------------------------------
// Sheets client
// ---------------------------------------------------------------------------
function getSheets() {
  if (_sheets) return _sheets;
  let key;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    key = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf8'));
  } else {
    throw new Error(
      'No service account credentials found. ' +
      'Set GOOGLE_SERVICE_ACCOUNT_JSON (Netlify) or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (local .env file path).'
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

function spreadsheetId() {
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID environment variable is not set');
  return id;
}

function sourceTab() {
  if (!_sourceTab) throw new Error('Source tab not yet resolved — call ensureReady() first');
  return _sourceTab;
}

// ---------------------------------------------------------------------------
// Spreadsheet helpers
// ---------------------------------------------------------------------------
function colLetter(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

function headerIndex(rows) {
  const hi = {};
  (rows[0] || []).forEach((h, i) => { hi[h.trim()] = i; });
  return hi;
}

function cellGet(row, hi, col) {
  const i = hi[col];
  return i !== undefined ? (row[i] || '') : '';
}

async function readRows(tabName) {
  const resp = await getSheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `'${tabName}'!A1:ZZ`,
  });
  return resp.data.values || [];
}

// ---------------------------------------------------------------------------
// Lazy initialisation — run once per Lambda instance
// ---------------------------------------------------------------------------
async function ensureReady() {
  if (_helperTabsOk) return;

  const sheets = getSheets();
  const sid    = spreadsheetId();

  const meta      = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties.title' });
  const allTitles = meta.data.sheets.map(s => s.properties.title);
  const titleSet  = new Set(allTitles);

  // Resolve source tab
  const envTab = process.env.SOURCE_TAB;
  if (envTab) {
    if (!titleSet.has(envTab)) {
      throw new Error(
        `Tab "${envTab}" not found. Available: ${allTitles.map(t => `"${t}"`).join(', ')}. ` +
        `Update SOURCE_TAB in your environment variables or .env file.`
      );
    }
    _sourceTab = envTab;
  } else {
    const candidate = allTitles.find(t => !HELPER_TABS.has(t));
    if (!candidate) throw new Error('No applicant data tab found in the spreadsheet');
    _sourceTab = candidate;
  }

  // Create missing helper tabs in one batch
  const toAdd = [GROUPS_TAB, TEMPLATES_TAB, SETTINGS_TAB].filter(t => !titleSet.has(t));
  if (toAdd.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      resource: { requests: toAdd.map(title => ({ addSheet: { properties: { title } } })) },
    });
  }

  // Ensure Groups tab has a header row
  const groupRows = await readRows(GROUPS_TAB);
  if (!groupRows.length || groupRows[0][0] !== 'Group ID') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid, range: `'${GROUPS_TAB}'!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Group ID', 'Name', 'Member IDs', 'Status', 'Created', 'Updated']] },
    });
  }

  // Ensure Match Status / Match Group ID columns exist on the source tab
  const srcRows = await readRows(_sourceTab);
  if (srcRows.length) {
    const hi      = headerIndex(srcRows);
    const missing = [];
    if (hi[COL.matchStatus]  === undefined) missing.push(COL.matchStatus);
    if (hi[COL.matchGroupId] === undefined) missing.push(COL.matchGroupId);
    if (missing.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `'${_sourceTab}'!${colLetter(srcRows[0].length)}1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [missing] },
      });
    }
  }

  _helperTabsOk = true;
}

// ---------------------------------------------------------------------------
// Sheets — applicants
// ---------------------------------------------------------------------------
async function sheetGetApplicants() {
  await ensureReady();
  const rows = await readRows(sourceTab());
  if (rows.length < 2) return [];
  const hi  = headerIndex(rows);
  const get = (row, col) => cellGet(row, hi, col);

  return rows.slice(1).map((row, i) => {
    const raw = Object.entries(COL).reduce((acc, [propertyName, columnName]) => ({...acc, [propertyName]: get(row, columnName)}), {});
    const a = Validation.normalizeApplicant(raw);
    a.sheetRow            = i + 2;
    a.matchStatus         = get(row, COL.matchStatus)  || 'unmatched';
    a.matchGroupId        = get(row, COL.matchGroupId) || null;
    a.worries             = get(row, 'worries');
    a.hopes               = get(row, 'hopes');
    a.questions           = get(row, 'questions');
    a.source              = get(row, 'source');
    a.amountOfChildren    = get(row, 'amount of children');
    a.olderSiblingBirthMonth = get(row, COL.olderSiblingBirthMonth);
    return a;
  });
}

async function sheetUpdateApplicant(id, fields) {
  await ensureReady();
  const rows = await readRows(sourceTab());
  if (!rows.length) throw new Error('Source tab is empty');
  const hi     = headerIndex(rows);
  const rowIdx = rows.findIndex((r, i) => i > 0 && (r[hi[COL.id]] || '') === id);
  if (rowIdx === -1) throw new Error(`Applicant '${id}' not found in sheet`);
  const sheetRow = rowIdx + 1;

  const updates = [];
  if (fields.matchStatus !== undefined) {
    const col = hi[COL.matchStatus] ?? rows[0].length;
    updates.push({ range: `'${sourceTab()}'!${colLetter(col)}${sheetRow}`, values: [[fields.matchStatus]] });
  }
  if (fields.matchGroupId !== undefined) {
    const col = hi[COL.matchGroupId] ?? (rows[0].length + (hi[COL.matchStatus] === undefined ? 1 : 0));
    updates.push({ range: `'${sourceTab()}'!${colLetter(col)}${sheetRow}`, values: [[fields.matchGroupId || '']] });
  }
  if (updates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      resource: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }
  return { updated: true, id };
}

// ---------------------------------------------------------------------------
// Sheets — groups
// ---------------------------------------------------------------------------
async function sheetGetGroups() {
  await ensureReady();
  const rows = await readRows(GROUPS_TAB);
  if (rows.length < 2) return [];
  const hi = headerIndex(rows);
  return rows.slice(1)
    .filter(row => row[hi['Group ID']])
    .map(row => ({
      id:        cellGet(row, hi, 'Group ID'),
      name:      cellGet(row, hi, 'Name'),
      memberIds: (cellGet(row, hi, 'Member IDs') || '').split(',').map(s => s.trim()).filter(Boolean),
      status:    cellGet(row, hi, 'Status') || 'open',
      created:   cellGet(row, hi, 'Created'),
      updated:   cellGet(row, hi, 'Updated'),
    }));
}

async function sheetCreateGroup(groupData) {
  await ensureReady();
  const existing = await sheetGetGroups();
  const max      = Math.max(0, ...existing.map(g => Number((g.id || '').replace('G-', '')) || 0));
  const id       = 'G-' + String(max + 1).padStart(3, '0');
  const now      = new Date().toISOString();
  await getSheets().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${GROUPS_TAB}'!A:F`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[id, groupData.name, groupData.memberIds.join(', '), groupData.status || 'open', now, now]] },
  });
  return { id };
}

async function sheetUpdateGroup(id, fields) {
  await ensureReady();
  const rows   = await readRows(GROUPS_TAB);
  const hi     = headerIndex(rows);
  const rowIdx = rows.findIndex((r, i) => i > 0 && (r[hi['Group ID']] || '') === id);
  if (rowIdx === -1) throw new Error(`Group '${id}' not found`);
  const sheetRow = rowIdx + 1;

  const updates = [];
  if (fields.status    !== undefined) updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi['Status'])}${sheetRow}`,     values: [[fields.status]] });
  if (fields.memberIds !== undefined) updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi['Member IDs'])}${sheetRow}`, values: [[fields.memberIds.join(', ')]] });
  updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi['Updated'])}${sheetRow}`, values: [[new Date().toISOString()]] });

  await getSheets().spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    resource: { valueInputOption: 'USER_ENTERED', data: updates },
  });
  return { updated: true, id };
}

// ---------------------------------------------------------------------------
// Sheets — templates
// ---------------------------------------------------------------------------
async function sheetGetTemplates() {
  await ensureReady();
  const rows = await readRows(TEMPLATES_TAB);
  const hi   = headerIndex(rows);
  const data = rows[1] || [];
  return {
    firstContact:    cellGet(data, hi, 'First Contact')    || '',
    confirmationAsk: cellGet(data, hi, 'Confirmation Ask') || '',
    introduction:    cellGet(data, hi, 'Introduction')     || '',
  };
}

async function sheetSaveTemplates(templates) {
  await ensureReady();
  const HEADERS = ['First Contact', 'Confirmation Ask', 'Introduction'];
  const rows    = await readRows(TEMPLATES_TAB);
  const sid     = spreadsheetId();
  const vals    = [[templates.firstContact || '', templates.confirmationAsk || '', templates.introduction || '']];

  if (!rows.length || rows[0][0] !== 'First Contact') {
    await getSheets().spreadsheets.values.update({
      spreadsheetId: sid, range: `'${TEMPLATES_TAB}'!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [HEADERS, ...vals] },
    });
  } else {
    await getSheets().spreadsheets.values.update({
      spreadsheetId: sid, range: `'${TEMPLATES_TAB}'!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: vals },
    });
  }
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Sheets — settings
// ---------------------------------------------------------------------------
async function sheetGetSettings() {
  await ensureReady();
  const rows = await readRows(SETTINGS_TAB);
  const hi   = headerIndex(rows);
  const data = rows[1] || [];
  return {
    maxAgeGap:    Number(cellGet(data, hi, 'maxAgeGap'))    || 6,
    minGroupSize: Number(cellGet(data, hi, 'minGroupSize')) || 3,
    maxGroupSize: Number(cellGet(data, hi, 'maxGroupSize')) || 4,
  };
}

async function sheetSaveSettings(settings) {
  await ensureReady();
  const HEADERS = ['maxAgeGap', 'minGroupSize', 'maxGroupSize'];
  const rows    = await readRows(SETTINGS_TAB);
  const sid     = spreadsheetId();

  if (!rows.length || rows[0][0] !== 'maxAgeGap') {
    await getSheets().spreadsheets.values.update({
      spreadsheetId: sid, range: `'${SETTINGS_TAB}'!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [HEADERS, [settings.maxAgeGap ?? 6, settings.minGroupSize ?? 3, settings.maxGroupSize ?? 4]] },
    });
  } else {
    const cur = rows[1] || [];
    const hi  = headerIndex(rows);
    const row = [...cur];
    if (settings.maxAgeGap    !== undefined) row[hi['maxAgeGap']]    = settings.maxAgeGap;
    if (settings.minGroupSize !== undefined) row[hi['minGroupSize']] = settings.minGroupSize;
    if (settings.maxGroupSize !== undefined) row[hi['maxGroupSize']] = settings.maxGroupSize;
    await getSheets().spreadsheets.values.update({
      spreadsheetId: sid, range: `'${SETTINGS_TAB}'!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  }
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Geocoding — Digitransit Pelias API
// ---------------------------------------------------------------------------
// The geocoder treats the query as free text: it discards the municipality and
// fuzzy-matches the street nationally, so "Jokikatu 11, Porvoo" comes back as
// Jokikatu 11 in Joensuu at 0.96 confidence. Confidence cannot catch this.
//
// So search nationally and verify the answer here, at municipality level.
// Never constrain the search to a sub-region: a Uusimaa `boundary.rect` used
// to clip Pirkanmaa out of the results, leaving only same-named Uusimaa
// streets for every Tampere address. Regions.scoreCandidate holds the
// verification and is unit-tested without network.
const GEOCODE_URL = 'https://api.digitransit.fi/geocoding/v1/search';

const GEOCODE_CONCURRENCY = 6;

// Digitransit rate-limits per key. Unspaced, a 300-applicant sync had 20-odd
// people fail as "geocoder unavailable" purely because the batch was large.
// Spaced globally, not per worker, so the ceiling holds at any concurrency.
const MIN_REQUEST_SPACING_MS = 110;

let _nextRequestSlot = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitRequestSlot() {
  const now  = Date.now();
  const slot = Math.max(now, _nextRequestSlot);
  _nextRequestSlot = slot + MIN_REQUEST_SPACING_MS;
  if (slot > now) await sleep(slot - now);
}

function digitransitKey() {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');
  return key;
}

// Retried rather than surfaced as "address not found": a transient failure and
// a bad address need different reactions from the organizer.
async function geocoderSearch(params, attempt = 0) {
  await awaitRequestSlot();
  const resp = await fetch(`${GEOCODE_URL}?${new URLSearchParams(params)}`, {
    headers: { 'digitransit-subscription-key': digitransitKey() },
  });
  if ((resp.status === 429 || resp.status >= 500) && attempt < 5) {
    // Jittered, or workers throttled together retry in lockstep.
    await sleep(500 * 2 ** attempt + Math.random() * 250);
    return geocoderSearch(params, attempt + 1);
  }
  if (!resp.ok) throw new Error(`geocoder returned HTTP ${resp.status}`);
  return resp.json();
}

// The administrative fields, not the coordinates, are what say whether a hit
// is in the right place.
function toCandidate(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  const p = feature.properties || {};
  return {
    lat, lon,
    label:         p.label || null,
    localadmin:    p.localadmin || null,
    locality:      p.locality || null,
    neighbourhood: p.neighbourhood || null,
    borough:       p.borough || null,
    confidence:    p.confidence,
    layer:         p.layer || null,
  };
}

// Resolved from the geocoder's own localadmin layer, so all 309 municipalities
// work without a hand-kept table. Names do not change, so cached for the life
// of the process.
const _municipalityCache = new Map();

async function resolveMunicipalityName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (_municipalityCache.has(key)) return _municipalityCache.get(key);

  let resolved = null;
  try {
    const data = await geocoderSearch({
      text: trimmed, size: '5', layers: 'localadmin', 'boundary.country': 'FIN',
    });
    // Exact equality only. A fuzzy hit is the failure being defended against:
    // "Hervanta" ranks "Herva, Ii" first, 600km north.
    const hit = (data.features || []).find((f) =>
      Regions.placeNameMatches(trimmed, f.properties.localadmin) ||
      Regions.placeNameMatches(trimmed, f.properties.name));
    if (hit) {
      const [lon, lat] = hit.geometry.coordinates;
      resolved = { name: hit.properties.localadmin || hit.properties.name, coords: [lat, lon] };
    }
  } catch (err) {
    // Deliberately not cached. "Not a municipality" and "the network blipped"
    // are indistinguishable here, and this cache outlives the request, so
    // caching the second would degrade every later batch too.
    return null;
  }
  _municipalityCache.set(key, resolved);
  return resolved;
}

// The curated table maps a district to its city ("Hervanta" -> Tampere);
// anything it does not know is put to the geocoder.
async function resolveArea(areaRaw) {
  const known = Regions.resolveDistrict(areaRaw);
  if (known) return { municipality: known.municipality, centre: known.coords };

  for (const part of Regions.areaLookupCandidates(areaRaw)) {
    const hit = await resolveMunicipalityName(part);
    if (hit) return { municipality: hit.name, centre: hit.coords };
  }
  return { municipality: null, centre: null };
}

// Pelias is inconsistent about qualifiers: a district name can pin the right
// city ("Insinöörinkatu 60, Hervanta" is exact) or return nothing at all
// ("Vaasankatu 5, Kallio"). Appending the municipality rescues the second.
function buildQueries(street, area, municipality) {
  const queries = [];
  const push = (text) => { if (text && !queries.includes(text)) queries.push(text); };
  const areaIsCity = area && municipality && Regions.placeNameMatches(area, municipality);

  if (municipality && area && !areaIsCity) push(`${street}, ${area}, ${municipality}`);
  if (municipality) push(`${street}, ${municipality}`);
  if (area) push(`${street}, ${area}`);
  push(street);
  return queries;
}

async function geocodeOne(entry) {
  const rawStreet    = typeof entry === 'string' ? entry : (entry.street || '');
  const neighborhood = typeof entry === 'string' ? ''    : (entry.neighborhood || '');

  // The sheet is hand-filled, so the cell may carry an apartment number, a
  // stair, a postal code or a care-of line. None of that helps the geocoder
  // and some of it makes it miss entirely, so the query uses a cleaned
  // street while the response reports the original.
  const street = Regions.normalizeStreet(rawStreet) || rawStreet;
  const base   = { street: rawStreet, neighborhood, queried: street };

  if (!street.trim()) return { ...base, precise: false, error: 'no street address given' };

  // A Street address column holding "Kaleva" or "Tampere": a place, not an
  // address. Placed at the centre of that place and labelled, because refusing
  // outright dropped people off the map entirely.
  const placeOnlyStreet = Regions.looksLikePlaceNameOnly(street) ? Regions.resolveDistrict(street) : null;
  if (placeOnlyStreet) {
    // A district beats the city it sits in, whichever cell it was typed in.
    const areaAnchor = Regions.resolveDistrict(neighborhood);
    const anchor = placeOnlyStreet.kind === 'district' ? placeOnlyStreet
      : (areaAnchor && areaAnchor.kind === 'district' ? areaAnchor : placeOnlyStreet);
    return {
      ...base,
      municipality: anchor.municipality,
      lat: anchor.coords[0],
      lon: anchor.coords[1],
      label: anchor.name,
      town: anchor.municipality,
      precise: true,
      precision: 'area',
      houseDelta: null,
      warning: `no street address in the sheet, so this is placed at the centre of ${anchor.name} and travel times are rough`,
    };
  }

  const { municipality, centre } = await resolveArea(neighborhood);
  const request = { street, area: neighborhood, municipality };
  const withBase = { ...base, municipality };

  // Nothing to verify a hit against. Guessing here is what put people in the
  // wrong city, so the row is flagged for the organizer instead.
  if (!municipality && !neighborhood.trim()) {
    return { ...withBase, precise: false, error: 'no neighbourhood or city given, so the address cannot be placed with confidence' };
  }

  const common = { size: '15', 'boundary.country': 'FIN' };
  // focus.point re-ranks, it never excludes, so it is safe in a way
  // boundary.rect was not.
  if (centre) {
    common['focus.point.lat'] = String(centre[0]);
    common['focus.point.lon'] = String(centre[1]);
  }

  const seen = [];
  let best = null;
  let lastError = null;

  for (const text of buildQueries(street, neighborhood, municipality)) {
    let data;
    try {
      data = await geocoderSearch({ ...common, text, layers: 'address' });
    } catch (err) {
      lastError = err.message;
      continue;
    }
    for (const feature of data.features || []) seen.push(toCandidate(feature));
    best = Regions.pickBestCandidate(request, seen);
    if (best) break;
  }

  // Last resort: the street without a house number, if it is in the verified
  // municipality. Reported, so the organizer can decide.
  let precision = 'exact';
  if (!best) {
    // Only the most specific phrasing. Re-running the whole ladder tripled the
    // request count for the rows least likely to resolve.
    const [mostSpecific] = buildQueries(street, neighborhood, municipality);
    try {
      const data = await geocoderSearch({ ...common, text: mostSpecific, layers: 'street' });
      for (const feature of data.features || []) seen.push(toCandidate(feature));
      best = Regions.pickBestCandidate(request, seen);
      if (best) precision = 'street';
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!best) {
    if (lastError) return { ...withBase, precise: false, error: `geocoder unavailable: ${lastError}` };
    // "No such street here" and "right street, wrong city" need different
    // fixes in the sheet.
    const nearby = seen.find((c) => c.label);
    return {
      ...withBase,
      precise: false,
      error: nearby
        ? `no match for "${street}" in ${municipality || neighborhood}; closest was "${nearby.label}"`
        : `no address matching "${street}" found in ${municipality || neighborhood}`,
    };
  }

  if (precision === 'exact' && best.houseDelta !== null && best.houseDelta > 0) precision = 'approximate';

  // Tens of doors away is a different part of a long street, even though the
  // pin is close enough to match on.
  const warning = precision === 'street'
    ? `placed at street level, because "${street}" has no exact house number in the address register`
    : best.houseDelta !== null && best.houseDelta > 20
      ? `house number ${Regions.houseNumber(street)} not in the register; using nearest known "${best.label}"`
      : undefined;

  return {
    ...withBase,
    lat: best.lat,
    lon: best.lon,
    label: best.label,
    town: best.localadmin || best.locality || null,
    district: best.neighbourhood || best.borough || null,
    confidence: best.confidence,
    precise: true,
    precision,
    houseDelta: best.houseDelta,
    matchedOn: best.reasons,
    warning,
  };
}

// Bounded rather than Promise.all over the whole batch, which got throttled at
// 300 applicants and looked like missing people.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function geocodeBatch(entries) {
  digitransitKey();
  const list = entries || [];

  // Mothers at the same address are the point of the tool, so batches repeat
  // addresses. Each distinct one is looked up once.
  const inFlight = new Map();
  const keyFor = (entry) => typeof entry === 'string'
    ? entry
    : `${entry?.street || ''}|${entry?.neighborhood || ''}`;

  return mapWithConcurrency(list, GEOCODE_CONCURRENCY, async (entry) => {
    const rawStreet    = typeof entry === 'string' ? entry : (entry?.street || '');
    const neighborhood = typeof entry === 'string' ? ''    : (entry?.neighborhood || '');
    const key = keyFor(entry);
    if (!inFlight.has(key)) inFlight.set(key, geocodeOne(entry));
    try {
      return await inFlight.get(key);
    } catch (err) {
      return { street: rawStreet, neighborhood, precise: false, error: err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Travel time — Digitransit Routing API for every mode.
//
// Modes are the single-letter codes produced by Validation.parseTransport:
// W walk, D drive, P public transport, B bicycle.
// ---------------------------------------------------------------------------
// Digitransit's own mode names. Everything routes through Digitransit now,
// including walking and cycling — see directMinutes for why.
const DIRECT_MODE = { W: 'WALK', B: 'BICYCLE', D: 'CAR' };

async function travelTimeBatch(pairs) {
  const departure = representativeDeparture();
  return Promise.all(pairs.map(async (p) => {
    try {
      const minutes = p.mode === 'P'
        ? await transitMinutes(p.from, p.to, departure)
        : await directMinutes(p.from, p.to, p.mode, departure);
      return { id: p.id, minutes };
    } catch (err) {
      return { id: p.id, error: err.message };
    }
  }));
}

// Walking, cycling and driving, all from Digitransit rather than OSRM.
//
// The public OSRM demo server this used to call returns byte-identical results
// for its foot, bike and car profiles — it routes everything as a car. A 2.9km
// walk came back as 6.7 minutes (26 km/h) instead of roughly 40, so walkers
// were being matched as though they drove. Digitransit answers the same trip
// as WALK 42.1 min (4.0 km/h), BICYCLE 13.3 and CAR 6.0, which is the whole
// point of asking per mode. It is also the API the transit path already uses,
// so this drops a second provider and a dependency on a demo server that isn't
// meant for production traffic.
async function directMinutes(from, to, mode, departure = representativeDeparture()) {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');

  const directMode = DIRECT_MODE[mode];
  if (!directMode) throw new Error(`Unknown transport mode '${mode}'`);

  const query = `{ planConnection(
    origin:      { location: { coordinate: { latitude: ${from.lat}, longitude: ${from.lon} } } },
    destination: { location: { coordinate: { latitude: ${to.lat}, longitude: ${to.lon} } } },
    dateTime:    { earliestDeparture: "${departure}" },
    modes:       { directOnly: true, direct: [${directMode}] },
    first: 1
  ) { edges { node { duration } } } }`;

  const resp = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'digitransit-subscription-key': key },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`Digitransit routing returned HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.errors?.length) throw new Error(`Digitransit routing: ${data.errors[0].message}`);

  const node = data.data?.planConnection?.edges?.[0]?.node;
  if (!node) throw new Error(`No ${directMode.toLowerCase()} route found`);
  // Direct modes leave immediately, so there is no boarding wait to add.
  return node.duration / 60;
}

// Transit times must be reproducible, so they're asked for at a fixed
// representative moment rather than "now" — otherwise the answer depends on
// what time of day the organizer happens to run matching. A weekday mid-
// morning is when these groups actually meet.
//
// Deliberately not cached across calls. server.js is a long-lived process, so
// a value cached at startup drifts into the past, and the router answers a
// stale date with a plausible-looking but wrong duration: HTTP 200, no GraphQL
// errors, no real service found. That is indistinguishable from a healthy
// answer downstream, which is the exact failure mode this file is trying to
// eliminate. Computed once per batch instead, so every pair in a run still
// shares one reference moment.
function representativeDeparture() {
  const parts = (date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Helsinki',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  // Next Monday-to-Friday, starting from tomorrow so it's always in the future.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < 7 && ['Sat', 'Sun'].includes(parts(d).weekday); i++) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const { year, month, day } = parts(d);

  // Helsinki is +03:00 in summer and +02:00 in winter, so the offset has to be
  // read for that specific date rather than hardcoded.
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Helsinki', timeZoneName: 'longOffset',
  }).formatToParts(d).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';

  return `${year}-${month}-${day}T10:00:00${offset}`;
}

async function transitMinutes(from, to, departure = representativeDeparture()) {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');

  // planConnection is the scheduled OTP2 API — it consults timetables, unlike
  // the older `plan` field which returned the same duration at 03:00 as at
  // 10:00. Verified against the live router: requesting 03:00 pushes `start`
  // to when first service actually runs.
  const query = `{ planConnection(
    origin:      { location: { coordinate: { latitude: ${from.lat}, longitude: ${from.lon} } } },
    destination: { location: { coordinate: { latitude: ${to.lat}, longitude: ${to.lon} } } },
    dateTime:    { earliestDeparture: "${departure}" },
    first: 1
  ) { edges { node { duration start } } } }`;

  const resp = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'digitransit-subscription-key': key,
    },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`Digitransit routing returned HTTP ${resp.status}`);

  const data = await resp.json();
  // GraphQL reports schema and validation problems in `errors` with HTTP 200.
  // These went unchecked before, so a renamed field surfaced as the misleading
  // "No transit itinerary found".
  if (data.errors?.length) throw new Error(`Digitransit routing: ${data.errors[0].message}`);

  const node = data.data?.planConnection?.edges?.[0]?.node;
  if (!node) throw new Error('No transit itinerary found');

  // `duration` covers start-to-end only. Waiting for the first departure is
  // the difference between when we asked to leave and when the itinerary
  // begins, and it's part of the journey as far as the traveller is concerned.
  const waitMs = Math.max(0, new Date(node.start).getTime() - new Date(departure).getTime());
  return node.duration / 60 + waitMs / 60000;
}

// ---------------------------------------------------------------------------
// Meeting venues, from OpenStreetMap
// ---------------------------------------------------------------------------
// Digitransit's geocoder has a `venue` layer but returns no category, so a
// search comes back with hairdressers and kebab shops and no way to tell them
// apart. OpenStreetMap has the tags.
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_USER_AGENT = 'village-matcher (janne.niutanen@cgi.com)';

// Malls because of the winter: warm, free, a lift, and somewhere to feed a
// baby.
const OVERPASS_TAGS = [
  ['leisure', 'playground'],
  ['leisure', 'park'],
  ['amenity', 'community_centre'],
  ['shop', 'mall'],
];

// Overpass is free and community-run, so results are cached for the life of
// the process.
const _venueCache = new Map();

// Rounded, so nearby groups share one entry.
function venueCacheKey(circle) {
  return `${circle.lat.toFixed(2)},${circle.lon.toFixed(2)},${circle.radiusKm}`;
}

// Overpass sheds load when busy: the same query that answers in 2s can return
// 504 minutes later. Normal operation for it, so retry and let the caller
// carry on without venues if it stays down.
async function overpassFetch(query, attempt = 0) {
  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass answers 406 Not Acceptable without one.
      'User-Agent': OVERPASS_USER_AGENT,
    },
    body: new URLSearchParams({ data: query }),
  });

  if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return overpassFetch(query, attempt + 1);
  }
  if (!resp.ok) throw new Error(`Overpass returned HTTP ${resp.status}`);

  const data = await resp.json();
  // Overpass reports its own timeouts in `remark` with HTTP 200 and no
  // elements, which is otherwise indistinguishable from "nothing near here".
  if (data.remark) throw new Error(`Overpass: ${String(data.remark).slice(0, 160)}`);
  return data;
}

async function meetingVenues(circle) {
  if (!circle || typeof circle.lat !== 'number' || typeof circle.lon !== 'number') return [];
  const radiusKm = Math.min(Math.max(circle.radiusKm || 10, 1), 25);
  const key = venueCacheKey({ ...circle, radiusKm });
  if (_venueCache.has(key)) return _venueCache.get(key);

  // A box, not Overpass's `around:`. That works for nodes but times out at 40s
  // returning nothing once `way` elements are included, and parks and
  // playgrounds are mapped as areas. The caller trims to the true radius.
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((circle.lat * Math.PI) / 180));
  const bbox = [
    circle.lat - dLat, circle.lon - dLon,
    circle.lat + dLat, circle.lon + dLon,
  ].map((n) => n.toFixed(5)).join(',');

  // Nodes and ways both, since a playground is usually an area; `out center`
  // reduces each to a point. Named only: two thirds have no name and filtering
  // server-side cut the reply from 1688 elements to 644.
  const clauses = OVERPASS_TAGS
    .flatMap(([k, v]) => [`node["${k}"="${v}"]["name"](${bbox});`, `way["${k}"="${v}"]["name"](${bbox});`])
    .join('\n  ');
  const query = `[out:json][timeout:25];\n(\n  ${clauses}\n);\nout center tags;`;

  const data = await overpassFetch(query);
  const venues = (data.elements || []).map((el) => {
    const tags = el.tags || {};
    const centre = el.center || { lat: el.lat, lon: el.lon };
    return {
      id: `${el.type}/${el.id}`,
      name: tags.name || tags['name:fi'] || null,
      kind: tags.leisure || tags.amenity || tags.shop || null,
      lat: centre?.lat,
      lon: centre?.lon,
    };
  }).filter((v) => typeof v.lat === 'number' && typeof v.lon === 'number');

  _venueCache.set(key, venues);
  return venues;
}

// ---------------------------------------------------------------------------
// Travel-time grid: many origins to many candidate points, in bulk
// ---------------------------------------------------------------------------
// This is what makes an accurate group overlap affordable. Asking the router
// one journey per HTTP request, as travelTimeBatch does, costs a request per
// member per candidate point: a 3x3 grid for four members is 36 round trips.
// GraphQL will answer many aliased queries in a single request, so the same 36
// journeys become 4 requests, one per member. Measured against the live
// router: 8 real transit journeys in one request in 1.7s, 25 in 5.7s.
//
// Every journey is a real itinerary from the same router Reittiopas uses, with
// real timetables, real walking legs to the stop and real waiting time. None
// of it is modelled or interpolated.
const GRID_MAX_POINTS_PER_REQUEST = 12;

// One aliased planConnection per candidate point. Transit needs the scheduled
// query; walking, cycling and driving are direct and leave immediately.
function gridQuery(origin, points, departure) {
  const mode = DIRECT_MODE[origin.mode];
  const fields = origin.mode === 'P' ? 'duration start' : 'duration';
  const modeArg = origin.mode === 'P' ? '' : `modes: { directOnly: true, direct: [${mode}] },`;

  const aliases = points.map((point, i) => `p${i}: planConnection(
    origin:      { location: { coordinate: { latitude: ${origin.lat}, longitude: ${origin.lon} } } },
    destination: { location: { coordinate: { latitude: ${point.lat}, longitude: ${point.lon} } } },
    dateTime:    { earliestDeparture: "${departure}" },
    ${modeArg}
    first: 1
  ) { edges { node { ${fields} } } }`).join('\n');

  return `{ ${aliases} }`;
}

async function gridChunk(origin, points, departure) {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');
  if (origin.mode !== 'P' && !DIRECT_MODE[origin.mode]) {
    throw new Error(`Unknown transport mode '${origin.mode}'`);
  }

  const resp = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'digitransit-subscription-key': key },
    body: JSON.stringify({ query: gridQuery(origin, points, departure) }),
  });
  if (!resp.ok) throw new Error(`Digitransit routing returned HTTP ${resp.status}`);

  const data = await resp.json();
  // GraphQL reports schema problems in `errors` with HTTP 200, and a whole
  // aliased batch fails together, so this must be checked before reading.
  if (data.errors?.length) throw new Error(`Digitransit routing: ${data.errors[0].message}`);

  return points.map((_, i) => {
    const node = data.data?.[`p${i}`]?.edges?.[0]?.node;
    // null, not a large number: "no way to get there" is different in kind
    // from "a long way", and the caller treats it as a hard exclusion.
    if (!node) return null;
    if (origin.mode !== 'P') return node.duration / 60;
    // Waiting for the first departure is part of the journey as far as the
    // traveller is concerned, exactly as in transitMinutes.
    const waitMs = Math.max(0, new Date(node.start).getTime() - new Date(departure).getTime());
    return node.duration / 60 + waitMs / 60000;
  });
}

// origins: [{ id, lat, lon, mode }], points: [{ lat, lon }]
// Returns { [originId]: [minutes | null, ...] } aligned with `points`.
// Enough for a shortlist of venues plus every member's home, and a ceiling so
// a mistake upstream cannot turn one click into hundreds of routing queries.
const GRID_MAX_POINTS = 24;

async function travelTimeGrid(origins, points) {
  const departure = representativeDeparture();
  const list = (points || []).slice(0, GRID_MAX_POINTS);
  const out = {};

  // Origins run in parallel, their own chunks in sequence. The router
  // serializes work per key, so firing every chunk at once buys nothing and
  // risks the documented 10 requests/second guidance.
  await Promise.all((origins || []).map(async (origin) => {
    const times = [];
    for (let i = 0; i < list.length; i += GRID_MAX_POINTS_PER_REQUEST) {
      const chunk = list.slice(i, i + GRID_MAX_POINTS_PER_REQUEST);
      try {
        times.push(...await gridChunk(origin, chunk, departure));
      } catch (err) {
        // One member's failure must not sink the whole grid; their points read
        // as unreachable, which the scorer already handles.
        console.warn(`[api] grid chunk failed for ${origin.id}: ${err.message}`);
        times.push(...chunk.map(() => null));
      }
    }
    out[origin.id] = times;
  }));

  return out;
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------
// Enough to follow what the frontend asked for, without dumping payloads. The
// previous full-body log buried the terminal under 150-entry geocode batches
// and printed applicant fields on every update.
function describeRequest(body) {
  const size = body.addresses?.length ?? body.pairs?.length ?? body.locations?.length;
  return `${body.action}${size !== undefined ? ` (${size})` : ''}${body.id ? ` id=${body.id}` : ''}`;
}

async function dispatch(body) {
  console.log(`[api] ${describeRequest(body)}`);
  switch (body.action) {
    case 'ping':
      await ensureReady();
      return { time: new Date().toISOString(), sourceTab: _sourceTab };

    case 'geocode':    return geocodeBatch(body.addresses);
    case 'travelTime': return travelTimeBatch(body.pairs);
    case 'travelTimeGrid': return travelTimeGrid(body.origins, body.points);
    case 'meetingVenues':  return meetingVenues(body.circle);

    case 'getApplicants':   return sheetGetApplicants();
    case 'updateApplicant': return sheetUpdateApplicant(body.id, body.fields);
    case 'getGroups':       return sheetGetGroups();
    case 'createGroup':     return sheetCreateGroup(body.group);
    case 'updateGroup':     return sheetUpdateGroup(body.id, body.fields);
    case 'getTemplates':    return sheetGetTemplates();
    case 'saveTemplates':   return sheetSaveTemplates(body.templates);
    case 'getSettings':     return sheetGetSettings();
    case 'saveSettings':    return sheetSaveSettings(body.settings);

    default: throw new Error('Unknown action: ' + body.action);
  }
}

// ---------------------------------------------------------------------------
// Netlify handler
// ---------------------------------------------------------------------------
// Exported for tests: the freshness of this value is load-bearing, since the
// router answers a past date with a plausible but wrong duration.
exports.representativeDeparture = representativeDeparture;

exports.handler = async (event) => {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'Method not allowed' });

  // Password gate
  const expected = process.env.MATCHER_PASSWORD;
  const provided = event.headers['x-matcher-password'];
  if (!expected || provided !== expected) return json(401, { ok: false, error: 'Unauthorized' });

  try {
    const body   = JSON.parse(event.body || '{}');
    const result = await dispatch(body);
    return json(200, { ok: true, result });
  } catch (err) {
    return json(200, { ok: false, error: err.message });
  }
};
