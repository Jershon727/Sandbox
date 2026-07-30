/**
 * Bot players for the dealt game.
 *
 * Each bot weighs the expected value of one more card against what busting would
 * cost, then bends that judgement by a personality factor. The maths is the same
 * shared core the Bust-O-meter uses, so a bot never acts on different odds from
 * the ones a human is shown.
 *
 * Bots know the composition of the remaining deck. So does every player: in
 * Flip 7 every card is dealt face up, so it's countable. They do not see the
 * order, which is the part that would be cheating.
 */

import { FLIP7_TARGET } from './scoring.js';
import { tallyOf, bustChanceOf, expectedDeltaOf } from './odds.js';

export const STYLES = {
  cautious: {
    key: 'cautious',
    label: 'Careful',
    caution: 1.9,
    noise: 0.6,
    blurb: 'Banks early. Hates a coin flip.',
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    caution: 1.0,
    noise: 1.0,
    blurb: 'Plays the odds, mostly.',
  },
  reckless: {
    key: 'reckless',
    label: 'Wild',
    caution: 0.45,
    noise: 1.6,
    blurb: 'Chases the 7 like it owes them money.',
  },
};

export const BOT_ROSTER = [
  { name: 'Nova', style: 'balanced' },
  { name: 'Pip', style: 'cautious' },
  { name: 'Blaze', style: 'reckless' },
  { name: 'Momo', style: 'balanced' },
  { name: 'Zed', style: 'cautious' },
  { name: 'Wren', style: 'reckless' },
];

const styleOf = (player) => STYLES[player.style] ?? STYLES.balanced;

/** The hand, in the shape the odds core wants. */
function handOf(game, player) {
  return {
    numbers: player.numbers.map((c) => c.value),
    doubled: player.modifiers.some((c) => c.op === 'mul'),
    chance: !!player.secondChance,
    busted: false,
    standing: game.scoreOf(player),
  };
}

/** Chance the next card busts this player, from the deck that's actually left. */
export function bustChanceFor(game, player) {
  return bustChanceOf(tallyOf(game.deck), handOf(game, player));
}

/** Expected change in score from one more card. */
export function expectedDeltaFor(game, player) {
  return expectedDeltaOf(tallyOf(game.deck), handOf(game, player));
}

/** 'hit' or 'stay' for the bot whose turn it is. */
export function decideMove(game, player, rng) {
  const style = styleOf(player);
  const hand = handOf(game, player);
  const standing = hand.standing;

  // Free roll: a Second Chance means the next duplicate can't hurt.
  if (player.secondChance) return 'hit';
  if (!player.numbers.length) return 'hit';
  if (player.numbers.length >= FLIP7_TARGET) return 'stay';

  // Banking the win beats squeezing out more points.
  const leader = Math.max(...game.players.map((q) => q.total));
  if (player.total + standing >= game.targetScore && player.total + standing > leader) {
    return 'stay';
  }

  const tally = tallyOf(game.deck);
  const ev = expectedDeltaOf(tally, hand);
  const risk = bustChanceOf(tally, hand);

  // Caution re-weights only the downside, so a careful bot folds sooner on the
  // same odds and a wild one pushes further, without either ignoring the maths.
  const adjusted = ev - (style.caution - 1) * risk * standing;

  // Behind in the game? A zero costs less than staying small.
  const deficit = Math.max(0, leader - player.total);
  const desperation = Math.min(6, (deficit / game.targetScore) * 12);

  const jitter = ((rng ? rng.next() : Math.random()) - 0.45) * 3 * style.noise;

  return adjusted + desperation + jitter > 0 ? 'hit' : 'stay';
}

/** Which player a bot points an action card at. */
export function decideTarget(game, player, request, rng) {
  const candidates = request.targets.map((id) => game.byId(id));
  const others = candidates.filter((p) => p.id !== player.id);
  const pick = (arr) => arr[Math.floor((rng ? rng.next() : Math.random()) * arr.length)];

  if (request.action === 'gift') {
    // Hand the spare shield to whoever is least threatening.
    return [...others].sort((a, b) => a.total - b.total)[0]?.id ?? candidates[0].id;
  }

  if (request.action === 'freeze') {
    if (!others.length) return player.id;
    // Freezing locks in what they already have, so hit the player with the most
    // still to gain: high game total, small pile in front of them.
    const scored = others.map((p) => ({
      id: p.id,
      value:
        p.total / game.targetScore -
        game.scoreOf(p) / 45 +
        (FLIP7_TARGET - p.numbers.length) / 20,
    }));
    scored.sort((a, b) => b.value - a.value);
    return scored[0].id;
  }

  // Flip Three: shove it at whoever is most likely to blow up.
  const selfRisk = bustChanceFor(game, player);
  const ranked = others
    .map((p) => ({ id: p.id, risk: bustChanceFor(game, p) }))
    .sort((a, b) => b.risk - a.risk);

  if (!ranked.length) return player.id;
  // If nobody else is in danger and my own hand is thin, take the free cards.
  if (ranked[0].risk < 0.25 && selfRisk < 0.15 && player.numbers.length <= 2) return player.id;
  if (ranked[0].risk === ranked[ranked.length - 1].risk) return pick(ranked).id;
  return ranked[0].id;
}

/** A little variance so bots don't all answer on the same beat. */
export function thinkingTime(game, player, rng) {
  const r = rng ? rng.next() : Math.random();
  const tension = bustChanceFor(game, player) > 0.3 ? 1.35 : 1;
  return (700 + r * 700) * tension;
}
