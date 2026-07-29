/**
 * App shell: screen routing, the game driver, and the glue between the engine's
 * event stream and the animations on screen.
 *
 * The driver is a small loop — ask the engine what it needs, animate whatever
 * it emitted, hand control back to the player when it's their turn.
 */

import { Flip7Game, Status } from './engine.js';
import { STYLES, BOT_ROSTER, decideMove, decideTarget, thinkingTime } from './ai.js';
import { bustChance, riskBand } from './odds.js';
import { ACTIONS } from './cards.js';
import { createCard, dealFrom, renderPips } from './cardview.js';
import { FLIP7_TARGET } from './scoring.js';
import {
  settings,
  saveSettings,
  setup,
  saveSetup,
  stats,
  bumpStat,
  recordBest,
  resetStats,
  speedFactor,
} from './storage.js';
import {
  wait,
  openModal,
  closeModal,
  closeAllModals,
  anyModalOpen,
  trapFocus,
  toast,
  showBanner,
  announce,
  setStatus,
  fillScores,
} from './views.js';
import { sfx, setSoundEnabled, unlockSound } from './sound.js';
import { initFx, setFxEnabled, burstFrom, celebrate } from './fx.js';
import { TallyController } from './tally.js';

const $ = (id) => document.getElementById(id);

const state = {
  screen: 'home',
  game: null,
  spotlightId: null,
  busy: false,
  awaitingTarget: null,
  cardEls: new Map(), // player id -> Map(cardId -> element)
};

const tally = new TallyController();

// ── boot ──────────────────────────────────────────────────────────────────

function boot() {
  applyTheme();
  setSoundEnabled(settings.sound);
  setFxEnabled(settings.effects);
  initFx($('fx'));

  buildSetup();
  buildSettings();
  wireChrome();
  tally.mount();

  // A handle for debugging and for the browser-driven checks in scripts/.
  window.__flip7 = state;

  document.addEventListener(
    'pointerdown',
    () => {
      if (settings.sound) unlockSound();
    },
    { once: true },
  );

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline support is a bonus, not a requirement */
      });
    });
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', settings.theme === 'light' ? '#f2f0fb' : '#0a0918');
  document.documentElement.style.setProperty('--speed', String(speedFactor()));
}

function go(screen) {
  state.screen = screen;
  for (const el of document.querySelectorAll('.screen')) {
    el.classList.toggle('is-active', el.dataset.screen === screen);
  }
  closeAllModals();
}

// ── chrome ────────────────────────────────────────────────────────────────

function wireChrome() {
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      sfx.tap();
      if (goto.hasAttribute('data-close')) closeAllModals();
      go(goto.dataset.goto);
      return;
    }

    const opener = e.target.closest('[data-open]');
    if (opener) {
      sfx.tap();
      const which = opener.dataset.open;
      if (which === 'rules') $('rules-target').textContent = String(setup.target);
      if (which === 'stats') renderStats();
      openModal(which);
      return;
    }

    if (e.target.closest('[data-close]')) {
      sfx.tap();
      closeModal();
      return;
    }

    // tapping the backdrop closes non-blocking dialogs
    const modal = e.target.classList?.contains('modal') ? e.target : null;
    if (modal && !['modal-round', 'modal-over'].includes(modal.id)) {
      closeModal(modal);
    }
  });

  $('btn-start').addEventListener('click', startGame);
  $('btn-hit').addEventListener('click', () => playerMove('hit'));
  $('btn-stay').addEventListener('click', () => playerMove('stay'));
  $('btn-quit').addEventListener('click', () => {
    closeAllModals();
    state.game = null;
    go('home');
  });
  $('btn-reset-stats').addEventListener('click', () => {
    resetStats();
    renderStats();
    toast('Stats cleared');
  });

  $('btn-next-round').addEventListener('click', (e) => {
    closeAllModals();
    if (e.currentTarget.dataset.mode === 'tally') return;
    nextRound();
  });

  $('btn-rematch').addEventListener('click', (e) => {
    closeAllModals();
    if (e.currentTarget.dataset.mode === 'tally') {
      tally.rematch();
      return;
    }
    startGame();
  });

  document.addEventListener('keydown', (e) => {
    if (anyModalOpen()) {
      trapFocus(e);
      if (e.key === 'Escape') {
        const top = document.querySelector('.modal:not([hidden])');
        if (top && !['modal-round', 'modal-over'].includes(top.id)) closeModal(top);
      }
      return;
    }
    if (state.screen !== 'game') return;

    if (state.awaitingTarget) {
      const n = Number(e.key);
      if (n >= 1 && n <= state.awaitingTarget.targets.length) {
        chooseTarget(state.awaitingTarget.targets[n - 1]);
      }
      return;
    }
    if (e.key === 'h' || e.key === 'H' || e.key === ' ') {
      e.preventDefault();
      playerMove('hit');
    } else if (e.key === 's' || e.key === 'S') {
      playerMove('stay');
    } else if (e.key === '?' || e.key === 'r') {
      openModal('rules');
    }
  });
}

