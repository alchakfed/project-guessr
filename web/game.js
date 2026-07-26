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
  constructor(code, allRounds, mapMeta, opts = {}) {
    this.code = code;
    this.allRounds = allRounds;
    this.mapMeta = mapMeta;
    // --- Options (all mutable in the lobby by the host via setOptions) ---
    this.roundsPerGame = clampInt(opts.rounds, 1, allRounds.length, 5);
    this.mode = ['classic', 'duel', 'teamduel'].includes(opts.mode) ? opts.mode : 'classic';
    this.startHp = clampInt(opts.hp, 100, 100000, 6000);
    this.roundTime = clampInt(opts.roundTime, 0, 600, 100); // seconds; 0 = no limit
    this.allowMove = opts.allowMove !== false;             // default on
    this.isPublic = !!opts.isPublic;                       // listed in lobby browser

    this.players = new Map();   // clientId -> { name, ws, totalScore, team }
    this.hostId = null;
    this.state = 'lobby';       // lobby | playing | roundover | finished
    this.rounds = [];           // selected rounds for this game
    this.roundIndex = -1;
    this.guesses = new Map();    // clientId -> { x, z } for the current round
    this.hpByTeam = new Map();   // teamKey -> current HP (duel modes only)
    this.winner = null;          // set when a duel ends (label string)
    this.endReason = null;       // 'death' | 'rounds' | null
    this.roundStartedAt = null;  // epoch ms the current round began (for deadline math)
  }

  isDuel() { return this.mode === 'duel' || this.mode === 'teamduel'; }

  // The team a player belongs to for scoring/HP purposes.
  //   teamduel -> '0' or '1' (a shared side)
  //   duel     -> the player's own clientId (each is their own side)
  //   classic  -> null (no HP)
  teamKeyOf(clientId) {
    const p = this.players.get(clientId);
    if (!p) return null;
    if (this.mode === 'teamduel') return String(p.team == null ? 0 : p.team);
    if (this.mode === 'duel') return clientId;
    return null;
  }

  teamLabel(teamKey) {
    if (this.mode === 'teamduel') return teamKey === '1' ? 'Team B' : 'Team A';
    if (this.mode === 'duel') {
      const p = this.players.get(teamKey);
      return p ? p.name : 'Player';
    }
    return '';
  }

  addPlayer(clientId, name, ws, reconnectKey = null) {
    if (!this.hostId) this.hostId = clientId;
    // Team-duel joiners land on the smaller side so teams stay balanced.
    let team = null;
    if (this.mode === 'teamduel') team = this.smallerTeam();
    this.players.set(clientId, {
      name, ws, totalScore: 0, team,
      reconnectKey, disconnectedAt: null,
    });
  }

  // Find an existing slot by reconnect key (e.g. a player who dropped and is
  // coming back). Returns the clientId or null.
  findSlotByKey(reconnectKey) {
    if (!reconnectKey) return null;
    for (const [cid, p] of this.players) {
      if (p.reconnectKey === reconnectKey) return cid;
    }
    return null;
  }

  // Mark a player disconnected but KEEP their slot (score, team, host status,
  // AND any guess they already locked in this round) for a grace window so they
  // can reconnect. Returns true if the slot was preserved (caller should
  // broadcast a lobby update showing them as offline), false if they were
  // removed outright (no key -> no reconnect possible).
  //
  // `closingWs` is the WebSocket whose close triggered this. If the player has
  // ALREADY reconnected on a different socket (p.ws !== closingWs), this close
  // is STALE — the old socket finally closing after the new one took over — and
  // must be ignored, or it would null out the live connection and silently cut
  // the reconnected player off from all further broadcasts.
  disconnect(clientId, closingWs) {
    const p = this.players.get(clientId);
    if (!p) return false;
    if (closingWs && p.ws && p.ws !== closingWs) {
      // Stale close from a superseded socket; the player is already back on a
      // new ws. Ignore it entirely.
      return p.disconnectedAt == null ? false : true;
    }
    // NOTE: we deliberately do NOT delete this.guesses[clientId]. A guess they
    // locked in before dropping should still count (and be restored on
    // reconnect). allGuessed() already skips disconnected players, so keeping
    // the guess can't stall the round.
    p.ws = null;
    if (p.reconnectKey) {
      p.disconnectedAt = Date.now();
      return true; // preserved for grace window
    }
    // No reconnect key: drop them for real (legacy behaviour).
    this.players.delete(clientId);
    if (clientId === this.hostId) {
      this.hostId = this.players.keys().next().value || null;
    }
    return false;
  }

  // Revive a preserved slot on a new ws. Restores the same clientId so score,
  // team, and host status carry over. Returns the clientId, or null if the
  // slot is gone (expired / not found).
  reconnect(clientId, ws) {
    const p = this.players.get(clientId);
    if (!p || !p.reconnectKey || p.disconnectedAt == null) return false;
    p.ws = ws;
    p.disconnectedAt = null;
    return true;
  }

  // Expire any disconnected slots past the grace window. Call periodically.
  static GRACE_MS = 5 * 60_000;
  sweep(now = Date.now()) {
    const expired = [];
    for (const [cid, p] of this.players) {
      if (p.disconnectedAt != null && now - p.disconnectedAt > Room.GRACE_MS) {
        expired.push(cid);
      }
    }
    for (const cid of expired) {
      this.players.delete(cid);
      if (cid === this.hostId) this.hostId = this.players.keys().next().value || null;
    }
    return expired;
  }

  // Which of the two teams (0/1) currently has fewer members (ties -> 0).
  smallerTeam() {
    let a = 0, b = 0;
    for (const p of this.players.values()) {
      if (p.team === 1) b++; else a++;
    }
    return b < a ? 1 : 0;
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

  // --- Host-only lobby operations (server validates the caller is host) ---
  setTeam(clientId, team) {
    if (this.state !== 'lobby' || this.mode !== 'teamduel') return false;
    const p = this.players.get(clientId);
    if (!p) return false;
    p.team = team === 1 || team === '1' ? 1 : 0;
    return true;
  }

  // Remove a player by host request. Returns the removed player's ws (so the
  // caller can notify + close it), or null if not found / illegal.
  kick(clientId) {
    if (clientId === this.hostId) return null; // host can't kick self
    const p = this.players.get(clientId);
    if (!p) return null;
    this.removePlayer(clientId);
    return p.ws;
  }

  setOptions(opts = {}) {
    if (this.state !== 'lobby') return;
    if (opts.rounds != null) this.roundsPerGame = clampInt(opts.rounds, 1, this.allRounds.length, this.roundsPerGame);
    if (opts.mode != null && ['classic', 'duel', 'teamduel'].includes(opts.mode)) this.mode = opts.mode;
    if (opts.hp != null) this.startHp = clampInt(opts.hp, 100, 100000, this.startHp);
    if (opts.roundTime != null) this.roundTime = clampInt(opts.roundTime, 0, 600, this.roundTime);
    if (opts.allowMove != null) this.allowMove = !!opts.allowMove;
    if (opts.isPublic != null) this.isPublic = !!opts.isPublic;
    // Switching into team-duel: make sure everyone has a side, balanced.
    if (this.mode === 'teamduel') {
      let i = 0;
      for (const p of this.players.values()) {
        if (p.team !== 0 && p.team !== 1) p.team = (i++ % 2);
      }
    }
  }

  startGame(seed) {
    // Duel modes have no fixed round count — they run until someone dies, so
    // draw from the entire pool of locations. Classic uses the host's setting.
    const count = this.isDuel() ? this.allRounds.length : this.roundsPerGame;
    this.rounds = pickRounds(this.allRounds, count, seed);
    this.roundIndex = -1;
    this.winner = null;
    this.endReason = null;
    for (const p of this.players.values()) p.totalScore = 0;
    // Initialise HP per team for duel modes.
    this.hpByTeam = new Map();
    if (this.isDuel()) {
      for (const clientId of this.players.keys()) {
        const key = this.teamKeyOf(clientId);
        if (key != null && !this.hpByTeam.has(key)) this.hpByTeam.set(key, this.startHp);
      }
    }
    this.nextRound();
  }

  nextRound() {
    this.roundIndex++;
    this.guesses.clear();
    if (this.roundIndex >= this.rounds.length) {
      this.state = 'finished';
      if (this.isDuel() && !this.endReason) this.finishByRounds();
    } else {
      this.state = 'playing';
      this.roundStartedAt = Date.now();
    }
  }

  currentRound() {
    return this.rounds[this.roundIndex] || null;
  }

  // Absolute epoch-ms deadline for the current round, or null if no time limit.
  // Computed from the round's START time so it's identical for every player —
  // including a reconnecting player who rejoins partway through (they get the
  // REMAINING time, not a fresh full timer). Used by both the broadcast round
  // message and the single-player reconnect replay.
  roundDeadline() {
    if (!this.roundTime || this.roundStartedAt == null) return null;
    return this.roundStartedAt + this.roundTime * 1000;
  }

  /** True once every CONNECTED player has submitted a guess this round.
   *  Disconnected (grace-window) players are skipped so a drop can't stall the
   *  round waiting for someone who's gone. */
  allGuessed() {
    // Count only CONNECTED players, and only THEIR guesses — a disconnected
    // player's preserved guess (kept for reconnect) must NOT count toward the
    // alive total, or a drop could falsely trigger "everyone guessed" and reveal
    // the round while connected players still have time to guess.
    let alive = 0, aliveGuessed = 0;
    for (const [cid, p] of this.players) {
      if (p.ws && p.disconnectedAt == null) {
        alive++;
        if (this.guesses.has(cid)) aliveGuessed++;
      }
    }
    return alive > 0 && aliveGuessed >= alive;
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
    // Per-team best (closest) score this round — the only thing that deals dmg.
    const bestByTeam = new Map(); // teamKey -> best score
    for (const [clientId, player] of this.players) {
      const g = this.guesses.get(clientId);
      let entry;
      if (g) {
        const { score, distance } = scoreGuess(g, truth, this.mapMeta);
        player.totalScore += score;
        entry = { clientId, name: player.name, guess: g, score, distance,
                  totalScore: player.totalScore, team: this.teamKeyOf(clientId) };
      } else {
        entry = { clientId, name: player.name, guess: null, score: 0,
                  distance: null, totalScore: player.totalScore, team: this.teamKeyOf(clientId) };
      }
      if (this.isDuel()) {
        const key = entry.team;
        if (!bestByTeam.has(key) || entry.score > bestByTeam.get(key)) bestByTeam.set(key, entry.score);
      }
      results.push(entry);
    }

    // --- Damage: each team loses (topScore - itsBestScore) HP. For two teams
    // this is exactly |bestA - bestB| applied to whichever guessed worse; only
    // the round's top team takes no damage. Sudden death: game ends the instant
    // any team hits 0. ---
    let damage = null;
    if (this.isDuel() && bestByTeam.size > 0) {
      const top = Math.max(...bestByTeam.values());
      damage = [];
      for (const [key, best] of bestByTeam) {
        const dmg = top - best;
        if (dmg > 0) this.hpByTeam.set(key, Math.max(0, this.hpByTeam.get(key) - dmg));
        damage.push({ team: key, label: this.teamLabel(key), dmg, hp: this.hpByTeam.get(key) });
      }
      // Anyone at 0 -> sudden death.
      const dead = [...this.hpByTeam.entries()].filter(([, hp]) => hp <= 0).map(([k]) => k);
      if (dead.length) {
        this.state = 'finished';
        this.endReason = 'death';
        const alive = [...this.hpByTeam.entries()].filter(([, hp]) => hp > 0).map(([k]) => k);
        this.winner = alive.length === 1 ? this.teamLabel(alive[0])
                    : alive.length === 0 ? 'Draw'
                    : alive.map((k) => this.teamLabel(k)).join(', ');
      }
    }

    if (this.state !== 'finished') this.state = 'roundover';
    return { truth, results, teams: this.teamsSnapshot(), damage };
  }

  // Decide a winner when all rounds are played without a knockout (most HP).
  finishByRounds() {
    if (!this.isDuel() || this.hpByTeam.size === 0) return;
    const maxHp = Math.max(...this.hpByTeam.values());
    const leaders = [...this.hpByTeam.entries()].filter(([, hp]) => hp === maxHp).map(([k]) => k);
    this.endReason = 'rounds';
    this.winner = leaders.length === 1 ? this.teamLabel(leaders[0])
                : leaders.map((k) => this.teamLabel(k)).join(', ');
  }

  // Snapshot of team HP + membership for the client (bars, gameover screen).
  teamsSnapshot() {
    if (!this.isDuel()) return null;
    const out = [];
    for (const [key, hp] of this.hpByTeam) {
      const members = [...this.players.entries()]
        .filter(([cid]) => this.teamKeyOf(cid) === key)
        .map(([cid, p]) => ({ clientId: cid, name: p.name }));
      out.push({ team: key, label: this.teamLabel(key), hp, maxHp: this.startHp, members });
    }
    return out;
  }

  scoreboard() {
    return [...this.players.entries()]
      .map(([clientId, p]) => ({ clientId, name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);
  }
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
