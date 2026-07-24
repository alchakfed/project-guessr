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
  tourScenes: null,  // Set of scene ids registered on the current viewer
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
 *
 *  When CFG.DYNMAP.enabled, the guessing map is instead the live CCNet Dynmap
 *  (see the Dynmap section below); the two helpers branch on that so every
 *  caller (guess pin, result markers, scoring) works unchanged.
 * ------------------------------------------------------------------ */
const DM = CFG.DYNMAP || {};
function dynmapEnabled() { return !!DM.enabled; }

function worldToLatLng(x, z) {
  if (dynmapEnabled()) return L.latLng(z, x); // lng=X, lat=Z (see dynmapCRS)
  const m = state.mapMeta;
  const px = ((x - m.worldMinX) / (m.worldMaxX - m.worldMinX)) * m.imageWidth;
  const py = ((z - m.worldMinZ) / (m.worldMaxZ - m.worldMinZ)) * m.imageHeight;
  return L.latLng(-py, px);
}
function latLngToWorld(latlng) {
  if (dynmapEnabled()) return { x: latlng.lng, z: latlng.lat };
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

  ws.onopen = () => {
    state.connected = true;
    state.retries = 0;
    if ($('lobbyError').textContent === 'Disconnected from server.' ||
        $('lobbyError').textContent.startsWith('Connecting')) {
      $('lobbyError').textContent = '';
    }
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    state.connected = false;
    // Free hosting (e.g. Render) spins the server down when idle; the first
    // connection can be refused while it wakes. Retry with backoff instead of
    // giving up so the game becomes playable once the instance is warm.
    const n = (state.retries = (state.retries || 0) + 1);
    if (n <= 8) {
      const wait = Math.min(1000 * n, 5000);
      $('lobbyError').textContent = `Connecting to server… (waking up, attempt ${n})`;
      setTimeout(connect, wait);
    } else {
      $('lobbyError').textContent = 'Disconnected from server. Refresh to retry.';
    }
  };
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
  preloadedPanos.clear();
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
  state.tourScenes = new Set();

  const opts = {
    default: {
      firstScene: folder,
      sceneFadeDuration: 350, // crossfade between panoramas -> no black loader
      autoLoad: true,
      showControls: true,
      hfov: view ? view.hfov : 100,
    },
    scenes: { [folder]: sceneConfig(folder) },
  };
  state.tourScenes.add(folder);
  // Restore the previous view when roaming; use defaults on a fresh round.
  if (view) {
    opts.default.yaw = view.yaw;
    opts.default.pitch = view.pitch;
  }
  state.pano = pannellum.viewer('panorama', opts);

  onSceneShown(folder);
}

// Build the Pannellum scene config (cubemap + movement-arrow hotspots) for one
// panorama. Clicking an arrow crossfades to that neighbour via moveTo().
function sceneConfig(folder) {
  const yawOffset = CFG.PANO_YAW_OFFSET || 0;
  const hotSpots = neighboursFor(folder).map((n) => ({
    // Pannellum yaw: 0 = front face, positive clockwise. Our bearing is
    // clockwise from +Z; the single offset aligns the two coordinate frames.
    yaw: ((n.bearing + yawOffset + 180) % 360) - 180,
    pitch: -12,
    cssClass: 'pg-arrow',
    createTooltipFunc: makeArrow,
    createTooltipArgs: { to: n.to, dist: n.dist },
    clickHandlerFunc: () => moveTo(n.to),
  }));
  return { type: 'cubemap', cubeMap: panoUrls(folder), hotSpots };
}

// Register a scene once so its arrows exist before we fade to it.
function ensureScene(folder) {
  if (!state.pano || state.tourScenes.has(folder)) return;
  state.tourScenes.add(folder);
  state.pano.addScene(folder, sceneConfig(folder));
}

// Walk to a neighbour: register the target scene, then crossfade to it keeping
// the current look direction. The faces are already warm (preloadNeighbours),
// so the fade lands on a decoded image instead of a spinner.
function moveTo(folder) {
  if (!state.pano) { loadPanorama(folder); return; }
  ensureScene(folder);
  state.currentFolder = folder;
  // 'same' keeps the current pitch/yaw/hfov across the transition.
  state.pano.loadScene(folder, 'same', 'same', 'same');
  onSceneShown(folder);
}

// Shared per-scene housekeeping: hint when off the start panorama, and warm the
// caches for wherever the player can go next.
function onSceneShown(folder) {
  const moved = folder !== state.startFolder;
  $('roamHint').classList.toggle('hidden', !moved);
  preloadNeighbours(folder);
}

