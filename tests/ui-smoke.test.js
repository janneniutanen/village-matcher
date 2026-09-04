// UI-level smoke test: loads the REAL index.html markup and REAL app.js /
// matching-engine.js / validation.js into a jsdom window,
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
const { JSDOM, VirtualConsole } = require("jsdom");

const SERVER_PATH = path.join(__dirname, "..", "local-test-server.js");
const CSV_PATH = path.join(__dirname, "..", "mock-applicants.csv");
const PORT = 8793;
const BASE_URL = `http://localhost:${PORT}`;   // first port; each test takes the next

let serverProcess;
// A fresh port per test. Reusing one and sleeping 150ms for the OS to release
// it was a race that lost intermittently, and the failure landed on whichever
// test ran next rather than on anything broken.
let nextPort = PORT;
let baseUrl = BASE_URL;

test.beforeEach(async () => {
  const port = nextPort++;
  baseUrl = `http://localhost:${port}`;
  serverProcess = spawn("node", [SERVER_PATH, CSV_PATH, String(port)], { stdio: "pipe" });
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

test.afterEach(() => {
  serverProcess.kill();
});

// Records what the app asked Leaflet to draw, so map behaviour that is not in
// the DOM is still assertable without a browser.
function fakeLeaflet(record) {
  function chainable(extra = {}) {
    const obj = {
      addTo:      () => obj,
      clearLayers: () => obj,
      invalidateSize: () => obj,
      setView:    (...args) => { record.setViews.push(args); return obj; },
      fitBounds:  (bounds, opts) => { record.fitBounds.push({ bounds, opts }); return obj; },
      getZoom:    () => 12,
      bindPopup:  (html) => { obj.popupHtml = html; return obj; },
      bindTooltip: (text, opts) => { obj.tooltip = text; record.tooltips.push({ text, opts }); return obj; },
      openPopup:  () => { record.openedPopups.push(obj.popupHtml); return obj; },
    };
    Object.assign(obj, extra);
    return obj;
  }
  return {
    map: () => chainable(),
    tileLayer: () => chainable(),
    layerGroup: () => chainable(),
    circleMarker: (coords, opts) => {
      const marker = chainable({ getLatLng: () => coords, coords, opts });
      record.markers.push(marker);
      return marker;
    },
    circle: () => chainable(),
    geoJSON: () => chainable(),
    rectangle: () => chainable(),
    polyline: (points, opts) => { record.polylines.push({ points, opts }); return chainable(); },
    divIcon: (opts) => { record.divIcons.push(opts); return opts; },
    marker: (coords, opts) => {
      const m = chainable({ coords, opts });
      record.meetingMarkers.push(m);
      return m;
    },
    latLngBounds: (coords) => { record.bounds.push(coords); return { coords }; },
  };
}

// Applicant writes are fire-and-forget by design: app.js updates local state
// immediately and posts in the background so the UI never waits on a round
// trip. Asserting on the server the instant after an approval is therefore a
// race, and it lost intermittently on a loaded machine. Poll instead.
async function waitForServer(check, describe) {
  const deadline = Date.now() + 4000;
  let last;
  while (Date.now() < deadline) {
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "getApplicants" }),
    });
    const { result } = await resp.json();
    last = result;
    if (check(result)) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${describe} did not reach the server within 4s`);
  return last;
}

function newLeafletRecord() {
  return {
    markers: [], tooltips: [], setViews: [], fitBounds: [], bounds: [], openedPopups: [],
    polylines: [], divIcons: [], meetingMarkers: [],
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
function buildWindow(transformSource = (src) => src) {
  const rawHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const htmlWithoutScripts = rawHtml.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "");
  // Include ?backend= so API_URL in app.js resolves to the local server,
  // and pre-set the password so init() skips the gate (local server ignores it).
  // Forward the page's console to the test output. jsdom discards it by
  // default, which hides the console.warn that app.js emits when a backend
  // call fails — so a broken fetch looked like an empty result set.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn",  (msg) => console.error("  [page warn]", msg));
  virtualConsole.on("error", (msg) => console.error("  [page error]", msg));
  virtualConsole.on("jsdomError", (err) => console.error("  [jsdom error]", err.message));
  const dom = new JSDOM(htmlWithoutScripts, { url: `http://localhost/?backend=${baseUrl}`, runScripts: "dangerously", virtualConsole });
  const { window } = dom;

  const leafletRecord = newLeafletRecord();
  window.__leaflet__ = leafletRecord;
  window.L = fakeLeaflet(leafletRecord);
  window.fetch = fetch; // Node's built-in global fetch, shared across realms
  window.alert = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  window.localStorage.setItem("matcherPassword", "test");

  // Read from index.html, so adding a script to the page cannot leave these
  // tests loading a different set. That happened, and every meeting-point
  // test failed with "Reachability is not defined".
  const files = [...rawHtml.matchAll(/<script src="(src\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(files.length >= 3, `expected the app's scripts in index.html, got ${files.join(", ")}`);
  files.forEach((f) => {
    const script = window.document.createElement("script");
    script.textContent = transformSource(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
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
    renderMap, groupApplicantsByLocation, focusApplicantOnMap, selectApplicantOnMap,
    showMeetingPlaces, travelMode,
  };`;
  window.document.body.appendChild(hook);

  return window;
}

test("UI smoke: init() loads real applicants from the backend into state", async () => {
  const window = buildWindow();
  await window.__test__.init();
  assert.equal(window.__test__.state.usingBackendData, true);
  const dataRows = fs.readFileSync(CSV_PATH, "utf8").trim().split(/\r?\n/).length - 1;
  assert.equal(window.__test__.state.applicants.length, dataRows);
  assert.ok(window.__test__.state.applicants.filter((a) => a.hasDataIssues).length > 0);
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
  const excluded = window.__test__.state.applicants[2];
  assert.doesNotMatch(activeGroups.textContent, new RegExp(`${excluded.id}.*${excluded.name}`, "s"));
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

test("UI smoke: candidate cards show rank, total score and the breakdown", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const groups = await window.__test__.computeCandidateGroups();
  assert.ok(groups.length >= 2, "need at least two groups to check ranking");

  window.__test__.state.candidateGroups = groups;
  window.__test__.renderCandidateCards();
  const cards = window.document.querySelectorAll("#candidateCards .card");

  // Rank badges are sequential and the score matches the engine.
  assert.equal(cards[0].querySelector(".rank-badge").textContent, "#1");
  assert.equal(cards[1].querySelector(".rank-badge").textContent, "#2");
  const shown = Number(cards[0].querySelector(".badge-score").textContent.replace(/\D/g, ""));
  assert.equal(shown, Math.round(groups[0].score.total * 100));

  // All three signals are broken out, each with a bar width matching its value.
  const rows = cards[0].querySelectorAll(".score-row");
  assert.equal(rows.length, 3);
  const labels = [...rows].map((r) => r.querySelector(".score-label").textContent);
  assert.deepEqual(labels, ["Travel", "Baby age", "Language"]);
  ["travel", "age", "language"].forEach((key, i) => {
    const expected = Math.round(groups[0].score[key] * 100);
    assert.equal(rows[i].querySelector(".score-value").textContent, `${expected}%`);
    assert.equal(rows[i].querySelector(".score-fill").style.width, `${expected}%`);
  });
});

test("UI smoke: candidate view states where travel times came from", async () => {
  const window = buildWindow();
  await window.__test__.init();
  await window.__test__.computeCandidateGroups();

  const stats = window.__test__.state.travelTimeStats;
  assert.ok(stats && stats.total > 0, "expected travel-time provenance to be recorded");
  assert.equal(stats.routed + stats.estimated, stats.total);

  window.__test__.renderCandidateCards();
  const note = window.document.querySelector("#candidateCards .source-note");
  assert.ok(note, "expected a note saying where travel times came from");
  assert.match(note.textContent, /Digitransit/);

  // The dev server answers every routing request, so nothing should be an
  // estimate here — the warning variant only appears when routing fails.
  assert.equal(stats.estimated, 0, "dev server routes every pair");
  assert.ok(note.classList.contains("source-note-ok"), `unexpected class: ${note.className}`);
});

test("UI smoke: implausible routed times are reported separately from missing ones", async () => {
  const window = buildWindow();
  await window.__test__.init();

  // A routing service that answers with impossible numbers is a different
  // problem from one that is unreachable, and the note must say which.
  window.__test__.state.travelTimeStats = { total: 40, routed: 36, estimated: 4, rejected: 4 };
  window.__test__.state.travelTimeError = "implausible routed time (7 min for 2.2 km by W)";
  window.__test__.renderCandidateCards();

  const note = window.document.querySelector("#candidateCards .source-note");
  assert.ok(note.classList.contains("source-note-warn"));
  assert.match(note.textContent, /4 routed journeys were discarded as impossible/);
  assert.match(note.textContent, /implausible routed time/);
});

test("UI smoke: falling back to estimates is reported, not hidden", async () => {
  const window = buildWindow();
  await window.__test__.init();

  // Simulate the routing API being unreachable, which is what a bad
  // DIGITRANSIT_API_KEY looks like from the frontend.
  window.__test__.state.travelTimeStats = { total: 40, routed: 0, estimated: 40 };
  window.__test__.state.travelTimeError = "HTTP 401 invalid subscription key";
  window.__test__.renderCandidateCards();

  const note = window.document.querySelector("#candidateCards .source-note");
  assert.ok(note.classList.contains("source-note-warn"));
  assert.match(note.textContent, /40 \(100%\) fell back to straight-line estimates/);
  assert.match(note.textContent, /401 invalid subscription key/);
});

test("UI smoke: cards are ordered strongest first", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const groups = await window.__test__.computeCandidateGroups();

  window.__test__.state.candidateGroups = groups;
  window.__test__.renderCandidateCards();

  const shown = [...window.document.querySelectorAll("#candidateCards .badge-score")]
    .map((b) => Number(b.textContent.replace(/\D/g, "")));
  const descending = shown.every((v, i) => i === 0 || shown[i - 1] >= v);
  assert.ok(descending, `expected descending scores, got ${shown.join(", ")}`);
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

  // ...AND that it reached the server, read back independently of the app's
  // own state.
  const freshApplicants = await waitForServer(
    (rows) => memberIds.every((id) => rows.find((a) => a.id === id)?.matchStatus === "match_found"),
    "the approved members"
  );
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

  const freshApplicants = await waitForServer(
    (rows) => memberIds.every((id) => rows.find((a) => a.id === id)?.matchStatus === "introduced"),
    "the advanced statuses"
  );
  memberIds.forEach((id) => {
    assert.equal(freshApplicants.find((a) => a.id === id).matchStatus, "introduced");
  });

  const groupsResp = await fetch(baseUrl, {
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
  const person = window.__test__.state.applicants.find((a) => a.eligibleForMatching);
  window.__test__.state.templates.firstContact = "Hi {{name}} from {{neighborhood}}!";
  const link = window.__test__.waLink(person, window.__test__.state.templates.firstContact, null);
  // The sheet holds numbers in assorted local formats; the link must carry the
  // normalized international number with no '+' or separators.
  assert.match(link, new RegExp(`^https://wa\\.me/${person.phone.replace(/\D/g, "")}\\?text=`));
  assert.match(link, /^https:\/\/wa\.me\/358\d+\?text=/);
  assert.match(decodeURIComponent(link), new RegExp(`Hi ${person.name} from ${person.neighborhood}!`));
});

test("UI smoke: settings changes round-trip to the backend", async () => {
  const window = buildWindow();
  await window.__test__.init();
  window.__test__.syncToBackend("saveSettings", { settings: { maxAgeGap: 9 } });
  await new Promise((r) => setTimeout(r, 200)); // fire-and-forget — give it a beat to land
  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getSettings" }),
  });
  const { result } = await resp.json();
  assert.equal(result.maxAgeGap, 9);
});

