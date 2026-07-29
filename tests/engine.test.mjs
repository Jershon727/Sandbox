import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, copiesOf, DECK_SIZE } from '../public/js/cards.js';
import { Flip7Game, Status, FLIP7_BONUS } from '../public/js/engine.js';
import { bustChance } from '../public/js/odds.js';
import { decideMove, decideTarget } from '../public/js/ai.js';

const makeGame = (opts = {}) =>
  new Flip7Game({
    players: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    seed: 42,
    ...opts,
  });

/** Force a specific next card by putting it on top of the deck. */
function stack(game, ...cards) {
  for (const card of cards) game.deck.push(card);
}
const num = (value) => ({ id: `n${value}-${Math.random()}`, kind: 'number', value });
const mod = (op, value) => ({ id: `m${op}${value}`, kind: 'modifier', op, value });
const act = (action) => ({ id: `a${action}${Math.random()}`, kind: 'action', action });

/** Drain automatic steps until the game needs input (bounded, to catch loops). */
function settle(game, limit = 500) {
  let n = 0;
  while (game.tick()) {
    if (++n > limit) throw new Error('tick() did not settle');
  }
  return game.request();
}

test('deck is the real 94-card Flip 7 deck', () => {
  const deck = buildDeck();
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(deck.length, 94);

  const numbers = deck.filter((c) => c.kind === 'number');
  assert.equal(numbers.length, 79);
  for (let v = 0; v <= 12; v++) {
    assert.equal(numbers.filter((c) => c.value === v).length, copiesOf(v), `copies of ${v}`);
  }

  assert.equal(deck.filter((c) => c.kind === 'modifier').length, 6);
  assert.equal(deck.filter((c) => c.kind === 'modifier' && c.op === 'mul').length, 1);
  assert.equal(deck.filter((c) => c.kind === 'action').length, 9);
  for (const a of ['freeze', 'flip3', 'chance']) {
    assert.equal(deck.filter((c) => c.action === a).length, 3, `copies of ${a}`);
  }
  assert.equal(new Set(deck.map((c) => c.id)).size, 94, 'ids are unique');
});

test('round opens by dealing one card to every player', () => {
  const game = makeGame();
  game.startRound();
  const req = settle(game);
  assert.equal(req.type, 'move');
  for (const p of game.players) {
    assert.equal(p.numbers.length + p.modifiers.length + (p.secondChance ? 1 : 0), 1);
  }
  assert.equal(game.deck.length, 94 - 2);
});

test('duplicate number busts and zeroes the round', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(5), num(9)];
  p.modifiers = [mod('add', 10)];
  stack(game, num(5));

  game.hit();
  assert.equal(p.status, Status.BUSTED);
  assert.equal(game.scoreOf(p), 0);
  assert.ok(game.drain().some((e) => e.type === 'bust'));
});

test('a busted hand stays visible but is out of play', () => {
  const game = makeGame();
  game.startRound();
  settle(game);
  const p = game.current;
  p.numbers = [num(3), num(4)];
  p.modifiers = [mod('mul', 2)];
  p.secondChance = null;
  stack(game, num(3));
  game.hit();

  assert.equal(p.status, Status.BUSTED);
  assert.equal(p.bustCard.value, 3, 'the killer card is recorded');
  assert.equal(p.numbers.length, 2, 'the hand is still there to look at');
  // Out of play means out of the draw pool: no dead card can come back.
  const ids = new Set(game.deck.map((c) => c.id));
  for (const c of [...p.numbers, ...p.modifiers, p.bustCard]) {
    assert.ok(!ids.has(c.id), 'dead cards are not redrawable');
  }
});

test('Second Chance absorbs one duplicate then is gone', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(6)];
  p.secondChance = act('chance');
  stack(game, num(6));

  game.hit();
  assert.equal(p.status, Status.ACTIVE, 'survives the duplicate');
  assert.equal(p.secondChance, null, 'shield is consumed');
  assert.equal(p.numbers.length, 1, 'duplicate is not kept');
  assert.ok(game.drain().some((e) => e.type === 'second-chance'));

  // Second duplicate now busts.
  stack(game, num(6));
  game.turnIndex = p.seat;
  game.needAdvance = false;
  game.hit();
  assert.equal(p.status, Status.BUSTED);
});

