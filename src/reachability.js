// ============================================================================
// Village Matcher: where should a group actually meet?
//
// The old answer was a circle per member, radius = best speed x stated travel
// limit. That is wrong in three ways at once. It uses each member's fastest
// mode rather than one they can all use, it measures straight lines across a
// city built between two large lakes, and it uses the full travel limit while
// the matching engine halves journeys on the assumption the group meets in the
// middle. It looked like an isochrone and was not one.
//
// A real isochrone is not available anywhere. OpenRouteService has profiles
// for car, foot and bicycle but none for public transport, and public
// transport is how most applicants travel. Digitransit has no isochrone
// endpoint at all: its published API list has seven APIs and none of them
// return reachable areas, and the OpenTripPlanner isochrone resource that
// older versions exposed is gone from the v2 routers.
//
// So this stops trying to draw a reachable area, which was never the question
// anyway. A coordinator does not need to know the shape of an overlap; she
// needs to tell four mothers where to meet. Instead:
//
//   1. Ask OpenStreetMap for real places near the group where mothers with a
//      baby can plausibly meet: playgrounds, parks, community centres,
//      shopping malls. Plus the members' own homes, which cost nothing to
//      offer and are often the right answer in a Finnish winter.
//   2. Shortlist a handful, spread out, so the travel-time budget is not
//      spent on ten playgrounds in one neighbourhood.
//   3. Ask the router Reittiopas itself runs on how long each member would
//      really take to reach each one, using her own mode and real timetables.
//   4. Rank by the worst journey in the group and offer the best few.
//
// Every number that reaches the coordinator is a real itinerary. Nothing is
// modelled, interpolated or assumed.
//
// This module is the pure half: geography, shortlisting and scoring. No
// network calls live here.
// ============================================================================

// Loaded both as a Node module (tests, backend) and as a plain browser script
// from index.html, so the dependency has to be resolved either way: `require`
// does not exist in the browser, and the global does not exist in Node.
//
// Note the name. Classic script tags share one global lexical scope, so
// destructuring `haversineKm` here collided with the function of that name in
// matching-engine.js and threw "Identifier already declared" before this file
// could define anything. The app reported that as "Reachability is not
// defined", which points nowhere near the actual cause. There is a test that
// checks for this class of collision now.
const ReachEngine = typeof require === "function"
  ? require("./matching-engine.js")
  : MatchingEngine;
const reachDistanceKm = ReachEngine.haversineKm;

// How far from the group to look for somewhere to meet.
//
// Matching comes first, and that is what makes a fixed radius reasonable: a
// candidate group is already built from members who are close to each other in
// travel time, so their combined centre is somewhere they can all plausibly
// get to, and 10km around it is a generous margin rather than a guess.
//
// Searching wider does not find better meeting points, only more of them
// further away. It also breaks the venue lookup: an 80km box around Tampere
// holds thousands of playgrounds and the shared Overpass server answers it
// with a 504.
const VENUE_SEARCH_RADIUS_KM = 10;

// The middle of the group. Meeting points are searched around here.
function groupCentre(members) {
  if (!members || !members.length) return null;
  return [
    members.reduce((s, m) => s + m.coords[0], 0) / members.length,
    members.reduce((s, m) => s + m.coords[1], 0) / members.length,
  ];
}

// Where to look for venues: a circle, because "within 10km of the group" is
// what is actually meant, and Overpass takes it directly as `around:`. A box
// would search the corners too, which are the furthest points from everyone.
function venueSearchCircle(members, radiusKm = VENUE_SEARCH_RADIUS_KM) {
  const centre = groupCentre(members);
  if (!centre) return null;
  return { lat: centre[0], lon: centre[1], radiusKm };
}

// How far apart the group is. Worth reporting: if the members are 30km apart
// there is no good shared meeting point, and the coordinator should be able to
// see that is why the options look poor rather than blaming the tool.
function groupSpreadKm(members) {
  const centre = groupCentre(members);
  if (!centre) return 0;
  return Math.max(...members.map((m) => reachDistanceKm(centre, m.coords)), 0);
}

// Which kinds of place a group of new mothers can actually meet at, best
// first. A playground is the obvious one; a mall matters in a Finnish winter,
// when an outdoor meeting is not really an option for months at a time.
const VENUE_KINDS = ["playground", "park", "community_centre", "mall"];

