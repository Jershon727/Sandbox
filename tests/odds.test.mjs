import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deckCopies,
  remaining,
  bustChance,
  bustCards,
  expectedDelta,
  advise,
  riskBand,
  MOD_ADDS,
  ACTION_COUNT,
} from '../public/js/odds.js';

const hand = (numbers = [], mods = [], extra = {}) => ({
  numbers,
  mods,
  chance: false,
  busted: false,
  ...extra,
});

function room(players, extra = {}) {
  return {
    code: 'ABCD',
    target: 200,
    round: 1,
    hostId: 'me',
    status: 'playing',
    players,
    ...extra,
  };
}

const solo = (h, total = 0) => room({ me: { name: 'Me', order: 0, total, hand: h } });

// ── the deck it reasons about ─────────────────────────────────────────────

test('the model uses the real deck', () => {
  const left = remaining(room({}));
  let numbers = 0;
  for (let v = 0; v <= 12; v++) {
    assert.equal(left.numbers.get(v), deckCopies(v), `copies of ${v}`);
    numbers += left.numbers.get(v);
  }
  assert.equal(numbers, 79, 'number cards');
  assert.equal(left.adds.length, MOD_ADDS.length);
  assert.equal(left.mul, 1);
  assert.equal(left.actions, ACTION_COUNT);
  assert.equal(left.total, 94, 'the whole deck');
});

test('cards on the table are removed from what is left', () => {
  const left = remaining(
    room({
      a: { order: 0, hand: hand([12, 12, 5], [{ op: 'mul', value: 2 }]) },
      b: { order: 1, hand: hand([7], [{ op: 'add', value: 10 }], { chance: true }) },
    }),
  );
  assert.equal(left.numbers.get(12), 10, 'two of the twelve 12s are showing');
  assert.equal(left.numbers.get(5), 4);
  assert.equal(left.numbers.get(7), 6);
  assert.equal(left.mul, 0, 'the x2 is taken');
  assert.ok(!left.adds.includes(10), 'the +10 is taken');
  assert.equal(left.actions, ACTION_COUNT - 1, 'a Second Chance is being held');
  // Face-up: four numbers (12, 12, 5, 7), the x2, the +10, and one shield = 7.
  assert.equal(left.total, 94 - 7);
});

test('a hand cannot drive a count below zero', () => {
  // Defensive: a mis-tapped extra 0 shouldn't produce negative counts.
  const left = remaining(room({ a: { order: 0, hand: hand([0, 0, 0]) } }));
  assert.equal(left.numbers.get(0), 0);
  assert.ok(left.total > 0);
});

// ── bust chance ───────────────────────────────────────────────────────────

test('an empty hand cannot bust', () => {
  assert.equal(bustChance(solo(hand()), 'me'), 0);
});

test('bust chance counts every remaining copy of what you hold', () => {
  const r = solo(hand([12, 3]));
  const left = remaining(r);
  // 11 twelves and 2 threes are still out there.
  const expected = (left.numbers.get(12) + left.numbers.get(3)) / left.total;
  assert.equal(bustChance(r, 'me'), expected);
  const { deadly, total } = bustCards(r, 'me');
  assert.equal(deadly, 11 + 2);
  assert.equal(total, 94 - 2);
});

test('holding a low number is far safer than holding a high one', () => {
  assert.ok(bustChance(solo(hand([1])), 'me') < bustChance(solo(hand([12])), 'me'));
});

test('a Second Chance reads as no risk', () => {
  assert.equal(bustChance(solo(hand([12], [], { chance: true })), 'me'), 0);
});

test('a busted hand has no further risk', () => {
  assert.equal(bustChance(solo(hand([12], [], { busted: true })), 'me'), 0);
});

test("other players' cards lower your risk", () => {
  const alone = solo(hand([12]));
  const withOthers = room({
    me: { order: 0, total: 0, hand: hand([12]) },
    other: { order: 1, total: 0, hand: hand([12, 12, 12]) },
  });
  assert.ok(
    bustChance(withOthers, 'me') < bustChance(alone, 'me'),
    'three 12s showing elsewhere means three fewer that can bust you',
  );
});

test('risk bands rise with the number', () => {
  assert.equal(riskBand(0.05), 'safe');
  assert.equal(riskBand(0.2), 'ok');
  assert.equal(riskBand(0.4), 'warm');
  assert.equal(riskBand(0.75), 'hot');
});

// ── expected value of one more card ───────────────────────────────────────

test('with nothing to lose, one more card is always worth it', () => {
  assert.ok(expectedDelta(solo(hand()), 'me') > 0);
  assert.ok(expectedDelta(solo(hand([1])), 'me') > 0);
});