test('a duplicate Second Chance must be given away', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.secondChance = act('chance');
  stack(game, act('chance'));
  game.hit();

  const req = game.request();
  assert.equal(req.type, 'target');
  assert.equal(req.action, 'gift');
  assert.ok(!req.targets.includes(p.id), 'cannot gift to yourself');

  const other = req.targets[0];
  game.resolveTarget(other);
  assert.ok(game.byId(other).secondChance, 'target now holds it');
});

test('a duplicate Second Chance with no eligible taker is discarded', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.secondChance = act('chance');
  for (const q of game.players) if (q !== p) q.status = Status.STAYED;

  stack(game, act('chance'));
  game.hit();
  assert.equal(game.pending, null);
  assert.ok(game.drain().some((e) => e.type === 'discard-action'));
});

test('seven unique numbers scores the Flip 7 bonus and ends the round', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  const other = game.players.find((q) => q !== p);
  p.numbers = [num(1), num(2), num(3), num(4), num(5), num(6)];
  other.status = Status.ACTIVE;
  other.numbers = [num(8)];
  stack(game, num(7));

  game.hit();
  assert.equal(p.status, Status.FLIP7);
  assert.equal(game.scoreOf(p), 1 + 2 + 3 + 4 + 5 + 6 + 7 + FLIP7_BONUS);
  assert.equal(other.status, Status.STAYED, 'everyone else stops where they are');
  assert.equal(game.scoreOf(other), 8, 'and still scores their cards');

  settle(game);
  assert.equal(game.phase, 'round-over');
});

test('modifiers never bust you and never count toward Flip 7', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(1), num(2), num(3), num(4), num(5), num(6)];
  stack(game, mod('add', 10));
  game.hit();

  assert.equal(p.status, Status.ACTIVE, 'six uniques plus a modifier is not Flip 7');
  assert.equal(p.numbers.length, 6);
  assert.equal(game.scoreOf(p), 21 + 10);
});

test('x2 doubles the numbers before + modifiers are added', () => {
  const game = makeGame();
  const p = game.players[0];
  p.numbers = [num(10), num(5)];
  p.modifiers = [mod('mul', 2), mod('add', 4)];
  assert.equal(game.scoreOf(p), 15 * 2 + 4);

  const b = game.breakdown(p);
  assert.deepEqual(
    { base: b.base, doubled: b.doubled, bonus: b.bonus, total: b.total },
    { base: 15, doubled: true, bonus: 4, total: 34 },
  );
});

test('Freeze banks the target and removes them from the round', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  const other = game.players.find((q) => q !== p);
  other.numbers = [num(9), num(4)];
  stack(game, act('freeze'));
  game.hit();

  const req = game.request();
  assert.equal(req.action, 'freeze');
  assert.ok(req.targets.includes(p.id), 'you may freeze yourself');

  game.resolveTarget(other.id);
  assert.equal(other.status, Status.FROZEN);
  assert.equal(other.roundScore, 13, 'frozen players keep their points');
});

test('Flip Three deals exactly three cards, one at a time', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(0)];
  stack(game, act('flip3'));
  game.hit();
  game.resolveTarget(p.id);

  // Feed three harmless, distinct numbers.
  game.deck.push(num(12), num(11), num(10));
  const deckBefore = game.deck.length;
  settle(game);

  assert.equal(deckBefore - game.deck.length, 3, 'three cards left the deck');
  assert.equal(game.flipQueue, null);
  assert.deepEqual(
    p.numbers.map((c) => c.value).sort((a, b) => a - b),
    [0, 10, 11, 12],
  );
});

