// ============================================================================
// Village Matcher — local server
//
// Two modes, selected by how you invoke it:
//
// 1. CSV mode (no Google account needed — great for quick testing):
//      node local-test-server.js [csv-file] [port]
//    Reads applicants from a CSV export of your Google Sheet.
//    Groups/settings live in memory and reset on restart.
//    Geocoding and travel times return clearly-labelled fake values.
//
// 2. Google Sheets API mode (reads/writes the real sheet — no CORS issues):
//      node local-test-server.js service-account.json SPREADSHEET_ID [port]
//    Requires: npm install   (installs the googleapis package)
//    The server authenticates with a Google service account, so the browser
//    never has to deal with Google auth at all. Set the tool's Backend URL
//    to http://localhost:PORT (default 8791).
//
// In both modes the geocode/travelTime/isochrone actions return fake data
// (real API keys are not needed for testing the sheet-integration logic).
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const Validation = require("./src/validation.js");

// ---------------------------------------------------------------------------
// Argument parsing — detect mode from the first argument
//
// CSV mode:        node local-test-server.js [csv-file] [port]
// Sheets mode:     node local-test-server.js service-account.json SPREADSHEET_ID [tab-name] [port]
//
// tab-name defaults to auto-detecting the first non-helper tab in the sheet.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const isSheetMode = args[0] && args[0].endsWith(".json") && fs.existsSync(args[0]);

let csvPath, sheetKeyPath, spreadsheetId, sourceTabOverride, port;

