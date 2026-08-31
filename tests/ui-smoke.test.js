// UI-level smoke test: loads the REAL index.html markup and REAL app.js /
// matching-engine.js / validation.js / mock-data.js into a jsdom window,
// pointed at a REAL local-test-server.js instance over REAL HTTP (Node's
// built-in fetch) — the only thing faked is Leaflet itself (jsdom has no
// map canvas/tile-rendering to test against, so map calls are stubbed to
// no-ops). Everything else — state management, backend sync, DOM
// rendering — is the actual shipped code.
//
// This is the closest thing to browser E2E achievable without a real
// browser in this environment. See SELF-REVIEW.md for what this does and
// doesn't cover. Run manually in a real browser before going live.
//
// Run with: node --test tests/ui-smoke.test.js
// Requires the `jsdom` package (npm install jsdom) — not needed to run the
// tool itself, only this specific test.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawn } = require("node:child_process");
const { JSDOM } = require("jsdom");

const SERVER_PATH = path.join(__dirname, "..", "local-test-server.js");
const CSV_PATH = path.join(__dirname, "..", "mock-applicants.csv");
const PORT = 8793;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess;

test.beforeEach(async () => {
  serverProcess = spawn("node", [SERVER_PATH, CSV_PATH, String(PORT)], { stdio: "pipe" });
  await new Promise((resolve, reject) => {
    let out = "";
    const timeout = setTimeout(() => reject(new Error("Server didn't start in time:\n" + out)), 5000);
    serverProcess.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("running at")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

test.afterEach(async () => {
  serverProcess.kill();
  // Give the OS a moment to release the port before the next test's server binds it.
  await new Promise((r) => setTimeout(r, 150));
});

function fakeLeaflet() {
  function chainable() {
    const obj = {};
    ["addTo", "setView", "bindPopup", "clearLayers"].forEach((m) => (obj[m] = () => obj));
    return obj;
  }
  return {
    map: () => chainable(),
    tileLayer: () => chainable(),
    layerGroup: () => chainable(),
    circleMarker: () => chainable(),
    circle: () => chainable(),
    geoJSON: () => chainable(),
  };
}

// Builds a jsdom window with the real markup + real scripts evaluated in
// the real order, backend URL pre-configured, Leaflet stubbed.
//
// Note: this uses actual <script> element injection (not window.eval) —
// jsdom's window.eval() runs in a context where bare DOM globals like
// `document` aren't resolvable, but a real <script> tag executes in the
// window's true global scope, same as a browser. Original <script src="">
// tags (the CDN Leaflet include, and our own files) are stripped from the
// markup first so jsdom doesn't try to fetch them over the network.
function buildWindow() {
  const rawHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const htmlWithoutScripts = rawHtml.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "");
  // Include ?backend= so API_URL in app.js resolves to the local server,
  // and pre-set the password so init() skips the gate (local server ignores it).
  const dom = new JSDOM(htmlWithoutScripts, { url: `http://localhost/?backend=${BASE_URL}`, runScripts: "dangerously" });
  const { window } = dom;

  window.L = fakeLeaflet();
  window.fetch = fetch; // Node's built-in global fetch, shared across realms
  window.alert = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  window.localStorage.setItem("matcherPassword", "test");

  const files = ["src/matching-engine.js", "src/validation.js", "src/mock-data.js", "src/app.js"];
  files.forEach((f) => {
    const script = window.document.createElement("script");
    script.textContent = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    window.document.body.appendChild(script); // executes immediately (runScripts: "dangerously")
  });

  // Top-level `const`/`let` in a <script> tag aren't exposed as window
  // properties (this is correct, standard browser behavior — only `var`
  // and function declarations are). This tiny test-only script, appended
  // after the real ones, exposes exactly what the tests need via the
  // shared lexical scope, without changing a single line of the shipped
  // app.js.
  const hook = window.document.createElement("script");
  hook.textContent = `window.__test__ = {
    get state() { return state; },
    computeCandidateGroups, approveGroup, rejectGroup, markStatus,
    getApplicant, renderCandidateCards, renderAll, waLink, syncToBackend, init,
    populateNeighborhoodFilter, renderSettingsTab,
  };`;
  window.document.body.appendChild(hook);

  return window;
}

test("UI smoke: init() loads real applicants from the backend into state", async () => {
  const window = buildWindow();
  await window.__test__.init();
  assert.equal(window.__test__.state.usingBackendData, true);
  assert.equal(window.__test__.state.applicants.length, 18);
  assert.equal(window.__test__.state.applicants.filter((a) => a.hasDataIssues).length, 3);
});

test("UI smoke: data issues render into the DOM with readable reasons", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const html = window.document.getElementById("dataIssuesList").innerHTML;
  assert.match(html, /Outi/);
  assert.match(html, /skateboard/i);
});

test("UI smoke: unmatched applicant ID opens row details", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const btn = window.document.querySelector("#unmatchedList .id-toggle");
  assert.ok(btn, "expected unmatched applicant ID button");

  const details = btn.closest(".unmatched-card").querySelector(".applicant-details");
  assert.equal(details.hidden, true);

  btn.click();

  assert.equal(details.hidden, false);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.match(details.textContent, /Phone/);
});

test("UI smoke: a malicious phone number is escaped, not injected as markup", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const victim = window.__test__.state.applicants[0];
  victim.phone = `+358401234501"><img src=x onerror="window.__pwned=1">`;
  window.__test__.renderAll();

  const details = window.document.querySelector("#unmatchedList .applicant-details");
  assert.equal(window.__pwned, undefined, "injected markup must not execute");
  assert.equal(details.querySelectorAll("img").length, 0, "injected element must not be created");

  const link = details.querySelector('a[href^="https://wa.me/"]');
  assert.ok(link, "expected a WhatsApp link for a phone number");
  assert.match(link.getAttribute("href"), /^https:\/\/wa\.me\/\d+$/, "href must be digits only");
  assert.match(link.textContent, /onerror/, "the raw value is shown as text, not parsed as markup");
});

