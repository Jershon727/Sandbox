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
  tiedLeaders,
  makeId,
  isAway,
  hostAwayFor,
  canRailbird,
  roundScore,
  HOST_AWAY_TAKEOVER,
} from './room.js';
import { REACTIONS, CHAT_MAX, cleanChat } from './table.js';
import { bustChance, riskBand } from './odds.js';
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
  wait,
  buzz,
} from './views.js';
import { sfx, setSoundEnabled, unlockSound, setHeartbeat } from './sound.js';
import { initFx, setFxEnabled, celebrate, burstFrom } from './fx.js';
import { createCard, dealFrom } from './cardview.js';
import { seatColor, monogram } from './avatar.js';
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
  spectateId: null, // whose hand the read-only strip is showing
  spectateSeen: null, // { id, round, n, m, c } — that hand as last painted
  armTimer: 0, // Hit/Stay stay inert for a beat after appearing
  lastReactAt: 0, // reactions are rate-limited to one a second
  seenReactions: null, // scorekeeping reaction ids already floated
  lastChatAt: 0, // chat shares the one-a-second limit
  seenChat: null, // scorekeeping chat ids already surfaced
  chatUnread: 0, // messages arrived while the chat sheet was closed
  lastDeckLeft: null, // for nudging the deck when a card comes off it
  lastConn: null, // the connection pill's last painted state
  connTimer: 0, // hides the brief "Back online" pill
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
  buildReactions();
  buildChat();
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
      if (which === 'rules') {
        $('rules-target').textContent = String(store.state?.target ?? setup.target);
        // The "using this app" section depends on who is holding the cards.
        $('rules-real').hidden = store.isDealt;
        $('rules-dealt').hidden = !store.isDealt;
        $('rules-press').hidden = !(store.isDealt && store.state?.pressBets === true);
      }
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
  // Both buttons check the arming window: they appear the instant the turn
  // does, and a tap already in flight toward that spot shouldn't count.
  $('btn-dhit').addEventListener('click', () => {
    if (actionsArming()) return;
    store.intent({ do: 'hit' });
  });
  $('btn-dstay').addEventListener('click', () => {
    if (actionsArming()) return;
    sfx.stay();
    store.intent({ do: 'stay' });
  });
  $('btn-deal-next').addEventListener('click', () => store.intent({ do: 'next-round' }));

  // The host's way past a phone that went quiet mid-turn: bank the hand now
  // rather than waiting out the dealer's timer, or clear the seat for good.
  $('btn-stall-skip').addEventListener('click', () => {
    const id = $('stall').dataset.target;
    if (id) store.intent({ do: 'skip', targetId: id });
  });
  $('btn-stall-remove').addEventListener('click', () => {
    const id = $('stall').dataset.target;
    if (id) store.intent({ do: 'remove-seat', targetId: id });
  });

  // In a dealt game, dismissing the summary is also the host asking for the next
  // deal. In scorekeeping mode the round has already turned over, so it just closes.
  $('btn-next-round').addEventListener('click', () => {
    if (store.isDealt && store.isHost) store.intent({ do: 'next-round' });
  });
  $('btn-rematch').addEventListener('click', rematch);
  // Ready-up for the next game, and dealing back in from the bench, are the
  // same ask: "count me in from here".
  $('btn-ready').addEventListener('click', () => {
    sfx.tap();
    store.intent({ do: 'ready' });
  });
  $('btn-dealin').addEventListener('click', () => {
    sfx.tap();
    store.intent({ do: 'ready' });
  });
  $('btn-share').addEventListener('click', shareRoom);
  $('room-chip').addEventListener('click', shareRoom);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-leave-over').addEventListener('click', leaveRoom);
  $('btn-manage').addEventListener('click', openPlayers);
  $('players-add').addEventListener('click', addPlayerRow);
  $('players-save').addEventListener('click', savePlayers);

  // The "that name is already playing" choice: rejoin as them, or rename.
  $('claim-rejoin').addEventListener('click', () => {
    closeModal($('modal-claim'));
    joinGame({ takeover: true });
  });
  $('claim-fresh').addEventListener('click', () => {
    const input = $('join-name');
    input.value = freshName((input.value || '').trim());
    closeModal($('modal-claim'));
    joinGame();
  });

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
  // 'You' and 'Me' were old placeholder fallbacks; never resurrect them.
  name.value = ['You', 'Me'].includes(setup.name) ? '' : setup.name;
  name.addEventListener('input', () => {
    $('host-error').textContent = '';
    saveSetup({ name: name.value });
  });
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
  $('field-press').hidden = !dealing;
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

    // The Press bet house rule — off is the standard game.
    segment(
      $('host-press'),
      [
        { value: false, label: 'Off' },
        { value: true, label: 'On' },
      ],
      setup.pressBets === true,
      (v) => {
        saveSetup({ pressBets: v });
        paintHostSetup();
      },
    );
    $('host-press-hint').textContent =
      setup.pressBets === true
        ? 'Before a hit, wager points that you won’t bust. The payout is set by the exact odds you take — riskier hand, bigger win.'
        : 'A house rule: side-bets on your own draw. Off plays the standard game.';
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
  toggle('Vibrate', 'A tick for each card, a thump for the bad news', 'vibrate', (on) => {
    if (on) buzz(20);
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
  // No silent fallback name: a seat labelled "Me" with a "you" badge next to it
  // reads as a bug, and everyone else at the table sees "Me" too. The name you
  // type is remembered, so this is a one-time ask per device.
  const name = $('host-name').value.trim().slice(0, 14);
  if (!name) {
    sfx.error();
    $('host-error').textContent = 'What should the table call you?';
    $('host-name').focus();
    return;
  }
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
      pressBets: dealt && setup.pressBets === true,
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

async function joinGame(opts = {}) {
  // Also wired straight to a click, so the argument may be an event.
  const takeover = opts?.takeover === true;
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
        await store.join({ code, name, mode, takeover });
        joined = true;
        break;
      } catch (err) {
        last = err;
        // The room exists and the name is taken — trying another transport
        // would only bury that answer under a "no such room".
        if (err?.code === 'seat-active') break;
      }
    }
    if (!joined && last?.code === 'seat-active') {
      openClaimModal(name);
      return;
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

/**
 * The name you typed is already being played by someone whose phone looks very
 * much alive. Rejoining silently would put two people in one seat, so ask:
 * that's you on a new phone, or a second person who needs their own name?
 */
function openClaimModal(name) {
  $('claim-title').textContent = `${name} is already playing`;
  $('claim-lede').textContent =
    'Someone at the table is using that name right now. Rejoin as them only if that was you — otherwise join with your own name.';
  $('claim-rejoin').textContent = `That's me — take my seat back`;
  $('claim-fresh').textContent = `Join as ${freshName(name)}`;
  openModal('claim');
}

/** "Sam" → "Sam 2", "Sam 2" → "Sam 3", capped at the name-length limit. */
function freshName(name) {
  const m = name.match(/^(.*?)\s*(\d+)$/);
  const base = m ? m[1] : name;
  const n = m ? Number(m[2]) + 1 : 2;
  return `${base.slice(0, 14 - String(n).length - 1)} ${n}`;
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
  setHeartbeat(null);
  view.seenReactions = null;
  view.seenChat = null;
  view.chatUnread = 0;
  paintChatBadge();
  view.gamePointSeen = null;
  view.lastDeckLeft = null;
  view.spectateSeen = null;
  view.lastConn = null;
  clearTimeout(view.connTimer);
  $('conn-pill').hidden = true;
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
  if (!state) return;
  // The host's button — unless the host has vanished for long enough that the
  // table would otherwise be stranded mid-round, in which case it's anyone's.
  const orphaned = store.isOnline && hostAwayFor(state) >= HOST_AWAY_TAKEOVER;
  if (!store.isHost && !orphaned) return;

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
    // Online, the next game is opt-in (whoever readied plays). On a shared
    // phone there's nobody remote to wait for, so everyone is simply in.
    await store.intent({ do: 'rematch', everyone: !store.isOnline });
  } else {
    await store.update(rematchUpdates(store.state));
  }
  toast('Scores cleared — good luck');
}

// ── emoji reactions ───────────────────────────────────────────────────────

/** The tray: six emoji, one tap each, floating up from your row on every phone. */
function buildReactions() {
  const tray = $('react-tray');
  for (const emoji of REACTIONS) {
    const btn = document.createElement('button');
    btn.className = 'reactions__btn';
    btn.type = 'button';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', `React with ${emoji}`);
    btn.addEventListener('click', () => sendReaction(emoji));
    tray.append(btn);
  }

  // The chat door lives at the end of the tray, wearing its unread count.
  const chat = document.createElement('button');
  chat.className = 'reactions__btn reactions__btn--chat';
  chat.id = 'chat-open';
  chat.type = 'button';
  chat.setAttribute('aria-label', 'Open table chat');
  const badge = document.createElement('span');
  badge.className = 'reactions__badge';
  badge.id = 'chat-badge';
  badge.hidden = true;
  chat.append(document.createTextNode('💬'), badge);
  chat.addEventListener('click', openChat);
  tray.append(chat);
}

function sendReaction(emoji) {
  const now = Date.now();
  // One a second: enough to heckle, not enough to wallpaper the table.
  if (now - view.lastReactAt < 1000) return;
  view.lastReactAt = now;
  sfx.tap();

  // In a dealt game the dealer owns the feed, so reactions travel as intents.
  // In scorekeeping the room is a shared object, so they're just small writes —
  // old clients ignore the subtree, and stale ones are pruned as we go.
  if (store.isDealt) {
    store.intent({ do: 'react', emoji });
    return;
  }
  const paths = { [`reactions/${makeId()}`]: { who: store.actingId ?? store.myId, emoji, at: now } };
  for (const [k, r] of Object.entries(store.state?.reactions ?? {})) {
    if (now - (r.at ?? 0) > 15_000) paths[`reactions/${k}`] = null;
  }
  store.update(paths);
}

/** Scorekeeping reactions arrive as room writes; float each one exactly once. */
function renderReactions(state) {
  if (store.isDealt) return; // dealt-mode reactions arrive through the feed
  const all = Object.entries(state.reactions ?? {});
  if (!view.seenReactions) {
    // Don't replay whatever happened before we joined or reconnected.
    view.seenReactions = new Set(all.map(([k]) => k));
    return;
  }
  for (const [k, r] of all) {
    if (view.seenReactions.has(k)) continue;
    view.seenReactions.add(k);
    if (Date.now() - (r.at ?? 0) < 8000) floatReaction(r.who, r.emoji);
  }
}

/** The emoji drifts up from the sender's row, so you can see who said it. */
function floatReaction(playerId, emoji) {
  if (!REACTIONS.includes(emoji)) return;
  const anchor = document.querySelector(`.stand[data-player="${playerId}"]`) ?? $('standings');
  const box = anchor?.getBoundingClientRect?.();
  if (!box || !box.width) return;
  const el = document.createElement('span');
  el.className = 'react-float';
  el.textContent = emoji;
  el.style.left = `${Math.round(box.left + box.width * 0.7)}px`;
  el.style.top = `${Math.round(box.top)}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1600 * speedFactor());
}

// ── table chat ────────────────────────────────────────────────────────────

/** Wire the chat sheet: send on button or Enter. The 💬 button is built above. */
function buildChat() {
  $('chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
}

const chatOpen = () => !$('modal-chat').hidden;

function openChat() {
  sfx.tap();
  view.chatUnread = 0;
  paintChatBadge();
  renderChat(store.state);
  openModal('chat');
  $('chat-input').focus();
}

function paintChatBadge() {
  const badge = $('chat-badge');
  badge.hidden = !view.chatUnread;
  badge.textContent = view.chatUnread > 9 ? '9+' : String(view.chatUnread);
}

function sendChat() {
  const input = $('chat-input');
  const text = cleanChat(input.value);
  if (!text) return;
  const now = Date.now();
  // Same politeness budget as reactions: one a second.
  if (now - view.lastChatAt < 1000) return;
  view.lastChatAt = now;
  input.value = '';

  // Same two pipes as reactions: an intent when the dealer owns the feed, a
  // small pruned write when the room is a shared object. Our own message comes
  // back through the same watch as everyone else's, so there's one code path.
  if (store.isDealt) {
    store.intent({ do: 'chat', text });
    return;
  }
  const who = store.actingId ?? store.myId;
  const paths = { [`chat/${makeId()}`]: { who, msg: text, at: now } };
  const all = Object.entries(store.state?.chat ?? {}).sort(
    (a, b) => (a[1].at ?? 0) - (b[1].at ?? 0),
  );
  // Keep the room small: everything beyond the last 30 messages goes.
  for (const [k] of all.slice(0, Math.max(0, all.length - 29))) paths[`chat/${k}`] = null;
  store.update(paths);
}

/** Every message, oldest first, from whichever pipe this room uses. */
function chatMessages(state) {
  if (store.isDealt) {
    return (state.feed ?? [])
      .filter((l) => l.type === 'chat')
      .map((l) => ({ id: `n${l.n}`, who: l.who, msg: l.msg ?? l.text, at: l.at ?? 0 }));
  }
  return Object.entries(state.chat ?? {})
    .map(([k, c]) => ({ id: k, who: c.who, msg: c.msg, at: c.at ?? 0 }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Fill the sheet: monogram, name, message — newest at the bottom, in view. */
function renderChat(state) {
  if (!state) return;
  const host = $('chat-list');
  const messages = chatMessages(state);
  host.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('li');
    empty.className = 'chat__empty';
    empty.textContent = 'Nothing yet — say something.';
    host.append(empty);
    return;
  }
  for (const m of messages) {
    const player = state.players?.[m.who];
    const li = document.createElement('li');
    li.className = 'chat__line';
    if (m.who === store.actingId) li.classList.add('is-mine');
    const name = document.createElement('b');
    name.className = 'chat__name';
    name.append(monogram(player?.name ?? '?', player?.order ?? 0), document.createTextNode(player?.name ?? 'Someone'));
    const text = document.createElement('span');
    text.className = 'chat__msg';
    text.textContent = m.msg ?? '';
    li.append(name, text);
    host.append(li);
  }
  host.scrollTop = host.scrollHeight;
}

/**
 * A message arriving, from either pipe. Sheet open: the list refreshes. Sheet
 * closed: somebody else's message becomes a toast and a badge tick, so table
 * talk is noticeable without stealing the screen from the game.
 */
function incomingChat(state, who, msg) {
  if (chatOpen()) {
    renderChat(state);
    return;
  }
  if (who === store.actingId || !msg) return;
  view.chatUnread += 1;
  paintChatBadge();
  const name = state.players?.[who]?.name ?? 'Someone';
  toast(`${name}: ${msg}`, 2600);
  sfx.count();
  buzz(10);
}

/** Scorekeeping chat arrives as room writes; surface each exactly once. */
function renderChatWrites(state) {
  if (store.isDealt) return; // dealt-mode chat arrives through the feed
  const all = Object.keys(state.chat ?? {});
  if (!view.seenChat) {
    // Don't replay the backlog on join — it's all in the sheet already.
    view.seenChat = new Set(all);
    return;
  }
  for (const k of all) {
    if (view.seenChat.has(k)) continue;
    view.seenChat.add(k);
    const m = state.chat[k];
    incomingChat(state, m?.who, m?.msg);
  }
}

// ── reacting to state ─────────────────────────────────────────────────────

function onState(state) {
  if (!state) return;

  $('room-code').textContent = state.code ?? '····';
  $('room-meta').textContent = state.lobby
    ? `taking seats · to ${state.target}`
    : `round ${state.round} · to ${state.target}`;
  renderConnection();
  scorer.render();

  // Reactions and chat make sense once there's a table to talk to — the tray
  // shows from the lobby on, so people can chat while seats fill.
  $('react-tray').hidden = playerList(state).length < 2;
  renderReactions(state);
  renderChatWrites(state);
  if (chatOpen()) renderChat(state);

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

  announceGamePoint(state);

  // The roll call for the next game, live while the winner screen is up.
  if (state.status === 'finished') renderOverReady(state);
  // A new game started under the winner screen: take it down everywhere, let
  // the next finish announce itself even if the same player wins again, and
  // reset the game-point memory — the new game reuses round numbers.
  if (state.status === 'playing' && view.shownWinner) {
    view.shownWinner = null;
    view.gamePointSeen = null;
    closeModal($('modal-over'));
  }
}

/**
 * Game point: somebody's banked total plus what they're holding has crossed
 * the target — if the round ends now, they win the game. That changes what
 * every other hand at the table should be doing, so it gets one loud banner
 * per player per round, plus the persistent chip on the standings (scorer.js).
 */
function announceGamePoint(state) {
  if (!state.target || state.lobby || state.status !== 'playing' || state.roundOver) return;
  for (const p of playerList(state)) {
    const live = (p.total ?? 0) + roundScore(p.hand);
    if (live < state.target) continue;
    const key = `${state.round}:${p.id}`;
    view.gamePointSeen ??= new Set();
    if (view.gamePointSeen.has(key)) continue;
    view.gamePointSeen.add(key);

    const mine = p.id === store.actingId;
    sfx.count();
    buzz([20, 40, 20]);
    showBanner(mine ? 'You can win this round' : `${p.name} can win this round`, {
      tone: 'flip7',
      sub: `${live} if it holds — past ${state.target}. Bank big or beat it.`,
      ms: 1900,
    });
    announce(`${mine ? 'You' : p.name} can win this round with ${live}.`);
    break; // one banner per render; any others announce on the next state
  }
}

/**
 * "Who's in for another?" — the winner screen doubles as the next game's
 * roll call in online dealt rooms. Everyone toggles themselves; the host's
 * start button counts heads (their own tap counts them in, bots are always
 * game) and only unlocks with a table worth dealing to.
 */
function renderOverReady(state) {
  const ready = $('btn-ready');
  const line = $('over-ready');
  if (!store.isDealt || !store.isOnline) {
    ready.hidden = true;
    line.hidden = true;
    return;
  }

  const me = state.players?.[store.myId];
  const humans = playerList(state).filter((p) => !p.isBot);
  const inFor = playerList(state).filter(
    (p) => p.isBot || p.ready || p.id === state.hostId,
  ).length;

  ready.hidden = !me;
  ready.textContent = me?.ready ? "You're in — tap to step out" : "I'm in for another";
  ready.classList.toggle('is-ready', !!me?.ready);
  // The host's start is their opt-in, so their toggle would be redundant.
  if (store.isHost) ready.hidden = true;

  const readyCount = humans.filter((p) => p.ready || p.id === state.hostId).length;
  line.hidden = false;
  line.textContent =
    `${readyCount} of ${humans.length} in for the next game` +
    (store.isHost ? '' : ` — ${state.players?.[state.hostId]?.name ?? 'the host'} starts it`);

  if (store.isHost) {
    $('btn-rematch').textContent = `Start the next game (${inFor} in)`;
    $('btn-rematch').disabled = inFor < 2;
  }
}

/**
 * The pill under the room code that says whether the relay can hear us. It
 * shows nothing while everything is fine — the steady state deserves no chrome
 * — turns "Reconnecting…" the moment the socket drops, and flashes a brief
 * "Back online" when it returns, so a quiet table reads as quiet rather than
 * broken.
 */
function renderConnection() {
  const conn = store.isOnline ? store.connection : 'online';
  if (conn === view.lastConn) return;
  const wasOffline = view.lastConn === 'offline';
  view.lastConn = conn;

  const pill = $('conn-pill');
  clearTimeout(view.connTimer);
  if (conn === 'offline') {
    pill.hidden = false;
    pill.dataset.tone = 'off';
    pill.textContent = 'Reconnecting…';
    announce('Connection lost — reconnecting.');
  } else if (wasOffline) {
    pill.hidden = false;
    pill.dataset.tone = 'on';
    pill.textContent = 'Back online';
    announce('Back online.');
    view.connTimer = setTimeout(() => {
      pill.hidden = true;
    }, 2000);
  } else {
    pill.hidden = true;
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
  // In scorekeeping mode the scorer decides who sees the waiting line — it
  // knows about the vanished-host takeover; here it only needs hiding for dealt.
  if (dealt) $('waiting').hidden = true;
  if (!dealt) {
    setHeartbeat(null);
    $('stall').hidden = true;
    return;
  }

  const me = state.players?.[store.actingId];
  const myTurn = state.turnId === store.actingId;
  const pending = state.pending;
  const mineToTarget = pending?.byId === store.actingId;
  const over = state.status === 'finished' || state.roundOver;

  // The same button opens the game from the lobby and turns each round over, so
  // there's one place the host looks for "deal".
  const seats = playerList(state).length;
  const canDeal = (state.lobby || state.roundOver) && store.isHost && state.status !== 'finished';
  const actions = $('dealt-actions');
  const showActions = myTurn && !pending;
  // Visible the instant the turn is, but inert for a beat: a tap already on its
  // way down toward where the buttons weren't must not hit one.
  if (showActions && actions.hidden) armActions(actions);
  actions.hidden = !showActions;
  // While the wire is down the dealer can't hear us: gameplay taps go inert
  // rather than silently queueing a hit somebody no longer means.
  const offline = store.isOnline && store.connection === 'offline';
  $('btn-dhit').disabled = offline;
  $('btn-dstay').disabled = offline;
  $('btn-deal-next').hidden = !canDeal;
  if (canDeal) {
    // Dealing to a table of one would deal the host a hand and end the round.
    $('btn-deal-next').disabled = (state.lobby && seats < 2) || offline;
    $('btn-deal-next').textContent = state.lobby
      ? `Deal the first round (${seats} in)`
      : 'Deal the next round';
  }

  // Six cards is the brink: the Hit button stops being a button and becomes the
  // dare. The restyle is presentation only — the arming guard still applies.
  const hitBtn = $('btn-dhit');
  const atSix = (me?.hand?.numbers?.length ?? 0) === 6 && me?.state === 'active';
  hitBtn.classList.toggle('is-seven', atSix && myTurn && !pending);
  if (myTurn && !pending) {
    const hand = me?.hand ?? { numbers: [] };
    // Say the number you'd bank, not just "stay" — it's the whole decision.
    $('dstay-sub').textContent = `bank ${roundScoreOf(me)}`;
    hitBtn.querySelector('.btn__label').textContent = atSix ? 'Flip for the 7' : 'Hit';
    $('dhit-sub').textContent = atSix
      ? 'one card from +15'
      : hand.chance
        ? 'shielded'
        : 'one more card';
  }

  // Five cards deep with the decision live, a low heartbeat runs under the
  // round, quickening with the odds. Bank, bust or lose the turn and it stops
  // dead. Runs through the sound switch like every other noise.
  const heartCards = me?.hand?.numbers?.length ?? 0;
  if (settings.sound && myTurn && !pending && !over && me?.state === 'active' && heartCards >= 5) {
    setHeartbeat(bustChance(state, store.actingId));
  } else {
    setHeartbeat(null);
  }

  // On the bench: seated, watching, one tap from being dealt back in.
  $('btn-dealin').hidden = !(me?.benched && !state.lobby && state.status !== 'finished');

  renderPress(state, { me, myTurn, pending, over });

  // One attribute drives every "it's on you now" cue in the CSS, so the status
  // pill, the hand and the buttons can't disagree about whose turn it is.
  $('dealt').dataset.turn = mineToTarget ? 'aim' : myTurn ? 'mine' : over ? 'over' : 'theirs';

  renderAim(state, mineToTarget);
  renderSpectate(state);

  renderDeck(state, over);

  $('dealt-status').textContent = dealtStatus(state, {
    myTurn,
    pending,
    mineToTarget,
    over,
    waiting: !!me?.waiting,
    benched: !!me?.benched,
  });
  renderStall(state, over);
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

  // An armed target turns the panel into the confirmation step.
  const armed = scorer.armedTargetId ? state.players?.[scorer.armedTargetId]?.name : null;
  if (armed) {
    $('aim-text').textContent = {
      freeze: `Freeze ${armed}? Tap their name once more to confirm — or tap someone else.`,
      flip3: `Make ${armed} flip three? Tap their name once more to confirm — or tap someone else.`,
      gift: `Give ${armed} the Second Chance? Tap their name once more to confirm — or tap someone else.`,
    }[pending.action];
    return;
  }

  const targets = pending.targets.length;
  const only = targets === 1 ? state.players?.[pending.targets[0]]?.name : null;
  $('aim-text').textContent = {
    freeze: only
      ? `You drew Freeze. ${only} is the only one left — tap their name on the scoreboard above.`
      : 'You drew Freeze. Tap a name on the scoreboard above to make them bank and sit out.',
    flip3: only
      ? `You drew Flip Three. Tap ${only} on the scoreboard above to make them flip three cards.`
      : 'You drew Flip Three. Tap a name on the scoreboard above to make them flip three cards.',
    gift: only
      ? `A second Second Chance — tap ${only} on the scoreboard above to give it to them.`
      : 'A second Second Chance. Tap a name on the scoreboard above to give it away.',
  }[pending.action];
}

/**
 * Somebody else is playing and every card in Flip 7 is face up — so show their
 * hand rather than making spectators read the feed backwards: a compact strip
 * of the cards they're holding, what they'd bank, and their live bust odds.
 */
function renderSpectate(state) {
  const host = $('spectate');
  const live = !state.lobby && !state.roundOver && state.status !== 'finished';
  // Follow whoever the table is waiting on; between automatic steps (deals,
  // resolving actions) keep the last player rather than flickering away.
  let focusId = live ? (state.pending?.byId ?? state.turnId ?? view.spectateId) : null;
  if (focusId === store.actingId) focusId = null;
  const watched = focusId ? state.players?.[focusId] : null;
  view.spectateId = watched ? focusId : null;
  host.hidden = !watched;
  if (!watched) {
    delete host.dataset.key;
    return;
  }

  const hand = watched.hand ?? {};
  const numbers = hand.numbers ?? [];
  const mods = hand.mods ?? [];
  const risk = bustChance(state, focusId);

  const who = $('spectate-who');
  who.replaceChildren(
    monogram(watched.name, watched.order ?? 0),
    document.createTextNode(
      `${watched.name} — ${hand.busted ? 'busted' : `holding ${roundScoreOf(watched)}`}`,
    ),
  );
  const stat = $('spectate-stat');
  // A live press is the whole table's sweat, so the strip says so.
  const pressing = watched.bet ? ` · pressing ${watched.bet.wager}` : '';
  stat.textContent = hand.busted
    ? ''
    : hand.chance
      ? `shielded${pressing}`
      : `${Math.round(risk * 100)}% bust${pressing}`;
  stat.dataset.band = hand.busted || hand.chance ? 'safe' : riskBand(risk);

  // Rebuild the cards only when the hand actually changes, so the strip doesn't
  // churn on every heartbeat.
  const key = [
    focusId,
    numbers.join(','),
    mods.map((m) => `${m.op}${m.value}`).join(','),
    hand.chance ? 'c' : '',
    hand.bustCard ? 'k' : '',
  ].join('|');
  if (host.dataset.key === key) return;
  host.dataset.key = key;

  // Cards landing in the strip get the same deck-flip the player's own hand
  // gets — spectating should look like watching cards being dealt, not like a
  // list updating. Only growth since the last paint of *this* hand animates,
  // so starting to watch mid-hand doesn't replay it.
  const prev =
    view.spectateSeen?.id === focusId && view.spectateSeen.round === state.round
      ? view.spectateSeen
      : null;
  view.spectateSeen = {
    id: focusId,
    round: state.round,
    n: numbers.length,
    m: mods.length,
    c: hand.chance ? 1 : 0,
  };
  const deck = $('deck');
  let arriving = 0;
  const flipIn = (card) => dealFrom(card, deck, arriving++ * 200 * speedFactor());

  const cards = $('spectate-cards');
  cards.replaceChildren();
  numbers.forEach((v, i) => {
    const card = createCard({ kind: 'number', value: v });
    if (hand.busted) card.classList.add('is-spent');
    if (hand.bustCard?.kind === 'number' && hand.bustCard.value === v) card.classList.add('is-clash');
    cards.append(card);
    if (prev && i >= prev.n) flipIn(card);
  });
  mods.forEach((m, i) => {
    const card = createCard({ kind: 'modifier', op: m.op, value: m.value });
    cards.append(card);
    if (prev && i >= prev.m) flipIn(card);
  });
  if (hand.chance) {
    const card = createCard({ kind: 'action', action: 'chance' });
    cards.append(card);
    if (prev && !prev.c) flipIn(card);
  }
  if (hand.bustCard) {
    const killer = createCard(hand.bustCard);
    killer.classList.add('is-killer');
    cards.append(killer);
  }
}

/**
 * The Press bet row (house rule, host-enabled): before a hit, stake points that
 * the next card won't bust you. Each chip shows exactly what surviving pays at
 * the odds you're taking right now — the dealer prices the bet from the same
 * deck count, so the preview is the contract. One press per round.
 */
function renderPress(state, { me, myTurn, pending, over }) {
  const host = $('press');
  const label = $('press-label');
  const chipsHost = $('press-chips');

  // From the rail: out of the round, backing a horse. The tap itself happens
  // on the scoreboard (scorer.js); this row is the standing invitation and,
  // once placed, the ticket.
  const railTicket = me?.railbird ?? null;
  const railOpen = canRailbird(state, store.actingId);
  if (!myTurn && !over && (railOpen || (railTicket && !state.roundOver))) {
    host.hidden = false;
    chipsHost.replaceChildren();
    if (railTicket) {
      host.dataset.armed = '';
      const horse = state.players?.[railTicket.targetId]?.name ?? 'your horse';
      label.textContent = `${railTicket.stake} on ${horse} to top the round — pays +${railTicket.payout}`;
    } else {
      delete host.dataset.armed;
      label.textContent = "You're out — back a horse: tap a live player (5 ⇢ +10)";
    }
    return;
  }

  const risk = myTurn ? bustChance(state, store.actingId) : 0;
  const bet = me?.bet ?? null;
  const idle =
    state.pressBets === true &&
    myTurn &&
    !pending &&
    !over &&
    me?.state === 'active' &&
    !me?.waiting;
  // No funds gate: totals can go negative, so round one can press too. Only a
  // hand with real bust odds has anything to bet on.
  const canPress = idle && risk > 0 && risk < 1;
  host.hidden = !(idle && (bet || canPress));
  if (host.hidden) return;

  // Two lines of plain words: what this is, and what a chip buys you.
  const say = (main, sub) => {
    const strong = document.createElement('span');
    strong.textContent = main;
    const small = document.createElement('small');
    small.textContent = sub;
    label.replaceChildren(strong, small);
  };

  if (bet) {
    host.dataset.armed = '';
    say(
      `${bet.wager} says this card won't bust you`,
      `it rides on your very next card — survive and collect +${bet.payout}`,
    );
    chipsHost.replaceChildren();
    return;
  }

  delete host.dataset.armed;
  const pct = Math.round(risk * 100);
  say(
    'Press bet: survive your next card?',
    `${pct}% bust odds — win the gold number, or the stake comes off your score`,
  );
  chipsHost.replaceChildren();
  for (const wager of [5, 10, 15]) {
    const btn = document.createElement('button');
    btn.className = 'press__chip';
    btn.type = 'button';
    const payout = Math.max(1, Math.ceil((wager * risk) / (1 - risk)));
    btn.textContent = `${wager} ⇢ +${payout}`;
    btn.title = `Risk ${wager}, win ${payout}`;
    btn.setAttribute(
      'aria-label',
      `Press ${wager} points — pays ${payout} if the next card doesn't bust you, costs ${wager} if it does`,
    );
    btn.addEventListener('click', () => {
      sfx.modifier();
      store.intent({ do: 'bet', wager });
    });
    chipsHost.append(btn);
  }
}

