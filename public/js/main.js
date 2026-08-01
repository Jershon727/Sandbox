/**
 * App shell: screens, hosting and joining, and the round lifecycle.
 *
 * All shared state lives in the Store; this file turns state changes into what
 * you see — the standings, the round summary every phone shows at once, and the
 * winner.
 */

import { Store } from './store.js';
import { Scorer } from './scorer.js';
import {
  endRoundUpdates,
  rematchUpdates,
  normalizeCode,
  isCompleteCode,
  roundStarted,
  playerList,
  standings,
} from './room.js';
import {
  settings,
  saveSettings,
  setup,
  saveSetup,
  speedFactor,
  resolvedTheme,
} from './storage.js';
import {
  showBanner,
  openModal,
  closeModal,
  closeAllModals,
  anyModalOpen,
  trapFocus,
  toast,
  announce,
  fillScores,
} from './views.js';
import { sfx, setSoundEnabled, unlockSound } from './sound.js';
import { initFx, setFxEnabled, celebrate } from './fx.js';
import { createCard } from './cardview.js';
import { seatColor } from './avatar.js';
import { ACTIONS, cardName } from './cards.js';

const $ = (id) => document.getElementById(id);

const store = new Store();
const scorer = new Scorer(store);

const view = {
  screen: 'home',
  lastAnnounced: undefined, // feed line already shown as a banner
  onlineKind: null, // 'relay' | 'firebase' | null
  shownRound: null, // last round summary displayed
  shownWinner: null,
  wasMyTurn: false, // to catch the moment the turn becomes yours
  wasMineToAim: false,
  lastActor: undefined, // on a shared phone, who was last handed it
};

// ── boot ──────────────────────────────────────────────────────────────────

async function boot() {
  applyTheme();
  setSoundEnabled(settings.sound);
  setFxEnabled(settings.effects);
  initFx($('fx'));

  buildHostSetup();
  buildSettings();
  wireChrome();
  scorer.mount();

  store.subscribe(onState);
  store.onError(onSyncError);

  window.__flip7 = { store, scorer, view };

  registerServiceWorker();

  view.onlineKind = await Store.onlineKind();
  paintHostSetup();

  document.addEventListener(
    'pointerdown',
    () => {
      if (settings.sound) unlockSound();
    },
    { once: true },
  );

  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  await route();
}

/**
 * Turn on offline support.
 *
 * Deferred to the load event so it doesn't compete with the shell for a phone's
 * first few hundred milliseconds — but only if that event is still coming. This
 * used to sit at the end of boot(), after awaiting a network probe and a room
 * rejoin, by which point `load` had usually already fired; the listener was
 * attached to an event in the past and the worker silently never registered, so
 * the app had no offline support at all.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // The single-file build has no sw.js to register — it is already the whole app
  // in one file, which is as offline as it gets.
  if (Store.singleFile) return;
  const register = () =>
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * Where does opening the app land you?
 *
 * A phone that locks mid-game and comes back should be back in the game, so an
 * existing membership wins. A shared link for a different room beats it.
 */
async function route() {
  const linkCode = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
  const saved = store.savedMembership;

  if (saved?.code && (!linkCode || linkCode === saved.code)) {
    const rejoined = await store.resume().catch(() => false);
    if (rejoined) {
      view.shownRound = store.state?.lastRound?.round ?? null;
      view.shownWinner = store.state?.winnerId ?? null;
      go('room');
      return;
    }
  }

  if (linkCode) {
    $('join-code').value = linkCode;
    $('join-name').value = setup.name;
    go('join');
    $('join-name').focus();
    return;
  }

  $('home-resume').hidden = !store.savedMembership;
  go('home');
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f2f0fb' : '#0a0918');
  document.documentElement.style.setProperty('--speed', String(speedFactor()));
}