test("UI smoke: a blank phone number renders no WhatsApp link", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const victim = window.__test__.state.applicants[0];
  victim.phone = "";
  window.__test__.renderAll();

  const details = window.document.querySelector("#unmatchedList .applicant-details");
  assert.equal(details.querySelectorAll('a[href^="https://wa.me/"]').length, 0);
  assert.doesNotMatch(details.textContent, /Phone/);
});

test("UI smoke: active groups render applicants grouped by village", async () => {
  const window = buildWindow();
  await window.__test__.init();

  window.__test__.state.applicants[0].village = "Kallio Village";
  window.__test__.state.applicants[1].village = "Kallio Village";
  window.__test__.state.applicants[2].village = null;
  window.__test__.renderAll();

  const activeGroups = window.document.getElementById("activeGroups");
  const unmatchedList = window.document.getElementById("unmatchedList");
  assert.match(activeGroups.textContent, /Kallio Village · 2 moms/);
  assert.match(activeGroups.textContent, new RegExp(window.__test__.state.applicants[0].id));
  assert.doesNotMatch(activeGroups.textContent, new RegExp(`${window.__test__.state.applicants[2].id}.*Sara`, "s"));
  assert.doesNotMatch(unmatchedList.textContent, new RegExp(window.__test__.state.applicants[0].id));
  assert.match(unmatchedList.textContent, new RegExp(window.__test__.state.applicants[2].id));

  const btn = activeGroups.querySelector(".id-toggle");
  const details = btn.closest(".applicant-card").querySelector(".applicant-details");
  btn.click();
  assert.equal(details.hidden, false);
  assert.match(details.textContent, /Phone/);
});

