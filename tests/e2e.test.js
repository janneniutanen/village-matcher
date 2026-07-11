// End-to-end tests for the local CSV test server (local-test-server.js).
// Verifies the full HTTP contract the front end speaks:
// - the sheet-shaped CSV loads and validates correctly
// - every action the front end calls behaves correctly
// - a full realistic user flow (load -> approve -> contact -> confirm ->
//   introduce) round-trips correctly through the backend
//
// Run with: node --test tests/e2e.test.js
// No dependencies — spins up local-test-server.js as a real HTTP server on
// an ephemeral port and talks to it with Node's built-in fetch.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("node:child_process");

const SERVER_PATH = path.join(__dirname, "..", "local-test-server.js");
const CSV_PATH = path.join(__dirname, "..", "mock-applicants.csv");
const PORT = 8792; // distinct from the manual-testing default (8791)
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess;

test.before(async () => {
  serverProcess = spawn("node", [SERVER_PATH, CSV_PATH, String(PORT)], { stdio: "pipe" });
  // Wait for the "running at" line rather than a fixed sleep, so this isn't flaky.
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
    serverProcess.stderr.on("data", (chunk) => (out += chunk.toString()));
  });
});

test.after(() => {
  serverProcess.kill();
});

async function call(action, payload = {}) {
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...payload }),
  });
  return resp.json();
}

test("ping: server responds and identifies itself", async () => {
  const { ok, result } = await call("ping");
  assert.equal(ok, true);
  assert.ok(result.time);
});

test("unknown action: returns ok:false with a message, doesn't crash the server", async () => {
  const { ok, error } = await call("doTheThing");
  assert.equal(ok, false);
  assert.match(error, /Unknown action/);
});

test("getApplicants: loads the CSV, matches expected count and validation split", async () => {
  const { ok, result } = await call("getApplicants");
  assert.equal(ok, true);
  assert.equal(result.length, 18);
  const flagged = result.filter((a) => a.hasDataIssues);
  const eligible = result.filter((a) => a.eligibleForMatching);
  assert.equal(flagged.length, 3);
  assert.equal(eligible.length, 15);
});

test("getApplicants: corrupted rows carry human-readable reasons", async () => {
  const { result } = await call("getApplicants");
  const outi = result.find((a) => a.name === "Outi");
  assert.ok(outi.dataIssues.some((e) => e.includes("skateboard")));
  const riikka = result.find((a) => a.name === "Riikka");
  assert.ok(riikka.dataIssues.some((e) => e.toLowerCase().includes("neighborhood")));
});

test("getApplicants: valid rows have real coordin -independent fields parsed correctly", async () => {
  const { result } = await call("getApplicants");
  const lisa = result.find((a) => a.name === "Lisa");
  assert.deepEqual(lisa.transport.sort(), ["bus", "car", "walk"]);
  assert.deepEqual(lisa.language, ["Russian", "English"]);
  assert.equal(lisa.phone, "+358401234501");
  assert.equal(lisa.maxTravel, 15);
});

test("full flow: approve a group, advance every stage, verify persisted state throughout", async () => {
  const { result: applicants } = await call("getApplicants");
  const eligible = applicants.filter((a) => a.eligibleForMatching);
  const trio = eligible.slice(0, 3);

  // 1. Create a group (mirrors what approveGroup() does in app.js)
  const { result: created } = await call("createGroup", {
    group: { name: "Test Group", memberIds: trio.map((a) => a.id), status: "open" },
  });
  assert.ok(created.id);

  for (const a of trio) {
    await call("updateApplicant", { id: a.id, fields: { matchStatus: "match_found", matchGroupId: created.id } });
  }

  // 2. Verify it actually persisted (fresh read, not just the write response)
  let { result: afterMatch } = await call("getApplicants");
  trio.forEach((original) => {
    const now = afterMatch.find((a) => a.id === original.id);
    assert.equal(now.matchStatus, "match_found");
    assert.equal(now.matchGroupId, created.id);
  });

  // 3. Advance everyone to contacted -> confirmed -> introduced
  for (const status of ["contacted", "confirmed", "introduced"]) {
    for (const a of trio) {
      await call("updateApplicant", { id: a.id, fields: { matchStatus: status } });
    }
  }
  const { result: afterAll } = await call("getApplicants");
  trio.forEach((original) => {
    assert.equal(afterAll.find((a) => a.id === original.id).matchStatus, "introduced");
  });

  // 4. Group itself is independently readable and updatable
  await call("updateGroup", { id: created.id, fields: { status: "established" } });
  const { result: groups } = await call("getGroups");
  const group = groups.find((g) => g.id === created.id);
  assert.equal(group.status, "established");
  assert.deepEqual(group.memberIds.sort(), trio.map((a) => a.id).sort());
});

test("updateApplicant: unknown id fails clearly instead of silently no-op'ing", async () => {
  const { ok, error } = await call("updateApplicant", { id: "NOT-A-REAL-ID", fields: { matchStatus: "contacted" } });
  assert.equal(ok, false);
  assert.match(error, /not found/);
});

test("updateGroup: unknown id fails clearly", async () => {
  const { ok, error } = await call("updateGroup", { id: "G-999", fields: { status: "established" } });
  assert.equal(ok, false);
  assert.match(error, /not found/);
});

test("templates: round-trip save and read", async () => {
  await call("saveTemplates", {
    templates: { firstContact: "Hi {{name}}!", confirmationAsk: "Confirm?", introduction: "Meet up!" },
  });
  const { result } = await call("getTemplates");
  assert.equal(result.firstContact, "Hi {{name}}!");
  assert.equal(result.confirmationAsk, "Confirm?");
  assert.equal(result.introduction, "Meet up!");
});

test("settings: round-trip save and read, including group size", async () => {
  await call("saveSettings", { settings: { maxAgeGap: 8, minGroupSize: 3, maxGroupSize: 6 } });
  const { result } = await call("getSettings");
  assert.equal(result.maxAgeGap, 8);
  assert.equal(result.maxGroupSize, 6);
});

test("geocode / travelTime / isochrone stubs respond in the shape the front end expects", async () => {
  const geo = await call("geocode", { addresses: ["Vaasankatu 5, Kallio, Finland"] });
  assert.equal(geo.ok, true);
  assert.equal(typeof geo.result[0].lat, "number");

  const travel = await call("travelTime", { pairs: [{ id: "p1", from: { lat: 60.18, lon: 24.95 }, to: { lat: 60.2, lon: 24.9 }, mode: "car" }] });
  assert.equal(travel.ok, true);
  assert.equal(typeof travel.result[0].minutes, "number");

  const iso = await call("isochrone", { locations: [{ lat: 60.18, lon: 24.95 }], mode: "car", minutes: 15 });
  assert.equal(iso.ok, true);
});
