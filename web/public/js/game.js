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
  everConnected: false, // true once any socket has opened (gates mid-game drop handling)
  retryTimer: null,     // pending initial-connection retry setTimeout
  pano: null,        // Pannellum viewer instance
  tourScenes: null,  // Set of scene ids registered on the current viewer
  map: null,         // Leaflet map (guess)
  guessMarker: null,
  guessLatLng: null, // current pending guess in Leaflet coords
  resultMap: null,   // Leaflet map on the result overlay
  locationsMap: null, // Leaflet map on the "all photo locations" overview
  hasGuessed: false,
  links: null,       // navigation graph {folder: [{to, bearing, dist}]}
  startFolder: null, // where the round began — scoring is pinned here
  currentFolder: null, // panorama currently shown (may differ after roaming)
  // --- Game mode / duel state ---
  mode: 'classic',       // classic | duel | teamduel
  myTeam: null,          // this client's team key (server-assigned)
  roundTeams: null,      // latest team HP snapshot from the server
  allowMove: true,       // per-game roaming toggle (overrides CFG.ENABLE_MOVEMENT)
  timerId: null,         // setInterval for the round countdown
  deadline: null,        // ms epoch the current round auto-locks
  teamMarkers: {},       // clientId -> Leaflet marker for live teammate guesses
  // --- Team chat ---
  chatOpen: false,
  chatHideTimer: null,
  // --- Settings (persisted in localStorage) ---
  settings: { disableChat: false },
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
  // Dynmap transform is pixelY = -scale*lat, and getTileUrl inverts tile Y
  // (fy = -coords.y) so the terrain renders north-up. The marker path never
  // sees that inversion, so lat must be -Z (not +Z) to land on the SAME
  // hemisphere as the tiles: +Z is south (down), matching Minecraft.
  //
  // markerOffsetX/Z nudge the whole world<->screen mapping to line the latLng
  // grid up with the terrain tiles (see config). Applied here and inverted in
  // latLngToWorld so the pair stays a clean round-trip: scoring is unaffected,
  // pins and clicks just register on the right pixel.
  if (dynmapEnabled()) return L.latLng(-(z + (DM.markerOffsetZ || 0)), x + (DM.markerOffsetX || 0));
  const m = state.mapMeta;
  const px = ((x - m.worldMinX) / (m.worldMaxX - m.worldMinX)) * m.imageWidth;
  const py = ((z - m.worldMinZ) / (m.worldMaxZ - m.worldMinZ)) * m.imageHeight;
  return L.latLng(-py, px);
}
function latLngToWorld(latlng) {
  if (dynmapEnabled()) return { x: latlng.lng - (DM.markerOffsetX || 0), z: -latlng.lat - (DM.markerOffsetZ || 0) }; // inverse of above
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
  // Tag this socket so onclose can tell an initial-connection retry from a
  // mid-game drop (which should NOT auto-retry — that clobbers the Reconnect
  // button's controlled socket and silently drops the reconnect message).
  ws._initial = !state.everConnected;

  ws.onopen = () => {
    state.connected = true;
    state.everConnected = true;
    state.retries = 0;
    if ($('lobbyError').textContent === 'Disconnected from server.' ||
        $('lobbyError').textContent.startsWith('Connecting')) {
      $('lobbyError').textContent = '';
    }
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    state.connected = false;
    // Only auto-retry the INITIAL connection (e.g. waking a cold Render
    // instance). Once we've been in a game/room and the socket drops, do NOT
    // auto-retry — the Reconnect button handles rejoining, and a blind retry
    // would open a contextless socket that clobbers state.ws and eats the
    // reconnect message. Show a hint + the Reconnect button instead.
    if (ws._initial && !state.everConnected) {
      const n = (state.retries = (state.retries || 0) + 1);
      if (n <= 8) {
        const wait = Math.min(1000 * n, 5000);
        $('lobbyError').textContent = `Connecting to server… (waking up, attempt ${n})`;
        state.retryTimer = setTimeout(connect, wait);
      } else {
        $('lobbyError').textContent = 'Disconnected from server. Refresh to retry.';
      }
      return;
    }
    // Mid-game / mid-room drop: surface it and let the user Reconnect.
    if (state.code) {
      $('lobbyError').textContent = 'Connection lost — click Reconnect to rejoin.';
      showReconnectButton();
      showScreen('lobby');
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
      // Persist the reconnect key + code so an accidental close/refresh can
      // rejoin this exact slot (score/team/host preserved server-side).
      if (msg.reconnectKey) saveReconnect(msg.code, msg.reconnectKey);
      $('roomCode').textContent = msg.code;
      // On reconnect, switch to the screen matching the game's current state.
      // The server sends the full state replay (round / roundresult / lobby)
      // right after this, which fills in the details — but we set the SCREEN
      // here so there's no flash of "waiting for host" when rejoining mid-game.
      if (msg.reconnected) {
        if (msg.roomState === 'lobby') showScreen('room');
        // playing / roundover / finished -> the game screen; the round or
        // roundresult message populates it. (showRoundResult/startRound also
        // call showScreen('game'), so this is belt-and-braces.)
        else showScreen('game');
        break;
      }
      showScreen('room');
      break;
    case 'lobby': {
      state.players = msg.players;
      state.isHost = msg.hostId === state.clientId;
      state.mode = msg.mode || 'classic';
      state.allowMove = msg.allowMove !== false;
      const me = msg.players.find((p) => p.clientId === state.clientId);
      state.myTeam = me ? me.team : null;
      renderRoom(msg);
      $('startBtn').classList.toggle('hidden', !state.isHost);
      $('waitMsg').classList.toggle('hidden', state.isHost);
      // The lobby message renders into the room/waiting screen. We don't call
      // showScreen('room') here: on a fresh join the 'joined' handler already
      // switched to it, and on a mid-game reconnect the server sends 'round' or
      // 'roundresult' to govern our screen — switching here would yank us back
      // to the waiting screen. The lobby-state reconnect path sends this AFTER
      // 'joined' and expects us to already be on the room screen from 'joined'.
      break;
    }
    case 'round':
      startRound(msg);
      break;
    case 'guessed':
      $('guessStatus').textContent = `Locked in: ${msg.count} / ${msg.total}`;
      lockTeammateMarker(msg.clientId);
      break;
    case 'teamguess':
      upsertTeammateMarker(msg);
      break;
    case 'teampin':
      upsertTeammateMarker(msg);
      break;
    case 'browselist':
      renderBrowseList(msg.rooms);
      break;
    case 'chat':
      receiveChat(msg);
      break;
    case 'roundresult':
      showRoundResult(msg);
      break;
    case 'scoreboard':
      // Kept for future live scoreboard; results table already shows totals.
      break;
    case 'finished':
      showFinal(msg);
      break;
    case 'kicked':
      state.kicked = true;
      clearReconnect(); // kicked = no rejoining this room
      $('lobbyError').textContent = 'You were removed from the room by the host.';
      showScreen('lobby');
      break;
    case 'left':
      // We voluntarily left the lobby: drop any saved session and go back.
      clearReconnect();
      state.isHost = false;
      $('lobbyError').textContent = '';
      showScreen('lobby');
      break;
    case 'error':
      $('lobbyError').textContent = msg.message;
      break;
  }
}

/* ------------------------------------------------------------------ *
 *  Lobby / room
 * ------------------------------------------------------------------ */
const MODE_LABEL = {
  classic: 'Classic — highest score wins',
  duel: 'Duel — HP battle, closest guess deals damage',
  teamduel: 'Team Duel — two teams share HP',
};

function renderRoom(msg) {
  // --- Options panel (host can edit, others read-only) ---
  const editable = state.isHost;
  for (const id of ['optMode', 'optRounds', 'optTime', 'optHp', 'optMove', 'optPublic']) {
    const el = $(id);
    if (el) el.disabled = !editable;
  }
  if ($('optMode').value !== msg.mode) $('optMode').value = msg.mode;
  if (document.activeElement !== $('optRounds')) $('optRounds').value = msg.rounds;
  if (document.activeElement !== $('optTime')) $('optTime').value = msg.roundTime;
  if (document.activeElement !== $('optHp')) $('optHp').value = msg.hp;
  $('optMove').checked = msg.allowMove;
  $('optPublic').checked = msg.isPublic;
  $('timeReadout').textContent = msg.roundTime ? `${msg.roundTime}s` : 'No limit';
  const duel = msg.mode === 'duel' || msg.mode === 'teamduel';
  $('optHpField').classList.toggle('hidden', !duel);
  // Duel modes run until a knockout — no fixed round count to configure.
  $('optRoundsField').classList.toggle('hidden', duel);

  // Public/private badge + subtitle.
  $('publicBadge').classList.toggle('hidden', !msg.isPublic);
  $('roomSub').textContent = msg.isPublic
    ? 'Public - appears in the lobby browser. Join code also works.'
    : 'Private - share the join code with friends.';

  const teamMode = msg.mode === 'teamduel';
  $('teamCols').classList.toggle('hidden', !teamMode);
  $('playerList').classList.toggle('hidden', teamMode);
  if (teamMode) renderTeams(msg.players, msg.hostId);
  else renderPlayers(msg.players, msg.hostId);

  // Show the chat affordance only in team duel.
  setChatAvailable(teamMode);
}

// Build one <li> for a player, with host-only move/kick controls.
function playerLi(p, hostId, teamMode) {
  const li = document.createElement('li');
  const you = p.clientId === state.clientId ? ' (you)' : '';
  const label = document.createElement('span');
  label.className = p.clientId === state.clientId ? 'you' : '';
  label.textContent = p.name + you;
  li.appendChild(label);
  if (p.clientId === hostId) {
    const b = document.createElement('span');
    b.className = 'host-badge'; b.textContent = 'HOST';
    li.appendChild(b);
  }
  // Host controls (not shown on the host's own row).
  if (state.isHost && p.clientId !== state.clientId) {
    const ctrls = document.createElement('span');
    ctrls.className = 'host-ctrls';
    if (teamMode) {
      const mv = document.createElement('button');
      mv.className = 'mini-btn';
      mv.textContent = p.team === 1 ? '← A' : 'B →';
      mv.title = 'Move to the other team';
      mv.onclick = () => sendWS({ t: 'setteam', clientId: p.clientId, team: p.team === 1 ? 0 : 1 });
      ctrls.appendChild(mv);
    }
    const k = document.createElement('button');
    k.className = 'mini-btn kick';
    k.textContent = '✕';
    k.title = 'Kick from room';
    k.onclick = () => sendWS({ t: 'kick', clientId: p.clientId });
    ctrls.appendChild(k);
    li.appendChild(ctrls);
  }
  return li;
}

function renderPlayers(players, hostId) {
  const ul = $('playerList');
  ul.innerHTML = '';
  for (const p of players) ul.appendChild(playerLi(p, hostId, false));
}

function renderTeams(players, hostId) {
  const a = $('teamA'), b = $('teamB');
  a.innerHTML = ''; b.innerHTML = '';
  for (const p of players) {
    (p.team === 1 ? b : a).appendChild(playerLi(p, hostId, true));
  }
}

/* ------------------------------------------------------------------ *
 *  Lobby browser (public rooms)
 * ------------------------------------------------------------------ */
function renderBrowseList(rooms) {
  const el = $('browseList');
  if (!rooms || !rooms.length) {
    el.innerHTML = '<p class="hint">No public rooms right now.</p>';
    return;
  }
  el.innerHTML = '';
  for (const r of rooms) {
    const row = document.createElement('div');
    row.className = 'browse-row';
    row.innerHTML =
      `<div class="browse-info"><span class="browse-name">${escapeHtml(r.name)}</span>` +
      `<span class="browse-meta">${MODE_LABEL_SHORT[r.mode] || r.mode} · ${r.players} player${r.players === 1 ? '' : 's'}</span></div>` +
      `<button class="mini-btn browse-join">Join</button>`;
    row.querySelector('.browse-join').onclick = () => {
      const name = $('nameInput').value.trim() || 'Player';
      sendWS({ t: 'join', code: r.code, name });
    };
    el.appendChild(row);
  }
}
const MODE_LABEL_SHORT = { classic: 'Classic', duel: 'Duel', teamduel: 'Team Duel' };

/* ------------------------------------------------------------------ *
 *  Settings (persisted in localStorage) + team chat
 * ------------------------------------------------------------------ */
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('pg_settings') || '{}');
    state.settings.disableChat = !!s.disableChat;
  } catch (_) { state.settings.disableChat = false; }
  const el = $('disableChatInput');
  if (el) el.checked = state.settings.disableChat;
}
function saveSettings() {
  try { localStorage.setItem('pg_settings', JSON.stringify(state.settings)); } catch (_) {}
}