/**
 * The deck itself: a face-down mini card with a live count. The deck is public
 * arithmetic — every card is dealt face up — so show it rather than making
 * people count the feed. Deal-in flips originate from this element, it nudges
 * each time a card comes off it, and it riffles when the discard shuffles back.
 */
function renderDeck(state, over) {
  const row = $('deck-row');
  const show = !state.lobby && typeof state.deckLeft === 'number' && !over;
  row.hidden = !show;
  if (!show) {
    view.lastDeckLeft = null;
    return;
  }

  const count = $('deck-count');
  count.textContent = `${state.deckLeft} ${state.deckLeft === 1 ? 'card' : 'cards'} left`;

  if (view.lastDeckLeft !== null && state.deckLeft < view.lastDeckLeft) {
    const deck = $('deck');
    // Remove-and-reflow so back-to-back deals each get their own nudge.
    deck.classList.remove('is-push');
    count.classList.remove('is-counting');
    void deck.offsetWidth;
    deck.classList.add('is-push');
    count.classList.add('is-counting');
  }
  view.lastDeckLeft = state.deckLeft;
}

/** The reshuffle, made physical: a quick riffle and its sound. */
function riffleDeck() {
  sfx.riffle();
  const deck = $('deck');
  if ($('deck-row').hidden) return;
  deck.classList.remove('is-riffle');
  void deck.offsetWidth;
  deck.classList.add('is-riffle');
}