function go(screen) {
  view.screen = screen;
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
      go(goto.dataset.goto);
      return;
    }

    const opener = e.target.closest('[data-open]');
    if (opener) {
      sfx.tap();
      const which = opener.dataset.open;
      if (which === 'rules') $('rules-target').textContent = String(store.state?.target ?? setup.target);
      if (which === 'menu') paintMenu();
      openModal(which);
      return;
    }

    if (e.target.closest('[data-close]')) {
      sfx.tap();
      closeModal();
      return;
    }

    const modal = e.target.classList?.contains('modal') ? e.target : null;
    if (modal && !['modal-round', 'modal-over'].includes(modal.id)) closeModal(modal);
  });

  $('btn-host').addEventListener('click', hostGame);
  $('btn-join').addEventListener('click', joinGame);
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-end-round').addEventListener('click', endRound);
  $('btn-dhit').addEventListener('click', () => store.intent({ do: 'hit' }));
  $('btn-dstay').addEventListener('click', () => {
    sfx.stay();
    store.intent({ do: 'stay' });
  });
  $('btn-deal-next').addEventListener('click', () => store.intent({ do: 'next-round' }));

  // In a dealt game, dismissing the summary is also the host asking for the next
  // deal. In scorekeeping mode the round has already turned over, so it just closes.
  $('btn-next-round').addEventListener('click', () => {
    if (store.isDealt && store.isHost) store.intent({ do: 'next-round' });
  });
  $('btn-rematch').addEventListener('click', rematch);
  $('btn-share').addEventListener('click', shareRoom);
  $('room-chip').addEventListener('click', shareRoom);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-leave-over').addEventListener('click', leaveRoom);
  $('btn-manage').addEventListener('click', openPlayers);
  $('players-add').addEventListener('click', addPlayerRow);
  $('players-save').addEventListener('click', savePlayers);

  const code = $('join-code');
  code.addEventListener('input', () => {
    const clean = normalizeCode(code.value);
    if (code.value !== clean) code.value = clean;
    $('join-error').textContent = '';
    if (isCompleteCode(clean)) $('join-name').focus();
  });
  for (const input of [code, $('join-name')]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinGame();
    });
  }
  $('host-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') hostGame();
  });

  document.addEventListener('keydown', (e) => {
    if (anyModalOpen()) {
      trapFocus(e);
      if (e.key === 'Escape') {
        const top = document.querySelector('.modal:not([hidden])');
        if (top && !['modal-round', 'modal-over'].includes(top.id)) closeModal(top);
      }
    }
  });
}

// ── setup screens ─────────────────────────────────────────────────────────

function segment(host, options, current, onPick) {
  host.replaceChildren();
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.className = 'seg__opt';
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.value === current));
    if (opt.disabled) btn.disabled = true;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      sfx.tap();
      onPick(opt.value);
    });
    host.append(btn);
  }
}

function buildHostSetup() {
  const name = $('host-name');
  name.value = setup.name === 'You' ? '' : setup.name;
  name.addEventListener('input', () => saveSetup({ name: name.value }));
}

const BOT_STYLE_OPTIONS = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'cautious', label: 'Careful' },
  { value: 'balanced', label: 'Steady' },
  { value: 'reckless', label: 'Wild' },
];

const BOT_STYLE_HINTS = {
  mixed: 'A table of different nerves. Recommended.',
  cautious: 'They bank early and hate a coin flip.',
  balanced: 'They play the odds, mostly.',
  reckless: 'They chase the 7 like it owes them money.',
};