if (isSheetMode) {
  sheetKeyPath  = args[0];
  spreadsheetId = args[1];
  if (!spreadsheetId) {
    console.error("Usage: node local-test-server.js service-account.json SPREADSHEET_ID [tab-name] [port]");
    process.exit(1);
  }
  // Remaining args: optional tab name (non-numeric) and/or port (numeric)
  for (const a of args.slice(2)) {
    if (/^\d+$/.test(a)) port = Number(a);
    else sourceTabOverride = a;
  }
  port = port || 8791;
} else {
  csvPath = args[0] || path.join(__dirname, "mock-applicants.csv");
  port = Number(args[1]) || 8791;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (used in CSV mode only)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // skip
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

// Column index → spreadsheet letter (0→A, 25→Z, 26→AA, …)
function colLetter(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

// Build a header→index map from the first row of a 2D array
function headerIndex(rows) {
  const hi = {};
  (rows[0] || []).forEach((h, i) => (hi[h.trim()] = i));
  return hi;
}

function cellGet(row, hi, col) {
  const i = hi[col];
  return i !== undefined ? (row[i] || "") : "";
}

// ---------------------------------------------------------------------------
// Fake geo/travel responses (deterministic, not random — same input → same
// output across runs so test results are stable)
// ---------------------------------------------------------------------------
const NEIGHBORHOOD_COORDS = {
  "Kallio": [60.1841, 24.9502],
  "Töölö": [60.1756, 24.9145],
  "Espoo keskus": [60.2052, 24.6522],
  "Kamppi": [60.1687, 24.9316],
  "Kruununhaka": [60.1710, 24.9580],
  "Punavuori": [60.1620, 24.9350],
};

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function fakeGeocode(addresses) {
  return addresses.map((addr) => {
    const neighborhood = Object.keys(NEIGHBORHOOD_COORDS).find((n) => addr.includes(n));
    const base = NEIGHBORHOOD_COORDS[neighborhood] || [60.1699, 24.9384];
    const h = stableHash(addr);
    return { address: addr, lat: base[0] + (((h % 1000) / 1000) - 0.5) * 0.01,
             lon: base[1] + ((((h >> 10) % 1000) / 1000) - 0.5) * 0.02, _fake: true };
  });
}
function fakeTravelTime(pairs) {
  return pairs.map((p) => ({ id: p.id, minutes: 4 + (stableHash(p.id) % 12), _fake: true }));
}
function fakeIsochrone() {
  return { type: "FeatureCollection", features: [], _fake: true, note: "local test server stub" };
}

// ---------------------------------------------------------------------------
// CSV mode — in-memory store seeded from a CSV file
// ---------------------------------------------------------------------------
let store = null;

function initCsvStore() {
  const csvRows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const hi = headerIndex(csvRows);
  const get = (row, h) => cellGet(row, hi, h);

  store = {
    applicants: csvRows.slice(1).map((row, i) => {
      const raw = {
        id: get(row, "Identity number"), name: get(row, "Name"),
        neighborhood: get(row, "Neighbourhood"), street: get(row, "Street address"),
        transport: get(row, "Transport"), language: get(row, "Language"),
        maxTravel: get(row, "travel time"), dob: get(row, "Date of birth"),
        phone: get(row, "Phone number"),
      };
      const a = Validation.normalizeApplicant(raw);
      a.sheetRow = i + 2;
      a.matchStatus = "unmatched"; a.matchGroupId = null;
      a.worries = get(row, "worries"); a.hopes = get(row, "hopes");
      a.questions = get(row, "questions"); a.source = get(row, "source");
      a.amountOfChildren = get(row, "amount of children");
      a.olderSiblingBirthMonth = get(row, "birth month");
      return a;
    }),
    groups: [],
    templates: { firstContact: "", confirmationAsk: "", introduction: "" },
    settings: { sourceTab: path.basename(csvPath), maxAgeGap: 6, minGroupSize: 3, maxGroupSize: 4 },
    nextGroupNum: 1,
  };

  console.log(`Loaded ${store.applicants.length} applicants from ${csvPath}`);
  console.log(`  - ${store.applicants.filter((a) => a.hasDataIssues).length} flagged with data issues`);
  console.log(`  - ${store.applicants.filter((a) => a.eligibleForMatching).length} eligible for matching`);
}

// ---------------------------------------------------------------------------
// Google Sheets API mode
// ---------------------------------------------------------------------------
let sheets = null; // googleapis Sheets client, initialised in initSheets()

// SOURCE_TAB is resolved at startup: use the --tab-name argument if given,
// otherwise auto-detect by picking the first tab that isn't one of the
// helper tabs (Groups, Message Templates, Settings).
let SOURCE_TAB = sourceTabOverride || null; // filled in by ensureHelperTabs_
const GROUPS_TAB    = "Groups";
const TEMPLATES_TAB = "Message Templates";
const SETTINGS_TAB  = "Settings";
const HELPER_TABS   = new Set([GROUPS_TAB, TEMPLATES_TAB, SETTINGS_TAB]);

// Column names matching the real Google Sheet column headers
const COL = {
  id: "Identity number", name: "Name", neighborhood: "Neighbourhood",
  street: "Street address", transport: "Transport", language: "Language",
  maxTravel: "travel time", dob: "Date of birth", phone: "Phone number",
  matchStatus: "Match Status", matchGroupId: "Match Group ID",
  olderSiblingBirthMonth: "birth month",
  worries: "worries", hopes: "hopes", questions: "questions",
  source: "source", amountOfChildren: "amount of children",
};

async function initSheets() {
  let google;
  try {
    ({ google } = require("googleapis"));
  } catch {
    console.error("\n❌  Missing dependency. Run:  npm install\n");
    process.exit(1);
  }

  const key = JSON.parse(fs.readFileSync(sheetKeyPath, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });

  // Verify the connection and ensure helper tabs exist
  try {
    await ensureHelperTabs_();
    console.log(`Connected to spreadsheet ${spreadsheetId}`);
    console.log(`Source tab: "${SOURCE_TAB}"`);
  } catch (err) {
    console.error(`\n❌  Could not connect to spreadsheet:\n    ${err.message}`);
    if (!err.message.includes("Tab ")) {
      // Generic error — likely wrong ID or sheet not shared
      console.error("\nCheck that:");
      console.error(`  1. The spreadsheet ID is correct`);
      console.error(`  2. You shared the sheet with: ${key.client_email}\n`);
    }
    process.exit(1);
  }
}

async function readRows(tabName) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'!A1:ZZ`,
  });
  return resp.data.values || [];
}

