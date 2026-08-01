/**
 * Shared bits of chrome: modals, toasts, the big centre banner and the
 * scoreboard rows. Both the game and the score helper render through these so
 * the two modes feel like one app.
 */

import { speedFactor } from './storage.js';
import { monogram } from './avatar.js';

export const wait = (ms) => new Promise((r) => setTimeout(r, ms * speedFactor()));

// ── modals ────────────────────────────────────────────────────────────────

let lastFocus = null;
const openStack = [];

export function openModal(id) {
  const el = typeof id === 'string' ? document.getElementById(`modal-${id}`) : id;
  if (!el || !el.hidden) return el;
  lastFocus = document.activeElement;
  el.hidden = false;
  openStack.push(el);
  const focusable = el.querySelector(
    'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
  );
  focusable?.focus();
  return el;
}

export function closeModal(el) {
  const modal = el ?? openStack[openStack.length - 1];
  if (!modal) return;
  modal.hidden = true;
  const i = openStack.indexOf(modal);
  if (i > -1) openStack.splice(i, 1);
  if (!openStack.length && lastFocus?.isConnected) lastFocus.focus();
}

export function closeAllModals() {
  while (openStack.length) closeModal(openStack[openStack.length - 1]);
}

export const anyModalOpen = () => openStack.length > 0;

/** Keep tab focus inside the topmost dialog. */
export function trapFocus(event) {
  const modal = openStack[openStack.length - 1];
  if (!modal || event.key !== 'Tab') return;
  const items = [
    ...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]'),
  ].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ── toast ─────────────────────────────────────────────────────────────────

let toastTimer = 0;

export function toast(message, ms = 1900) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

// ── centre banner ─────────────────────────────────────────────────────────

/**
 * The big centre announcement.
 *
 * `card` takes a rendered card element. "You busted" or "you were frozen" are
 * much easier to believe when the card that did it is on the screen, so the
 * banner can carry one.
 */
export async function showBanner(text, { tone = '', sub = '', ms = 950, card = null } = {}) {
  const el = document.getElementById('banner');
  if (!el) return;
  el.dataset.tone = tone;
  const box = document.createElement('p');
  box.className = 'banner__text';
  box.textContent = text;
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    box.append(small);
  }
  if (card) {
    const holder = document.createElement('span');
    holder.className = 'banner__card';
    holder.append(card);
    el.replaceChildren(holder, box);
  } else {
    el.replaceChildren(box);
  }
  el.classList.add('is-on');
  await wait(ms);
  el.classList.remove('is-on');
  el.replaceChildren();
}

export function announce(text) {
  const el = document.getElementById('announcer');
  if (el) el.textContent = text;
}

// ── scoreboards ───────────────────────────────────────────────────────────

/**
 * @param {object[]} rows  { name, seat, delta, total, note, busted, winner }
 * @param {number} target  used to draw the race-to-target progress bar
 */
export function fillScores(host, rows, target) {
  host.replaceChildren();
  const ranked = [...rows].sort((a, b) => b.total - a.total);

  ranked.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'row';
    if (row.winner) el.classList.add('is-winner');
    if (row.busted) el.classList.add('is-busted');

    const rank = document.createElement('span');
    rank.className = 'row__rank';
    if (row.seat != null) rank.append(monogram(row.name, row.seat));
    else rank.textContent = `${i + 1}`;

    const name = document.createElement('span');
    name.className = 'row__name';
    name.textContent = row.name;
    if (row.note) {
      const note = document.createElement('small');
      note.className = 'row__note';
      note.textContent = row.note;
      name.append(note);
    }

    const delta = document.createElement('span');
    delta.className = 'row__delta';
    delta.textContent = row.busted ? 'bust' : `+${row.delta}`;

    const total = document.createElement('span');
    total.className = 'row__total';
    total.textContent = String(row.total);

    el.append(rank, name, delta, total);

    if (target) {
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.className = 'bar__fill';
      bar.append(fill);
      el.append(bar);
      // Let the row paint before the bar animates, so the fill is visible.
      requestAnimationFrame(() => {
        fill.style.width = `${Math.min(100, (row.total / target) * 100)}%`;
      });
    }

    host.append(el);
  });
}
