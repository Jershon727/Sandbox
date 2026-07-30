import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeEvent,
  seatsFor,
  createDealtGame,
  addSeat,
  removeSeat,
  project,
  applyIntent,
  advance,
  roundResults,
  snapshot,
  restore,
  deckTally,
  MAX_SEATS,
} from '../public/js/dealer.js';
import { Status } from '../public/js/engine.js';

const newGame = (opts = {}) =>
  createDealtGame({
    seats: seatsFor({ hostId: 'me', hostName: 'Jack', bots: 1, ...opts.seats }),
    target: opts.target ?? 200,
    seed: opts.seed ?? 7,
  });

/** Drive the game until it needs a person, as the relay's loop does. */
function settle(game, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const step = advance(game);
    if (step.delay === null) return step;
  }
  throw new Error('game never settled');
}

/**
 * Drive until it's somebody's turn to hit or stay, resolving any targeting on
 * the way. The opening deal can pause for a Freeze or Flip Three, and a player
 * dealt one of those plays it immediately rather than holding it.
 */
function dealOut(game, limit = 300) {
  for (let i = 0; i < limit; i++) {
    if (game.request().type === 'move') return;
    const step = advance(game);
    if (step.delay !== null) continue;
    const request = game.request();
    if (request.type === 'target') {
      applyIntent(game, request.playerId, { do: 'target', targetId: request.targets[0] });
    } else {
      return;
    }
  }
  throw new Error('never reached a turn');
}

/**
 * Play a round to its close, staying for every person the dealer asks. Needed
 * because advance() deliberately stops at a human — waiting for one by calling
 * tick() would spin forever, since a human turn is not automatic work.
 */
function playRoundOut(game, limit = 600) {
  for (let i = 0; i < limit; i++) {
    const step = advance(game);
    if (step.delay !== null) continue;
    const request = game.request();
    if (request.type === 'move') {
      applyIntent(game, request.playerId, { do: 'stay' });
    } else if (request.type === 'target') {
      applyIntent(game, request.playerId, { do: 'target', targetId: request.targets[0] });
    } else {
      return request.type; // round-over or game-over
    }
  }
  throw new Error('round never closed');
}

// ── seating ───────────────────────────────────────────────────────────────

test('a new game seats the host first, then the bots', () => {
  const seats = seatsFor({ hostId: 'me', hostName: 'Jack', bots: 3 });
  assert.equal(seats.length, 4);
  assert.deepEqual(seats[0], { id: 'me', name: 'Jack', isBot: false });
  assert.ok(seats.slice(1).every((s) => s.isBot));
  assert.equal(new Set(seats.map((s) => s.id)).size, 4, 'ids are distinct');
});

test('bot styles can be mixed or forced', () => {
  const mixed = seatsFor({ hostId: 'me', hostName: 'J', bots: 3, botStyle: 'mixed' });
  assert.ok(new Set(mixed.slice(1).map((s) => s.style)).size > 1);
  const wild = seatsFor({ hostId: 'me', hostName: 'J', bots: 3, botStyle: 'reckless' });
  assert.ok(wild.slice(1).every((s) => s.style === 'reckless'));
});

test('the table cannot be over-filled', () => {
  assert.equal(seatsFor({ hostId: 'me', hostName: 'J', bots: 99 }).length, MAX_SEATS);
});

test('someone joining mid-round waits for the next deal', () => {
  const game = newGame();
  settle(game);
  assert.equal(game.phase, 'round');
  addSeat(game, { id: 'late', name: 'Late' });

  const player = game.byId('late');
  assert.equal(player.status, Status.STAYED, 'sits out the hand in progress');
  assert.equal(player.total, 0);
  assert.deepEqual(player.numbers, [], 'is not handed cards nobody dealt');

  // The next round deals them in.
  playRoundOut(game);
  applyIntent(game, 'me', { do: 'next-round' });
  settle(game);
  assert.equal(game.byId('late').status, Status.ACTIVE);
  assert.ok(game.byId('late').numbers.length >= 1, 'and gives them an opening card');
});

test('bots can be removed but people cannot', () => {
  const game = newGame({ seats: { bots: 2 } });
  const botId = game.players.find((p) => p.isBot).id;
  assert.equal(removeSeat(game, botId), true);
  assert.equal(game.players.length, 2);
  assert.equal(removeSeat(game, 'me'), false, 'a person is not the dealer’s to evict');
});

// ── the projection ────────────────────────────────────────────────────────

test('the projection never contains the deck order', () => {
  const game = newGame();
  settle(game);
  const view = project(game, { code: 'ABCD' });
  const json = JSON.stringify(view);

  assert.ok(!('deck' in view), 'no deck');
  assert.ok(!('discard' in view), 'no discard');
  // A card object would carry an id; the tally is only counts.
  assert.ok(!/"id":"c\d+"/.test(json), 'no card identities leak');
  assert.equal(typeof view.deckLeft, 'number');
});