test("UI smoke: running the matching engine produces candidate groups and renders them", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const groups = await window.__test__.computeCandidateGroups();
  assert.ok(groups.length > 0, "expected at least one candidate group from the real dataset");

  window.__test__.state.candidateGroups = groups;
  window.__test__.renderCandidateCards();
  const candidateCards = window.document.getElementById("candidateCards");
  const html = candidateCards.innerHTML;
  const firstMemberName = window.__test__.getApplicant(groups[0].memberIds[0]).name;
  assert.match(html, new RegExp(firstMemberName));
  assert.match(html, /Approve/);

  const btn = candidateCards.querySelector(".id-toggle");
  const details = btn.closest(".applicant-card").querySelector(".applicant-details");
  assert.equal(details.hidden, true);
  btn.click();
  assert.equal(details.hidden, false);
  assert.match(details.textContent, /Phone/);
  assert.ok(candidateCards.querySelector(".participant-map-dot"), "expected candidate participant map color dot");
});

test("UI smoke: approving a group persists to the backend (real HTTP round trip)", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const groups = await window.__test__.computeCandidateGroups();
  window.__test__.state.candidateGroups = groups;
  const candidateId = groups[0].candidateId;
  const memberIds = groups[0].memberIds;

  await window.__test__.approveGroup(candidateId);

  // Check the UI's own state updated...
  assert.equal(window.__test__.state.groups.length, 1);
  memberIds.forEach((id) => {
    assert.equal(window.__test__.getApplicant(id).matchStatus, "match_found");
  });

  // ...AND that it actually reached the server, via an independent request
  // that doesn't go through the app's own state at all.
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getApplicants" }),
  });
  const { result: freshApplicants } = await resp.json();
  memberIds.forEach((id) => {
    const a = freshApplicants.find((a) => a.id === id);
    assert.equal(a.matchStatus, "match_found", `expected ${id} to be match_found on the server`);
    assert.equal(a.matchGroupId, window.__test__.state.groups[0].id);
  });
});

test("UI smoke: advancing status through the full pipeline reaches the backend each step", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const groups = await window.__test__.computeCandidateGroups();
  assert.ok(groups.length > 0, "expected at least one candidate group to advance through the pipeline");
  window.__test__.state.candidateGroups = groups;
  const candidateId = groups[0].candidateId;
  const memberIds = groups[0].memberIds;
  await window.__test__.approveGroup(candidateId);
  const groupId = window.__test__.state.groups[0].id;

  for (const status of ["contacted", "confirmed", "introduced"]) {
    memberIds.forEach((id) => window.__test__.markStatus(id, status));
  }

  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getApplicants" }),
  });
  const { result: freshApplicants } = await resp.json();
  memberIds.forEach((id) => {
    assert.equal(freshApplicants.find((a) => a.id === id).matchStatus, "introduced");
  });

  const groupsResp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getGroups" }),
  });
  const { result: freshGroups } = await groupsResp.json();
  const group = freshGroups.find((g) => g.id === groupId);
  assert.equal(group.status, "established", "group should auto-establish once a member is confirmed/introduced");
});

test("UI smoke: WhatsApp link is built with a normalized phone number and filled template", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const lisa = window.__test__.state.applicants.find((a) => a.name === "Lisa");
  window.__test__.state.templates.firstContact = "Hi {{name}} from {{neighborhood}}!";
  const link = window.__test__.waLink(lisa, window.__test__.state.templates.firstContact, null);
  assert.match(link, /^https:\/\/wa\.me\/358401234501\?text=/);
  assert.match(decodeURIComponent(link), /Hi Lisa from Kallio!/);
});

test("UI smoke: settings changes round-trip to the backend", async () => {
  const window = buildWindow();
  await window.__test__.init();
  window.__test__.syncToBackend("saveSettings", { settings: { maxAgeGap: 9 } });
  await new Promise((r) => setTimeout(r, 200)); // fire-and-forget — give it a beat to land
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getSettings" }),
  });
  const { result } = await resp.json();
  assert.equal(result.maxAgeGap, 9);
});
