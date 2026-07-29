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
const page = await browser.newPage({
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
});

const problems = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
// Motion off makes the captures deterministic.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.waitForTimeout(300);
await shot('01-home');

// ── the game ──────────────────────────────────────────────────────────────
await page.click('[data-goto="setup"]');
await page.waitForTimeout(200);
await shot('02-setup');

await page.click('#btn-start');
await page.waitForTimeout(2600);
await shot('03-game-early');

// Play a handful of turns so the table fills up.
for (let i = 0; i < 5; i++) {
  const hit = page.locator('#btn-hit');
  if (await hit.isEnabled()) {
    await hit.click();
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(900);
  }
}
await shot('04-game-mid');

// Play on until a round actually finishes, so the summary gets captured.
for (let i = 0; i < 40; i++) {
  if (await page.locator('#modal-round').isVisible()) break;
  const hint = page.locator('#targeting');
  if (await hint.isVisible()) {
    await page.locator('.pod.is-target, .seat.is-target').first().click();
    await page.waitForTimeout(1200);
    continue;
  }
  const hit = page.locator('#btn-hit');
  if (await hit.isEnabled()) await hit.click();
  await page.waitForTimeout(1100);
}
if (await page.locator('#modal-round').isVisible()) await shot('04b-round-summary');
else console.log('  (round did not finish in time)');

// ── the score helper ──────────────────────────────────────────────────────
await page.evaluate(() => {
  document.querySelectorAll('.modal:not([hidden])').forEach((m) => (m.hidden = true));
});
await page.click('#screen-game [data-open="pause"]');
await page.waitForTimeout(150);
await page.click('#btn-quit');
await page.waitForTimeout(300);
await page.click('[data-goto="tally"]');
await page.waitForTimeout(250);
await shot('05-tally-setup');

await page.click('#tally-start');
await page.waitForTimeout(300);

for (const n of ['4', '9', '12', '0']) {
  await page.click(`#tally-pad button[aria-label="Add a ${n}"]`);
  await page.waitForTimeout(120);
}
await page.click('#tally-pad button[aria-label="Times two"]');
await page.waitForTimeout(120);
await page.click('#tally-pad button[aria-label="Plus 10"]');
await page.waitForTimeout(350);
await shot('06-tally-hand');

// ── reference sheet ───────────────────────────────────────────────────────
await page.click('#screen-tally [data-goto="home"]');
await page.waitForTimeout(250);
await page.click('[data-open="rules"]');
await page.waitForTimeout(350);
await shot('07-rules');

await page.evaluate(() => document.querySelector('#modal-rules').setAttribute('hidden', ''));
await page.click('[data-open="settings"]');
await page.waitForTimeout(300);
await shot('08-settings');

// ── light theme ───────────────────────────────────────────────────────────
await page.evaluate(() => {
  const opts = [...document.querySelectorAll('#settings-opts .seg__opt')];
  opts.find((b) => b.textContent === 'Light')?.click();
});
await page.waitForTimeout(250);
await page.evaluate(() => document.querySelector('#modal-settings').setAttribute('hidden', ''));
await page.waitForTimeout(200);
await shot('09-home-light');

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} console problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\nNo console errors.');
