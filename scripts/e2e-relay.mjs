/**
 * Relay checks — two genuinely separate devices sharing a room over WebSockets.
 *
 * The other suite runs both phones in one browser context, which share
 * localStorage. Here each phone gets its own context with nothing in common, so
 * the only thing that can be carrying state between them is the relay.
 *
 * This runs the production shape: one relay process serving the app *and* the
 * WebSockets on one origin, with the client discovering it via 'same-origin' —
 * exactly what the Dockerfile and railway.json deploy.
 *
 *   node scripts/e2e-relay.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8899);
// One origin for both, the way the container serves it.
const BASE = `http://localhost:${RELAY_PORT}`;

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const children = [];

/** Never leave servers behind, however this script ends. */
function cleanup() {
  for (const child of children) child.kill();
  children.length = 0;
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

/** A stale server on the port would make this suite test the wrong thing. */
async function requireFree(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
  } catch {
    return; // nothing listening, which is what we want
  }
  console.error(`Port ${port} is already serving. Stop it first — otherwise this
suite would silently check a stale server instead of the one it starts.`);
  process.exit(1);
}

function start(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} never came up`);
}

await requireFree(RELAY_PORT);

const ROOM_STORE = `/tmp/flip7-e2e-rooms-${process.pid}.json`;
const relayEnv = { PORT: String(RELAY_PORT), ROOM_STORE };
let relay = start('server/relay.mjs', relayEnv);
await waitFor(`http://localhost:${RELAY_PORT}/health`);

check(
  'the relay serves the app as well as the sockets',
  (await fetch(BASE).then((r) => r.text())).includes('Bust-O-meter'),
);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

/** A phone: its own context, its own storage, pointed at the relay. */
async function phone(label, base = BASE) {
  const context = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_(CONNECTION|NAME|BLOCKED|INTERNET)|Failed to load resource/.test(m.text())) {
      errors.push(`${label}: ${m.text()}`);
    }
  });
  // 'same-origin' is what ships; nothing here is told the address.
  await page.addInitScript(() => localStorage.setItem('flip7:relay', 'same-origin'));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => !!window.__flip7);
  return { context, page };
}

const tap = (page, label) => page.click(`#pad button[aria-label="${label}"]`);
const standing = (page, name) =>
  page.evaluate((who) => {
    const row = [...document.querySelectorAll('#standings .stand')].find((r) =>
      r.querySelector('.stand__name')?.textContent.startsWith(who),
    );
    if (!row) return null;
    return {
      round: row.querySelector('.stand__round')?.textContent,
      total: row.querySelector('.stand__total')?.textContent,
    };
  }, name);

// ── the relay is recognised as the online transport ───────────────────────
const jack = await phone('jack');
check(
  'a relay address switches on online rooms',
  (await jack.page.evaluate(() => window.__flip7.view.onlineKind)) === 'relay',
  await jack.page.evaluate(() => String(window.__flip7.view.onlineKind)),
);

await jack.page.click('[data-goto="host"]');
await jack.page.evaluate(() => {
  const opts = [...document.querySelectorAll('#host-mode .seg__opt')];
  opts.find((b) => b.textContent.includes('their own phones') || b.textContent.includes('Their own'))?.click();
});
await jack.page.fill('#host-name', 'Jack');
await jack.page.click('#btn-host');
await jack.page.waitForFunction(() => window.__flip7.store.code, null, { timeout: 8000 });

const code = await jack.page.evaluate(() => window.__flip7.store.code);
check('hosting over the relay gets a code', /^[A-Z2-9]{4}$/.test(code), code);
check(
  'and the app knows it is online',
  await jack.page.evaluate(() => window.__flip7.store.isOnline),
);
check(
  'the relay is holding the room',
  (await fetch(`http://localhost:${RELAY_PORT}/health`).then((r) => r.json())).rooms === 1,
);

// ── a second, unrelated device joins ─────────────────────────────────────
const sam = await phone('sam');
await sam.page.click('[data-goto="join"]');
await sam.page.fill('#join-code', code);
await sam.page.fill('#join-name', 'Sam');
await sam.page.click('#btn-join');
await sam.page.waitForFunction(() => window.__flip7.store.code, null, { timeout: 8000 });
check('a separate device joins with just the code', true);

const jackSawSam = await jack.page
  .waitForFunction(() => document.querySelectorAll('#standings .stand').length === 2, null, {
    timeout: 8000,
  })
  .then(() => true)
  .catch(() => false);
check('the host sees them arrive, with no shared storage between them', jackSawSam);

// ── scores cross the wire ────────────────────────────────────────────────
for (const n of [4, 9, 12]) await tap(sam.page, `Add a ${n}`);
await tap(sam.page, 'Times two');
await tap(sam.page, 'Plus 10');

const sawSamScore = await jack.page
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#standings .stand')].some(
        (r) =>
          r.querySelector('.stand__name')?.textContent.startsWith('Sam') &&
          r.querySelector('.stand__round')?.textContent === '+60',
      ),
    null,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);
check("Sam's 60 appears on Jack's phone", sawSamScore, JSON.stringify(await standing(jack.page, 'Sam')));

for (const n of [7, 8]) await tap(jack.page, `Add a ${n}`);
const sawJackScore = await sam.page
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#standings .stand')].some(
        (r) =>
          r.querySelector('.stand__name')?.textContent.startsWith('Jack') &&
          r.querySelector('.stand__round')?.textContent === '+15',
      ),
    null,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);
check("and Jack's 15 appears on Sam's", sawJackScore);

// ── the Bust-O-meter uses the whole table's cards ────────────────────────
const jackRisk = await jack.page.textContent('#advice-pct');
check(
  "the meter counts other phones' cards too",
  jackRisk !== '0%',
  `Jack's risk with 7 and 8 showing: ${jackRisk}`,
);