/**
 * The host's controls for a stuck turn. Shown only while the dealer is waiting
 * on a person whose phone has gone quiet — the dealer will bank that hand by
 * itself after its timer, but the host shouldn't have to explain that to a
 * table of people staring at "Dana is playing…".
 */
function renderStall(state, over) {
  const row = $('stall');
  const waitedOnId = state.pending?.byId ?? state.turnId ?? null;
  const waitedOn = waitedOnId ? state.players?.[waitedOnId] : null;
  const show =
    store.isHost &&
    store.isOnline &&
    !over &&
    !state.lobby &&
    !!waitedOn &&
    !waitedOn.isBot &&
    waitedOnId !== store.myId &&
    isAway(waitedOn);
  row.hidden = !show;
  if (!show) return;
  $('stall-note').textContent = `${waitedOn.name} lost connection`;
  $('btn-stall-skip').textContent = state.pending
    ? 'Play their card'
    : `Bank their ${roundScoreOf(waitedOn)}`;
  row.dataset.target = waitedOnId;
}

/** Hit and Stay: on screen at once, tappable a beat later. */
function armActions(el) {
  el.dataset.arming = '';
  clearTimeout(view.armTimer);
  view.armTimer = setTimeout(() => {
    delete el.dataset.arming;
  }, 400);
}