async function ensureHelperTabs_() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  const allTitles = meta.data.sheets.map((s) => s.properties.title);
  const titleSet  = new Set(allTitles);

  // Resolve the source tab
  if (SOURCE_TAB) {
    // Explicit tab name given — validate it exists
    if (!titleSet.has(SOURCE_TAB)) {
      const available = allTitles.filter((t) => !HELPER_TABS.has(t));
      throw new Error(
        `Tab "${SOURCE_TAB}" not found in the spreadsheet.\n` +
        `Available tabs: ${allTitles.map((t) => `"${t}"`).join(", ")}\n` +
        `Pass the correct name: node local-test-server.js key.json SHEET_ID "tab name" [port]`
      );
    }
  } else {
    // Auto-detect: first tab that isn't a helper tab
    const candidate = allTitles.find((t) => !HELPER_TABS.has(t));
    if (!candidate) throw new Error("No data tab found in the spreadsheet (only helper tabs exist).");
    SOURCE_TAB = candidate;
    console.log(`Auto-detected source tab: "${SOURCE_TAB}"`);
  }

  // Create missing helper tabs
  const requests = [];
  for (const title of [GROUPS_TAB, TEMPLATES_TAB, SETTINGS_TAB]) {
    if (!titleSet.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
  }

  // Ensure the Groups tab has headers
  const groupRows = await readRows(GROUPS_TAB);
  if (!groupRows.length || groupRows[0][0] !== "Group ID") {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${GROUPS_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [["Group ID", "Name", "Member IDs", "Status", "Created", "Updated"]] },
    });
  }

  // Ensure Match Status / Match Group ID columns exist on the source tab
  const sourceRows = await readRows(SOURCE_TAB);
  if (sourceRows.length) {
    const hi = headerIndex(sourceRows);
    const headers = sourceRows[0];
    const missing = [];
    if (hi[COL.matchStatus]  === undefined) missing.push(COL.matchStatus);
    if (hi[COL.matchGroupId] === undefined) missing.push(COL.matchGroupId);
    if (missing.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `'${SOURCE_TAB}'!${colLetter(headers.length)}1`,
        valueInputOption: "USER_ENTERED",
        resource: { values: [missing] },
      });
    }
  }
}

async function sheetGetApplicants() {
  const rows = await readRows(SOURCE_TAB);
  if (rows.length < 2) return [];
  const hi = headerIndex(rows);
  const get = (row, col) => cellGet(row, hi, col);
  return rows.slice(1).map((row, i) => {
    const raw = {
      id: get(row, COL.id), name: get(row, COL.name),
      neighborhood: get(row, COL.neighborhood), street: get(row, COL.street),
      transport: get(row, COL.transport), language: get(row, COL.language),
      maxTravel: get(row, COL.maxTravel), dob: get(row, COL.dob),
      phone: get(row, COL.phone),
    };
    const a = Validation.normalizeApplicant(raw);
    a.sheetRow = i + 2;
    a.matchStatus = get(row, COL.matchStatus) || "unmatched";
    a.matchGroupId = get(row, COL.matchGroupId) || null;
    a.worries = get(row, "worries"); a.hopes = get(row, "hopes");
    a.questions = get(row, "questions"); a.source = get(row, "source");
    a.amountOfChildren = get(row, "amount of children");
    a.olderSiblingBirthMonth = get(row, COL.olderSiblingBirthMonth);
    return a;
  });
}

async function sheetUpdateApplicant(id, fields) {
  const rows = await readRows(SOURCE_TAB);
  if (!rows.length) throw new Error("Source tab is empty");
  const hi = headerIndex(rows);

  // Find the row (1-indexed, row 1 = headers, row 2 = first data row)
  const rowIdx = rows.findIndex((r, i) => i > 0 && (r[hi[COL.id]] || "") === id);
  if (rowIdx === -1) throw new Error(`Applicant '${id}' not found in sheet`);
  const sheetRow = rowIdx + 1; // 1-indexed for Sheets API

  const updates = [];
  if (fields.matchStatus !== undefined) {
    let col = hi[COL.matchStatus];
    if (col === undefined) { col = rows[0].length; } // will be added by ensureHelperTabs
    updates.push({
      range: `'${SOURCE_TAB}'!${colLetter(col)}${sheetRow}`,
      values: [[fields.matchStatus]],
    });
  }
  if (fields.matchGroupId !== undefined) {
    let col = hi[COL.matchGroupId];
    if (col === undefined) { col = rows[0].length + (hi[COL.matchStatus] === undefined ? 1 : 0); }
    updates.push({
      range: `'${SOURCE_TAB}'!${colLetter(col)}${sheetRow}`,
      values: [[fields.matchGroupId || ""]],
    });
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: { valueInputOption: "USER_ENTERED", data: updates },
    });
  }
  return { updated: true, id };
}

