'use strict';

// Netlify Function — Village Matcher backend
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
  matchStatus: 'Match Status', matchGroupId: 'Match Group ID',
  olderSiblingBirthMonth: 'birth month',
  worries: 'worries', hopes: 'hopes', questions: 'questions',
  source: 'source', amountOfChildren: 'amount of children',
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
    const raw = {
      id:           get(row, COL.id),
      name:         get(row, COL.name),
      neighborhood: get(row, COL.neighborhood),
      street:       get(row, COL.street),
      transport:    get(row, COL.transport),
      language:     get(row, COL.language),
      maxTravel:    get(row, COL.maxTravel),
      dob:          get(row, COL.dob),
      phone:        get(row, COL.phone),
    };
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
async function geocodeBatch(addresses) {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');

  return Promise.all(addresses.map(async (addr) => {
    try {
      const url  = `https://api.digitransit.fi/geocoding/v1/search?text=${encodeURIComponent(addr)}&size=1&boundary.country=FIN`;
      const resp = await fetch(url, { headers: { 'digitransit-subscription-key': key } });
      const data = await resp.json();
      const feat = data.features && data.features[0];
      if (!feat) return { address: addr, error: 'not found' };
      const [lon, lat] = feat.geometry.coordinates;
      return { address: addr, lat, lon };
    } catch (err) {
      return { address: addr, error: err.message };
    }
  }));
}

// ---------------------------------------------------------------------------
// Travel time — OSRM (car/walk) + Digitransit Routing API (transit)
// ---------------------------------------------------------------------------
async function travelTimeBatch(pairs) {
  return Promise.all(pairs.map(async (p) => {
    try {
      const minutes = p.mode === 'bus' ? await transitMinutes(p.from, p.to) : await osrmMinutes(p.from, p.to, p.mode);
      return { id: p.id, minutes };
    } catch (err) {
      return { id: p.id, error: err.message };
    }
  }));
}

async function osrmMinutes(from, to, mode) {
  const profile = mode === 'walk' ? 'foot' : 'car';
  const url     = `https://router.project-osrm.org/route/v1/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const resp    = await fetch(url);
  const data    = await resp.json();
  if (!data.routes || !data.routes.length) throw new Error('No OSRM route found');
  return data.routes[0].duration / 60;
}

async function transitMinutes(from, to) {
  const key = process.env.DIGITRANSIT_API_KEY;
  if (!key) throw new Error('DIGITRANSIT_API_KEY environment variable is not set');

  // NOTE: Digitransit GraphQL routing — tested against v2 Finland router.
  // If this returns errors, check the Digitransit GraphiQL explorer at
  // https://api.digitransit.fi/graphiql/finland/v2 for schema changes.
  const query = `{ plan(
    from: { lat: ${from.lat}, lon: ${from.lon} },
    to: { lat: ${to.lat}, lon: ${to.lon} },
    numItineraries: 1,
    transportModes: [{ mode: WALK }, { mode: BUS }, { mode: RAIL }, { mode: TRAM }, { mode: SUBWAY }]
  ) { itineraries { duration } } }`;

  const resp = await fetch('https://api.digitransit.fi/routing/v2/finland/gtfs/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'digitransit-subscription-key': key,
    },
    body: JSON.stringify({ query }),
  });
  const data         = await resp.json();
  const itineraries  = data.data?.plan?.itineraries;
  if (!itineraries?.length) throw new Error('No transit itinerary found');
  return itineraries[0].duration / 60;
}

// ---------------------------------------------------------------------------
// Isochrones — OpenRouteService v2
// ---------------------------------------------------------------------------
async function isochroneReq(locations, mode, minutes) {
  const key     = process.env.ORS_API_KEY;
  if (!key) throw new Error('ORS_API_KEY environment variable is not set');
  const profile = mode === 'walk' ? 'foot-walking' : 'driving-car';

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
async function dispatch(body) {
  console.log(body);
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
