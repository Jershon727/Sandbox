/**
 * The live room: whichever backend is in play, the rest of the app talks to
 * this.
 *
 * Responsibilities beyond passing writes along:
 *   - remembers which room and which player you are, so a refresh or a dropped
 *     phone rejoins instead of losing the game
 *   - heartbeats, so the table can see who is still connected
 *   - decides what you're allowed to edit (your own hand; the host can fix
 *     anyone's, for the friend whose battery died)
 */

import {
  blankRoom,
  makeRoomCode,
  makeId,
  newPlayer,
  nextOrder,
  normalizeCode,
  playerList,
  HEARTBEAT,
} from './room.js';
import { createLocalSync } from './sync-local.js';

const MEMBERSHIP = 'flip7:membership';

function loadMembership() {
  try {
    return JSON.parse(localStorage.getItem(MEMBERSHIP) ?? 'null');
  } catch {
    return null;
  }
}

function saveMembership(value) {
  try {
    if (value) localStorage.setItem(MEMBERSHIP, JSON.stringify(value));
    else localStorage.removeItem(MEMBERSHIP);
  } catch {
    /* private browsing — the session just won't survive a refresh */
  }
}

export class Store {
  constructor() {
    this.sync = null;
    this.code = null;
    this.myId = null;
    this.mode = null; // 'local' | 'firebase'
    this.state = null;
    this.unwatch = null;
    this.beat = 0;
    this.listeners = new Set();
    this.errorListeners = new Set();
  }

  // ── subscriptions ───────────────────────────────────────────────────────

  subscribe(fn) {
    this.listeners.add(fn);
    if (this.state) fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onError(fn) {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  _fail(error) {
    for (const fn of this.errorListeners) fn(error);
  }

  // ── identity ────────────────────────────────────────────────────────────

  get me() {
    return this.state?.players?.[this.myId] ?? null;
  }

  get isHost() {
    return !!this.state && this.state.hostId === this.myId;
  }

  get isOnline() {
    return this.mode === 'firebase';
  }

  /** You may always fix your own hand; the host may fix anybody's. */
  canEdit(playerId) {
    return playerId === this.myId || this.isHost;
  }

  get savedMembership() {
    return loadMembership();
  }

  // ── connecting ──────────────────────────────────────────────────────────

  /**
   * The single-file build has no separate modules to fetch, so don't try —
   * a failed dynamic import is caught, but it still shouts in the console.
   */
  static get singleFile() {
    return !!globalThis.__FLIP7_SINGLE_FILE;
  }

  async _backend(mode) {
    if (mode === 'firebase' && !Store.singleFile) {
      const [{ createFirebaseSync }, { firebaseConfig }] = await Promise.all([
        import('./sync-firebase.js'),
        import('../firebase-config.js'),
      ]);
      return createFirebaseSync(firebaseConfig);
    }
    return createLocalSync();
  }

  /** Is an online game even possible in this build? */
  static async onlineAvailable() {
    if (Store.singleFile) return false;
    try {
      const [{ hasFirebaseConfig }, { firebaseConfig }] = await Promise.all([
        import('./sync-firebase.js'),
        import('../firebase-config.js'),
      ]);
      return hasFirebaseConfig(firebaseConfig);
    } catch {
      return false;
    }
  }

  async host({ name, target = 200, mode = 'local' }) {
    const sync = await this._backend(mode);
    const hostId = makeId();

    // Codes are short, so a collision is possible; just try another.
    let room = null;
    let code = null;
    for (let attempt = 0; attempt < 8 && !room; attempt++) {
      code = makeRoomCode();
      const candidate = blankRoom({ code, target, hostId, hostName: name });
      try {
        room = await sync.create(code, candidate);
      } catch (err) {
        if (err.code !== 'code-taken') throw err;
      }
    }
    if (!room) throw new Error('Could not find a free room code — try again');

    this.sync = sync;
    this.mode = mode;
    this.code = code;
    this.myId = hostId;
    saveMembership({ code, playerId: hostId, mode });
    this._watch();
    return code;
  }

  async join({ code, name, mode = 'firebase' }) {
    const clean = normalizeCode(code);
    const sync = await this._backend(mode);
    const room = await sync.join(clean);
    if (!room) {
      const err = new Error(`No game found with the code ${clean}`);
      err.code = 'room-missing';
      throw err;
    }

    // Re-joining under a name already at the table takes that seat back, which
    // is what someone whose phone died actually wants.
    const existing = playerList(room).find(
      (p) => p.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    const playerId = existing?.id ?? makeId();

    this.sync = sync;
    this.mode = mode;
    this.code = clean;
    this.myId = playerId;

    if (!existing) {
      await sync.update(clean, {
        [`players/${playerId}`]: newPlayer(name, nextOrder(room)),
      });
    } else {
      await sync.update(clean, { [`players/${playerId}/lastSeen`]: Date.now() });
    }

    saveMembership({ code: clean, playerId, mode });
    this._watch();
    return clean;
  }

  /** Reconnect to the game this device was already in. */
  async resume() {
    const saved = loadMembership();
    if (!saved?.code || !saved.playerId) return false;
    const sync = await this._backend(saved.mode ?? 'local');
    const room = await sync.join(saved.code);
    if (!room || !room.players?.[saved.playerId]) {
      saveMembership(null);
      return false;
    }
    this.sync = sync;
    this.mode = saved.mode ?? 'local';
    this.code = saved.code;
    this.myId = saved.playerId;
    this._watch();
    return true;
  }

  _watch() {
    this.unwatch?.();
    this.unwatch = this.sync.watch(
      this.code,
      (room) => {
        this.state = room;
        this._emit();
      },
      (error) => this._fail(error),
    );

    clearInterval(this.beat);
    this.beat = setInterval(() => this._touch(), HEARTBEAT);
    this._touch();
  }

  _touch() {
    if (!this.sync || !this.myId) return;
    this.update({ [`players/${this.myId}/lastSeen`]: Date.now() }).catch(() => {
      /* a missed heartbeat only affects the away indicator */
    });
  }

  // ── writing ─────────────────────────────────────────────────────────────

  async update(paths) {
    if (!this.sync || !this.code) return;
    try {
      await this.sync.update(this.code, paths);
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }

  /** Add somebody who isn't holding a phone. Host only. */
  async addPlayer(name) {
    if (!this.isHost) return null;
    const id = makeId();
    await this.update({ [`players/${id}`]: newPlayer(name, nextOrder(this.state)) });
    return id;
  }

  async renamePlayer(playerId, name) {
    if (!this.canEdit(playerId)) return;
    await this.update({ [`players/${playerId}/name`]: name });
  }

  async removePlayer(playerId) {
    if (!this.isHost || playerId === this.myId) return;
    await this.update({ [`players/${playerId}`]: null });
  }

  leave() {
    clearInterval(this.beat);
    this.unwatch?.();
    this.sync?.close?.();
    this.unwatch = null;
    this.sync = null;
    this.state = null;
    this.code = null;
    this.myId = null;
    this.mode = null;
    saveMembership(null);
    this._emit();
  }
}
