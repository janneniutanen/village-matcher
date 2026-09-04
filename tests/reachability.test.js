// Run with: node --test tests/reachability.test.js
// Pure functions, no network. The live-API behaviour these support is
// documented at the top of src/reachability.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/reachability.js");

const members = [
  { id: "A", coords: [61.4490, 23.8500], maxTravel: 30 },
  { id: "B", coords: [61.4970, 23.8020], maxTravel: 30 },
  { id: "C", coords: [61.4978, 23.7610], maxTravel: 45 },
];

test("venueSearchCircle: a fixed radius around the group centre", () => {
  // Matching already groups members who are close in travel time, so the
  // centre is somewhere they can all plausibly reach and a fixed radius is a
  // margin rather than a guess.
  const circle = R.venueSearchCircle(members);
  assert.equal(circle.radiusKm, R.VENUE_SEARCH_RADIUS_KM);
  assert.equal(circle.radiusKm, 10);
  assert.ok(Math.abs(circle.lat - 61.4813) < 0.001, "centred on the group");
  assert.ok(Math.abs(circle.lon - 23.8043) < 0.001);
  assert.equal(R.venueSearchCircle(members, 3).radiusKm, 3);
  assert.equal(R.venueSearchCircle([]), null);
});

test("groupSpreadKm: reports how far apart the members are", () => {
  assert.ok(R.groupSpreadKm(members) > 1, "these three are kilometres apart");
  assert.equal(R.groupSpreadKm([members[0]]), 0, "one member is not spread out");
  assert.equal(R.groupSpreadKm([]), 0);
});

test("shortlistVenues: unnamed places are dropped", () => {
  // Roughly two thirds of OSM playgrounds have no name, and an unnamed
  // polygon cannot be put in a message telling a mother where to go.
  const venues = [
    { name: "Atlaspuisto", kind: "playground", lat: 61.4921, lon: 23.7268 },
    { kind: "playground", lat: 61.4922, lon: 23.7269 },
    { name: "", kind: "park", lat: 61.4923, lon: 23.7270 },
  ];
  const out = R.shortlistVenues(venues, [61.49, 23.73], { limit: 10 });
  assert.deepEqual(out.map((v) => v.name), ["Atlaspuisto"]);
});

test("shortlistVenues: spreads the options out instead of clustering", () => {
  // Ten playgrounds on one street are one option, not ten, and measuring them
  // all would spend the whole travel-time budget on a single neighbourhood.
  const cluster = Array.from({ length: 8 }, (_, i) => ({
    name: `Near ${i}`, kind: "playground", lat: 61.4900 + i * 0.0005, lon: 23.7600,
  }));
  const far = { name: "Far", kind: "playground", lat: 61.5200, lon: 23.8200 };
  const out = R.shortlistVenues([...cluster, far], [61.49, 23.76], { limit: 5, minSeparationKm: 0.8 });

  assert.ok(out.length < 6, `expected the cluster to collapse, got ${out.length}`);
  assert.ok(out.some((v) => v.name === "Far"), "a distant option must survive");
  // No two chosen venues sit on top of each other.
  const { haversineKm } = require("../src/matching-engine.js");
  out.forEach((a, i) => out.slice(i + 1).forEach((b) => {
    const km = haversineKm([a.lat, a.lon], [b.lat, b.lon]);
    assert.ok(km >= 0.8, `${a.name} and ${b.name} are ${km.toFixed(2)}km apart`);
  }));
});

test("shortlistVenues: offers a mix of kinds, not just the commonest one", () => {
  // Playgrounds outnumber everything else roughly ten to one in OSM, so a
  // pure distance sort offered ten playgrounds and nothing else: no park, no
  // community centre, and nowhere warm to meet in February.
  // All inside the 10km radius, or the distance filter removes them and the
  // test would be measuring the wrong thing.
  const playgrounds = Array.from({ length: 20 }, (_, i) => ({
    name: `Playground ${i}`, kind: "playground", lat: 61.49 + i * 0.002, lon: 23.76,
  }));
  const others = [
    { name: "Park", kind: "park", lat: 61.50, lon: 23.79 },
    { name: "Centre", kind: "community_centre", lat: 61.51, lon: 23.80 },
    { name: "Mall", kind: "mall", lat: 61.52, lon: 23.81 },
  ];
  const out = R.shortlistVenues([...playgrounds, ...others], [61.49, 23.76], { limit: 8 });
  const kinds = new Set(out.map((v) => v.kind));

  assert.ok(kinds.has("park"), "a park must make the list");
  assert.ok(kinds.has("community_centre"), "a community centre must make the list");
  assert.ok(kinds.has("mall"), "a mall must make the list");
  // The playground it does pick should still be the nearest one.
  assert.equal(out.find((v) => v.kind === "playground").name, "Playground 0");
});

test("shortlistVenues: respects the limit and survives empty input", () => {
  const venues = Array.from({ length: 30 }, (_, i) => ({
    name: `V${i}`, kind: "park", lat: 61.40 + i * 0.01, lon: 23.70 + i * 0.01,
  }));
  assert.equal(R.shortlistVenues(venues, [61.49, 23.76], { limit: 6 }).length, 6);
  assert.deepEqual(R.shortlistVenues([], [61.49, 23.76]), []);
  assert.deepEqual(R.shortlistVenues(null, [61.49, 23.76]), []);
});

test("homesAsVenues: every member's home is offered as a meeting place", () => {
  const named = members.map((m) => ({ ...m, name: `Mum ${m.id}` }));
  const homes = R.homesAsVenues(named);
  assert.equal(homes.length, 3);
  assert.equal(homes[0].kind, "home");
  assert.equal(homes[0].hostId, "A");
  assert.match(homes[0].name, /Mum A/);
  assert.deepEqual([homes[0].lat, homes[0].lon], named[0].coords);
});