function paintHostSetup() {
  // 'online' means whichever transport is configured; older saves stored the
  // transport name directly.
  if (setup.mode === 'firebase' || setup.mode === 'relay') saveSetup({ mode: 'online' });
  if (!view.onlineKind && setup.mode === 'online') saveSetup({ mode: 'local' });

  segment(
    $('host-target'),
    [100, 200, 300].map((n) => ({ value: n, label: String(n) })),
    setup.target,
    (v) => {
      saveSetup({ target: v });
      paintHostSetup();
    },
  );

  // "Their own phones" is the better default when it can actually work, so the
  // stored default is online and this walks it back when nothing can serve it —
  // otherwise the picker shows a selected option that is also disabled.
  if (!view.onlineKind && setup.mode === 'online') saveSetup({ mode: 'local' });

  // Real cards vs the app dealing. Either works without a network: with a relay
  // the dealer lives there, and without one this device deals.
  segment(
    $('host-cards'),
    [
      { value: 'real', label: 'Real cards' },
      { value: 'dealt', label: 'Deal for us' },
    ],
    setup.cards,
    (v) => {
      saveSetup({ cards: v });
      paintHostSetup();
    },
  );

  const dealing = setup.cards === 'dealt';
  const online = setup.mode === 'online' && view.onlineKind;
  $('host-cards-hint').textContent = dealing
    ? online
      ? 'The app shuffles and deals. Everyone taps Hit or Stay on their own phone.'
      : 'The app shuffles and deals, and the phone goes round the table. Every card in Flip 7 is face up, so there is nothing to hide.'
    : "You're playing with a physical deck; the app keeps score.";

  $('field-bots').hidden = !dealing;
  $('field-botstyle').hidden = !dealing;
  $('field-mode').hidden = false;

  if (dealing) {
    segment(
      $('host-bots'),
      [0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })),
      setup.bots,
      (v) => {
        saveSetup({ bots: v });
        paintHostSetup();
      },
    );
    segment($('host-botstyle'), BOT_STYLE_OPTIONS, setup.botStyle, (v) => {
      saveSetup({ botStyle: v });
      paintHostSetup();
    });
    $('host-botstyle-hint').textContent = BOT_STYLE_HINTS[setup.botStyle] ?? '';
  }

  segment(
    $('host-mode'),
    [
      { value: 'online', label: 'Their own phones', disabled: !view.onlineKind },
      { value: 'local', label: dealing ? 'Pass this one round' : 'Just this one' },
    ],
    setup.mode,
    (v) => {
      saveSetup({ mode: v });
      paintHostSetup();
    },
  );

  const local = dealing
    ? 'One phone for the table — it tells you who to pass it to. Works with no signal at all.'
    : 'One phone for the table — you tap for everybody.';
  $('host-mode-hint').textContent = view.onlineKind
    ? setup.mode === 'online'
      ? 'Everyone joins with the room code and taps their own cards.'
      : local
    : `No online rooms available right now — ${local[0].toLowerCase()}${local.slice(1)}`;
}

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

  toggle('Sound', 'Blips for cards, a groan for a bust', 'sound', (on) => {
    setSoundEnabled(on);
    if (on) {
      unlockSound();
      sfx.save();
    }
  });
  toggle('Confetti', 'Celebrate a Flip 7 properly', 'effects', setFxEnabled);
  toggle('Bust-O-meter', 'Your bust odds and a hit-or-stay call', 'advice', () => {
    if (store.state) scorer.render();
  });

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
      themeSeg,
      [
        { value: 'auto', label: 'Auto' },
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

// ── hosting & joining ─────────────────────────────────────────────────────

function busy(button, on, label) {
  button.disabled = on;
  if (on) {
    button.dataset.was = button.textContent;
    button.textContent = label;
  } else if (button.dataset.was) {
    button.textContent = button.dataset.was;
  }
}

async function hostGame() {
  const btn = $('btn-host');
  const name = ($('host-name').value || 'Me').trim().slice(0, 14);
  saveSetup({ name });
  busy(btn, true, 'Creating…');
  try {
    const dealt = setup.cards === 'dealt';
    const mode = setup.mode === 'online' && view.onlineKind ? view.onlineKind : 'local';
    const code = await store.host({
      name,
      target: setup.target,
      mode,
      dealt,
      bots: setup.bots,
      botStyle: setup.botStyle,
    });
    view.shownRound = null;
    view.shownWinner = null;
    view.lastAnnounced = undefined;
    scorer.selectedId = null;
    go('room');
  } catch (err) {
    sfx.error();
    toast(err.message ?? 'Could not create the room');
  } finally {
    busy(btn, false);
  }
}

async function joinGame() {
  const btn = $('btn-join');
  const code = normalizeCode($('join-code').value);
  const name = ($('join-name').value || '').trim().slice(0, 14);
  const error = $('join-error');
  error.textContent = '';

  if (!isCompleteCode(code)) {
    error.textContent = 'A room code is four letters and numbers.';
    $('join-code').focus();
    return;
  }
  if (!name) {
    error.textContent = 'Which name should the table see?';
    $('join-name').focus();
    return;
  }

  saveSetup({ name });
  busy(btn, true, 'Joining…');
  try {
    // A code that isn't online may still be a game on this device.
    const modes = view.onlineKind ? [view.onlineKind, 'local'] : ['local'];
    let joined = false;
    let last = null;
    for (const mode of modes) {
      try {
        await store.join({ code, name, mode });
        joined = true;
        break;
      } catch (err) {
        last = err;
      }
    }
    if (!joined) throw last ?? new Error('Could not join');

    view.shownRound = null;
    view.shownWinner = null;
    view.lastAnnounced = undefined;
    scorer.selectedId = null;
    go('room');
    toast(`You're in — room ${code}`);
  } catch (err) {
    sfx.error();
    error.textContent = err.message ?? 'Could not join that room';
  } finally {
    busy(btn, false);
  }
}

async function resumeGame() {
  try {
    const ok = await store.resume();
    if (!ok) {
      $('home-resume').hidden = true;
      return toast('That game has finished');
    }
    view.shownRound = store.state?.lastRound?.round ?? null;
    view.shownWinner = store.state?.winnerId ?? null;
    go('room');
  } catch (err) {
    toast(err.message ?? 'Could not rejoin');
  }
}

function leaveRoom() {
  store.leave();
  closeAllModals();
  $('home-resume').hidden = true;
  go('home');
}

async function shareRoom() {
  const code = store.code;
  if (!code) return;
  const link = `${location.origin}${location.pathname}?room=${code}`;

  if (store.isOnline && navigator.share) {
    try {
      await navigator.share({ title: 'Flip 7', text: `Join my Flip 7 game — code ${code}`, url: link });
      return;
    } catch {
      /* dismissed — fall through to copying */
    }
  }
  // Offline there is nothing for another device to join, so say so rather than
  // handing over a code that will only fail on someone else's phone.
  if (!store.isOnline) {
    return toast(
      store.isPassAndPlay
        ? 'This game lives on this phone — pass it round rather than sharing'
        : `Room code ${code} — this device only`,
    );
  }

  try {
    await navigator.clipboard.writeText(link);
    toast('Join link copied');
  } catch {
    toast(`Room code: ${code}`);
  }
}

// ── rounds ────────────────────────────────────────────────────────────────

async function endRound() {
  const state = store.state;
  if (!state || !store.isHost) return;

  if (!roundStarted(state)) {
    sfx.error();
    return toast('No cards tapped yet');
  }

  const { paths } = endRoundUpdates(state);
  sfx.count();
  await store.update(paths);
}

async function rematch() {
  if (!store.state) return;
  closeAllModals();
  if (!store.isHost) return toast('The host can start the next game');
  view.shownWinner = null;
  view.shownRound = null;
  if (store.isDealt) {
    await store.intent({ do: 'rematch' });
  } else {
    await store.update(rematchUpdates(store.state));
  }
  toast('Scores cleared — good luck');
}

// ── reacting to state ─────────────────────────────────────────────────────

function onState(state) {
  if (!state) return;

  $('room-code').textContent = state.code ?? '····';
  $('room-meta').textContent = state.lobby
    ? `taking seats · to ${state.target}`
    : `round ${state.round} · to ${state.target}`;
  scorer.render();

  renderDealt(state);

  // A table of one needs telling what to do next — inline, not as a toast that
  // covers the very code they're meant to read out.
  const hint = $('room-hint');
  // A lobby is exactly the moment the host should be reading the code out, bots
  // at the table or not — so show it there too, not only when the room is empty.
  const gathering =
    playerList(state).length < 2 || (state.lobby && store.isOnline && store.isHost);
  hint.hidden = !gathering;
  if (gathering) {
    // Never invite someone to read a code out when nothing can act on it: with
    // no transport, other devices have no way to reach this game at all.
    hint.textContent = store.isOnline
      ? `Read out the code ${state.code} — players appear here as they join.`
      : store.isPassAndPlay
        ? 'Add everyone from the menu, then pass the phone round as it asks.'
        : 'Add everyone at the table from the menu, then tap their cards as they land.';
  }

  // The host publishes the summary; every phone shows it when it appears.
  const last = state.lastRound;
  if (last && last.round !== view.shownRound && state.status !== 'finished') {
    view.shownRound = last.round;
    showRoundSummary(last);
  }

  if (state.status === 'finished' && state.winnerId && view.shownWinner !== state.winnerId) {
    view.shownWinner = state.winnerId;
    view.shownRound = state.lastRound?.round ?? view.shownRound;
    showWinner(state);
  }
}

/**
 * The dealt-game controls. The keypad is for tapping cards you were physically
 * dealt; when the app is dealing, the only decisions are hit and stay.
 */
function renderDealt(state) {
  const dealt = state.kind === 'dealt';
  // Lets the layout differ: with no keypad, splitting the slack above and below
  // the hand leaves two dead zones and pushes the turn cue off the bottom.
  $('screen-room').dataset.mode = dealt ? 'dealt' : 'score';
  $('pad').hidden = dealt;
  $('dealt').hidden = !dealt;
  for (const id of ['btn-undo', 'btn-clear']) $(id).hidden = dealt;
  if (dealt) $('btn-end-round').hidden = true;
  $('waiting').hidden = dealt || store.isHost;
  if (!dealt) return;

  const me = state.players?.[store.actingId];
  const myTurn = state.turnId === store.actingId;
  const pending = state.pending;
  const mineToTarget = pending?.byId === store.actingId;
  const over = state.status === 'finished' || state.roundOver;

  // The same button opens the game from the lobby and turns each round over, so
  // there's one place the host looks for "deal".
  const seats = playerList(state).length;
  const canDeal = (state.lobby || state.roundOver) && store.isHost && state.status !== 'finished';
  $('dealt-actions').hidden = !myTurn || !!pending;
  $('btn-deal-next').hidden = !canDeal;
  if (canDeal) {
    // Dealing to a table of one would deal the host a hand and end the round.
    $('btn-deal-next').disabled = state.lobby && seats < 2;
    $('btn-deal-next').textContent = state.lobby
      ? `Deal the first round (${seats} in)`
      : 'Deal the next round';
  }

  if (myTurn && !pending) {
    const hand = me?.hand ?? { numbers: [] };
    // Say the number you'd bank, not just "stay" — it's the whole decision.
    $('dstay-sub').textContent = `bank ${roundScoreOf(me)}`;
    $('dhit-sub').textContent = hand.chance ? 'shielded' : 'one more card';
  }

  // One attribute drives every "it's on you now" cue in the CSS, so the status
  // pill, the hand and the buttons can't disagree about whose turn it is.
  $('dealt').dataset.turn = mineToTarget ? 'aim' : myTurn ? 'mine' : over ? 'over' : 'theirs';

  renderAim(state, mineToTarget);
  $('dealt-status').textContent = dealtStatus(state, {
    myTurn,
    pending,
    mineToTarget,
    over,
    waiting: !!me?.waiting,
  });
  renderFeed(state.feed ?? [], state.players ?? {});
  announceTurn(state, { myTurn, mineToAim: mineToTarget, pending });
  announceSittingOut(state, me);
  announceWhatHappenedToMe(state);
}

/** The action card you drew and have to point at somebody. */
function renderAim(state, mineToAim) {
  const panel = $('aim');
  panel.hidden = !mineToAim;
  if (!mineToAim) return;

  const pending = state.pending;
  const holder = $('aim-card');
  // Rebuild only when the card changes, so the deal-in animation doesn't restart
  // on every heartbeat.
  const key = pending.action;
  if (holder.dataset.action !== key) {
    holder.dataset.action = key;
    holder.replaceChildren(createCard(pending.card ?? { kind: 'action', action: pending.action }));
  }

  const targets = pending.targets.length;
  const only = targets === 1 ? state.players?.[pending.targets[0]]?.name : null;
  $('aim-text').textContent = {
    freeze: only
      ? `You drew Freeze. ${only} is the only one left — tap them to end their round.`
      : 'You drew Freeze. Tap a player to make them bank and sit out.',
    flip3: only
      ? `You drew Flip Three. Tap ${only} to make them flip three cards.`
      : 'You drew Flip Three. Tap a player to make them flip three cards.',
    gift: only
      ? `A second Second Chance — tap ${only} to give it to them.`
      : 'A second Second Chance. Tap a player to give it away.',
  }[pending.action];
}

/**
 * The moment it becomes your turn.
 *
 * A phone is face-down on a table for most of a round, so a colour change on a
 * row is not enough — this is the one cue that has to reach someone who isn't
 * looking. It fires on the transition, not on every render, so a heartbeat
 * doesn't buzz your pocket.
 */
function announceTurn(state, { myTurn, mineToAim, pending }) {
  const mine = myTurn && !pending;
  const acting = store.actingId;
  let passed = false;

  // On a shared phone the cue that matters is *who to hand it to*, and it has to
  // be unmissable — nobody is watching a screen that isn't theirs yet.
  if (store.isPassAndPlay && acting && acting !== view.lastActor) {
    const first = view.lastActor === undefined;
    view.lastActor = acting;
    if (!first && (mine || mineToAim)) {
      const name = state.players?.[acting]?.name ?? 'the next player';
      sfx.deal();
      buzz([40, 60, 40]);
      showBanner(`Pass to ${name}`, {
        tone: 'turn',
        sub: mineToAim
          ? 'an action card to aim'
          : `holding ${roundScoreOf(state.players?.[acting])}`,
        ms: 1400,
      });
      announce(`Pass the phone to ${name}.`);
      passed = true;
    }
  }

  if (mine && !view.wasMyTurn && !passed) {
    sfx.deal();
    buzz([28, 60, 28]);
    // A toast, not the centre banner: your turn is exactly when you want to be
    // looking at your own hand, and a banner would sit on top of it. The lasting
    // cue is the styling driven by data-turn.
    const held = roundScoreOf(state.players?.[acting]);
    const who = store.isPassAndPlay ? (state.players?.[acting]?.name ?? 'You') : 'Your';
    const label = store.isPassAndPlay ? `${who}'s turn` : 'Your turn';
    toast(held ? `${label} — holding ${held}` : label, 2200);
    announce(`${label}.`);
  }
  if (mineToAim && !view.wasMineToAim) {
    const label = ACTIONS[pending.action === 'gift' ? 'chance' : pending.action]?.label ?? 'a card';
    if (pending.action === 'freeze') sfx.freeze();
    else if (pending.action === 'flip3') sfx.flip3();
    else sfx.save();
    buzz([18, 40, 18, 40, 18]);
    showBanner(`You drew ${label}`, {
      tone: pending.action === 'gift' ? 'save' : pending.action,
      sub: 'pick who it lands on',
      ms: 1100,
      card: createCard(pending.card ?? { kind: 'action', action: pending.action }),
    });
  }
  view.wasMyTurn = mine;
  view.wasMineToAim = mineToAim;
}

/** A short buzz where the device supports it. Silent everywhere else. */
function buzz(pattern) {
  if (!settings.sound) return; // the sound switch is the "don't draw attention" switch
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not available, or blocked without a gesture */
  }
}

