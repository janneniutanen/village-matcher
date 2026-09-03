'use strict';

// Village Matcher backend.
//
// The organizer runs the tool locally with `node server.js`, which imports
// this handler directly. The Netlify Function wrapper is kept for the hosted
// path, but the local server is what is actually used, so nothing here is
// designed around a Lambda invocation limit.
//
// Handles all backend actions: Google Sheets read/write (via service account),
// geocoding (Digitransit), travel time (OSRM + Digitransit routing), and
// isochrones (OpenRouteService). All credentials come from Netlify environment
// variables — never from the browser.
//
// Environment variables required:
//   MATCHER_PASSWORD           — password the organizer enters in the UI
//   GOOGLE_SERVICE_ACCOUNT_JSON — full contents of the service account JSON key file
//   SPREADSHEET_ID             — Google Sheet ID (the long string in the sheet URL)
//   SOURCE_TAB                 — sheet tab name containing applicant data
//   DIGITRANSIT_API_KEY        — from portal.digitransit.fi
//   ORS_API_KEY                — from openrouteservice.org

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
// Digitransit's geocoder covers all of Finland, but it treats the query as
// free text: it discards the municipality and fuzzy-matches the street name
// nationally, so "Jokikatu 11, Porvoo" comes back as Jokikatu 11 in Joensuu,
// 400km away, at 0.96 confidence. Confidence is therefore useless for
// catching this.
//
// The previous version fought that by passing a Uusimaa-shaped `boundary.rect`
// and rejecting anything outside a radius of a hand-kept district centre. Both
// halves broke as soon as the tool was pointed at Tampere:
//
//   * The rect clipped Pirkanmaa out of the result set, so the only candidates
//     left for a Tampere street were same-named streets in Uusimaa. Every one
//     of eight sample Tampere addresses came back in Helsinki, Hyvinkää,
//     Espoo, Salo or Järvenpää.
//   * A district name in the query text can return zero results outright:
//     "Vaasankatu 5, Kallio" finds nothing while "Vaasankatu 5, Helsinki" is
//     an exact hit. That is why addresses Google resolves fine never appeared.
//
// So: search nationally, ask several differently-phrased questions rather than
// one, and do the verifying ourselves on the way out, at MUNICIPALITY level.
// Street names repeat across Finland but are effectively unique within a
// municipality, which makes the municipality the check that actually works.
// Regions.scoreCandidate holds that logic and is unit-tested without network.
const GEOCODE_URL = 'https://api.digitransit.fi/geocoding/v1/search';

// How many applicants to geocode at once. One request per applicant with no
// limit is fine for a dozen rows and gets rate-limited at a few hundred, which
// showed up as a handful of people mysteriously missing from the map.
const GEOCODE_CONCURRENCY = 6;

// Digitransit rate-limits per key, and a 300-applicant sync overran it: 20-odd
// people came back as "geocoder unavailable" purely because the batch was
// large. Requests are spaced globally rather than per worker, so the ceiling
// holds however many workers are running.
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

// Rate limiting and the occasional 502 are expected on a shared public API, so
// they are retried rather than surfaced as "address not found", since a transient
// failure and a bad address need different reactions from the organizer.
async function geocoderSearch(params, attempt = 0) {
  await awaitRequestSlot();
  const resp = await fetch(`${GEOCODE_URL}?${new URLSearchParams(params)}`, {
    headers: { 'digitransit-subscription-key': digitransitKey() },
  });
  if ((resp.status === 429 || resp.status >= 500) && attempt < 5) {
    // Jittered, so workers that were throttled together don't all come back
    // at the same moment and throttle each other again.
    await sleep(500 * 2 ** attempt + Math.random() * 250);
    return geocoderSearch(params, attempt + 1);
  }
  if (!resp.ok) throw new Error(`geocoder returned HTTP ${resp.status}`);
  return resp.json();
}

// Pelias features carry the administrative hierarchy of a hit as properties.
// Those, not the coordinates, are what tell us whether it is in the right
// place, so they are lifted into the flat shape Regions.scoreCandidate takes.
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

