// Village Matcher — browser UI
//
// Talks to the Netlify Function at /.netlify/functions/api for all
// backend operations (Google Sheets read/write, geocoding, travel time,
// meeting-place suggestions). A password stored in localStorage is sent as
// X-Matcher-Password on every request.
//
// For local development against local-test-server.js, append
// ?backend=http://localhost:8791 to the page URL.

const API_URL     = new URLSearchParams(location.search).get('backend') || '/.netlify/functions/api';
const PASSWORD_KEY = 'matcherPassword';

function getPassword() { return localStorage.getItem(PASSWORD_KEY) || ''; }
function setPassword(p) { localStorage.setItem(PASSWORD_KEY, p); }

async function callBackend(action, payload) {
  let resp;
  try {
    resp = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Matcher-Password': getPassword() },
      body:    JSON.stringify({ action, ...payload }),
    });
  } catch (netErr) {
    throw new Error(netErr.message || 'Network error — check your internet connection');
  }

  if (resp.status === 401) {
    const err = new Error('Incorrect password or session expired.');
    err.code  = 'UNAUTHORIZED';
    throw err;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Unexpected response (HTTP ${resp.status})`);
  }

  if (!data.ok) throw new Error(data.error || 'Backend error');
  return data.result;
}

function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function cacheSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full */ }
}

// Not a timeout workaround; the backend runs locally. Chunking is so pins
// appear as they resolve rather than after a silent minute, and so one failed
// chunk costs ten people instead of everyone.
const GEOCODE_CHUNK_SIZE = 10;

const SYNC_BTN_LABEL = '\u21BB Sync with Google Sheet';

// Passing null restores the button's normal label.
function reportSyncProgress(text) {
  const btn = document.getElementById('syncBtn');
  if (btn) btn.textContent = text || SYNC_BTN_LABEL;
}

// Cached results never expire, which is right for an address, but it means a
// coordinate the backend got WRONG is kept forever too. Bump this whenever a
// change could alter what an address resolves to, or the fix never reaches a
// browser holding the old answer.
const GEOCODE_CACHE_VERSION = 'v2';
const GEOCODE_CACHE_PREFIX  = `geocode:${GEOCODE_CACHE_VERSION}:`;

function geocodeCacheKey(applicant) {
  return `${GEOCODE_CACHE_PREFIX}${applicant.street}, ${applicant.neighborhood}`;
}

function pruneStaleGeocodeCache() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('geocode:') && !key.startsWith(GEOCODE_CACHE_PREFIX)) stale.push(key);
    }
    stale.forEach((key) => localStorage.removeItem(key));
    if (stale.length) console.info(`Discarded ${stale.length} geocode result(s) from an older version.`);
  } catch { /* storage unavailable */ }
}

// Fire-and-forget backend write. Local state is updated immediately so the
// UI never waits on a network round trip.
function syncToBackend(action, payload) {
  callBackend(action, payload).catch((err) => {
    if (err.code === 'UNAUTHORIZED') { showPasswordGate('Session expired — please re-enter the password.'); return; }
    console.warn(`Backend sync failed (${action}):`, err.message);
  });
}

// Not re-entrant on its own: the function replaces state.applicants and then
// awaits geocoding, so a second concurrent call would swap the array out from
// under the first and the geocode results would land on orphaned objects,
// leaving everyone without coordinates. Concurrent callers share one load
// instead — this happens for real when the organizer hits Sync while the
// initial load is still running.
let loadInFlight = null;

async function loadFromBackend() {
  if (loadInFlight) return loadInFlight;
  loadInFlight = loadFromBackend_();
  try {
    return await loadInFlight;
  } finally {
    loadInFlight = null;
  }
}

async function loadFromBackend_() {
  try {
    const [applicants, groups, templates, settings] = await Promise.all([
      callBackend('getApplicants', {}),
      callBackend('getGroups', {}),
      callBackend('getTemplates', {}),
      callBackend('getSettings', {}),
    ]);
    const prevById = Object.fromEntries(state.applicants.map((a) => [a.id, a]));
    state.applicants = applicants.map((a) => {
      const prev = prevById[a.id];
      return {
        ...a,
        // No coordinate until geocoding produces one. Inventing a random
        // point near Helsinki (which this used to do) doesn't just misplace a
        // pin — it fabricates distances that the matching engine then treats
        // as real.
        coords:        prev?.geocodedReal ? prev.coords : null,
        geocodedReal:  prev?.geocodedReal || false,
        geocodeLabel:  prev?.geocodeLabel || null,
        geocodeIssue:  prev?.geocodedReal ? null : 'Address not geocoded yet',
        // A placed-but-imperfect match: right street and city, nearest known
        // house number. Usable for matching, still worth the organizer seeing.
        geocodeWarning: prev?.geocodeWarning || null,
        // 'exact' | 'approximate' | 'street' | 'area'. Drives how the pin is
        // drawn, so an area-centre guess doesn't look like a rooftop fix.
        geocodePrecision: prev?.geocodePrecision || null,
      };
    });
    await ensureGeocoded(state.applicants);
    state.groups    = groups;
    state.templates = { ...state.templates, ...templates };
    if (settings.maxAgeGap)    state.settings.maxAgeGap    = Number(settings.maxAgeGap);
    if (settings.minGroupSize) state.settings.minGroupSize = Number(settings.minGroupSize);
    if (settings.maxGroupSize) state.settings.maxGroupSize = Number(settings.maxGroupSize);
    const maxNum = Math.max(0, ...groups.map((g) => Number((g.id || '').replace('G-', '')) || 0));
    state.nextGroupNum     = maxNum + 1;
    state.usingBackendData = true;
    return true;
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      showPasswordGate('Session expired — please re-enter the password.');
      return false;
    }
    console.warn('Loading from backend failed:', err.message);
    state.usingBackendData = false;
    return false;
  }
}

const state = {
  applicants:       [],
  groups:           [],
  candidateGroups:  [],
  templates:        { firstContact: '', confirmationAsk: '', introduction: '' },
  settings: {
    maxAgeGap:          6,
    minGroupSize:       3,
    maxGroupSize:       4,
    neighborhoodFilter: 'all',
  },
  activeTab:         'new-matches',
  overlapVisibleFor: null,
  nextGroupNum:      1,
  usingBackendData:  false,
  travelTimeStats: null,
  travelTimeError: null,
  travelTimeRejected: 0,
};

// ---------------------------------------------------------------------------
// Travel time: cache + backend, falling back to MatchingEngine estimates
// ---------------------------------------------------------------------------

// Directional. Transit A->B and B->A genuinely differ, and the matching model
// compares each person's own journey against their own limit, so collapsing
// the two into one slot threw away half the data — computeCandidateGroups
// already requests both directions, so a sorted key meant the second result
// simply overwrote the first.
function travelCacheKey(idA, idB, mode) {
  return `travel:${idA}>${idB}:${mode}`;
}

function getTravelMinutes(a, b, mode) {
  const key    = travelCacheKey(a.id, b.id, mode);
  const cached = cacheGet(key);
  if (cached && typeof cached.minutes === 'number') return cached.minutes;
  return MatchingEngine.estimateTravelTime(MatchingEngine.haversineKm(a.coords, b.coords), mode);
}

async function ensureGeocoded(applicants) {
  const missing = applicants.filter((a) => !a.geocodedReal);
  if (missing.length === 0) return;

  const toFetch = [];
  missing.forEach((a) => {
    const cached = cacheGet(geocodeCacheKey(a));
    if (cached && typeof cached.lat === 'number') {
      a.coords         = [cached.lat, cached.lon];
      a.geocodedReal   = true;
      a.geocodeLabel   = cached.label || null;
      a.geocodeIssue   = null;
      a.geocodeWarning = cached.warning || null;
      a.geocodePrecision = cached.precision || 'exact';
    } else {
      toFetch.push(a);
    }
  });
  if (toFetch.length === 0) return;

  // Sequential, not parallel: the backend rate-limits per process, so
  // concurrent chunks would just multiply the request rate.
  for (let start = 0; start < toFetch.length; start += GEOCODE_CHUNK_SIZE) {
    const chunk = toFetch.slice(start, start + GEOCODE_CHUNK_SIZE);
    reportSyncProgress(`Placing addresses… ${start} of ${toFetch.length}`);
    try {
      // Structured, so the backend can anchor the search to the district rather
      // than hoping the geocoder respects a municipality buried in free text.
      const addresses = chunk.map((a) => ({ street: a.street, neighborhood: a.neighborhood }));
      const results   = await callBackend('geocode', { addresses });
      results.forEach((r, i) => applyGeocodeResult(chunk[i], r));
    } catch (err) {
      // One failed chunk must not abandon the rest.
      console.warn(`Geocoding chunk ${start}-${start + chunk.length} failed:`, err.message);
      chunk.forEach((a) => { a.geocodeIssue = `Geocoding unavailable: ${err.message}`; });
    }
  }
  reportSyncProgress(null);
}

function applyGeocodeResult(a, r) {
  a.geocodeLabel = r.label || null;
  if (typeof r.lat === 'number' && r.precise) {
    a.coords         = [r.lat, r.lon];
    a.geocodedReal   = true;
    a.geocodeIssue   = null;
    a.geocodeWarning = r.warning || null;
    a.geocodePrecision = r.precision || 'exact';
    cacheSet(geocodeCacheKey(a), r);
    return;
  }

  a.coords         = null;
  a.geocodedReal   = false;
  a.geocodeWarning = null;
  a.geocodeIssue   = r.error
    ? `Address not found: ${r.error}`
    : `Address only matched loosely${r.label ? ` (got "${r.label}")` : ''}, so it needs a more exact street address`;
}

async function ensureTravelTimes(pairsNeeded) {
  if (pairsNeeded.length === 0) return;

  const toFetch = pairsNeeded
    .filter(({ a, b, mode }) => !cacheGet(travelCacheKey(a.id, b.id, mode)))
    .map(({ a, b, mode }) => ({
      id:   travelCacheKey(a.id, b.id, mode),
      from: { lat: a.coords[0], lon: a.coords[1] },
      to:   { lat: b.coords[0], lon: b.coords[1] },
      mode,
    }));
  if (toFetch.length === 0) return;

  const requested = new Map(toFetch.map((p) => [p.id, p]));

  try {
    const results = await callBackend('travelTime', { pairs: toFetch });
    results.forEach((r) => {
      if (typeof r.minutes !== 'number') {
        if (r.error && !state.travelTimeError) state.travelTimeError = r.error;
        return;
      }
      // A successful call can still return an impossible number. Caching one
      // is worse than falling back to an estimate, because it would be counted
      // and displayed as a real routed journey.
      const pair = requested.get(r.id);
      const km   = pair
        ? MatchingEngine.haversineKm([pair.from.lat, pair.from.lon], [pair.to.lat, pair.to.lon])
        : NaN;
      if (pair && !MatchingEngine.travelTimePlausible(r.minutes, km, pair.mode)) {
        state.travelTimeRejected = (state.travelTimeRejected || 0) + 1;
        if (!state.travelTimeError) {
          state.travelTimeError =
            `implausible routed time (${r.minutes.toFixed(0)} min for ${km.toFixed(1)} km by ${pair.mode})`;
        }
        return;
      }
      cacheSet(r.id, { minutes: r.minutes });
    });
  } catch (err) {
    console.warn('Travel-time backend call failed, falling back to estimates:', err.message);
    state.travelTimeError = err.message;
  }
}

// ---------------------------------------------------------------------------
// Matching engine orchestration
// ---------------------------------------------------------------------------

async function computeCandidateGroups() {
  // geocodedReal is a hard requirement: without a real coordinate there is no
  // honest travel time, and matching on a guess is worse than not matching.
  const pool = state.applicants.filter(
    (a) =>
      a.matchStatus === 'unmatched' &&
      a.eligibleForMatching &&
      a.geocodedReal &&
      (state.settings.neighborhoodFilter === 'all' || a.neighborhood === state.settings.neighborhoodFilter)
  );

  const pairsNeeded = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      const distanceKm = MatchingEngine.haversineKm(a.coords, b.coords);
      // Rough reachability, only to decide which pairs are worth a routing
      // call. Each person covers about half the door-to-door distance to reach
      // the meeting point, minus the fixed overhead of their mode, and the 1.5
      // factor allows for roads not running straight.
      const reachable = (person, mode) => {
        const model = MatchingEngine.MODE_MODEL[mode];
        if (!model) return false;
        const movingMin = Math.max(0, person.maxTravel - model.overheadMin);
        return distanceKm <= 2 * (movingMin / 60) * model.speedKmh * 1.5;
      };
      const modesA = a.transport.filter((mode) => reachable(a, mode));
      const modesB = b.transport.filter((mode) => reachable(b, mode));
      if (modesA.length === 0 || modesB.length === 0) continue;
      modesA.forEach((mode) => pairsNeeded.push({ a, b, mode }));
      modesB.forEach((mode) => pairsNeeded.push({ a: b, b: a, mode }));
    }
  }
  state.travelTimeError = null;
  state.travelTimeRejected = 0;
  await ensureTravelTimes(pairsNeeded);

  // Lisa asked whether the tool really checks public transport times. It does,
  // but any routing failure degrades silently to a straight-line speed
  // estimate, which is indistinguishable in the output — so count which is
  // which and say so.
  const routed = pairsNeeded.filter(({ a, b, mode }) => cacheGet(travelCacheKey(a.id, b.id, mode))).length;
  state.travelTimeStats = {
    total: pairsNeeded.length,
    routed,
    estimated: pairsNeeded.length - routed,
    rejected: state.travelTimeRejected || 0,
  };

  // clusterGroups already returns strongest-first; the score is recomputed
  // here for display rather than widening its return type.
  const groups = MatchingEngine.clusterGroups(pool, state.settings, getTravelMinutes);
  return groups.map((group, i) => ({
    candidateId: 'cand-' + i,
    memberIds:   group.map((m) => m.id),
    name:        `${MatchingEngine.mostCommonNeighborhood(group)} · ${MatchingEngine.groupAgeRangeLabel(group)} · ${group.length} moms`,
    score:       MatchingEngine.scoreGroup(group, state.settings, getTravelMinutes),
  }));
}

// ---------------------------------------------------------------------------
// Data mutations
// ---------------------------------------------------------------------------

function getApplicant(id) { return state.applicants.find((a) => a.id === id); }

async function approveGroup(candidateId) {
  const cand = state.candidateGroups.find((c) => c.candidateId === candidateId);
  if (!cand) return;
  const name = cand.name.replace(/ · \d+ moms$/, '');

  let groupId;
  try {
    const result = await callBackend('createGroup', { group: { name, memberIds: cand.memberIds, status: 'open' } });
    groupId = result.id;
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') { showPasswordGate(); return; }
    console.warn('Creating group on backend failed, using local id:', err.message);
  }
  if (!groupId) groupId = 'G-' + String(state.nextGroupNum++).padStart(3, '0');

  const group = { id: groupId, name, memberIds: cand.memberIds, status: 'open', created: new Date().toISOString() };
  state.groups.push(group);
  cand.memberIds.forEach((id) => {
    const a = getApplicant(id);
    a.matchStatus  = 'match_found';
    a.matchGroupId = groupId;
    syncToBackend('updateApplicant', { id, fields: { matchStatus: 'match_found', matchGroupId: groupId } });
  });
  state.candidateGroups = state.candidateGroups.filter((c) => c.candidateId !== candidateId);
  renderAll();
}

function rejectGroup(candidateId) {
  state.candidateGroups = state.candidateGroups.filter((c) => c.candidateId !== candidateId);
  renderAll();
}

function markStatus(applicantId, status) {
  const a = getApplicant(applicantId);
  a.matchStatus = status;
  syncToBackend('updateApplicant', { id: applicantId, fields: { matchStatus: status } });
  if (status === 'confirmed' || status === 'introduced') {
    const group = state.groups.find((g) => g.id === a.matchGroupId);
    if (group) {
      group.status = 'established';
      syncToBackend('updateGroup', { id: group.id, fields: { status: 'established' } });
    }
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// WhatsApp helpers
// ---------------------------------------------------------------------------

function fillTemplate(template, applicant, group) {
  if (!template) return `Hi ${applicant.name}! This is a message from your village organizer.`;
  const groupMembers = group ? group.memberIds.map((id) => getApplicant(id).name).join(', ') : '';
  return template
    .replaceAll('{{name}}',          applicant.name)
    .replaceAll('{{neighborhood}}',  applicant.neighborhood)
    .replaceAll('{{baby_month}}',    MatchingEngine.formatMonthYear(applicant.dob))
    .replaceAll('{{group_members}}', groupMembers)
    .replaceAll('{{age_range}}',     group ? MatchingEngine.groupAgeRangeLabel(group.memberIds.map((id) => getApplicant(id))) : '');
}

function waLink(applicant, template, group) {
  const digits = applicant.phone.replace(/[^\d]/g, '');
  const text   = encodeURIComponent(fillTemplate(template, applicant, group));
  return `https://wa.me/${digits}?text=${text}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

let map, overlapLayer, pinLayer, highlightLayer;

// Rebuilt on every renderMap.
let markerForApplicant = new Map();
// So a re-render does not yank the map back from wherever it was panned.
let mapFramed = false;
// Held across renders, or approving a group drops the ring silently.
let selectedApplicantId = null;

function initMap() {
  // Placeholder only; renderMap fits the view to the actual pins. A hardcoded
  // Helsinki view left a Tampere dataset off-screen.
  map = L.map('map', { attributionControl: false }).setView([64.0, 26.0], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  overlapLayer   = L.layerGroup().addTo(map);
  pinLayer       = L.layerGroup().addTo(map);
  // Above the pins, so a selection ring is never hidden under a dot.
  highlightLayer = L.layerGroup().addTo(map);
}

const GROUP_COLORS = ['#3F6C51', '#C1622D', '#5B6EC9', '#B0447A', '#3F8F8F', '#8A7A3F'];

function colorForGroup(groupId) {
  if (!groupId) return null;
  const idx = state.groups.findIndex((g) => g.id === groupId);
  return GROUP_COLORS[idx % GROUP_COLORS.length];
}

function candidateColor(candidateId) {
  const idx = state.candidateGroups.findIndex((c) => c.candidateId === candidateId);
  return GROUP_COLORS[idx % GROUP_COLORS.length];
}

function applicantCandidateColor(applicantId) {
  const cand = state.candidateGroups.find((c) => c.memberIds.includes(applicantId));
  return cand ? candidateColor(cand.candidateId) : null;
}

// Five decimals is about a metre, so anyone sharing an entrance.
function pinKey(coords) {
  return coords[0].toFixed(5) + ',' + coords[1].toFixed(5);
}

// Two mothers in one building used to be two markers on the same pixel, so
// the second was invisible: 17 applicants showed as 7 dots.
function groupApplicantsByLocation(applicants) {
  const spots = new Map();
  applicants.forEach((a) => {
    const key = pinKey(a.coords);
    if (!spots.has(key)) spots.set(key, { coords: a.coords, people: [] });
    spots.get(key).people.push(a);
  });
  return [...spots.values()];
}

function applicantPopupHtml(a) {
  const groupName = a.matchGroupId
    ? escHtml(state.groups.find((g) => g.id === a.matchGroupId)?.name ?? '')
    : '';
  return `<strong>${escHtml(a.id)}</strong> ${escHtml(a.name)}` +
    `${a.expecting ? ' (expecting)' : ''}<br>` +
    `${escHtml(a.street + ', ' + a.neighborhood)}<br>` +
    `${a.language.map(escHtml).join(', ')}<br>` +
    `${a.transport.map(escHtml).join('')} ${escHtml(a.maxTravel)}<br>` +
    `${a.matchGroupId ? 'Group: ' + groupName : 'Status: ' + escHtml(a.matchStatus)}` +
    (a.geocodeWarning ? `<br><em>${escHtml(a.geocodeWarning)}</em>` : '');
}

function renderMap() {
  pinLayer.clearLayers();
  highlightLayer.clearLayers();
  markerForApplicant = new Map();

  const placed = state.applicants.filter((a) => !a.hasDataIssues && a.geocodedReal && a.coords);

  groupApplicantsByLocation(placed).forEach((spot) => {
    const { coords, people } = spot;
    // From whichever occupant is in a group, so a shared dot never looks
    // unmatched when someone under it is matched.
    const groupColor = people.map((a) => colorForGroup(a.matchGroupId) || applicantCandidateColor(a.id))
                             .find(Boolean) || null;
    const isMatched  = !!groupColor;
    const shared     = people.length > 1;

    // Drawn hollow and dashed, or a guess covering a whole district reads as
    // a rooftop-accurate fix while scanning the map.
    const approximate = people.every((a) => a.geocodePrecision === 'area');
    const marker = L.circleMarker(coords, {
      radius: shared ? 12 : 9,
      color: isMatched ? groupColor : '#8A8577',
      weight: shared ? 3 : 2,
      fillColor: isMatched ? groupColor : '#FAF9F6',
      fillOpacity: approximate ? 0.15 : (isMatched ? 0.9 : 0.5),
      dashArray: approximate ? '2,3' : (isMatched ? null : '3,2'),
    }).addTo(pinLayer);

    if (shared) {
      // Otherwise there is nothing to show that anyone is underneath.
      marker.bindTooltip(String(people.length), {
        permanent: true, direction: 'center', className: 'pin-count',
      });
    }

    marker.bindPopup(
      shared
        ? `<strong>${people.length} people at this address</strong>` +
          `<div class="pin-popup-list">${people.map(applicantPopupHtml).join('<hr>')}</div>`
        : applicantPopupHtml(people[0]),
      { maxHeight: 260 }
    );

    people.forEach((a) => markerForApplicant.set(a.id, marker));
  });

  frameMapAroundPins(placed);
  // Re-draw the ring for whoever was selected. The layer was just cleared, and
  // losing the highlight on every render made it useless as soon as anything
  // else on the page changed.
  if (selectedApplicantId) drawHighlightRing(selectedApplicantId);
}

function frameMapAroundPins(placed) {
  if (mapFramed || placed.length === 0) return;
  const bounds = L.latLngBounds(placed.map((a) => a.coords));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  mapFramed = true;
}

function drawHighlightRing(applicantId) {
  const marker = markerForApplicant.get(applicantId);
  if (!marker) return null;
  L.circleMarker(marker.getLatLng(), {
    radius: 20, color: '#C1622D', weight: 3, fill: false, className: 'pin-highlight',
  }).addTo(highlightLayer);
  return marker;
}

let markerForMeeting = new Map();

// The answer to "where is this person" for someone under another dot.
function focusApplicantOnMap(applicantId) {
  highlightLayer.clearLayers();
  if (!getApplicant(applicantId)) return false;

  const marker = drawHighlightRing(applicantId);
  if (!marker) return false;
  selectedApplicantId = applicantId;

  // Never zoom out from wherever the organizer already is.
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
  marker.openPopup();
  return true;
}

// Each venue costs a routing query per member, so this is the budget.
const MEETING_SHORTLIST = 9;
const MEETING_OPTIONS = 3;

// Keyed by the members, so editing a group discards it.
const meetingCache = new Map();

function meetingCacheKey(members) {
  return members.map((m) => `${m.id}:${m.coords}:${m.maxTravel}`).sort().join('|');
}

// The fastest mode she has. Deliberately not a mode the whole group shares:
// requiring that made the old overlap useless, since one transit-only member
// disabled measurement for everyone.
function travelMode(applicant) {
  return [...applicant.transport]
    .sort((a, b) => MatchingEngine.MODE_MODEL[b].speedKmh - MatchingEngine.MODE_MODEL[a].speedKmh)[0];
}

async function findMeetingPoints(members) {
  const circle = Reachability.venueSearchCircle(members);
  const centre = [circle.lat, circle.lon];

  // Free to offer, and a living room often beats a park.
  let candidates = Reachability.homesAsVenues(members);

  try {
    const venues = await callBackend('meetingVenues', { circle });
    candidates = candidates.concat(
      Reachability.shortlistVenues(venues, centre, {
        limit: MEETING_SHORTLIST, maxDistanceKm: circle.radiusKm,
      })
    );
  } catch (err) {
    // Overpass sheds load when busy. Fewer options, not no answer.
    console.warn('Venue lookup failed, offering homes only:', err.message);
  }

  const times = await callBackend('travelTimeGrid', {
    origins: members.map((m) => ({ id: m.id, lat: m.coords[0], lon: m.coords[1], mode: travelMode(m) })),
    points:  candidates.map((v) => ({ lat: v.lat, lon: v.lon })),
  });

  return Reachability.scorePoints(candidates, times, members);
}

async function drawOverlap(candidateId) {
  overlapLayer.clearLayers();
  // Toggling the suggestions off has to take the status line with it, or the
  // last result sits there describing markers that are no longer on the map.
  setOverlapStatus(null);
  clearMeetingLists();
  if (!candidateId) return;
  const cand = state.candidateGroups.find((c) => c.candidateId === candidateId);
  if (!cand) return;

  const all      = cand.memberIds.map(getApplicant);
  const members  = all.filter((m) => m.coords && m.transport.length);
  const excluded = all.filter((m) => !m.coords || !m.transport.length);

  if (members.length < 2) {
    setOverlapStatus('Not enough of this group has a location and a way of travelling to work out where to meet.');
    return;
  }
  // Silently leaving someone out would produce a meeting place that does not
  // actually work for the whole group, which is worse than saying so.
  const caveat = excluded.length
    ? ` Not counting ${excluded.map((m) => m.name).join(', ')}, who ${excluded.length === 1 ? 'has' : 'have'} no usable location or transport.`
    : '';
  const color = candidateColor(candidateId);

  const key = meetingCacheKey(members);
  let scored = meetingCache.get(key);

  if (!scored) {
    // Real itineraries, so this takes a few seconds.
    setOverlapStatus('Finding places to meet and checking real travel times\u2026');
    try {
      scored = await findMeetingPoints(members);
      meetingCache.set(key, scored);
    } catch (err) {
      console.warn('Meeting point search failed:', err.message);
      setOverlapStatus(`Could not work out where to meet: ${err.message}`);
      return;
    }
  }
  renderMeetingPoints(scored, members, color, caveat);
  renderMeetingList(candidateId, scored, members);
}

// The map answers "where", but the name and times get copied into a message,
// and re-opening a popup for each option to compare them is painful.
function renderMeetingList(candidateId, scored, members) {
  const host = document.querySelector(`.meeting-list[data-meeting-for="${cssEscape(candidateId)}"]`);
  if (!host) return;

  const workable = scored
    .filter((s) => s.reachable)
    .sort((a, b) => a.worstMinutes - b.worstMinutes)
    .slice(0, MEETING_OPTIONS);

  if (!workable.length) {
    const spread = Reachability.groupSpreadKm(members);
    host.innerHTML = `<div class="meeting-empty">Nowhere works for everyone within their own travel limits. ` +
      `These members live ${escHtml(spread.toFixed(1))}km apart.</div>`;
    host.hidden = false;
    return;
  }

  host.innerHTML = `<div class="meeting-list-head">Places everyone can reach</div>` +
    workable.map((option, rank) => {
      const rows = option.perMember.map((r) => {
        const who = getApplicant(r.id);
        const mode = who ? MODE_ICON[travelMode(who)] || '' : '';
        return `<div class="meeting-leg"><span>${mode} ${escHtml(who ? who.name : r.id)}</span>` +
          `<span>${Math.round(r.minutes)} min <span class="meeting-limit">of ${escHtml(r.limit)}</span></span></div>`;
      }).join('');

      return `<div class="meeting-option${rank === 0 ? ' meeting-option-best' : ''}" data-meeting-key="${escHtml(meetingKey(option))}">
        <button class="meeting-option-head" type="button" aria-expanded="false">
          <span class="meeting-icon">${VENUE_ICON[option.kind] || '\u{1F4CD}'}</span>
          <span class="meeting-name">${escHtml(option.name)}</span>
          <span class="meeting-kind">${escHtml(VENUE_LABEL[option.kind] || option.kind || 'place')}</span>
          <span class="meeting-worst">${Math.round(option.worstMinutes)} min</span>
        </button>
        <div class="meeting-legs" hidden>${rows}
          <button class="meeting-locate" type="button">Show on map</button>
        </div>
      </div>`;
    }).join('');

  host.hidden = false;

  host.querySelectorAll('.meeting-option-head').forEach((head) => {
    head.addEventListener('click', () => {
      const legs = head.nextElementSibling;
      const open = !legs.hidden;
      legs.hidden = open;
      head.setAttribute('aria-expanded', String(!open));
    });
  });

  host.querySelectorAll('.meeting-locate').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.closest('.meeting-option').dataset.meetingKey;
      const marker = markerForMeeting.get(key);
      if (!marker) return;
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
      marker.openPopup();
    });
  });
}