async function sheetGetGroups() {
  const rows = await readRows(GROUPS_TAB);
  if (rows.length < 2) return [];
  const hi = headerIndex(rows);
  return rows.slice(1).map((row) => ({
    id:        cellGet(row, hi, "Group ID"),
    name:      cellGet(row, hi, "Name"),
    memberIds: (cellGet(row, hi, "Member IDs") || "").split(",").map((s) => s.trim()).filter(Boolean),
    status:    cellGet(row, hi, "Status") || "open",
    created:   cellGet(row, hi, "Created"),
    updated:   cellGet(row, hi, "Updated"),
  }));
}

let nextGroupNum = 1;

async function sheetCreateGroup(groupData) {
  // Derive next group number from existing rows
  const existing = await sheetGetGroups();
  const max = Math.max(0, ...existing.map((g) => Number((g.id || "").replace("G-", "")) || 0));
  nextGroupNum = max + 1;

  const id = "G-" + String(nextGroupNum++).padStart(3, "0");
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `'${GROUPS_TAB}'!A:F`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[id, groupData.name, groupData.memberIds.join(", "), groupData.status || "open", now, now]] },
  });
  return { id };
}

async function sheetUpdateGroup(id, fields) {
  const rows = await readRows(GROUPS_TAB);
  const hi = headerIndex(rows);
  const rowIdx = rows.findIndex((r, i) => i > 0 && (r[hi["Group ID"]] || "") === id);
  if (rowIdx === -1) throw new Error(`Group '${id}' not found`);
  const sheetRow = rowIdx + 1;

  const updates = [];
  if (fields.status !== undefined) {
    updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi["Status"])}${sheetRow}`, values: [[fields.status]] });
  }
  if (fields.memberIds !== undefined) {
    updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi["Member IDs"])}${sheetRow}`, values: [[fields.memberIds.join(", ")]] });
  }
  updates.push({ range: `'${GROUPS_TAB}'!${colLetter(hi["Updated"])}${sheetRow}`, values: [[new Date().toISOString()]] });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    resource: { valueInputOption: "USER_ENTERED", data: updates },
  });
  return { updated: true, id };
}

async function sheetGetTemplates() {
  const rows = await readRows(TEMPLATES_TAB);
  const hi = headerIndex(rows);
  const data = rows[1] || [];
  return {
    firstContact:    cellGet(data, hi, "First Contact") || "",
    confirmationAsk: cellGet(data, hi, "Confirmation Ask") || "",
    introduction:    cellGet(data, hi, "Introduction") || "",
  };
}

async function sheetSaveTemplates(templates) {
  const HEADERS = ["First Contact", "Confirmation Ask", "Introduction"];
  const rows = await readRows(TEMPLATES_TAB);
  if (!rows.length || rows[0][0] !== "First Contact") {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${TEMPLATES_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [HEADERS, [templates.firstContact || "", templates.confirmationAsk || "", templates.introduction || ""]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${TEMPLATES_TAB}'!A2`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[templates.firstContact || "", templates.confirmationAsk || "", templates.introduction || ""]] },
    });
  }
  return { saved: true };
}

async function sheetGetSettings() {
  const rows = await readRows(SETTINGS_TAB);
  const hi = headerIndex(rows);
  const data = rows[1] || [];
  return {
    maxAgeGap:    Number(cellGet(data, hi, "maxAgeGap"))    || 6,
    minGroupSize: Number(cellGet(data, hi, "minGroupSize")) || 3,
    maxGroupSize: Number(cellGet(data, hi, "maxGroupSize")) || 4,
  };
}

