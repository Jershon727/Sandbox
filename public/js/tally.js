/**
 * Score helper.
 *
 * For games played with the real deck. Instead of doing arithmetic in your head
 * at the end of every round, you tap the cards as they land and the app keeps
 * the hand, the round score and the running totals.
 *
 * Two things make it faster than a notepad:
 *   - numbers you already hold are marked on the keypad, so you can see your
 *     bust cards without scanning your hand
 *   - tapping one of those marked numbers is the bust, which is exactly what
 *     happens at the table
 */

import { scoreHand, isFlip7, formula, FLIP7_TARGET } from './scoring.js';
import { createCard, dealFrom, renderPips } from './cardview.js';
import { loadTally, saveTally, clearTally } from './storage.js';
import { toast, showBanner, fillScores } from './views.js';
import { sfx } from './sound.js';
import { burstFrom, celebrate } from './fx.js';

const MOD_KEYS = [
  { op: 'add', value: 2 },
  { op: 'add', value: 4 },
  { op: 'add', value: 6 },
  { op: 'add', value: 8 },
  { op: 'add', value: 10 },
  { op: 'mul', value: 2 },
];

const emptyHand = () => ({ numbers: [], mods: [], chance: false, busted: false });

export class TallyController {
  constructor() {
    this.session = null;
    this.undoStack = [];
    this.flag = null; // transient badge: bust | flip7 | save
    this.el = {};
  }

  mount() {
    const id = (x) => document.getElementById(x);
    this.el = {
      setup: id('tally-setup'),
      main: id('tally-main'),
      roundLabel: id('tally-round-label'),
      namelist: id('tally-namelist'),
      addName: id('tally-add'),
      targetSeg: id('tally-target'),
      start: id('tally-start'),
      rail: id('tally-rail'),
      pips: id('tally-pips'),
      flagEl: id('tally-flag'),
      hand: id('tally-hand'),
      score: id('tally-score'),
      formula: id('tally-formula'),
      pad: id('tally-pad'),
      undo: id('tally-undo'),
      clear: id('tally-clear'),
      end: id('tally-end'),
      card: document.querySelector('.tally__card'),
      editBtn: id('tally-edit'),
      playersModal: id('modal-players'),
      playersList: id('players-namelist'),
      playersAdd: id('players-add'),
      playersSave: id('players-save'),
      playersReset: id('players-reset'),
    };

    this.session = loadTally();
    this.draftNames = ['Player 1', 'Player 2', 'Player 3'];
    this.draftTarget = 200;

    this.buildPad();
    this.bind();
    this.renderSetup();
    this.render();
  }

  // ── setup ───────────────────────────────────────────────────────────────

  renderSetup() {
    const { namelist, targetSeg } = this.el;

    namelist.replaceChildren();
    this.draftNames.forEach((name, i) => {
      namelist.append(
        nameRow(name, i, {
          canDelete: this.draftNames.length > 2,
          onInput: (v) => {
            this.draftNames[i] = v;
          },
          onDelete: () => {
            this.draftNames.splice(i, 1);
            this.renderSetup();
          },
        }),
      );
    });

    targetSeg.replaceChildren();
    for (const value of [100, 200, 300]) {
      const opt = document.createElement('button');
      opt.className = 'seg__opt';
      opt.type = 'button';
      opt.setAttribute('role', 'radio');
      opt.setAttribute('aria-checked', String(this.draftTarget === value));
      opt.textContent = String(value);
      opt.addEventListener('click', () => {
        this.draftTarget = value;
        sfx.tap();
        this.renderSetup();
      });
      targetSeg.append(opt);
    }
  }

  startSession() {
    const names = this.draftNames.map((n, i) => n.trim() || `Player ${i + 1}`);
    this.session = {
      target: this.draftTarget,
      round: 1,
      active: 0,
      players: names.map((name, i) => ({ id: `t${i}`, name, total: 0, history: [] })),
      hands: {},
    };
    for (const p of this.session.players) this.session.hands[p.id] = emptyHand();
    this.undoStack = [];
    this.persist();
    this.render();
    toast('Tap the cards as they land');
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  bind() {
    this.el.addName.addEventListener('click', () => {
      if (this.draftNames.length >= 8) return toast('Eight players is plenty');
      this.draftNames.push(`Player ${this.draftNames.length + 1}`);
      sfx.tap();
      this.renderSetup();
    });

    this.el.start.addEventListener('click', () => {
      sfx.stay();
      this.startSession();
    });

    this.el.undo.addEventListener('click', () => this.undo());
    this.el.clear.addEventListener('click', () => this.clearHand());
    this.el.end.addEventListener('click', () => this.endRound());
    this.el.editBtn.addEventListener('click', () => this.openPlayers());

    this.el.playersAdd.addEventListener('click', () => {
      if (this.editNames.length >= 8) return toast('Eight players is plenty');
      this.editNames.push(`Player ${this.editNames.length + 1}`);
      this.renderPlayersModal();
    });

    this.el.playersSave.addEventListener('click', () => this.savePlayers());
    this.el.playersReset.addEventListener('click', () => this.newGame());
  }

  persist() {
    if (this.session) saveTally(this.session);
  }

  get player() {
    return this.session?.players[this.session.active] ?? null;
  }

  get hand() {
    const p = this.player;
    return p ? this.session.hands[p.id] : null;
  }

  /** Snapshot before every mutation so Undo can reach back through anything. */
  snapshot() {
    if (!this.session) return;
    this.undoStack.push(JSON.stringify(this.session));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) {
      sfx.error();
      return toast('Nothing to undo');
    }
    this.session = JSON.parse(prev);
    this.flag = null;
    sfx.tap();
    this.persist();
    this.render();
  }

