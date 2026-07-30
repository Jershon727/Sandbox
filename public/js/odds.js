/**
 * Bust odds, and a hit-or-stay recommendation.
 *
 * What the app can honestly know: every card the table has tapped in this
 * round. From that it works out what's left in a 94-card deck and how much of
 * that would bust you.
 *
 * Two things it can't know, both stated in the UI rather than hidden:
 *   - Cards dealt in earlier rounds. The model assumes this round starts from a
 *     full deck, which is right for round one and gets gradually optimistic.
 *   - Freeze and Flip Three cards, which nobody taps because they don't score.
 *     Six cards that may already be gone are still counted as available.
 *
 * The recommendation is one-card lookahead: is *one more* card worth it? That's
 * the actual decision in front of you, and you get to ask again afterwards.
 */

import { FLIP7_BONUS, FLIP7_TARGET } from './scoring.js';
import { playerList, readHand, roundScore } from './room.js';

/** Copies of each number in a full deck: one 0, one 1, two 2s ... twelve 12s. */
export function deckCopies(value) {
  return value === 0 ? 1 : value;
}

export const MOD_ADDS = [2, 4, 6, 8, 10];
export const ACTION_COUNT = 9; // 3 Freeze, 3 Flip Three, 3 Second Chance

/** What's left in the deck, given everything face-up on the table. */
export function remaining(room) {
  const numbers = new Map();
  for (let v = 0; v <= 12; v++) numbers.set(v, deckCopies(v));

  const addsLeft = new Set(MOD_ADDS);
  let mulLeft = 1;
  let chancesHeld = 0;

  for (const player of playerList(room)) {
    const hand = readHand(player.hand);
    for (const v of hand.numbers) numbers.set(v, Math.max(0, (numbers.get(v) ?? 0) - 1));
    for (const mod of hand.mods) {
      if (mod.op === 'mul') mulLeft = 0;
      else addsLeft.delete(mod.value);
    }
    if (hand.chance) chancesHeld += 1;
  }

  const numberTotal = [...numbers.values()].reduce((a, b) => a + b, 0);
  const actionsLeft = Math.max(0, ACTION_COUNT - chancesHeld);

  return {
    numbers,
    adds: [...addsLeft],
    mul: mulLeft,
    actions: actionsLeft,
    total: numberTotal + addsLeft.size + mulLeft + actionsLeft,
  };
}

/**
 * Chance the next card busts this player.
 * A Second Chance absorbs the first duplicate, so nothing can bust them yet.
 */
export function bustChance(room, playerId) {
  const player = room?.players?.[playerId];
  if (!player) return 0;
  const hand = readHand(player.hand);
  if (hand.busted || hand.chance) return 0;

  const left = remaining(room);
  if (!left.total) return 0;

  let deadly = 0;
  for (const v of new Set(hand.numbers)) deadly += left.numbers.get(v) ?? 0;
  return deadly / left.total;
}

export function riskBand(p) {
  if (p < 0.12) return 'safe';
  if (p < 0.3) return 'ok';
  if (p < 0.5) return 'warm';
  return 'hot';
}

/** How many unseen cards would bust you, and out of how many. */
export function bustCards(room, playerId) {
  const player = room?.players?.[playerId];
  const hand = readHand(player?.hand);
  const left = remaining(room);
  let deadly = 0;
  for (const v of new Set(hand.numbers)) deadly += left.numbers.get(v) ?? 0;
  return { deadly, total: left.total };
}

/**
 * Expected change in this round's score from taking exactly one more card.
 * Positive means the card is worth taking.
 */
export function expectedDelta(room, playerId) {
  const player = room?.players?.[playerId];
  if (!player) return 0;
  const hand = readHand(player.hand);
  const left = remaining(room);
  if (!left.total) return 0;

  const standing = roundScore(hand);
  const owned = new Set(hand.numbers);
  const doubled = hand.mods.some((m) => m.op === 'mul');
  const numberSum = hand.numbers.reduce((a, b) => a + b, 0);
  const uniques = owned.size;

  let sum = 0;

  for (const [value, count] of left.numbers) {
    if (!count) continue;
    if (owned.has(value)) {
      // A duplicate: the shield eats it, otherwise the round is gone.
      sum += count * (hand.chance ? 0 : -standing);
    } else {
      const gained = doubled ? value * 2 : value;
      const completes = uniques + 1 >= FLIP7_TARGET ? FLIP7_BONUS : 0;
      sum += count * (gained + completes);
    }
  }

  for (const add of left.adds) sum += add;
  if (left.mul) sum += numberSum; // doubling is worth what you already hold
  // Freeze, Flip Three and Second Chance add no points on their own.

  return sum / left.total;
}

/**
 * Hit or stay, with the reasoning behind it.
 * `target` and `myTotal` let it recognise a hand that already wins the game.
 */
export function advise(room, playerId) {
  const player = room?.players?.[playerId];
  if (!player) return null;

  const hand = readHand(player.hand);
  const standing = roundScore(hand);
  const risk = bustChance(room, playerId);
  const { deadly, total } = bustCards(room, playerId);
  const band = riskBand(risk);
  const uniques = new Set(hand.numbers).size;

  if (hand.busted) {
    return { move: 'none', risk: 0, band: 'safe', headline: 'Round over for you', why: 'This hand busted.' };
  }
  if (uniques >= FLIP7_TARGET) {
    return {
      move: 'none',
      risk: 0,
      band: 'safe',
      headline: 'Flip 7 — stop there',
      why: `Seven different numbers. That's ${standing} with the bonus, and the round ends.`,
    };
  }

  if (!hand.numbers.length) {
    return {
      move: 'hit',
      risk: 0,
      band: 'safe',
      headline: 'Hit',
      why: 'Nothing in front of you yet — no card can bust you.',
    };
  }

  if (hand.chance) {
    return {
      move: 'hit',
      risk: 0,
      band: 'safe',
      headline: 'Hit',
      why: 'Your Second Chance covers the next duplicate, so this card is free.',
    };
  }

  // Banking a winning score beats squeezing out more points.
  const target = room.target ?? 200;
  const myTotal = player.total ?? 0;
  const best = Math.max(...playerList(room).map((p) => p.total ?? 0));
  if (myTotal + standing >= target && myTotal + standing > best) {
    return {
      move: 'stay',
      risk,
      band,
      headline: 'Stay — this wins it',
      why: `${myTotal + standing} puts you past ${target} and ahead of everyone. Don't risk it.`,
    };
  }

  const ev = expectedDelta(room, playerId);
  const pct = Math.round(risk * 100);
  const chasing = uniques === FLIP7_TARGET - 1;

  if (ev > 0) {
    return {
      move: 'hit',
      risk,
      band,
      ev,
      headline: 'Hit',
      why: chasing
        ? `One card from Flip 7. ${deadly} of the ${total} unseen cards would bust you (${pct}%), but the +${FLIP7_BONUS} bonus is worth the risk.`
        : `${deadly} of the ${total} unseen cards would bust you (${pct}%). On average another card still gains you about ${Math.round(ev)}.`,
    };
  }

  return {
    move: 'stay',
    risk,
    band,
    ev,
    headline: 'Stay',
    why: `${deadly} of the ${total} unseen cards would bust you (${pct}%). Risking ${standing} points is not worth the average gain.`,
  };
}