function clearMeetingLists() {
  document.querySelectorAll('.meeting-list').forEach((el) => {
    el.hidden = true;
    el.innerHTML = '';
  });
}

function meetingKey(option) {
  return `${option.lat.toFixed(5)},${option.lon.toFixed(5)}`;
}

function renderMeetingPoints(scored, members, color, caveat = '') {
  markerForMeeting = new Map();
  const workable = scored
    .filter((s) => s.reachable)
    .sort((a, b) => a.worstMinutes - b.worstMinutes)
    .slice(0, MEETING_OPTIONS);

  // Everyone in the pool is on this map, so without this the suggestion is
  // lines reaching into an anonymous crowd of dots.
  markActiveMembers(members, color);

  if (!workable.length) {
    // Still frame it: how far apart they are is the explanation.
    frameGroup(members, []);
    const near = Reachability.nearestMiss(scored);
    const spread = Reachability.groupSpreadKm(members);
    setOverlapStatus(
      'No shared meeting place works for everyone within their stated travel limits. ' +
      (near ? `The closest was ${near.name}, ${Math.round(Math.max(...near.perMember.map((r) => r.minutes)))} min for the furthest member. ` : '') +
      `These members live ${spread.toFixed(1)}km apart.` + caveat
    );
    return;
  }

  // So it is visible who is being asked to travel furthest.
  workable.forEach((option, rank) => {
    const primary = rank === 0;

    members.forEach((m) => {
      const path = [m.coords, [option.lat, option.lon]];
      // A pale casing under the coloured line. The group colours are dark by
      // design and vanish into the basemap's greens and greys, and
      // brightening them would lose the link to the group's pins.
      L.polyline(path, {
        color: '#FFFFFF',
        weight: primary ? 7 : 5,
        opacity: primary ? 0.9 : 0.55,
        lineCap: 'round',
      }).addTo(overlapLayer);

      L.polyline(path, {
        color,
        weight: primary ? 3.5 : 2,
        opacity: primary ? 1 : 0.65,
        dashArray: primary ? null : '5,5',
        lineCap: 'round',
      }).addTo(overlapLayer);
    });

    // Square, unlike the round pins that mean people.
    const marker = L.marker([option.lat, option.lon], {
      icon: L.divIcon({
        className: 'meeting-marker' + (primary ? ' meeting-marker-best' : ''),
        html: `<span style="border-color:${escHtml(color)}">${VENUE_ICON[option.kind] || '\u{1F4CD}'}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
    }).addTo(overlapLayer).bindPopup(meetingPopup(option, rank));
    markerForMeeting.set(meetingKey(option), marker);
  });

  frameGroup(members, workable);

  const best = workable[0];
  setOverlapStatus(
    `Best of ${workable.length}: ${best.name} (${Math.round(best.worstMinutes)} min for whoever travels furthest). ` +
    `Click a marker for each member's journey.` + caveat
  );
}

// Dashed and wider than the pin inside, so it reads as a selection and is not
// confused with the solid ring that marks one person picked from a list.
function markActiveMembers(members, color) {
  members.forEach((m) => {
    L.circleMarker(m.coords, {
      radius: 15, color, weight: 3, fill: false, dashArray: '4,3', opacity: 0.9,
    }).addTo(overlapLayer);
  });
}

// Without this the map stays framed over the whole pool, which for a national
// dataset is hundreds of kilometres wide.
function frameGroup(members, options) {
  const points = [
    ...members.map((m) => m.coords),
    ...options.map((o) => [o.lat, o.lon]),
  ];
  if (!points.length) return;

  // Overrides wherever it was panned: she just asked to see this group.
  map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 15 });
  mapFramed = true;
}

const VENUE_ICON = {
  playground:       '\u{1F6DD}',
  park:             '\u{1F333}',
  community_centre: '\u{1F3E4}',
  mall:             '\u{1F6CD}',
  home:             '\u{1F3E1}',
};

const VENUE_LABEL = {
  playground:       'playground',
  park:             'park',
  community_centre: 'community centre',
  mall:             'shopping centre',
  home:             'a member\u2019s home',
};

function meetingPopup(option, rank) {
  const rows = option.perMember.map((r) => {
    const who  = getApplicant(r.id);
    const mode = who ? MODE_ICON[travelMode(who)] || '' : '';
    const time = r.minutes === null ? 'no route' : `${Math.round(r.minutes)} min`;
    const over = r.minutes !== null && r.minutes > r.limit;
    return `<div>${mode} ${escHtml(who ? who.name : r.id)} ` +
      `<strong${over ? ' style="color:#B3261E"' : ''}>${time}</strong>` +
      `<span style="opacity:.6"> of ${escHtml(r.limit)} min</span></div>`;
  }).join('');

  return `<strong>${escHtml(option.name)}</strong><br>` +
    `<span style="opacity:.7">${escHtml(VENUE_LABEL[option.kind] || option.kind || 'place')}` +
    `${rank === 0 ? ' \u00B7 best option' : ''}</span><br>` +
    `Longest journey ${Math.round(option.worstMinutes)} min` +
    `<div style="margin-top:5px">${rows}</div>`;
}

// Written next to the map legend, because this takes a few seconds and can
// legitimately come back empty. Both need saying somewhere visible.
function setOverlapStatus(text) {
  const el = document.getElementById('overlapStatus');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

const MODE_ICON = { W: '🚶', D: '🚙', P: '🚌', B: '🚲' };
const MODE_LABEL = { W: 'walk', D: 'car', P: 'public transport', B: 'bicycle' };

// A flag per language, for the compact summary on an applicant row. Only
// languages with one widely-understood country association are listed. Arabic
// and Kurdish are spoken across many countries and by people from many more,
// so choosing a flag for them would state something false about the person;
// those fall through to their name in text, which is the honest answer.
const FLAG_MAP = {
  Finnish: '\u{1F1EB}\u{1F1EE}', English: '\u{1F1EC}\u{1F1E7}', Swedish: '\u{1F1F8}\u{1F1EA}',
  Russian: '\u{1F1F7}\u{1F1FA}', Ukrainian: '\u{1F1FA}\u{1F1E6}', Estonian: '\u{1F1EA}\u{1F1EA}',
  Polish: '\u{1F1F5}\u{1F1F1}', Romanian: '\u{1F1F7}\u{1F1F4}', Turkish: '\u{1F1F9}\u{1F1F7}',
  Somali: '\u{1F1F8}\u{1F1F4}', Vietnamese: '\u{1F1FB}\u{1F1F3}', Thai: '\u{1F1F9}\u{1F1ED}',
  Chinese: '\u{1F1E8}\u{1F1F3}', Japanese: '\u{1F1EF}\u{1F1F5}', Hindi: '\u{1F1EE}\u{1F1F3}',
  Bengali: '\u{1F1E7}\u{1F1E9}', Nepali: '\u{1F1F3}\u{1F1F5}', Tagalog: '\u{1F1F5}\u{1F1ED}',
  Spanish: '\u{1F1EA}\u{1F1F8}', Portuguese: '\u{1F1F5}\u{1F1F9}', French: '\u{1F1EB}\u{1F1F7}',
  Italian: '\u{1F1EE}\u{1F1F9}', German: '\u{1F1E9}\u{1F1EA}', Farsi: '\u{1F1EE}\u{1F1F7}',
  Persian: '\u{1F1EE}\u{1F1F7}',
};

// The compact line that used to sit on every applicant row and disappeared
// with the village rewrite: which languages she speaks, how she travels, and
// how far she will go. Emoji alone are ambiguous and say nothing to a screen
// reader, so the cluster carries the same information as text in its title.
function applicantTags(a) {
  const flags = a.language.map((l) => FLAG_MAP[l] || `<span class="tag-word">${escHtml(l)}</span>`).join('');
  const modes = a.transport.map((m) => MODE_ICON[m] || escHtml(m)).join('');
  const travel = a.maxTravel || a.maxTravel === 0 ? `${escHtml(a.maxTravel)} min` : '';
  const title = [
    a.language.length ? `Speaks ${a.language.join(', ')}` : '',
    a.transport.length ? `Travels by ${a.transport.map((m) => MODE_LABEL[m] || m).join(', ')}` : '',
    travel ? `up to ${a.maxTravel} min` : '',
  ].filter(Boolean).join(' \u00B7 ');

  if (!flags && !modes && !travel) return '';
  return `<span class="applicant-tags" title="${escHtml(title)}">${flags}` +
    `${modes ? `<span class="tag-modes">${modes}</span>` : ''}` +
    `${travel ? `<span class="tag-travel">${travel}</span>` : ''}</span>`;
}


const SCORE_LABELS = {
  travel:   'Travel',
  age:      'Baby age',
  language: 'Language',
};

const SCORE_HINTS = {
  travel:   "Worst single journey in the group, against that member's own travel limit",
  age:      'How tightly the babies cluster in age, against the configured max age gap',
  language: 'How much of the members\u2019 shared languages is common to everyone',
};

function pct(n) {
  return Math.round(n * 100);
}

// The score breakdown is shown so the coordinator can see why a group ranked
// where it did — a weak group with one bad dimension reads very differently
// from one that is mediocre across the board.
function scorePanel(score) {
  if (!score) return '';
  const bar = (key) => {
    const value = pct(score[key]);
    const weight = MatchingEngine.SCORE_WEIGHTS[key];
    return `
      <div class="score-row">
        <span class="score-label" title="${escHtml(SCORE_HINTS[key])}">${escHtml(SCORE_LABELS[key])}</span>
        <span class="score-track" role="img" aria-label="${escHtml(SCORE_LABELS[key])}: ${value} percent, weighted ${weight}">
          <span class="score-fill score-fill-${escHtml(key)}" style="width:${value}%"></span>
        </span>
        <span class="score-value">${value}%</span>
      </div>`;
  };
  return `
    <div class="score-panel">
      ${['travel', 'age', 'language'].map(bar).join('')}
    </div>`;
}

// Says plainly where the travel times came from. Without this a run against a
// dead routing API looks exactly like a healthy one.
function travelSourceNote() {
  const s = state.travelTimeStats;
  if (!s || !s.total) return '';
  if (s.estimated === 0 && !s.rejected) {
    return `<div class="source-note source-note-ok">Travel times: all ${s.routed} journeys routed via HSL/Digitransit.</div>`;
  }
  const pct = Math.round((s.estimated / s.total) * 100);
  // Rejected journeys are called out separately: a routing service returning
  // impossible numbers is a different problem from one being unreachable.
  const bad = s.rejected
    ? ` ${s.rejected} routed ${s.rejected === 1 ? 'journey was' : 'journeys were'} discarded as impossible for the distance.`
    : '';
  const why = state.travelTimeError ? ` Last problem: ${escHtml(state.travelTimeError)}` : '';
  return `<div class="source-note source-note-warn">Travel times: ${s.routed} of ${s.total} journeys routed via HSL/Digitransit; ${s.estimated} (${pct}%) fell back to straight-line estimates, which are less accurate.${bad}${why}</div>`;
}

function renderCandidateCards() {
  const container = document.getElementById('candidateCards');
  container.innerHTML = travelSourceNote();
  if (state.candidateGroups.length === 0) {
    container.innerHTML += `<div class="empty-state">No candidate groups yet. Adjust the filters above and click "Run matching."</div>`;
    return;
  }
  state.candidateGroups.forEach((candidateGroup, rank) => {
    const members = candidateGroup.memberIds.map(getApplicant);
    const color   = candidateColor(candidateGroup.candidateId);
    const score   = candidateGroup.score;
    const card    = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title"><span class="rank-badge">#${rank + 1}</span>${escHtml(candidateGroup.name)}</span>
        ${score
          ? `<span class="badge badge-score" title="Weighted match score — higher is a stronger group">${pct(score.total)}% match</span>`
          : `<span class="badge badge-pending">pending</span>`}
      </div>
      ${scorePanel(score)}
      <div class="mini-card-list">${members.map((m) => applicantCard(m, color)).join('')}</div>
      <div class="card-actions">
        <button data-action="approve" data-id="${escHtml(candidateGroup.candidateId)}">Approve</button>
        <button data-action="reject"  data-id="${escHtml(candidateGroup.candidateId)}">Reject</button>
        <button data-action="overlap" data-id="${escHtml(candidateGroup.candidateId)}">Suggest where to meet</button>
      </div>
      <div class="meeting-list" data-meeting-for="${escHtml(candidateGroup.candidateId)}" hidden></div>`;
    container.appendChild(card);
  });

  attachApplicantDetailToggles(container);

  // A group whose suggestions are open stays open across a re-render. The
  // results are already cached, so this costs nothing and avoids the list
  // disappearing whenever anything else on the page changes.
  if (state.overlapVisibleFor) {
    const shown = state.candidateGroups.find((c) => c.candidateId === state.overlapVisibleFor);
    if (shown) {
      const members = shown.memberIds.map(getApplicant).filter((m) => m.coords && m.transport.length);
      const cached = meetingCache.get(meetingCacheKey(members));
      if (cached) renderMeetingList(state.overlapVisibleFor, cached, members);
    }
  }

  container.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'approve') { btn.disabled = true; await approveGroup(id); btn.disabled = false; }
      if (btn.dataset.action === 'reject')   rejectGroup(id);
      if (btn.dataset.action === 'overlap') {
        const opening = state.overlapVisibleFor !== id;
        state.overlapVisibleFor = opening ? id : null;
        // Finding places takes a few seconds on a cold group, so the button
        // says what it is doing rather than looking like it ignored the click.
        if (opening) { btn.disabled = true; btn.textContent = 'Looking\u2026'; }
        try {
          await drawOverlap(state.overlapVisibleFor);
        } finally {
          btn.disabled = false;
          btn.textContent = state.overlapVisibleFor === id ? 'Hide meeting places' : 'Suggest where to meet';
        }
      }
    });
  });
}

function renderUnmatchedList() {
  const container = document.getElementById('unmatchedList');
  const unmatched = state.applicants.filter((a) => a.matchStatus === 'unmatched' && !a.hasDataIssues && !hasVillage(a));

  container.innerHTML = unmatched.length
    ? unmatched.map((a) => applicantCard(a)).join('')
    : `<div class="empty-state">Everyone currently in the pool is either matched or pending approval.</div>`;

  attachApplicantDetailToggles(container);
}

function hasVillage(a) {
  return a.village !== null && a.village !== undefined && String(a.village).trim() !== '';
}

function applicantCard(a, mapColor) {
  const detailRow = (label, value) => value || value === 0
    ? `<div><strong>${label}</strong><span>${escHtml(value)}</span></div>`
    : '';
  // wa.me takes digits only, no '+'. A row that failed phone validation is
  // still shown, but as plain text rather than a link that can't work.
  const phoneRow = () => {
    if (!a.phone) return '';
    const digits = a.phone.replace(/[^\d]/g, '');
    const shown  = escHtml(a.phone);
    const body   = digits
      ? `<a href="https://wa.me/${digits}" rel="noopener noreferrer" target="_blank">${shown}</a>`
      : shown;
    return `<div><strong>Phone</strong><span>${body}</span></div>`;
  };
  const mapDot = mapColor
    ? `<span class="participant-map-dot" style="background:${escHtml(mapColor)}; border-color:${escHtml(mapColor)}" aria-label="Map dot color"></span>`
    : '';

  // An expecting mother's date is a due date, not a birthday. Worth saying so
  // on the row: it changes how the coordinator writes to her, and whether the
  // group she lands in is one of newborns or one still waiting.
  const expectingBadge = a.expecting ? ' <span class="badge badge-expecting">expecting</span>' : '';

  // Only offer "show on map" to someone who actually has a pin; a disabled
  // control on an un-geocoded row would just be a dead end.
  const locatable = a.geocodedReal && a.coords;
  const locateBtn = locatable
    ? `<button class="locate-btn" type="button" data-locate="${escHtml(a.id)}" title="Show on map">📍</button>`
    : '';

  // The name, not the identity number. An organizer thinks in names, and the
  // number told her nothing usable while scanning a list. It is still in the
  // details, and still on the row as a data attribute for the map.
  return `
    <div class="mini-card unmatched-card applicant-card${locatable ? ' locatable' : ''}" data-applicant-id="${escHtml(a.id)}">
      <div class="unmatched-summary">
        <span class="participant-id-wrap">${mapDot}<button class="id-toggle" type="button" aria-expanded="false">${escHtml(a.name || a.id)}</button>${expectingBadge}</span>
        <span class="applicant-summary-line">${applicantTags(a)}<span class="applicant-address">${escHtml(a.street)}, ${escHtml(a.neighborhood)}</span></span>
        <span class="applicant-locate">${a.geocodedReal && a.coords ? escHtml(a.coords) : '<em>no location</em>'}${locateBtn}</span>
      </div>
      <div class="applicant-details" hidden>
        ${detailRow('Identity number', a.id)}
        ${detailRow('Name', a.name)}
        ${phoneRow()}
        ${detailRow(a.expecting ? 'Due' : 'Baby DOB', MatchingEngine.formatMonthYear(a.dob))}
        ${detailRow('Languages', a.language.join(', '))}
        ${detailRow('Transport', `${a.transport.join('')} ${a.maxTravel}`)}
        ${detailRow('Address', `${a.street}, ${a.neighborhood}`)}
        ${detailRow('Children', a.amountOfChildren)}
        ${detailRow('Older sibling', a.olderSiblingBirthMonth)}
        ${detailRow('Hopes', a.hopes)}
        ${detailRow('Worries', a.worries)}
        ${detailRow('Questions', a.questions)}
        ${detailRow('Source', a.source)}
        ${detailRow('My notes', a.myNotes)}
        ${detailRow('Status', a.status)}
      </div>
    </div>`;
}

function attachApplicantDetailToggles(container) {
  container.querySelectorAll('.id-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const details = btn.closest('.applicant-card').querySelector('.applicant-details');
      const isOpen  = !details.hidden;
      details.hidden = isOpen;
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  // Clicking a person anywhere on their row locates them on the map. The
  // explicit pin button is there for discoverability; the whole-row handler is
  // what the organizer actually reaches for. Buttons and links inside the row
  // keep their own behaviour, so expanding details or opening WhatsApp still
  // works.
  container.querySelectorAll('.applicant-card.locatable').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      if (event.target.closest('button') && !event.target.closest('.locate-btn')) return;
      selectApplicantOnMap(card.dataset.applicantId);
    });
  });
}

// Keeps the map selection and the list selection in step, so it is obvious
// which row the ringed dot belongs to.
function selectApplicantOnMap(applicantId) {
  if (!applicantId) return;
  document.querySelectorAll('.applicant-card.selected')
    .forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll(`.applicant-card[data-applicant-id="${cssEscape(applicantId)}"]`)
    .forEach((el) => el.classList.add('selected'));
  focusApplicantOnMap(applicantId);
}

// Applicant ids come from a hand-edited sheet, so they can contain anything.
function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function renderActiveGroups() {
  const container      = document.getElementById('activeGroups');
  const reviewContainer = document.getElementById('needsReview');

  const declined = state.applicants.filter((a) => a.matchStatus === 'declined');
  reviewContainer.style.display = declined.length ? 'block' : 'none';
  reviewContainer.innerHTML = declined.length
    ? `<div class="review-title">Needs review</div>` +
      declined.map((a) => {
        const groupName = escHtml(state.groups.find((g) => g.id === a.matchGroupId)?.name || 'no group');
        return `<div class="mini-card review-item"><span>${escHtml(a.name)} declined · was in ${groupName}</span><button data-action="reset" data-id="${escHtml(a.id)}">Reset to unmatched</button></div>`;
      }).join('')
    : '';

  container.innerHTML = '';
  const applicantsByVillage = state.applicants.reduce((byVillage, a) => {
    if (!hasVillage(a)) return byVillage;
    const village = String(a.village).trim();
    if (!byVillage.has(village)) byVillage.set(village, []);
    byVillage.get(village).push(a);
    return byVillage;
  }, new Map());
  const villages = [...applicantsByVillage.entries()].sort(([a], [b]) => a.localeCompare(b));

  if (villages.length === 0) {
    container.innerHTML = `<div class="empty-state">No active groups yet.</div>`;
    attachApplicantDetailToggles(container);
    return;
  }
  villages.forEach(([village, members]) => {
    const el      = document.createElement('div');
    el.className  = 'card';
    el.innerHTML = `
      <div class="card-header">
        <span class="card-title">${escHtml(village)} · ${members.length} moms</span>
      </div>
      <div class="mini-card-list">${members.map((m) => applicantCard(m)).join('')}</div>`;
    container.appendChild(el);
  });

  attachApplicantDetailToggles(container);

  reviewContainer.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => markStatus(btn.dataset.id, 'unmatched'));
  });
}

function renderDataIssues() {
  const container = document.getElementById('dataIssuesList');
  // A row can be perfectly valid in the sheet but still un-geocodable, and
  // that keeps it out of matching just as effectively, so both belong here.
  const flagged = state.applicants
    .map((a) => ({ a, issues: [...(a.hasDataIssues ? a.dataIssues : []), ...(a.geocodeIssue ? [a.geocodeIssue] : [])] }))
    .filter((r) => r.issues.length > 0);

  // Placed, but not exactly where the sheet said. These are on the map and in
  // the matching pool, so they are listed apart from the blocking issues;
  // lumping them together would make the blocking list look longer than the
  // number of people actually missing from the map.
  const warned = state.applicants.filter((a) => !a.hasDataIssues && a.geocodedReal && a.geocodeWarning);

  const blocking = flagged.length
    ? flagged.map(({ a, issues }) => `<div class="mini-card issue-card" data-applicant-id="${escHtml(a.id)}"><span><strong>${escHtml(a.name)}</strong> (${escHtml(a.id)}): ${issues.map(escHtml).join('; ')}</span></div>`).join('')
    : `<div class="empty-state">No data issues found in the current sheet.</div>`;

  const approximate = warned.length
    ? `<div class="issue-subhead">On the map, but worth checking (${warned.length})</div>` +
      warned.map((a) => `<div class="mini-card warning-card applicant-card locatable" data-applicant-id="${escHtml(a.id)}"><span><strong>${escHtml(a.name)}</strong> (${escHtml(a.id)}): ${escHtml(a.geocodeWarning)}</span></div>`).join('')
    : '';

  container.innerHTML = blocking + approximate;
  attachApplicantDetailToggles(container);
}

function renderSettingsTab() {
  document.getElementById('templateFirstContact').value = state.templates.firstContact;
  document.getElementById('templateConfirmation').value = state.templates.confirmationAsk;
  document.getElementById('templateIntroduction').value = state.templates.introduction;
  document.getElementById('settingMaxAgeGap').value     = state.settings.maxAgeGap;
  document.getElementById('settingMinSize').value       = state.settings.minGroupSize;
  document.getElementById('settingMaxSize').value       = state.settings.maxGroupSize;
}

function populateNeighborhoodFilter() {
  const select        = document.getElementById('neighborhoodFilter');
  const neighborhoods = [...new Set(state.applicants.filter((a) => !a.hasDataIssues).map((a) => a.neighborhood))];
  select.innerHTML =
    `<option value="all">All neighborhoods</option>` +
    neighborhoods.map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
}

function renderAll() {
  renderMap();
  renderCandidateCards();
  renderUnmatchedList();
  renderDataIssues();
  renderActiveGroups();
}

// ---------------------------------------------------------------------------
// Password gate
// ---------------------------------------------------------------------------

function showPasswordGate(message) {
  const gate  = document.getElementById('passwordGate');
  const error = document.getElementById('passwordError');
  gate.hidden = false;
  document.getElementById('passwordInput').value = '';
  if (message) { error.textContent = message; error.hidden = false; }
  else          { error.hidden = true; }
  document.getElementById('passwordInput').focus();
}

function hidePasswordGate() {
  document.getElementById('passwordGate').hidden = true;
}

async function attemptUnlock() {
  const input  = document.getElementById('passwordInput');
  const error  = document.getElementById('passwordError');
  const btn    = document.getElementById('passwordSubmitBtn');
  const pw     = input.value;

  btn.disabled    = true;
  btn.textContent = 'Checking…';
  error.hidden    = true;

  // Temporarily store the candidate password so callBackend can send it
  setPassword(pw);

  try {
    await callBackend('ping', {});
    hidePasswordGate();
    await loadFromBackend();
    populateNeighborhoodFilter();
    renderSettingsTab();
    renderAll();
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') localStorage.removeItem(PASSWORD_KEY);
    error.textContent = err.code === 'UNAUTHORIZED'
      ? 'Incorrect password — try again.'
      : 'Cannot connect to server. Check your internet connection.';
    error.hidden = false;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Unlock';
  }
}

// ---------------------------------------------------------------------------
// Tab + control wiring
// ---------------------------------------------------------------------------

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-panel').forEach((el) => el.classList.toggle('active', el.id === tabId));
  document.querySelectorAll('.tab-btn').forEach((el)   => el.classList.toggle('active', el.dataset.tab === tabId));
  if (tabId === 'new-matches') setTimeout(() => map.invalidateSize(), 50);
}

function wireControls() {
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  document.getElementById('ageGapSlider').addEventListener('input', (e) => {
    state.settings.maxAgeGap = Number(e.target.value);
    document.getElementById('ageGapOut').textContent = `${e.target.value} months`;
  });
  document.getElementById('neighborhoodFilter').addEventListener('change', (e) => {
    state.settings.neighborhoodFilter = e.target.value;
  });
  document.getElementById('runMatchingBtn').addEventListener('click', async () => {
    const btn = document.getElementById('runMatchingBtn');
    btn.disabled = true; btn.textContent = 'Calculating…';
    try {
      state.candidateGroups = await computeCandidateGroups();
    } catch (err) {
      alert('Matching couldn\'t complete: ' + err.message);
    }
    state.overlapVisibleFor = null;
    overlapLayer.clearLayers();
    renderAll();
    btn.disabled = false; btn.textContent = '▶ Run matching';
  });

  document.getElementById('minGroupSizeInput').addEventListener('change', (e) => {
    const val = Math.min(Number(e.target.value), state.settings.maxGroupSize);
    e.target.value = val; state.settings.minGroupSize = val;
  });
  document.getElementById('maxGroupSizeInput').addEventListener('change', (e) => {
    const val = Math.max(Number(e.target.value), state.settings.minGroupSize);
    e.target.value = val; state.settings.maxGroupSize = val;
  });

  document.getElementById('templateFirstContact').addEventListener('input', (e) => (state.templates.firstContact   = e.target.value));
  document.getElementById('templateConfirmation').addEventListener('input', (e) => (state.templates.confirmationAsk = e.target.value));
  document.getElementById('templateIntroduction').addEventListener('input', (e) => (state.templates.introduction    = e.target.value));
  ['templateFirstContact', 'templateConfirmation', 'templateIntroduction'].forEach((id) => {
    document.getElementById(id).addEventListener('blur', () => syncToBackend('saveTemplates', { templates: state.templates }));
  });

  document.getElementById('settingMaxAgeGap').addEventListener('change', (e) => {
    state.settings.maxAgeGap = Number(e.target.value);
    document.getElementById('ageGapSlider').value = e.target.value;
    document.getElementById('ageGapOut').textContent = `${e.target.value} months`;
    syncToBackend('saveSettings', { settings: { maxAgeGap: state.settings.maxAgeGap } });
  });
  document.getElementById('settingMinSize').addEventListener('change', (e) => {
    const val = Math.min(Number(e.target.value), state.settings.maxGroupSize);
    e.target.value = val; state.settings.minGroupSize = val;
    document.getElementById('minGroupSizeInput').value = val;
    syncToBackend('saveSettings', { settings: { minGroupSize: val } });
  });
  document.getElementById('settingMaxSize').addEventListener('change', (e) => {
    const val = Math.max(Number(e.target.value), state.settings.minGroupSize);
    e.target.value = val; state.settings.maxGroupSize = val;
    document.getElementById('maxGroupSizeInput').value = val;
    syncToBackend('saveSettings', { settings: { maxGroupSize: val } });
  });

  document.getElementById('testBackendBtn').addEventListener('click', async () => {
    const status = document.getElementById('backendStatus');
    status.textContent = 'Testing…';
    try {
      const result = await callBackend('ping', {});
      status.textContent = `✓ Connected — sheet tab: ${result.sourceTab || '?'}, server time: ${result.time}`;
    } catch (err) {
      status.textContent = '✗ ' + err.message;
    }
  });

  document.getElementById('syncBtn').addEventListener('click', async () => {
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    const success = await loadFromBackend();
    // An explicit sync may bring in a different set of people entirely (a
    // second city, or addresses just fixed in the sheet), so re-frame the map
    // around whatever is there now instead of keeping the previous view.
    mapFramed = false;
    populateNeighborhoodFilter();
    renderSettingsTab();
    renderAll();
    btn.disabled = false;
    btn.textContent = SYNC_BTN_LABEL;
    if (!success) alert('Sync failed — check your connection and try again.');
  });

  // Password gate submit (button click + Enter key)
  document.getElementById('passwordSubmitBtn').addEventListener('click', attemptUnlock);
  document.getElementById('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptUnlock();
  });
}

async function init() {
  // Before anything reads the cache, so a coordinate cached by an older
  // version of the geocoder can never reach the map.
  pruneStaleGeocodeCache();
  initMap();
  wireControls();

  const stored = getPassword();
  if (!stored) {
    showPasswordGate();
    return;
  }

  // Verify stored password is still valid
  try {
    await callBackend('ping', {});
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      localStorage.removeItem(PASSWORD_KEY);
      showPasswordGate('Password has changed — please re-enter.');
      return;
    }
    // Network error: proceed anyway, user will see errors on sync
  }

  await loadFromBackend();
  populateNeighborhoodFilter();
  renderSettingsTab();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