  handShape(hand) {
    return {
      numbers: hand.numbers,
      addMods: hand.mods.filter((m) => m.op === 'add').map((m) => m.value),
      doubled: hand.mods.some((m) => m.op === 'mul'),
      flip7: isFlip7(hand.numbers),
      busted: hand.busted,
    };
  }

  scoreOf(hand) {
    return scoreHand(this.handShape(hand));
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

    // Second Chance sits at the end of the number rows — it's a number-card saver.
    const chance = utilKey('Second Chance', '#i-chance');
    chance.classList.add('pad__key--chance');
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
    if (!hand) return;

    if (hand.busted) {
      sfx.error();
      return toast('This hand already busted — undo if that was a mistake');
    }

    if (hand.numbers.length >= FLIP7_TARGET) {
      sfx.error();
      return toast("That's already a Flip 7 — end the round");
    }

    const duplicate = hand.numbers.includes(v);
    this.snapshot();

    if (duplicate && hand.chance) {
      hand.chance = false;
      this.flag = 'save';
      sfx.save();
      this.persist();
      this.render();
      showBanner('Second Chance!', { tone: 'save', sub: `the ${v} is discarded`, ms: 900 });
      return;
    }

    if (duplicate) {
      hand.busted = true;
      this.flag = 'bust';
      sfx.bust();
      this.persist();
      this.render();
      this.el.card.classList.add('is-shaking');
      setTimeout(() => this.el.card.classList.remove('is-shaking'), 500);
      showBanner('Busted', { tone: 'bust', sub: `a second ${v}`, ms: 1000 });
      return;
    }

    hand.numbers.push(v);
    this.flag = null;
    sfx.gain(v);
    this.persist();
    this.render(keyEl);

    if (isFlip7(hand.numbers)) {
      this.flag = 'flip7';
      this.render();
      sfx.flip7();
      burstFrom(this.el.card);
      showBanner('FLIP 7!', { tone: 'flip7', sub: '+15 bonus — round over', ms: 1500 });
    }
  }

  toggleMod(m, keyEl) {
    const hand = this.hand;
    if (!hand) return;
    this.snapshot();
    const i = hand.mods.findIndex((x) => x.op === m.op && x.value === m.value);
    if (i > -1) {
      hand.mods.splice(i, 1);
      sfx.tap();
      this.persist();
      this.render();
      return;
    }
    hand.mods.push({ ...m });
    sfx.modifier();
    this.persist();
    this.render(keyEl);
  }

  toggleChance(keyEl) {
    const hand = this.hand;
    if (!hand) return;
    this.snapshot();
    hand.chance = !hand.chance;
    if (hand.chance) sfx.modifier();
    else sfx.tap();
    this.persist();
    this.render(hand.chance ? keyEl : null);
  }

  toggleBust() {
    const hand = this.hand;
    if (!hand) return;
    this.snapshot();
    hand.busted = !hand.busted;
    this.flag = hand.busted ? 'bust' : null;
    if (hand.busted) sfx.bust();
    else sfx.tap();
    this.persist();
    this.render();
  }

  removeCard(kind, index) {
    const hand = this.hand;
    if (!hand) return;
    this.snapshot();
    if (kind === 'number') hand.numbers.splice(index, 1);
    else if (kind === 'mod') hand.mods.splice(index, 1);
    else if (kind === 'chance') hand.chance = false;
    this.flag = null;
    sfx.tap();
    this.persist();
    this.render();
  }

  clearHand() {
    const hand = this.hand;
    if (!hand) return;
    if (!hand.numbers.length && !hand.mods.length && !hand.chance && !hand.busted) return;
    this.snapshot();
    this.session.hands[this.player.id] = emptyHand();
    this.flag = null;
    sfx.tap();
    this.persist();
    this.render();
  }