// ── setup screen ──────────────────────────────────────────────────────────

function segment(host, options, current, onPick) {
  host.replaceChildren();
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.className = 'seg__opt';
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.value === current));
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      sfx.tap();
      onPick(opt.value);
    });
    host.append(btn);
  }
}

const STYLE_OPTIONS = [
  { value: 'cautious', label: 'Careful' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'reckless', label: 'Wild' },
  { value: 'mixed', label: 'Mixed' },
];

const STYLE_HINTS = {
  cautious: STYLES.cautious.blurb,
  balanced: STYLES.balanced.blurb,
  reckless: STYLES.reckless.blurb,
  mixed: 'A table of different nerves. Recommended.',
};

function buildSetup() {
  const name = $('setup-name');
  name.value = setup.name;
  name.addEventListener('input', () => saveSetup({ name: name.value }));

  const paint = () => {
    segment(
      $('setup-opponents'),
      [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })),
      setup.opponents,
      (v) => {
        saveSetup({ opponents: v });
        paint();
      },
    );
    segment($('setup-style'), STYLE_OPTIONS, setup.style, (v) => {
      saveSetup({ style: v });
      paint();
    });
    segment(
      $('setup-target'),
      [100, 200, 300].map((n) => ({ value: n, label: String(n) })),
      setup.target,
      (v) => {
        saveSetup({ target: v });
        paint();
      },
    );
    $('setup-style-hint').textContent = STYLE_HINTS[setup.style] ?? '';
  };
  paint();
}

// ── settings & stats ──────────────────────────────────────────────────────

function buildSettings() {
  const host = $('settings-opts');
  host.replaceChildren();

  const toggle = (label, sub, key, onChange) => {
    const row = document.createElement('div');
    row.className = 'opt';
    const text = document.createElement('span');
    text.className = 'opt__label';
    text.textContent = label;
    if (sub) {
      const small = document.createElement('small');
      small.textContent = sub;
      text.append(small);
    }
    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!settings[key]));
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', () => {
      const next = !settings[key];
      saveSettings({ [key]: next });
      sw.setAttribute('aria-checked', String(next));
      onChange?.(next);
      sfx.tap();
    });
    row.append(text, sw);
    host.append(row);
  };

  toggle('Sound', 'Blips, busts and fanfares', 'sound', (on) => {
    setSoundEnabled(on);
    if (on) {
      unlockSound();
      sfx.save();
    }
  });
  toggle('Confetti', 'Celebrate a Flip 7 properly', 'effects', setFxEnabled);
  toggle('Risk meter', 'Show your bust odds on the Hit button', 'riskMeter', () => {
    if (state.game) renderAll();
  });

  const speedRow = document.createElement('div');
  speedRow.className = 'opt';
  const speedLabel = document.createElement('span');
  speedLabel.className = 'opt__label';
  speedLabel.textContent = 'Pace';
  const speedSeg = document.createElement('div');
  speedSeg.className = 'seg';
  speedRow.append(speedLabel, speedSeg);
  host.append(speedRow);

  const themeRow = document.createElement('div');
  themeRow.className = 'opt';
  const themeLabel = document.createElement('span');
  themeLabel.className = 'opt__label';
  themeLabel.textContent = 'Theme';
  const themeSeg = document.createElement('div');
  themeSeg.className = 'seg';
  themeRow.append(themeLabel, themeSeg);
  host.append(themeRow);

  const paint = () => {
    segment(
      speedSeg,
      [
        { value: 'chill', label: 'Chill' },
        { value: 'normal', label: 'Normal' },
        { value: 'fast', label: 'Fast' },
      ],
      settings.speed,
      (v) => {
        saveSettings({ speed: v });
        applyTheme();
        paint();
      },
    );
    segment(
      themeSeg,
      [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
      settings.theme,
      (v) => {
        saveSettings({ theme: v });
        applyTheme();
        paint();
      },
    );
  };
  paint();
}

