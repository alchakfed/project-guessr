/**
 * server.js — static file server + WebSocket game rooms.
 *
 * Multiplayer, no accounts. Clients connect over WebSocket, create/join a room
 * by code, and play synchronized rounds. The server holds the answer key
 * (manifest) and only reveals a round's true coordinates after it's scored.
 *
 * Protocol (JSON messages):
 *   client -> server: {t:'create', name, rounds?}   -> {t:'joined', ...}
 *                     {t:'join', code, name}         -> {t:'joined', ...} | {t:'error'}
 *                     {t:'start'}                    (host only)
 *                     {t:'guess', x, z}
 *                     {t:'next'}                     (host only, after roundover)
 *   server -> client: {t:'joined', code, clientId, isHost, players}
 *                     {t:'lobby', players, hostId}
 *                     {t:'round', index, total, id, folder}   (no coords!)
 *                     {t:'roundresult', truth, results}
 *                     {t:'scoreboard', board}
 *                     {t:'finished', board}
 *                     {t:'error', message}
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, Room, makeRoomCode } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Load game data (fail fast with a helpful message) --------------------
let manifest, mapMeta;
try {
  const loaded = loadManifest(
    path.join(PUBLIC_DIR, 'manifest.json'),
    path.join(PUBLIC_DIR, 'map', 'map-meta.json')
  );
  manifest = loaded.manifest;
  mapMeta = loaded.mapMeta;
  console.log(`[server] Loaded ${manifest.rounds.length} rounds.`);
} catch (e) {
  console.error('\n[server] Could not load game data: ' + e.message);
  console.error('[server] Run the tools/ scripts (build-map, build-manifest, copy-panoramas) first.\n');
  process.exit(1);
}

// --- HTTP + static ---------------------------------------------------------
const app = express();
// The manifest is the ANSWER KEY (true coordinates for every round). The server
// reads it from disk, but it must never be downloadable by the client — block it
// before the static middleware can serve it. links.json is safe (relative
// bearings only) and stays public for the movement arrows.
app.get('/manifest.json', (_req, res) => res.status(404).end());

// --- Dynmap tile proxy + cache --------------------------------------------
// The guess map streams tiles from a THIRD-PARTY live Dynmap (map.ccnetmc.com).
// Hotlinking it directly means every player, every pan, and every zoom hits
// their server anew — thousands of requests to a server we don't own, and a
// reliable way to get rate-limited/blocked (which shows up as black tiles).
// Proxy tiles through here with a short-lived cache + request coalescing so
// each unique tile is fetched upstream at most once per TTL no matter how many
// players are looking, and send a real User-Agent they can identify us by.
// To take ZERO third-party load, set DYNMAP.enabled=false in config.js (the game
// falls back to the bundled map.png) — this proxy is only used when it's on.
const DYNMAP_UPSTREAM = process.env.DYNMAP_UPSTREAM || 'https://map.ccnetmc.com/nationsmap/tiles';
const TILE_TTL_MS = 60_000;     // live map; 60s dedups request bursts without going stale
const TILE_CACHE_MAX = 3000;    // a few MB of webp tiles; oldest evicted past this
const tileCache = new Map();    // relPath -> { buf, type, ts }   (Map = insertion-ordered LRU)
const tileInflight = new Map(); // relPath -> Promise  (coalesce concurrent identical fetches)

// 1x1 transparent PNG for empty/ungenerated regions and upstream misses.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64');

function tileCacheGet(key) {
  const hit = tileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TILE_TTL_MS) { tileCache.delete(key); return null; }
  tileCache.delete(key); tileCache.set(key, hit); // refresh LRU recency
  return hit;
}
function tileCacheSet(key, val) {
  tileCache.set(key, val);
  while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
}

async function fetchTile(relPath) {
  const cached = tileCacheGet(relPath);
  if (cached) return cached;
  if (tileInflight.has(relPath)) return tileInflight.get(relPath);
  const p = (async () => {
    const r = await fetch(`${DYNMAP_UPSTREAM}/${relPath}`, {
      headers: {
        'User-Agent': 'ProjectGuessr/1.0 (hobby Minecraft GeoGuessr; caching tile proxy)',
        'Referer': 'https://map.ccnetmc.com/nationsmap',
        'Accept': 'image/webp,image/png,*/*',
      },
    });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const type = r.headers.get('content-type') || 'image/webp';
    const val = { buf: Buffer.from(await r.arrayBuffer()), type, ts: Date.now() };
    tileCacheSet(relPath, val);
    return val;
  })().finally(() => tileInflight.delete(relPath));
  tileInflight.set(relPath, p);
  return p;
}