  select(index) {
    if (!this.session || index === this.session.active) return;
    this.session.active = index;
    this.flag = null;
    sfx.tap();
    this.persist();
    this.render();
  }

  // ── rounds ──────────────────────────────────────────────────────────────

  endRound() {
    const s = this.session;
    if (!s) return;

    const dealt = s.players.some((p) => {
      const h = s.hands[p.id];
      return h.numbers.length || h.mods.length || h.busted;
    });
    if (!dealt) {
      sfx.error();
      return toast('No cards tapped yet');
    }

    this.snapshot();

    const rows = s.players.map((p) => {
      const hand = s.hands[p.id];
      const shape = this.handShape(hand);
      const delta = scoreHand(shape);
      p.total += delta;
      p.history.push(delta);
      return {
        name: p.name,
        delta,
        total: p.total,
        busted: shape.busted,
        note: noteFor(shape),
      };
    });

    const finished = s.players.filter((p) => p.total >= s.target);
    const best = Math.max(...s.players.map((p) => p.total));
    const winners = finished.filter((p) => p.total === best);

    for (const p of s.players) s.hands[p.id] = emptyHand();
    s.round += 1;
    s.active = 0;
    this.flag = null;
    this.persist();
    this.render();

    if (winners.length === 1) {
      this.showWinner(winners[0], rows);
    } else {
      if (winners.length > 1) toast('Tied at the top — one more round');
      this.showRoundSummary(rows);
    }
  }

  showRoundSummary(rows) {
    const s = this.session;
    document.getElementById('round-title').textContent = `Round ${s.round - 1}`;
    fillScores(document.getElementById('round-scores'), rows, s.target);
    const next = document.getElementById('btn-next-round');
    next.textContent = `Start round ${s.round}`;
    next.dataset.mode = 'tally';
    document.getElementById('modal-round').hidden = false;
    sfx.count();
  }

  showWinner(winner, rows) {
    const s = this.session;
    document.getElementById('over-title').textContent = `${winner.name} wins!`;
    document.getElementById('over-sub').textContent =
      `${winner.total} points in ${s.round - 1} round${s.round - 1 === 1 ? '' : 's'}.`;
    fillScores(
      document.getElementById('over-scores'),
      rows.map((r) => ({ ...r, winner: r.name === winner.name })),
      s.target,
    );
    const btn = document.getElementById('btn-rematch');
    btn.textContent = 'New game';
    btn.dataset.mode = 'tally';
    document.getElementById('modal-over').hidden = false;
    sfx.win();
    celebrate();
  }

  /** Keep the players, wipe the scores. */
  rematch() {
    const s = this.session;
    if (!s) return;
    this.snapshot();
    s.round = 1;
    s.active = 0;
    for (const p of s.players) {
      p.total = 0;
      p.history = [];
      s.hands[p.id] = emptyHand();
    }
    this.persist();
    this.render();
    toast('Scores cleared — good luck');
  }

  newGame() {
    this.draftNames = this.session ? this.session.players.map((p) => p.name) : this.draftNames;
    this.draftTarget = this.session?.target ?? 200;
    this.session = null;
    this.undoStack = [];
    clearTally();
    document.getElementById('modal-players').hidden = true;
    this.renderSetup();
    this.render();
  }

  // ── player editing ──────────────────────────────────────────────────────

  openPlayers() {
    if (!this.session) return;
    this.editNames = this.session.players.map((p) => p.name);
    this.renderPlayersModal();
    document.getElementById('modal-players').hidden = false;
  }

  renderPlayersModal() {
    const host = this.el.playersList;
    host.replaceChildren();
    this.editNames.forEach((name, i) => {
      host.append(
        nameRow(name, i, {
          canDelete: this.editNames.length > 2,
          onInput: (v) => {
            this.editNames[i] = v;
          },
          onDelete: () => {
            this.editNames.splice(i, 1);
            this.renderPlayersModal();
          },
        }),
      );
    });
  }

  savePlayers() {
    const s = this.session;
    if (!s) return;
    this.snapshot();

    const next = this.editNames.map((name, i) => {
      const existing = s.players[i];
      const trimmed = name.trim() || `Player ${i + 1}`;
      return existing
        ? { ...existing, name: trimmed }
        : { id: `t${Date.now()}${i}`, name: trimmed, total: 0, history: [] };
    });

    const hands = {};
    for (const p of next) hands[p.id] = s.hands[p.id] ?? emptyHand();
    s.players = next;
    s.hands = hands;
    s.active = Math.min(s.active, next.length - 1);
    this.persist();
    this.render();
    document.getElementById('modal-players').hidden = true;
    sfx.tap();
  }

  // ── render ──────────────────────────────────────────────────────────────