// ---------------------------------------------------------------------------
// Map behaviour. Two people at one address used to be drawn as two markers on
// the same pixel, so the second was invisible: a 17-person dataset showed as
// 7 dots and there was no way to tell from the app that anyone was hidden.
// ---------------------------------------------------------------------------

test("UI smoke: people at the same address share one pin, labelled with the count", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const placed = window.__test__.state.applicants.filter((a) => !a.hasDataIssues && a.geocodedReal && a.coords);
  const spots  = window.__test__.groupApplicantsByLocation(placed);
  const shared = spots.filter((s) => s.people.length > 1);

  // The stub's clearLayers is a no-op, so start clean and draw once.
  Object.assign(window.__leaflet__, newLeafletRecord());
  window.__test__.renderMap();

  assert.ok(shared.length > 0, "the sample must contain people sharing an address");
  // Every person is on exactly one pin, and there are fewer pins than people.
  assert.equal(spots.reduce((n, s) => n + s.people.length, 0), placed.length);
  assert.ok(spots.length < placed.length, "shared addresses must collapse into fewer pins");

  const counts = window.__leaflet__.tooltips.map((t) => Number(t.text));
  assert.ok(counts.length > 0, "expected a count label on at least one shared pin");
  // Joined, because arrays built inside the jsdom realm are not
  // reference-equal to arrays built here even when their contents match.
  assert.equal(
    counts.slice().sort((a, b) => a - b).join(","),
    shared.map((s) => s.people.length).sort((a, b) => a - b).join(",")
  );
  const sharedMarker = window.__leaflet__.markers.find((m) => m.tooltip);
  assert.match(sharedMarker.popupHtml, /people at this address/);
});