/**
 * Walking in halfway through a round means sitting that one out — the cards were
 * dealt before you got here. Told nothing, you watch a whole round go past
 * without being dealt to and reasonably conclude the app forgot you.
 *
 * Read from the room rather than the feed, so it still fires for a phone that
 * reconnects mid-round and for one that joined before it started watching.
 */
function announceSittingOut(state, me) {
  const key = me?.waiting ? `${state.code}:${state.round}` : null;
  if (!key || key === view.announcedWaiting) return;
  view.announcedWaiting = key;
  showBanner("You're in", {
    tone: 'freeze',
    sub: `round ${state.round} was already dealt — you play from the next one`,
    ms: 1800,
  });
}

/**
 * Something done *to you* between your turns needs to be impossible to miss.
 *
 * Being frozen ends your round on whatever you happen to be holding — sometimes
 * nothing — and if that only appears as a line in a list it reads as the game
 * skipping you.
 */
function announceWhatHappenedToMe(state) {
  const feed = state.feed ?? [];
  if (view.lastAnnounced === undefined) {
    // Don't replay history when joining or reconnecting.
    view.lastAnnounced = feed.at(-1)?.n ?? 0;
    return;
  }

  for (const line of feed) {
    if (line.n <= view.lastAnnounced) continue;
    view.lastAnnounced = line.n;
    if (line.to !== store.actingId) continue;

    // Who did it, by name — "frozen" without a culprit is the part that annoys
    // people. Doing it to yourself is worth naming too.
    const self = line.who === store.actingId;
    const by = self ? 'You' : (state.players?.[line.who]?.name ?? 'Someone');
    const card = line.card ? createCard(line.card) : null;

    if (line.type === 'freeze') {
      sfx.freeze();
      buzz([40, 70, 40]);
      showBanner('Frozen', {
        tone: 'freeze',
        sub: self
          ? `you froze yourself — banked ${line.score ?? 0}`
          : `${by} froze you — banked ${line.score ?? 0}, you're out this round`,
        ms: 1700,
        card: createCard({ kind: 'action', action: 'freeze' }),
      });
    } else if (line.type === 'flip3-start') {
      sfx.flip3();
      buzz([25, 50, 25, 50, 25]);
      showBanner('Flip Three', {
        tone: 'flip3',
        sub: self ? 'you took three yourself' : `${by} made you flip three cards`,
        ms: 1500,
        card: createCard({ kind: 'action', action: 'flip3' }),
      });
    } else if (line.type === 'gift') {
      sfx.save();
      toast(`${by === 'You' ? 'You kept' : `${by} gave you`} a Second Chance`);
    } else if (line.type === 'bust' && self) {
      // The card that did it, on screen. Being told only "busted" leaves you
      // wondering which duplicate landed.
      sfx.bust();
      buzz([60, 40, 90]);
      showBanner('Busted', {
        tone: 'bust',
        sub: `${cardName(line.card)} — you already had one, so this round scores 0`,
        ms: 1800,
        card,
      });
    } else if (line.type === 'stay' && self) {
      sfx.stay();
      showBanner(`Banked ${line.score ?? 0}`, {
        tone: 'save',
        sub: "you're safe — sit tight until the round ends",
        ms: 1300,
      });
    } else if (line.type === 'second-chance' && self) {
      sfx.save();
      showBanner('Second Chance!', {
        tone: 'save',
        sub: `${cardName(line.card)} would have busted you — both cards discarded`,
        ms: 1500,
        card,
      });
    }
  }
}