/* ------------------------------------------------------------------ *
 *  Reconnect: remember the room code + key so an accidental close or
 *  refresh can rejoin the same slot (score/team/host preserved).
 * ------------------------------------------------------------------ */
function saveReconnect(code, key) {
  try { localStorage.setItem('pg_reconnect', JSON.stringify({ code, key, ts: Date.now() })); } catch (_) {}
  showReconnectButton();
}
function loadReconnect() {
  try {
    const r = JSON.parse(localStorage.getItem('pg_reconnect') || 'null');
    if (!r || !r.code || !r.key) return null;
    // Expire after the server's grace window (5 min) + a little slack.
    if (Date.now() - (r.ts || 0) > 6 * 60_000) { clearReconnect(); return null; }
    return r;
  } catch (_) { return null; }
}
function clearReconnect() {
  try { localStorage.removeItem('pg_reconnect'); } catch (_) {}
  hideReconnectButton();
}
function showReconnectButton() {
  const r = loadReconnect();
  if (!r) return;
  const btn = $('reconnectBtn');
  if (!btn) return;
  btn.textContent = `Reconnect to ${r.code}`;
  btn.classList.remove('hidden');
}
function hideReconnectButton() {
  const btn = $('reconnectBtn');
  if (btn) btn.classList.add('hidden');
}
function doReconnect() {
  const r = loadReconnect();
  if (!r) return;
  // Don't reuse a dead/half-open socket: sendWS silently drops on non-OPEN,
  // which is exactly why a Reconnect click can do nothing. Open a fresh
  // controlled socket and send the reconnect message once it's open.
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
  if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch (_) {} }
  const url = CFG.WS_URL || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const ws = new WebSocket(url);
  state.ws = ws;
  state.retries = 0;
  $('lobbyError').textContent = 'Reconnecting…';
  ws.onopen = () => {
    state.connected = true;
    state.everConnected = true;
    ws.send(JSON.stringify({ t: 'reconnect', code: r.code, reconnectKey: r.key }));
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    state.connected = false;
    // If we never got 'joined' back (server down / room expired / key invalid),
    // surface the failure. If we DID reconnect and later drop again, treat it
    // like any mid-game drop: show the Reconnect button + lobby so the player
    // can rejoin once more.
    if (state.code) {
      $('lobbyError').textContent = 'Connection lost — click Reconnect to rejoin.';
      showReconnectButton();
      showScreen('lobby');
    } else {
      $('lobbyError').textContent = 'Reconnect failed — the room may have expired. Try again.';
      showReconnectButton();
    }
  };
}