test("UI smoke: the map frames itself around the pins rather than a fixed city", async () => {
  const window = buildWindow();
  await window.__test__.init();

  // The opening view was hardcoded to Helsinki, which left Tampere off-screen.
  assert.equal(window.__leaflet__.fitBounds.length, 1, "expected the view to be fitted to the pins once");
  const framed = window.__leaflet__.bounds[0];
  assert.ok(framed.length > 1);

  const lats = framed.map((c) => c[0]);
  assert.ok(Math.max(...lats) - Math.min(...lats) > 1, "the sample must span well beyond one city");
});

test("UI smoke: clicking a person in a list rings them on the map", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const target = window.__test__.state.applicants.find((a) => !a.hasDataIssues && a.geocodedReal && a.coords);
  const before = window.__leaflet__.openedPopups.length;

  assert.equal(window.__test__.focusApplicantOnMap(target.id), true);
  assert.equal(window.__leaflet__.openedPopups.length, before + 1, "the person's popup should open");

  const ring = window.__leaflet__.markers.filter((m) => m.opts && m.opts.fill === false).pop();
  assert.ok(ring, "expected a highlight ring");
  assert.equal(ring.coords.lat ?? ring.coords[0], target.coords[0]);
  assert.equal(ring.coords.lng ?? ring.coords[1], target.coords[1]);

  const lastView = window.__leaflet__.setViews.pop();
  assert.ok(lastView, "expected the map to move to the person");
  assert.ok(lastView[1] >= 12, "focusing must not zoom further out than the current view");
});

