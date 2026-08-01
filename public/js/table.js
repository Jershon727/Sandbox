/**
 * A dealt game, running.
 *
 * dealer.js knows the rules and how to project them; this is the loop that keeps
 * a game moving — the opening deal, bot turns, the written account of the round,
 * and closing a round out. It is deliberately the piece shared between the relay
 * and a single phone, so a game dealt on a plane behaves exactly like one dealt
 * on a server rather than being a second, slightly different implementation.
 *
 * It schedules nothing itself. The caller decides what a pause means: setTimeout
 * on a phone, setTimeout on the relay, or nothing at all in a test.
 */

import {
  advance,
  applyIntent,
  createDealtGame,
  describeEvent,
  project,
  publicCard,
  roundResults,
  seatsFor,
  settleSeat,
  stalledTurn,
} from './dealer.js';

/** How much of the round's account to keep. Enough to scroll back a turn or two. */
export const FEED_LINES = 40;

/** The whole social vocabulary. Anything else a client sends is refused. */
export const REACTIONS = ['😱', '🔥', '😂', '❄️', '👏', '💀'];

/** Table talk: one message can't be longer than this. */
export const CHAT_MAX = 120;

/** How many chat lines survive a new deal, when the play-by-play is cleared. */
export const CHAT_KEEP = 8;

/** A chat message, cleaned for the table: trimmed, de-controlled, capped. */
export function cleanChat(text) {
  // eslint-disable-next-line no-control-regex
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.slice(0, CHAT_MAX);
}

/**
 * A table is a game plus everything the players read about it: the account of
 * the round, the last round's results, and the projection built from all three.
 */
export function createTable({ code, setup, deal = false }) {
  const game = createDealtGame({
    seats: seatsFor({
      hostId: setup.hostId,
      hostName: String(setup.hostName ?? 'Me').slice(0, 20),
      bots: Number(setup.bots) || 0,
      botStyle: setup.botStyle,
    }),
    target: Number(setup.target) || 200,
    seed: setup.seed,
    deal,
  });
  const table = { code, game, feed: [], seq: 0, lastRound: null, room: null };
  reproject(table);
  return table;
}

/** Wrap an existing game — used when restoring one from storage. */
export function tableFrom({ code, game, feed = [], seq = 0, lastRound = null }) {
  const table = { code, game, feed, seq: seq || feed.at(-1)?.n || 0, lastRound, room: null };
  reproject(table);
  return table;
}

/** Add one line to the running account of the round. */
export function noteFeed(table, line) {
  table.feed.push({ n: ++table.seq, ...line });
  if (table.feed.length > FEED_LINES) table.feed.splice(0, table.feed.length - FEED_LINES);
}

/**
 * Record what just happened, so every player can follow a round they aren't
 * playing. Without this a bot's whole turn passes in under a second and the
 * round looks like it skipped people.
 */
export function recordEvents(table, events) {
  if (!events?.length) return;
  for (const event of events) {
    const text = describeEvent(event, table.game);
    if (!text) continue;
    // `to` lets a player tell when something was done *to them* — being frozen
    // out of a round deserves more than a line in a list.
    noteFeed(table, {
      text,
      type: event.type,
      who: event.playerId ?? null,
      to: event.targetId ?? event.playerId ?? null,
      ...(event.score === undefined ? {} : { score: event.score }),
      ...(event.card ? { card: publicCard(event.card) } : {}),
    });
  }
}

/** Rebuild what the players read, without sending it anywhere. */
export function reproject(table) {
  table.room = project(table.game, {
    code: table.code,
    lastRound: table.lastRound,
    feed: table.feed,
  });
  return table.room;
}

/**
 * Move the game along by one step: deal a card, play a bot, close a round.
 * Returns how long to wait before stepping again, or null when it is waiting on
 * a person. The pause is what makes a bot's turn readable instead of instant.
 */
export function step(table) {
  const before = table.game.round;
  const result = advance(table.game);
  recordEvents(table, result.events);

  // A finished round is recorded once, with its results, so every player sees
  // the same summary.
  if (table.game.phase === 'round-over' && table.lastRound?.round !== before) {
    table.lastRound = { round: before, results: roundResults(table.game) };
  }

  reproject(table);
  return result;
}

