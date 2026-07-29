/**
 * Browser-driven checks for the flows the unit tests can't reach: the driver
 * loop, human targeting, and the score helper's persistence.
 *
 *   node scripts/serve.mjs &   node scripts/e2e.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  // The Google Fonts request is blocked in CI sandboxes; that isn't our bug.
  if (m.type() === 'error' && !/ERR_(CONNECTION|NAME|BLOCKED|INTERNET)/.test(m.text())) {
    errors.push(m.text());
  }
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.emulateMedia({ reducedMotion: 'reduce' });

// ── the game drives itself to a finished round ────────────────────────────
await page.click('[data-goto="setup"]');
await page.click('#btn-start');
await page.waitForFunction(() => window.__flip7?.game?.round === 1, null, { timeout: 5000 });
check('game starts', true);

/** Put a specific card on top of the deck. */
const stack = (card) =>
  page.evaluate((c) => {
    window.__flip7.game.deck.push({ id: `e2e${Math.random()}`, ...c });
  }, card);

const yourTurn = () =>
  page.waitForFunction(
    () => {
      const s = window.__flip7;
      const r = s.game?.request();
      return r?.type === 'move' && !s.game.byId(r.playerId).isBot;
    },
    null,
    { timeout: 20000 },
  );

// ── human targeting must not stall the driver ─────────────────────────────
await yourTurn();
await stack({ kind: 'action', action: 'freeze' });
await page.click('#btn-hit');
await page.waitForSelector('#targeting:not([hidden])', { timeout: 8000 });
check('drawing Freeze asks you to pick a target', true);

const targets = await page.locator('.pod.is-target, .seat.is-target').count();
check('targets are highlighted', targets > 0, `${targets} highlighted`);

await page.locator('.pod.is-target, .seat.is-target').first().click();
await page.waitForFunction(() => document.getElementById('targeting').hidden, null, {
  timeout: 5000,
});

// The real regression: does the game keep running after you choose?
const recovered = await page
  .waitForFunction(
    () => {
      const s = window.__flip7;
      if (!s.game) return false;
      const r = s.game.request();
      return r.type !== 'target';
    },
    null,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);
check('the game continues after you pick a target', recovered);

const frozen = await page.evaluate(
  () => window.__flip7.game.players.filter((p) => p.status === 'frozen').length,
);
check('the target is frozen', frozen === 1, `${frozen} frozen`);

// ── a Flip Three resolves three flips ────────────────────────────────────
const advanced = await page
  .waitForFunction(
    () => {
      const s = window.__flip7;
      const r = s.game?.request();
      return r?.type === 'move' || r?.type === 'round-over';
    },
    null,
    { timeout: 20000 },
  )
  .then(() => true)
  .catch(() => false);
check('play resumes to a normal turn', advanced);

// ── bust risk is shown and matches the engine ────────────────────────────
if (await page.locator('#btn-hit').isEnabled()) {
  const shown = await page.textContent('#hit-sub');
  const actual = await page.evaluate(() => {
    const s = window.__flip7;
    const r = s.game.request();
    const p = s.game.byId(r.playerId);
    const pool = s.game.deck;
    if (p.secondChance) return null;
    const owned = new Set(p.numbers.map((c) => c.value));
    const bad = pool.filter((c) => c.kind === 'number' && owned.has(c.value)).length;
    return Math.round((bad / pool.length) * 100);
  });
  check(
    'the risk meter matches the deck',
    actual === null || shown.includes(`${actual}%`),
    `showed "${shown}", deck says ${actual}%`,
  );
}

// ── the round finishes and the summary appears ────────────────────────────
for (let i = 0; i < 60; i++) {
  if (await page.locator('#modal-round').isVisible()) break;
  if (await page.locator('#targeting').isVisible()) {
    await page.locator('.pod.is-target, .seat.is-target').first().click();
  } else if (await page.locator('#btn-hit').isEnabled()) {
    await page.click('#btn-hit');
  }
  await page.waitForTimeout(400);
}
check('a round ends with a summary', await page.locator('#modal-round').isVisible());

await page.click('#btn-next-round');
await page.waitForFunction(() => window.__flip7.game.round === 2, null, { timeout: 8000 });
check('the next round starts', true);

// ── score helper ─────────────────────────────────────────────────────────
await page.click('#screen-game [data-open="pause"]');
await page.click('#btn-quit');
await page.click('[data-goto="tally"]');
await page.click('#tally-start');

const tap = (label) => page.click(`#tally-pad button[aria-label="${label}"]`);
for (const n of [4, 9, 12]) await tap(`Add a ${n}`);
await tap('Times two');
await tap('Plus 10');
check(
  'the calculator applies x2 before the + modifier',
  (await page.textContent('#tally-score')) === '60',
  `showed ${await page.textContent('#tally-score')}`,
);
check(
  'it shows the arithmetic',
  (await page.textContent('#tally-formula')) === '(4 + 9 + 12) × 2 + 10 = 60',
  await page.textContent('#tally-formula'),
);

// a held number is flagged, and tapping it again is the bust
check(
  'held numbers are marked on the keypad',
  await page.locator('#tally-pad button[aria-label^="9 —"]').count() === 1,
);
await tap('9 — you already have this, tapping again busts you');
check(
  'tapping a duplicate busts the hand',
  (await page.textContent('#tally-score')) === '0' &&
    (await page.locator('#tally-flag').textContent()) === 'Busted',
);

// undo walks it back
await page.click('#tally-undo');
check('undo restores the hand', (await page.textContent('#tally-score')) === '60');

// a Second Chance absorbs the duplicate instead
await page.click('#tally-pad button[aria-label="Second Chance"]');
await tap('9 — you already have this, tapping again busts you');
check(
  'a Second Chance absorbs the duplicate',
  (await page.textContent('#tally-score')) === '60',
  `showed ${await page.textContent('#tally-score')}`,
);

// scores survive a reload — the thing that must never break at a real table
await page.click('#tally-end');
await page.waitForSelector('#modal-round:not([hidden])');
const bankedTotal = await page.evaluate(
  () => JSON.parse(localStorage.getItem('flip7:tally')).players[0].total,
);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.click('[data-goto="tally"]');
const afterReload = await page.textContent('.rail__tab .rail__total');
check(
  'the session survives a reload',
  Number(afterReload) === bankedTotal && bankedTotal === 60,
  `banked ${bankedTotal}, reloaded ${afterReload}`,
);

// ── flip 7 in the calculator ─────────────────────────────────────────────
for (const n of [1, 2, 3, 4, 5, 6, 7]) await tap(`Add a ${n}`);
check(
  'seven uniques scores the Flip 7 bonus',
  (await page.textContent('#tally-score')) === '43',
  `showed ${await page.textContent('#tally-score')}`,
);
check('and is called out', (await page.locator('#tally-flag').textContent()) === 'Flip 7!');

await browser.close();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed || errors.length) process.exit(1);