function renderStats() {
  const host = $('stats-grid');
  const winRate = stats.games ? Math.round((stats.wins / stats.games) * 100) : 0;
  const items = [
    ['Games', stats.games],
    ['Wins', stats.wins],
    ['Win rate', `${winRate}%`],
    ['Flip 7s', stats.flip7s],
    ['Busts', stats.busts],
    ['Best round', stats.bestRound],
  ];
  host.replaceChildren();
  for (const [label, value] of items) {
    const cell = document.createElement('div');
    cell.className = 'stat';
    const v = document.createElement('span');
    v.className = 'stat__value';
    v.textContent = String(value);
    const l = document.createElement('span');
    l.className = 'stat__label';
    l.textContent = label;
    cell.append(v, l);
    host.append(cell);
  }
}

// ── starting a game ───────────────────────────────────────────────────────

function startGame() {
  const you = { id: 'you', name: ($('setup-name').value || 'You').trim(), avatar: '⭐' };
  const roster = BOT_ROSTER.slice(0, setup.opponents).map((bot, i) => ({
    id: `bot${i}`,
    name: bot.name,
    avatar: bot.avatar,
    isBot: true,
    style: setup.style === 'mixed' ? bot.style : setup.style,
  }));

  state.game = new Flip7Game({ players: [you, ...roster], targetScore: setup.target });
  state.spotlightId = 'you';
  state.cardEls = new Map();
  state.awaitingTarget = null;
  bumpStat('games');

  go('game');
  $('hud-target').textContent = String(setup.target);
  renderAll();
  nextRound();
}

function nextRound() {
  const game = state.game;
  if (!game) return;
  state.cardEls = new Map();
  $('opponents').replaceChildren();
  const seat = $('seat');
  seat.replaceChildren();
  delete seat.dataset.player;
  game.startRound();
  renderAll();
  drive();
}

// ── the driver ────────────────────────────────────────────────────────────

async function drive() {
  const game = state.game;
  if (!game || state.busy) return;
  state.busy = true;
  setControls(false);

  // Quitting mid-turn swaps or clears the game while this loop is awaiting an
  // animation, so every resume checks that it is still driving the same one.
  const stillMine = () => state.game === game;

  try {
    for (;;) {
      await flush();
      if (!stillMine()) return;
      const req = game.request();

      if (req.type === 'auto') {
        game.tick();
        continue;
      }

      if (req.type === 'move') {
        const player = game.byId(req.playerId);
        spotlight(player);
        renderAll();
        if (!player.isBot) {
          setStatus('Your call — hit or stay?');
          setControls(true);
          announce(`Your turn. ${game.scoreOf(player)} points in front of you.`);
          return;
        }
        setStatus(`${player.name} is thinking…`);
        await wait(thinkingTime(game, player, game.rng));
        if (!stillMine()) return;
        if (decideMove(game, player, game.rng) === 'hit') game.hit();
        else game.stay();
        continue;
      }

      if (req.type === 'target') {
        const actor = game.byId(req.playerId);
        if (!actor.isBot) {
          // Stay inside this loop while the player picks — handing control to a
          // fresh drive() would bounce off the busy flag and stall the game.
          await promptTarget(req);
          if (!stillMine()) return;
          continue;
        }
        setStatus(`${actor.name} is choosing…`);
        await wait(560);
        if (!stillMine()) return;
        game.resolveTarget(decideTarget(game, actor, req, game.rng));
        continue;
      }

      if (req.type === 'round-over') {
        await endRound();
        return;
      }

      if (req.type === 'game-over') {
        await endGame();
        return;
      }

      return;
    }
  } finally {
    state.busy = false;
  }
}

