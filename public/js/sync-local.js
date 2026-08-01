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
import { snapshot, restore, claimSeat } from './dealer.js';
import { createTable, tableFrom, noteFeed, reproject, request, runTable } from './table.js';

const KEY = (code) => `flip7:room:${code}`;
const GAME = (code) => `flip7:game:${code}`;
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

/**
 * A dealt game, dealt by this device.
 *
 * On a plane there is no relay to be the dealer, so the phone is. It runs the
 * exact loop the relay runs (table.js), which is the point of that module: a
 * game dealt at 30,000 feet plays the same as one dealt on a server.
 *
 * The tradeoff is honest rather than hidden: the deck lives in this device's
 * storage, so whoever holds the phone could go looking for it. Against a server
 * that would be cheating; on one shared phone it is only cheating yourself.
 */
function readGame(code) {
  try {
    const raw = localStorage.getItem(GAME(code));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const game = restore(saved.dealt);
    return game ? tableFrom({ code, game, feed: saved.feed, lastRound: saved.lastRound }) : null;
  } catch {
    return null;
  }
}

function writeGame(table) {
  try {
    localStorage.setItem(
      GAME(table.code),
      JSON.stringify({
        dealt: snapshot(table.game),
        feed: table.feed,
        lastRound: table.lastRound,
      }),
    );
  } catch {
    /* storage full or blocked — the game carries on, it just won't survive a reload */
  }
}

export function createLocalSync() {
  const channels = new Map();
  /** The dealt games this tab is running, by code. */
  const tables = new Map();

  const channelFor = (code) => {
    if (!channels.has(code) && typeof BroadcastChannel === 'function') {
      channels.set(code, new BroadcastChannel(CHANNEL(code)));
    }
    return channels.get(code) ?? null;
  };

  /** The dealt game for this code, reloading it from storage after a refresh. */
  const tableAt = (code) => {
    if (tables.has(code)) return tables.get(code);
    const restored = readGame(code);
    if (restored) tables.set(code, restored);
    return restored;
  };

  /** Save the projection where watchers read it, and the game where we do. */
  const publishTable = (table) => {
    writeRoom(table.code, table.room);
    writeGame(table);
    announce(table.code);
  };

  const stoppers = new Map();

  /** Let the dealer get on with it: the opening deal, bot turns, closing out. */
  const drive = (code) => {
    stoppers.get(code)?.();
    const table = tableAt(code);
    if (!table) return;
    stoppers.set(
      code,
      runTable(table, { publish: () => publishTable(table) }),
    );
  };

  const announce = (code) => {
    channelFor(code)?.postMessage({ at: Date.now() });
    // Same-tab listeners don't receive their own BroadcastChannel messages.
    window.dispatchEvent(new StorageEvent('storage', { key: KEY(code) }));
  };

  return {
    kind: 'local',
    label: 'this device',

    async create(code, room, options) {
      if (options?.kind === 'dealt') {
        if (readRoom(code)) {
          throw Object.assign(new Error('That code is already in use'), { code: 'code-taken' });
        }
        const table = createTable({ code, setup: options.setup, deal: false });
        tables.set(code, table);
        publishTable(table);
        drive(code);
        return table.room;
      }
      if (readRoom(code)) {
        const err = new Error('That code is already in use');
        err.code = 'code-taken';
        throw err;
      }
      writeRoom(code, room);
      return room;
    },

    async join(code, seatWanted) {
      const table = tableAt(code);
      if (!table) return readRoom(code);

      // Same rule as the relay: the dealer owns the seating and says which seat
      // it gave you, rather than letting the caller decide.
      if (seatWanted?.id || seatWanted?.name) {
        const seat = claimSeat(table.game, seatWanted);
        if (!seat) throw Object.assign(new Error('That table is full'), { code: 'room-full' });
        // The name matches a seat that is being actively played. Same answer the
        // relay gives: refuse, and let the caller ask whether it's really them.
        if (seat.conflict) {
          const held = table.game.byId(seat.playerId);
          throw Object.assign(new Error(`${held?.name ?? 'That name'} is already playing`), {
            code: 'seat-active',
          });
        }
        if (seat.added) {
          const player = table.game.byId(seat.playerId);
          noteFeed(table, {
            text: seat.late ? `${player.name} joined — dealt in next round.` : `${player.name} joined.`,
            type: 'join',
            who: seat.playerId,
            to: seat.playerId,
            late: seat.late,
          });
        }
        // Only a device claiming a seat is "us" — seating somebody who has no
        // phone must not steal the id this device is playing as.
        if (seatWanted.id) table.seated = seat.playerId;
        reproject(table);
        publishTable(table);
      }
      return table.room;
    },

    /** Which seat the dealer gave this device — see sync-relay's version. */
    seatedAs(code) {
      return tables.get(code)?.seated ?? null;
    },

    /** Ask the dealer for something. Here the dealer is simply next door. */
    async intent(code, playerId, wanted) {
      const table = tableAt(code);
      if (!table) throw Object.assign(new Error('That game has ended'), { code: 'room-missing' });
      const result = request(table, playerId, wanted);
      if (!result.ok) {
        throw Object.assign(new Error('The dealer refused that'), { code: result.why });
      }
      publishTable(table);
      // Reactions and chat only annotate the feed; restarting the loop for
      // them would cut short whatever pause a bot was mid-way through.
      if (wanted?.do !== 'react' && wanted?.do !== 'chat') drive(code);
    },

    watch(code, onChange) {
      // A reload lands here: pick the game back up and let the dealer carry on.
      if (tableAt(code)) drive(code);

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
      // The dealer is the only writer in a dealt game; heartbeats and stray
      // writes are dropped rather than raised, exactly as the relay does.
      if (tableAt(code)) return null;

      const current = readRoom(code);
      if (!current) {
        const err = new Error('That game is no longer on this device');
        err.code = 'room-missing';
        throw err;
      }
      const next = applyPaths(current, paths);
      writeRoom(code, next);
      announce(code);
      return next;
    },

    async close() {
      for (const stop of stoppers.values()) stop();
      stoppers.clear();
      tables.clear();
      for (const bc of channels.values()) bc.close();
      channels.clear();
    },
  };
}
