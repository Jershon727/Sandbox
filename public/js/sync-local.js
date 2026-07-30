/**
 * Same-device backend.
 *
 * Rooms live in localStorage and changes are announced over a BroadcastChannel,
 * so every tab on this device stays in step. Two jobs:
 *
 *   1. "Just this device" mode — one phone keeping score for the whole table.
 *   2. It implements the same interface as the Firebase backend, so the sync
 *      logic can be tested for real without a network.
 */

import { applyPaths } from './room.js';

const KEY = (code) => `flip7:room:${code}`;
const CHANNEL = (code) => `flip7-room-${code}`;

function readRoom(code) {
  try {
    const raw = localStorage.getItem(KEY(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeRoom(code, room) {
  try {
    localStorage.setItem(KEY(code), JSON.stringify(room));
    return true;
  } catch {
    return false;
  }
}

export function createLocalSync() {
  const channels = new Map();

  const channelFor = (code) => {
    if (!channels.has(code) && typeof BroadcastChannel === 'function') {
      channels.set(code, new BroadcastChannel(CHANNEL(code)));
    }
    return channels.get(code) ?? null;
  };

  return {
    kind: 'local',
    label: 'this device',

    async create(code, room, options) {
      if (options?.kind === 'dealt') {
        // Dealing needs a dealer, and this backend is only a shared notebook.
        throw Object.assign(new Error('Dealt games need the relay'), { code: 'not-supported' });
      }
      if (readRoom(code)) {
        const err = new Error('That code is already in use');
        err.code = 'code-taken';
        throw err;
      }
      writeRoom(code, room);
      return room;
    },

    async join(code, _seat) {
      return readRoom(code);
    },

    watch(code, onChange) {
      const push = () => {
        const room = readRoom(code);
        if (room) onChange(room);
      };

      const bc = channelFor(code);
      bc?.addEventListener('message', push);

      // Fallback for tabs that miss the channel message, and for other windows.
      const onStorage = (e) => {
        if (e.key === KEY(code)) push();
      };
      window.addEventListener('storage', onStorage);

      push();

      return () => {
        bc?.removeEventListener('message', push);
        window.removeEventListener('storage', onStorage);
      };
    },

    async update(code, paths) {
      const current = readRoom(code);
      if (!current) {
        const err = new Error('That game is no longer on this device');
        err.code = 'room-missing';
        throw err;
      }
      const next = applyPaths(current, paths);
      writeRoom(code, next);
      channelFor(code)?.postMessage({ at: Date.now() });
      // Same-tab listeners don't receive their own BroadcastChannel messages.
      window.dispatchEvent(new StorageEvent('storage', { key: KEY(code) }));
      return next;
    },

    async close() {
      for (const bc of channels.values()) bc.close();
      channels.clear();
    },
  };
}
