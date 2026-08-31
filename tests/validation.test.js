// Run with: node --test tests/validation.test.js
// No dependencies — uses Node's built-in test runner and assert module.

const test = require("node:test");
const assert = require("node:assert/strict");
const Validation = require("../src/validation.js");

test("normalizePhone: leading 0 becomes +358", () => {
  assert.equal(Validation.normalizePhone("0401234567"), "+358401234567");
});

test("normalizePhone: already-international number is left alone", () => {
  assert.equal(Validation.normalizePhone("+44 7911 123456"), "+447911123456");
});

test("normalizePhone: 00-prefixed international is converted to +", () => {
  assert.equal(Validation.normalizePhone("00358401234567"), "+358401234567");
});

test("normalizePhone: phone number missing + has + added on is converted to +", () => {
  assert.equal(Validation.normalizePhone("44401234567"), "+44401234567");
});


test("normalizePhone: garbage input returns something, not a crash", () => {
  assert.doesNotThrow(() => Validation.normalizePhone("abc"));
  assert.equal(Validation.normalizePhone(""), null);
  assert.equal(Validation.normalizePhone(null), null);
});

test("isPlausiblePhone: rejects too-short numbers", () => {
  assert.equal(Validation.isPlausiblePhone("+358123"), false);
});

test("isPlausiblePhone: accepts a normal Finnish mobile number", () => {
  assert.equal(Validation.isPlausiblePhone("+358401234567"), true);
});

test("parseTransport: recognizes known modes case-insensitively", () => {
  const { modes, unknown } = Validation.parseTransport("Bus, Walking, CAR");
  assert.deepEqual(modes.sort(), ["D", "P", "W"]);
  assert.equal(unknown.length, 0);
});

test("parseTransport: flags unrecognized values instead of silently dropping them", () => {
  const { modes, unknown } = Validation.parseTransport("skateboard");
  assert.deepEqual(modes, []);
  assert.deepEqual(unknown, ["skateboard"]);
});

test("parseTransport: empty/missing input returns empty modes, no crash", () => {
  assert.deepEqual(Validation.parseTransport("").modes, []);
  assert.deepEqual(Validation.parseTransport(null).modes, []);
});

test("parseDob: accepts ISO date string", () => {
  const d = Validation.parseDob("2025-07-10");
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 6); // 0-indexed July
});

test("parseDob: accepts DD.MM.YYYY format", () => {
  const d = Validation.parseDob("10.07.2025");
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 6);
  assert.equal(d.getDate(), 10);
});

test("parseDob: rejects an invalid calendar date (32.13.2025)", () => {
  assert.equal(Validation.parseDob("32.13.2025"), null);
});

test("parseDob: rejects a wildly wrong year (fat-finger typo)", () => {
  assert.equal(Validation.parseDob("2205-07-10"), null);
});

test("parseDob: rejects empty/missing input", () => {
  assert.equal(Validation.parseDob(""), null);
  assert.equal(Validation.parseDob(null), null);
});

test("parseMaxTravel: accepts a plain positive number", () => {
  assert.equal(Validation.parseMaxTravel(15), 15);
  assert.equal(Validation.parseMaxTravel("15"), 15);
});

test("parseMaxTravel: rejects non-numeric, zero, negative, and absurd values", () => {
  assert.equal(Validation.parseMaxTravel("many"), null);
  assert.equal(Validation.parseMaxTravel(0), null);
  assert.equal(Validation.parseMaxTravel(-5), null);
  assert.equal(Validation.parseMaxTravel(999), null);
});

test("parseMaxTravel: minute answers in free text", () => {
  assert.equal(Validation.parseMaxTravel("about 20 min"), 20);
  assert.equal(Validation.parseMaxTravel("30 minutes"), 30);
  assert.equal(Validation.parseMaxTravel("45 min"), 45);
  assert.equal(Validation.parseMaxTravel("90 minutes"), 90);
});

test("parseMaxTravel: hour answers are converted to minutes", () => {
  assert.equal(Validation.parseMaxTravel("2 hours"), 120);
  assert.equal(Validation.parseMaxTravel("1 hour"), 60);
  assert.equal(Validation.parseMaxTravel("3 hours"), 180);
});

test("parseMaxTravel: the cap is applied after the hour conversion, not before", () => {
  // Regression: the range check used to run on the pre-conversion number, so
  // anything containing "hour" could exceed the cap once multiplied by 60.
  assert.equal(Validation.parseMaxTravel("4 hours"), null);
  assert.equal(Validation.parseMaxTravel("5 hours"), null);
  assert.equal(Validation.parseMaxTravel("24 hours"), null);
});

