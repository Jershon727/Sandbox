/**
 * Where your relay lives — fill this in to switch on online rooms.
 *
 * The relay is the small WebSocket server in `server/relay.mjs`. Deploy it
 * anywhere that runs a Node process (Fly, Render, Railway, a VPS), then put its
 * address here. Use `wss://` — a page served over https can't open a plain `ws://`
 * socket.
 *
 *   export const relayUrl = 'wss://flip7-relay.fly.dev';
 *
 * There's nothing secret here: knowing the address only lets you join rooms whose
 * four-character code you already know.
 *
 * Until this is filled in, the app runs in single-phone mode — one device keeps
 * score for the whole table.
 *
 * To point one device at a different relay without editing this file:
 *   localStorage.setItem('flip7:relay', 'wss://my-relay.example')
 */

export const relayUrl = '';
