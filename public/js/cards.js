/**
 * The Flip 7 deck: 94 cards.
 *
 *   79 number cards  — one 0, one 1, two 2s, three 3s ... twelve 12s
 *    6 modifier cards — +2 +4 +6 +8 +10 and x2
 *    9 action cards   — 3x Freeze, 3x Flip Three, 3x Second Chance
 */

let uid = 0;
const nextId = () => `c${++uid}`;

export const DECK_SIZE = 94;

export const ACTIONS = {
  freeze: {
    key: 'freeze',
    label: 'Freeze',
    short: 'Freeze',
    blurb: 'Force any player still in the round to bank their points and sit out.',
  },
  flip3: {
    key: 'flip3',
    label: 'Flip Three',
    short: 'Flip 3',
    blurb: 'Force any player still in the round to flip three cards, one at a time.',
  },
  chance: {
    key: 'chance',
    label: 'Second Chance',
    short: '2nd Chance',
    blurb: 'Survive one duplicate. Both cards are discarded and you keep playing.',
  },
};

/** How many copies of each number card are in the deck. */
export function copiesOf(value) {
  return value === 0 ? 1 : value;
}

export function buildDeck() {
  const cards = [];

  for (let value = 0; value <= 12; value++) {
    for (let i = 0; i < copiesOf(value); i++) {
      cards.push({ id: nextId(), kind: 'number', value });
    }
  }

  for (const value of [2, 4, 6, 8, 10]) {
    cards.push({ id: nextId(), kind: 'modifier', op: 'add', value });
  }
  cards.push({ id: nextId(), kind: 'modifier', op: 'mul', value: 2 });

  for (const action of ['freeze', 'flip3', 'chance']) {
    for (let i = 0; i < 3; i++) {
      cards.push({ id: nextId(), kind: 'action', action });
    }
  }

  return cards;
}

export function cardLabel(card) {
  if (!card) return '';
  if (card.kind === 'number') return String(card.value);
  if (card.kind === 'modifier') return card.op === 'mul' ? '×2' : `+${card.value}`;
  return ACTIONS[card.action].label;
}

/** Short, human phrasing used in the activity log and screen-reader announcements. */
export function cardName(card) {
  if (!card) return 'nothing';
  if (card.kind === 'number') return `a ${card.value}`;
  if (card.kind === 'modifier') return card.op === 'mul' ? 'the x2 multiplier' : `a +${card.value}`;
  return `a ${ACTIONS[card.action].label}`;
}