test("scorePoints: a point is only reachable if everyone is inside their own limit", () => {
  const points = [{ lat: 61.48, lon: 23.80 }];
  // C has a 45 minute limit, A and B have 30.
  const ok      = R.scorePoints(points, { A: [25], B: [28], C: [40] }, members)[0];
  const overOne = R.scorePoints(points, { A: [25], B: [28], C: [50] }, members)[0];

  assert.equal(ok.reachable, true);
  assert.equal(ok.worstMinutes, 40);
  assert.equal(overOne.reachable, false);
  assert.deepEqual(overOne.blockedBy, ["C"]);
});

test("scorePoints: no route at all is a hard no, not a long journey", () => {
  // The router returning nothing means there is no way to get there. Treating
  // that as a big number would let an unreachable point win a comparison.
  const points = [{ lat: 61.48, lon: 23.80 }];
  const [s] = R.scorePoints(points, { A: [10], B: [10], C: [null] }, members);
  assert.equal(s.reachable, false);
  assert.equal(s.worstMinutes, null);
  assert.deepEqual(s.blockedBy, ["C"]);
});

test("scorePoints: a member missing from the results is unreachable, not undefined", () => {
  const points = [{ lat: 61.48, lon: 23.80 }];
  const [s] = R.scorePoints(points, { A: [10], B: [10] }, members);
  assert.equal(s.reachable, false);
  assert.equal(s.perMember.find((r) => r.id === "C").minutes, null);
});

test("rankMeetingPoints: ranks on the worst journey, not the best average", () => {
  // A group is only as reachable as its most burdened member, so the place
  // that keeps the worst journey down wins even if another has a lower total.
  const points = [{ lat: 61.48, lon: 23.80 }, { lat: 61.49, lon: 23.81 }];
  const scored = R.scorePoints(points, { A: [10, 20], B: [10, 21], C: [44, 22] }, members);
  const ranked = R.rankMeetingPoints(scored);
  assert.equal(ranked[0].worstMinutes, 22, "the 20/21/22 place beats 10/10/44");
});

test("rankMeetingPoints: ties break towards less total travel", () => {
  // Real groups tie: the first live run had two options at 27 minutes and two
  // at 25, so without this the order between them is arbitrary.
  const points = [{ lat: 61.48, lon: 23.80 }, { lat: 61.49, lon: 23.81 }];
  const scored = R.scorePoints(points, { A: [30, 10], B: [30, 10], C: [30, 30] }, members);
  const ranked = R.rankMeetingPoints(scored);
  assert.equal(ranked[0].perMember.reduce((s, r) => s + r.minutes, 0), 50);
});

test("rankMeetingPoints: places nobody can all reach are left out entirely", () => {
  const points = [{ lat: 61.48, lon: 23.80 }, { lat: 61.49, lon: 23.81 }];
  const scored = R.scorePoints(points, { A: [99, 10], B: [99, 10], C: [99, 30] }, members);
  const ranked = R.rankMeetingPoints(scored);
  assert.equal(ranked.length, 1, "the unreachable one is dropped, not ranked last");
  assert.deepEqual(R.rankMeetingPoints([]), []);
  assert.deepEqual(R.rankMeetingPoints(null), []);
});

test("nearestMiss: gives the refining pass somewhere to look when nothing was reachable", () => {
  const points = [{ lat: 61.48, lon: 23.80 }, { lat: 61.49, lon: 23.81 }, { lat: 61.50, lon: 23.82 }];
  // Third point is only slightly over; first two are far over.
  const scored = R.scorePoints(points, { A: [90, 80, 32], B: [90, 80, 31], C: [90, 80, 46] }, members);
  const near = R.nearestMiss(scored);
  assert.equal(near.perMember[0].minutes, 32, "expected the point closest to everyone's limits");

  // A point nobody can route to is no use as a starting guess.
  const unroutable = R.scorePoints(points.slice(0, 1), { A: [null], B: [null], C: [null] }, members);
  assert.equal(R.nearestMiss(unroutable), null);
});


test("shortlistVenues: a venue beyond the radius is dropped", () => {
  // The Overpass query asks for a box because its own circle filter times out
  // on the way elements that most parks are mapped as, so the real radius has
  // to be applied here or the corners of that box leak through.
  const venues = [
    { name: "Inside", kind: "park", lat: 61.50, lon: 23.80 },
    { name: "Outside", kind: "park", lat: 61.70, lon: 23.80 },
  ];
  const out = R.shortlistVenues(venues, [61.49, 23.80], { limit: 10 });
  assert.deepEqual(out.map((v) => v.name), ["Inside"]);
});

test("scorePoints: nobody travels to their own front door", () => {
  // The router returns no itinerary between a point and itself, which scored
  // every home as unreachable for the person who lives there, so a home could
  // never be offered as a meeting place at all.
  const named = members.map((m) => ({ ...m, name: `Mum ${m.id}` }));
  const homes = R.homesAsVenues(named);
  const scored = R.scorePoints(homes, { A: [null, 20, 25], B: [22, null, 18], C: [30, 15, null] }, named);

  assert.equal(scored[0].perMember.find((r) => r.id === "A").minutes, 0, "A is already at A's home");
  assert.equal(scored[1].perMember.find((r) => r.id === "B").minutes, 0);
  assert.equal(scored[0].reachable, true, "everyone can reach A's home");
  assert.equal(scored[0].worstMinutes, 30);
});