test('the projection is the same shape the scorekeeper renders', () => {
  const game = newGame();
  settle(game);
  const view = project(game, { code: 'ABCD' });

  assert.equal(view.kind, 'dealt');
  assert.equal(view.code, 'ABCD');
  assert.equal(view.round, 1);
  assert.equal(view.hostId, 'me');
  assert.equal(view.status, 'playing');
  for (const player of Object.values(view.players)) {
    assert.equal(typeof player.name, 'string');
    assert.equal(typeof player.total, 'number');
    assert.ok(Array.isArray(player.hand.numbers));
    assert.ok(Array.isArray(player.hand.mods));
    assert.equal(typeof player.hand.chance, 'boolean');
    assert.equal(typeof player.hand.busted, 'boolean');
  }
});

test('everyone is dealt an opening card', () => {
  const game = newGame({ seats: { bots: 2 } });
  dealOut(game);
  const view = project(game, { code: 'ABCD' });
  for (const p of Object.values(view.players)) {
    const held = p.hand.numbers.length + p.hand.mods.length + (p.hand.chance ? 1 : 0);
    assert.ok(held >= 1, `${p.name} has a card`);
  }
});

test('the tally accounts for every card still in the deck', () => {
  const game = newGame();
  settle(game);
  const tally = deckTally(game);
  const counted =
    tally.numbers.reduce((n, [, c]) => n + c, 0) + tally.adds.length + tally.mul + tally.actions;
  assert.equal(counted, tally.total);
  assert.equal(tally.total, game.deck.length, 'matches the real remaining deck');
});

// ── intents ───────────────────────────────────────────────────────────────

test('you cannot play out of turn', () => {
  const game = newGame();
  const step = settle(game);
  const other = game.players.find((p) => p.id !== step.waitingFor);
  assert.deepEqual(applyIntent(game, other.id, { do: 'hit' }), {
    ok: false,
    why: 'not-your-turn',
  });
});

test('you cannot deal yourself a card by any other name', () => {
  const game = newGame();
  settle(game);
  assert.equal(applyIntent(game, 'me', { do: 'deal' }).ok, false);
  assert.equal(applyIntent(game, 'me', {}).ok, false);
  assert.equal(applyIntent(game, 'me', null).ok, false);
});

test('hitting on your turn draws exactly one card', () => {
  const game = newGame();
  const step = settle(game);
  assert.equal(step.waitingFor, 'me', 'the human is up');
  const before = game.deck.length;
  const held = game.byId('me').numbers.length;
  assert.equal(applyIntent(game, 'me', { do: 'hit' }).ok, true);
  assert.equal(before - game.deck.length, 1);
  assert.ok(game.byId('me').numbers.length >= held);
});

test('staying banks the hand and passes on', () => {
  const game = newGame();
  settle(game);
  assert.equal(applyIntent(game, 'me', { do: 'stay' }).ok, true);
  assert.equal(game.byId('me').status, Status.STAYED);
});

test('only the host starts the next round, and only between rounds', () => {
  const game = newGame();
  settle(game);
  assert.deepEqual(applyIntent(game, 'me', { do: 'next-round' }), { ok: false, why: 'not-now' });

  playRoundOut(game);
  assert.equal(game.phase, 'round-over');

  const bot = game.players.find((p) => p.isBot);
  assert.deepEqual(applyIntent(game, bot.id, { do: 'next-round' }), {
    ok: false,
    why: 'host-only',
  });
  assert.equal(applyIntent(game, 'me', { do: 'next-round' }).ok, true);
  assert.equal(game.round, 2);
});

test('a rematch clears the scores and deals again', () => {
  const game = newGame();
  settle(game);
  game.byId('me').total = 180;
  assert.equal(applyIntent(game, 'me', { do: 'rematch' }).ok, true);
  assert.equal(game.byId('me').total, 0);
  assert.equal(game.round, 1);
});

// ── the dealer drives itself ──────────────────────────────────────────────

test('it waits for a person and never for itself', () => {
  const game = newGame();
  const step = settle(game);
  assert.equal(step.delay, null);
  assert.equal(step.waitingFor, 'me');
  assert.equal(game.request().type, 'move');
});

test('bots take their own turns, with a pause you can follow', () => {
  const game = newGame({ seats: { bots: 1 } });
  settle(game);
  applyIntent(game, 'me', { do: 'stay' });

  let botMoved = false;
  for (let i = 0; i < 200; i++) {
    const step = advance(game);
    if (step.delay === null) break;
    if (step.delay > 300) botMoved = true; // a thinking pause, not an auto step
  }
  assert.ok(botMoved, 'a bot thought before acting');
});

