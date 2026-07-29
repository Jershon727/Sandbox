import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreHand, isFlip7, formula, FLIP7_BONUS } from '../public/js/scoring.js';

test('an empty hand is worth nothing', () => {
  assert.equal(scoreHand(), 0);
  assert.equal(scoreHand({ numbers: [] }), 0);
});

test('numbers simply add up', () => {
  assert.equal(scoreHand({ numbers: [4, 9, 12] }), 25);
  assert.equal(scoreHand({ numbers: [0] }), 0);
});

test('+ modifiers are added after the numbers', () => {
  assert.equal(scoreHand({ numbers: [3, 5], addMods: [10] }), 18);
  assert.equal(scoreHand({ numbers: [1], addMods: [2, 4, 6, 8, 10] }), 31);
});

test('x2 doubles the numbers only, never the + modifiers', () => {
  assert.equal(scoreHand({ numbers: [10, 5], doubled: true, addMods: [4] }), 34);
  // If x2 also doubled the bonus this would be 38.
  assert.notEqual(scoreHand({ numbers: [10, 5], doubled: true, addMods: [4] }), 38);
});

test('x2 on its own is worth nothing', () => {
  assert.equal(scoreHand({ numbers: [], doubled: true }), 0);
});

test('Flip 7 adds the 15 point bonus on top', () => {
  const numbers = [1, 2, 3, 4, 5, 6, 7];
  assert.equal(scoreHand({ numbers, flip7: true }), 28 + FLIP7_BONUS);
  assert.equal(scoreHand({ numbers, flip7: true, doubled: true }), 56 + FLIP7_BONUS);
});

test('busting zeroes everything, modifiers included', () => {
  assert.equal(
    scoreHand({ numbers: [12, 11], addMods: [10], doubled: true, busted: true }),
    0,
  );
});

test('Flip 7 needs seven distinct numbers', () => {
  assert.equal(isFlip7([1, 2, 3, 4, 5, 6]), false);
  assert.equal(isFlip7([1, 2, 3, 4, 5, 6, 7]), true);
  assert.equal(isFlip7([0, 1, 2, 3, 4, 5, 6]), true, 'a zero counts as a card');
});

test('the formula reads like the arithmetic a player would do', () => {
  assert.equal(formula({ numbers: [4, 9, 12] }), '4 + 9 + 12 = 25');
  assert.equal(
    formula({ numbers: [4, 9, 12], doubled: true, addMods: [10] }),
    '(4 + 9 + 12) × 2 + 10 = 60',
  );
  assert.equal(
    formula({ numbers: [1, 2, 3, 4, 5, 6, 7], flip7: true }),
    '1 + 2 + 3 + 4 + 5 + 6 + 7 + 15 = 43',
  );
  assert.equal(formula({ numbers: [5], busted: true }), 'Busted — 0 for the round');
  assert.match(formula({}), /Tap the cards/);
});

test('a single number is not wrapped in pointless brackets', () => {
  assert.equal(formula({ numbers: [7], doubled: true }), '7 × 2 = 14');
});
