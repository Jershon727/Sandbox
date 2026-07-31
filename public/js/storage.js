/**
 * localStorage with a shrug.
 *
 * Private browsing and blocked storage should degrade to "preferences don't
 * stick", never to a broken app — so every access is guarded.
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

// ── settings ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  sound: true,
  effects: true,
  advice: true, // bust odds and the hit-or-stay suggestion
  speed: 'normal', // chill | normal | fast
  theme: 'auto', // auto follows the OS until someone picks a side
};

export const settings = { ...DEFAULT_SETTINGS, ...read('settings', {}) };

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  write('settings', settings);
  return settings;
}

/** Resolve 'auto' against the OS preference. */
export function resolvedTheme() {
  if (settings.theme === 'dark' || settings.theme === 'light') return settings.theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const SPEEDS = { chill: 1.45, normal: 1, fast: 0.55 };

export function speedFactor() {
  return SPEEDS[settings.speed] ?? 1;
}

// ── what you chose last time ──────────────────────────────────────────────

const DEFAULT_SETUP = {
  name: '',
  target: 200,
  mode: 'online', // online | local — online whenever a transport is there, see paintHostSetup
  cards: 'real', // real (physical deck, app scores) | dealt (app deals)
  bots: 1,
  botStyle: 'mixed',
};

export const setup = { ...DEFAULT_SETUP, ...read('setup', {}) };

export function saveSetup(patch = {}) {
  Object.assign(setup, patch);
  write('setup', setup);
  return setup;
}