function actionsArming() {
  return $('dealt-actions').dataset.arming !== undefined;
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

    // Table-wide beats first — these aren't aimed at anyone in particular.
    if (line.type === 'react') {
      floatReaction(line.who, line.emoji);
      continue;
    }
    if (line.type === 'chat') {
      incomingChat(state, line.who, line.msg ?? '');
      continue;
    }
    if (line.type === 'reshuffle') {
      riffleDeck();
      continue;
    }
    if (line.type === 'railbird-won' && line.who === store.actingId) {
      // Round-end beat: the summary modal is opening, so this rides as a toast.
      sfx.save();
      buzz([15, 30, 15]);
      toast(`Your horse came in — +${line.payout} from the rail`, 2600);
      continue;
    }
    if (line.type === 'railbird-lost' && line.who === store.actingId) {
      sfx.error();
      toast(`Your ${line.stake} on ${state.players?.[line.to]?.name ?? 'them'} is gone`, 2400);
      continue;
    }
    if (line.type === 'bust' && line.who !== store.actingId) {
      // Somebody else went down: a muted thud, and their row flickers red.
      // The class lives on the scorer so re-renders don't wipe it mid-flash.
      sfx.thud();
      scorer.flicker = { id: line.who, until: Date.now() + 700 };
      scorer.render();
    }

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
      // The duplicate lands and both copies are already ringed on your hand.
      // Then, for a beat, nothing — the silence is the dread. Then the verdict,
      // with the card that did it: being told only "busted" leaves you
      // wondering which duplicate landed.
      (async () => {
        await wait(400);
        sfx.bust();
        buzz([60, 40, 90]);
        showBanner('Busted', {
          tone: 'bust',
          sub: `${cardName(line.card)} — you already had one, so this round scores 0`,
          ms: 1800,
          card,
        });
      })();
    } else if (line.type === 'stay' && self) {
      sfx.stay();
      showBanner(`Banked ${line.score ?? 0}`, {
        tone: 'save',
        sub: "you're safe — sit tight until the round ends",
        ms: 1300,
      });
    } else if (line.type === 'stall' && self) {
      // You come back from a tunnel to find your hand banked. Say who did it —
      // the dealer, not a person — and that nothing was lost.
      showBanner('While you were away', {
        tone: 'freeze',
        sub:
          line.score === undefined
            ? 'the dealer played your card for you'
            : `the dealer banked ${line.score} for you`,
        ms: 1800,
      });
    } else if (line.type === 'bet-won' && self) {
      sfx.save();
      buzz([15, 30, 15]);
      showBanner(`Press pays +${line.payout}`, {
        tone: 'save',
        sub: `you pressed ${line.wager} and the card came good`,
        ms: 1300,
      });
    } else if (line.type === 'bet-lost' && self) {
      // The bust banner owns the screen; the lost press rides under it.
      toast(`Your press is gone too — that's another ${line.wager}`, 2600);
    } else if (line.type === 'second-chance' && self) {
      // The shield-break beat: the duplicate hits the shield, the shield
      // shatters, and the save is quantified — the number it just kept alive.
      sfx.shield();
      buzz([20, 40, 20]);
      const saved = roundScoreOf(state.players?.[store.actingId]);
      const shield = createCard({ kind: 'action', action: 'chance' });
      shield.classList.add('is-shatter');
      burstFrom($('hand-card'), { count: 24, power: 9, colors: ['#2ed6ad', '#66d97a', '#7ff0b6'] });
      showBanner('Second Chance!', {
        tone: 'save',
        sub: `${cardName(line.card)} bounced off your shield — that would've cost you ${saved}`,
        ms: 1700,
        card: shield,
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

function dealtStatus(state, { myTurn, pending, mineToTarget, over, waiting, benched }) {
  const name = (id) => state.players?.[id]?.name ?? 'someone';

  if (state.status === 'finished') return 'Game over.';
  // Benched: didn't ready up for this game, watching from a kept seat.
  if (benched && !state.lobby) return "You're sitting this game out — deal in whenever you like.";
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
  // than only naming whoever is playing. A player whose phone has gone quiet is
  // named as offline, not "playing" — the dealer will move past them shortly.
  const mine = state.players?.[store.actingId];
  const up = state.turnId ? state.players?.[state.turnId] : null;
  const playing = state.turnId
    ? up && !up.isBot && state.turnId !== store.actingId && store.isOnline && isAway(up)
      ? `${name(state.turnId)} lost connection — hang on…`
      : `${name(state.turnId)} is playing…`
    : 'Dealing…';
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

async function showRoundSummary(last) {
  const state = store.state;
  const results = last.results ?? [];
  $('round-title').textContent = `Round ${last.round}`;

  // The round's stories, computed from before/after totals: a lead change gets
  // named and its row pulsed gold; the biggest score coming from the bottom
  // half of the table gets called a comeback.
  const before = results.map((r) => ({
    id: r.id,
    total: (r.total ?? 0) - (r.delta ?? 0) - (r.bet ?? 0),
  }));
  const prevBest = Math.max(0, ...before.map((r) => r.total));
  const prevLeaders = new Set(
    before.filter((r) => r.total === prevBest && prevBest > 0).map((r) => r.id),
  );
  const best = Math.max(0, ...results.map((r) => r.total ?? 0));
  const leaders = results.filter((r) => (r.total ?? 0) === best && best > 0);
  const newLeader =
    leaders.length === 1 && prevLeaders.size > 0 && !prevLeaders.has(leaders[0].id)
      ? leaders[0]
      : null;

  const bottomHalf = new Set(
    [...before]
      .sort((a, b) => a.total - b.total)
      .slice(0, Math.floor(before.length / 2))
      .map((r) => r.id),
  );
  const bestDelta = [...results].sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
  const comebackId =
    results.length >= 3 && bestDelta && (bestDelta.delta ?? 0) > 0 && bottomHalf.has(bestDelta.id)
      ? bestDelta.id
      : null;

  // Level at the finish line means one more round, exactly like the card game —
  // but silently dealing it looks like the app ignored the target. Say so.
  const tied = tiedLeaders(results, state.target);
  const note = $('round-note');
  note.hidden = !tied && !newLeader;
  if (tied) {
    const names = andList(tied.map((t) => t.name));
    note.textContent = `${names} tied at ${tied[0].total} — one more round decides it.`;
    announce(note.textContent);
  } else if (newLeader) {
    note.textContent = `${newLeader.name} takes the lead.`;
    announce(note.textContent);
  }

  // Only the host's tap actually deals; pretending otherwise teaches everyone
  // else that the button is broken.
  const hostName = state.players?.[state.hostId]?.name ?? 'the host';
  $('btn-next-round').textContent = store.isDealt
    ? store.isHost
      ? `Deal round ${last.round + 1}`
      : `Close — waiting for ${hostName} to deal`
    : `Start round ${last.round + 1}`;

  // A Flip 7 owns the screen for a beat before the paperwork covers it.
  if (results.some((r) => r.flip7)) await wait(2400);
  // The tie gets its beat before the scores cover it.
  if (tied) {
    await showBanner(`Tied at ${tied[0].total}`, {
      sub: 'one more round decides it',
      ms: 1500,
    });
  }

  // Filled after the waits so the totals count up while the modal is on screen.
  fillScores(
    $('round-scores'),
    results.map((r) => ({
      name: r.name,
      seat: state.players?.[r.id]?.order,
      delta: r.delta,
      total: r.total,
      busted: r.busted,
      lead: newLeader?.id === r.id,
      from: (r.total ?? 0) - (r.delta ?? 0) - (r.bet ?? 0),
      note: [noteFor(r), r.id === comebackId ? 'comeback' : ''].filter(Boolean).join(' · '),
    })),
    state.target,
    { countUp: true },
  );
  openModal('round');
  sfx.count();
}

/** "Sam", "Sam and Dana", "Sam, Dana and Rex". */
function andList(names) {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

async function showWinner(state) {
  const winner = state.players?.[state.winnerId];
  if (!winner) return;
  const mine = state.winnerId === store.myId;

  // A game won on a Flip 7 gets its jackpot beat before the paperwork.
  if ((state.lastRound?.results ?? []).some((r) => r.flip7)) await wait(2400);

  $('over-title').textContent = mine ? 'You win!' : `${winner.name} wins`;
  $('over-sub').textContent = `${winner.total} points in ${(state.round ?? 2) - 1} rounds.`;
  // Bars fill in rank order — a little podium ceremony for the final table.
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
    { countUp: true, stagger: true },
  );

  $('btn-rematch').hidden = !store.isHost;
  closeModal($('modal-round'));
  openModal('over');
  // Everyone's evening ends on confetti — somebody at the table won, and the
  // fanfare (or the descending shrug) says whether it was you.
  celebrate({ count: mine ? 170 : 110 });
  if (mine) {
    sfx.win();
    buzz([40, 60, 40, 60, 120]);
  } else {
    sfx.lose();
  }
  announce(`${winner.name} wins with ${winner.total}`);
}

function noteFor(result) {
  const press = result.bet
    ? result.bet > 0
      ? `pressed +${result.bet}`
      : `pressed −${-result.bet}`
    : '';
  if (result.busted) return ['busted', press].filter(Boolean).join(' · ');
  if (result.flip7) return ['Flip 7 · +15', press].filter(Boolean).join(' · ');
  const bits = [];
  if (result.doubled) bits.push('×2');
  if (result.addMods?.length) bits.push(result.addMods.map((v) => `+${v}`).join(' '));
  if (press) bits.push(press);
  return bits.join(' · ');
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
    try {
      await store.addPlayer(row.name.trim() || 'Player');
    } catch (err) {
      // A name already being actively played can't just be absorbed.
      if (err?.code === 'seat-active') {
        toast(`${row.name.trim()} is already playing — pick another name`);
      } else {
        toast(err?.message ?? 'Could not add that player');
      }
    }
  }

  closeModal($('modal-players'));
  sfx.tap();
}

boot();
