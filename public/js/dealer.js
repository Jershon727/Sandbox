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

/**
 * How recently a seat must have been driven before handing it to a new phone
 * needs a yes. lastSeen here is stamped by the dealer itself — on seating and on
 * every accepted intent — not by client heartbeats, which dealt rooms drop.
 */
export const SEAT_ACTIVE_MS = 120_000;

/** Does this seat look like somebody is actually playing it right now? */
function seatLooksActive(player, now = Date.now()) {
  // A seat with no record — the host's, or one restored from an old snapshot —
  // is treated as active: the safe failure is one extra confirmation tap, not a
  // stranger silently driving somebody's hand.
  return player.lastSeen === undefined || now - player.lastSeen < SEAT_ACTIVE_MS;
}

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

/**
 * A dealt game, optionally sitting in a lobby.
 *
 * `deal: false` leaves it idle so friends can take a seat before any cards move.
 * Dealing at the moment the room is created would mean the host is the only
 * person in it, and everyone who then joined would have to sit out round one —
 * which looks precisely like the game refusing to deal them in.
 */
export function createDealtGame({ seats, target = 200, seed, deal = true }) {
  const game = new Flip7Game({ players: seats, targetScore: target, seed });
  if (deal) game.startRound();
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
    lastSeen: Date.now(),
  });
  return true;
}

/**
 * Find or make this person's seat, and say which one it is.
 *
 * The dealer owns seating, not the phone. A client that decides its own seat id
 * can end up driving a seat the dealer doesn't have, while the seat the dealer
 * actually dealt to sits there and never takes a turn — which looks exactly like
 * the game skipping a player. So the id this returns is the one to play as.
 *
 * Coming back under a name already at the table takes that seat over, which is
 * what someone whose phone died actually wants — but only when that seat looks
 * abandoned. A seat that acted moments ago is probably still being played, and a
 * second person who happens to share the name must not silently hijack it: that
 * case comes back as `conflict: true`, and the caller asks before either
 * rejoining as them (`takeover: true`) or picking another name.
 */
export function claimSeat(game, { id, name, takeover = false }) {
  const clean = (String(name ?? '').trim() || 'Player').slice(0, 20);
  const existing = id ? game.byId(id) : null;
  if (existing) {
    existing.lastSeen = Date.now();
    return { playerId: id, added: false, late: false };
  }

  const key = clean.toLowerCase();
  const held = game.players.find((p) => !p.isBot && p.name.trim().toLowerCase() === key);
  if (held) {
    if (!takeover && seatLooksActive(held)) {
      return { playerId: held.id, added: false, late: !!held.joinedLate, conflict: true };
    }
    held.lastSeen = Date.now();
    return { playerId: held.id, added: false, late: !!held.joinedLate };
  }

  const seatId = id || makeId();
  if (!addSeat(game, { id: seatId, name: clean })) return null;
  return { playerId: seatId, added: true, late: !!game.byId(seatId).joinedLate };
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

/**
 * A card as the table may see it: what it is, without which card it is.
 *
 * Dropping the deck id keeps the projection free of card identities, so nothing
 * about the order of the remaining deck can be inferred from a hand.
 */
export const publicCard = (card) =>
  card
    ? {
        kind: card.kind,
        ...(card.kind === 'number' ? { value: card.value } : {}),
        ...(card.kind === 'modifier' ? { op: card.op, value: card.value } : {}),
        ...(card.kind === 'action' ? { action: card.action } : {}),
      }
    : null;

const publicHand = (player) => ({
  numbers: player.numbers.map((c) => c.value),
  mods: player.modifiers.map((c) => ({ op: c.op, value: c.value })),
  chance: !!player.secondChance,
  busted: player.status === Status.BUSTED,
  // The card that did it. Being told only "you busted" leaves you guessing at
  // which duplicate landed, so the hand keeps it visible until the next deal.
  bustCard: publicCard(player.bustCard),
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
      // Sitting out the round they walked in on. Without this the table shows
      // them as having stayed, which reads as the dealer having skipped them.
      waiting: !!p.joinedLate,
      // Real socket presence is the relay's to report, and it doesn't yet — so
      // every seat is projected as present rather than flickering "away" for
      // anyone between turns. Seat-claiming reads p.lastSeen directly instead.
      lastSeen: Date.now(),
    };
  }

  return {
    code,
    kind: 'dealt',
    target: game.targetScore,
    round: game.round,
    hostId: game.players[0]?.id ?? null,
    // No cards dealt yet: people are still taking seats.
    lobby: game.phase === 'idle',
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
        ? {
            action: request.action,
            // The card itself, so the person aiming it sees what they drew
            // rather than only being told its name.
            card: publicCard(request.card),
            byId: request.playerId,
            targets: request.targets,
          }
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

  // Asking for anything proves the seat is being driven right now, which is
  // what claimSeat leans on to spot a hijack versus a dead phone coming back.
  const actor = game.byId(playerId);
  if (actor) actor.lastSeen = Date.now();

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
    // From the lobby or between rounds, and only the host asks.
    if (game.phase !== 'round-over' && game.phase !== 'idle') return { ok: false, why: 'not-now' };
    if (game.players[0]?.id !== playerId) return { ok: false, why: 'host-only' };
    // Opening a game against nobody would just deal the host a hand and end.
    if (game.phase === 'idle' && game.players.length < MIN_SEATS) {
      return { ok: false, why: 'need-players' };
    }
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

  // Bots have personalities (ai.js); at the tense end of a hand their lines
  // carry a little of it, so the table reads like company rather than a log.
  const actor = event.playerId === undefined ? null : game.byId(event.playerId);
  const botStyle = actor?.isBot ? actor.style : null;

  switch (event.type) {
    case 'round-start':
      return `Round ${event.round} — cards out.`;
    case 'gain': {
      const base = `${name} drew ${cardName(event.card)}.`;
      if (botStyle && event.card.kind === 'number' && actor.numbers.length >= 5) {
        if (botStyle === 'reckless') return `${base} Still hitting, of course.`;
        if (botStyle === 'cautious') return `${base} And ${name} looks nervous.`;
        return `${base} ${actor.numbers.length} deep and pushing for the 7.`;
      }
      return base;
    }
    case 'second-chance':
      return `${name} used their Second Chance on a second ${event.card.value}.`;
    case 'bust':
      return botStyle === 'reckless'
        ? `${name} busted on a second ${event.card.value}. Classic ${name}.`
        : `${name} busted on a second ${event.card.value}.`;
    case 'flip7':
      return `${name} hit FLIP 7 — the round ends.`;
    case 'stay':
      return botStyle === 'reckless' && (event.score ?? 0) >= 25
        ? `${name} stayed on ${event.score}. Even ${name} has limits.`
        : `${name} stayed on ${event.score}.`;
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
    case 'tiebreak': {
      // Level at the finish line: without a line for it, the game silently deals
      // another round and looks like it forgot somebody crossed the target.
      const names = (event.playerIds ?? []).map(who);
      const list =
        names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      const total = game.byId(event.playerIds?.[0])?.total ?? 0;
      return `${list} tied at ${total} — one more round decides it.`;
    }
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
      lastSeen: p.lastSeen,
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
      lastSeen: saved.lastSeen,
    });
  });

  game.deferred = (snap.deferred ?? [])
    .map((d) => ({ player: game.byId(d.playerId), card: d.card }))
    .filter((d) => d.player);
  game.winner = snap.winnerId ? game.byId(snap.winnerId) : null;

  return game;
}

export const BOT_STYLES = STYLES;
