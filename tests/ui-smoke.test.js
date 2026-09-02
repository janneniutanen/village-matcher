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

// Records what the app asked Leaflet to draw, so the map behaviour that can't
// be seen in the DOM (how many pins, which ones share a spot, whether the
// view was framed) is still assertable without a browser.
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
    latLngBounds: (coords) => { record.bounds.push(coords); return { coords }; },
  };
}

function newLeafletRecord() {
  return { markers: [], tooltips: [], setViews: [], fitBounds: [], bounds: [], openedPopups: [] };
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
  // Forward the page's console to the test output. jsdom discards it by
  // default, which hides the console.warn that app.js emits when a backend
  // call fails — so a broken fetch looked like an empty result set.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn",  (msg) => console.error("  [page warn]", msg));
  virtualConsole.on("error", (msg) => console.error("  [page error]", msg));
  virtualConsole.on("jsdomError", (err) => console.error("  [jsdom error]", err.message));
  const dom = new JSDOM(htmlWithoutScripts, { url: `http://localhost/?backend=${BASE_URL}`, runScripts: "dangerously", virtualConsole });
  const { window } = dom;

  const leafletRecord = newLeafletRecord();
  window.__leaflet__ = leafletRecord;
  window.L = fakeLeaflet(leafletRecord);
  window.fetch = fetch; // Node's built-in global fetch, shared across realms
  window.alert = () => {};
  window.navigator.clipboard = { writeText: async () => {} };
  window.localStorage.setItem("matcherPassword", "test");

  const files = ["src/matching-engine.js", "src/validation.js", "src/app.js"];
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
    renderMap, groupApplicantsByLocation, focusApplicantOnMap, selectApplicantOnMap,
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
  const resp = await fetch(BASE_URL, {
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

  // The Leaflet stub's clearLayers is a no-op, so the record holds every
  // render init did. Start clean and draw once.
  Object.assign(window.__leaflet__, { markers: [], tooltips: [], setViews: [], fitBounds: [], bounds: [], openedPopups: [] });
  window.__test__.renderMap();

  assert.ok(shared.length > 0, "the sample must contain people sharing an address");
  // Every person is on exactly one pin, and there are fewer pins than people.
  assert.equal(spots.reduce((n, s) => n + s.people.length, 0), placed.length);
  assert.ok(spots.length < placed.length, "shared addresses must collapse into fewer pins");

  // The count is what makes a hidden person discoverable.
  const counts = window.__leaflet__.tooltips.map((t) => Number(t.text));
  assert.ok(counts.length > 0, "expected a count label on at least one shared pin");
  // Joined, because arrays built inside the jsdom realm are not
  // reference-equal to arrays built here even when their contents match.
  assert.equal(
    counts.slice().sort((a, b) => a - b).join(","),
    shared.map((s) => s.people.length).sort((a, b) => a - b).join(",")
  );
  // And the popup names everyone standing on that pin, not just the first.
  const sharedMarker = window.__leaflet__.markers.find((m) => m.tooltip);
  assert.match(sharedMarker.popupHtml, /people at this address/);
});

test("UI smoke: the map frames itself around the pins rather than a fixed city", async () => {
  const window = buildWindow();
  await window.__test__.init();

  // The opening view was hardcoded to Helsinki at zoom 12, which left a
  // Tampere dataset entirely off-screen.
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

  // A highlight ring, drawn unfilled so the dot underneath stays visible.
  const ring = window.__leaflet__.markers.filter((m) => m.opts && m.opts.fill === false).pop();
  assert.ok(ring, "expected a highlight ring");
  assert.equal(ring.coords.lat ?? ring.coords[0], target.coords[0]);
  assert.equal(ring.coords.lng ?? ring.coords[1], target.coords[1]);

  // And it brings the person into view without zooming back out.
  const lastView = window.__leaflet__.setViews.pop();
  assert.ok(lastView, "expected the map to move to the person");
  assert.ok(lastView[1] >= 12, "focusing must not zoom further out than the current view");
});

test("UI smoke: an un-geocoded person gets no map affordance and no crash", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const stranded = window.__test__.state.applicants.find((a) => !a.geocodedReal);
  assert.ok(stranded, "the sample must contain someone who cannot be placed");
  // Returns false rather than throwing, so a click on a flagged row is inert.
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

  // Expanding details must still work and must not steal the click.
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

  // Approving a group or running matching re-renders the map, which clears
  // every layer. The ring has to come back, or it disappears the moment
  // anything else on the page changes.
  Object.assign(window.__leaflet__, { markers: [], tooltips: [], setViews: [], fitBounds: [], bounds: [], openedPopups: [] });
  window.__test__.renderMap();

  const ring = window.__leaflet__.markers.find((m) => m.opts && m.opts.fill === false);
  assert.ok(ring, "the ring should be redrawn after a re-render");
  assert.equal(ring.coords.lat ?? ring.coords[0], target.coords[0]);
  // Re-rendering must not move the view; the organizer may have panned away.
  assert.equal(window.__leaflet__.setViews.length, 0);
});

test("UI smoke: expecting mothers are matched and marked as expecting", async () => {
  const window = buildWindow();
  await window.__test__.init();

  const expecting = window.__test__.state.applicants.filter((a) => a.expecting);
  assert.ok(expecting.length > 0, "the sample must contain mothers who have not given birth yet");
  // They are ordinary applicants, not a flagged special case; joining before
  // the birth is the point.
  assert.ok(expecting.some((a) => a.eligibleForMatching), "expecting mothers must be eligible for matching");

  // Their date reads as a due date rather than a birthday wherever it shows.
  const withCard = expecting.find((a) => !a.hasDataIssues && a.geocodedReal && a.matchStatus === "unmatched");
  if (withCard) {
    const row = window.document.querySelector(`#unmatchedList .applicant-card[data-applicant-id="${withCard.id}"]`);
    if (row) {
      assert.match(row.innerHTML, /badge-expecting/);
      assert.match(row.innerHTML, /Due/);
    }
  }
});
