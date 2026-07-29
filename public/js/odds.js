/**
 * Odds helpers.
 *
 * Every card in Flip 7 is dealt face up, so the exact composition of the
 * remaining deck is public information. Showing the bust risk isn't giving
 * anything away — it just saves the player from counting 94 cards by hand,
 * and it turns "hit or stay" into a real decision instead of a shrug.
 */

import { FLIP7_TARGET } from './scoring.js';

/** Cards the player could still draw. */
function pool(game) {
  return game.deck.length ? game.deck : game.discard;
}

/** Probability that the next card busts this player. */
export function bustChance(game, player) {
  const cards = pool(game);
  if (!cards.length) return 0;
  if (player.secondChance) return 0; // the shield absorbs the first duplicate
  const owned = new Set(player.numbers.map((c) => c.value));
  const deadly = cards.filter((c) => c.kind === 'number' && owned.has(c.value)).length;
  return deadly / cards.length;
}

/** Probability the next card is a brand new number (progress toward Flip 7). */
export function freshNumberChance(game, player) {
  const cards = pool(game);
  if (!cards.length) return 0;
  const owned = new Set(player.numbers.map((c) => c.value));
  const fresh = cards.filter((c) => c.kind === 'number' && !owned.has(c.value)).length;
  return fresh / cards.length;
}

/** Expected points added by one non-busting draw. */
export function expectedGain(game, player) {
  const cards = pool(game);
  if (!cards.length) return 0;
  const owned = new Set(player.numbers.map((c) => c.value));
  const doubled = player.modifiers.some((c) => c.op === 'mul');
  let sum = 0;
  let n = 0;
  for (const c of cards) {
    if (c.kind === 'number') {
      if (owned.has(c.value)) continue; // busts are accounted for separately
      sum += doubled ? c.value * 2 : c.value;
    } else if (c.kind === 'modifier') {
      sum += c.op === 'mul' ? player.numbers.reduce((s, x) => s + x.value, 0) : c.value;
    }
    n += 1;
  }
  return n ? sum / n : 0;
}

/** Rough chance of running the table to 7 uniques from here. */
export function flip7Chance(game, player) {
  const need = FLIP7_TARGET - player.numbers.length;
  if (need <= 0) return 1;
  const cards = pool(game);
  if (!cards.length) return 0;
  const owned = new Set(player.numbers.map((c) => c.value));
  let fresh = 0;
  for (const c of cards) if (c.kind === 'number' && !owned.has(c.value)) fresh += 1;
  // Optimistic chain estimate: each of the next `need` draws must be fresh.
  const p = fresh / cards.length;
  return Math.pow(p, need);
}

export function riskBand(p) {
  if (p < 0.12) return 'safe';
  if (p < 0.3) return 'ok';
  if (p < 0.5) return 'warm';
  return 'hot';
}