test('a whole dealt game plays itself out and produces a winner', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const game = createDealtGame({
      seats: seatsFor({ hostId: 'me', hostName: 'Jack', bots: 3 }).map((s) => ({
        ...s,
        isBot: true, // let the bots play the human's seat too, to run it to the end
      })),
      target: 200,
      seed,
    });

    let guard = 0;
    while (game.phase !== 'game-over') {
      if (++guard > 2000) throw new Error(`seed ${seed} never finished`);
      const outcome = playRoundOut(game);
      if (outcome === 'game-over') break;
      applyIntent(game, 'me', { do: 'next-round' });
    }

    assert.ok(game.winner, `seed ${seed} has a winner`);
    assert.ok(game.winner.total >= 200);

    // Cards are conserved throughout: nothing dealt twice, nothing lost.
    const inHands = game.players.reduce(
      (n, p) =>
        n + p.numbers.length + p.modifiers.length + (p.secondChance ? 1 : 0) + (p.bustCard ? 1 : 0),
      0,
    );
    assert.equal(game.deck.length + game.discard.length + inHands, 94, `seed ${seed} card count`);
  }
});

test('round results carry what the summary needs', () => {
  const game = newGame();
  settle(game);
  const results = roundResults(game);
  assert.equal(results.length, game.players.length);
  for (const r of results) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.delta, 'number');
    assert.equal(typeof r.total, 'number');
    assert.equal(typeof r.busted, 'boolean');
  }
});

// ── following a round you aren't playing ──────────────────────────────────

test('every event a player should notice becomes a readable line', () => {
  const game = newGame({ seats: { bots: 1 } });
  const me = game.byId('me');
  const bot = game.players.find((p) => p.isBot);

  const line = (event) => describeEvent(event, game);

  assert.match(line({ type: 'round-start', round: 3 }), /Round 3/);
  assert.match(line({ type: 'gain', playerId: me.id, card: { kind: 'number', value: 9 } }), /Jack drew a 9/);
  assert.match(
    line({ type: 'gain', playerId: me.id, card: { kind: 'modifier', op: 'mul', value: 2 } }),
    /x2 multiplier/,
  );
  assert.match(line({ type: 'bust', playerId: bot.id, card: { value: 7 } }), /busted on a second 7/);
  assert.match(line({ type: 'flip7', playerId: me.id }), /FLIP 7/);
  assert.match(line({ type: 'stay', playerId: me.id, score: 22 }), /stayed on 22/);
  assert.match(
    line({ type: 'freeze', playerId: me.id, targetId: bot.id, score: 14 }),
    new RegExp(`Jack froze ${bot.name} on 14`),
  );
  assert.match(line({ type: 'freeze', playerId: me.id, targetId: me.id, score: 8 }), /froze themselves/);
  assert.match(line({ type: 'flip3-start', playerId: me.id, targetId: bot.id }), /flip three/i);
  assert.match(line({ type: 'gift', playerId: me.id, targetId: bot.id }), /gave a Second Chance/);
  assert.match(
    line({ type: 'second-chance', playerId: me.id, card: { value: 5 } }),
    /used their Second Chance/,
  );

  // Bookkeeping the player doesn't need to read stays out of the account.
  for (const type of ['draw', 'turn', 'defer']) {
    assert.equal(line({ type, playerId: me.id, card: { kind: 'number', value: 4 } }), null, type);
  }
});

test('a bot turn produces something for the table to read', () => {
  const game = newGame({ seats: { bots: 1 } });
  dealOut(game);
  applyIntent(game, 'me', { do: 'stay' });

  const lines = [];
  for (let i = 0; i < 60; i++) {
    const step = advance(game);
    for (const event of step.events ?? []) {
      const text = describeEvent(event, game);
      if (text) lines.push(text);
    }
    if (step.delay === null) break;
  }

  assert.ok(lines.length > 0, 'the round left an account of itself');
  const bot = game.players.find((p) => p.isBot);
  assert.ok(
    lines.some((l) => l.includes(bot.name)),
    `the bot's turn is described — got ${JSON.stringify(lines)}`,
  );
});

// ── surviving a restart ───────────────────────────────────────────────────

test('a game in progress can be saved and resumed exactly', () => {
  const game = newGame({ seats: { bots: 2 } });
  settle(game);
  applyIntent(game, 'me', { do: 'hit' });
  settle(game);

  const snap = JSON.parse(JSON.stringify(snapshot(game)));
  const back = restore(snap);
  assert.ok(back);

  assert.equal(back.round, game.round);
  assert.equal(back.phase, game.phase);
  assert.equal(back.turnIndex, game.turnIndex);
  assert.equal(back.deck.length, game.deck.length);
  assert.deepEqual(
    back.players.map((p) => [p.id, p.total, p.numbers.map((c) => c.value), p.status]),
    game.players.map((p) => [p.id, p.total, p.numbers.map((c) => c.value), p.status]),
  );

  // And it deals the same cards from here, because the RNG came back too.
  assert.deepEqual(
    project(back, { code: 'X' }).deckTally,
    project(game, { code: 'X' }).deckTally,
  );
});

test('a snapshot from a future version is refused rather than misread', () => {
  assert.equal(restore({ v: 99 }), null);
  assert.equal(restore(null), null);
});
