/**
 * The one place round scores are calculated.
 *
 * Both the digital game and the Score Helper call through here, so a hand
 * tapped in by a player at a real table always totals the same as one dealt
 * by the engine.
 */

export const FLIP7_BONUS = 15;
export const FLIP7_TARGET = 7;

/**
 * @param {object} hand
 * @param {number[]} hand.numbers  face values of the number cards held
 * @param {number[]} hand.addMods  values of the + modifier cards held
 * @param {boolean}  hand.doubled  holding the x2 modifier
 * @param {boolean}  hand.flip7    seven unique numbers
 * @param {boolean}  hand.busted   drew a duplicate without a Second Chance
 */
export function scoreHand({
  numbers = [],
  addMods = [],
  doubled = false,
  flip7 = false,
  busted = false,
} = {}) {
  if (busted) return 0;
  const base = numbers.reduce((sum, v) => sum + v, 0) * (doubled ? 2 : 1);
  const bonus = addMods.reduce((sum, v) => sum + v, 0);
  return base + bonus + (flip7 ? FLIP7_BONUS : 0);
}

/** Seven unique numbers is a Flip 7 — modifiers don't count. */
export function isFlip7(numbers) {
  return new Set(numbers).size >= FLIP7_TARGET;
}

/**
 * Readable arithmetic for the score readout, e.g.
 * `(4 + 9 + 12) × 2 + 10 + 15 = 75`
 */
export function formula(hand) {
  const { numbers = [], addMods = [], doubled = false, flip7 = false, busted = false } = hand;
  if (busted) return 'Busted — 0 for the round';
  if (!numbers.length && !addMods.length) return 'Tap the cards you were dealt';

  const parts = [];
  const nums = numbers.join(' + ');
  if (numbers.length) {
    parts.push(doubled && numbers.length > 1 ? `(${nums})` : nums || '0');
  } else if (doubled) {
    parts.push('0');
  }
  if (doubled) parts.push('× 2');
  for (const m of addMods) parts.push(`+ ${m}`);
  if (flip7) parts.push(`+ ${FLIP7_BONUS}`);
  return `${parts.join(' ')} = ${scoreHand(hand)}`;
}