/**
 * A running account of the round. Bot turns take about a second each, so without
 * this the round appears to end without anyone else playing.
 */
function renderFeed(feed, players) {
  const host = $('feed');
  const seen = new Set();

  for (const el of [...host.children]) {
    const n = Number(el.dataset.n);
    if (feed.some((line) => line.n === n)) seen.add(n);
    else el.remove();
  }

  for (const line of feed) {
    if (seen.has(line.n)) continue;
    const el = document.createElement('li');
    el.className = 'feed__line';
    el.dataset.n = String(line.n);
    if (['bust', 'flip7', 'freeze', 'flip3-start'].includes(line.type)) {
      el.dataset.tone = line.type === 'flip3-start' ? 'flip3' : line.type;
    }
    // Lines about you are the ones you'd scroll back for, so they don't have to
    // be found by reading names.
    if (line.who === store.actingId || line.to === store.actingId) el.dataset.me = '';
    // The marker dot borrows the actor's seat colour, matching their monogram.
    const actor = players[line.who];
    if (actor) el.style.setProperty('--seat-c', seatColor(actor.order ?? 0));
    el.textContent = line.text;
    host.append(el);
  }

  // Keep only the last few on screen, newest at the bottom, scrolled into view.
  while (host.childElementCount > 6) host.firstElementChild.remove();
  host.scrollTop = host.scrollHeight;
}

