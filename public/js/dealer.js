/**
 * The dealer: a dealt game of Flip 7, wrapped so it can be driven remotely.
 *
 * The rules live in engine.js. This adds the three things a shared, dealt game
 * needs on top:
 *
 *   - **A projection.** Clients get the same room shape they already render for
 *     scorekeeping, plus whose turn it is — and *not* the deck. The order of the
 *     remaining cards is the one thing that would be cheating to know, so it
 *     never leaves the dealer. Their composition does go out, because in Flip 7
 *     every card is dealt face up and anyone can count them.
 *   - **Intents.** Players ask ("hit", "stay", "target X") and the dealer decides.
 *     Nobody can deal themselves a card.
 *   - **A snapshot.** Enough to resume a game in progress, RNG included, so a
 *     relay restart doesn't end the evening.
 *
 * It has no idea whether it's running on a server or in a browser tab.
 */

import { Flip7Game, Status } from './engine.js';
import { cardName, ACTIONS } from './cards.js';
import { decideMove, decideTarget, thinkingTime, BOT_ROSTER, STYLES } from './ai.js';
import { emptyTally } from './odds.js';
import { makeId } from './room.js';

export const MIN_SEATS = 2;
export const MAX_SEATS = 8;

/** Seats for a new dealt game: the host, any friends joining later, and bots. */
export function seatsFor({ hostId, hostName, bots = 1, botStyle = 'mixed' }) {
  const seats = [{ id: hostId, name: hostName, isBot: false }];
  const count = Math.max(0, Math.min(MAX_SEATS - 1, bots));
  for (let i = 0; i < count; i++) {
    const bot = BOT_ROSTER[i % BOT_ROSTER.length];
    seats.push({
      id: `bot-${i}-${makeId()}`,
      name: bot.name,
      isBot: true,
      style: botStyle === 'mixed' ? bot.style : botStyle,
    });
  }
  return seats;
}

export function createDealtGame({ seats, target = 200, seed }) {
  const game = new Flip7Game({ players: seats, targetScore: target, seed });
  game.startRound();
  return game;
}

/** Add a human to a game already in progress. They join from the next round. */
export function addSeat(game, { id, name }) {
  if (game.players.length >= MAX_SEATS) return false;
  game.players.push({
    id,
    name,
    isBot: false,
    style: 'balanced',
    avatar: '🙂',
    seat: game.players.length,
    total: 0,
    history: [],
    numbers: [],
    modifiers: [],
    secondChance: null,
    // Mid-round arrivals sit out until the next deal rather than being handed a
    // hand nobody dealt them.
    status: game.phase === 'round' ? Status.STAYED : Status.ACTIVE,
    roundScore: 0,
    bustCard: null,
    joinedLate: game.phase === 'round',
  });
  return true;
}

export function removeSeat(game, playerId) {
  const i = game.players.findIndex((p) => p.id === playerId);
  if (i < 0 || !game.players[i].isBot) return false;
  game.players.splice(i, 1);
  game.players.forEach((p, n) => {
    p.seat = n;
  });
  if (game.turnIndex >= game.players.length) game.turnIndex = 0;
  return true;
}

// ── what the table can see ────────────────────────────────────────────────

const publicHand = (player) => ({
  numbers: player.numbers.map((c) => c.value),
  mods: player.modifiers.map((c) => ({ op: c.op, value: c.value })),
  chance: !!player.secondChance,
  busted: player.status === Status.BUSTED,
});

/** The remaining deck as counts — countable by anyone, unlike its order. */
export function deckTally(game) {
  const tally = emptyTally();
  for (const card of game.deck) {
    if (card.kind === 'number') {
      tally.numbers.set(card.value, (tally.numbers.get(card.value) ?? 0) + 1);
    } else if (card.kind === 'modifier') {
      if (card.op === 'mul') tally.mul += 1;
      else tally.adds.push(card.value);
    } else {
      tally.actions += 1;
    }
    tally.total += 1;
  }
  // Maps don't survive JSON, so send the counts as a plain array.
  return {
    numbers: [...tally.numbers.entries()].map(([value, count]) => [value, count]),
    adds: tally.adds,
    mul: tally.mul,
    actions: tally.actions,
    total: tally.total,
  };
}

/**
 * The room object every phone renders. Deliberately the same shape the
 * scorekeeping mode uses, so the standings, the hand and the Bust-O-meter all
 * work unchanged.
 */