  render(dealSource = null) {
    const s = this.session;
    const hasSession = !!s;
    this.el.setup.hidden = hasSession;
    this.el.main.hidden = !hasSession;
    this.el.editBtn.hidden = !hasSession;

    if (!hasSession) {
      this.el.roundLabel.textContent = 'Score helper';
      return;
    }

    this.el.roundLabel.textContent = `Round ${s.round} · to ${s.target}`;
    this.renderRail();

    const hand = this.hand;
    const shape = this.handShape(hand);
    const score = scoreHand(shape);

    // flag badge
    const flagEl = this.el.flagEl;
    const flagText = { bust: 'Busted', flip7: 'Flip 7!', save: 'Saved' };
    if (this.flag && flagText[this.flag]) {
      flagEl.hidden = false;
      flagEl.textContent = flagText[this.flag];
      flagEl.dataset.tone = this.flag;
    } else if (shape.busted) {
      flagEl.hidden = false;
      flagEl.textContent = 'Busted';
      flagEl.dataset.tone = 'bust';
    } else if (shape.flip7) {
      flagEl.hidden = false;
      flagEl.textContent = 'Flip 7!';
      flagEl.dataset.tone = 'flip7';
    } else {
      flagEl.hidden = true;
    }

    this.el.card.classList.toggle('is-busted', shape.busted);
    this.el.card.classList.toggle('is-flip7', shape.flip7 && !shape.busted);
    renderPips(this.el.pips, hand.numbers.length);

    this.renderHand(hand, dealSource);

    this.el.score.textContent = String(score);
    this.el.score.classList.toggle('is-zero', score === 0);
    this.el.formula.textContent = formula(shape);
    this.renderPadState(hand);
  }

  renderRail() {
    const s = this.session;
    const rail = this.el.rail;
    rail.replaceChildren();

    s.players.forEach((p, i) => {
      const hand = s.hands[p.id];
      const shape = this.handShape(hand);
      const round = scoreHand(shape);

      const tab = document.createElement('button');
      tab.className = 'rail__tab';
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(i === s.active));
      if (shape.busted) tab.classList.add('is-busted');

      const name = document.createElement('span');
      name.className = 'rail__name';
      name.textContent = p.name;

      const total = document.createElement('span');
      total.className = 'rail__total';
      total.textContent = String(p.total);

      const delta = document.createElement('span');
      delta.className = 'rail__round';
      if (shape.busted) {
        delta.textContent = 'bust';
      } else if (round > 0 || hand.numbers.length) {
        delta.textContent = `+${round} this round`;
      } else {
        delta.textContent = 'no cards yet';
        delta.classList.add('is-zero');
      }

      tab.append(name, total, delta);
      tab.addEventListener('click', () => this.select(i));
      rail.append(tab);
    });
  }

  renderHand(hand, dealSource) {
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
      empty.textContent = hand.busted ? 'Busted with nothing' : 'Tap the cards below';
      host.replaceChildren(empty);
      return;
    }

    const previous = host.childElementCount;
    host.replaceChildren();
    for (const item of items) {
      const el = createCard(item.card);
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.title = 'Tap to remove';
      if (hand.busted) el.classList.add('is-spent');
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

    // Only animate when something was actually added by this interaction.
    if (dealSource && host.childElementCount > previous) {
      dealFrom(host.lastElementChild, dealSource);
    }
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
      const key = this.padKeys.get(`m${m.op}${m.value}`);
      key.classList.toggle('is-picked', hand.mods.some((x) => x.op === m.op && x.value === m.value));
    }
    this.padKeys.get('chance').classList.toggle('is-on', hand.chance);
    this.padKeys.get('bust').classList.toggle('is-on', hand.busted);
  }
}

// ── small builders ────────────────────────────────────────────────────────

function nameRow(name, index, { canDelete, onInput, onDelete }) {
  const row = document.createElement('div');
  row.className = 'namerow';

  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'text';
  input.maxLength = 14;
  input.value = name;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `Player ${index + 1} name`);
  input.addEventListener('input', () => onInput(input.value));

  const del = document.createElement('button');
  del.className = 'namerow__del';
  del.type = 'button';
  del.textContent = '×';
  del.setAttribute('aria-label', `Remove ${name || `player ${index + 1}`}`);
  del.disabled = !canDelete;
  if (!canDelete) del.style.opacity = '0.35';
  del.addEventListener('click', onDelete);

  row.append(input, del);
  return row;
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

function noteFor(shape) {
  if (shape.busted) return 'busted';
  if (shape.flip7) return 'Flip 7 · +15';
  const bits = [];
  if (shape.doubled) bits.push('×2');
  if (shape.addMods.length) bits.push(shape.addMods.map((v) => `+${v}`).join(' '));
  return bits.join(' ');
}
