/**
 * Flip 7 relay — the smallest server that lets phones share a room.
 *
 * It holds each room in memory and forwards path updates to everyone in it. It
 * has no idea what Flip 7 is beyond the merge semantics, which it borrows from
 * the app's own room.js so the server and the browsers can't disagree about
 * what an update means.
 *
 * Run it:   npm run relay          (PORT, default 8787)
 * Deploy:   any host that runs `npm start` on a Node process — Fly, Render,
 *           Railway, a VPS. See README.md → "Running your own relay".
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

import { applyPaths, normalizeCode, CODE_LENGTH } from '../public/js/room.js';
import { claimSeat, snapshot as snapshotGame, restore } from '../public/js/dealer.js';
import {
  createTable,
  tableFrom,
  noteFeed,
  reproject as reprojectTable,
  request as requestOf,
  step as stepTable,
} from '../public/js/table.js';

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Where rooms are kept between restarts. Hosting platforms restart containers,
 * and losing a game halfway through the evening would undo the main reason to
 * run a relay at all. Set ROOM_STORE='' to disable.
 */
const STORE = process.env.ROOM_STORE ?? new URL('../.rooms.json', import.meta.url).pathname;

/**
 * Optionally serve the app itself from this same process, so one deploy gets you
 * both. That also means the page and its relay share an origin, and the client
 * can find the relay without being told where it is — which matters when the
 * only device you have is the phone you're playing on.
 */