// Cuts hundreds of candidates down to a handful worth measuring.
//
// Measuring real travel times is the expensive part, so this is where the
// money is saved: Overpass returns well over a thousand playgrounds and parks
// around Tampere, and the group only needs a few options. Three rules, in
// order of importance:
//
//   1. It has to be nameable. An unnamed playground polygon cannot be put in
//      a message to a mother, and roughly two thirds of them are unnamed.
//   2. It has to be near the group. Closest to the centroid first.
//   3. They have to be spread out. Ten playgrounds on the same street are one
//      option, not ten, and would waste the whole travel-time budget on a
//      single neighbourhood.
function shortlistVenues(venues, centre, options = {}) {
  const limit = options.limit || 10;
  const minSeparationKm = options.minSeparationKm || 0.8;
  const maxDistanceKm = options.maxDistanceKm || VENUE_SEARCH_RADIUS_KM;

  const named = (venues || []).filter((v) => v.name && typeof v.lat === "number" && typeof v.lon === "number");

  // The radius is enforced here rather than in the query. Overpass can filter
  // by a circle with `around:`, but combined with `way` elements it goes from
  // answering in 2 seconds to timing out at 40 and returning nothing, and
  // playgrounds and parks are mapped as areas. So the query asks for a box and
  // the circle is applied to the answer, which is both fast and exact.
  const byKind = new Map();
  named
    .map((v) => ({ ...v, distanceKm: reachDistanceKm(centre, [v.lat, v.lon]) }))
    .filter((v) => v.distanceKm <= maxDistanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .forEach((v) => {
      const kind = VENUE_KINDS.includes(v.kind) ? v.kind : "other";
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(v);
    });

  // Round-robin across the kinds rather than taking the closest few overall.
  // Playgrounds outnumber everything else roughly ten to one, so a pure
  // distance sort offered ten playgrounds and nothing else: no park, no
  // community centre, and no mall to meet at in February.
  const queues = [...VENUE_KINDS, "other"].map((k) => byKind.get(k) || []).filter((q) => q.length);
  const chosen = [];
  let progress = true;
  while (chosen.length < limit && progress) {
    progress = false;
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      // Two playgrounds on the same street are one option, not two.
      while (queue.length) {
        const venue = queue.shift();
        const tooClose = chosen.some((c) => reachDistanceKm([c.lat, c.lon], [venue.lat, venue.lon]) < minSeparationKm);
        if (!tooClose) { chosen.push(venue); progress = true; break; }
      }
    }
  }
  return chosen;
}

// The members' own homes, as meeting places. Free to offer, since no lookup is
// needed, and for mothers with a small baby someone's living room is often a
// better answer than a park in November.
function homesAsVenues(members) {
  return members.map((m) => ({
    id: `home:${m.id}`,
    name: `${m.name}'s home`,
    kind: "home",
    lat: m.coords[0],
    lon: m.coords[1],
    hostId: m.id,
  }));
}

// Scores every sampled point against what each member can actually manage.
//
// `times` is { memberId: [minutes | null, ...] } aligned with `points`, and
// null means the router found no way to get there at all, which is a hard no
// rather than a slow yes.
//
// A group meets somewhere between them rather than at each other's homes, so
// the limit each member is held to is their own stated maximum. The halving
// the matching engine applies is about door-to-door distance between two
// members; here the journey being measured is already the one they would make,
// so it is compared whole.
function scorePoints(points, times, members) {
  const limits = new Map(members.map((m) => [m.id, m.maxTravel]));

  return points.map((point, index) => {
    const perMember = members.map((m) => ({
      id: m.id,
      // Nobody travels to their own front door. The router agrees there is no
      // itinerary between a point and itself and returns nothing, which scored
      // every home as unreachable for the person who lives there, so a home
      // could never be offered at all.
      minutes: point.hostId === m.id ? 0 : (times[m.id]?.[index] ?? null),
      limit: limits.get(m.id),
    }));

    const unreachable = perMember.filter((r) => r.minutes === null);
    const overLimit   = perMember.filter((r) => r.minutes !== null && r.minutes > r.limit);
    const reachable   = unreachable.length === 0 && overLimit.length === 0;

    // The worst journey in the group is what decides whether a meeting point
    // is kind: an average hides the one member travelling an hour.
    const worstMinutes = unreachable.length
      ? null
      : Math.max(...perMember.map((r) => r.minutes));

    return { ...point, perMember, reachable, worstMinutes, blockedBy: [...unreachable, ...overLimit].map((r) => r.id) };
  });
}

// The kindest point everyone can reach, or null if there is no such point.
// Ties break towards the point with the lower total travel, so a group is not
// sent somewhere that happens to suit one member badly.
function bestPoint(scored) {
  const usable = scored.filter((s) => s.reachable && s.worstMinutes !== null);
  if (!usable.length) return null;

  const total = (s) => s.perMember.reduce((sum, r) => sum + r.minutes, 0);
  return usable.reduce((best, s) => {
    if (s.worstMinutes < best.worstMinutes) return s;
    if (s.worstMinutes > best.worstMinutes) return best;
    return total(s) < total(best) ? s : best;
  });
}

// Fallback for the refining pass when nothing at all was reachable: refine
// around whatever came closest, so a second pass can still find a pocket the
// coarse grid stepped over. Points where a member simply cannot get there are
// no use as a starting guess, so they are excluded.
function nearestMiss(scored) {
  const rankable = scored.filter((s) => s.perMember.every((r) => r.minutes !== null));
  if (!rankable.length) return null;
  // How far over their own limit the worst-affected member is.
  const overshoot = (s) => Math.max(...s.perMember.map((r) => r.minutes - r.limit));
  return rankable.reduce((best, s) => (overshoot(s) < overshoot(best) ? s : best));
}

const Reachability = {
  VENUE_SEARCH_RADIUS_KM,
  groupCentre,
  venueSearchCircle,
  groupSpreadKm,
  VENUE_KINDS,
  shortlistVenues,
  homesAsVenues,
  scorePoints,
  bestPoint,
  nearestMiss,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Reachability;
}