test("UI smoke: an un-geocoded person gets no map affordance and no crash", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const stranded = window.__test__.state.applicants.find((a) => !a.geocodedReal);
  assert.ok(stranded, "the sample must contain someone who cannot be placed");
  assert.equal(window.__test__.focusApplicantOnMap(stranded.id), false);
  assert.equal(window.__test__.focusApplicantOnMap("no-such-id"), false);
});

test("UI smoke: a located row is marked selected so the list and map agree", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const unmatched = window.document.getElementById("unmatchedList");
  const card = unmatched.querySelector(".applicant-card.locatable");
  assert.ok(card, "expected a locatable applicant row under the map");
  assert.ok(card.querySelector(".locate-btn"), "expected a show-on-map control");

  card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(card.classList.contains("selected"), "the clicked row should be marked selected");

  const other = [...unmatched.querySelectorAll(".applicant-card.locatable")][1];
  if (other) {
    other.querySelector(".id-toggle").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(other.querySelector(".applicant-details").hidden, false);
  }
});

test("UI smoke: the highlight survives a re-render", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const target = window.__test__.state.applicants.find((a) => !a.hasDataIssues && a.geocodedReal && a.coords);
  window.__test__.focusApplicantOnMap(target.id);

  // A re-render clears every layer, so the ring has to come back.
  Object.assign(window.__leaflet__, newLeafletRecord());
  window.__test__.renderMap();

  const ring = window.__leaflet__.markers.find((m) => m.opts && m.opts.fill === false);
  assert.ok(ring, "the ring should be redrawn after a re-render");
  assert.equal(ring.coords.lat ?? ring.coords[0], target.coords[0]);
  assert.equal(window.__leaflet__.setViews.length, 0);
});

test("UI smoke: expecting mothers are matched and marked as expecting", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const expecting = window.__test__.state.applicants.filter((a) => a.expecting);
  assert.ok(expecting.length > 0, "the sample must contain mothers who have not given birth yet");
  assert.ok(expecting.some((a) => a.eligibleForMatching), "expecting mothers must be eligible for matching");

  const withCard = expecting.find((a) => !a.hasDataIssues && a.geocodedReal && a.matchStatus === "unmatched");
  if (withCard) {
    const row = window.document.querySelector(`#unmatchedList .applicant-card[data-applicant-id="${withCard.id}"]`);
    if (row) {
      assert.match(row.innerHTML, /badge-expecting/);
      assert.match(row.innerHTML, /Due/);
    }
  }
});