app.get('/dyntiles/*', async (req, res) => {
  const rel = req.params[0];
  // Only ever proxy the exact Dynmap tile shape; never let a path escape upstream.
  if (rel.includes('..') || !/^[\w/-]+\.(webp|png|jpg|jpeg)$/i.test(rel)) return res.status(400).end();
  try {
    const { buf, type } = await fetchTile(rel);
    res.set('Content-Type', type);
    res.set('Cache-Control', 'public, max-age=60');
    res.send(buf);
  } catch {
    // Ungenerated region or upstream hiccup: serve a blank tile so the client
    // shows empty space (not a broken image) and doesn't retry-storm upstream.
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=30');
    res.send(BLANK_PNG);
  }
});

app.use(express.static(PUBLIC_DIR));
const server = http.createServer(app);

// --- WebSocket rooms -------------------------------------------------------
const wss = new WebSocketServer({ server });
const rooms = new Map();       // code -> Room
let clientSeq = 0;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const p of room.players.values()) send(p.ws, obj);
}

function playerList(room) {
  return [...room.players.entries()].map(([clientId, p]) => ({
    clientId, name: p.name, isHost: clientId === room.hostId, team: p.team ?? null,
  }));
}

// Everything the client needs to render the lobby: roster + the shared options.
function lobbyMsg(room) {
  return {
    t: 'lobby',
    players: playerList(room),
    hostId: room.hostId,
    mode: room.mode,
    hp: room.startHp,
    roundTime: room.roundTime,
    allowMove: room.allowMove,
    isPublic: room.isPublic,
    code: room.code,
  };
}

// --- Lobby browser: a set of sockets currently viewing the public-rooms list.
// They get a refreshed list whenever a public room's lobby state changes. ---
const browsers = new Set();
function browseList() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.isPublic || room.state !== 'lobby') continue;
    const host = room.players.get(room.hostId);
    out.push({
      code: room.code,
      name: host ? host.name + "'s room" : 'Public room',
      mode: room.mode,
      players: room.players.size,
    });
  }
  return { t: 'browselist', rooms: out };
}
function pushBrowseList() {
  const msg = browseList();
  for (const ws of browsers) send(ws, msg);
}

// --- Per-round countdown timer (only when roundTime > 0) -------------------
// The server is authoritative: when the timer fires we reveal the round with
// whatever guesses have arrived. The client shows a cosmetic mirror countdown.
const roundTimers = new Map(); // roomCode -> Timeout
function clearRoundTimer(room) {
  const t = roundTimers.get(room.code);
  if (t) { clearTimeout(t); roundTimers.delete(room.code); }
}
function armRoundTimer(room) {
  clearRoundTimer(room);
  if (!room.roundTime) return;
  roundTimers.set(room.code, setTimeout(() => {
    roundTimers.delete(room.code);
    if (room.state === 'playing') revealRound(room);
  }, room.roundTime * 1000));
}

function sendRound(room) {
  const r = room.currentRound();
  if (!r) return;
  armRoundTimer(room);
  // Deliberately omit x/z — the client must not know the answer.
  broadcast(room, {
    t: 'round',
    index: room.roundIndex,
    total: room.rounds.length,
    id: r.id,
    folder: r.folder || r.id,
    roundTime: room.roundTime,
    allowMove: room.allowMove,
    mode: room.mode,
    teams: room.teamsSnapshot(),
    deadline: room.roundTime ? Date.now() + room.roundTime * 1000 : null,
  });
}

