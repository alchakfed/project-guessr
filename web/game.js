/**
 * game.js — server-side game logic: room state, round selection, scoring.
 *
 * No accounts. A room is identified by a short code. Players join with a display
 * name kept only in memory. The manifest (answer key) is loaded once at startup;
 * true coordinates are NEVER sent to clients until a round is scored.
 */

import fs from 'node:fs';

export function loadManifest(manifestPath, mapMetaPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mapMeta = JSON.parse(fs.readFileSync(mapMetaPath, 'utf8'));
  if (!manifest.rounds || manifest.rounds.length === 0) {
    throw new Error('Manifest has no rounds. Run the tools/ scripts first.');
  }
  return { manifest, mapMeta };
}

/**
 * GeoGuessr-style score: 5000 at distance 0, decaying exponentially with
 * distance. The decay is scaled to the map size so scoring feels consistent
 * regardless of world scale — a guess off by ~the map's diagonal scores ~0.
 */
export function scoreGuess(guess, truth, mapMeta) {
  const dx = guess.x - truth.x;
  const dz = guess.z - truth.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  const spanX = mapMeta.worldMaxX - mapMeta.worldMinX;
  const spanZ = mapMeta.worldMaxZ - mapMeta.worldMinZ;
  const diagonal = Math.sqrt(spanX * spanX + spanZ * spanZ);

  // Characteristic distance where score falls to ~1800 (5000/e). ~12% of the
  // map diagonal — tuned so close guesses are rewarded but not trivially.
  const scale = Math.max(1, diagonal * 0.12);
  const score = Math.round(5000 * Math.exp(-dist / scale));
  return { score, distance: Math.round(dist) };
}

let roomSeq = 0;

export function makeRoomCode() {
  // Human-friendly 4-char code, avoiding ambiguous chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  // Mix a sequence counter with derived characters for uniqueness without RNG.
  roomSeq++;
  let n = roomSeq * 2654435761 % (alphabet.length ** 4);
  for (let i = 0; i < 4; i++) {
    code += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length);
  }
  return code;
}

/**
 * Picks N distinct rounds from the manifest. Deterministic per-room shuffle
 * seeded by a number so the server never needs Math.random (and rooms differ).
 */
export function pickRounds(allRounds, count, seed) {
  const pool = allRounds.slice();
  // Fisher–Yates with a simple LCG seeded by `seed`.
  let s = (seed >>> 0) || 1;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

export class Room {
  constructor(code, allRounds, mapMeta, roundsPerGame = 5) {
    this.code = code;
    this.allRounds = allRounds;
    this.mapMeta = mapMeta;
    this.roundsPerGame = roundsPerGame;
    this.players = new Map();   // clientId -> { name, ws, totalScore }
    this.hostId = null;
    this.state = 'lobby';       // lobby | playing | roundover | finished
    this.rounds = [];           // selected rounds for this game
    this.roundIndex = -1;
    this.guesses = new Map();    // clientId -> { x, z } for the current round
  }

  addPlayer(clientId, name, ws) {
    if (!this.hostId) this.hostId = clientId;
    this.players.set(clientId, { name, ws, totalScore: 0 });
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
    this.guesses.delete(clientId);
    if (clientId === this.hostId) {
      // Promote the next player to host, if any.
      this.hostId = this.players.keys().next().value || null;
    }
  }

  isEmpty() {
    return this.players.size === 0;
  }

  startGame(seed) {
    this.rounds = pickRounds(this.allRounds, this.roundsPerGame, seed);
    this.roundIndex = -1;
    for (const p of this.players.values()) p.totalScore = 0;
    this.nextRound();
  }

  nextRound() {
    this.roundIndex++;
    this.guesses.clear();
    if (this.roundIndex >= this.rounds.length) {
      this.state = 'finished';
    } else {
      this.state = 'playing';
    }
  }

  currentRound() {
    return this.rounds[this.roundIndex] || null;
  }

  /** True once every connected player has submitted a guess this round. */
  allGuessed() {
    return this.players.size > 0 && this.guesses.size >= this.players.size;
  }

  submitGuess(clientId, x, z) {
    if (this.state !== 'playing') return false;
    if (this.guesses.has(clientId)) return false;
    this.guesses.set(clientId, { x, z });
    return true;
  }

  /** Score everyone for the current round; returns per-player results. */
  scoreRound() {
    const round = this.currentRound();
    const truth = { x: round.x, z: round.z };
    const results = [];
    for (const [clientId, player] of this.players) {
      const g = this.guesses.get(clientId);
      let entry;
      if (g) {
        const { score, distance } = scoreGuess(g, truth, this.mapMeta);
        player.totalScore += score;
        entry = { clientId, name: player.name, guess: g, score, distance,
                  totalScore: player.totalScore };
      } else {
        entry = { clientId, name: player.name, guess: null, score: 0,
                  distance: null, totalScore: player.totalScore };
      }
      results.push(entry);
    }
    this.state = 'roundover';
    return { truth, results };
  }

  scoreboard() {
    return [...this.players.entries()]
      .map(([clientId, p]) => ({ clientId, name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);
  }
}