test('Flip Three stops early when the target busts', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(4)];
  p.secondChance = null;
  stack(game, act('flip3'));
  game.hit();
  game.resolveTarget(p.id);

  game.deck.push(num(12), num(4), num(11)); // popped: 11, then 4 -> bust
  const deckBefore = game.deck.length;
  settle(game);

  assert.equal(p.status, Status.BUSTED);
  assert.equal(deckBefore - game.deck.length, 2, 'the third card is never flipped');
});

test('an action drawn during Flip Three resolves after the flips', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(0)];
  stack(game, act('flip3'));
  game.hit();
  game.resolveTarget(p.id);

  // Draw order: 12, freeze, 11 -> the freeze waits for the run to finish.
  game.deck.push(num(11), act('freeze'), num(12));
  game.tick(); // flip 12
  game.tick(); // flip freeze -> deferred
  assert.equal(game.pending, null, 'freeze does not interrupt the run');
  assert.equal(game.deferred.length, 1);
  game.tick(); // flip 11
  assert.equal(game.pending, null);
  game.tick(); // close out the run
  game.tick(); // now the freeze opens
  assert.equal(game.request().action, 'freeze');
});

test('busting during Flip Three throws away unresolved actions', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  const p = game.current;
  p.numbers = [num(7)];
  p.secondChance = null;
  stack(game, act('flip3'));
  game.hit();
  game.resolveTarget(p.id);

  game.deck.push(num(3), num(7), act('freeze')); // freeze, then a fatal 7
  settle(game);
  assert.equal(p.status, Status.BUSTED);
  assert.equal(game.deferred.length, 0);
  assert.equal(game.pending, null);
});

test('the turn passes after a single flip', () => {
  const game = makeGame();
  game.startRound();
  settle(game);
  const first = game.current.id;
  stack(game, num(12));
  if (game.current.numbers.some((c) => c.value === 12)) game.current.numbers = [];
  game.hit();
  settle(game);
  assert.notEqual(game.current.id, first, 'one hit, one turn');
});

test('staying keeps your points and ends your round', () => {
  const game = makeGame();
  game.startRound();
  settle(game);
  const p = game.current;
  p.numbers = [num(11), num(2)];
  game.stay();
  assert.equal(p.status, Status.STAYED);
  assert.equal(p.roundScore, 13);
  settle(game);
  assert.notEqual(game.current.id, p.id);
});

test('the round ends when nobody is active and totals carry forward', () => {
  const game = makeGame();
  game.startRound();
  settle(game);

  game.players[0].numbers = [num(12), num(8)];
  game.players[1].numbers = [num(3)];
  for (const p of game.players) p.status = Status.STAYED;

  settle(game);
  assert.equal(game.phase, 'round-over');
  assert.equal(game.players[0].total, 20);
  assert.equal(game.players[1].total, 3);
  assert.deepEqual(game.players[0].history, [20]);
});

test('reaching the target score ends the game', () => {
  const game = makeGame({ targetScore: 30 });
  game.startRound();
  settle(game);
  game.players[0].numbers = [num(12), num(11), num(10)];
  game.players[1].numbers = [num(1)];
  for (const p of game.players) p.status = Status.STAYED;
  settle(game);
  assert.equal(game.phase, 'game-over');
  assert.equal(game.winner.id, 'a');
});

test('a tie at the finish line plays another round', () => {
  const game = makeGame({ targetScore: 20 });
  game.startRound();
  settle(game);
  game.players[0].numbers = [num(12), num(9)];
  game.players[1].numbers = [num(12), num(9)];
  for (const p of game.players) p.status = Status.STAYED;
  settle(game);
  assert.equal(game.phase, 'round-over');
  assert.equal(game.winner, null);
  assert.ok(game.drain().some((e) => e.type === 'tiebreak'));
});