function playerMove(move) {
  const game = state.game;
  if (!game || state.busy || state.awaitingTarget) return;
  const req = game.request();
  if (req.type !== 'move' || game.byId(req.playerId).isBot) return;

  setControls(false);
  if (move === 'hit') game.hit();
  else {
    sfx.stay();
    game.stay();
  }
  drive();
}

// ── animating engine events ───────────────────────────────────────────────

async function flush() {
  const game = state.game;
  if (!game) return;
  for (const ev of game.drain()) {
    if (state.game !== game) return;
    await handle(ev, game);
  }
}

async function handle(ev, game) {
  if (state.game !== game) return;
  const player = ev.playerId ? game.byId(ev.playerId) : null;
  const isYou = player && !player.isBot;

  switch (ev.type) {
    case 'round-start':
      setStatus(`Round ${ev.round} — cards out`);
      break;

    case 'draw': {
      $('deck-pile').classList.add('is-dealing');
      setTimeout(() => $('deck-pile').classList.remove('is-dealing'), 300);
      sfx.deal();
      $('hud-deck').textContent = String(ev.deckLeft);
      renderAll();
      await wait(ev.reason === 'flip3' ? 330 : 250);
      break;
    }

    case 'gain':
      if (ev.card.kind === 'modifier') sfx.modifier();
      else if (ev.card.kind === 'number') sfx.gain(ev.card.value);
      renderAll();
      if (player.numbers.length === FLIP7_TARGET - 1 && player.status === Status.ACTIVE) {
        setStatus(`${isYou ? 'You are' : `${player.name} is`} one card from Flip 7`);
        await wait(260);
      }
      break;

    case 'second-chance':
      sfx.save();
      renderAll();
      await showBanner('Second Chance!', {
        tone: 'save',
        sub: `${player.name} dodges the ${ev.card.value}`,
        ms: 1000,
      });
      break;

    case 'bust': {
      sfx.bust();
      if (isYou) bumpStat('busts');
      markFatal(player, ev.card);
      renderAll();
      shake(seatOrPod(player));
      await showBanner('Bust', {
        tone: 'bust',
        sub: `${player.name} drew a second ${ev.card.value}`,
        ms: 1050,
      });
      break;
    }

    case 'flip7': {
      sfx.flip7();
      renderAll();
      if (isYou) bumpStat('flip7s');
      burstFrom(seatOrPod(player) ?? $('felt'));
      await showBanner('FLIP 7!', {
        tone: 'flip7',
        sub: `${player.name} · +15 bonus · round over`,
        ms: 1650,
      });
      break;
    }

    case 'freeze':
      sfx.freeze();
      renderAll();
      await showBanner('Frozen', {
        tone: 'freeze',
        sub:
          ev.playerId === ev.targetId
            ? `${player.name} freezes themselves on ${ev.score}`
            : `${player.name} → ${game.byId(ev.targetId).name} banks ${ev.score}`,
        ms: 1150,
      });
      break;

    case 'flip3-start':
      sfx.flip3();
      renderAll();
      await showBanner('Flip Three', {
        tone: 'flip3',
        sub:
          ev.playerId === ev.targetId
            ? `${player.name} takes three`
            : `${player.name} → ${game.byId(ev.targetId).name}`,
        ms: 1050,
      });
      break;

    case 'defer':
      setStatus(`${ACTIONS[ev.card.action].label} held until the flips are done`);
      await wait(340);
      break;

    case 'gift':
      sfx.save();
      renderAll();
      toast(`${player.name} hands a Second Chance to ${game.byId(ev.targetId).name}`);
      await wait(500);
      break;

    case 'discard-action':
      toast(`${ACTIONS[ev.card.action].label} discarded — nobody to use it on`);
      await wait(420);
      break;

    case 'stay':
      if (player.isBot) sfx.stay();
      renderAll();
      setStatus(`${player.name} stays on ${ev.score}`);
      await wait(430);
      break;

    case 'turn':
      renderAll();
      break;

    case 'reshuffle':
      toast('Deck reshuffled');
      await wait(300);
      break;

    default:
      break;
  }
}