function roundScoreOf(player) {
  if (!player) return 0;
  const hand = player.hand ?? {};
  const base = (hand.numbers ?? []).reduce((a, b) => a + b, 0);
  const doubled = (hand.mods ?? []).some((m) => m.op === 'mul');
  const bonus = (hand.mods ?? []).filter((m) => m.op === 'add').reduce((a, m) => a + m.value, 0);
  if (hand.busted) return 0;
  return base * (doubled ? 2 : 1) + bonus + ((hand.numbers ?? []).length >= 7 ? 15 : 0);
}

function dealtStatus(state, { myTurn, pending, mineToTarget, over, waiting }) {
  const name = (id) => state.players?.[id]?.name ?? 'someone';

  if (state.status === 'finished') return 'Game over.';
  if (state.lobby) {
    if (!store.isHost) return `Waiting for ${name(state.hostId)} to deal.`;
    if (playerList(state).length >= 2) return 'Everyone in? Tap deal and the cards go out.';
    // Offline there is no code for anyone to join with, so don't suggest one.
    return store.isPassAndPlay
      ? 'Add players from the menu, or a bot, then deal.'
      : 'Waiting for someone to join — read out the code, or add a bot.';
  }
  if (state.roundOver) {
    return store.isHost ? 'Round over.' : `Round over — waiting for ${name(state.hostId)}.`;
  }
  // Say it every render, not just once: this is the answer to "why am I not
  // being dealt anything?" for as long as the round lasts.
  if (waiting) return `You sit out round ${state.round} — you're dealt in next round.`;
  if (pending) {
    const label = { freeze: 'Freeze', flip3: 'Flip Three', gift: 'a spare Second Chance' }[
      pending.action
    ];
    // The aim panel spells out the choice; this just says who the table waits on.
    if (mineToTarget) return 'Pick who it lands on.';
    const target = pending.targets.length === 1 ? name(pending.targets[0]) : null;
    return target
      ? `${name(pending.byId)} drew ${label} — aiming at ${target}…`
      : `${name(pending.byId)} drew ${label} — choosing a target…`;
  }
  if (myTurn) return 'Your turn — hit or stay';

  // Out of the round but it hasn't ended: say why you can't do anything, rather
  // than only naming whoever is playing.
  const mine = state.players?.[store.actingId];
  const playing = state.turnId ? `${name(state.turnId)} is playing…` : 'Dealing…';
  if (mine && !mine.waiting) {
    if (mine.hand?.busted) return `You busted — ${playing}`;
    if (mine.state === 'frozen') return `Frozen out this round — ${playing}`;
    if (mine.state === 'stayed') return `Banked ${roundScoreOf(mine)} — ${playing}`;
  }
  void over;
  return playing;
}

