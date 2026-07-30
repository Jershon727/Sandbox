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

const $ = (id) => document.getElementById(id);

const store = new Store();
const scorer = new Scorer(store);

const view = {
  screen: 'home',
  lastAnnounced: undefined, // feed line already shown as a banner
  onlineKind: null, // 'relay' | 'firebase' | null
  shownRound: null, // last round summary displayed
  shownWinner: null,
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

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline support is a bonus, not a requirement */
      });
    });
  }
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

  // Real cards vs the app dealing. Dealing needs the relay, since the dealer
  // lives there — nobody should be able to deal themselves a card.
  const canDeal = view.onlineKind === 'relay';
  if (!canDeal && setup.cards === 'dealt') saveSetup({ cards: 'real' });

  segment(
    $('host-cards'),
    [
      { value: 'real', label: 'Real cards' },
      { value: 'dealt', label: 'Deal for us', disabled: !canDeal },
    ],
    setup.cards,
    (v) => {
      saveSetup({ cards: v });
      paintHostSetup();
    },
  );

  const dealing = setup.cards === 'dealt';
  $('host-cards-hint').textContent = dealing
    ? 'The app shuffles and deals. Everyone taps Hit or Stay on their own phone.'
    : canDeal
      ? "You're playing with a physical deck; the app keeps score."
      : "You're playing with a physical deck; the app keeps score. Dealing needs the relay.";

  $('field-bots').hidden = !dealing;
  $('field-botstyle').hidden = !dealing;
  $('field-mode').hidden = dealing;

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
    return;
  }

  segment(
    $('host-mode'),
    [
      { value: 'online', label: 'Their own phones', disabled: !view.onlineKind },
      { value: 'local', label: 'Just this one' },
    ],
    setup.mode,
    (v) => {
      saveSetup({ mode: v });
      paintHostSetup();
    },
  );

  $('host-mode-hint').textContent = view.onlineKind
    ? setup.mode === 'online'
      ? 'Everyone joins with the room code and taps their own cards.'
      : 'One phone for the table — you tap for everybody.'
    : 'Online rooms need a relay address in relay-config.js, or a Firebase config. Until then, one phone keeps score for the table.';
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
    const mode = dealt ? 'relay' : setup.mode === 'online' ? view.onlineKind : 'local';
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
  const text = store.isOnline
    ? `Join my Flip 7 game — code ${code}\n${link}`
    : `Flip 7 room ${code}`;

  if (store.isOnline && navigator.share) {
    try {
      await navigator.share({ title: 'Flip 7', text: `Join my Flip 7 game — code ${code}`, url: link });
      return;
    } catch {
      /* dismissed — fall through to copying */
    }
  }
  try {
    await navigator.clipboard.writeText(store.isOnline ? link : code);
    toast(store.isOnline ? 'Join link copied' : `Room code ${code} copied`);
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
  $('room-meta').textContent = `round ${state.round} · to ${state.target}`;
  scorer.render();

  renderDealt(state);

  // A table of one needs telling what to do next — inline, not as a toast that
  // covers the very code they're meant to read out.
  const hint = $('room-hint');
  const alone = playerList(state).length < 2;
  hint.hidden = !alone;
  if (alone) {
    hint.textContent = store.isOnline
      ? `Read out the code ${state.code} — players appear here as they join.`
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
  $('pad').hidden = dealt;
  $('dealt').hidden = !dealt;
  for (const id of ['btn-undo', 'btn-clear']) $(id).hidden = dealt;
  if (dealt) $('btn-end-round').hidden = true;
  $('waiting').hidden = dealt || store.isHost;
  if (!dealt) return;

  const me = state.players?.[store.myId];
  const myTurn = state.turnId === store.myId;
  const pending = state.pending;
  const mineToTarget = pending?.byId === store.myId;
  const over = state.status === 'finished' || state.roundOver;

  $('dealt-actions').hidden = !myTurn || !!pending;
  $('btn-deal-next').hidden = !(state.roundOver && store.isHost && state.status !== 'finished');

  if (myTurn && !pending) {
    const hand = me?.hand ?? { numbers: [] };
    const banked = hand.numbers.reduce((a, b) => a + b, 0);
    $('dstay-sub').textContent = `bank ${roundScoreOf(me)}`;
    $('dhit-sub').textContent = hand.chance ? 'shielded' : 'one more card';
    void banked;
  }

  $('dealt-status').textContent = dealtStatus(state, { myTurn, pending, mineToTarget, over });
  renderFeed(state.feed ?? []);
  announceWhatHappenedToMe(state);
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
    if (line.to !== store.myId || line.who === store.myId) continue;

    const by = state.players?.[line.who]?.name ?? 'Someone';
    if (line.type === 'freeze') {
      sfx.freeze();
      showBanner('Frozen', {
        tone: 'freeze',
        sub: `${by} froze you — your round ends here`,
        ms: 1600,
      });
    } else if (line.type === 'flip3-start') {
      sfx.flip3();
      showBanner('Flip Three', { tone: 'flip3', sub: `${by} made you flip three`, ms: 1400 });
    } else if (line.type === 'gift') {
      sfx.save();
      toast(`${by} gave you a Second Chance`);
    }
  }
}

/**
 * A running account of the round. Bot turns take about a second each, so without
 * this the round appears to end without anyone else playing.
 */
function renderFeed(feed) {
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
    if (['bust', 'flip7', 'freeze'].includes(line.type)) el.dataset.tone = line.type;
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

function dealtStatus(state, { myTurn, pending, mineToTarget, over }) {
  const name = (id) => state.players?.[id]?.name ?? 'someone';

  if (state.status === 'finished') return 'Game over.';
  if (state.roundOver) {
    return store.isHost ? 'Round over.' : `Round over — waiting for ${name(state.hostId)}.`;
  }
  if (pending) {
    const label = { freeze: 'Freeze', flip3: 'Flip Three', gift: 'a spare Second Chance' }[
      pending.action
    ];
    return mineToTarget
      ? `You drew ${label} — tap a player to use it on.`
      : `${name(pending.byId)} drew ${label}…`;
  }
  if (myTurn) return 'Your turn.';
  if (state.turnId) return `${name(state.turnId)} is playing…`;
  void over;
  return 'Dealing…';
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