test("UI smoke: the browser scripts declare no colliding globals", () => {
  // Classic script tags share one global lexical scope, so a duplicate
  // top-level name is a SyntaxError that stops the whole file executing and
  // surfaces somewhere else entirely. That happened with `haversineKm`.
  const declarations = (file) => {
    const names = new Set();
    fs.readFileSync(path.join(__dirname, "..", file), "utf8").split("\n").forEach((line) => {
      let m = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
      if (m) names.add(m[1]);
      m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) names.add(m[1]);
        m = line.match(/^const\s*\{\s*([^}]+)\}/);
      if (m) m[1].split(",").forEach((n) => names.add(n.trim().split(":")[0]));
    });
    return names;
  };

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const files = [...html.matchAll(/<script src="(src\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(files.length >= 3, `expected the app's own scripts, found ${files.join(", ")}`);

  const sets = files.map((f) => [f, declarations(f)]);
  const collisions = [];
  sets.forEach(([fileA, a], i) => sets.slice(i + 1).forEach(([fileB, b]) => {
    [...a].filter((n) => b.has(n)).forEach((n) => collisions.push(`${n} in both ${fileA} and ${fileB}`));
  }));
  assert.deepEqual(collisions, []);
});

// ---------------------------------------------------------------------------
// Meeting points. Everyone in the pool is on the map, so showing where one
// group should meet has to pick that group out and zoom to it.
// ---------------------------------------------------------------------------

async function showFirstGroup(window) {
  const groups = await window.__test__.computeCandidateGroups();
  assert.ok(groups.length, 'the sample must produce at least one candidate group');
  // The app assigns this in the Run matching handler.
  window.__test__.state.candidateGroups = groups;
  // The suggestions are shown inside a card, so the cards must exist.
  window.__test__.renderCandidateCards();
  Object.assign(window.__leaflet__, newLeafletRecord());
  await window.__test__.showMeetingPlaces(groups[0].candidateId);
  return groups[0];
}

test("UI smoke: suggesting a meeting place draws options and journey lines", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);

  const members = group.memberIds.map(window.__test__.getApplicant);
  const status = window.document.getElementById('meetingStatus').textContent;
  assert.ok(window.__leaflet__.divIcons.length > 0,
    `expected at least one suggested place; status was ${JSON.stringify(status)}`);
  assert.ok(window.__leaflet__.divIcons.some((i) => /meeting-marker-best/.test(i.className)),
    'the best option must be marked as such');

  // Each line is drawn twice, a casing under a coloured line, so count the
  // coloured ones.
  const coloured = window.__leaflet__.polylines.filter((l) => l.opts.color !== '#FFFFFF');
  const casings  = window.__leaflet__.polylines.filter((l) => l.opts.color === '#FFFFFF');
  const expected = members.length * window.__leaflet__.divIcons.length;
  assert.equal(coloured.length, expected, 'one coloured line per member per option');
  assert.equal(casings.length, expected, 'and a casing under each of them');
  casings.forEach((c) => assert.ok(c.opts.weight > 3, 'a casing must be wider than the line it backs'));

  assert.match(window.document.getElementById('meetingStatus').textContent, /Best of|No shared meeting place/);
});

test("UI smoke: the members of the group being shown are ringed", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  const members = group.memberIds.map(window.__test__.getApplicant).filter((m) => m.coords);

  const rings = window.__leaflet__.markers.filter(
    (m) => m.opts && m.opts.fill === false && m.opts.dashArray
  );
  assert.equal(rings.length, members.length, 'one ring per member of the shown group');

  // Joined, because arrays produced inside the jsdom realm are not
  // reference-equal to arrays built here even when their contents match.
  const ringKeys = rings.map((r) => `${r.coords[0]},${r.coords[1]}`).sort().join(' ');
  const memberKeys = members.map((m) => `${m.coords[0]},${m.coords[1]}`).sort().join(' ');
  assert.equal(ringKeys, memberKeys);
});

