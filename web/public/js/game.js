/* global L, pannellum */
/**
 * game.js — ProjectGuessr front-end.
 *
 * Responsibilities:
 *   - WebSocket protocol with the server (create/join/start/guess/next).
 *   - Render each round's 360 panorama with Pannellum (cubemap mode).
 *   - Show a Leaflet map of the world; convert clicks to Minecraft X/Z.
 *   - Show round results (true location + everyone's guesses) and scoreboards.
 */

const CFG = window.PG_CONFIG || {};

/* ------------------------------------------------------------------ *
 *  Cubemap face mapping
 *  ------------------------------------------------------------------
 *  Minecraft's vanilla panorama writes panorama_0..panorama_5:
 *    0..3 = the four horizontal directions, 4 = up (top), 5 = down (bottom).
 *  Pannellum's `cubeMap` array wants faces in the order:
 *    [ front, right, back, left, up, down ]
 *
 *  The default mapping below assumes MC 0=front,1=right,2=back,3=left,4=up,5=down.
 *  If your panoramas look rotated or the seams don't line up, this is the ONE
 *  thing to tweak: reorder the indices (horizontals) and/or the CSS rotations
 *  until a straight wall stays straight as you pan across a seam.
 * ------------------------------------------------------------------ */
const MC_FACE_FOR_PANNELLUM_SLOT = [0, 1, 2, 3, 4, 5];
// Per-face rotation in degrees, if the up/down faces come out spun. Order
// matches Pannellum slots [front, right, back, left, up, down].
const FACE_ROTATION = [0, 0, 0, 0, 0, 0];

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const state = {
  ws: null,
  clientId: null,
  code: null,
  isHost: false,
  mapMeta: null,
  players: [],
  pano: null,        // Pannellum viewer instance
  map: null,         // Leaflet map (guess)
  guessMarker: null,
  guessLatLng: null, // current pending guess in Leaflet coords
  resultMap: null,   // Leaflet map on the result overlay
  hasGuessed: false,
  links: null,       // navigation graph {folder: [{to, bearing, dist}]}
  startFolder: null, // where the round began — scoring is pinned here
  currentFolder: null, // panorama currently shown (may differ after roaming)
};

/* ------------------------------------------------------------------ *
 *  Screen helpers
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $(id).classList.add('active');
}

/* ------------------------------------------------------------------ *
 *  Coordinate conversion (Leaflet CRS.Simple <-> Minecraft world)
 *  ------------------------------------------------------------------
 *  We lay the map image on a CRS.Simple plane where Leaflet y grows downward.
 *  Image pixel (px, py) maps linearly to world (X, Z) using map-meta bounds.
 *  In Leaflet CRS.Simple we use latLng = [ -py, px ] so north (smaller Z) is up.
 * ------------------------------------------------------------------ */
function worldToLatLng(x, z) {
  const m = state.mapMeta;
  const px = ((x - m.worldMinX) / (m.worldMaxX - m.worldMinX)) * m.imageWidth;
  const py = ((z - m.worldMinZ) / (m.worldMaxZ - m.worldMinZ)) * m.imageHeight;
  return L.latLng(-py, px);
}
function latLngToWorld(latlng) {
  const m = state.mapMeta;
  const px = latlng.lng;
  const py = -latlng.lat;
  const x = m.worldMinX + (px / m.imageWidth) * (m.worldMaxX - m.worldMinX);
  const z = m.worldMinZ + (py / m.imageHeight) * (m.worldMaxZ - m.worldMinZ);
  return { x, z };
}

/* ------------------------------------------------------------------ *
 *  WebSocket
 * ------------------------------------------------------------------ */
