/**
 * localStorage with a shrug.
 *
 * Private browsing and blocked storage should degrade to "settings don't
 * persist", never to a broken game — so every access is guarded.
 */

const PREFIX = 'flip7:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the session still works, it just won't be remembered */
  }
}

function drop(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

// ── settings ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  sound: true,
  effects: true,
  riskMeter: true,
  speed: 'normal', // chill | normal | fast
  theme: 'dark', // dark | light
};

export const settings = { ...DEFAULT_SETTINGS, ...read('settings', {}) };

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  write('settings', settings);
  return settings;
}

export const SPEEDS = { chill: 1.45, normal: 1, fast: 0.55 };

export function speedFactor() {
  return SPEEDS[settings.speed] ?? 1;
}

// ── setup preferences ─────────────────────────────────────────────────────

const DEFAULT_SETUP = { name: 'You', opponents: 3, style: 'mixed', target: 200 };

export const setup = { ...DEFAULT_SETUP, ...read('setup', {}) };

export function saveSetup(patch = {}) {
  Object.assign(setup, patch);
  write('setup', setup);
  return setup;
}

// ── lifetime stats ────────────────────────────────────────────────────────

const DEFAULT_STATS = {
  games: 0,
  wins: 0,
  rounds: 0,
  flip7s: 0,
  busts: 0,
  bestRound: 0,
  bestGame: 0,
};

export const stats = { ...DEFAULT_STATS, ...read('stats', {}) };

export function bumpStat(key, by = 1) {
  stats[key] = (stats[key] ?? 0) + by;
  write('stats', stats);
}

export function recordBest(key, value) {
  if (value > (stats[key] ?? 0)) {
    stats[key] = value;
    write('stats', stats);
  }
}

export function resetStats() {
  Object.assign(stats, DEFAULT_STATS);
  write('stats', stats);
}

// ── score helper session ──────────────────────────────────────────────────
// A real game at a real table can last half an hour. Losing the scores to an
// accidental refresh would be the worst bug this app could have, so the whole
// tally session is persisted on every change.

export function loadTally() {
  return read('tally', null);
}

export function saveTally(session) {
  write('tally', session);
}

export function clearTally() {
  drop('tally');
}