function onSyncError(error) {
  if (error?.code === 'room-missing') {
    toast('That game has ended');
    leaveRoom();
    return;
  }
  toast(error?.message ?? 'Lost touch with the room');
}

function showRoundSummary(last) {
  const state = store.state;
  $('round-title').textContent = `Round ${last.round}`;
  fillScores(
    $('round-scores'),
    (last.results ?? []).map((r) => ({
      name: r.name,
      seat: state.players?.[r.id]?.order,
      delta: r.delta,
      total: r.total,
      busted: r.busted,
      note: noteFor(r),
    })),
    state.target,
  );
  $('btn-next-round').textContent = store.isDealt
    ? `Deal round ${last.round + 1}`
    : `Start round ${last.round + 1}`;
  openModal('round');
  sfx.count();
}

function showWinner(state) {
  const winner = state.players?.[state.winnerId];
  if (!winner) return;
  const mine = state.winnerId === store.myId;

  $('over-title').textContent = mine ? 'You win!' : `${winner.name} wins`;
  $('over-sub').textContent = `${winner.total} points in ${(state.round ?? 2) - 1} rounds.`;
  fillScores(
    $('over-scores'),
    standings(state).map((p) => ({
      name: p.name,
      seat: p.order,
      delta: p.history?.at(-1) ?? 0,
      total: p.total ?? 0,
      winner: p.id === state.winnerId,
      note: p.id === state.winnerId ? 'winner' : '',
    })),
    state.target,
  );

  $('btn-rematch').hidden = !store.isHost;
  closeModal($('modal-round'));
  openModal('over');
  if (mine) {
    sfx.win();
    celebrate();
  } else {
    sfx.lose();
  }
  announce(`${winner.name} wins with ${winner.total}`);
}