export function project(game, { code, lastRound = null, feed = [] } = {}) {
  const request = game.request();
  const players = {};

  for (const p of game.players) {
    players[p.id] = {
      name: p.name,
      order: p.seat,
      total: p.total,
      history: p.history,
      hand: publicHand(p),
      isBot: !!p.isBot,
      style: p.isBot ? p.style : undefined,
      state: p.status,
      lastSeen: p.lastSeen ?? Date.now(),
    };
  }

  return {
    code,
    kind: 'dealt',
    target: game.targetScore,
    round: game.round,
    hostId: game.players[0]?.id ?? null,
    status: game.phase === 'game-over' ? 'finished' : 'playing',
    winnerId: game.winner?.id ?? null,
    players,
    lastRound,
    feed,
    deckLeft: game.deck.length,
    deckTally: deckTally(game),
    turnId: request.type === 'move' ? request.playerId : null,
    roundOver: request.type === 'round-over' || request.type === 'game-over',
    pending:
      request.type === 'target'
        ? { action: request.action, byId: request.playerId, targets: request.targets }
        : null,
  };
}

// ── what players are allowed to ask for ───────────────────────────────────

/**
 * Apply one player's intent. Returns what happened so the caller can decide
 * whether to broadcast, and refuses anything that isn't that player's to do.
 */
export function applyIntent(game, playerId, intent) {
  const request = game.request();

  if (intent?.do === 'hit' || intent?.do === 'stay') {
    if (request.type !== 'move') return { ok: false, why: 'not-now' };
    if (request.playerId !== playerId) return { ok: false, why: 'not-your-turn' };
    if (intent.do === 'hit') game.hit();
    else game.stay();
    return { ok: true };
  }

  if (intent?.do === 'target') {
    if (request.type !== 'target') return { ok: false, why: 'not-now' };
    if (request.playerId !== playerId) return { ok: false, why: 'not-yours' };
    if (!request.targets.includes(intent.targetId)) return { ok: false, why: 'bad-target' };
    game.resolveTarget(intent.targetId);
    return { ok: true };
  }

  if (intent?.do === 'next-round') {
    // Only between rounds, and only the host asks.
    if (game.phase !== 'round-over') return { ok: false, why: 'not-now' };
    if (game.players[0]?.id !== playerId) return { ok: false, why: 'host-only' };
    for (const p of game.players) delete p.joinedLate;
    game.startRound();
    return { ok: true, newRound: true };
  }

  if (intent?.do === 'rematch') {
    if (game.players[0]?.id !== playerId) return { ok: false, why: 'host-only' };
    for (const p of game.players) {
      p.total = 0;
      p.history = [];
      delete p.joinedLate;
    }
    game.winner = null;
    game.round = 0;
    game.phase = 'idle';
    game.startRound();
    return { ok: true, newRound: true };
  }

  return { ok: false, why: 'unknown-intent' };
}

/**
 * Move the game along by itself: deal the opening cards, run bot turns, close
 * out a round. Returns how long to wait before calling again, or null when it's
 * waiting on a person.
 *
 * Bots think for a beat because a game that resolves instantly is unreadable.
 */
export function advance(game, rng = game.rng) {
  const request = game.request();

  if (request.type === 'auto') {
    game.tick();
    return { delay: 260, events: game.drain() };
  }

  if (request.type === 'move') {
    const player = game.byId(request.playerId);
    if (!player.isBot) return { delay: null, events: game.drain(), waitingFor: player.id };
    if (decideMove(game, player, rng) === 'hit') game.hit();
    else game.stay();
    return { delay: thinkingTime(game, player, rng), events: game.drain() };
  }

  if (request.type === 'target') {
    const actor = game.byId(request.playerId);
    if (!actor.isBot) return { delay: null, events: game.drain(), waitingFor: actor.id };
    game.resolveTarget(decideTarget(game, actor, request, rng));
    return { delay: 700, events: game.drain() };
  }

  // Round or game over: a person decides when to move on.
  return { delay: null, events: game.drain(), waitingFor: game.players[0]?.id ?? null };
}

/**
 * Turn one engine event into a line for the table to read.
 *
 * Bot turns resolve in about a second, so without this a player sees the round
 * end and has no idea what happened — which reads as the game skipping people.
 * Returns null for events that aren't worth a line.
 */