test('bust risk is exact and a shield reads as zero', () => {
  const game = makeGame();
  game.startRound();
  const p = game.players[0];
  p.numbers = [];
  p.secondChance = null;
  game.deck = [num(5), num(5), num(7), mod('add', 2)];

  p.numbers = [num(5)];
  assert.equal(bustChance(game, p), 2 / 4);

  p.secondChance = act('chance');
  assert.equal(bustChance(game, p), 0);
});

test('bots hit an empty hand and bank a winning one', () => {
  const game = makeGame({ targetScore: 50 });
  game.startRound();
  const p = game.players[0];
  p.style = 'balanced';

  p.numbers = [];
  assert.equal(decideMove(game, p), 'hit');

  p.total = 40;
  p.numbers = [num(12), num(11), num(9)]; // 32 banked -> already past 50
  p.secondChance = null;
  assert.equal(decideMove(game, p), 'stay');
});

test('cautious bots fold sooner than reckless ones', () => {
  const game = makeGame();
  game.startRound();
  const hand = () => [num(12), num(11), num(10), num(9), num(8)];

  const timid = game.players[0];
  const wild = game.players[1];
  timid.style = 'cautious';
  wild.style = 'reckless';
  for (const p of [timid, wild]) {
    p.numbers = hand();
    p.secondChance = null;
  }

  const rng = { next: () => 0.5 };
  const timidHits = decideMove(game, timid, rng) === 'hit';
  const wildHits = decideMove(game, wild, rng) === 'hit';
  assert.ok(wildHits || !timidHits, 'reckless is never more timid than cautious');
});

test('bots aim Flip Three at whoever is closest to busting', () => {
  const game = makeGame({
    players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  game.startRound();
  const [a, b, c] = game.players;
  a.numbers = [num(1)];
  b.numbers = [num(2)];
  c.numbers = [num(3)];
  game.deck = [num(2), num(2), num(11), num(12)]; // only 2s are dangerous

  const target = decideTarget(game, a, {
    action: 'flip3',
    targets: ['a', 'b', 'c'],
  });
  assert.equal(target, 'b');
});

test('bots gift a spare shield to the weakest opponent', () => {
  const game = makeGame({ players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  game.startRound();
  game.byId('b').total = 90;
  game.byId('c').total = 12;
  const target = decideTarget(game, game.byId('a'), { action: 'gift', targets: ['b', 'c'] });
  assert.equal(target, 'c');
});

test('a full game with bots always terminates and produces a winner', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const game = new Flip7Game({
      seed,
      targetScore: 200,
      players: [
        { id: 'a', isBot: true, style: 'cautious' },
        { id: 'b', isBot: true, style: 'balanced' },
        { id: 'c', isBot: true, style: 'reckless' },
        { id: 'd', isBot: true, style: 'balanced' },
      ],
    });

    let guard = 0;
    while (game.phase !== 'game-over') {
      if (++guard > 20000) throw new Error(`seed ${seed} never finished`);
      if (game.phase === 'idle' || game.phase === 'round-over') {
        game.startRound();
        continue;
      }
      const req = game.request();
      if (req.type === 'auto') {
        game.tick();
      } else if (req.type === 'move') {
        const p = game.byId(req.playerId);
        if (decideMove(game, p, game.rng) === 'hit') game.hit();
        else game.stay();
      } else if (req.type === 'target') {
        game.resolveTarget(decideTarget(game, game.byId(req.playerId), req, game.rng));
      }
      game.drain();
    }

    assert.ok(game.winner, `seed ${seed} has a winner`);
    assert.ok(game.winner.total >= 200, `seed ${seed} winner cleared the target`);
    const best = Math.max(...game.players.map((p) => p.total));
    assert.equal(game.winner.total, best, `seed ${seed} winner has the top score`);
    // No card should ever vanish or be dealt twice.
    const inHands = game.players.reduce(
      (n, p) =>
        n + p.numbers.length + p.modifiers.length + (p.secondChance ? 1 : 0) + (p.bustCard ? 1 : 0),
      0,
    );
    assert.equal(game.deck.length + game.discard.length + inHands, 94, `seed ${seed} card count`);
  }
});