async function sheetSaveSettings(settings) {
  const HEADERS = ["maxAgeGap", "minGroupSize", "maxGroupSize"];
  const rows = await readRows(SETTINGS_TAB);
  if (!rows.length || rows[0][0] !== "maxAgeGap") {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${SETTINGS_TAB}'!A1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [HEADERS, [settings.maxAgeGap ?? 6, settings.minGroupSize ?? 3, settings.maxGroupSize ?? 4]] },
    });
  } else {
    // Only overwrite provided fields
    const cur = rows[1] || [];
    const hi = headerIndex(rows);
    const row = [...cur];
    if (settings.maxAgeGap    !== undefined) row[hi["maxAgeGap"]]    = settings.maxAgeGap;
    if (settings.minGroupSize !== undefined) row[hi["minGroupSize"]] = settings.minGroupSize;
    if (settings.maxGroupSize !== undefined) row[hi["maxGroupSize"]] = settings.maxGroupSize;
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${SETTINGS_TAB}'!A2`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [row] },
    });
  }
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Action dispatch — async-capable; wraps both modes uniformly
// ---------------------------------------------------------------------------
async function dispatch(body) {
  const { action } = body;

  // Geo/routing actions: always fake in this server regardless of mode
  if (action === "ping")       return { time: new Date().toISOString(), server: "local-test-server" + (isSheetMode ? " (Sheets API)" : " (CSV)") };
  if (action === "geocode")    return fakeGeocode(body.addresses);
  if (action === "travelTime") return fakeTravelTime(body.pairs);
  if (action === "isochrone")  return fakeIsochrone();

  if (isSheetMode) {
    switch (action) {
      case "getApplicants":  return sheetGetApplicants();
      case "updateApplicant": return sheetUpdateApplicant(body.id, body.fields);
      case "getGroups":      return sheetGetGroups();
      case "createGroup":    return sheetCreateGroup(body.group);
      case "updateGroup":    return sheetUpdateGroup(body.id, body.fields);
      case "getTemplates":   return sheetGetTemplates();
      case "saveTemplates":  return sheetSaveTemplates(body.templates);
      case "getSettings":    return sheetGetSettings();
      case "saveSettings":   return sheetSaveSettings(body.settings);
    }
  } else {
    // CSV / in-memory mode
    switch (action) {
      case "getApplicants": return store.applicants;
      case "updateApplicant": {
        const a = store.applicants.find((a) => a.id === body.id);
        if (!a) throw new Error(`Applicant '${body.id}' not found`);
        if (body.fields.matchStatus  !== undefined) a.matchStatus  = body.fields.matchStatus;
        if (body.fields.matchGroupId !== undefined) a.matchGroupId = body.fields.matchGroupId || null;
        return { updated: true, id: body.id };
      }
      case "getGroups": return store.groups;
      case "createGroup": {
        const id = "G-" + String(store.nextGroupNum++).padStart(3, "0");
        const now = new Date().toISOString();
        store.groups.push({ id, name: body.group.name, memberIds: body.group.memberIds, status: body.group.status || "open", created: now, updated: now });
        return { id };
      }
      case "updateGroup": {
        const g = store.groups.find((g) => g.id === body.id);
        if (!g) throw new Error(`Group '${body.id}' not found`);
        Object.assign(g, body.fields, { updated: new Date().toISOString() });
        return { updated: true, id: body.id };
      }
      case "getTemplates":  return store.templates;
      case "saveTemplates": Object.assign(store.templates, body.templates); return { saved: true };
      case "getSettings":   return store.settings;
      case "saveSettings":  Object.assign(store.settings, body.settings); return { saved: true };
    }
  }
  throw new Error("Unknown action: " + action);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Only POST is supported" }));
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    res.setHeader("Content-Type", "application/json");
    try {
      const body = JSON.parse(raw);
      const result = await dispatch(body);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  if (isSheetMode) {
    console.log(`\nStarting in Google Sheets API mode...`);
    await initSheets();
  } else {
    initCsvStore();
  }

  server.listen(port, () => {
    console.log(`\nLocal test server running at http://localhost:${port}`);
    console.log(`Paste that URL into the tool's Templates & Settings > Backend URL field.\n`);
  });
}

start().catch((err) => { console.error(err); process.exit(1); });

// Exported for the smoke tests (CSV mode interface stays the same)
module.exports = { dispatch, parseCsv };
