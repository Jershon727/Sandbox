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

// ── a new table waits in a lobby ──────────────────────────────────────────
// Dealing the moment the room is made would mean the host is the only person in
// it, and everyone who joined next would have to sit out round one.
check('a new table waits for players rather than dealing', view.lobby === true && view.round === 0);
check('no cards have moved yet', view.deckLeft === 0);
check('the host is offered the deal', await jack.page.locator('#btn-deal-next').isVisible());

// ── the deck stays with the dealer ────────────────────────────────────────
check('the client is never sent the deck', !('deck' in view) && !('discard' in view));
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

const samId = await sam.page.evaluate(() => window.__flip7.store.myId);
check(
  'the seat the guest plays is the seat the dealer dealt',
  !!(await state(sam.page)).players[samId],
  samId,
);
check('a guest waiting in the lobby is not marked as sitting out', (await state(sam.page)).players[samId].waiting === false);

// A guest cannot open the game — the host waits until everyone is in.
await sam.page.evaluate(() => window.__flip7.store.intent({ do: 'next-round' }));
await sam.page.waitForTimeout(600);
check('a guest cannot deal the first round', (await state(sam.page)).lobby === true);

// ── the host deals, and everybody is in round one ─────────────────────────
// This is the check behind "my friends didn't get a turn": whoever is in the room
// when the host deals must be holding cards in round one.
await jack.page.click('#btn-deal-next');
const opened = await jack.page
  .waitForFunction(() => window.__flip7.store.state?.round === 1, null, { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
check('the host deals the first round', opened);

// The opening deal can pause on somebody's action card; answer whoever it waits on.
for (let i = 0; i < 40; i++) {
  const st = await state(jack.page);
  if (!st) break;
  const dealtAll = Object.values(st.players).every(
    (p) => p.hand.numbers.length + p.hand.mods.length > 0 || p.hand.chance,
  );
  if (dealtAll || st.turnId || st.roundOver) break;
  for (const p of [jack, sam]) {
    const s = await state(p.page);
    const who = await p.page.evaluate(() => window.__flip7.store.myId);
    if (s?.pending?.byId === who) {
      await p.page.evaluate(
        (t) => window.__flip7.store.intent({ do: 'target', targetId: t }),
        s.pending.targets[0],
      );
    }
  }
  await jack.page.waitForTimeout(300);
}

const roundOne = await state(jack.page);
check(
  'everyone in the room is dealt into round one, nobody sitting it out',
  Object.values(roundOne.players).every((p) => p.waiting === false),
  JSON.stringify(Object.values(roundOne.players).map((p) => [p.name, p.waiting])),
);
check(
  'and both people were dealt a hand, not just the host',
  [await jack.page.evaluate(() => window.__flip7.store.myId), samId].every((id) => {
    const h = roundOne.players[id].hand;
    return h.numbers.length + h.mods.length > 0 || h.chance || roundOne.players[id].state !== 'active';
  }),
);
check('now the deck has been dealt from', roundOne.deckLeft > 0 && roundOne.deckLeft < 94);
check(
  'and the client is told the remaining composition, which anyone could count',
  !!roundOne.deckTally && roundOne.deckTally.total === roundOne.deckLeft,
);

// ── you cannot play out of turn ───────────────────────────────────────────
// Which player is up is not ours to choose — the dealer decides, and a bot can
// freeze someone out before their first turn. So ask whoever *isn't* up.
const upNow = await jack.page
  .waitForFunction(() => window.__flip7.store.state?.turnId ?? null, null, { timeout: 20000 })
  .then((h) => h.jsonValue())
  .catch(() => null);

if (upNow) {
  // Watch for the dealer's refusal rather than comparing room snapshots: the
  // game is running, so the room changes for legitimate reasons while we look.
  const askOutOfTurn = (p) =>
    p.page.evaluate(
      () =>
        new Promise((resolve) => {
          const store = window.__flip7.store;
          const off = store.onError((err) => {
            off();
            resolve(err.code ?? 'error');
          });
          store.intent({ do: 'hit' });
          setTimeout(() => {
            off();
            resolve(null);
          }, 1200);
        }),
    );

  // Whose turn it is can turn over between reading it and asking, so retry: a
  // hit that lands means we caught them on turn, not that the dealer allowed it.
  let refusal = null;
  for (let attempt = 0; attempt < 6 && !refusal; attempt++) {
    const st = await state(jack.page);
    const jackId = await jack.page.evaluate(() => window.__flip7.store.myId);
    if (!st?.turnId || st.roundOver) break;
    refusal = await askOutOfTurn(st.turnId === jackId ? sam : jack);
  }
  check(
    'the dealer refuses a hit from someone whose turn it is not',
    refusal === 'not-your-turn' || refusal === 'not-now',
    String(refusal),
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
//
// "Everyone is holding a card" is the wrong bar: a player dealt Freeze or Flip
// Three plays it straight away and holds nothing, while still being very much in
// the round. The bar that matters to a player is that the round's account names
// everyone the cards went to — nobody silently absent from it.
let dealtAgain = null;
for (let i = 0; i < 40; i++) {
  const s = await state(jack.page);
  if (!s) break;
  // A turn being on offer means the whole opening deal got through.
  if (s.turnId || s.roundOver) {
    dealtAgain = s;
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
  await jack.page.waitForTimeout(400);
}
check('and the fresh deal gets all the way round the table', !!dealtAgain);
if (dealtAgain) {
  const named = new Set(dealtAgain.feed.flatMap((l) => [l.who, l.to]).filter(Boolean));
  const missing = Object.entries(dealtAgain.players)
    .filter(([id]) => !named.has(id))
    .map(([, p]) => p.name);
  check(
    'and the account of the new round names every player in it',
    missing.length === 0,
    missing.join(', '),
  );
}

// ── someone arriving mid-round is told they're sitting it out ─────────────
// They genuinely can't be dealt into a hand already on the table. What broke
// before was saying nothing about it, which reads as the app skipping them.
const mo = await phone('mo');
await mo.page.click('[data-goto="join"]');
await mo.page.fill('#join-code', code);
await mo.page.fill('#join-name', 'Mo');
await mo.page.click('#btn-join');
const moSeated = await mo.page
  .waitForFunction(() => window.__flip7.store.state?.kind === 'dealt', null, { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('a latecomer can still join', moSeated);

if (moSeated) {
  const moId = await mo.page.evaluate(() => window.__flip7.store.myId);
  const moView = await state(mo.page);
  check('and is marked as sitting this round out', moView.players[moId]?.waiting === true);
  check(
    'their own screen says why they are not being dealt to',
    /sit out round|dealt in next round/i.test(await mo.page.textContent('#dealt-status')),
    await mo.page.textContent('#dealt-status'),
  );
  check(
    'the table shows them as next round, not as having stayed',
    await mo.page.evaluate(
      (id) =>
        [...document.querySelectorAll(`.stand[data-player="${id}"] .chip`)].some(
          (c) => c.textContent === 'next round',
        ),
      moId,
    ),
  );
  check(
    'and the account of the round says they arrived',
    (await state(jack.page)).feed.some((l) => l.type === 'join' && /Mo joined/.test(l.text)),
  );

  // The next deal brings them in properly — but the round in progress has to
  // finish first, so play it out.
  for (let i = 0; i < 60; i++) {
    const st = await state(jack.page);
    if (!st || st.roundOver || st.status === 'finished') break;
    for (const p of [jack, sam]) {
      const s = await state(p.page);
      const who = await p.page.evaluate(() => window.__flip7.store.myId);
      if (s?.pending?.byId === who) {
        await p.page.evaluate(
          (t) => window.__flip7.store.intent({ do: 'target', targetId: t }),
          s.pending.targets[0],
        );
      } else if (s?.turnId === who) {
        await p.page.evaluate(() => window.__flip7.store.intent({ do: 'stay' }));
      }
    }
    await jack.page.waitForTimeout(350);
  }
  check('the round in progress closes', (await state(jack.page)).roundOver === true);

  await jack.page.evaluate(() => window.__flip7.store.intent({ do: 'next-round' }));
  const moDealtIn = await mo.page
    .waitForFunction(
      () => window.__flip7.store.state.players[window.__flip7.store.myId]?.waiting === false,
      null,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('the next deal brings the latecomer in', moDealtIn);
}

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
