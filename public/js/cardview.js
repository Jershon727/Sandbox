/**
 * Card DOM. One builder used by the table, the score helper and the summaries,
 * so a 12 looks like a 12 everywhere in the app.
 */

import { ACTIONS } from './cards.js';

export function createCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.kind = card.kind;
  if (card.id) el.dataset.id = card.id;

  if (card.kind === 'number') {
    el.dataset.value = String(card.value);
    el.style.setProperty('--c', `var(--n${card.value})`);
    if (card.value >= 10) el.dataset.wide = '';
    el.append(corner(String(card.value)), value(String(card.value)));
    el.setAttribute('aria-label', `${card.value}`);
    return el;
  }

  if (card.kind === 'modifier') {
    const label = card.op === 'mul' ? '×2' : `+${card.value}`;
    el.dataset.mod = card.op;
    el.append(value(label));
    el.setAttribute('aria-label', card.op === 'mul' ? 'times two' : `plus ${card.value}`);
    return el;
  }

  const meta = ACTIONS[card.action];
  el.dataset.action = card.action;
  el.append(icon(`#i-${card.action}`), tag(meta.short));
  el.setAttribute('aria-label', meta.label);
  return el;
}

function value(text) {
  const span = document.createElement('span');
  span.className = 'card__value';
  span.textContent = text;
  return span;
}

/* small top-left index, like a real playing card */
function corner(text) {
  const span = document.createElement('span');
  span.className = 'card__corner';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = text;
  return span;
}

function tag(text) {
  const span = document.createElement('span');
  span.className = 'card__tag';
  span.textContent = text;
  return span;
}

function icon(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'card__icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

/**
 * Animate a freshly inserted card in from wherever it came from (the deck, or
 * the key that was tapped). Measuring after insertion means the card lands in
 * exactly the right place no matter how the hand reflowed.
 */
export function dealFrom(cardEl, sourceEl, delayMs = 0) {
  const to = cardEl.getBoundingClientRect();
  const from = sourceEl?.getBoundingClientRect?.();
  const dx = from ? from.left + from.width / 2 - (to.left + to.width / 2) : 0;
  const dy = from ? from.top + from.height / 2 - (to.top + to.height / 2) : -70;
  cardEl.style.setProperty('--dx', `${Math.round(dx)}px`);
  cardEl.style.setProperty('--dy', `${Math.round(dy)}px`);
  // A Flip Three lands as a little cascade, not a clump — the stylesheet passes
  // the delay through to the card-back reveal too.
  if (delayMs) cardEl.style.animationDelay = `${Math.round(delayMs)}ms`;
  cardEl.classList.add('is-new');
  cardEl.addEventListener(
    'animationend',
    () => {
      cardEl.classList.remove('is-new');
      cardEl.style.animationDelay = '';
    },
    { once: true },
  );
}

/** Seven dots that fill as a hand approaches Flip 7. */
export function renderPips(host, count) {
  if (host.childElementCount !== 7) {
    host.replaceChildren(
      ...Array.from({ length: 7 }, () => {
        const dot = document.createElement('span');
        dot.className = 'pips__dot';
        return dot;
      }),
    );
  }
  [...host.children].forEach((dot, i) => {
    dot.classList.toggle('is-on', i < count);
    dot.classList.toggle('is-hot', count === 6 && i < count);
  });
}