// Whether the team chat UI should be available at all (teamduel only, and not
// disabled via settings).
function setChatAvailable(teamMode) {
  const avail = teamMode && !state.settings.disableChat;
  $('chatTab').classList.toggle('hidden', !avail);
  if (!avail) closeChat();
}

function openChat() {
  if (state.settings.disableChat || state.mode !== 'teamduel') return;
  state.chatOpen = true;
  $('teamChat').classList.remove('hidden');
  $('chatTab').classList.add('hidden');
  resetChatHideTimer();
  setTimeout(() => $('chatInput').focus(), 0);
}
function closeChat() {
  state.chatOpen = false;
  $('teamChat').classList.add('hidden');
  if (state.mode === 'teamduel' && !state.settings.disableChat) {
    $('chatTab').classList.remove('hidden');
  }
  if (state.chatHideTimer) { clearTimeout(state.chatHideTimer); state.chatHideTimer = null; }
}
// Auto-hide after a short period of inactivity; any new message re-shows.
function resetChatHideTimer() {
  if (state.chatHideTimer) clearTimeout(state.chatHideTimer);
  state.chatHideTimer = setTimeout(() => { if (state.chatOpen) closeChat(); }, 6000);
}
function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  inp.value = '';
  if (!text || state.settings.disableChat) return;
  sendWS({ t: 'chat', text });
  resetChatHideTimer();
}
function receiveChat(msg) {
  if (state.settings.disableChat) return;
  const log = $('chatLog');
  const mine = msg.clientId === state.clientId;
  const line = document.createElement('div');
  line.className = 'chat-line' + (mine ? ' me' : '');
  line.innerHTML = `<span class="chat-name">${escapeHtml(mine ? 'You' : msg.name)}</span> ` +
    `<span class="chat-text">${escapeHtml(msg.text)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // A new message pops the panel open and resets the hide timer.
  if (!state.chatOpen) openChat();
  else resetChatHideTimer();
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
  // Duel modes have no fixed round count (they end on a knockout), so just show
  // the current round number instead of "X / total".
  const duel = (msg.mode || state.mode) !== 'classic';
  $('roundInfo').textContent = duel
    ? `Round ${msg.index + 1}`
    : `Round ${msg.index + 1} / ${msg.total}`;
  $('guessStatus').textContent = '';
  state.hasGuessed = false;
  state.guessLatLng = null;
  state.mode = msg.mode || state.mode;
  state.allowMove = msg.allowMove !== false;
  state.teamMarkers = {};
  setChatAvailable(state.mode === 'teamduel');
  if (msg.teams) state.roundTeams = msg.teams;
  updateHpBars(state.roundTeams);
  startRoundTimer(msg.deadline);

  // Scoring is pinned to where the round starts; roaming never moves this.
  state.startFolder = msg.folder;
  preloadedPanos.clear();
  loadPanorama(msg.folder, { freshView: true });

  // ---- Guess map (recreate each round) ----
  buildGuessMap();
  $('guessBtn').disabled = true;
  $('guessBtn').textContent = 'Place a pin to guess';

  // Reconnect-only: if the server says we already guessed before dropping,
  // restore that locked-in pin and mark ourselves guessed so we can't submit a
  // second (server-rejected) guess that would desync our view from the others.
  if (msg.myGuess) {
    restoreGuess(msg.myGuess);
  }
}

// Re-apply a guess we already locked in before a disconnect (reconnect path).
function restoreGuess(g) {
  if (!g || !state.map) return;
  const ll = worldToLatLng(g.x, g.z);
  state.guessLatLng = ll;
  state.hasGuessed = true;
  if (state.guessMarker) state.map.removeLayer(state.guessMarker);
  state.guessMarker = L.circleMarker(ll, {
    radius: 7, color: '#fff', weight: 2, fillColor: '#55c157', fillOpacity: 1,
    className: 'guess-pin',
  }).addTo(state.map);
  $('guessBtn').disabled = true;
  $('guessBtn').textContent = 'Locked in ✓';
  $('guessStatus').textContent = 'Locked in (restored after reconnect)';
}

/* ------------------------------------------------------------------ *
 *  Duel healthbars + round timer
 * ------------------------------------------------------------------ */
// Show your side's HP top-left and the opponent's top-right. In team duel your
// side = your team; in solo duel your side = you. Hidden entirely in classic.
function updateHpBars(teams) {
  const self = $('hpSelf'), opp = $('hpOpp');
  if (!teams || state.mode === 'classic') {
    self.classList.add('hidden'); opp.classList.add('hidden');
    return;
  }
  const mineKey = state.mode === 'teamduel' ? String(state.myTeam == null ? 0 : state.myTeam) : state.clientId;
  const mine = teams.find((t) => t.team === mineKey);
  const others = teams.filter((t) => t.team !== mineKey);
  // Opponent bar shows the strongest surviving rival (the one to beat).
  const rival = others.slice().sort((a, b) => b.hp - a.hp)[0] || null;
  renderHpBar(self, mine, 0);
  renderHpBar(opp, rival, others.length - 1);
}

function renderHpBar(el, team, extraRivals) {
  if (!team) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, (team.hp / team.maxHp) * 100));
  const fill = el.querySelector('.hp-fill');
  const prevW = parseFloat(fill.style.width) || 100;
  fill.style.width = pct + '%';
  if (pct < prevW - 0.01) { el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
  el.querySelector('.hp-label').textContent = team.label + (extraRivals > 0 ? ` (+${extraRivals} more)` : '');
  el.querySelector('.hp-num').textContent = `${team.hp} / ${team.maxHp}`;
}

// Cosmetic mirror of the server's authoritative round timer.
function startRoundTimer(deadline) {
  stopRoundTimer();
  const pill = $('roundTimer');
  if (!deadline) { pill.classList.add('hidden'); return; }
  state.deadline = deadline;
  pill.classList.remove('hidden');
  const tick = () => {
    const left = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
    pill.textContent = `⏱ ${left}s`;
    pill.classList.toggle('urgent', left <= 10);
    if (left <= 0) {
      stopRoundTimer();
      // Auto-lock whatever pin is placed (server also enforces this).
      if (!state.hasGuessed && state.guessLatLng) submitGuess();
    }
  };
  tick();
  state.timerId = setInterval(tick, 250);
}

function stopRoundTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  $('roundTimer').classList.add('hidden');
}

// A teammate locked in a guess: drop their pin on our map so we can coordinate.
// Draw/update a teammate's live pin on our guess map. Called for both 'teampin'
// (live placement/move) and the legacy 'teamguess' message. The pin appears the
// moment they place it and persists even if they never press Guess.
function upsertTeammateMarker(msg) {
  if (!state.map || !L) return;
  const ll = worldToLatLng(msg.x, msg.z);
  if (state.teamMarkers[msg.clientId]) state.map.removeLayer(state.teamMarkers[msg.clientId]);
  const m = L.circleMarker(ll, {
    radius: 6, color: '#fff', weight: 2, fillColor: '#e8b84a', fillOpacity: 0.9,
  }).addTo(state.map).bindTooltip(`${msg.name} (teammate)`, { direction: 'top' });
  state.teamMarkers[msg.clientId] = m;
}

// Mark a teammate's pin as locked once they've pressed Guess.
function lockTeammateMarker(clientId) {
  const m = state.teamMarkers[clientId];
  if (!m) return;
  m.setStyle({ fillColor: '#b07a16', fillOpacity: 1, color: '#fff' });
  const tip = m.getTooltip();
  if (tip) tip.setContent((tip.getContent() || '').replace('(teammate)', '(teammate · locked)'));
}

// Debounce live pin updates so rapid clicks/drags don't flood the server.
let teampinTimer = null;
function sendTeampinDebounced(x, z) {
  if (teampinTimer) clearTimeout(teampinTimer);
  teampinTimer = setTimeout(() => {
    teampinTimer = null;
    sendWS({ t: 'teampin', x, z });
  }, 60);
}

/* ------------------------------------------------------------------ *
 *  Panorama viewer + Street-View movement arrows
 *  ------------------------------------------------------------------
 *  The viewer is (re)built whenever we show a panorama - both at round start
 *  and each time the player roams to a neighbour. Arrows are Pannellum
 *  hotspots placed at the bearing to each neighbour (from links.json), pinned
 *  near the horizon. Clicking one loads that neighbour. Scoring is unaffected:
 *  the server only ever sees the guess coords, and the "actual" location it
 *  scores against is the round's start panorama.
 * ------------------------------------------------------------------ */
function neighboursFor(folder) {
  if (!CFG.ENABLE_MOVEMENT || !state.allowMove || !state.links) return [];
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
      showControls: false, // hide Pannellum's fullscreen/zoom widgets
      hfov: view ? view.hfov : 150,
      maxHfov: 150,
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

  // Render cold-start / reconnect fix: if the #game screen was just switched
  // to (e.g. on reconnect), the #panorama container may still have zero size
  // when the viewer is created, which makes Pannellum render a black sphere.
  // If so, wait one frame for the layout to settle and force a resize so the
  // viewer picks up the real dimensions.
  const cont = $('panorama');
  if (cont && (cont.clientWidth === 0 || cont.clientHeight === 0)) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (state.pano && state.currentFolder === folder) {
          try { state.pano.resize(); } catch (_) {}
        }
      });
    });
  }
}

// Effective on-screen yaw of a neighbour's arrow, in Pannellum's convention
// (0 = straight ahead of the panorama's front face, positive = to the right).
// Shared by the visual hotspots and the keyboard handler so a key press lands
// on the SAME neighbour the matching arrow points at.
function arrowYawFor(n) {
  const yawOffset = (CFG.PANO_YAW_OFFSET || 0);
  const yawSign = CFG.PANO_YAW_SIGN === -1 ? -1 : 1;
  const base = (n.arrowYaw != null ? n.arrowYaw : -n.bearing);
  // (+540 % 360 -180) wrap is negative-safe -> result in [-180, 180).
  return (((yawSign * base + yawOffset) % 360) + 540) % 360 - 180;
}

// Build the Pannellum scene config (cubemap + movement-arrow hotspots) for one
// panorama. Clicking an arrow crossfades to that neighbour via moveTo().
function sceneConfig(folder) {
  const hotSpots = neighboursFor(folder).map((n) => ({
    // build-links.js precomputes arrowYaw = -(bearing + captureYaw): the
    // neighbour's direction RELATIVE to this panorama's own front face, which is
    // whichever way the player looked when the shot was taken. That per-panorama
    // heading is why a single global offset never worked before. With arrowYaw
    // baked in, PANO_YAW_OFFSET is just a global fix for face-order rotation and
    // PANO_YAW_SIGN a global mirror fix. Fall back to the old bearing-only math
    // for links.json files generated before arrowYaw existed.
    yaw: arrowYawFor(n),
    pitch: -12,
    cssClass: 'pg-arrow',
    createTooltipFunc: makeArrow,
    createTooltipArgs: { to: n.to, dist: n.dist },
    clickHandlerFunc: () => moveTo(n.to),
  }));
  return { type: 'cubemap', cubeMap: panoUrls(folder), hotSpots };
}

// Roam by keyboard: pick the neighbour whose arrow is closest to the requested
// direction RELATIVE TO THE CURRENT VIEW (up = ahead of where you're looking,
// right = to your right, etc.), and walk there — same as clicking that arrow.
// Returns true if it moved, so the caller can swallow the key event.
function roamRelative(screenDeg) {
  if (!state.pano) return false;
  const neighbours = neighboursFor(state.currentFolder);
  if (!neighbours.length) return false;
  const viewYaw = state.pano.getYaw();
  let best = null, bestDiff = Infinity;
  for (const n of neighbours) {
    // Where this neighbour's arrow sits relative to the view centre.
    let rel = arrowYawFor(n) - viewYaw;
    rel = ((rel % 360) + 540) % 360 - 180;
    let diff = Math.abs(rel - screenDeg);
    diff = Math.min(diff, 360 - diff); // shortest way round the circle
    if (diff < bestDiff) { bestDiff = diff; best = n; }
  }
  // Only accept a neighbour that's reasonably in the pressed direction (within
  // ~70° of it), so pressing Left with nothing to the left does nothing rather
  // than teleporting you to the only arrow available.
  if (best && bestDiff <= 70) { moveTo(best.to); return true; }
  return false;
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
  const from = state.currentFolder;
  state.currentFolder = folder;
  // Keep the player facing the SAME WORLD DIRECTION across the step (like walking
  // forward in Street View), not the same on-screen yaw. Each panorama has its own
  // captured front-face heading, so "screen yaw 0" points a different way in each.
  // northScreenYawFor gives where world-north sits on a scene (from public link
  // bearings), so shifting the yaw by the difference between the two scenes' norths
  // holds the world heading fixed. Pitch/hfov carry over unchanged ('same'); pitch
  // is already world-absolute since panoramas aren't tilted. Falls back to 'same'
  // yaw when either scene lacks bearing data to know its north.
  let targetYaw = 'same';
  const nFrom = northScreenYawFor(from);
  const nTo = northScreenYawFor(folder);
  if (nFrom != null && nTo != null) {
    let y = state.pano.getYaw() + (nTo - nFrom);
    y = ((y % 360) + 540) % 360 - 180; // normalise to [-180, 180)
    targetYaw = y;
  }
  state.pano.loadScene(folder, 'same', targetYaw, 'same');
  onSceneShown(folder);
}

// Shared per-scene housekeeping: show the return-to-start button when the
// player has roamed off the start panorama, and warm caches for next moves.
function onSceneShown(folder) {
  const moved = folder !== state.startFolder;
  $('backToStartBtn').classList.toggle('hidden', !moved);
  preloadNeighbours(folder);
}

// Spin the little bottom-left compass so its needle points to TRUE WORLD NORTH.
//
// We never receive an absolute heading directly, but links.json gives, per
// neighbour, both the absolute `bearing` (degrees clockwise from +Z = north) and
// the on-screen `arrowYaw` we already render the movement arrow at. A rendered
// arrow at screen-yaw `arrowYawFor(n)` is known-correct: it points at world
// bearing `n.bearing`. So the screen-yaw that points at north (bearing 0) is
//   northScreenYaw = arrowYawFor(n) - yawSign * n.bearing
// (same handedness the arrows already use, so whatever face-order/mirror fix is
// in config is inherited — this is what kills the old ~45deg constant offset).
// We average that over all neighbours (circular mean) for stability. This leaks
// no coordinate: bearings are already public in links.json and reveal only
// orientation, never position.
//
// Panoramas with no neighbours have no bearing data -> fall back to relative
// mode (needle = this panorama's captured-forward face), same as before.
const captureNorthCache = new Map(); // folder -> northScreenYaw (deg) or null
function northScreenYawFor(folder) {
  if (captureNorthCache.has(folder)) return captureNorthCache.get(folder);
  const yawSign = CFG.PANO_YAW_SIGN === -1 ? -1 : 1;
  // Read link data directly (not neighboursFor) so the compass keeps true-north
  // even when roaming is disabled for the game — we only need the bearings, not
  // the movement arrows.
  const raw = (state.links && state.links[folder]) || [];
  const ns = raw.filter((n) => n.bearing != null);
  let val = null;
  if (ns.length) {
    // A rendered arrow at screen-yaw arrowYawFor(n) is known to point at world
    // bearing n.bearing. screen-yaw scales with bearing by -yawSign (a larger
    // bearing lands at a smaller screen yaw), so the screen-yaw that points at
    // bearing 0 (world north) is arrowYawFor(n) + yawSign * n.bearing. Average
    // that across neighbours (circular mean) for a stable fix.
    let sx = 0, sy = 0;
    for (const n of ns) {
      const a = (arrowYawFor(n) + yawSign * n.bearing) * Math.PI / 180;
      sx += Math.cos(a); sy += Math.sin(a);
    }
    val = Math.atan2(sy, sx) * 180 / Math.PI; // circular mean, [-180,180)
  }
  captureNorthCache.set(folder, val);
  return val;
}

// Rotate the rose so NORTH sits at northScreenYaw relative to the current view
// centre. The needle is fixed at the top (screen "up" = view centre), so the
// rose's N glyph must move to (northScreenYaw - yaw). If we have no bearing data
// for this scene, fall back to the relative compass (rotate by -yaw).
function startCompassLoop() {
  const rose = $('compassRose');
  const compass = $('compass');
  if (!rose) return;
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!state.pano || !$('game').classList.contains('active')) return;
    let yaw = 0;
    try { yaw = state.pano.getYaw(); } catch (_) { return; }
    const north = northScreenYawFor(state.currentFolder);
    if (north == null) {
      rose.style.transform = `rotate(${-yaw}deg)`;
      if (compass) compass.classList.add('relative');
    } else {
      // +180: the link bearings are stored as the reciprocal of the arrow's
      // screen direction, so the derived "north" lands where south is. Flip the
      // rose half a turn so the needle actually points north.
      rose.style.transform = `rotate(${north - yaw + 180}deg)`;
      if (compass) compass.classList.remove('relative');
    }
  };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
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
    zoomControl: false,
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
    zoomControl: false,
  });
  new DynmapTileLayer('', {
    tileSize: DM.tileSize,
    minZoom: DM.minZoom,
    maxZoom: DM.maxZoom,
    minNativeZoom: DM.minZoom,
    maxNativeZoom: DM.maxNativeZoom || DM.nativeZoom,
    noWrap: true,
    errorTileUrl: BLANK_TILE,
    // Keep a modest off-screen ring so panning back doesn't flash black, but no
    // more: every buffered tile is a real upstream request. keepBuffer:8 (4x the
    // default) quadrupled our load on the third-party Dynmap. The server-side
    // tile proxy now absorbs pan/zoom bursts, so 2 is plenty here.
    keepBuffer: 2,
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
    // Team Duel: broadcast this pin live to teammates so they can see it the
    // moment it's placed (and as it moves), even before we press Guess.
    if (state.mode === 'teamduel') sendTeampinDebounced(w.x, w.z);
  });
  // Leaflet reads its container size on creation; if the game screen is still
  // animating in, it sizes to a short strip and only that strip's tiles load
  // (black elsewhere until you pan). Recalculate a few times as layout settles,
  // and once more whenever the element resizes, so the full frame fills in.
  recalcMapSize(map, 'map');
}

function recalcMapSize(map, elementId) {
  const bump = () => { if (state.map === map || state.resultMap === map || state.locationsMap === map) map.invalidateSize(); };
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
 *  "All photo locations" overview (landing page)
 *  ------------------------------------------------------------------
 *  Opens a modal with the same world map used in-game and drops a blue dot
 *  on every panorama capture spot (fetched from the public /locations.json).
 *  This reveals where photos exist, NOT which round is which, so it can't be
 *  used as an answer key during play.
 * ------------------------------------------------------------------ */
let locationsPoints = null; // cached [{x, z}, ...]

async function loadLocations() {
  if (locationsPoints) return locationsPoints;
  const r = await fetch('/locations.json');
  if (!r.ok) throw new Error('locations unavailable');
  const data = await r.json();
  locationsPoints = Array.isArray(data.points) ? data.points : [];
  return locationsPoints;
}

async function openLocationsOverlay() {
  const overlay = $('locationsOverlay');
  overlay.classList.remove('hidden');
  const countEl = $('locationsCount');

  // The world map needs mapMeta for the static-map path; the Dynmap path does
  // not. If we're not on Dynmap and haven't received mapMeta yet, fetch it.
  if (!dynmapEnabled() && !state.mapMeta) {
    try { state.mapMeta = await (await fetch('/map/map-meta.json')).json(); }
    catch { /* map will just fail to render; count still shows */ }
  }

  let points;
  try {
    points = await loadLocations();
  } catch {
    countEl.textContent = 'Could not load locations.';
    return;
  }
  countEl.textContent = `${points.length} photo${points.length === 1 ? '' : 's'} captured across the map`;

  if (state.locationsMap) { state.locationsMap.remove(); state.locationsMap = null; }
  $('locationsMap').innerHTML = '';
  const map = makeWorldMap('locationsMap');
  state.locationsMap = map;

  const lls = [];
  for (const p of points) {
    const ll = worldToLatLng(p.x, p.z);
    lls.push(ll);
    const dot = L.circleMarker(ll, {
      radius: 5, color: '#fff', weight: 1.5,
      fillColor: '#4a90d9', fillOpacity: 0.95, className: 'loc-dot',
    }).addTo(map);
    // Click a dot to see which panorama it is (folder id + world coords).
    if (p.folder) {
      const folder = p.folder;
      dot.bindPopup(
        `<b>${folder}</b><br>x ${Math.round(p.x)}, z ${Math.round(p.z)}
         <br><button class="loc-view-btn" data-folder="${folder}">View panorama</button>`,
        { className: 'loc-popup' },
      );
    }
  }
  recalcMapSize(map, 'locationsMap');
  // Frame all the dots once the container has a real size.
  if (lls.length) {
    const bounds = L.latLngBounds(lls);
    setTimeout(() => map.fitBounds(bounds.pad(0.25)), 60);
  }
}

function closeLocationsOverlay() {
  $('locationsOverlay').classList.add('hidden');
  if (state.locationsMap) { state.locationsMap.remove(); state.locationsMap = null; }
}

// Enter a free-roam Street View session for a specific panorama from the
// locations overlay. Closes the overlay and loads the panorama with movement
// enabled (if links.json is available), same as in a game round.
function viewLocationPanorama(folder) {
  closeLocationsOverlay();
  showScreen('game');
  // Ensure movement is enabled for this session (mirrors CFG.ENABLE_MOVEMENT).
  state.allowMove = true;
  loadPanorama(folder, { freshView: true });
}

/* ------------------------------------------------------------------ *
 *  Round result overlay
 * ------------------------------------------------------------------ */
// Animate a dashed polyline "drawing in" by sliding its dash offset.
function animateDash(line) {
  const el = line.getElement?.();
  if (!el) return;
  const path = el.querySelector('path');
  if (!path) return;
  let off = 0;
  path.style.strokeDashoffset = '0';
  const id = setInterval(() => {
    off -= 1;
    path.style.strokeDashoffset = String(off);
  }, 30);
  // Stop after ~1.2s; the line stays visible at full opacity.
  setTimeout(() => clearInterval(id), 1200);
}

// Count a number cell up from 0 to its target over ~1s (ease-out).
function rollUp(cell) {
  if (!cell) return;
  const target = parseInt(cell.dataset.target, 10) || 0;
  if (!target) { cell.textContent = '0'; return; }
  const dur = 1000;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    cell.textContent = Math.round(target * eased);
    if (p < 1) requestAnimationFrame(step);
    else cell.textContent = target;
  };
  requestAnimationFrame(step);
}

function showRoundResult(msg) {
  stopRoundTimer();
  if (msg.teams) { state.roundTeams = msg.teams; updateHpBars(msg.teams); }
  $('resultOverlay').classList.remove('hidden');
  $('resultTitle').textContent = `Round ${msg.index + 1} / ${msg.total} — results`;

  // Mini map showing the true location + each player's guess, GeoGuessr-style:
  // start zoomed on the player's own guess, then fly out to reveal the actual
  // location with a dashed line drawing between them.
  if (state.resultMap) { state.resultMap.remove(); state.resultMap = null; }
  $('resultMapWrap').classList.add('expanded'); // start expanded each round
  $('resultMiniMap').innerHTML = '';
  const map = makeWorldMap('resultMiniMap');
  state.resultMap = map;

  const truthLL = worldToLatLng(msg.truth.x, msg.truth.z);
  // Actual location marker (revealed after the fly-to, not immediately).
  const truthMarker = L.circleMarker(truthLL, {
    radius: 9, color: '#000', weight: 2, fillColor: '#ffd23f', fillOpacity: 1,
  }).addTo(map).bindTooltip('Actual', { permanent: true, direction: 'top' });

  // Each player's guess + a dashed line to the truth. Lines animate in (dash
  // offset slides) once the camera settles.
  const lines = [];
  let myGuessLL = null;
  for (const r of msg.results) {
    if (!r.guess) continue;
    const gll = worldToLatLng(r.guess.x, r.guess.z);
    const mine = r.clientId === state.clientId;
    if (mine) myGuessLL = gll;
    L.circleMarker(gll, {
      radius: 6, color: '#fff', weight: 2,
      fillColor: mine ? '#55c157' : '#4a90d9', fillOpacity: 1,
    }).addTo(map).bindTooltip(r.name, { direction: 'top' });
    const line = L.polyline([gll, truthLL], {
      color: mine ? '#55c157' : '#4a90d9', weight: 2, dashArray: '6',
      opacity: 0,
    }).addTo(map);
    lines.push(line);
  }
  recalcMapSize(map, 'resultMiniMap');

  // Open on the player's guess, then fly to fit guess + actual so the line is
  // revealed dramatically. Fall back to fitting the truth if this player didn't
  // guess.
  const startLL = myGuessLL || truthLL;
  map.setView(startLL, (DM && DM.maxNativeZoom) || 6, { animate: false });
  setTimeout(() => {
    const bounds = L.latLngBounds(myGuessLL ? [myGuessLL, truthLL] : [truthLL]);
    map.flyToBounds(bounds.pad(0.4), { duration: 1.1, easeLinearity: 0.25 });
    // Reveal the actual marker + draw the lines once the camera lands.
    setTimeout(() => {
      truthMarker.getElement()?.classList?.add('reveal-pop');
      for (const line of lines) {
        line.setStyle({ opacity: 0.9 });
        animateDash(line);
      }
    }, 900);
  }, 350);

  // Results table sorted by round score. Round score counts up from 0
  // (GeoGuessr-style number roll) instead of appearing instantly.
  const rows = msg.results.slice().sort((a, b) => b.score - a.score);
  const t = $('resultTable');
  t.innerHTML = '<tr><th>Player</th><th class="num">Distance</th><th class="num">Round</th><th class="num">Total</th></tr>';
  const rollCells = [];
  for (const r of rows) {
    const tr = document.createElement('tr');
    const mine = r.clientId === state.clientId;
    tr.innerHTML =
      `<td class="${mine ? 'you' : ''}">${escapeHtml(r.name)}</td>` +
      `<td class="num">${r.distance == null ? '—' : r.distance + ' blk'}</td>` +
      `<td class="num roll" data-target="${r.score}">0</td>` +
      `<td class="num">${r.totalScore}</td>`;
    t.appendChild(tr);
    rollCells.push(tr.querySelector('.roll'));
  }
  // Kick off the count-up once the map reveal begins.
  setTimeout(() => rollCells.forEach((c) => rollUp(c)), 1000);

  // Damage summary (duel modes) — who lost how much HP this round.
  const dmgEl = $('resultDamage');
  if (msg.damage && msg.damage.length) {
    const lines = msg.damage.slice().sort((a, b) => a.dmg - b.dmg).map((d) => {
      const hit = d.dmg > 0 ? `−${d.dmg} HP` : 'no damage';
      return `<div class="${d.dmg > 0 ? 'dmg-hit' : 'dmg-safe'}">${escapeHtml(d.label)}: ${hit} · ${d.hp} HP left</div>`;
    });
    dmgEl.innerHTML = lines.join('');
    dmgEl.classList.remove('hidden');
  } else {
    dmgEl.classList.add('hidden');
  }

  // Knockout / win banner on the result map (sudden death ends the game here,
  // not in a separate window). Replace Next round with a Back-to-lobby action.
  const ko = $('knockoutBanner');
  if (msg.finished && msg.winner) {
    clearReconnect(); // game ended (sudden death) — don't offer to rejoin
    ko.textContent = msg.reason === 'death'
      ? `${msg.winner} wins by knockout!`
      : `${msg.winner} wins!`;
    ko.classList.remove('hidden');
    $('nextBtn').classList.add('hidden');
    $('waitNext').classList.add('hidden');
    const back = $('nextBtn');
    back.classList.remove('hidden');
    back.textContent = 'Back to lobby';
    back.onclick = () => location.reload();
  } else {
    ko.classList.add('hidden');
    const last = msg.index + 1 >= msg.total;
    $('nextBtn').classList.toggle('hidden', !state.isHost);
    $('nextBtn').textContent = last ? 'See final scores' : 'Next round';
    $('nextBtn').onclick = () => sendWS({ t: 'next' });
    $('waitNext').classList.toggle('hidden', state.isHost);
  }
}

function showFinal(msg) {
  stopRoundTimer();
  clearReconnect(); // game is over — no point rejoining a finished room
  const board = Array.isArray(msg) ? msg : msg.board;
  const winner = msg && msg.winner;
  const reason = msg && msg.reason;
  const teams = msg && msg.teams;
  // Sudden-death knockouts are shown as a banner on the result map (handled in
  // showRoundResult), so don't pop a separate final window for those.
  if (reason === 'death') return;
  $('finalOverlay').classList.remove('hidden');
  $('hpSelf').classList.add('hidden');
  $('hpOpp').classList.add('hidden');

  // Winner banner for duel modes.
  const wEl = $('finalWinner');
  if (winner) {
    wEl.classList.remove('hidden');
    wEl.textContent = reason === 'death'
      ? `${winner} wins by knockout!`
      : `${winner} wins on HP!`;
  } else {
    wEl.classList.add('hidden');
  }

  // Final team HP table (duel modes).
  const teamsEl = $('finalTeams');
  if (teams && teams.length) {
    teamsEl.classList.remove('hidden');
    teamsEl.innerHTML = teams.slice().sort((a, b) => b.hp - a.hp)
      .map((t) => `<div class="final-team"><span>${escapeHtml(t.label)}</span><span>${t.hp} / ${t.maxHp} HP</span></div>`)
      .join('');
  } else {
    teamsEl.classList.add('hidden');
  }

  $('finalTitle').textContent = winner ? 'Game over' : 'Final scores';
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
  startCompassLoop();

  // Load the movement graph (relative bearings only — safe to expose).
  if (CFG.ENABLE_MOVEMENT) {
    fetch('/links.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { state.links = data && data.links ? data.links : null; })
      .catch(() => { state.links = null; });
  }

  // --- Settings + gear popover ---
  loadSettings();
  $('settingsBtn').onclick = (e) => {
    e.stopPropagation();
    $('settingsPopover').classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    const pop = $('settingsPopover');
    if (pop.classList.contains('hidden')) return;
    if (!pop.contains(e.target) && e.target !== $('settingsBtn')) pop.classList.add('hidden');
  });
  $('disableChatInput').onchange = () => {
    state.settings.disableChat = $('disableChatInput').checked;
    saveSettings();
    setChatAvailable(state.mode === 'teamduel');
  };

  // --- Tabs (Create / Join / Browse) ---
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t2 of document.querySelectorAll('.tab')) t2.classList.remove('active');
      tab.classList.add('active');
      const which = tab.dataset.tab;
      for (const p of document.querySelectorAll('.tab-pane')) {
        p.classList.toggle('active', p.dataset.pane === which);
      }
      // Subscribe to the live public-rooms list only while Browse is open.
      if (which === 'browse') sendWS({ t: 'browse' });
      else sendWS({ t: 'browseclose' });
    };
  }

  $('createBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    // Options default on the server (classic, 5 rounds, no time, move on,
    // private). The host edits them inside the room.
    sendWS({ t: 'create', name });
  };
  $('joinBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) { $('lobbyError').textContent = 'Enter a room code.'; return; }
    sendWS({ t: 'join', code, name });
  };

  // Reconnect to a remembered room (slot/score/team preserved server-side).
  $('reconnectBtn').onclick = doReconnect;
  showReconnectButton(); // in case we land on the lobby with a saved session

  // --- "View all photo locations" overview ---
  $('viewLocationsBtn').onclick = openLocationsOverlay;
  $('closeLocationsBtn').onclick = closeLocationsOverlay;
  $('locationsOverlay').addEventListener('click', (e) => {
    // Click on the dimmed backdrop (not the card) closes it.
    if (e.target === $('locationsOverlay')) closeLocationsOverlay();
    // "View panorama" button in a dot popup
    if (e.target.matches('.loc-view-btn')) {
      const folder = e.target.dataset.folder;
      if (folder) viewLocationPanorama(folder);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('locationsOverlay').classList.contains('hidden')) {
      closeLocationsOverlay();
    }
  });

  // --- Room options panel: host edits broadcast via setoptions (debounced) ---
  let optTimer = null;
  function pushOptions() {
    if (!state.isHost) return;
    const opts = {
      mode: $('optMode').value,
      rounds: parseInt($('optRounds').value, 10) || 5,
      roundTime: parseInt($('optTime').value, 10) || 0,
      hp: parseInt($('optHp').value, 10) || 6000,
      allowMove: $('optMove').checked,
      isPublic: $('optPublic').checked,
    };
    sendWS({ t: 'setoptions', ...opts });
  }
  function optChanged() {
    $('timeReadout').textContent = parseInt($('optTime').value, 10)
      ? `${$('optTime').value}s` : 'No limit';
    const duel = $('optMode').value !== 'classic';
    $('optHpField').classList.toggle('hidden', !duel);
    $('optRoundsField').classList.toggle('hidden', duel);
    if (optTimer) clearTimeout(optTimer);
    optTimer = setTimeout(pushOptions, 200);
  }
  for (const id of ['optMode', 'optRounds', 'optTime', 'optHp', 'optMove', 'optPublic']) {
    const el = $(id);
    if (el) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', optChanged);
  }

  // Copy room code.
  $('copyCodeBtn').onclick = () => {
    const code = $('roomCode').textContent;
    navigator.clipboard?.writeText(code).catch(() => {});
  };

  $('startBtn').onclick = () => sendWS({ t: 'start' });
  $('leaveBtn').onclick = () => sendWS({ t: 'leave' });
  $('guessBtn').onclick = submitGuess;
  $('nextBtn').onclick = () => sendWS({ t: 'next' });
  $('playAgainBtn').onclick = () => location.reload();
  $('expandMapBtn').onclick = () => {
    $('mapPanel').classList.toggle('expanded');
    if (state.map) state.map.invalidateSize();
  };
  $('expandResultMapBtn').onclick = () => {
    $('resultMapWrap').classList.toggle('expanded');
    if (state.resultMap) state.resultMap.invalidateSize();
  };
  $('backToStartBtn').onclick = () => {
    if (state.startFolder) moveTo(state.startFolder);
  };

  // --- Team chat wiring ---
  $('chatTab').onclick = openChat;
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); $('chatInput').blur(); closeChat(); }
    e.stopPropagation();
  });
  $('chatInput').addEventListener('input', resetChatHideTimer);
  $('teamChat').addEventListener('mousemove', resetChatHideTimer);

  // Arrow-key roaming (Street-View style). Direction is relative to where you're
  // currently looking: Up = walk toward what's ahead, Left/Right/Down likewise.
  // Capture phase + stopPropagation so Pannellum doesn't also pan the view on
  // the same key. Ignored while typing in a field or when the map has focus.
  const KEY_DEG = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: -90 };
  window.addEventListener('keydown', (e) => {
    // 'T' toggles team chat (only when not typing in some other field, and only
    // in team duel with chat enabled). If the chat input is focused, let 't'
    // type normally.
    if (e.key === 't' || e.key === 'T') {
      if (e.target === $('chatInput')) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (state.mode === 'teamduel' && !state.settings.disableChat) {
        e.preventDefault();
        if (state.chatOpen) closeChat(); else openChat();
      }
      return;
    }
    if (!(e.target === document.body || $('panorama').contains(e.target))) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    }
    if (!CFG.ENABLE_MOVEMENT || !state.allowMove) return;
    if (!$('game').classList.contains('active')) return;
    const deg = KEY_DEG[e.key];
    if (deg === undefined) return;
    if (roamRelative(deg)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
});
