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
import { monogram } from './avatar.js';
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
import { toast, showBanner, buzz, reducedMotion } from './views.js';
import { sfx } from './sound.js';
import { burstFrom, celebrate, fxAllowed } from './fx.js';
import { settings, speedFactor } from './storage.js';

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
    this.dealtHand = null; // { key, seen } — the dealt hand as last painted
    this.handKey = null; // skip hand rebuilds when nothing in it changed
    this.flicker = null; // { id, until } — a row flashing for somebody's bust
    this.armedTargetId = null; // first tap picks a target, the second confirms
    this.pendingKey = null; // which action card the armed target belongs to
    this.scrolledTo = null; // whose row the scoreboard is following
    this.userScrolled = false; // ...unless somebody scrolled it themselves
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
      adviceBand: id('advice-band'),
      adviceRec: id('advice-rec'),
      adviceWhy: id('advice-why'),
      adviceReason: id('advice-reason'),
    };

    this.buildPad();
    this.el.undo.addEventListener('click', () => this.undo());
    this.el.clear.addEventListener('click', () => this.clearHand());
    this.el.standings.addEventListener('pointerdown', () => {
      // Somebody looking around the table owns the scroll until the turn moves on.
      this.userScrolled = true;
    });
    this.el.standings.addEventListener('scroll', () => this.markScrollEdges(), { passive: true });

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
      this.selectedId && state.players?.[this.selectedId] ? this.selectedId : this.store.actingId;
    return state.players?.[id] ? { id, ...state.players[id] } : null;
  }

  get hand() {
    return readHand(this.target?.hand);
  }

  select(playerId) {
    // In a dealt game, tapping a player is how you aim an action card. Freezing
    // the wrong person is not undoable, so the first tap arms and the second —
    // on the same row — confirms; tapping somebody else re-arms onto them.
    const pending = this.store.state?.pending;
    if (this.store.isDealt) {
      if (pending?.byId === this.store.actingId) {
        if (!pending.targets.includes(playerId)) {
          sfx.error();
          toast('Pick one of the highlighted players');
          return;
        }
        if (this.armedTargetId === playerId) {
          this.armedTargetId = null;
          sfx.tap();
          this.store.intent({ do: 'target', targetId: playerId });
        } else {
          this.armedTargetId = playerId;
          sfx.tap();
          this.render();
        }
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
      key.dataset.value = String(v);
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

    // An armed target only makes sense for the action card it was armed under.
    const pendingKey = state.pending ? `${state.pending.byId}:${state.pending.action}` : null;
    if (pendingKey !== this.pendingKey) {
      this.pendingKey = pendingKey;
      this.armedTargetId = null;
    }

    this.renderStandings();

    const dealt = this.store.isDealt;
    // A dealt game always shows you your own hand; nobody edits anyone's.
    if (dealt) this.selectedId = null;

    const t = this.target;
    const hand = this.hand;
    const shape = handShape(hand);
    const score = scoreHand(shape);
    const mine = t?.id === this.store.actingId;

    this.el.whose.textContent = dealt
      ? 'Your hand'
      : mine
        ? 'Your hand'
        : `${t?.name ?? ''}'s hand`;
    this.el.card.classList.toggle('is-proxy', !mine);

    const labels = {
      bust: 'Busted',
      flip7: 'Flip 7!',
      save: 'Saved',
      freeze: 'Frozen',
      stayed: 'Banked',
    };
    // In a dealt game the hand carries its own verdict, so you can tell a banked
    // 20 from a live 20 without reading the scoreboard.
    const settled = dealt && !shape.busted && !shape.flip7
      ? { frozen: 'freeze', stayed: t?.waiting ? null : 'stayed' }[t?.state] ?? null
      : null;
    const flag =
      this.flag && labels[this.flag]
        ? this.flag
        : shape.busted
          ? 'bust'
          : shape.flip7
            ? 'flip7'
            : settled;
    this.el.flag.hidden = !flag;
    if (flag) {
      this.el.flag.textContent = labels[flag];
      this.el.flag.dataset.tone = flag;
    }

    this.el.card.classList.toggle('is-busted', shape.busted);
    this.el.card.classList.toggle('is-flip7', shape.flip7 && !shape.busted);
    // A ring round your own hand while the dealer is waiting on you.
    this.el.card.classList.toggle('is-turn', dealt && this.store.myTurn && !state.pending);
    this.el.card.classList.toggle('is-frozen', dealt && t?.state === 'frozen');
    // Five cards in, the hand card starts to run warm; at six it glows. The
    // escalation dies with the hand — bank, bust or freeze and it goes cold.
    const heatable =
      dealt && t?.state === 'active' && !t?.waiting && !shape.busted && !state.lobby && !state.roundOver;
    const heat = heatable ? hand.numbers.length : 0;
    if (heat >= 5) this.el.card.dataset.heat = String(Math.min(6, heat));
    else delete this.el.card.dataset.heat;
    renderPips(this.el.pips, hand.numbers.length);
    this.renderHand(hand, shape);

    this.el.score.textContent = String(score);
    this.el.score.classList.toggle('is-zero', score === 0);
    // The empty-hand prompt tells you to tap your cards, which is an instruction
    // for scorekeeping. When the app deals, there is nothing for you to tap.
    const empty = !hand.numbers.length && !hand.mods.length;
    this.el.formula.textContent =
      dealt && empty && !shape.busted
        ? t?.waiting
          ? 'Sitting this round out'
          : 'The dealer is dealing'
        : formula(shape);
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
    // There is only something to advise when a hit-or-stay decision is actually
    // in front of you: not in the lobby, not while sitting a round out, not while
    // aiming an action card, and not on a hand that has already banked or frozen.
    const state = this.store.state;
    const dealt = this.store.isDealt;
    const settled = dealt && target && target.state !== 'active';
    const aiming = state?.pending?.byId === this.store.actingId;
    if (!settings.advice || !target || state?.lobby || target.waiting || aiming || settled) {
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
    // The band in a word too, so the colour is never the only signal.
    el.adviceBand.textContent =
      { safe: 'safe', ok: 'okay', warm: 'risky', hot: 'danger' }[a.band] ?? '';

    const pct = Math.round(a.risk * 100);
    // The needle slides via CSS; the number is tweened to match it.
    el.adviceNeedle.style.setProperty('--pct', String(Math.min(100, pct)));
    this.tweenPct(pct);
    el.adviceRec.textContent = a.headline;
    el.adviceReason.textContent = a.why;

    const whose = target.id === this.store.actingId ? 'You' : target.name;
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

    const mine = hit.id === this.store.actingId;
    sfx.flip7();
    buzz([30, 60, 30, 60, 120]);

    // The jackpot gets the full treatment: the seven cards light up in order,
    // the screen flashes gold, and everyone gets the shower — a Flip 7 ends the
    // round for the whole table, so the whole table celebrates it. The summary
    // modal is held back (main.js) so none of this plays under a dialog.
    if (fxAllowed() && !reducedMotion()) {
      const strip = mine ? this.el.hand : document.getElementById('spectate-cards');
      [...(strip?.querySelectorAll(".card[data-kind='number']") ?? [])].forEach((card, i) => {
        if (card.classList.contains('is-new')) return; // still mid deal-in
        card.style.animationDelay = `${i * 80}ms`;
        card.classList.add('is-glow7');
      });
      goldFlash();
      if (mine) this.flyBonus();
    }
    burstFrom(mine ? this.el.card : this.el.standings);
    celebrate({ count: 90 });
    showBanner('FLIP 7!', {
      tone: 'flip7',
      sub: mine ? '+15 bonus — round over' : `${hit.name} — round over`,
      ms: 1500,
    });
  }

  /** "+15" leaves the hand and lands on the score readout. */
  flyBonus() {
    const from = this.el.hand.getBoundingClientRect();
    const to = this.el.score.getBoundingClientRect();
    const el = document.createElement('span');
    el.className = 'fly15';
    el.textContent = '+15';
    el.style.left = `${Math.round(from.left + from.width / 2)}px`;
    el.style.top = `${Math.round(from.top + from.height / 2)}px`;
    el.style.setProperty('--fx', `${Math.round(to.left + to.width / 2 - (from.left + from.width / 2))}px`);
    el.style.setProperty('--fy', `${Math.round(to.top + to.height / 2 - (from.top + from.height / 2))}px`);
    document.body.append(el);
    setTimeout(() => el.remove(), 1200 * speedFactor());
  }

  renderStandings() {
    const state = this.store.state;
    const host = this.el.standings;
    const rows = standings(state);
    const now = Date.now();
    const leader = rows.length ? rows[0].total ?? 0 : 0;
    const selectedId = this.target?.id ?? this.store.actingId;

    // Five or more rows switch the list to its denser single-line form.
    host.classList.toggle('is-compact', rows.length > 4);

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
      // Your own turn gets its own treatment: on a phone at a card table the
      // question is always "is it me?", not "who is it".
      row.classList.toggle('is-my-turn', state.turnId === p.id && p.id === this.store.actingId);
      row.classList.toggle(
        'is-target',
        state.pending?.byId === this.store.actingId && state.pending.targets.includes(p.id),
      );
      row.classList.toggle('is-armed', p.id === this.armedTargetId);
      row.classList.toggle('is-frozen', p.state === 'frozen');
      // Somebody else's bust: their row flickers red for a beat. Held here
      // rather than toggled by the event, so a re-render can't wipe it early.
      row.classList.toggle('is-flicker', this.flicker?.id === p.id && now < this.flicker.until);

      const rank = document.createElement('span');
      rank.className = 'stand__rank';
      rank.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'stand__name';
      name.append(monogram(p.name, p.order ?? i), document.createTextNode(p.name));

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
      else if (this.store.isDealt && !p.waiting && p.state === 'frozen') {
        tags.append(chip('frozen', 'freeze'));
      } else if (this.store.isDealt && state.turnId === p.id) {
        // A bot's pause is deliberate (ai.js thinkingTime) — label it as
        // thought, with a pulsing ellipsis, rather than a generic "playing".
        if (p.isBot) tags.append(chip('thinking', 'thinking'));
        else tags.append(chip(p.id === this.store.actingId ? 'your turn' : 'playing', 'turn'));
      }
      if (this.store.isOnline && p.id !== this.store.myId && isAway(p, now)) {
        tags.append(chip('away', 'away'));
      }
      if (tags.childElementCount) name.append(tags);

      const round = document.createElement('span');
      round.className = 'stand__round';
      const delta = roundScore(p.hand);
      // In a dealt game the column says what the number *means*: banked and safe,
      // frozen out, or still in play. Otherwise a stayed 14 and a live 14 look
      // identical, and you can't tell who is still deciding.
      const settled = { stayed: '✓', frozen: '❄', flip7: '★' }[p.state];
      if (shape.busted) round.textContent = 'bust';
      else if (this.store.isDealt && p.waiting) {
        round.textContent = 'next';
        round.classList.add('is-idle');
      } else if (this.store.isDealt && settled) {
        round.textContent = `+${delta} ${settled}`;
        round.classList.add('is-settled');
      } else if (delta) round.textContent = `+${delta}`;
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

    this.keepMyRowVisible();
  }

  /**
   * On a short phone the scoreboard is the part that scrolls, and the row you
   * care about is your own — or, on a shared phone, whoever is up. A half-cut
   * row at the fold reads as a broken layout rather than a list with more in it,
   * so scroll it into view and mark the edge as having more below.
   *
   * Only when the row it should be showing changes, so it never fights someone
   * scrolling the table deliberately.
   */
  keepMyRowVisible() {
    const box = this.el.standings;
    const wanted = this.store.actingId;

    // A new person to follow means the table moved on, so take the scroll back.
    if (wanted !== this.scrolledTo) {
      this.scrolledTo = wanted;
      this.userScrolled = false;
    }

    const row = wanted ? box.querySelector(`.stand[data-player="${wanted}"]`) : null;
    if (row && !this.userScrolled) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      // Adjust this container only — never let it scroll an ancestor. Checked
      // on every render, not just when the row changes: the list grows as
      // people join, so a row that fit a moment ago may not now.
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }

    this.markScrollEdges();
  }

  /** Fade the edge that has more beyond it, so a clipped row looks deliberate. */
  markScrollEdges() {
    const box = this.el.standings;
    const scrollable = box.scrollHeight > box.clientHeight + 1;
    box.classList.toggle('is-scrollable', scrollable);
    box.classList.toggle('has-more', scrollable && box.scrollTop + box.clientHeight < box.scrollHeight - 1);
    box.classList.toggle('has-above', scrollable && box.scrollTop > 1);
  }

  renderHand(hand, shape) {
    const host = this.el.hand;
    // A busting card is the one card a player most wants to see, so it sits at
    // the end of the hand marked as the killer, with its twin marked as the clash.
    const clash = hand.bustCard?.kind === 'number' ? hand.bustCard.value : null;
    const items = [
      ...hand.numbers.map((v, i) => ({
        card: { kind: 'number', value: v },
        kind: 'number',
        i,
        clash: v === clash,
      })),
      ...hand.mods.map((m, i) => ({
        card: { kind: 'modifier', op: m.op, value: m.value },
        kind: 'mod',
        i,
      })),
    ];
    if (hand.chance) {
      items.push({ card: { kind: 'action', action: 'chance' }, kind: 'chance', i: 0 });
    }
    if (hand.bustCard) {
      items.push({ card: hand.bustCard, kind: 'bust', i: 0, killer: true });
    }

    // Skip the rebuild when nothing in the hand changed: renders arrive on
    // every table event, and rebuilding mid deal-in cuts the flip short.
    const renderKey = [
      this.store.isDealt ? 'd' : 's',
      this.target?.id ?? '',
      this.store.state?.round ?? 0,
      this.target?.waiting ? 'w' : '',
      hand.busted ? 'b' : '',
      hand.numbers.join(','),
      hand.mods.map((m) => `${m.op}${m.value}`).join(','),
      hand.chance ? 'c' : '',
      hand.bustCard ? `k${hand.bustCard.kind}:${hand.bustCard.value ?? hand.bustCard.action ?? ''}` : '',
    ].join('|');
    if (this.handKey === renderKey) return;
    this.handKey = renderKey;

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
      // An empty dealt hand is the baseline the next deal animates from.
      if (this.store.isDealt) {
        this.dealtHand = { key: this.dealtKey(), seen: { n: 0, m: 0, c: 0 } };
      }
      return;
    }

    // In a dealt game cards arrive from the deck, not from a keypad tap, so the
    // flip-in is driven by the hand growing between renders: anything beyond
    // what was painted last time flips in from the deck, rings its value and
    // ticks the motor. Counted per category (a new number lands before held
    // modifiers, so a flat index diff would flip the wrong card), and keyed per
    // round and player so a reload mid-round, or the phone changing hands in
    // pass-and-play, doesn't replay a whole hand.
    let seen = null;
    if (this.store.isDealt) {
      const key = this.dealtKey();
      const now = { n: hand.numbers.length, m: hand.mods.length, c: hand.chance ? 1 : 0 };
      const prevRound = (this.dealtHand?.key ?? '').split(':')[0];
      const sameRound = prevRound === String(this.store.state?.round ?? 0);
      seen = !this.dealtHand
        ? now // first paint after a join or reload — nothing to replay
        : this.dealtHand.key === key
          ? this.dealtHand.seen
          : sameRound
            ? now // same round, different hand: the phone changed hands
            : { n: 0, m: 0, c: 0 }; // a fresh deal
      this.dealtHand = { key, seen: now };
    }
    const deck = document.getElementById('deck');
    let arriving = 0;

    const before = host.querySelectorAll('.card').length;
    host.replaceChildren();
    for (const item of items) {
      const el = createCard(item.card);
      if (hand.busted) el.classList.add('is-spent');
      if (item.clash) el.classList.add('is-clash');
      if (item.killer) {
        el.classList.add('is-killer');
        el.classList.remove('is-spent');
        el.title = `This busted you — you already had ${
          item.card.kind === 'number' ? `a ${item.card.value}` : 'one'
        }`;
        // A labelled wrapper, because .card clips its own overflow and its
        // ::after is the gloss.
        const wrap = document.createElement('span');
        wrap.className = 'killer';
        const label = document.createElement('span');
        label.className = 'killer__label';
        label.textContent = 'busted you';
        wrap.append(el, label);
        host.append(wrap);
        continue;
      }
      if (this.store.isDealt) {
        // Dealt cards aren't yours to take back.
        host.append(el);
        const isNew =
          seen &&
          ((item.kind === 'number' && item.i >= seen.n) ||
            (item.kind === 'mod' && item.i >= seen.m) ||
            (item.kind === 'chance' && !seen.c));
        if (isNew) this.dealtCardIn(el, item, arriving++, deck);
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

  /** Which dealt hand the growth-diff is tracking: this round, this player. */
  dealtKey() {
    return `${this.store.state?.round ?? 0}:${this.target?.id ?? ''}`;
  }

  /**
   * One card arriving from the deck: the existing deal-in flip (face down for
   * the first half, then the reveal), with the value ringing as the face turns
   * over rather than when the DOM changes. A Flip Three lands as a cascade.
   */
  dealtCardIn(el, item, order, deck) {
    const delay = order * 200 * speedFactor();
    dealFrom(el, deck, delay);
    const reveal = delay + 230 * speedFactor();
    setTimeout(() => {
      if (item.kind === 'number') {
        sfx.gain(item.card.value);
        // The tick sharpens as the hand fattens — five and six get a double.
        buzz(this.hand.numbers.length >= 5 ? [15, 40, 15] : 10);
      } else {
        sfx.modifier();
        buzz(10);
      }
    }, reveal);
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

/** A brief gold wash over the whole screen — the Flip 7 moment. */
function goldFlash() {
  const el = document.createElement('div');
  el.className = 'goldflash';
  document.body.append(el);
  setTimeout(() => el.remove(), 950 * speedFactor());
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
