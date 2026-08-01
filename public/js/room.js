/**
 * Room state and the pure functions that operate on it.
 *
 * A room is one shared object. Everyone playing has a copy, and every change is
 * written as a set of paths ("players/ab12/total": 84) so two people tapping at
 * the same moment can't overwrite each other — each player only ever writes
 * inside their own subtree.
 *
 * Nothing here touches the network or the DOM, which is what makes the sync
 * rules testable.
 */

import { scoreHand, isFlip7, FLIP7_TARGET } from './scoring.js';

/** No I, O, 0 or 1 — codes get read aloud across a table. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

/** How long before a quiet phone is shown as away. */
export const AWAY_AFTER = 45_000;
export const HEARTBEAT = 15_000;

export function makeRoomCode(rand = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Forgiving about how a code was typed or pasted. */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .slice(0, CODE_LENGTH)
    .join('');
}

export function isCompleteCode(input) {
  return normalizeCode(input).length === CODE_LENGTH;
}

export function makeId(rand = Math.random) {
  return Math.floor(rand() * 2 ** 40).toString(36) + Math.floor(rand() * 2 ** 20).toString(36);
}

export const emptyHand = () => ({ numbers: [], mods: [], chance: false, busted: false });

export function newPlayer(name, order, now = Date.now()) {
  return {
    name,
    order,
    total: 0,
    history: [],
    hand: emptyHand(),
    lastSeen: now,
  };
}

export function blankRoom({ code, target = 200, hostId, hostName, now = Date.now() }) {
  return {
    code,
    createdAt: now,
    target,
    round: 1,
    hostId,
    status: 'playing', // playing | finished
    winnerId: null,
    players: { [hostId]: newPlayer(hostName, 0, now) },
  };
}

// ── reading a room ────────────────────────────────────────────────────────

/** Firebase omits empty arrays and objects, so normalise on the way out. */
export function readHand(hand) {
  return {
    numbers: hand?.numbers ?? [],
    mods: hand?.mods ?? [],
    chance: !!hand?.chance,
    busted: !!hand?.busted,
    // Only a dealt game knows which card busted you; tapping your own cards in
    // scorekeeping mode leaves it null, and the hand renders the same either way.
    bustCard: hand?.bustCard ?? null,
  };
}

export function handShape(hand) {
  const h = readHand(hand);
  return {
    numbers: h.numbers,
    addMods: h.mods.filter((m) => m.op === 'add').map((m) => m.value),
    doubled: h.mods.some((m) => m.op === 'mul'),
    flip7: isFlip7(h.numbers),
    busted: h.busted,
  };
}

export function roundScore(hand) {
  return scoreHand(handShape(hand));
}

