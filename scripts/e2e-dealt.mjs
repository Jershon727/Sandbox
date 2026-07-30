/**
 * A dealt game, played through the relay for real.
 *
 * The relay is the dealer: it holds the deck, decides what everyone draws, and
 * plays the bots. The browser only ever asks. This drives an actual game to a
 * finished round with two humans and a bot at the table, and checks the things
 * that matter about a server-authoritative game — most importantly that the deck
 * never leaves the dealer and that you can't play out of turn.
 *
 *   node scripts/e2e-dealt.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.RELAY_PORT ?? 8907);
const BASE = `http://localhost:${PORT}`;

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const children = [];
const cleanup = () => {
  for (const c of children) c.kill();
  children.length = 0;
};
process.on('exit', cleanup);
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

async function waitFor(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} never came up`);
}

try {
  await fetch(BASE, { signal: AbortSignal.timeout(400) });
  console.error(`Port ${PORT} is already serving; stop it first.`);
  process.exit(1);
} catch {
  /* free, good */
}

const relay = spawn(process.execPath, ['server/relay.mjs'], {
  env: { ...process.env, PORT: String(PORT), ROOM_STORE: `/tmp/flip7-dealt-${process.pid}.json` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(relay);
await waitFor(`${BASE}/health`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

async function phone(label) {
  const context = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) {
      errors.push(`${label}: ${m.text()}`);
    }
  });
  await page.addInitScript(() => localStorage.setItem('flip7:relay', 'same-origin'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => !!window.__flip7);
  return { context, page };
}

const state = (page) => page.evaluate(() => window.__flip7.store.state);
const myTurn = (page) => page.evaluate(() => window.__flip7.store.myTurn);

/** Wait until this phone is asked to do something, or the round ends. */
async function waitForPrompt(page, ms = 25000) {
  return page
    .waitForFunction(
      () => {
        const s = window.__flip7.store;
        const st = s.state;
        if (!st) return false;
        if (st.roundOver || st.status === 'finished') return true;
        if (st.pending?.byId === s.myId) return true;
        return st.turnId === s.myId;
      },
      null,
      { timeout: ms },
    )
    .then(() => true)
    .catch(() => false);
}

// ── host a dealt game with a bot ──────────────────────────────────────────
const jack = await phone('jack');
await jack.page.click('[data-goto="host"]');
await jack.page.fill('#host-name', 'Jack');
await jack.page.evaluate(() => {
  const pick = (id, label) =>
    [...document.querySelectorAll(`#${id} .seg__opt`)].find((b) => b.textContent === label)?.click();
  pick('host-cards', 'Deal for us');
});
await jack.page.waitForTimeout(150);
check('the setup offers a dealt game when a relay is there', await jack.page.locator('#field-bots').isVisible());

await jack.page.evaluate(() => {
  [...document.querySelectorAll('#host-bots .seg__opt')].find((b) => b.textContent === '1')?.click();
});
await jack.page.click('#btn-host');
await jack.page.waitForFunction(() => window.__flip7.store.state?.kind === 'dealt', null, {
  timeout: 8000,
});

const code = await jack.page.evaluate(() => window.__flip7.store.code);
check('hosting a dealt game works', /^[A-Z2-9]{4}$/.test(code), code);

const view = await state(jack.page);
check('the dealer seated the host and a bot', Object.keys(view.players).length === 2);
check(
  'one of them is a bot',
  Object.values(view.players).filter((p) => p.isBot).length === 1,
);

// ── the deck stays with the dealer ────────────────────────────────────────
check('the client is never sent the deck', !('deck' in view) && !('discard' in view));
check('but is told how many cards are left', typeof view.deckLeft === 'number' && view.deckLeft < 94);
check(
  'and the remaining composition, which anyone could count',
  !!view.deckTally && view.deckTally.total === view.deckLeft,
);
const raw = await jack.page.evaluate(async () => {
  // Whatever the socket delivered, in full — no card identities should appear.
  return JSON.stringify(window.__flip7.store.state);
});
check('no card identities leak in the payload', !/"id":"c\d+"/.test(raw));

// ── the keypad is gone; hit and stay replace it ───────────────────────────
check('the tap-in keypad is hidden', await jack.page.locator('#pad').isHidden());
check('the dealt controls are shown', await jack.page.locator('#dealt').isVisible());

// ── a second human joins the same dealt table ────────────────────────────
const sam = await phone('sam');
await sam.page.click('[data-goto="join"]');
await sam.page.fill('#join-code', code);
await sam.page.fill('#join-name', 'Sam');
await sam.page.click('#btn-join');
await sam.page.waitForFunction(() => window.__flip7.store.state?.kind === 'dealt', null, {
  timeout: 8000,
});
const seated = await jack.page
  .waitForFunction(() => Object.keys(window.__flip7.store.state.players).length === 3, null, {
    timeout: 8000,
  })
  .then(() => true)
  .catch(() => false);
check('a second person can join a dealt table', seated);
check(
  'and sits out the hand already in progress rather than being dealt into it',
  (await state(sam.page)).players[await sam.page.evaluate(() => window.__flip7.store.myId)].hand
    .numbers.length === 0,
);

// ── you cannot play out of turn ───────────────────────────────────────────
// Which player is up is not ours to choose — the dealer decides, and a bot can
// freeze someone out before their first turn. So ask whoever *isn't* up.
const upNow = await jack.page
  .waitForFunction(() => window.__flip7.store.state?.turnId ?? null, null, { timeout: 20000 })
  .then((h) => h.jsonValue())
  .catch(() => null);

if (upNow) {
  const notUp = (await jack.page.evaluate(() => window.__flip7.store.myId)) === upNow ? sam : jack;
  const before = JSON.stringify((await state(notUp.page)).players);
  await notUp.page.evaluate(() => window.__flip7.store.intent({ do: 'hit' }));
  await notUp.page.waitForTimeout(800);
  check(
    'a hit from someone whose turn it is not changes nothing',
    JSON.stringify((await state(notUp.page)).players) === before,
  );
} else {
  // A round can end before we catch anyone mid-turn — a Freeze on the opening
  // deal can do it. The refusal itself is pinned down deterministically by
  // "you cannot play out of turn" in tests/dealer.test.mjs; this is the
  // over-the-wire version of the same thing, and only runs when it can.
  results.push('· out-of-turn check skipped: the round ended before anyone was on turn');
}

// ── play, across rounds, until a person has actually had a turn ────────────
// One round is not a guarantee: Freeze can end your round before it starts. Over
// two rounds a person should get to act, and the account should say why if not.
let acted = 0;
let sawBot = false;
let roundsPlayed = 0;

for (let step = 0; step < 240 && roundsPlayed < 2; step++) {
  const st = await state(jack.page);
  if (!st) break;

  if (st.turnId && st.players[st.turnId]?.isBot) sawBot = true;

  if (st.roundOver || st.status === 'finished') {
    roundsPlayed++;
    if (acted > 0 || st.status === 'finished') break;
    // Nobody human got a turn that round; deal another and try again.
    await jack.page.evaluate(() => window.__flip7.store.intent({ do: 'next-round' }));
    await jack.page.waitForTimeout(900);
    continue;
  }

  for (const p of [jack, sam]) {
    const s = await state(p.page);
    const me = await p.page.evaluate(() => window.__flip7.store.myId);
    if (s.pending?.byId === me) {
      await p.page.evaluate(
        (t) => window.__flip7.store.intent({ do: 'target', targetId: t }),
        s.pending.targets[0],
      );
      acted++;
      await p.page.waitForTimeout(400);
    } else if (s.turnId === me) {
      await p.page.evaluate((first) => window.__flip7.store.intent({ do: first ? 'hit' : 'stay' }), acted === 0);
      acted++;
      await p.page.waitForTimeout(500);
    }
  }
  await jack.page.waitForTimeout(300);
}

check('a person got to act within two rounds', acted > 0, `acted ${acted}`);
check('the round closes by itself once everyone is done', roundsPlayed > 0 || (await state(jack.page)).roundOver);

// Whether the poll happened to catch the bot mid-turn is luck; what matters is
// that the dealer played it. Its recorded round score is the evidence.
const botPlayed = await jack.page.evaluate(() => {
  const st = window.__flip7.store.state;
  const bot = Object.values(st.players).find((p) => p.isBot);
  return {
    state: bot.state,
    held: (bot.hand.numbers?.length ?? 0) + (bot.hand.mods?.length ?? 0),
    scored: (bot.history ?? []).length,
  };
});
check(
  'the dealer played the bot to a finish',
  botPlayed.state !== 'active' && botPlayed.held > 0,
  JSON.stringify(botPlayed),
);
if (sawBot) results.push('  (and the poll caught it mid-turn)');

// The account of the round is the fix for "it ended without everyone playing".
const feed = await jack.page.evaluate(() => ({
  lines: (window.__flip7.store.state.feed ?? []).map((l) => l.text),
  onScreen: [...document.querySelectorAll('#feed .feed__line')].map((el) => el.textContent),
}));
check('the round leaves a readable account', feed.lines.length > 0, `${feed.lines.length} lines`);
check('and it is on screen', feed.onScreen.length > 0, feed.onScreen.at(-1) ?? '');
const botName = await jack.page.evaluate(
  () => Object.values(window.__flip7.store.state.players).find((p) => p.isBot).name,
);
check(
  'feed lines say who did what to whom',
  await jack.page.evaluate(() =>
    (window.__flip7.store.state.feed ?? []).every((l) => 'who' in l && 'to' in l),
  ),
);
check(
  "the bot's turn is described, not silent",
  feed.lines.some((l) => l.includes(botName)),
  feed.lines.join(' | ').slice(0, 140),
);

const summaryBoth =
  (await jack.page
    .waitForSelector('#modal-round:not([hidden])', { timeout: 8000 })
    .then(() => true)
    .catch(() => false)) &&
  (await sam.page
    .waitForSelector('#modal-round:not([hidden])', { timeout: 8000 })
    .then(() => true)
    .catch(() => false));
check('both phones get the round summary', summaryBoth);

// ── only the host deals again ─────────────────────────────────────────────
const roundBefore = (await state(jack.page)).round;
await sam.page.evaluate(() => window.__flip7.store.intent({ do: 'next-round' }));
await sam.page.waitForTimeout(700);
check(
  'a guest cannot deal the next round',
  (await state(sam.page)).round === roundBefore,
  `round ${(await state(sam.page)).round}`,
);

check(
  'the summary button names the round it will deal',
  /Deal round 2/.test(await jack.page.textContent('#btn-next-round')),
  await jack.page.textContent('#btn-next-round'),
);

await jack.page.click('#modal-round [data-close]');
const advanced = await jack.page
  .waitForFunction((r) => window.__flip7.store.state.round === r + 1, roundBefore, { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
check('the host deals the next round', advanced);

// The opening deal pauses if someone's first card is an action card, and if
// that someone is us the dealer is waiting on our target — so answer it.
let dealtAgain = false;
for (let i = 0; i < 30; i++) {
  const s = await state(jack.page);
  const me = await jack.page.evaluate(() => window.__flip7.store.myId);
  const hand = s?.players?.[me]?.hand;
  if ((hand?.numbers?.length ?? 0) + (hand?.mods?.length ?? 0) > 0 || hand?.chance) {
    dealtAgain = true;
    break;
  }
  // The pause may be on either phone's target, so answer whichever it is.
  for (const p of [jack, sam]) {
    const view = await state(p.page);
    const who = await p.page.evaluate(() => window.__flip7.store.myId);
    if (view?.pending?.byId === who) {
      await p.page.evaluate(
        (t) => window.__flip7.store.intent({ do: 'target', targetId: t }),
        view.pending.targets[0],
      );
    }
  }
  await jack.page.waitForTimeout(500);
}
check('and everyone gets fresh cards', dealtAgain);

// ── the Bust-O-meter is exact when the dealer knows the deck ──────────────
check(
  'the meter uses the exact remaining deck',
  await jack.page.evaluate(async () => {
    const { remaining } = await import('/js/odds.js');
    return remaining(window.__flip7.store.state).exact === true;
  }),
);

await browser.close();
cleanup();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