function noteFor(result) {
  if (result.busted) return 'busted';
  if (result.flip7) return 'Flip 7 · +15';
  const bits = [];
  if (result.doubled) bits.push('×2');
  if (result.addMods?.length) bits.push(result.addMods.map((v) => `+${v}`).join(' '));
  return bits.join(' ');
}

// ── the players dialog (host) ─────────────────────────────────────────────

let editRows = [];

function paintMenu() {
  $('menu-code').textContent = store.code ?? '····';
  $('menu-status').textContent = store.isOnline
    ? `${playerList(store.state).length} at the table · synced via ${store.transport}`
    : 'Keeping score on this device only';
  $('btn-manage').hidden = !store.isHost;
  $('btn-share').hidden = !store.code;
}

function openPlayers() {
  if (!store.isHost) return;
  editRows = playerList(store.state).map((p) => ({ id: p.id, name: p.name, remove: false }));
  renderPlayersModal();
  closeModal($('modal-menu'));
  openModal('players');
}

function addPlayerRow() {
  if (editRows.length >= 12) return toast('That is a lot of players');
  editRows.push({ id: null, name: `Player ${editRows.length + 1}`, remove: false });
  renderPlayersModal();
}

function renderPlayersModal() {
  const host = $('players-namelist');
  host.replaceChildren();
  editRows.forEach((row, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'namerow';

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.maxLength = 14;
    input.value = row.name;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    input.addEventListener('input', () => {
      row.name = input.value;
    });

    const del = document.createElement('button');
    del.className = 'namerow__del';
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `Remove ${row.name}`);
    // The host has to stay at their own table.
    del.disabled = row.id === store.myId || editRows.length <= 1;
    del.addEventListener('click', () => {
      editRows.splice(i, 1);
      renderPlayersModal();
    });

    wrap.append(input, del);
    host.append(wrap);
  });
}

async function savePlayers() {
  const state = store.state;
  if (!state || !store.isHost) return;

  const kept = new Set(editRows.filter((r) => r.id).map((r) => r.id));
  const paths = {};

  for (const p of playerList(state)) {
    if (!kept.has(p.id) && p.id !== store.myId) paths[`players/${p.id}`] = null;
  }
  editRows.forEach((row, order) => {
    const name = row.name.trim() || `Player ${order + 1}`;
    if (row.id) {
      paths[`players/${row.id}/name`] = name;
      paths[`players/${row.id}/order`] = order;
    }
  });

  await store.update(paths);
  // New rows need ids, which addPlayer allocates.
  for (const row of editRows.filter((r) => !r.id)) {
    await store.addPlayer(row.name.trim() || 'Player');
  }

  closeModal($('modal-players'));
  sfx.tap();
}

boot();
