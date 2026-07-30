/**
 * The scoring surface: live standings for the table, and the keypad for the
 * hand you're responsible for.
 *
 * Every tap is a small write to one player's own subtree, so two people tapping
 * at the same moment never collide. Undo is local — it walks back the hand you
 * were editing, not somebody else's.
 */

import { scoreHand, formula, FLIP7_TARGET } from './scoring.js';
import { createCard, dealFrom, renderPips } from './cardview.js';
import {
  emptyHand,
  handShape,
  readHand,
  roundScore,
  standings,
  playerList,
  isAway,
  roundLooksDone,
} from './room.js';
import { advise } from './odds.js';
import { toast, showBanner } from './views.js';
import { sfx } from './sound.js';
import { burstFrom } from './fx.js';
import { settings } from './storage.js';

const MOD_KEYS = [
  { op: 'add', value: 2 },
  { op: 'add', value: 4 },
  { op: 'add', value: 6 },
  { op: 'add', value: 8 },
  { op: 'add', value: 10 },
  { op: 'mul', value: 2 },
];

export class Scorer {
  constructor(store) {
    this.store = store;
    this.selectedId = null;
    this.undoStack = [];
    this.flag = null; // transient badge: bust | flip7 | save
    this.lastFlip7 = null; // so a Flip 7 is only announced once
    this.dealSource = null;
  }

  mount() {
    const id = (x) => document.getElementById(x);
    this.el = {
      standings: id('standings'),
      card: id('hand-card'),
      whose: id('whose'),
      pips: id('pips'),
      flag: id('flag'),
      hand: id('hand'),
      score: id('round-score'),
      formula: id('formula'),
      pad: id('pad'),
      undo: id('btn-undo'),
      clear: id('btn-clear'),
      end: id('btn-end-round'),
      waiting: id('waiting'),
      advice: id('advice'),
      adviceRow: id('advice-row'),
      adviceNeedle: id('advice-needle'),
      advicePct: id('advice-pct'),
      adviceRec: id('advice-rec'),
      adviceWhy: id('advice-why'),
      adviceReason: id('advice-reason'),
    };

    this.buildPad();
    this.el.undo.addEventListener('click', () => this.undo());
    this.el.clear.addEventListener('click', () => this.clearHand());

    this.el.adviceRow.addEventListener('click', () => {
      const open = this.el.adviceWhy.hidden;
      this.el.adviceWhy.hidden = !open;
      this.el.adviceRow.setAttribute('aria-expanded', String(open));
      sfx.tap();
    });
  }

  // ── whose hand am I editing ─────────────────────────────────────────────

  get target() {
    const state = this.store.state;
    if (!state) return null;
    const id =
      this.selectedId && state.players?.[this.selectedId] ? this.selectedId : this.store.myId;
    return state.players?.[id] ? { id, ...state.players[id] } : null;
  }

  get hand() {
    return readHand(this.target?.hand);
  }

  select(playerId) {
    // In a dealt game, tapping a player is how you aim an action card.
    const pending = this.store.state?.pending;
    if (this.store.isDealt) {
      if (pending?.byId === this.store.myId && pending.targets.includes(playerId)) {
        sfx.tap();
        this.store.intent({ do: 'target', targetId: playerId });
      } else {
        sfx.error();
        toast('The dealer is running this one');
      }
      return;
    }

    if (!this.store.canEdit(playerId)) {
      const name = this.store.state?.players?.[playerId]?.name ?? 'They';
      sfx.error();
      return toast(`${name} taps their own cards`);
    }
    this.selectedId = playerId;
    this.undoStack = [];
    this.flag = null;
    sfx.tap();
    this.render();
  }

  // ── writing a hand ──────────────────────────────────────────────────────