/** Apply a player's request. A new deal clears the previous round's paperwork. */
export function request(table, playerId, intent) {
  // Reactions and chat are social, not gameplay: any seated player may send
  // one at any moment, and they go straight into the account of the round
  // rather than through the rules engine. Old clients render both as plain
  // text feed lines.
  if (intent?.do === 'react') {
    const player = table.game.byId(playerId);
    if (!player || !REACTIONS.includes(intent.emoji)) {
      return { ok: false, why: 'bad-reaction' };
    }
    player.lastSeen = Date.now();
    noteFeed(table, {
      text: `${player.name} ${intent.emoji}`,
      type: 'react',
      emoji: intent.emoji,
      who: playerId,
      to: playerId,
    });
    reproject(table);
    return { ok: true };
  }

  if (intent?.do === 'chat') {
    const player = table.game.byId(playerId);
    const msg = cleanChat(intent.text);
    if (!player || !msg) return { ok: false, why: 'bad-chat' };
    player.lastSeen = Date.now();
    noteFeed(table, {
      text: `${player.name}: ${msg}`,
      type: 'chat',
      msg,
      who: playerId,
      to: playerId,
      at: Date.now(),
    });
    reproject(table);
    return { ok: true };
  }

  const result = applyIntent(table.game, playerId, intent);
  if (result.ok && result.newRound) {
    table.lastRound = null;
    // The play-by-play belongs to the round; table talk doesn't. Keep the tail
    // of the conversation across the deal so chat doesn't vanish mid-sentence.
    table.feed = table.feed.filter((l) => l.type === 'chat').slice(-CHAT_KEEP);
  }
  // A skipped or removed seat deserves a line: without one, a player who comes
  // back sees their hand banked — or their chair gone — with no explanation.
  if (result.ok && result.skipped) {
    const name = table.game.byId(result.skipped)?.name ?? 'They';
    if (result.settled.did === 'stay') {
      noteFeed(table, {
        text: `${name} was skipped — banked ${result.settled.score}.`,
        type: 'stall',
        who: result.skipped,
        to: result.skipped,
        score: result.settled.score,
      });
    } else {
      noteFeed(table, {
        text: `${name} was skipped — the dealer aimed their card.`,
        type: 'stall',
        who: result.skipped,
        to: result.skipped,
      });
      recordEvents(table, result.settled.events);
    }
  }
  if (result.ok && result.removed) {
    noteFeed(table, {
      text: `${result.removedName} was removed from the table.`,
      type: 'leave',
      who: result.removed,
      to: result.removed,
    });
  }
  if (result.ok) reproject(table);
  return result;
}

/**
 * The stall timer's payoff: the whole table is stuck behind a seat whose phone
 * has gone silent, so bank that hand and say why. Runs wherever the dealer
 * runs — the relay's timer calls it on a schedule; a test calls it with a
 * clock of its own. Returns whether anything was recovered.
 */
export function recoverStalledTurn(table, now = Date.now()) {
  const playerId = stalledTurn(table.game, now);
  if (!playerId) return false;
  const player = table.game.byId(playerId);
  const settled = settleSeat(table.game, playerId);
  if (!settled) return false;
  if (settled.did === 'stay') {
    noteFeed(table, {
      text: `${player.name} lost connection — banked ${settled.score}.`,
      type: 'stall',
      who: playerId,
      to: playerId,
      score: settled.score,
    });
  } else {
    noteFeed(table, {
      text: `${player.name} lost connection — the dealer aimed their card.`,
      type: 'stall',
      who: playerId,
      to: playerId,
    });
    recordEvents(table, settled.events);
  }
  reproject(table);
  return true;
}

/**
 * Run the loop until the game needs a person, calling `onPublish` after each
 * step and `schedule` for the pauses. Returns a function that stops it.
 */
export function runTable(table, { publish, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null;
  const tick = () => {
    timer = null;
    const result = step(table);
    publish(table.room);
    if (result.delay !== null) timer = schedule(tick, result.delay);
  };
  tick();
  return () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
}
