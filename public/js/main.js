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
  onlineAvailable: false,
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

  view.onlineAvailable = await Store.onlineAvailable();
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

function paintHostSetup() {
  // Without a Firebase config there is nothing to sync to, so don't offer it.
  if (!view.onlineAvailable && setup.mode === 'firebase') saveSetup({ mode: 'local' });

  segment(
    $('host-target'),
    [100, 200, 300].map((n) => ({ value: n, label: String(n) })),
    setup.target,
    (v) => {
      saveSetup({ target: v });
      paintHostSetup();
    },
  );

  segment(
    $('host-mode'),
    [
      { value: 'firebase', label: 'Their own phones', disabled: !view.onlineAvailable },
      { value: 'local', label: 'Just this one' },
    ],
    setup.mode,
    (v) => {
      saveSetup({ mode: v });
      paintHostSetup();
    },
  );

  $('host-mode-hint').textContent = view.onlineAvailable
    ? setup.mode === 'firebase'
      ? 'Everyone joins with the room code and taps their own cards.'
      : 'One phone for the table — you tap for everybody.'
    : 'Online rooms need a Firebase config in firebase-config.js. Until then, one phone keeps score for the table.';
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
    const code = await store.host({ name, target: setup.target, mode: setup.mode });
    view.shownRound = null;
    view.shownWinner = null;
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
    const modes = view.onlineAvailable ? ['firebase', 'local'] : ['local'];
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
  await store.update(rematchUpdates(store.state));
  toast('Scores cleared — good luck');
}

// ── reacting to state ─────────────────────────────────────────────────────

function onState(state) {
  if (!state) return;

  $('room-code').textContent = state.code ?? '····';
  $('room-meta').textContent = `round ${state.round} · to ${state.target}`;
  scorer.render();

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
  $('btn-next-round').textContent = `Start round ${state.round}`;
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
    ? `${playerList(store.state).length} at the table · everyone on their own phone`
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