  writeHand(hand) {
    const t = this.target;
    if (!t) return Promise.resolve();
    // Only the dealer writes hands in a dealt game.
    if (this.store.isDealt) return Promise.resolve();
    this.undoStack.push({ id: t.id, hand: structuredClone(this.hand) });
    if (this.undoStack.length > 40) this.undoStack.shift();
    return this.store.update({ [`players/${t.id}/hand`]: hand });
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) {
      sfx.error();
      return toast('Nothing to undo');
    }
    this.flag = null;
    sfx.tap();
    this.store.update({ [`players/${prev.id}/hand`]: prev.hand });
  }

  clearHand() {
    const hand = this.hand;
    if (!hand.numbers.length && !hand.mods.length && !hand.chance && !hand.busted) return;
    sfx.tap();
    this.flag = null;
    this.writeHand(emptyHand());
  }

  // ── the keypad ──────────────────────────────────────────────────────────

  buildPad() {
    const pad = this.el.pad;
    pad.replaceChildren();
    this.padKeys = new Map();

    for (let v = 0; v <= 12; v++) {
      const key = document.createElement('button');
      key.className = 'pad__key';
      key.type = 'button';
      key.style.setProperty('--c', `var(--n${v})`);
      key.textContent = String(v);
      key.setAttribute('aria-label', `Add a ${v}`);
      if (v >= 10) key.classList.add('pad__key--wide');
      key.addEventListener('click', () => this.tapNumber(v, key));
      pad.append(key);
      this.padKeys.set(`n${v}`, key);
    }

    const chance = utilKey('Second Chance', '#i-chance');
    chance.addEventListener('click', () => this.toggleChance(chance));
    pad.append(chance);
    this.padKeys.set('chance', chance);

    for (const m of MOD_KEYS) {
      const key = document.createElement('button');
      key.className = 'pad__key pad__key--mod';
      key.type = 'button';
      key.textContent = m.op === 'mul' ? '×2' : `+${m.value}`;
      key.setAttribute('aria-label', m.op === 'mul' ? 'Times two' : `Plus ${m.value}`);
      key.addEventListener('click', () => this.toggleMod(m, key));
      pad.append(key);
      this.padKeys.set(`m${m.op}${m.value}`, key);
    }

    const bust = utilKey('Busted', null, 'Bust');
    bust.classList.add('pad__key--danger');
    bust.addEventListener('click', () => this.toggleBust());
    pad.append(bust);
    this.padKeys.set('bust', bust);
  }

  tapNumber(v, keyEl) {
    const hand = this.hand;
    if (!this.target) return;

    if (hand.busted) {
      sfx.error();
      return toast('This hand busted — undo if that was a mistake');
    }
    if (hand.numbers.length >= FLIP7_TARGET) {
      sfx.error();
      return toast("That's a Flip 7 already — the round is over");
    }

    const duplicate = hand.numbers.includes(v);

    if (duplicate && hand.chance) {
      sfx.save();
      this.flag = 'save';
      this.writeHand({ ...hand, chance: false });
      showBanner('Second Chance!', { tone: 'save', sub: `the ${v} is discarded`, ms: 900 });
      return;
    }

    if (duplicate) {
      sfx.bust();
      this.flag = 'bust';
      this.writeHand({ ...hand, busted: true });
      this.el.card.classList.add('is-shaking');
      setTimeout(() => this.el.card.classList.remove('is-shaking'), 500);
      showBanner('Busted', { tone: 'bust', sub: `a second ${v}`, ms: 1000 });
      return;
    }

    sfx.gain(v);
    this.flag = null;
    this.dealSource = keyEl;
    this.writeHand({ ...hand, numbers: [...hand.numbers, v] });
  }

  toggleMod(m, keyEl) {
    const hand = this.hand;
    if (!this.target) return;
    const i = hand.mods.findIndex((x) => x.op === m.op && x.value === m.value);
    const mods = [...hand.mods];
    if (i > -1) {
      mods.splice(i, 1);
      sfx.tap();
    } else {
      mods.push({ ...m });
      sfx.modifier();
      this.dealSource = keyEl;
    }
    this.writeHand({ ...hand, mods });
  }

  toggleChance(keyEl) {
    const hand = this.hand;
    if (!this.target) return;
    const next = !hand.chance;
    if (next) {
      sfx.modifier();
      this.dealSource = keyEl;
    } else {
      sfx.tap();
    }
    this.writeHand({ ...hand, chance: next });
  }

  toggleBust() {
    const hand = this.hand;
    if (!this.target) return;
    const next = !hand.busted;
    this.flag = next ? 'bust' : null;
    if (next) sfx.bust();
    else sfx.tap();
    this.writeHand({ ...hand, busted: next });
  }

  removeCard(kind, index) {
    const hand = this.hand;
    const next = { ...hand, numbers: [...hand.numbers], mods: [...hand.mods] };
    if (kind === 'number') next.numbers.splice(index, 1);
    else if (kind === 'mod') next.mods.splice(index, 1);
    else if (kind === 'chance') next.chance = false;
    this.flag = null;
    sfx.tap();
    this.writeHand(next);
  }

  // ── render ──────────────────────────────────────────────────────────────

  render() {
    const state = this.store.state;
    if (!state) return;

    this.renderStandings();

    const dealt = this.store.isDealt;
    // A dealt game always shows you your own hand; nobody edits anyone's.
    if (dealt) this.selectedId = null;

    const t = this.target;
    const hand = this.hand;
    const shape = handShape(hand);
    const score = scoreHand(shape);
    const mine = t?.id === this.store.myId;

    this.el.whose.textContent = dealt
      ? 'Your hand'
      : mine
        ? 'Your hand'
        : `${t?.name ?? ''}'s hand`;
    this.el.card.classList.toggle('is-proxy', !mine);

    const labels = { bust: 'Busted', flip7: 'Flip 7!', save: 'Saved' };
    const flag =
      this.flag && labels[this.flag]
        ? this.flag
        : shape.busted
          ? 'bust'
          : shape.flip7
            ? 'flip7'
            : null;
    this.el.flag.hidden = !flag;
    if (flag) {
      this.el.flag.textContent = labels[flag];
      this.el.flag.dataset.tone = flag;
    }

    this.el.card.classList.toggle('is-busted', shape.busted);
    this.el.card.classList.toggle('is-flip7', shape.flip7 && !shape.busted);
    renderPips(this.el.pips, hand.numbers.length);
    this.renderHand(hand, shape);

    this.el.score.textContent = String(score);
    this.el.score.classList.toggle('is-zero', score === 0);
    this.el.formula.textContent = formula(shape);
    this.renderPadState(hand);
    this.renderAdvice(t);

    // Only the host ends the round, so the whole table banks on the same beat.
    // In a dealt game the dealer decides, so neither control applies.
    const host = this.store.isHost;
    if (!dealt) {
      this.el.end.hidden = !host;
      this.el.waiting.hidden = host;
      if (host) this.el.end.classList.toggle('is-ready', roundLooksDone(state));
    }

    this.announceFlip7();
  }

  /**
   * The bust odds and the recommendation.
   *
   * Every card in Flip 7 is dealt face up, so this is arithmetic over public
   * information — it isn't telling you anything you couldn't count yourself.
   */
  renderAdvice(target) {
    const el = this.el;
    // Nothing to advise before the cards go out, or while you're sitting a round out.
    if (!settings.advice || !target || this.store.state?.lobby || target.waiting) {
      el.advice.hidden = true;
      return;
    }

    const a = advise(this.store.state, target.id);
    if (!a || a.move === 'none') {
      // Nothing to decide once the hand is busted or already at seven.
      el.advice.hidden = true;
      return;
    }

    el.advice.hidden = false;
    el.advice.dataset.band = a.band;
    el.advice.dataset.move = a.move;

    const pct = Math.round(a.risk * 100);
    // The needle slides via CSS; the number is tweened to match it.
    el.adviceNeedle.style.setProperty('--pct', String(Math.min(100, pct)));
    this.tweenPct(pct);
    el.adviceRec.textContent = a.headline;
    el.adviceReason.textContent = a.why;

    const whose = target.id === this.store.myId ? 'You' : target.name;
    el.adviceRow.setAttribute(
      'aria-label',
      `Bust-O-meter: ${pct} percent chance the next card busts ${whose}. Claude recommends: ${a.headline}. ${a.why}`,
    );
  }

  /** Count the percentage up or down so it travels with the needle. */
  tweenPct(to) {
    const el = this.el.advicePct;
    cancelAnimationFrame(this.pctFrame);

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = Number.parseInt(el.textContent, 10);
    if (still || !Number.isFinite(from) || from === to) {
      el.textContent = `${to}%`;
      return;
    }

    const start = performance.now();
    const span = 420;
    const step = (now) => {
      const t = Math.min(1, (now - start) / span);
      // Ease out, so it settles rather than stopping dead.
      const eased = 1 - (1 - t) ** 3;
      el.textContent = `${Math.round(from + (to - from) * eased)}%`;
      if (t < 1) this.pctFrame = requestAnimationFrame(step);
    };
    this.pctFrame = requestAnimationFrame(step);
  }

  /** A Flip 7 anywhere on the table ends the round, so everyone should know. */
  announceFlip7() {
    const state = this.store.state;
    const hit = playerList(state).find((p) => p.hand.numbers.length >= FLIP7_TARGET);
    if (!hit) {
      this.lastFlip7 = null;
      return;
    }
    const key = `${state.round}:${hit.id}`;
    if (key === this.lastFlip7) return;
    this.lastFlip7 = key;

    const mine = hit.id === this.store.myId;
    sfx.flip7();
    burstFrom(mine ? this.el.card : this.el.standings);
    showBanner('FLIP 7!', {
      tone: 'flip7',
      sub: mine ? '+15 bonus — round over' : `${hit.name} — round over`,
      ms: 1500,
    });
  }

  renderStandings() {
    const state = this.store.state;
    const host = this.el.standings;
    const rows = standings(state);
    const now = Date.now();
    const leader = rows.length ? rows[0].total ?? 0 : 0;
    const selectedId = this.target?.id ?? this.store.myId;

    host.replaceChildren();
    rows.forEach((p, i) => {
      const shape = handShape(p.hand);
      const row = document.createElement('button');
      row.className = 'stand';
      row.type = 'button';
      row.dataset.player = p.id;
      row.setAttribute('aria-pressed', String(p.id === selectedId));
      row.classList.toggle('is-selected', p.id === selectedId);
      row.classList.toggle('is-editable', this.store.canEdit(p.id));
      row.classList.toggle('is-busted', shape.busted);
      row.classList.toggle('is-flip7', shape.flip7);
      row.classList.toggle('is-leading', leader > 0 && (p.total ?? 0) === leader);
      row.classList.toggle('is-turn', state.turnId === p.id);
      row.classList.toggle(
        'is-target',
        state.pending?.byId === this.store.myId && state.pending.targets.includes(p.id),
      );

      const rank = document.createElement('span');
      rank.className = 'stand__rank';
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'stand__name';
      name.append(document.createTextNode(p.name));

      const tags = document.createElement('span');
      tags.className = 'stand__tags';
      if (p.id === this.store.myId) tags.append(chip('you', 'you'));
      if (p.id === state.hostId) tags.append(chip('host', 'host'));
      if (p.isBot) tags.append(chip('bot', 'bot'));
      // Somebody who walked in mid-round isn't out, they're next. Saying so is
      // the difference between "the app skipped them" and "they just missed one".
      if (p.waiting) tags.append(chip('next round', 'waiting'));
      if (shape.busted) tags.append(chip('bust', 'bust'));
      else if (shape.flip7) tags.append(chip('flip 7', 'flip7'));
      if (this.store.isOnline && p.id !== this.store.myId && isAway(p, now)) {
        tags.append(chip('away', 'away'));
      }
      if (tags.childElementCount) name.append(tags);

      const round = document.createElement('span');
      round.className = 'stand__round';
      const delta = roundScore(p.hand);
      if (shape.busted) round.textContent = 'bust';
      else if (delta) round.textContent = `+${delta}`;
      else {
        round.textContent = '—';
        round.classList.add('is-idle');
      }

      const total = document.createElement('span');
      total.className = 'stand__total';
      total.textContent = String(p.total ?? 0);

      const bar = document.createElement('span');
      bar.className = 'stand__bar';
      const fill = document.createElement('span');
      fill.className = 'stand__fill';
      fill.style.width = `${Math.min(100, ((p.total ?? 0) / (state.target || 200)) * 100)}%`;
      bar.append(fill);

      row.append(rank, name, round, total, bar);
      row.addEventListener('click', () => this.select(p.id));
      host.append(row);
    });
  }

  renderHand(hand, shape) {
    const host = this.el.hand;
    const items = [
      ...hand.numbers.map((v, i) => ({ card: { kind: 'number', value: v }, kind: 'number', i })),
      ...hand.mods.map((m, i) => ({
        card: { kind: 'modifier', op: m.op, value: m.value },
        kind: 'mod',
        i,
      })),
    ];
    if (hand.chance) {
      items.push({ card: { kind: 'action', action: 'chance' }, kind: 'chance', i: 0 });
    }

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'hand__empty';
      empty.textContent = shape.busted
        ? 'Busted with nothing'
        : this.target?.waiting
          ? 'Dealt in next round'
          : this.store.isDealt
            ? 'Waiting for a card'
            : 'Tap the cards below';
      host.replaceChildren(empty);
      this.dealSource = null;
      return;
    }

    const before = host.querySelectorAll('.card').length;
    host.replaceChildren();
    for (const item of items) {
      const el = createCard(item.card);
      if (hand.busted) el.classList.add('is-spent');
      if (this.store.isDealt) {
        // Dealt cards aren't yours to take back.
        host.append(el);
        continue;
      }
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.title = 'Tap to remove';
      const remove = () => this.removeCard(item.kind, item.i);
      el.addEventListener('click', remove);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          remove();
        }
      });
      host.append(el);
    }

    if (this.dealSource && items.length > before) dealFrom(host.lastElementChild, this.dealSource);
    this.dealSource = null;
  }

  renderPadState(hand) {
    for (let v = 0; v <= 12; v++) {
      const key = this.padKeys.get(`n${v}`);
      const held = hand.numbers.includes(v);
      key.classList.toggle('is-held', held);
      key.setAttribute(
        'aria-label',
        held ? `${v} — you already have this, tapping again busts you` : `Add a ${v}`,
      );
    }
    for (const m of MOD_KEYS) {
      this.padKeys
        .get(`m${m.op}${m.value}`)
        .classList.toggle('is-picked', hand.mods.some((x) => x.op === m.op && x.value === m.value));
    }
    this.padKeys.get('chance').classList.toggle('is-on', hand.chance);
    this.padKeys.get('bust').classList.toggle('is-on', hand.busted);
  }
}

function chip(text, tone) {
  const el = document.createElement('span');
  el.className = 'chip';
  el.dataset.tone = tone;
  el.textContent = text;
  return el;
}

function utilKey(label, iconHref, text) {
  const key = document.createElement('button');
  key.className = 'pad__key pad__key--util';
  key.type = 'button';
  key.setAttribute('aria-label', label);
  if (iconHref) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', iconHref);
    svg.append(use);
    key.append(svg);
  } else {
    key.textContent = text ?? label;
  }
  return key;
}