function markFatal(player, card) {
  const map = state.cardEls.get(player.id);
  const el = map?.get(card.id);
  if (el) el.classList.add('is-fatal');
}

function shake(el) {
  if (!el) return;
  el.classList.add('is-shaking');
  setTimeout(() => el.classList.remove('is-shaking'), 520);
}

// ── targeting ─────────────────────────────────────────────────────────────

function promptTarget(req) {
  return new Promise((resolve) => {
    const game = state.game;
    const verb = { freeze: 'Freeze', flip3: 'Flip Three on', gift: 'Give your spare shield to' }[
      req.action
    ];
    state.awaitingTarget = { ...req, resolve };
    setControls(false);
    renderAll();

    const hint = $('targeting');
    hint.hidden = false;
    hint.textContent =
      req.targets.length === 1
        ? `${verb} ${game.byId(req.targets[0]).name} — the only option. Tap to confirm.`
        : `You drew ${ACTIONS[req.action === 'gift' ? 'chance' : req.action].label}. Tap a player to ${verb.toLowerCase()}.`;

    if (req.action !== 'gift') sfx.count();
    announce(hint.textContent);
  });
}

function chooseTarget(targetId) {
  const pending = state.awaitingTarget;
  if (!pending || !pending.targets.includes(targetId)) return;
  state.awaitingTarget = null;
  $('targeting').hidden = true;
  sfx.tap();
  state.game.resolveTarget(targetId);
  pending.resolve(); // the waiting drive() loop picks it up from here
}

// ── round & game end ──────────────────────────────────────────────────────

async function endRound() {
  const game = state.game;
  const you = game.byId('you');
  bumpStat('rounds');
  recordBest('bestRound', you.roundScore);
  renderAll();
  await wait(420);

  $('round-title').textContent = `Round ${game.round}`;
  fillScores(
    $('round-scores'),
    game.players.map((p) => ({
      name: p.name,
      avatar: p.avatar,
      delta: p.roundScore,
      total: p.total,
      busted: p.status === Status.BUSTED,
      note: noteFor(game, p),
    })),
    game.targetScore,
  );
  const next = $('btn-next-round');
  next.textContent = 'Next round';
  delete next.dataset.mode;
  openModal('round');
  sfx.count();
}

async function endGame() {
  const game = state.game;
  const winner = game.winner;
  const you = game.byId('you');
  const youWon = winner.id === 'you';

  bumpStat('rounds');
  recordBest('bestRound', you.roundScore);
  recordBest('bestGame', you.total);
  if (youWon) bumpStat('wins');
  renderAll();
  await wait(500);

  $('over-title').textContent = youWon ? 'You win!' : `${winner.name} wins`;
  $('over-sub').textContent = youWon
    ? `${you.total} points in ${game.round} rounds. Nerves of steel.`
    : `${winner.name} got to ${winner.total}. You finished on ${you.total}.`;
  fillScores(
    $('over-scores'),
    game.players.map((p) => ({
      name: p.name,
      avatar: p.avatar,
      delta: p.roundScore,
      total: p.total,
      winner: p.id === winner.id,
      note: p.id === winner.id ? 'winner' : '',
    })),
    game.targetScore,
  );

  const btn = $('btn-rematch');
  btn.textContent = 'Rematch';
  delete btn.dataset.mode;
  openModal('over');

  if (youWon) {
    sfx.win();
    celebrate();
  } else {
    sfx.lose();
  }
}

