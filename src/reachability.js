// Picking where a group should meet.
//
// No isochrone is available to do this properly: OpenRouteService has no
// public-transport profile, and Digitransit has no isochrone endpoint at all
// (the OpenTripPlanner one older versions exposed is gone from the v2
// routers). So candidate places are scored against real measured journeys
// instead of a reachable area.
//
// The pure half: geography, shortlisting and scoring. No network calls.

// Loaded as a Node module and as a browser script, so the dependency resolves
// both ways. Not destructured: script tags share one global scope, and a bare
// `haversineKm` here collides with matching-engine.js and stops this whole
// file executing.
const ReachEngine = typeof require === "function"
  ? require("./matching-engine.js")
  : MatchingEngine;
const reachDistanceKm = ReachEngine.haversineKm;

// A fixed radius is reasonable because matching runs first: the group is
// already close in travel time. Searching wider also breaks the venue lookup,
// an 80km box around Tampere gets a 504 from Overpass.
const VENUE_SEARCH_RADIUS_KM = 10;

function groupCentre(members) {
  if (!members || !members.length) return null;
  return [
    members.reduce((s, m) => s + m.coords[0], 0) / members.length,
    members.reduce((s, m) => s + m.coords[1], 0) / members.length,
  ];
}

function venueSearchCircle(members, radiusKm = VENUE_SEARCH_RADIUS_KM) {
  const centre = groupCentre(members);
  if (!centre) return null;
  return { lat: centre[0], lon: centre[1], radiusKm };
}

// Reported to the coordinator when no meeting place works, so the reason is
// visible rather than looking like a tool failure.
function groupSpreadKm(members) {
  const centre = groupCentre(members);
  if (!centre) return 0;
  return Math.max(...members.map((m) => reachDistanceKm(centre, m.coords)), 0);
}

// Malls are here because of the winter, when meeting outdoors is not an option
// for months.
const VENUE_KINDS = ["playground", "park", "community_centre", "mall"];

// Cuts the hundreds Overpass returns down to a handful worth measuring, since
// measuring is the expensive part. Unnamed places are dropped because a mother
// cannot be told to meet at an unnamed polygon.
function shortlistVenues(venues, centre, options = {}) {
  const limit = options.limit || 10;
  const minSeparationKm = options.minSeparationKm || 0.8;
  const maxDistanceKm = options.maxDistanceKm || VENUE_SEARCH_RADIUS_KM;

  const named = (venues || []).filter((v) => v.name && typeof v.lat === "number" && typeof v.lon === "number");

  // The radius is enforced here, not in the query: Overpass's own `around:`
  // times out on the `way` elements that most parks are mapped as, so the
  // query asks for a box.
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

  // Round-robin across kinds. Playgrounds outnumber everything else about ten
  // to one, so a pure distance sort offered nothing but playgrounds.
  const queues = [...VENUE_KINDS, "other"].map((k) => byKind.get(k) || []).filter((q) => q.length);
  const chosen = [];
  let progress = true;
  while (chosen.length < limit && progress) {
    progress = false;
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      while (queue.length) {
        const venue = queue.shift();
        const tooClose = chosen.some((c) => reachDistanceKm([c.lat, c.lon], [venue.lat, venue.lon]) < minSeparationKm);
        if (!tooClose) { chosen.push(venue); progress = true; break; }
      }
    }
  }
  return chosen;
}

// Free to offer, and for a mother with a small baby a living room often beats
// a park in November.
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

// `times` is { memberId: [minutes | null, ...] } aligned with `points`. null
// means no route at all, which is a hard no rather than a slow yes.
//
// Journeys are compared whole. The halving the matching engine applies is
// about door-to-door distance between two members; this journey is already the
// one she would actually make.
function scorePoints(points, times, members) {
  const limits = new Map(members.map((m) => [m.id, m.maxTravel]));

  return points.map((point, index) => {
    const perMember = members.map((m) => ({
      id: m.id,
      // The router returns no itinerary between a point and itself, which
      // scored every home as unreachable for the person living there.
      minutes: point.hostId === m.id ? 0 : (times[m.id]?.[index] ?? null),
      limit: limits.get(m.id),
    }));

    const unreachable = perMember.filter((r) => r.minutes === null);
    const overLimit   = perMember.filter((r) => r.minutes !== null && r.minutes > r.limit);
    const reachable   = unreachable.length === 0 && overLimit.length === 0;

    // The worst journey decides, not the average, which hides the one member
    // travelling an hour.
    const worstMinutes = unreachable.length
      ? null
      : Math.max(...perMember.map((r) => r.minutes));

    return { ...point, perMember, reachable, worstMinutes, blockedBy: [...unreachable, ...overLimit].map((r) => r.id) };
  });
}

// Ties break towards less total travel.
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

// What came closest when nothing was reachable, so the coordinator is told
// how near the group got. Places nobody can route to are excluded.
function nearestMiss(scored) {
  const rankable = scored.filter((s) => s.perMember.every((r) => r.minutes !== null));
  if (!rankable.length) return null;
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
