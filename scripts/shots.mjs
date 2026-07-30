/**
 * Development helper: drive the app in a real browser, capture screenshots and
 * fail loudly on any console error. Run with `node scripts/shots.mjs`.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.SHOT_DIR ?? '/tmp/flip7-shots';
const BASE = process.env.BASE ?? 'http://localhost:5173';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

const problems = [];
function guard(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
}

const host = await context.newPage();
guard(host, 'host');
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
};

await host.goto(BASE, { waitUntil: 'domcontentloaded' });
await host.emulateMedia({ reducedMotion: 'reduce' });
await host.waitForFunction(() => !!window.__flip7);
await shot(host, '01-home');

await host.click('[data-goto="host"]');
await host.fill('#host-name', 'Jack');
await host.waitForTimeout(150);
await shot(host, '02-host-setup');

await host.click('#btn-host');
await host.waitForFunction(() => window.__flip7.store.code);
const code = await host.evaluate(() => window.__flip7.store.code);

// A few friends, so the standings look like a real table.
await host.evaluate(async () => {
  const s = window.__flip7.store;
  for (const name of ['Sam', 'Mo', 'Ada']) await s.addPlayer(name);
});
await host.waitForTimeout(200);

// Give everyone a plausible round in progress.
await host.evaluate(async () => {
  const s = window.__flip7.store;
  const ids = Object.keys(s.state.players);
  const hands = [
    { numbers: [4, 9, 12], mods: [{ op: 'mul', value: 2 }, { op: 'add', value: 10 }], chance: false, busted: false },
    { numbers: [7, 3, 11, 0], mods: [], chance: true, busted: false },
    { numbers: [8, 5], mods: [], chance: false, busted: true },
    { numbers: [12, 6, 1], mods: [{ op: 'add', value: 4 }], chance: false, busted: false },
  ];
  const paths = {};
  ids.forEach((id, i) => {
    paths[`players/${id}/hand`] = hands[i % hands.length];
    paths[`players/${id}/total`] = [61, 88, 34, 120][i % 4];
  });
  await s.update(paths);
});
await host.waitForTimeout(350);
await shot(host, '03-room-live');

// The join screen on a second phone.
const guest = await context.newPage();
guard(guest, 'guest');
await guest.addInitScript(() => localStorage.removeItem('flip7:membership'));
await guest.goto(`${BASE}?room=${code}`, { waitUntil: 'domcontentloaded' });
await guest.emulateMedia({ reducedMotion: 'reduce' });
await guest.waitForFunction(() => !!window.__flip7);
await guest.waitForTimeout(200);
await shot(guest, '04-join');

// Round summary, as everyone sees it.
await host.click('#btn-end-round');
await host.waitForSelector('#modal-round:not([hidden])');
await host.waitForTimeout(300);
await shot(host, '05-round-summary');
await host.click('#modal-round [data-close]');

// The menu, with the code to share.
await host.click('[data-open="menu"]');
await host.waitForTimeout(250);
await shot(host, '06-menu');
await host.click('#modal-menu [data-close]');

await host.click('#screen-room [data-open="rules"]');
await host.waitForTimeout(300);
await shot(host, '07-rules');
await host.evaluate(() => document.querySelector('#modal-rules').setAttribute('hidden', ''));

// Light theme.
await host.click('[data-open="menu"]');
await host.waitForTimeout(150);
await host.click('#modal-menu [data-open="settings"]');
await host.waitForTimeout(200);
await host.evaluate(() => {
  const opts = [...document.querySelectorAll('#settings-opts .seg__opt')];
  opts.find((b) => b.textContent === 'Light')?.click();
});
await host.waitForTimeout(200);
await host.evaluate(() => document.querySelector('#modal-settings').setAttribute('hidden', ''));
await host.waitForTimeout(200);
await shot(host, '08-room-light');

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} console problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\nNo console errors.');