export function describeEvent(event, game) {
  const who = (id) => (id === undefined ? '' : (game.byId(id)?.name ?? 'Someone'));
  const name = who(event.playerId);

  switch (event.type) {
    case 'round-start':
      return `Round ${event.round} — cards out.`;
    case 'gain':
      return `${name} drew ${cardName(event.card)}.`;
    case 'second-chance':
      return `${name} used their Second Chance on a second ${event.card.value}.`;
    case 'bust':
      return `${name} busted on a second ${event.card.value}.`;
    case 'flip7':
      return `${name} hit FLIP 7 — the round ends.`;
    case 'stay':
      return `${name} stayed on ${event.score}.`;
    case 'freeze':
      return event.playerId === event.targetId
        ? `${name} froze themselves on ${event.score}.`
        : `${name} froze ${who(event.targetId)} on ${event.score}.`;
    case 'flip3-start':
      return event.playerId === event.targetId
        ? `${name} takes three.`
        : `${name} made ${who(event.targetId)} flip three.`;
    case 'gift':
      return `${name} gave a Second Chance to ${who(event.targetId)}.`;
    case 'discard-action':
      return `${ACTIONS[event.card.action].label} discarded — nobody to use it on.`;
    case 'reshuffle':
      return 'Deck reshuffled.';
    default:
      // draw/turn/defer are bookkeeping; 'gain' already reports the card.
      return null;
  }
}

/** The per-player results for a round summary, in the shape the UI expects. */
export function roundResults(game) {
  return game.players.map((p) => {
    const b = game.breakdown(p);
    return {
      id: p.id,
      name: p.name,
      delta: p.roundScore,
      total: p.total,
      busted: p.status === Status.BUSTED,
      flip7: p.status === Status.FLIP7,
      doubled: b.doubled,
      addMods: p.modifiers.filter((c) => c.op === 'add').map((c) => c.value),
    };
  });
}

// ── saving a game in progress ─────────────────────────────────────────────

export function snapshot(game) {
  return {
    v: 1,
    seedState: game.rng.state,
    targetScore: game.targetScore,
    round: game.round,
    dealerIndex: game.dealerIndex,
    turnIndex: game.turnIndex,
    phase: game.phase,
    needAdvance: game.needAdvance,
    winnerId: game.winner?.id ?? null,
    deck: game.deck,
    discard: game.discard,
    dealQueue: game.dealQueue ?? [],
    flipQueue: game.flipQueue,
    pending: game.pending
      ? { type: game.pending.type, by: game.pending.by, card: game.pending.card, targets: game.pending.targets }
      : null,
    deferred: game.deferred.map((d) => ({ playerId: d.player.id, card: d.card })),
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      style: p.style,
      seat: p.seat,
      total: p.total,
      history: p.history,
      numbers: p.numbers,
      modifiers: p.modifiers,
      secondChance: p.secondChance,
      status: p.status,
      roundScore: p.roundScore,
      bustCard: p.bustCard,
      joinedLate: p.joinedLate,
    })),
  };
}

export function restore(snap) {
  if (!snap || snap.v !== 1) return null;
  const game = new Flip7Game({
    players: snap.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, style: p.style })),
    targetScore: snap.targetScore,
  });

  game.rng.setState(snap.seedState);
  game.round = snap.round;
  game.dealerIndex = snap.dealerIndex;
  game.turnIndex = snap.turnIndex;
  game.phase = snap.phase;
  game.needAdvance = snap.needAdvance;
  game.deck = snap.deck;
  game.discard = snap.discard;
  game.dealQueue = snap.dealQueue;
  game.flipQueue = snap.flipQueue;
  game.pending = snap.pending;
  game.events = [];

  snap.players.forEach((saved, i) => {
    Object.assign(game.players[i], {
      seat: saved.seat,
      total: saved.total,
      history: saved.history,
      numbers: saved.numbers,
      modifiers: saved.modifiers,
      secondChance: saved.secondChance,
      status: saved.status,
      roundScore: saved.roundScore,
      bustCard: saved.bustCard,
      joinedLate: saved.joinedLate,
    });
  });

  game.deferred = (snap.deferred ?? [])
    .map((d) => ({ player: game.byId(d.playerId), card: d.card }))
    .filter((d) => d.player);
  game.winner = snap.winnerId ? game.byId(snap.winnerId) : null;

  return game;
}

export const BOT_STYLES = STYLES;
