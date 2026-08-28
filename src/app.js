// Village Matcher — browser UI
//
// Talks to the Netlify Function at /.netlify/functions/api for all
// backend operations (Google Sheets read/write, geocoding, travel time,
// isochrones). A password stored in localStorage is sent as
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

// Fire-and-forget backend write. Local state is updated immediately so the
// UI never waits on a network round trip.
function syncToBackend(action, payload) {
  callBackend(action, payload).catch((err) => {
    if (err.code === 'UNAUTHORIZED') { showPasswordGate('Session expired — please re-enter the password.'); return; }
    console.warn(`Backend sync failed (${action}):`, err.message);
  });
}

async function loadFromBackend() {
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
        coords:       prev?.geocodedReal ? prev.coords : [60.1699 + (Math.random() - 0.5) * 0.05, 24.9384 + (Math.random() - 0.5) * 0.1],
        geocodedReal: prev?.geocodedReal || false,
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
};

// ---------------------------------------------------------------------------
// Travel time: cache + backend, falling back to MatchingEngine estimates
// ---------------------------------------------------------------------------

function travelCacheKey(idA, idB, mode) {
  const [x, y] = [idA, idB].sort();
  return `travel:${x}:${y}:${mode}`;
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
    const cacheKey = 'geocode:' + a.street + ', ' + a.neighborhood;
    const cached   = cacheGet(cacheKey);
    if (cached && typeof cached.lat === 'number') {
      a.coords      = [cached.lat, cached.lon];
      a.geocodedReal = true;
    } else {
      toFetch.push(a);
    }
  });
  if (toFetch.length === 0) return;

  try {
    const addresses = toFetch.map((a) => `${a.street}, ${a.neighborhood}, Finland`);
    const results   = await callBackend('geocode', { addresses });
    results.forEach((r, i) => {
      const a = toFetch[i];
      if (typeof r.lat === 'number') {
        a.coords      = [r.lat, r.lon];
        a.geocodedReal = true;
        cacheSet('geocode:' + a.street + ', ' + a.neighborhood, r);
      }
    });
  } catch (err) {
    console.warn('Geocoding failed, using approximate coordinates:', err.message);
  }
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

  try {
    const results = await callBackend('travelTime', { pairs: toFetch });
    results.forEach((r) => {
      if (typeof r.minutes === 'number') cacheSet(r.id, { minutes: r.minutes });
    });
  } catch (err) {
    console.warn('Travel-time backend call failed, falling back to estimates:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Matching engine orchestration
// ---------------------------------------------------------------------------

async function computeCandidateGroups() {
  const pool = state.applicants.filter(
    (a) =>
      a.matchStatus === 'unmatched' &&
      a.eligibleForMatching &&
      (state.settings.neighborhoodFilter === 'all' || a.neighborhood === state.settings.neighborhoodFilter)
  );

  const pairsNeeded = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      const distanceKm = MatchingEngine.haversineKm(a.coords, b.coords);
      const modesA = a.transport.filter((mode) => {
        const model = MatchingEngine.MODE_MODEL[mode];
        return model && distanceKm <= (a.maxTravel / 60) * model.speedKmh * 1.5;
      });
      const modesB = b.transport.filter((mode) => {
        const model = MatchingEngine.MODE_MODEL[mode];
        return model && distanceKm <= (b.maxTravel / 60) * model.speedKmh * 1.5;
      });
      if (modesA.length === 0 || modesB.length === 0) continue;
      modesA.forEach((mode) => pairsNeeded.push({ a, b, mode }));
      modesB.forEach((mode) => pairsNeeded.push({ a: b, b: a, mode }));
    }
  }
  await ensureTravelTimes(pairsNeeded);

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

let map, overlapLayer, pinLayer;

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView([60.185, 24.93], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
  overlapLayer = L.layerGroup().addTo(map);
  pinLayer     = L.layerGroup().addTo(map);
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

function renderMap() {
  pinLayer.clearLayers();
  state.applicants
    .filter((a) => !a.hasDataIssues)
    .forEach((a) => {
      const groupColor = colorForGroup(a.matchGroupId) || applicantCandidateColor(a.id);
      const isMatched  = !!groupColor;
      const marker = L.circleMarker(a.coords, {
        radius: 9, color: isMatched ? groupColor : '#8A8577', weight: 2,
        fillColor: isMatched ? groupColor : '#FAF9F6',
        fillOpacity: isMatched ? 0.9 : 0.5, dashArray: isMatched ? null : '3,2',
      }).addTo(pinLayer);

      const groupName = a.matchGroupId
        ? escHtml(state.groups.find((g) => g.id === a.matchGroupId)?.name ?? '')
        : '';
      marker.bindPopup(
        `<strong>${escHtml(a.id)}</strong><br/>`+
        `${escHtml(a.name)}<br/>`+
        `${escHtml(a.street + ", " + a.neighborhood)}<br>` +
        `${a.language.map(escHtml).join(', ')}<br>` +
        `${a.transport.map(escHtml).join('')} ${a.maxTravel}<br>` +
        `${a.matchGroupId ? 'Group: ' + groupName : 'Status: ' + escHtml(a.matchStatus)}`
      );
    });
}

async function drawOverlap(candidateId) {
  overlapLayer.clearLayers();
  if (!candidateId) return;
  const cand = state.candidateGroups.find((c) => c.candidateId === candidateId);
  if (!cand) return;
  const members = cand.memberIds.map(getApplicant);
  const color   = candidateColor(candidateId);

  // Isochrones need a mode every member shares. Prefer driving over walking
  // because it yields the larger, more useful overlap area.
  const commonModes = members.reduce((acc, m) => acc.filter((mode) => m.transport.includes(mode)), ['D', 'W']);
  const mode        = commonModes.includes('D') ? 'D' : commonModes.includes('W') ? 'W' : null;

  if (mode && members.length <= 5) {
    try {
      const minutes   = Math.min(...members.map((m) => m.maxTravel));
      const locations = members.map((m) => ({ lat: m.coords[0], lon: m.coords[1] }));
      const geojson   = await callBackend('isochrone', { locations, mode, minutes });
      L.geoJSON(geojson, { style: { color, weight: 1, fillColor: color, fillOpacity: 0.15 } }).addTo(overlapLayer);
      return;
    } catch (err) {
      console.warn('Isochrone call failed, falling back to radius circles:', err.message);
    }
  }

  members.forEach((a) => {
    const bestSpeed = Math.max(...a.transport.map((m) => MatchingEngine.MODE_MODEL[m].speedKmh));
    const radiusKm  = (a.maxTravel / 60) * bestSpeed;
    L.circle(a.coords, { radius: radiusKm * 1000, color, weight: 1, fillColor: color, fillOpacity: 0.12 }).addTo(overlapLayer);
  });
}

const FLAG_MAP = { English: '🇬🇧', Finnish: '🇫🇮', Swedish: '🇸🇪', Russian: '🇷🇺', Arabic: '🇸🇦', French: '🇫🇷', Swahili: '🇰🇪' };
const MODE_ICON = { W: '🚶', D: '🚙', P: '🚌', B: '🚲' };

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

function renderCandidateCards() {
  const container = document.getElementById('candidateCards');
  container.innerHTML = '';
  if (state.candidateGroups.length === 0) {
    container.innerHTML = `<div class="empty-state">No candidate groups yet. Adjust the filters above and click "Run matching."</div>`;
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
        <button data-action="overlap" data-id="${escHtml(candidateGroup.candidateId)}">View overlap on map</button>
      </div>`;
    container.appendChild(card);
  });

  attachApplicantDetailToggles(container);

  container.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'approve') { btn.disabled = true; await approveGroup(id); btn.disabled = false; }
      if (btn.dataset.action === 'reject')   rejectGroup(id);
      if (btn.dataset.action === 'overlap') {
        state.overlapVisibleFor = state.overlapVisibleFor === id ? null : id;
        await drawOverlap(state.overlapVisibleFor);
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

  return `
    <div class="mini-card unmatched-card applicant-card">
      <div class="unmatched-summary">
        <span class="participant-id-wrap">${mapDot}<button class="id-toggle" type="button" aria-expanded="false">${escHtml(a.id)}</button></span>
        <span>${escHtml(a.name)} · ${escHtml(a.street)}, ${escHtml(a.neighborhood)}</span>
        <span>${escHtml(a.coords)}</span>
      </div>
      <div class="applicant-details" hidden>
        ${detailRow('Name', a.name)}
        ${phoneRow()}
        ${detailRow('Baby DOB', MatchingEngine.formatMonthYear(a.dob))}
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
  const flagged   = state.applicants.filter((a) => a.hasDataIssues);
  container.innerHTML = flagged.length
    ? flagged.map((a) => `<div class="mini-card issue-card"><span><strong>${escHtml(a.name)}</strong> (${escHtml(a.id)}) — ${a.dataIssues.map(escHtml).join('; ')}</span></div>`).join('')
    : `<div class="empty-state">No data issues found in the current sheet.</div>`;
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
    populateNeighborhoodFilter();
    renderSettingsTab();
    renderAll();
    btn.disabled = false;
    btn.textContent = '↻ Sync with Google Sheet';
    if (!success) alert('Sync failed — check your connection and try again.');
  });

  // Password gate submit (button click + Enter key)
  document.getElementById('passwordSubmitBtn').addEventListener('click', attemptUnlock);
  document.getElementById('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptUnlock();
  });
}

async function init() {
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