// Municipality names resolved from the geocoder's own localadmin layer, so any
// of Finland's 309 municipalities works without a hand-kept table. Cached for
// the life of the warm Lambda: municipality names do not change, and a batch
// of 300 applicants usually spans only a handful of them.
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
    // Exact name equality only. A fuzzy localadmin hit is exactly the failure
    // mode being defended against: "Hervanta" ranks "Herva, Ii" first, 600km
    // north, and anchoring on that would be worse than having no anchor.
    const hit = (data.features || []).find((f) =>
      Regions.placeNameMatches(trimmed, f.properties.localadmin) ||
      Regions.placeNameMatches(trimmed, f.properties.name));
    if (hit) {
      const [lon, lat] = hit.geometry.coordinates;
      resolved = { name: hit.properties.localadmin || hit.properties.name, coords: [lat, lon] };
    }
  } catch (err) {
    // A lookup failure must not decide the address's fate; verification just
    // falls back to matching the area name against the hit's own fields.
    //
    // Deliberately NOT cached. "Tampere is not a municipality" and "the
    // network blipped while asking about Tampere" are indistinguishable here,
    // and this cache lives as long as the warm container: caching the second
    // would degrade every remaining applicant in the batch, and every future
    // batch on the same container, to the weaker check for no reason.
    return null;
  }
  // Only a definitive answer is cached: a name either is a municipality or
  // demonstrably isn't, and neither changes.
  _municipalityCache.set(key, resolved);
  return resolved;
}

// What the Neighbourhood cell actually refers to. The curated table answers
// instantly and maps a district to its city ("Hervanta" -> Tampere); anything
// it doesn't know is put to the geocoder, one comma-separated part at a time,
// so "Kaleva, Tampere" still finds Tampere.
async function resolveArea(areaRaw) {
  const known = Regions.resolveDistrict(areaRaw);
  if (known) return { municipality: known.municipality, centre: known.coords };

  for (const part of Regions.areaLookupCandidates(areaRaw)) {
    const hit = await resolveMunicipalityName(part);
    if (hit) return { municipality: hit.name, centre: hit.coords };
  }
  return { municipality: null, centre: null };
}

// Several phrasings of the same address, most specific first. The ladder
// exists because Pelias is inconsistent about qualifiers: a district name can
// pin the right city ("Insinöörinkatu 60, Hervanta" is exact) or return
// nothing at all ("Vaasankatu 5, Kallio"). Appending the municipality rescues
// the second case, and asking bare street-only last covers a mis-typed area.
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
  // address. No geocoder can place that to a house, but the place itself is
  // known, so the person goes on the map at its centre and is labelled as
  // such. Refusing outright is what dropped people off the map entirely; a
  // dot at the centre of their district is both honest and usable for a
  // travel-time radius, and the organizer can see it needs fixing.
  const placeOnlyStreet = Regions.looksLikePlaceNameOnly(street) ? Regions.resolveDistrict(street) : null;
  if (placeOnlyStreet) {
    // Whichever of the two cells is more specific: a district beats the city
    // it sits in, wherever the organizer happened to type it.
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
  // focus.point only re-ranks results, it never excludes them, so biasing
  // towards the expected city is safe in a way boundary.rect was not.
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

  // Last resort: accept the street without a house number, if it is in the
  // verified municipality. A pin at the right street in the right city is
  // usable for a 30-minute travel radius and far better than dropping someone
  // off the map, but it is reported so the organizer can decide.
  let precision = 'exact';
  if (!best) {
    // Only the most specific phrasing is retried at street level. Re-running
    // the whole ladder here tripled the request count for exactly the rows
    // least likely to resolve, which is what pushed a 300-row batch over the
    // rate limit.
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
    // Report what it did come back with, because "no such street here" and "right
    // street, wrong city" need different fixes in the sheet.
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

  // A house number tens of doors from the one asked for is a different part of
  // a long street, so it is worth saying out loud even though the pin is
  // close enough to match on.
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

// Bounded concurrency rather than Promise.all over the whole batch: 300
// applicants firing at once gets throttled, and a throttled request that
// slipped through as a failure looked to the organizer like a missing person.
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

  // Mothers who live at the same address are common and the point of the tool,
  // so a batch repeats addresses. Each distinct one is looked up once.
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
// Isochrones — OpenRouteService v2
// ---------------------------------------------------------------------------
const ORS_PROFILE = { W: 'foot-walking', B: 'cycling-regular', D: 'driving-car' };

async function isochroneReq(locations, mode, minutes) {
  const key     = process.env.ORS_API_KEY;
  if (!key) throw new Error('ORS_API_KEY environment variable is not set');
  const profile = ORS_PROFILE[mode] || 'driving-car';

  const resp = await fetch(`https://api.openrouteservice.org/v2/isochrones/${profile}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': key },
    body: JSON.stringify({
      locations:     locations.map(l => [l.lon, l.lat]),
      range:         [minutes * 60],
      intersections: true,
    }),
  });
  if (!resp.ok) {
    throw new Error(`ORS returned HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.json();
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
    case 'isochrone':  return isochroneReq(body.locations, body.mode, body.minutes);

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
