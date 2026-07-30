/**
 * Relay backend — phones share a room through a small WebSocket server you host.
 *
 * The relay orders every update and echoes the merged room back, so all phones
 * converge on one state rather than each guessing. Same five methods as the
 * other backends, so the app can't tell the difference.
 *
 * Reconnects on its own: a phone that sleeps, loses wifi or wanders out of range
 * rejoins and gets the current room, without anyone tapping anything.
 */

const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * Where the relay lives: the config file, or a per-device override.
 *
 * 'same-origin' means "wherever this page came from", which is what you want
 * when the relay is also serving the app. It saves having to know the deploy's
 * domain, and keeps working if that domain changes.
 */
export function relayUrlFrom(config) {
  let override = null;
  try {
    override = localStorage.getItem('flip7:relay');
  } catch {
    /* storage blocked; the config file still applies */
  }
  const raw = (override || config?.relayUrl || '').trim();
  if (!raw || raw.startsWith('PASTE_')) return '';
  if (raw === 'same-origin') {
    if (typeof location === 'undefined' || !location.host) return '';
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
  }
  return raw;
}

export function hasRelayConfig(config) {
  return /^wss?:\/\/.+/.test(relayUrlFrom(config));
}

/**
 * Is a relay actually there?
 *
 * Config alone isn't proof — 'same-origin' is true of any host, including one
 * that only serves static files. Offering online rooms that then fail to connect
 * is worse than not offering them, so ask first.
 */
export async function probeRelay(config, timeoutMs = 2500) {
  const ws = relayUrlFrom(config);
  if (!ws) return false;
  const http = ws.replace(/^ws/, 'http');
  try {
    const res = await fetch(`${http}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.relay === true;
  } catch {
    return false;
  }
}

export async function createRelaySync(config) {
  const base = relayUrlFrom(config);
  if (!hasRelayConfig(config)) {
    const err = new Error('No relay configured');
    err.code = 'not-configured';
    throw err;
  }

  /** One live connection per room code. */
  const links = new Map();

  function connect(code) {
    if (links.has(code)) return links.get(code);

    const link = {
      socket: null,
      attempt: 0,
      room: null,
      onChange: null,
      onError: null,
      closed: false,
      queue: [], // updates made while briefly offline
      ready: null,
    };

    const open = () => {
      if (link.closed) return;
      const url = new URL(base);
      url.searchParams.set('room', code);
      const socket = new WebSocket(url);
      link.socket = socket;

      link.ready = new Promise((resolve, reject) => {
        socket.addEventListener('open', () => {
          link.attempt = 0;
          // Only re-announce on a reconnect. On the first connection the caller
          // is about to send create or join itself, and a premature join would
          // come back as "no such room" for a room being created right now.
          if (link.joined) {
            socket.send(JSON.stringify({ t: 'join' }));
            for (const paths of link.queue.splice(0)) {
              socket.send(JSON.stringify({ t: 'update', paths }));
            }
          }
          resolve();
        });
        socket.addEventListener('error', () => reject(new Error('Could not reach the relay')));
      });
      // `ask` attaches its own handler; this one stops a failed reconnect from
      // surfacing as an unhandled rejection when nothing is waiting on it.
      link.ready.catch(() => {});

      socket.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.t === 'state') {
          link.room = msg.room;
          link.onChange?.(msg.room);
        } else if (msg.t === 'error') {
          const err = new Error(msg.message ?? 'The relay refused that');
          err.code = msg.code;
          link.onError?.(err);
        }
      });

      socket.addEventListener('close', () => {
        if (link.closed) return;
        const wait = RETRY_MS[Math.min(link.attempt++, RETRY_MS.length - 1)];
        setTimeout(open, wait);
      });
    };

    open();
    links.set(code, link);
    return link;
  }

  /** Open a socket, send one message, and wait for the reply that answers it. */
  function ask(code, message, { expect = 'state' } = {}) {
    const link = connect(code);
    return new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        clearTimeout(timer);
        link.socket?.removeEventListener('message', onMessage);
        fn(value);
      };
      const onMessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.t === expect) settle(resolve, msg.room ?? null);
        else if (msg.t === 'error') {
          const err = new Error(msg.message);
          err.code = msg.code;
          settle(reject, err);
        }
      };
      const timer = setTimeout(
        () => settle(reject, Object.assign(new Error('The relay did not answer'), { code: 'timeout' })),
        8000,
      );

      const fire = () => {
        link.socket.addEventListener('message', onMessage);
        link.socket.send(JSON.stringify(message));
      };

      if (link.socket?.readyState === WebSocket.OPEN) fire();
      else link.ready?.then(fire, (err) => settle(reject, err));
    });
  }

  return {
    kind: 'relay',
    label: 'relay',

    async create(code, room) {
      const link = connect(code);
      const created = await ask(code, { t: 'create', room });
      link.joined = true; // reconnects re-announce with join, not create
      link.room = created;
      return created;
    },

    async join(code) {
      const link = connect(code);
      try {
        const room = await ask(code, { t: 'join' });
        link.joined = true;
        link.room = room;
        return room;
      } catch (err) {
        if (err.code === 'room-missing') return null;
        throw err;
      }
    },

    watch(code, onChange, onError) {
      const link = connect(code);
      link.onChange = onChange;
      link.onError = onError;
      if (link.room) onChange(link.room);
      return () => {
        link.onChange = null;
        link.onError = null;
      };
    },

    async update(code, paths) {
      const link = connect(code);
      if (link.socket?.readyState === WebSocket.OPEN) {
        link.socket.send(JSON.stringify({ t: 'update', paths }));
      } else {
        // Hold it until the socket is back rather than losing the tap.
        link.queue.push(paths);
      }
    },

    async close() {
      for (const link of links.values()) {
        link.closed = true;
        link.socket?.close();
      }
      links.clear();
    },
  };
}