function noteFor(game, player) {
  if (player.status === Status.BUSTED) return 'busted';
  if (player.status === Status.FLIP7) return 'Flip 7 · +15';
  if (player.status === Status.FROZEN) return 'frozen';
  const b = game.breakdown(player);
  const bits = [];
  if (b.doubled) bits.push('×2');
  if (b.bonus) bits.push(`+${b.bonus}`);
  return bits.join(' ');
}

// ── rendering the table ───────────────────────────────────────────────────

function spotlight(player) {
  // With one human the view never moves. Pass-and-play follows whoever is up.
  const humans = state.game.players.filter((p) => !p.isBot);
  if (humans.length <= 1) {
    state.spotlightId = humans[0]?.id ?? player.id;
  } else if (!player.isBot) {
    state.spotlightId = player.id;
  }
}

function renderAll() {
  const game = state.game;
  if (!game) return;

  $('hud-round').textContent = String(game.round);
  $('hud-deck').textContent = String(game.deck.length);
  $('targeting').hidden = !state.awaitingTarget;

  const spot = game.byId(state.spotlightId) ?? game.players[0];
  const pods = $('opponents');

  // Opponent pods, in seat order, skipping whoever is in the spotlight.
  const wanted = game.players.filter((p) => p.id !== spot.id);
  if (pods.childElementCount !== wanted.length) {
    pods.replaceChildren(...wanted.map((p) => buildPod(p)));
  }
  wanted.forEach((p, i) => renderPod(p, pods.children[i]));

  renderSeat(spot);
  renderControls(spot);
}

function buildPod(player) {
  const el = document.createElement('div');
  el.className = 'pod';
  el.dataset.player = player.id;
  el.innerHTML = `
    <div class="pod__top">
      <span class="pod__avatar"></span>
      <span class="pod__name"></span>
      <span class="pod__now"></span>
    </div>
    <div class="pod__meta">
      <span class="pod__total"></span>
      <span class="pod__state" hidden></span>
    </div>
    <div class="pod__hand"></div>`;
  el.addEventListener('click', () => {
    if (state.awaitingTarget?.targets.includes(player.id)) chooseTarget(player.id);
  });
  return el;
}

function renderPod(player, el) {
  const game = state.game;
  el.querySelector('.pod__avatar').textContent = player.avatar;
  el.querySelector('.pod__name').textContent = player.name;
  el.querySelector('.pod__now').textContent = String(game.scoreOf(player));
  el.querySelector('.pod__total').textContent = `${player.total} total`;

  const stateEl = el.querySelector('.pod__state');
  const label = stateLabel(player);
  stateEl.hidden = !label;
  if (label) {
    stateEl.textContent = label;
    stateEl.dataset.state = player.status;
  }

  const isTurn =
    player.status === Status.ACTIVE &&
    game.request().type === 'move' &&
    game.current?.id === player.id;
  el.classList.toggle('is-turn', isTurn);
  el.classList.toggle('is-out', player.status !== Status.ACTIVE);
  el.classList.toggle('is-busted', player.status === Status.BUSTED);
  const targetable = !!state.awaitingTarget?.targets.includes(player.id);
  el.classList.toggle('is-target', targetable);
  el.setAttribute('role', targetable ? 'button' : 'group');
  el.setAttribute(
    'aria-label',
    `${player.name}, ${game.scoreOf(player)} this round, ${player.total} total${label ? `, ${label}` : ''}`,
  );

  renderHand(player, el.querySelector('.pod__hand'));
}

