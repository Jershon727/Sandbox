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
} from './dealer.js';

/** How much of the round's account to keep. Enough to scroll back a turn or two. */
export const FEED_LINES = 40;

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
  const result = applyIntent(table.game, playerId, intent);
  if (result.ok && result.newRound) {
    table.lastRound = null;
    table.feed = [];
  }
  if (result.ok) reproject(table);
  return result;
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