// ── only the host ends the round, and both phones see the summary ────────
check('the guest cannot end the round', await sam.page.locator('#btn-end-round').isHidden());
await jack.page.click('#btn-end-round');
const bothSummaries =
  (await jack.page
    .waitForSelector('#modal-round:not([hidden])', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)) &&
  (await sam.page
    .waitForSelector('#modal-round:not([hidden])', { timeout: 8000 })
    .then(() => true)
    .catch(() => false));
check('both phones show the same round summary', bothSummaries);

await jack.page.click('#modal-round [data-close]');
await sam.page.click('#modal-round [data-close]');
check('totals banked across the wire', (await standing(sam.page, 'Sam'))?.total === '60');

// ── the room outlives a phone: the thing peer-to-peer could not do ───────
// A third phone stays connected so we can watch echoes arrive after the host
// goes away.
const jack2 = await phone('watcher');
await jack2.page.click('[data-goto="join"]');
await jack2.page.fill('#join-code', code);
await jack2.page.fill('#join-name', 'Watcher');
await jack2.page.click('#btn-join');
await jack2.page.waitForFunction(() => window.__flip7.store.code, null, { timeout: 8000 });
await jack.context.close();
await new Promise((r) => setTimeout(r, 500));
for (const n of [11, 3] ) await tap(sam.page, `Add a ${n}`);
check(
  "Sam keeps playing after the host's phone is gone",
  (await standing(sam.page, 'Sam'))?.round === '+14',
  JSON.stringify(await standing(sam.page, 'Sam')),
);

// ── a phone that reloads comes back to the same room ─────────────────────
await sam.page.reload({ waitUntil: 'domcontentloaded' });
await sam.page.waitForFunction(() => window.__flip7?.store?.code, null, { timeout: 8000 });
check('a reload rejoins through the relay', await sam.page.locator('#screen-room').isVisible());
check(
  'with the banked score intact',
  (await standing(sam.page, 'Sam'))?.total === '60',
  JSON.stringify(await standing(sam.page, 'Sam')),
);

// ── a wrong code fails cleanly ───────────────────────────────────────────
const zoe = await phone('zoe');
await zoe.page.click('[data-goto="join"]');
await zoe.page.fill('#join-code', 'ZZZZ');
await zoe.page.fill('#join-name', 'Zoe');
await zoe.page.click('#btn-join');
await zoe.page.waitForTimeout(1200);
const joinError = await zoe.page.textContent('#join-error');
check('an unknown code says so instead of hanging', /No game found/i.test(joinError), joinError);

// ── tapping fast must not lose cards ─────────────────────────────────────
// Each tap rewrites the whole hand, so a tap landing before the previous echo
// would otherwise be computed from a hand that no longer exists.
await sam.page.click('#btn-clear');
await sam.page.waitForTimeout(400);
// Fired synchronously in one go: six handlers back to back, which is the
// harshest form of the race. Driving them through Playwright instead would fight
// its element-stability checks, because a growing hand shifts the keypad.
await sam.page.evaluate(() => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    document.querySelector(`#pad button[aria-label="Add a ${n}"]`).click();
  }
});
await sam.page.waitForTimeout(1200);
const fast = await sam.page.evaluate(() => {
  const s = window.__flip7.store;
  return s.state.players[s.myId].hand.numbers;
});
check(
  'six quick taps all land',
  fast.length === 6 && [1, 2, 3, 4, 5, 6].every((n) => fast.includes(n)),
  `got [${fast}]`,
);
const echoed = await jack2.page.evaluate((id) => {
  const s = window.__flip7.store;
  return s.state.players[id].hand.numbers.length;
}, await sam.page.evaluate(() => window.__flip7.store.myId));
check('and all six reach the other phone', echoed === 6, `other phone saw ${echoed}`);

await sam.page.click('#btn-clear');
await sam.page.waitForTimeout(400);
for (const n of [11, 3]) await tap(sam.page, `Add a ${n}`);
await sam.page.waitForTimeout(600);

// ── a relay restart must not lose the game ───────────────────────────────
// Hosting platforms restart containers. If that ended everyone's evening, the
// relay would be no better than making the host's phone the server.
relay.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 700));
relay = start('server/relay.mjs', relayEnv);
await waitFor(`http://localhost:${RELAY_PORT}/health`);
check(
  'the restarted relay still has the room',
  (await fetch(`http://localhost:${RELAY_PORT}/health`).then((r) => r.json())).rooms >= 1,
);

const reconnected = await sam.page
  .waitForFunction(() => !!window.__flip7.store.state, null, { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
check('the phone reconnects on its own', reconnected);
check(
  'and the score came back with it',
  (await standing(sam.page, 'Sam'))?.total === '60',
  JSON.stringify(await standing(sam.page, 'Sam')),
);

// A tap made while the relay was down should still land.
await tap(sam.page, 'Add a 5');
await sam.page.waitForTimeout(800);
check(
  'play carries on after the restart',
  (await standing(sam.page, 'Sam'))?.round === '+19',
  JSON.stringify(await standing(sam.page, 'Sam')),
);

// A host with no relay behind it must not advertise online rooms.
const staticOnly = start('scripts/serve.mjs', { PORT: '5211' });
await waitFor('http://localhost:5211');
const plain = await phone('static-only', 'http://localhost:5211');
check(
  'a static host with no relay falls back to single-phone mode',
  (await plain.page.evaluate(() => window.__flip7.view.onlineKind)) === null,
  String(await plain.page.evaluate(() => window.__flip7.view.onlineKind)),
);
staticOnly.kill();

await browser.close();
cleanup();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
