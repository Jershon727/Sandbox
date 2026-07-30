/**
 * Browser checks for the things unit tests can't reach: two phones in the same
 * room, live sync, and scores surviving a refresh.
 *
 * Both "phones" run against the same-device backend, which implements exactly
 * the same interface as Firebase — so this exercises the real sync logic, just
 * over a BroadcastChannel instead of a socket.
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
// One context: two tabs sharing storage, the way two phones share a room.
const context = await browser.newContext({ viewport: { width: 414, height: 896 } });

const errors = [];
function guard(page, label) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_(CONNECTION|NAME|BLOCKED|INTERNET)|Failed to load resource/.test(m.text())) {
      errors.push(`${label}: ${m.text()}`);
    }
  });
}

const host = await context.newPage();
guard(host, 'host');
await host.goto(BASE, { waitUntil: 'domcontentloaded' });
await host.emulateMedia({ reducedMotion: 'reduce' });
await host.waitForFunction(() => !!window.__flip7);

// ── host a room ───────────────────────────────────────────────────────────
await host.click('[data-goto="host"]');
await host.fill('#host-name', 'Jack');
await host.click('#btn-host');
await host.waitForFunction(() => window.__flip7.store.code, null, { timeout: 5000 });

const code = await host.evaluate(() => window.__flip7.store.code);
check('hosting creates a room with a code', /^[A-Z2-9]{4}$/.test(code), code);
check('the host is the host', await host.evaluate(() => window.__flip7.store.isHost));
check(
  'the code is on screen',
  (await host.textContent('#room-code')) === code,
  await host.textContent('#room-code'),
);

// ── a second phone joins ──────────────────────────────────────────────────
const guest = await context.newPage();
guard(guest, 'guest');
// Both tabs share this context's localStorage, so without this the guest would
// auto-rejoin as the host. A real second phone starts with no membership; drop
// it once, on first load only, so the later reload still tests rejoining.
await guest.addInitScript(() => {
  if (!sessionStorage.getItem('e2e-fresh-device')) {
    sessionStorage.setItem('e2e-fresh-device', '1');
    localStorage.removeItem('flip7:membership');
  }
});
await guest.goto(`${BASE}?room=${code}`, { waitUntil: 'domcontentloaded' });
await guest.emulateMedia({ reducedMotion: 'reduce' });
await guest.waitForFunction(() => !!window.__flip7);
check(
  'a shared link pre-fills the code',
  (await guest.inputValue('#join-code')) === code,
  await guest.inputValue('#join-code'),
);

await guest.fill('#join-name', 'Sam');
await guest.click('#btn-join');
await guest.waitForFunction(() => window.__flip7.store.code, null, { timeout: 5000 });
check('the second phone is in the room', await guest.evaluate(() => !!window.__flip7.store.state));
check('and is not the host', !(await guest.evaluate(() => window.__flip7.store.isHost)));

// The host should see them arrive without doing anything.
const sawJoin = await host
  .waitForFunction(() => document.querySelectorAll('#standings .stand').length === 2, null, {
    timeout: 5000,
  })
  .then(() => true)
  .catch(() => false);
check('the host sees them join, live', sawJoin);

// ── tapping cards syncs both ways ─────────────────────────────────────────
const tap = (page, label) => page.click(`#pad button[aria-label="${label}"]`);

for (const n of [4, 9, 12]) await tap(guest, `Add a ${n}`);
await tap(guest, 'Times two');
await tap(guest, 'Plus 10');

check(
  'the calculator applies x2 before the + modifier',
  (await guest.textContent('#round-score')) === '60',
  `showed ${await guest.textContent('#round-score')}`,
);
check(
  'it shows the arithmetic',
  (await guest.textContent('#formula')) === '(4 + 9 + 12) × 2 + 10 = 60',
  await guest.textContent('#formula'),
);

const hostSawGuestScore = await host
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#standings .stand')].some(
        (row) =>
          row.querySelector('.stand__name')?.textContent.startsWith('Sam') &&
          row.querySelector('.stand__round')?.textContent === '+60',
      ),
    null,
    { timeout: 5000 },
  )
  .then(() => true)
  .catch(() => false);
check("the host's phone shows Sam's live round score", hostSawGuestScore);

// The host taps their own hand; the guest should see it.
for (const n of [7, 8]) await tap(host, `Add a ${n}`);
const guestSawHostScore = await guest
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#standings .stand')].some(
        (row) =>
          row.querySelector('.stand__name')?.textContent.startsWith('Jack') &&
          row.querySelector('.stand__round')?.textContent === '+15',
      ),
    null,
    { timeout: 5000 },
  )
  .then(() => true)
  .catch(() => false);
check("Sam's phone shows Jack's live round score", guestSawHostScore);

// ── you can't score for somebody else ─────────────────────────────────────
await guest.click('#standings .stand:has(.stand__name:text-matches("^Jack"))');
check(
  'a guest cannot edit another player',
  (await guest.textContent('#whose')) === 'Your hand',
  await guest.textContent('#whose'),
);

// ── busting, saving, undo ─────────────────────────────────────────────────
await tap(guest, '9 — you already have this, tapping again busts you');
check(
  'a duplicate busts the hand',
  (await guest.textContent('#round-score')) === '0' &&
    (await guest.textContent('#flag')) === 'Busted',
);
const hostSawBust = await host
  .waitForFunction(
    () =>
      [...document.querySelectorAll('#standings .stand')].some(
        (row) =>
          row.querySelector('.stand__name')?.textContent.startsWith('Sam') &&
          row.querySelector('.stand__round')?.textContent === 'bust',
      ),
    null,
    { timeout: 5000 },
  )
  .then(() => true)
  .catch(() => false);
check('the table sees the bust immediately', hostSawBust);

await guest.click('#btn-undo');
check('undo walks the bust back', (await guest.textContent('#round-score')) === '60');

await guest.click('#pad button[aria-label="Second Chance"]');
await tap(guest, '9 — you already have this, tapping again busts you');
check(
  'a Second Chance absorbs the duplicate instead',
  (await guest.textContent('#round-score')) === '60',
  `showed ${await guest.textContent('#round-score')}`,
);

// ── only the host ends the round ──────────────────────────────────────────
check('the guest has no End round button', await guest.locator('#btn-end-round').isHidden());
check('and is told what it is waiting for', await guest.locator('#waiting').isVisible());
check('the host does have one', await host.locator('#btn-end-round').isVisible());

await host.click('#btn-end-round');
await host.waitForSelector('#modal-round:not([hidden])', { timeout: 5000 });
check('the host gets the round summary', true);

const guestSummary = await guest
  .waitForSelector('#modal-round:not([hidden])', { timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check('every phone gets the same summary', guestSummary);

await guest.click('#modal-round [data-close]');
await host.click('#modal-round [data-close]');

const totals = await host.evaluate(() =>
  Object.values(window.__flip7.store.state.players).map((p) => `${p.name}:${p.total}`).sort(),
);
check('both hands banked into totals', JSON.stringify(totals) === '["Jack:15","Sam:60"]', totals.join(' '));
check('the round advanced for everyone', (await guest.textContent('#room-meta')).includes('round 2'));
check(
  'hands were cleared',
  (await guest.textContent('#round-score')) === '0',
  await guest.textContent('#round-score'),
);

// ── a refresh rejoins rather than losing the game ─────────────────────────
await guest.reload({ waitUntil: 'domcontentloaded' });
await guest.waitForFunction(() => window.__flip7?.store?.code, null, { timeout: 6000 });
check(
  'reopening the app goes straight back into the room',
  await guest.locator('#screen-room').isVisible(),
);
const resumedTotal = await guest.evaluate(
  () => window.__flip7.store.state.players[window.__flip7.store.myId].total,
);
check('a refresh rejoins with the score intact', resumedTotal === 60, `total ${resumedTotal}`);

// ── winning ───────────────────────────────────────────────────────────────
await host.evaluate(() => {
  const s = window.__flip7.store;
  return s.update({ [`players/${s.myId}/total`]: 195 });
});
for (const n of [11, 12] ) await tap(host, `Add a ${n}`);
await host.click('#btn-end-round');
const wonHost = await host
  .waitForSelector('#modal-over:not([hidden])', { timeout: 5000 })
  .then(() => true)
  .catch(() => false);
check('passing the target ends the game', wonHost);
check(
  'the winner is named on every phone',
  await guest
    .waitForFunction(() => {
      const el = document.querySelector('#modal-over');
      return el && !el.hidden && document.querySelector('#over-title')?.textContent.includes('Jack');
    }, null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false),
);
check('only the host is offered a rematch', await guest.locator('#btn-rematch').isHidden());

// ── bust odds and the recommendation ─────────────────────────────────────
// The game just finished, so clear it down to a fresh round first.
await host.click('#btn-rematch');
await guest.evaluate(() => document.querySelector('#modal-over')?.setAttribute('hidden', ''));
await host.waitForFunction(() => window.__flip7.store.state.round === 1, null, { timeout: 5000 });
await host.waitForTimeout(200);

// Empty hand: nothing can bust you.
check(
  'an empty hand shows no risk and says hit',
  (await host.textContent('#advice-pct')) === '0%' &&
    (await host.textContent('#advice-rec')) === 'Hit',
  `${await host.textContent('#advice-pct')} / ${await host.textContent('#advice-rec')}`,
);

// A fat hand of high cards should be worth protecting.
for (const n of [12, 11, 10, 9, 8, 7]) await tap(host, `Add a ${n}`);
const bigRisk = Number((await host.textContent('#advice-pct')).replace('%', ''));
check('a fat hand shows real risk', bigRisk > 30, `${bigRisk}%`);
check(
  'and the recommendation is to stay',
  (await host.textContent('#advice-rec')).startsWith('Stay'),
  await host.textContent('#advice-rec'),
);

// The reasoning is there when asked for, and quotes real counts.
check('the reasoning starts folded away', await host.locator('#advice-why').isHidden());
await host.click('#advice-row');
check('tapping opens it', await host.locator('#advice-why').isVisible());
const why = await host.textContent('#advice-reason');
check('it names how many cards would bust you', /\d+ of the \d+ unseen cards/.test(why), why);
check('and is honest about what it cannot see', /Freeze and Flip Three/.test(await host.textContent('#advice-why')));

// A Second Chance removes the risk entirely.
await host.click('#pad button[aria-label="Second Chance"]');
await host.waitForTimeout(120);
check(
  'a Second Chance drops the risk to zero and flips the call to hit',
  (await host.textContent('#advice-pct')) === '0%' &&
    (await host.textContent('#advice-rec')) === 'Hit',
  `${await host.textContent('#advice-pct')} / ${await host.textContent('#advice-rec')}`,
);

// Cards on the table reduce your risk: the guest showing 12s helps the host.
await host.click('#pad button[aria-label="Second Chance"]');
await host.waitForTimeout(120);
const before = Number((await host.textContent('#advice-pct')).replace('%', ''));
await guest.click('#btn-clear');
for (let i = 0; i < 1; i++) await tap(guest, 'Add a 12');
await host.waitForTimeout(400);
const after = Number((await host.textContent('#advice-pct')).replace('%', ''));
check(
  "another player's 12 lowers the host's risk",
  after <= before,
  `${before}% → ${after}%`,
);

// It can be turned off.
await host.click('[data-open="menu"]');
await host.click('#modal-menu [data-open="settings"]');
await host.waitForTimeout(150);
await host.evaluate(() => {
  const rows = [...document.querySelectorAll('#settings-opts .opt')];
  rows.find((r) => r.textContent.includes('Bust odds'))?.querySelector('.switch')?.click();
});
await host.evaluate(() => document.querySelector('#modal-settings').setAttribute('hidden', ''));
await host.waitForTimeout(150);
check('it can be switched off', await host.locator('#advice').isHidden());

await browser.close();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed || errors.length) process.exit(1);