export function playerList(room) {
  const players = room?.players ?? {};
  return Object.entries(players)
    .map(([id, p]) => ({ id, ...p, hand: readHand(p.hand), history: p.history ?? [] }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Leaderboard order: total, then this round, then seat. */
export function standings(room) {
  return playerList(room)
    .map((p) => ({ ...p, round: roundScore(p.hand) }))
    .sort(
      (a, b) => b.total - a.total || b.round - a.round || (a.order ?? 0) - (b.order ?? 0),
    );
}

/**
 * May this player place a railbird bet right now? Out of the round — busted or
 * frozen — while it runs on, with the house rule on, points to stake, no bet
 * already down, and somebody still alive to back. Shared between the standings
 * (which take the tap) and the prompt row (which explains it).
 */
export function canRailbird(room, playerId) {
  if (room?.kind !== 'dealt' || room.pressBets !== true) return false;
  if (room.lobby || room.roundOver || room.status !== 'playing') return false;
  const me = room.players?.[playerId];
  if (!me || me.waiting || me.railbird) return false;
  if (me.state !== 'busted' && me.state !== 'frozen') return false;
  if ((me.total ?? 0) < 5) return false;
  return playerList(room).some((p) => p.id !== playerId && !p.waiting && p.state === 'active');
}

export function isAway(player, now = Date.now()) {
  return now - (player.lastSeen ?? 0) > AWAY_AFTER;
}

/** How long the host must be silent before anyone may end the round for them. */
export const HOST_AWAY_TAKEOVER = 120_000;

/**
 * How long the host's phone has been quiet. Scorekeeping only: the host is the
 * one person who can end a round, so a host in a dead spot would otherwise
 * strand the whole table mid-round. Past HOST_AWAY_TAKEOVER, anybody may press
 * their button for them.
 */
export function hostAwayFor(room, now = Date.now()) {
  const host = room?.players?.[room?.hostId];
  if (!host) return 0;
  return Math.max(0, now - (host.lastSeen ?? 0));
}

/** Has anyone touched a card this round? */
export function roundStarted(room) {
  return playerList(room).some((p) => {
    const h = p.hand;
    return h.numbers.length > 0 || h.mods.length > 0 || h.busted || h.chance;
  });
}

/** Everyone has either busted or hit seven — the round is over in practice. */
export function roundLooksDone(room) {
  const list = playerList(room);
  if (!list.length) return false;
  return list.every((p) => p.hand.busted || p.hand.numbers.length >= FLIP7_TARGET);
}

/**
 * Level at the finish line: the players forcing a tiebreak round, or null.
 * Works on the published round results, so every phone — host or not, dealt or
 * scorekeeping — reads the same tie off the same summary.
 */
export function tiedLeaders(results, target) {
  if (!target || !results?.length) return null;
  const best = Math.max(...results.map((r) => r.total ?? 0));
  if (best < target) return null;
  const leaders = results.filter((r) => (r.total ?? 0) === best);
  return leaders.length > 1 ? leaders : null;
}

export function nextOrder(room) {
  const list = playerList(room);
  return list.length ? Math.max(...list.map((p) => p.order ?? 0)) + 1 : 0;
}

// ── writing to a room ─────────────────────────────────────────────────────

/**
 * Apply `{ "players/ab/total": 84 }` style updates to a plain object, the way
 * Firebase's multi-path update does. Used by the same-device adapter so both
 * backends behave identically.
 */
export function applyPaths(target, paths) {
  const next = structuredClone(target ?? {});
  for (const [path, value] of Object.entries(paths)) {
    const keys = path.split('/').filter(Boolean);
    let node = next;
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    const last = keys[keys.length - 1];
    if (value === null) delete node[last];
    else node[last] = structuredClone(value);
  }
  return next;
}

/**
 * Bank every hand into its total and start the next round.
 * Returns the paths to write plus the per-player results for the summary.
 */
export function endRoundUpdates(room) {
  const list = playerList(room);
  const paths = {};
  const results = [];

  for (const p of list) {
    const shape = handShape(p.hand);
    const delta = scoreHand(shape);
    const total = (p.total ?? 0) + delta;
    paths[`players/${p.id}/total`] = total;
    paths[`players/${p.id}/history`] = [...(p.history ?? []), delta];
    paths[`players/${p.id}/hand`] = emptyHand();
    results.push({
      id: p.id,
      name: p.name,
      delta,
      total,
      busted: shape.busted,
      flip7: shape.flip7,
      doubled: shape.doubled,
      addMods: shape.addMods,
    });
  }

  const best = Math.max(0, ...results.map((r) => r.total));
  const leaders = results.filter((r) => r.total === best && r.total >= room.target);
  const winner = leaders.length === 1 ? leaders[0] : null;

  paths.round = (room.round ?? 1) + 1;
  // Published so every phone shows the same summary, not just the host's.
  paths.lastRound = { round: room.round ?? 1, results };
  if (winner) {
    paths.status = 'finished';
    paths.winnerId = winner.id;
  }

  return {
    paths,
    results,
    winner,
    // Level at the finish line means one more round, exactly like the card game.
    tied: leaders.length > 1 ? leaders : null,
  };
}

/** Clear the scores but keep the room and everyone in it. */
export function rematchUpdates(room) {
  // lastRound has to go too, or every phone reopens the old summary the moment
  // the new game starts.
  const paths = { round: 1, status: 'playing', winnerId: null, lastRound: null };
  for (const p of playerList(room)) {
    paths[`players/${p.id}/total`] = 0;
    paths[`players/${p.id}/history`] = [];
    paths[`players/${p.id}/hand`] = emptyHand();
  }
  return paths;
}