test("UI smoke: the map zooms to the group, not the whole country", async () => {
  const window = buildWindow();
  await window.__test__.init();

  // Captured before showFirstGroup resets the record.
  const poolBounds = window.__leaflet__.bounds[0];
  const poolSpan = Math.max(...poolBounds.map((c) => c[0])) - Math.min(...poolBounds.map((c) => c[0]));

  const group = await showFirstGroup(window);
  const members = group.memberIds.map(window.__test__.getApplicant).filter((m) => m.coords);

  assert.equal(window.__leaflet__.fitBounds.length, 1, 'showing a group must reframe the map once');

  const framed = window.__leaflet__.bounds[window.__leaflet__.bounds.length - 1];
  const lats = framed.map((c) => c[0]);
  const lons = framed.map((c) => c[1]);
  members.forEach((m) => {
    assert.ok(m.coords[0] >= Math.min(...lats) && m.coords[0] <= Math.max(...lats),
      `${m.id} is outside the framed latitudes`);
    assert.ok(m.coords[1] >= Math.min(...lons) && m.coords[1] <= Math.max(...lons),
      `${m.id} is outside the framed longitudes`);
  });

  // The sample spans the country; one group does not.
  assert.ok(Math.max(...lats) - Math.min(...lats) < poolSpan,
    'a group must frame tighter than the whole pool');
});

test("UI smoke: toggling the suggestions off clears the rings and the status", async () => {
  const window = buildWindow();
  await window.__test__.init();
  await showFirstGroup(window);
  assert.notEqual(window.document.getElementById('meetingStatus').textContent, '');

  await window.__test__.showMeetingPlaces(null);
  assert.equal(window.document.getElementById('meetingStatus').textContent, '',
    'a stale status line would describe markers that are gone');
});

test("UI smoke: suggestions also appear on the candidate card, collapsed", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);

  const host = window.document.querySelector(`.meeting-list[data-meeting-for="${group.candidateId}"]`);
  assert.ok(host, 'the candidate card needs somewhere to show the suggestions');
  assert.equal(host.hidden, false, 'the list must be revealed after asking');

  const options = host.querySelectorAll('.meeting-option');
  assert.ok(options.length > 0, 'expected at least one suggestion on the card');
  assert.equal(options.length, window.__leaflet__.divIcons.length, 'card and map must agree');

  // Readable without opening, because this is what decides which she picks.
  const first = options[0];
  assert.ok(first.querySelector('.meeting-name').textContent.trim().length > 0);
  assert.match(first.querySelector('.meeting-worst').textContent, /\d+ min/);
  assert.ok(first.classList.contains('meeting-option-best'), 'the best option should be marked');

  const legs = first.querySelector('.meeting-legs');
  assert.equal(legs.hidden, true, 'legs start collapsed');
  first.querySelector('.meeting-option-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(legs.hidden, false);
  assert.equal(
    legs.querySelectorAll('.meeting-leg').length,
    group.memberIds.map(window.__test__.getApplicant).filter((m) => m.coords && m.transport.length).length,
    'one journey per member'
  );
});

test("UI smoke: hiding the suggestions clears them from the card", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  const host = window.document.querySelector(`.meeting-list[data-meeting-for="${group.candidateId}"]`);
  assert.equal(host.hidden, false);

  await window.__test__.showMeetingPlaces(null);
  assert.equal(host.hidden, true, 'a stale list would describe markers that are gone');
  assert.equal(host.innerHTML, '');
});

test("UI smoke: the open suggestions survive a re-render of the cards", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  window.__test__.state.meetingPlacesFor = group.candidateId;

  // Approving or rejecting anything re-renders the card list. The suggestions
  // are already cached, so they should come back rather than vanish.
  window.__test__.renderCandidateCards();
  const host = window.document.querySelector(`.meeting-list[data-meeting-for="${group.candidateId}"]`);
  assert.equal(host.hidden, false, 'the list should be restored after a re-render');
  assert.ok(host.querySelectorAll('.meeting-option').length > 0);
});

test("UI smoke: stripping comments for delivery does not change what renders", async () => {
  // server.js verifies the stripped result parses, but parsing is not enough:
  // a line inside one of app.js's HTML templates is content, and removing it
  // would change the markup while still parsing. This compares what renders.
  const { stripComments } = require("../server.js");

  const asWritten = buildWindow();
  await asWritten.__test__.init();
  const asDelivered = buildWindow(stripComments);
  await asDelivered.__test__.init();

  ["unmatchedList", "dataIssuesList", "activeGroups", "candidateCards"].forEach((id) => {
    assert.equal(
      asDelivered.document.getElementById(id).innerHTML,
      asWritten.document.getElementById(id).innerHTML,
      `${id} renders differently once comments are stripped`
    );
  });

  assert.equal(asDelivered.__test__.state.applicants.length, asWritten.__test__.state.applicants.length);
  assert.equal(
    asDelivered.__test__.state.applicants.filter((a) => a.geocodedReal).length,
    asWritten.__test__.state.applicants.filter((a) => a.geocodedReal).length
  );
});