const STATIC = process.env.SERVE_STATIC ?? new URL('../public/', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Guard rails, so one bad client can't sink the box. */
const LIMITS = {
  rooms: Number(process.env.MAX_ROOMS ?? 500),
  roomBytes: Number(process.env.MAX_ROOM_BYTES ?? 128 * 1024),
  messageBytes: Number(process.env.MAX_MESSAGE_BYTES ?? 64 * 1024),
  socketsPerRoom: Number(process.env.MAX_SOCKETS_PER_ROOM ?? 16),
  // A game runs for an evening; a room nobody has touched for this long is over.
  idleMs: Number(process.env.ROOM_IDLE_MS ?? 12 * 60 * 60 * 1000),
};

/**
 * code -> { room, sockets, touched, table?, timer? }
 *
 * A scorekeeping room is just `room`, merged from whatever the phones send. A
 * dealt room additionally has `table` — the dealer, from table.js — and `room`
 * becomes a projection of it the phones can only read. That's the whole
 * difference: in one mode the players are the authority, in the other the
 * server is.
 */
const rooms = new Map();
const log = (...args) => console.log(new Date().toISOString(), ...args);

const send = (socket, message) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

const fail = (socket, code, message) => send(socket, { t: 'error', code, message });

function broadcast(entry, except = null) {
  const payload = JSON.stringify({ t: 'state', room: entry.room });
  for (const socket of entry.sockets) {
    if (socket !== except && socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function touch(entry) {
  entry.touched = Date.now();
  schedulePersist();
}

// ── dealt rooms ───────────────────────────────────────────────────────────

/**
 * A dealt room is a table (see table.js) plus the sockets watching it. The loop
 * itself lives there, shared with the browser, so a game dealt by the relay and
 * one dealt by a phone can't drift apart.
 */
function reproject(entry) {
  entry.room = reprojectTable(entry.table);
  touch(entry);
}

/**
 * Let the dealer get on with it: opening deals, bot turns, closing a round. Each
 * step reports how long to wait, which is what gives bots a readable pause
 * instead of a whole round resolving in one frame.
 */
function runDealer(code) {
  const entry = rooms.get(code);
  if (!entry?.table) return;
  clearTimeout(entry.timer);

  const result = stepTable(entry.table);
  entry.room = entry.table.room;
  touch(entry);
  broadcast(entry);

  if (result.delay !== null) {
    entry.timer = setTimeout(() => runDealer(code), result.delay);
    entry.timer.unref?.();
  }
}

// ── keeping rooms across a restart ────────────────────────────────────────

let persistTimer = null;
let persisting = false;

function schedulePersist() {
  if (!STORE || persistTimer) return;
  persistTimer = setTimeout(persist, 1000);
  persistTimer.unref?.();
}

async function persist() {
  persistTimer = null;
  if (!STORE || persisting) return;
  persisting = true;
  try {
    const snapshot = {};
    for (const [code, entry] of rooms) {
      snapshot[code] = entry.table
        ? {
            dealt: snapshotGame(entry.table.game),
            lastRound: entry.table.lastRound,
            feed: entry.table.feed,
            touched: entry.touched,
          }
        : { room: entry.room, touched: entry.touched };
    }
    // Write then rename, so a crash mid-write can't leave a half-file behind.
    const tmp = `${STORE}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot));
    await rename(tmp, STORE);
  } catch (err) {
    log('could not save rooms:', err.message);
  } finally {
    persisting = false;
  }
}

async function restoreRooms() {
  if (!STORE) return;
  try {
    const snapshot = JSON.parse(await readFile(STORE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const [code, saved] of Object.entries(snapshot)) {
      if (now - (saved?.touched ?? 0) > LIMITS.idleMs) continue;

      if (saved.dealt) {
        const game = restore(saved.dealt);
        if (!game) continue;
        const table = tableFrom({
          code,
          game,
          feed: saved.feed ?? [],
          lastRound: saved.lastRound ?? null,
        });
        rooms.set(code, {
          table,
          room: table.room,
          sockets: new Set(),
          touched: saved.touched ?? now,
        });
        loaded += 1;
        continue;
      }

      if (!saved.room) continue;
      rooms.set(code, { room: saved.room, sockets: new Set(), touched: saved.touched ?? now });
      loaded += 1;
    }
    if (loaded) log(`restored ${loaded} room(s) from ${STORE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') log('could not read saved rooms:', err.message);
  }
}

// ── http (health checks and a friendly root) ──────────────────────────────

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');

  if (url.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ok: true, relay: true, rooms: rooms.size }));
    return;
  }

  if (!STATIC) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Flip 7 relay. Connect a WebSocket with ?room=CODE.\n');
    return;
  }

  try {
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let path = join(STATIC, safe);
    const info = await stat(path).catch(() => null);
    if (!info || info.isDirectory()) path = join(STATIC, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      // The app is small and changes when redeployed; don't cache the shell.
      'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// ── websockets ────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: http, maxPayload: LIMITS.messageBytes });

wss.on('connection', (socket, request) => {
  let code = null;
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  try {
    const url = new URL(request.url, 'http://relay');
    code = normalizeCode(url.searchParams.get('room') ?? '');
  } catch {
    code = null;
  }

  if (!code || code.length !== CODE_LENGTH) {
    fail(socket, 'bad-code', `A room code is ${CODE_LENGTH} characters.`);
    socket.close();
    return;
  }

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return fail(socket, 'bad-message', 'Expected JSON.');
    }

    const entry = rooms.get(code);

    if (msg.t === 'create') {
      if (entry) return fail(socket, 'code-taken', 'That code is already in use.');
      if (rooms.size >= LIMITS.rooms) {
        return fail(socket, 'busy', 'This relay is full. Try again in a while.');
      }

      if (msg.kind === 'dealt') {
        const setup = msg.setup ?? {};
        if (!setup.hostId || !setup.hostName) {
          return fail(socket, 'bad-message', 'A dealt game needs a host.');
        }
        // The shuffle is the server's, so nobody can pick their own deck. It
        // waits in a lobby: the host is alone in the room at this instant, and
        // dealing now would make everyone who joins next sit out round one.
        const table = createTable({ code, setup, deal: false });
        const created = {
          table,
          room: table.room,
          sockets: new Set([socket]),
          touched: Date.now(),
        };
        rooms.set(code, created);
        log(`create ${code} dealt (${rooms.size} rooms)`);
        send(socket, { t: 'state', room: created.room });
        runDealer(code);
        return;
      }

      if (!msg.room || typeof msg.room !== 'object') {
        return fail(socket, 'bad-message', 'create needs a room.');
      }
      const created = { room: msg.room, sockets: new Set([socket]), touched: Date.now() };
      rooms.set(code, created);
      log(`create ${code} (${rooms.size} rooms)`);
      schedulePersist();
      send(socket, { t: 'state', room: created.room });
      return;
    }

    if (msg.t === 'join') {
      if (!entry) return fail(socket, 'room-missing', 'No game with that code.');
      if (entry.sockets.size >= LIMITS.socketsPerRoom) {
        return fail(socket, 'room-full', 'That room already has a lot of phones in it.');
      }
      entry.sockets.add(socket);
      touch(entry);

      // In a dealt game the dealer owns the seating, so ask it for a seat and
      // tell the joiner which one it gave them. `you` is the important part: a
      // phone that assumed a different id would drive a seat the dealer has
      // never heard of, and its real seat would never take a turn.
      if (entry.table) {
        let seat = null;
        if (msg.seat?.id || msg.seat?.name) {
          seat = claimSeat(entry.table.game, {
            id: msg.seat.id,
            name: msg.seat.name,
            takeover: msg.seat.takeover === true,
          });
          if (!seat) return fail(socket, 'room-full', 'That table is full.');
          // A seat somebody is actively driving is not handed over on a name
          // match alone — the joiner has to confirm it's really them.
          if (seat.conflict) {
            const held = entry.table.game.byId(seat.playerId);
            return fail(socket, 'seat-active', `${held?.name ?? 'That name'} is already playing.`);
          }
        }

        if (seat?.added) {
          const player = entry.table.game.byId(seat.playerId);
          noteFeed(entry.table, {
            text: seat.late
              ? `${player.name} joined — dealt in next round.`
              : `${player.name} joined.`,
            type: 'join',
            who: seat.playerId,
            to: seat.playerId,
            late: seat.late,
          });
          reproject(entry);
          // Everyone else hears about the arrival; the arrival gets the version
          // that also says which seat is theirs.
          broadcast(entry, socket);
        }

        send(socket, { t: 'state', room: entry.room, you: seat?.playerId ?? null });
        return;
      }

      send(socket, { t: 'state', room: entry.room });
      return;
    }

    if (msg.t === 'intent') {
      if (!entry) return fail(socket, 'room-missing', 'That game has ended.');
      if (!entry.table) return fail(socket, 'not-dealt', 'This room is keeping score, not dealing.');
      if (!entry.sockets.has(socket)) return fail(socket, 'not-joined', 'Join the room first.');
      if (typeof msg.playerId !== 'string') return fail(socket, 'bad-message', 'Who is asking?');

      const result = requestOf(entry.table, msg.playerId, msg.intent);
      if (!result.ok) return fail(socket, result.why, 'The dealer refused that.');
      // A reaction only annotates the feed — stepping the dealer for it would
      // cut short whatever pause a bot was mid-way through.
      if (msg.intent?.do === 'react') {
        entry.room = entry.table.room; // request() already reprojected
        touch(entry);
        broadcast(entry);
        return;
      }
      runDealer(code);
      return;
    }

    if (msg.t === 'update') {
      if (!entry) return fail(socket, 'room-missing', 'That game has ended.');
      // The dealer is the only writer in a dealt game. Heartbeats and stray
      // writes are simply dropped rather than treated as an error, so a client
      // switching modes doesn't spew failures.
      if (entry.table) return;
      if (!entry.sockets.has(socket)) {
        return fail(socket, 'not-joined', 'Join the room before writing to it.');
      }
      if (!msg.paths || typeof msg.paths !== 'object') {
        return fail(socket, 'bad-message', 'update needs paths.');
      }

      let next;
      try {
        next = applyPaths(entry.room, msg.paths);
      } catch {
        return fail(socket, 'bad-message', 'Those paths could not be applied.');
      }

      if (JSON.stringify(next).length > LIMITS.roomBytes) {
        return fail(socket, 'too-big', 'That room has grown too large.');
      }

      entry.room = next;
      touch(entry);
      // Everyone, including the sender: one server-ordered view of the room.
      broadcast(entry);
      return;
    }

    if (msg.t === 'ping') return send(socket, { t: 'pong' });
    fail(socket, 'bad-message', `Unknown message: ${msg.t}`);
  });

  socket.on('close', () => {
    const entry = rooms.get(code);
    if (!entry) return;
    entry.sockets.delete(socket);
    // The room outlives every phone in it — that's the point of having a relay
    // rather than making the host's phone the server. Idle reaping cleans up.
  });

  socket.on('error', () => socket.close());
});

// Drop dead sockets, and rooms nobody has come back to.
const sweep = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }

  const now = Date.now();
  for (const [code, entry] of rooms) {
    if (!entry.sockets.size && now - entry.touched > LIMITS.idleMs) {
      clearTimeout(entry.timer);
      rooms.delete(code);
      log(`reap ${code} (${rooms.size} rooms)`);
      schedulePersist();
    }
  }
}, 30_000);
sweep.unref?.();

http.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another relay running?`);
    process.exit(1);
  }
  throw err;
});

await restoreRooms();
// Resume any dealt game that was mid-turn when we stopped.
for (const [code, entry] of rooms) if (entry.table) runDealer(code);

http.listen(PORT, () => {
  log(
    `Flip 7 relay listening on :${PORT}` +
      `${STATIC ? ` · serving ${STATIC}` : ''}` +
      `${STORE ? ` · rooms saved to ${STORE}` : ''}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('shutting down');
    clearInterval(sweep);
    clearTimeout(persistTimer);
    await persist();
    for (const socket of wss.clients) socket.close(1001, 'relay restarting');
    http.close(() => process.exit(0));
  });
}
