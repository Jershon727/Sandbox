/**
 * Bot opponents.
 *
 * Each bot weighs the expected value of one more flip against what it would
 * lose by busting, then bends that judgement by a personality factor. The
 * result is opponents who play recognisably differently — which is most of
 * what makes a push-your-luck game fun to play alone.
 */

import { FLIP7_TARGET, FLIP7_BONUS } from './scoring.js';
import { bustChance, expectedGain, flip7Chance } from './odds.js';

export const STYLES = {
  cautious: {
    key: 'cautious',
    label: 'Cautious',
    caution: 1.7,
    chase: 0.5,
    noise: 0.05,
    blurb: 'Banks early. Hates a coin flip.',
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    caution: 1.0,
    chase: 1.0,
    noise: 0.08,
    blurb: 'Plays the odds, mostly.',
  },
  reckless: {
    key: 'reckless',
    label: 'Reckless',
    caution: 0.55,
    chase: 1.6,
    noise: 0.12,
    blurb: 'Chases the 7 like it owes them money.',
  },
};

export const BOT_ROSTER = [
  { name: 'Nova', avatar: '🦊', style: 'balanced' },
  { name: 'Pip', avatar: '🐧', style: 'cautious' },
  { name: 'Blaze', avatar: '🐲', style: 'reckless' },
  { name: 'Momo', avatar: '🐨', style: 'balanced' },
  { name: 'Zed', avatar: '🦉', style: 'cautious' },
];

/** 'hit' or 'stay' for the bot whose turn it is. */
export function decideMove(game, player, rng) {
  const style = STYLES[player.style] ?? STYLES.balanced;
  const p = bustChance(game, player);
  const standing = game.scoreOf(player);
  const uniques = player.numbers.length;

  // Free roll: a Second Chance means the next duplicate can't hurt.
  if (player.secondChance) return 'hit';
  if (uniques === 0) return 'hit';

  // Banking the win beats squeezing out more points.
  const leadTotal = Math.max(...game.players.map((q) => q.total));
  if (
    player.total + standing >= game.targetScore &&
    player.total + standing > leadTotal &&
    p > 0.08
  ) {
    return 'stay';
  }

  const gain = expectedGain(game, player);
  const chaseValue =
    uniques >= FLIP7_TARGET - 2 ? flip7Chance(game, player) * FLIP7_BONUS * style.chase : 0;

  // Behind in the game? A round worth 0 costs less than staying small.
  const deficit = Math.max(0, leadTotal - player.total);
  const desperation = Math.min(0.45, deficit / (game.targetScore * 1.6));

  const reward = (1 - p) * gain + chaseValue;
  const risk = p * standing * style.caution * (1 - desperation);
  const jitter = (rng ? rng.next() : Math.random()) * style.noise * 6;

  return reward + jitter > risk ? 'hit' : 'stay';
}

/** Which player a bot points an action card at. */
export function decideTarget(game, player, request, rng) {
  const candidates = request.targets.map((id) => game.byId(id));
  const others = candidates.filter((p) => p.id !== player.id);
  const pickRandom = (arr) => arr[Math.floor((rng ? rng.next() : Math.random()) * arr.length)];

  if (request.action === 'gift') {
    // Hand the shield to whoever is least threatening.
    return others.sort((a, b) => a.total - b.total)[0]?.id ?? candidates[0].id;
  }

  if (request.action === 'freeze') {
    if (!others.length) return player.id;
    // Freeze locks in whatever the target already has, so hit the player with
    // the most to gain and the least banked: big game total, small round pile.
    const scored = others.map((p) => ({
      id: p.id,
      value: p.total / game.targetScore - game.scoreOf(p) / 45 + (7 - p.numbers.length) / 20,
    }));
    scored.sort((a, b) => b.value - a.value);
    return scored[0].id;
  }

  // Flip Three: shove it at whoever is most likely to blow up.
  const selfRisk = bustChance(game, player);
  const ranked = others
    .map((p) => ({ id: p.id, risk: bustChance(game, p) }))
    .sort((a, b) => b.risk - a.risk);

  if (!ranked.length) return player.id;
  // If nobody else is in danger and my own hand is thin, take the free cards.
  if (ranked[0].risk < 0.25 && selfRisk < 0.15 && player.numbers.length <= 2) return player.id;
  if (ranked[0].risk === ranked[ranked.length - 1].risk) return pickRandom(ranked).id;
  return ranked[0].id;
}

/** A little variance so bots don't all answer at the same beat. */
export function thinkingTime(game, player, rng) {
  const base = 420;
  const spread = 380;
  const r = rng ? rng.next() : Math.random();
  const tension = bustChance(game, player) > 0.3 ? 1.35 : 1;
  return (base + r * spread) * tension;
}
