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
    clientId, name: p.name, isHost: clientId === room.hostId,
  }));
}

function sendRound(room) {
  const r = room.currentRound();
  if (!r) return;
  // Deliberately omit x/z — the client must not know the answer.
  broadcast(room, {
    t: 'round',
    index: room.roundIndex,
    total: room.rounds.length,
    id: r.id,
    folder: r.folder || r.id,
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
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.removePlayer(ws.clientId);
    if (room.isEmpty()) {
      rooms.delete(room.code);
    } else {
      broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId });
    }
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      let code;
      do { code = makeRoomCode(); } while (rooms.has(code));
      const roundsPerGame = clamp(parseInt(msg.rounds, 10) || 5, 1, manifest.rounds.length);
      const room = new Room(code, manifest.rounds, mapMeta, roundsPerGame);
      rooms.set(code, room);
      joinRoom(ws, room, msg.name);
      break;
    }
    case 'join': {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) { send(ws, { t: 'error', message: 'Room not found' }); return; }
      if (room.state !== 'lobby') { send(ws, { t: 'error', message: 'Game already started' }); return; }
      joinRoom(ws, room, msg.name);
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
      // Let everyone see who has locked in.
      broadcast(room, { t: 'guessed', clientId: ws.clientId, count: room.guesses.size, total: room.players.size });
      if (room.allGuessed()) revealRound(room);
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
        broadcast(room, { t: 'finished', board: room.scoreboard() });
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
  broadcast(room, { t: 'lobby', players: playerList(room), hostId: room.hostId });
}

function revealRound(room) {
  const { truth, results } = room.scoreRound();
  broadcast(room, { t: 'roundresult', truth, results, index: room.roundIndex, total: room.rounds.length });
  broadcast(room, { t: 'scoreboard', board: room.scoreboard() });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

server.listen(PORT, () => {
  console.log(`\n[server] ProjectGuessr running:`);
  console.log(`         Local:   http://localhost:${PORT}`);
  console.log(`         LAN:     http://<your-ip>:${PORT}  (share this with friends on your network)\n`);
});