test("stripComments: removes comment lines and nothing else", () => {
  const { stripComments } = require("../server.js");

  // A `//` inside a string or regex is not a comment and must survive.
  const src = [
    "// a comment",
    "const url = 'https://example.com';",
    "  // indented comment",
    "const re = /\\/\\//;",
    "/* block start",
    " * continued",
    " */",
    "",
    "const x = 1; // trailing comment stays, the line is code",
  ].join("\n");

  assert.equal(stripComments(src), [
    "const url = 'https://example.com';",
    "const re = /\\/\\//;",
    "",
    "const x = 1; // trailing comment stays, the line is code",
  ].join("\n"));

  // Blank lines are kept: inside a template literal they are content.
  assert.match(stripComments("a\n\nb"), /a\n\nb/);
});

// ---------------------------------------------------------------------------
// The meeting-place cache. A lookup costs an Overpass query plus a routing
// query per member per place, so it is cached in the sheet, kept when a group
// is approved and dropped when one is rejected.
// ---------------------------------------------------------------------------

// Cache writes are fire-and-forget like the other sheet writes, so poll.
async function waitForCache(window, expectedCount, describe, extra) {
  const deadline = Date.now() + 4000;
  let last = {};
  while (Date.now() < deadline) {
    last = await readCache(window);
    const countOk = Object.keys(last).length === expectedCount;
    if (countOk && (!extra || extra(last))) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${describe} did not reach the sheet within 4s (got ${JSON.stringify(last)})`);
  return last;
}

async function readCache(window) {
  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "getMeetingPlaces" }),
  });
  return (await resp.json()).result;
}

test("UI smoke: a lookup is written to the sheet cache", async () => {
  const window = buildWindow();
  await window.__test__.init();
  assert.deepEqual(await readCache(window), {}, "nothing cached before the first lookup");

  const group = await showFirstGroup(window);
  const cached = await waitForCache(window, 1, "the lookup");

  const [key] = Object.keys(cached);
  const entry = cached[key];
  assert.equal(entry.groupId, null, "a candidate's entry is not claimed yet");
  assert.ok(Array.isArray(entry.places) && entry.places.length > 0);
  // Keyed on the members, not the candidate id, which every matching run
  // regenerates.
  group.memberIds.forEach((id) => assert.match(key, new RegExp(id)));
});

test("UI smoke: a second look at the same group does not repeat the lookup", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  await waitForCache(window, 1, "the first lookup");

  // A fresh page, so the in-memory cache is empty and only the sheet can help.
  const reloaded = buildWindow();
  await reloaded.__test__.init();
  const groups = await reloaded.__test__.computeCandidateGroups();
  reloaded.__test__.state.candidateGroups = groups;
  reloaded.__test__.renderCandidateCards();

  const before = await readCache(reloaded);
  await reloaded.__test__.showMeetingPlaces(groups[0].candidateId);

  const host = reloaded.document.querySelector(`.meeting-list[data-meeting-for="${groups[0].candidateId}"]`);
  assert.ok(host.querySelectorAll(".meeting-option").length > 0, "served from the sheet");
  assert.deepEqual(await readCache(reloaded), before, "and nothing was re-cached");
});

test("UI smoke: approving a group keeps its meeting places, tagged with the group", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  const [key] = Object.keys(await waitForCache(window, 1, "the lookup"));

  await window.__test__.approveGroup(group.candidateId);
  const groupId = window.__test__.state.groups[0].id;

  const cached = await waitForCache(window, 1, "the claim", (c) => c[key]?.groupId === groupId);
  assert.equal(cached[key].groupId, groupId, "kept, and now belongs to the group");
  assert.ok(cached[key].places.length > 0);
});

test("UI smoke: rejecting a group removes its meeting places", async () => {
  const window = buildWindow();
  await window.__test__.init();
  const group = await showFirstGroup(window);
  await waitForCache(window, 1, "the lookup");

  window.__test__.rejectGroup(group.candidateId);
  const cached = await waitForCache(window, 0, "the deletion");
  assert.deepEqual(cached, {}, "a group that will not happen leaves nothing behind");
});