// Prefetch the cubemap faces of every panorama the player can walk to from
// `folder`. Uses Image() so the browser caches them; the crossfade to a
// neighbour then lands on a decoded image with no network wait. Deduped per
// round so we never re-request a face we've already warmed.
const preloadedPanos = new Set();
function preloadNeighbours(folder) {
  for (const n of neighboursFor(folder)) {
    ensureScene(n.to); // register the scene too, so its arrows are ready
    if (preloadedPanos.has(n.to)) continue;
    preloadedPanos.add(n.to);
    for (const src of panoUrls(n.to)) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }
  }
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
  if (dynmapEnabled()) return makeDynmapMap(elementId);
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

/* ------------------------------------------------------------------ *
 *  Dynmap live-map layer (test)
 *  ------------------------------------------------------------------
 *  Serves the guessing map straight from the CCNet Dynmap tiles instead of
 *  the bundled map.png. Leaflet's plane is defined so pixel = (scale*X,
 *  -scale*Z), i.e. exactly Dynmap's `worldtomap`, and latLng carries raw
 *  world coords (lat=Z, lng=X) so worldToLatLng/latLngToWorld are trivial.
 *
 *  Tile addressing — matches LiveAtlas/Dynmap DynmapTileLayer.getTileName:
 *    n      = nativeZoom - leafletZoom      (# of 'z' zoom-out prefixes)
 *    fx     =  tileX*2^n
 *    fy     = -tileY*2^n                    (Y is INVERTED for the HD map)
 *    folder = (fx>>5)_(fy>>5)               (>>5 == floor(/32) for integers)
 *    name   = ('z'*n)['_' if n>0] + fx_fy.ext
 * ------------------------------------------------------------------ */
function makeDynmapCRS() {
  const s = DM.scale;         // blocks -> map pixels (4)
  const N = DM.nativeZoom;    // leaflet zoom where a map pixel == a tile pixel
  // Start from CRS.Simple (projection = LonLat: point(lng, lat)) and retune the
  // transformation + zoom scaling so native zoom lands on Dynmap's pixel grid.
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(s, 0, -s, 0),
    scale: (zoom) => Math.pow(2, zoom - N),
    zoom: (scale) => Math.log(scale) / Math.LN2 + N,
  });
}

const DynmapTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const n = DM.nativeZoom - coords.z;
    const f = Math.pow(2, n);
    const fx = coords.x * f;
    const fy = -coords.y * f; // Dynmap inverts Y for the HD map
    // >>5 is floor(/32) for the integer tile coords (works for negatives too).
    const folder = `${fx >> 5}_${fy >> 5}`;
    const pre = 'z'.repeat(n) + (n > 0 ? '_' : '');
    return `${DM.baseUrl}/${DM.world}/${DM.prefix}/${folder}/${pre}${fx}_${fy}.${DM.ext}`;
  },
});

// 1x1 transparent PNG — shown for empty/unrendered regions instead of a broken tile.
const BLANK_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function makeDynmapMap(elementId) {
  const map = L.map(elementId, {
    crs: makeDynmapCRS(),
    minZoom: DM.minZoom,
    maxZoom: DM.maxZoom,
    attributionControl: false,
    zoomControl: true,
  });
  new DynmapTileLayer('', {
    tileSize: DM.tileSize,
    minZoom: DM.minZoom,
    maxZoom: DM.maxZoom,
    minNativeZoom: DM.minZoom,
    maxNativeZoom: DM.maxZoom,
    noWrap: true,
    errorTileUrl: BLANK_TILE,
    // Fetch a generous ring of off-screen tiles so panning reveals already-
    // loaded map instead of black gaps. keepBuffer retains them when panning
    // back. This is the main lever against the "black until you drag" problem.
    keepBuffer: 8,
  }).addTo(map);
  map.setView(worldToLatLng(DM.center.x, DM.center.z), DM.initialZoom);
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
  // Leaflet reads its container size on creation; if the game screen is still
  // animating in, it sizes to a short strip and only that strip's tiles load
  // (black elsewhere until you pan). Recalculate a few times as layout settles,
  // and once more whenever the element resizes, so the full frame fills in.
  recalcMapSize(map, 'map');
}

function recalcMapSize(map, elementId) {
  const bump = () => { if (state.map === map || state.resultMap === map) map.invalidateSize(); };
  for (const t of [0, 50, 200, 500]) setTimeout(bump, t);
  if (window.ResizeObserver) {
    const el = $(elementId);
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    map.on('unload', () => ro.disconnect());
  }
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
  recalcMapSize(map, 'resultMiniMap');

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
    if (state.startFolder) moveTo(state.startFolder);
  };
});