test("parseMaxTravel: combined hour and minute answers", () => {
  // Regression: stripping every non-digit turned "1 hour 30" into 130, then
  // multiplied it by 60 for 7800 minutes.
  assert.equal(Validation.parseMaxTravel("1 hour 30"), 90);
  assert.equal(Validation.parseMaxTravel("1 hour 30 min"), 90);
  assert.equal(Validation.parseMaxTravel("1h30"), 90);
});

test("parseMaxTravel: accepts both decimal separators", () => {
  // Regression: stripping non-digits turned "1,5 hours" into 15, then 900.
  assert.equal(Validation.parseMaxTravel("1,5 hours"), 90);
  assert.equal(Validation.parseMaxTravel("1.5 hours"), 90);
  assert.equal(Validation.parseMaxTravel("2,5 hours"), 150);
  assert.equal(Validation.parseMaxTravel("1,5 h"), 90);
});

test("parseMaxTravel: \"Doesn't matter\" maps to the cap", () => {
  assert.equal(Validation.parseMaxTravel("Doesn't matter"), Validation.MAX_TRAVEL_MINUTES);
  assert.equal(Validation.parseMaxTravel("Doesn't matter"), 180);
});

test("parseMaxTravel: returns whole minutes", () => {
  assert.equal(Validation.parseMaxTravel("1,25 hours"), 75);
  assert.equal(Validation.parseMaxTravel("0,7 hours"), 42);
  // Never a fraction, so downstream arithmetic stays in integers.
  assert.equal(Number.isInteger(Validation.parseMaxTravel("1,33 hours")), true);
});

test("parseMaxTravel: unparseable and out-of-range values stay rejected", () => {
  assert.equal(Validation.parseMaxTravel("half an hour"), null);
  assert.equal(Validation.parseMaxTravel("0 hours"), null);
  assert.equal(Validation.parseMaxTravel(""), null);
  assert.equal(Validation.parseMaxTravel(null), null);
  assert.equal(Validation.parseMaxTravel(undefined), null);
  assert.doesNotThrow(() => Validation.parseMaxTravel({}));
});

test("normalizeApplicant: a fully valid row is eligible with no issues", () => {
  const raw = {
    id: "A001", name: "Lisa", neighborhood: "Kallio", street: "Vaasankatu 5",
    transport: ["bus", "car", "walk"], maxTravel: 15, language: ["Russian", "English"],
    phone: "0401234501", dob: "2025-07-10",
  };
  const result = Validation.normalizeApplicant(raw);
  assert.equal(result.eligibleForMatching, true);
  assert.equal(result.hasDataIssues, false);
  assert.deepEqual(result.dataIssues, []);
});

test("normalizeApplicant: unrecognized transport mode is flagged, not silently dropped", () => {
  const raw = {
    id: "A016", name: "Outi", neighborhood: "Kallio", street: "Fleminginkatu 9",
    transport: ["skateboard"], maxTravel: 15, language: ["Finnish"],
    phone: "0401234516", dob: "2025-07-01",
  };
  const result = Validation.normalizeApplicant(raw);
  assert.equal(result.eligibleForMatching, false);
  assert.ok(result.dataIssues.some((e) => e.includes("Unrecognized transport")));
});

test("normalizeApplicant: multiple corrupted fields are all reported, and it never throws", () => {
  const raw = {
    id: "", name: "Tuula", neighborhood: "Töölö", street: "Museokatu 2",
    transport: ["car"], maxTravel: "many", language: ["Finnish"],
    phone: "123", dob: "32.13.2025",
  };
  const result = Validation.normalizeApplicant(raw);
  assert.equal(result.eligibleForMatching, false);
  assert.ok(result.dataIssues.length >= 3, "expected multiple flagged issues");
  assert.ok(result.dataIssues.some((e) => e.includes("many")), "expected max travel issue to include invalid value");
  assert.ok(result.dataIssues.some((e) => e.includes("32.13.2025")), "expected DOB issue to include invalid value");
  assert.ok(result.dataIssues.some((e) => e.includes("123")), "expected phone issue to include invalid value");
  assert.ok(result.id, "a fallback id should still be generated so the row doesn't collide with others");
});

test("normalizeApplicant: missing neighborhood/street/language/dob is fully flagged", () => {
  const raw = {
    id: "A018", name: "Riikka", neighborhood: "", street: "",
    transport: ["bus", "walk"], maxTravel: 12, language: [],
    phone: "0401234518", dob: "",
  };
  const result = Validation.normalizeApplicant(raw);
  assert.equal(result.eligibleForMatching, false);
  ["neighborhood", "street", "language", "date of birth"].forEach((field) => {
    assert.ok(
      result.dataIssues.some((e) => e.toLowerCase().includes(field)),
      `expected an issue mentioning "${field}"`
    );
  });
});

test("normalizeApplicant: never throws even on a completely empty row", () => {
  assert.doesNotThrow(() => Validation.normalizeApplicant({}));
  const result = Validation.normalizeApplicant({});
  assert.equal(result.eligibleForMatching, false);
});