function connect() {
  const url = CFG.WS_URL || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => { $('lobbyError').textContent = 'Disconnected from server.'; };
  return ws;
}
function sendWS(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handle(msg) {
  switch (msg.t) {
    case 'joined':
      state.clientId = msg.clientId;
      state.code = msg.code;
      state.isHost = msg.isHost;
      state.mapMeta = msg.mapMeta;
      $('roomCode').textContent = msg.code;
      showScreen('room');
      break;
    case 'lobby':
      state.players = msg.players;
      state.isHost = msg.hostId === state.clientId;
      renderPlayers(msg.players, msg.hostId);
      $('startBtn').classList.toggle('hidden', !state.isHost);
      $('waitMsg').classList.toggle('hidden', state.isHost);
      break;
    case 'round':
      startRound(msg);
      break;
    case 'guessed':
      $('guessStatus').textContent = `Locked in: ${msg.count} / ${msg.total}`;
      break;
    case 'roundresult':
      showRoundResult(msg);
      break;
    case 'scoreboard':
      // Kept for future live scoreboard; results table already shows totals.
      break;
    case 'finished':
      showFinal(msg.board);
      break;
    case 'error':
      $('lobbyError').textContent = msg.message;
      break;
  }
}

/* ------------------------------------------------------------------ *
 *  Lobby / room
 * ------------------------------------------------------------------ */
function renderPlayers(players, hostId) {
  const ul = $('playerList');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const you = p.clientId === state.clientId ? ' (you)' : '';
    li.innerHTML = `<span class="${p.clientId === state.clientId ? 'you' : ''}">${escapeHtml(p.name)}${you}</span>` +
      (p.clientId === hostId ? '<span class="host-badge">HOST</span>' : '');
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------ *
 *  Panorama + guess map per round
 * ------------------------------------------------------------------ */
function panoUrls(folder) {
  const base = `${CFG.PANO_BASE_URL || '/panoramas'}/${folder}`;
  const ext = CFG.PANO_FACE_EXT || 'png';
  // Build the Pannellum cubeMap array from the MC face mapping.
  return MC_FACE_FOR_PANNELLUM_SLOT.map((mcIndex) => `${base}/panorama_${mcIndex}.${ext}`);
}

function startRound(msg) {
  showScreen('game');
  $('resultOverlay').classList.add('hidden');
  $('finalOverlay').classList.add('hidden');
  $('roundInfo').textContent = `Round ${msg.index + 1} / ${msg.total}`;
  $('guessStatus').textContent = '';
  state.hasGuessed = false;
  state.guessLatLng = null;

  // Scoring is pinned to where the round starts; roaming never moves this.
  state.startFolder = msg.folder;
  loadPanorama(msg.folder, { freshView: true });

  // ---- Guess map (recreate each round) ----
  buildGuessMap();
  $('guessBtn').disabled = true;
  $('guessBtn').textContent = 'Place a pin to guess';
}

/* ------------------------------------------------------------------ *
 *  Panorama viewer + Street-View movement arrows
 *  ------------------------------------------------------------------
 *  The viewer is (re)built whenever we show a panorama — both at round start
 *  and each time the player roams to a neighbour. Arrows are Pannellum
 *  hotspots placed at the bearing to each neighbour (from links.json), pinned
 *  near the horizon. Clicking one loads that neighbour. Scoring is unaffected:
 *  the server only ever sees the guess coords, and the "actual" location it
 *  scores against is the round's start panorama.
 * ------------------------------------------------------------------ */
function neighboursFor(folder) {
  if (!CFG.ENABLE_MOVEMENT || !state.links) return [];
  return state.links[folder] || [];
}

function loadPanorama(folder, { freshView = false } = {}) {
  state.currentFolder = folder;

  // Carry the current look direction across a move so roaming feels continuous
  // (like stepping forward in Street View rather than being re-aimed north).
  // A new round passes freshView so it starts from the default orientation.
  let view = null;
  if (state.pano) {
    if (!freshView) {
      view = {
        yaw: state.pano.getYaw(),
        pitch: state.pano.getPitch(),
        hfov: state.pano.getHfov(),
      };
    }
    state.pano.destroy();
    state.pano = null;
  }
  $('panorama').innerHTML = '';

  const yawOffset = CFG.PANO_YAW_OFFSET || 0;
  const hotSpots = neighboursFor(folder).map((n) => ({
    // Pannellum yaw: 0 = front face, positive clockwise. Our bearing is
    // clockwise from +Z; the single offset aligns the two coordinate frames.
    yaw: ((n.bearing + yawOffset + 180) % 360) - 180,
    pitch: -12,
    cssClass: 'pg-arrow',
    createTooltipFunc: makeArrow,
    createTooltipArgs: { to: n.to, dist: n.dist },
    clickHandlerFunc: () => loadPanorama(n.to),
  }));

  const opts = {
    type: 'cubemap',
    cubeMap: panoUrls(folder),
    autoLoad: true,
    showControls: true,
    hfov: view ? view.hfov : 100,
    hotSpots,
  };
  // Restore the previous view when roaming; use defaults on a fresh round.
  if (view) {
    opts.yaw = view.yaw;
    opts.pitch = view.pitch;
  }
  state.pano = pannellum.viewer('panorama', opts);

  // Show a small "you've moved" hint when off the start panorama.
  const moved = folder !== state.startFolder;
  $('roamHint').classList.toggle('hidden', !moved);
}

// Builds the arrow element for a hotspot. Pannellum calls this with the
// hotSpotDiv and our createTooltipArgs.
function makeArrow(hotSpotDiv, args) {
  hotSpotDiv.classList.add('pg-arrow');
  const chevron = document.createElement('div');
  chevron.className = 'pg-arrow-chevron';
  chevron.innerHTML = '&#10132;'; // heavy arrow glyph, rotated by CSS to point "up"
  hotSpotDiv.appendChild(chevron);
  hotSpotDiv.title = `Walk here (${args.dist} blk)`;
}

function makeWorldMap(elementId) {
  const m = state.mapMeta;
  const map = L.map(elementId, {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 2,
    attributionControl: false,
    zoomControl: true,
  });
  // Image bounds in CRS.Simple coords: y is negated so north is up.
  const bounds = [[0, 0], [-m.imageHeight, m.imageWidth]];
  L.imageOverlay(CFG.MAP_IMAGE_URL || '/map/map.png', bounds).addTo(map);
  map.fitBounds(bounds);
  return map;
}

function buildGuessMap() {
  if (state.map) { state.map.remove(); state.map = null; }
  $('map').innerHTML = '';
  const map = makeWorldMap('map');
  state.map = map;
  state.guessMarker = null;

  map.on('click', (e) => {
    if (state.hasGuessed) return;
    state.guessLatLng = e.latlng;
    if (state.guessMarker) {
      state.guessMarker.setLatLng(e.latlng);
    } else {
      state.guessMarker = L.circleMarker(e.latlng, {
        radius: 7, color: '#fff', weight: 2, fillColor: '#55c157', fillOpacity: 1,
        className: 'guess-pin',
      }).addTo(map);
    }
    const w = latLngToWorld(e.latlng);
    $('guessBtn').disabled = false;
    $('guessBtn').textContent = `Guess (X ${Math.round(w.x)}, Z ${Math.round(w.z)})`;
  });
  // Leaflet needs a size recalculation once its container is visible.
  setTimeout(() => map.invalidateSize(), 50);
}

function submitGuess() {
  if (!state.guessLatLng || state.hasGuessed) return;
  const w = latLngToWorld(state.guessLatLng);
  sendWS({ t: 'guess', x: w.x, z: w.z });
  state.hasGuessed = true;
  $('guessBtn').disabled = true;
  $('guessBtn').textContent = 'Guess locked in';
}

/* ------------------------------------------------------------------ *
 *  Round result overlay
 * ------------------------------------------------------------------ */
function showRoundResult(msg) {
  $('resultOverlay').classList.remove('hidden');
  $('resultTitle').textContent = `Round ${msg.index + 1} / ${msg.total} — results`;

  // Mini map showing the true location + each player's guess.
  if (state.resultMap) { state.resultMap.remove(); state.resultMap = null; }
  $('resultMiniMap').innerHTML = '';
  const map = makeWorldMap('resultMiniMap');
  state.resultMap = map;

  const truthLL = worldToLatLng(msg.truth.x, msg.truth.z);
  L.circleMarker(truthLL, { radius: 9, color: '#000', weight: 2, fillColor: '#ffd23f', fillOpacity: 1 })
    .addTo(map).bindTooltip('Actual', { permanent: true, direction: 'top' });

  for (const r of msg.results) {
    if (!r.guess) continue;
    const gll = worldToLatLng(r.guess.x, r.guess.z);
    const mine = r.clientId === state.clientId;
    L.circleMarker(gll, {
      radius: 6, color: '#fff', weight: 2,
      fillColor: mine ? '#55c157' : '#4a90d9', fillOpacity: 1,
    }).addTo(map).bindTooltip(r.name, { direction: 'top' });
    L.polyline([truthLL, gll], { color: mine ? '#55c157' : '#4a90d9', weight: 1, dashArray: '4' }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 50);

  // Results table sorted by round score.
  const rows = msg.results.slice().sort((a, b) => b.score - a.score);
  const t = $('resultTable');
  t.innerHTML = '<tr><th>Player</th><th class="num">Distance</th><th class="num">Round</th><th class="num">Total</th></tr>';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const mine = r.clientId === state.clientId;
    tr.innerHTML =
      `<td class="${mine ? 'you' : ''}">${escapeHtml(r.name)}</td>` +
      `<td class="num">${r.distance == null ? '—' : r.distance + ' blk'}</td>` +
      `<td class="num">${r.score}</td>` +
      `<td class="num">${r.totalScore}</td>`;
    t.appendChild(tr);
  }

  const last = msg.index + 1 >= msg.total;
  $('nextBtn').classList.toggle('hidden', !state.isHost);
  $('nextBtn').textContent = last ? 'See final scores' : 'Next round';
  $('waitNext').classList.toggle('hidden', state.isHost);
}

function showFinal(board) {
  $('finalOverlay').classList.remove('hidden');
  const t = $('finalTable');
  t.innerHTML = '<tr><th>#</th><th>Player</th><th class="num">Total</th></tr>';
  board.forEach((p, i) => {
    const tr = document.createElement('tr');
    const mine = p.clientId === state.clientId;
    tr.innerHTML = `<td>${i + 1}</td><td class="${mine ? 'you' : ''}">${escapeHtml(p.name)}</td><td class="num">${p.totalScore}</td>`;
    t.appendChild(tr);
  });
}

/* ------------------------------------------------------------------ *
 *  Utils + wiring
 * ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('DOMContentLoaded', () => {
  connect();

  // Load the movement graph (relative bearings only — safe to expose).
  if (CFG.ENABLE_MOVEMENT) {
    fetch('/links.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { state.links = data && data.links ? data.links : null; })
      .catch(() => { state.links = null; });
  }

  $('createBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    const rounds = parseInt($('roundsInput').value, 10) || 5;
    sendWS({ t: 'create', name, rounds });
  };
  $('joinBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) { $('lobbyError').textContent = 'Enter a room code.'; return; }
    sendWS({ t: 'join', code, name });
  };
  $('startBtn').onclick = () => sendWS({ t: 'start' });
  $('guessBtn').onclick = submitGuess;
  $('nextBtn').onclick = () => sendWS({ t: 'next' });
  $('playAgainBtn').onclick = () => location.reload();
  $('backToStartBtn').onclick = () => {
    if (state.startFolder) loadPanorama(state.startFolder);
  };
});