test('a big hand of high cards is worth protecting', () => {
  // 12+11+10+9+8+7 = 57 at stake, and 57 of the deck's cards are duplicates.
  const ev = expectedDelta(solo(hand([12, 11, 10, 9, 8, 7])), 'me');
  assert.ok(ev < 0, `expected a negative EV, got ${ev}`);
});

test('the Flip 7 bonus shows up in the maths at six uniques', () => {
  const withBonus = expectedDelta(solo(hand([1, 2, 3, 4, 5, 6])), 'me');
  const sameCardsNoBonus = expectedDelta(solo(hand([1, 2, 3, 4, 5])), 'me');
  assert.ok(
    withBonus > sameCardsNoBonus,
    `six uniques (${withBonus}) should beat five (${sameCardsNoBonus}) thanks to the +15`,
  );
});

test('x2 makes every further number worth double', () => {
  const plain = expectedDelta(solo(hand([3])), 'me');
  const doubled = expectedDelta(solo(hand([3], [{ op: 'mul', value: 2 }])), 'me');
  assert.ok(doubled > plain);
});

test('a Second Chance removes the downside entirely', () => {
  const exposed = expectedDelta(solo(hand([12, 11, 10, 9, 8, 7])), 'me');
  const shielded = expectedDelta(solo(hand([12, 11, 10, 9, 8, 7], [], { chance: true })), 'me');
  assert.ok(shielded > exposed);
  assert.ok(shielded > 0, 'nothing to lose means the card is free');
});

// ── the recommendation ────────────────────────────────────────────────────

test('it says hit on an empty hand, and says why', () => {
  const a = advise(solo(hand()), 'me');
  assert.equal(a.move, 'hit');
  assert.match(a.why, /no card can bust you/i);
});

test('it says hit while a Second Chance is held', () => {
  const a = advise(solo(hand([12, 11, 10, 9, 8, 7], [], { chance: true })), 'me');
  assert.equal(a.move, 'hit');
  assert.match(a.why, /Second Chance/);
  assert.equal(a.risk, 0);
});

test('it says stay on a fat, exposed hand', () => {
  const a = advise(solo(hand([12, 11, 10, 9, 8, 7])), 'me');
  assert.equal(a.move, 'stay');
  assert.match(a.why, /would bust you/);
});

test('it chases the Flip 7 from six uniques', () => {
  const a = advise(solo(hand([1, 2, 3, 4, 5, 6])), 'me');
  assert.equal(a.move, 'hit');
  assert.match(a.why, /Flip 7/);
});

test('it recognises a hand that already wins the game', () => {
  const r = room(
    {
      me: { order: 0, total: 190, hand: hand([12, 11]) },
      other: { order: 1, total: 100, hand: hand() },
    },
    { target: 200 },
  );
  const a = advise(r, 'me');
  assert.equal(a.move, 'stay');
  assert.match(a.headline, /wins it/i);
  assert.match(a.why, /213/, 'it names the winning total');
});

test('a winning total that is not the highest is not a reason to stop', () => {
  const r = room(
    {
      me: { order: 0, total: 190, hand: hand([5]) },
      other: { order: 1, total: 260, hand: hand() },
    },
    { target: 200 },
  );
  const a = advise(r, 'me');
  assert.notEqual(a.headline, 'Stay — this wins it');
});

test('it steps back once the round is decided', () => {
  assert.equal(advise(solo(hand([4], [], { busted: true })), 'me').move, 'none');
  const seven = advise(solo(hand([0, 1, 2, 3, 4, 5, 6])), 'me');
  assert.equal(seven.move, 'none');
  assert.match(seven.headline, /Flip 7/);
});

test('the risk it quotes matches the cards it names', () => {
  const r = solo(hand([9, 4]));
  const a = advise(r, 'me');
  const { deadly, total } = bustCards(r, 'me');
  assert.match(a.why, new RegExp(`${deadly} of the ${total} unseen`));
  assert.equal(Math.round(a.risk * 100), Math.round((deadly / total) * 100));
});

test('advice needs a player that exists', () => {
  assert.equal(advise(solo(hand()), 'nobody'), null);
  assert.equal(bustChance(solo(hand()), 'nobody'), 0);
});

test('the advice never contradicts itself on hit versus stay', () => {
  // Sweep hands from thin to fat: once it says stay it should not flip back to
  // hit as the hand gets strictly more dangerous.
  const ladder = [[1], [1, 2], [1, 2, 12], [1, 2, 12, 11], [1, 2, 12, 11, 10], [12, 11, 10, 9, 8]];
  let said = null;
  for (const numbers of ladder) {
    const a = advise(solo(hand(numbers)), 'me');
    if (said === 'stay') {
      assert.equal(a.move, 'stay', `hand ${numbers.join(',')} flipped back to hit`);
    }
    said = a.move;
  }
});
