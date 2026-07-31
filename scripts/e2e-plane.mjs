/**
 * The plane test: a dealt game, with friends, and no network whatsoever.
 *
 * The hardest thing the app claims to do offline. One phone deals, everyone
 * takes their turn on it, and it survives being reloaded mid-flight. Flip 7 is
 * played face up, so passing one phone round the table gives nothing away.
 *
 *   node scripts/e2e-plane.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8951;
const BASE = `http://localhost:${PORT}`;
const out = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  const line = `${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`;
  out.push(line);
  console.log(line);
  if (!ok) failed++;
};

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errs.push(m.text());
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__flip7);
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1200);

// Pull the plug — everything from here is offline.
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__flip7, null, { timeout: 15000 });
check('the app opens with no network', true);

// Host a dealt game on this device.
await page.click('[data-goto="host"]');
await page.fill('#host-name', 'Jack');
await page.evaluate(() => {
  [...document.querySelectorAll('#host-cards .seg__opt')].find((b) => b.textContent === 'Deal for us')?.click();
});
await page.waitForTimeout(200);
check(
  'the dealt game is offered even with no relay',
  await page.evaluate(
    () => !document.querySelector('#host-cards .seg__opt:nth-child(2)').disabled,
  ),
);
check(
  'and the mode picker explains passing the phone',
  /pass this one round/i.test(
    await page.evaluate(() =>
      [...document.querySelectorAll('#host-mode .seg__opt')].map((b) => b.textContent).join('|'),
    ),
  ),
  await page.evaluate(() =>
    [...document.querySelectorAll('#host-mode .seg__opt')].map((b) => b.textContent).join('|'),
  ),
);

await page.evaluate(() => {
  [...document.querySelectorAll('#host-bots .seg__opt')].find((b) => b.textContent === '1')?.click();
});
await page.click('#btn-host');
const hosted = await page
  .waitForFunction(() => window.__flip7.store.state?.kind === 'dealt', null, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('hosting a dealt game works offline', hosted);
if (!hosted) { console.log(out.join('\n')); process.exit(1); }

check('it starts in a lobby', (await page.evaluate(() => window.__flip7.store.state.lobby)) === true);

// Nothing may invite the host to read a code out: with no transport, another
// device has no way to reach this game, so a shared code would only fail.
const lobbyText = await page.evaluate(() => ({
  status: document.getElementById('dealt-status').textContent,
  hint: document.getElementById('room-hint').hidden
    ? ''
    : document.getElementById('room-hint').textContent,
}));
check(
  'the lobby never suggests sharing a code',
  !/code/i.test(`${lobbyText.status} ${lobbyText.hint}`),
  JSON.stringify(lobbyText),
);

await page.click('#room-chip');
await page.waitForTimeout(250);
const shared = await page.textContent('#toast');
check(
  'and tapping the code says the game lives on this phone',
  /this phone/i.test(shared) && !/link/i.test(shared),
  shared,
);
check(
  'and knows it is a shared phone',
  (await page.evaluate(() => window.__flip7.store.isPassAndPlay)) === true,
);

// Add two friends who have no phone of their own.
await page.evaluate(async () => {
  for (const n of ['Sam', 'Mo']) await window.__flip7.store.addPlayer(n);
});
await page.waitForTimeout(400);
const seats = await page.evaluate(() =>
  Object.values(window.__flip7.store.state.players).map((p) => p.name),
);
check('friends can be seated with no network', seats.includes('Sam') && seats.includes('Mo'), seats.join(','));

// Deal.
await page.click('#btn-deal-next');
const dealt = await page
  .waitForFunction(() => window.__flip7.store.state?.round === 1, null, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check('the host deals the first round', dealt);

// Play a whole round on the one phone, acting as whoever is up.
let turns = 0;
let sawPassBanner = false;
let sawOthers = new Set();
for (let i = 0; i < 200; i++) {
  const st = await page.evaluate(() => {
    const s = window.__flip7.store;
    return {
      turnId: s.state?.turnId,
      pendingBy: s.state?.pending?.byId ?? null,
      acting: s.actingId,
      myTurn: s.myTurn,
      roundOver: s.state?.roundOver,
      finished: s.state?.status === 'finished',
      actingName: s.state?.players?.[s.actingId]?.name,
      banner: document.getElementById('banner').textContent,
      whose: document.getElementById('whose').textContent,
    };
  });
  if (st.finished || st.roundOver) break;
  if (/Pass to/.test(st.banner)) sawPassBanner = true;
  if (st.actingName) sawOthers.add(st.actingName);

  if (st.pendingBy && st.pendingBy === st.acting) {
    await page.evaluate(() => {
      const s = window.__flip7.store;
      s.intent({ do: 'target', targetId: s.state.pending.targets[0] });
    });
    turns++;
    await page.waitForTimeout(250);
    continue;
  }
  if (st.myTurn) {
    await page.evaluate(() => window.__flip7.store.intent({ do: 'stay' }));
    turns++;
    await page.waitForTimeout(250);
    continue;
  }
  await page.waitForTimeout(200);
}

check('every human took a turn on the one phone', turns >= 3, `${turns} actions`);
check(
  'and the phone acted as more than one person',
  sawOthers.size >= 2,
  [...sawOthers].join(','),
);
check('a "pass to" cue appeared', sawPassBanner);
check('the round closed by itself', (await page.evaluate(() => window.__flip7.store.state.roundOver)) === true);

const results = await page.evaluate(() => window.__flip7.store.state.lastRound?.results?.length ?? 0);
check('and produced a summary for the whole table', results === 4, `${results} rows`);

// Deal another round, then check it survives a reload with no network.
await page.evaluate(() => window.__flip7.store.intent({ do: 'next-round' }));
await page.waitForFunction(() => window.__flip7.store.state?.round === 2, null, { timeout: 10000 })
  .then(() => check('the host can deal the next round', true))
  .catch(() => check('the host can deal the next round', false));

await page.waitForTimeout(600);
await page.reload({ waitUntil: 'domcontentloaded' });
const resumed = await page
  .waitForFunction(() => window.__flip7.store.state?.kind === 'dealt' && window.__flip7.store.state.round === 2, null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check('the game survives a reload while still offline', resumed);
if (resumed) {
  check(
    'and the dealer picks up where it left off',
    await page
      .waitForFunction(
        () => {
          const s = window.__flip7.store.state;
          return !!(s?.turnId || s?.pending || s?.roundOver);
        },
        null,
        { timeout: 12000 },
      )
      .then(() => true)
      .catch(() => false),
  );
}

await browser.close();
server.kill();
console.log(`\n${out.length - failed}/${out.length} checks passed`);
if (errs.length) console.log(`errors:\n  ${errs.join('\n  ')}`);
process.exit(failed || errs.length ? 1 : 0);