wss.on('connection', (ws) => {
  ws.clientId = 'c' + (++clientSeq);
  ws.roomCode = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    browsers.delete(ws);
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const wasPublic = room.isPublic;
    room.removePlayer(ws.clientId);
    if (room.isEmpty()) {
      clearRoundTimer(room);
      rooms.delete(room.code);
      if (wasPublic) pushBrowseList();
    } else {
      broadcast(room, lobbyMsg(room));
      if (wasPublic) pushBrowseList();
    }
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      let code;
      do { code = makeRoomCode(); } while (rooms.has(code));
      const room = new Room(code, manifest.rounds, mapMeta, {
        rounds: msg.rounds, mode: msg.mode, hp: msg.hp,
        roundTime: msg.roundTime, allowMove: msg.allowMove, isPublic: msg.isPublic,
      });
      rooms.set(code, room);
      joinRoom(ws, room, msg.name);
      pushBrowseList();
      break;
    }
    case 'join': {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) { send(ws, { t: 'error', message: 'Room not found' }); return; }
      if (room.state !== 'lobby') { send(ws, { t: 'error', message: 'Game already started' }); return; }
      joinRoom(ws, room, msg.name);
      break;
    }
    // Lobby browser: this socket wants the public-rooms list (sent immediately
    // and on every public-room change until it sends browseclose / disconnects).
    case 'browse': {
      browsers.add(ws);
      send(ws, browseList());
      break;
    }
    case 'browseclose': {
      browsers.delete(ws);
      break;
    }
    case 'setoptions': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      const wasPublic = room.isPublic;
      room.setOptions(msg);
      broadcast(room, lobbyMsg(room));
      if (room.isPublic || wasPublic) pushBrowseList();
      break;
    }
    case 'setteam': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      if (room.setTeam(msg.clientId, msg.team)) broadcast(room, lobbyMsg(room));
      break;
    }
    case 'kick': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      const victimWs = room.kick(msg.clientId);
      if (victimWs) {
        send(victimWs, { t: 'kicked' });
        victimWs.roomCode = null;
        broadcast(room, lobbyMsg(room));
        if (room.isPublic) pushBrowseList();
      }
      break;
    }
    case 'start': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      room.startGame(Date.now() ^ (clientSeq << 8));
      sendRound(room);
      break;
    }
    case 'guess': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const ok = room.submitGuess(ws.clientId, Number(msg.x), Number(msg.z));
      if (!ok) return;
      // Let everyone see who has locked in (teammate pins already arrived live
      // via 'teampin', so no separate relay is needed here).
      broadcast(room, { t: 'guessed', clientId: ws.clientId, count: room.guesses.size, total: room.players.size });
      if (room.allGuessed()) revealRound(room);
      break;
    }
    // Live teammate pin: sent on placement/move (not on lock). Team-duel only,
    // during a round. Relayed to teammates only — leaks no answer (it's the
    // player's own guess, never the truth) and never crosses teams.
    case 'teampin': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.state !== 'playing' || room.mode !== 'teamduel') return;
      const myTeam = room.teamKeyOf(ws.clientId);
      const me = room.players.get(ws.clientId);
      if (!me) return;
      const payload = { t: 'teampin', clientId: ws.clientId, name: me.name, x: Number(msg.x), z: Number(msg.z) };
      for (const [cid, p] of room.players) {
        if (cid === ws.clientId) continue;
        if (room.teamKeyOf(cid) === myTeam) send(p.ws, payload);
      }
      break;
    }
    // Team chat: team-duel only, short, server-truncated. Relayed to teammates.
    case 'chat': {
      const room = rooms.get(ws.roomCode);
      if (!room || room.mode !== 'teamduel') return;
      const me = room.players.get(ws.clientId);
      if (!me) return;
      const text = String(msg.text || '').slice(0, 200).trim();
      if (!text) return;
      const myTeam = room.teamKeyOf(ws.clientId);
      const payload = { t: 'chat', clientId: ws.clientId, name: me.name, text };
      for (const [cid, p] of room.players) {
        if (room.teamKeyOf(cid) === myTeam) send(p.ws, payload);
      }
      break;
    }
    case 'forcereveal': {
      // Host can end a round early even if not everyone guessed.
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      if (room.state === 'playing') revealRound(room);
      break;
    }
    case 'next': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      if (room.state !== 'roundover') return;
      room.nextRound();
      if (room.state === 'finished') {
        broadcast(room, { t: 'finished', board: room.scoreboard(),
          teams: room.teamsSnapshot(), winner: room.winner, reason: room.endReason });
      } else {
        sendRound(room);
      }
      break;
    }
  }
}

function joinRoom(ws, room, name) {
  const clean = (name || 'Player').toString().slice(0, 24);
  room.addPlayer(ws.clientId, clean, ws);
  ws.roomCode = room.code;
  send(ws, {
    t: 'joined',
    code: room.code,
    clientId: ws.clientId,
    isHost: ws.clientId === room.hostId,
    mapMeta,
  });
  broadcast(room, lobbyMsg(room));
  if (room.isPublic) pushBrowseList();
}

function revealRound(room) {
  clearRoundTimer(room);
  const { truth, results, teams, damage } = room.scoreRound();
  const finished = room.state === 'finished'; // sudden death ended the game
  broadcast(room, {
    t: 'roundresult', truth, results, teams, damage,
    mode: room.mode, index: room.roundIndex, total: room.rounds.length,
    finished, winner: room.winner, reason: room.endReason,
  });
  broadcast(room, { t: 'scoreboard', board: room.scoreboard() });
  // For sudden-death finishes, the roundresult already carries the winner so the
  // client renders the knockout banner on the result map. We still broadcast a
  // 'finished' so any late/summary logic sees the terminal state, but the UI
  // keys off roundresult.finished to avoid a second separate window.
  if (finished) {
    broadcast(room, { t: 'finished', board: room.scoreboard(),
      teams: room.teamsSnapshot(), winner: room.winner, reason: room.endReason });
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

server.listen(PORT, () => {
  console.log(`\n[server] ProjectGuessr running:`);
  console.log(`         Local:   http://localhost:${PORT}`);
  console.log(`         LAN:     http://<your-ip>:${PORT}  (share this with friends on your network)\n`);
});