function renderSeat(player) {
  const game = state.game;
  const seat = $('seat');
  // Rebuild when the spotlight moves, or when the round reset emptied the node.
  if (seat.dataset.player !== player.id || !seat.querySelector('.hand')) {
    seat.dataset.player = player.id;
    seat.innerHTML = `
      <div class="seat__top">
        <span class="seat__avatar"></span>
        <span class="seat__name"></span>
        <span class="pips"></span>
        <span class="seat__now"><span></span><small>this round</small></span>
      </div>
      <div class="hand"></div>`;
    seat.addEventListener('click', () => {
      const id = seat.dataset.player;
      if (state.awaitingTarget?.targets.includes(id)) chooseTarget(id);
    });
  }

  seat.querySelector('.seat__avatar').textContent = player.avatar;
  seat.querySelector('.seat__name').textContent = player.isBot ? player.name : 'You';
  seat.querySelector('.seat__now span').textContent = String(game.scoreOf(player));
  renderPips(seat.querySelector('.pips'), player.numbers.length);

  const isTurn = game.request().type === 'move' && game.current?.id === player.id;
  seat.classList.toggle('is-turn', isTurn);
  seat.classList.toggle('is-busted', player.status === Status.BUSTED);
  const targetable = !!state.awaitingTarget?.targets.includes(player.id);
  seat.classList.toggle('is-target', targetable);

  renderHand(player, seat.querySelector('.hand'), { big: true });
}

/** Reconcile a hand so only genuinely new cards animate in. */
function renderHand(player, host, { big = false } = {}) {
  let map = state.cardEls.get(player.id);
  if (!map) {
    map = new Map();
    state.cardEls.set(player.id, map);
  }

  const cards = [
    ...player.numbers,
    ...player.modifiers,
    ...(player.secondChance ? [player.secondChance] : []),
    ...(player.bustCard ? [player.bustCard] : []),
  ];

  if (!cards.length) {
    if (big) {
      const empty = document.createElement('p');
      empty.className = 'hand__empty';
      empty.textContent = 'No cards yet';
      host.replaceChildren(empty);
    } else {
      host.replaceChildren();
    }
    map.clear();
    return;
  }

  host.querySelector('.hand__empty')?.remove();

  const seen = new Set();
  for (const card of cards) {
    seen.add(card.id);
    let el = map.get(card.id);
    if (!el) {
      el = createCard(card);
      map.set(card.id, el);
      host.append(el);
      if (host.isConnected) dealFrom(el, $('deck-pile'));
    } else if (el.parentElement !== host) {
      host.append(el);
    }
    if (player.bustCard && card.id === player.bustCard.id) el.classList.add('is-fatal');
    el.classList.toggle('is-spent', player.status === Status.BUSTED);
  }

  for (const [id, el] of map) {
    if (!seen.has(id)) {
      el.remove();
      map.delete(id);
    }
  }

  // Keep the DOM in hand order without re-creating anything.
  cards.forEach((card, i) => {
    const el = map.get(card.id);
    if (host.children[i] !== el) host.insertBefore(el, host.children[i] ?? null);
  });
}

function stateLabel(player) {
  switch (player.status) {
    case Status.BUSTED:
      return 'bust';
    case Status.STAYED:
      return 'stay';
    case Status.FROZEN:
      return 'frozen';
    case Status.FLIP7:
      return 'flip 7';
    default:
      return '';
  }
}

function renderControls(spot) {
  const game = state.game;
  const req = game.request();
  const yourTurn = req.type === 'move' && !game.byId(req.playerId).isBot;
  const player = yourTurn ? game.byId(req.playerId) : spot;

  const standing = game.scoreOf(player);
  $('stay-sub').textContent = `bank ${standing}`;

  const risk = bustChance(game, player);
  const hit = $('btn-hit');
  const show = settings.riskMeter && player.status === Status.ACTIVE;
  hit.dataset.band = riskBand(risk);
  hit.querySelector('.risk__fill').style.width = show ? `${Math.round(risk * 100)}%` : '0%';
  $('risk').hidden = !show;

  if (!show) {
    $('hit-sub').textContent = player.secondChance ? 'shield up' : 'one more card';
  } else if (player.secondChance) {
    $('hit-sub').textContent = 'shielded — no risk';
  } else {
    $('hit-sub').textContent = `${Math.round(risk * 100)}% bust risk`;
  }
}

function setControls(on) {
  $('btn-hit').disabled = !on;
  $('btn-stay').disabled = !on;
}

function seatOrPod(player) {
  if (player.id === state.spotlightId) return $('seat');
  return $('opponents').querySelector(`[data-player="${player.id}"]`);
}

boot();
