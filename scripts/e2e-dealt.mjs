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

/**
 * Who the deal never reached.
 *
 * "Everyone is holding a card" is the wrong bar and keeps looking like a bug: a
 * player dealt Freeze or Flip Three plays it the instant it lands and holds
 * nothing, while being very much in the round. What must be true is that a card
 * reached every seat — and every card that lands puts its player in the round's
 * account, so the account is the honest test.
 */
const notDealtTo = (room) => {
  const named = new Set((room.feed ?? []).flatMap((l) => [l.who, l.to]).filter(Boolean));
  return Object.entries(room.players ?? {})
    .filter(([id]) => !named.has(id))
    .map(([, p]) => p.name);
};

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
  // A turn being on offer means the whole opening deal got through.
  if (st.turnId || st.roundOver) break;
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
  'and the round-one deal reached every player, not just the host',
  notDealtTo(roundOne).length === 0,
  notDealtTo(roundOne).join(', '),
);
check('now the deck has been dealt from', roundOne.deckLeft > 0 && roundOne.deckLeft < 94);
check(
  'and the client is told the remaining composition, which anyone could count',
  !!roundOne.deckTally && roundOne.deckTally.total === roundOne.deckLeft,
);

// ── knowing it is your turn ───────────────────────────────────────────────
// A phone spends most of a round face-down. The cues have to work at a glance.
const onTurn = await jack.page
  .waitForFunction(
    () => {
      const s = window.__flip7.store;
      return s.state?.turnId && !s.state.pending ? s.state.turnId : false;
    },
    null,
    { timeout: 20000 },
  )
  .then((h) => h.jsonValue())
  .catch(() => null);

if (onTurn) {
  const jackId = await jack.page.evaluate(() => window.__flip7.store.myId);
  const up = onTurn === jackId ? jack : onTurn === samId ? sam : null;

  if (up) {
    const cues = await up.page.evaluate(() => ({
      turn: document.getElementById('dealt').dataset.turn,
      status: document.getElementById('dealt-status').textContent,
      actions: !document.getElementById('dealt-actions').hidden,
      handRing: document.getElementById('hand-card').classList.contains('is-turn'),
      stay: document.getElementById('dstay-sub').textContent,
      chip: [
        ...document.querySelectorAll(
          `.stand[data-player="${window.__flip7.store.myId}"] .chip`,
        ),
      ].map((c) => c.textContent),
    }));
    check("the phone on turn is marked as the player's own turn", cues.turn === 'mine', cues.turn);
    check('and says so in words', /your turn/i.test(cues.status), cues.status);
    check('and offers hit and stay', cues.actions);
    check('and rings the hand the dealer is waiting on', cues.handRing);
    check('and the stay button names what it would bank', /^bank \d+$/.test(cues.stay), cues.stay);
    check(
      'and the scoreboard row says "your turn"',
      cues.chip.includes('your turn'),
      cues.chip.join(','),
    );

    const other = up === jack ? sam : jack;
    const theirs = await other.page.evaluate(() => ({
      turn: document.getElementById('dealt').dataset.turn,
      status: document.getElementById('dealt-status').textContent,
      actions: !document.getElementById('dealt-actions').hidden,
    }));
    check('the other phone is not told it is theirs', theirs.turn === 'theirs', theirs.turn);
    check('and names who the table is waiting on', /is playing/.test(theirs.status), theirs.status);
    check('and is offered nothing to tap', theirs.actions === false);
  } else {
    results.push('· turn-cue check skipped: a bot was on turn');
  }
} else {
  results.push('· turn-cue check skipped: no human turn came up');
}

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
// Evidence for the four things a player has to be able to see, collected as the
// game happens to produce them.
const seen = { aim: null, killer: null, banked: null };

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
      // Before answering: is the card on screen, and does it say what to do?
      seen.aim ??= await p.page.evaluate(() => ({
        shown: !document.getElementById('aim').hidden,
        cards: document.querySelectorAll('#aim-card .card').length,
        text: document.getElementById('aim-text').textContent,
        turn: document.getElementById('dealt').dataset.turn,
        targets: document.querySelectorAll('.stand.is-target').length,
      }));
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

    // Did anything land that a player must be able to read back?
    const after = await state(p.page);
    const mine = after?.players?.[me];
    if (mine?.hand?.busted && !seen.killer) {
      seen.killer = await p.page.evaluate(() => ({
        bustCard: window.__flip7.store.state.players[window.__flip7.store.myId].hand.bustCard,
        killers: document.querySelectorAll('#hand .card.is-killer').length,
        clashes: document.querySelectorAll('#hand .card.is-clash').length,
        status: document.getElementById('dealt-status').textContent,
      }));
    }
    if (mine?.state === 'stayed' && !mine.waiting && !seen.banked) {
      const line = (after.feed ?? []).filter((l) => l.type === 'stay' && l.who === me).at(-1);
      if (line) {
        seen.banked = {
          score: line.score,
          status: await p.page.textContent('#dealt-status'),
          round: await p.page.evaluate(
            (id) => document.querySelector(`.stand[data-player="${id}"] .stand__round`)?.textContent,
            me,
          ),
        };
      }
    }
  }
  await jack.page.waitForTimeout(300);
}

check('a person got to act within two rounds', acted > 0, `acted ${acted}`);

// ── the action card you have to aim ───────────────────────────────────────
if (seen.aim) {
  check('an action card to aim shows the card itself', seen.aim.cards === 1, JSON.stringify(seen.aim));
  check(
    'and says which card it is and what tapping does',
    /Freeze|Flip Three|Second Chance/.test(seen.aim.text) && /tap/i.test(seen.aim.text),
    seen.aim.text,
  );
  check('and marks the rows that can be tapped', seen.aim.targets > 0, `${seen.aim.targets}`);
  check('and the turn cue says you are aiming, not playing', seen.aim.turn === 'aim', seen.aim.turn);
} else {
  results.push('· aim-panel check skipped: no action card reached a phone');
}

// ── busting shows you the card ────────────────────────────────────────────
if (seen.killer) {
  check(
    'a busted hand is told which card busted it',
    !!seen.killer.bustCard,
    JSON.stringify(seen.killer.bustCard),
  );
  check('and the card is on screen, marked', seen.killer.killers === 1, `${seen.killer.killers}`);
  check(
    'with the duplicate it clashed with marked too',
    seen.killer.bustCard?.kind !== 'number' || seen.killer.clashes >= 1,
    `${seen.killer.clashes}`,
  );
  check('and the status says you busted', /busted/i.test(seen.killer.status), seen.killer.status);
} else {
  results.push('· bust-card check skipped: nobody busted');
}

// ── staying reads as banked, not as idle ──────────────────────────────────
if (seen.banked) {
  check(
    'a stay is reported with the score it banked',
    typeof seen.banked.score === 'number',
    JSON.stringify(seen.banked),
  );
  check(
    'the status says what you banked rather than going quiet',
    /banked \d+/i.test(seen.banked.status) || /round over/i.test(seen.banked.status),
    seen.banked.status,
  );
  check(
    'and the scoreboard marks it settled rather than still in play',
    /[✓❄★]/.test(seen.banked.round ?? '') || /bust/.test(seen.banked.round ?? ''),
    seen.banked.round ?? '',
  );
} else {
  results.push('· banked check skipped: nobody stayed');
}
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
  check(
    'and the account of the new round names every player in it',
    notDealtTo(dealtAgain).length === 0,
    notDealtTo(dealtAgain).join(', '),
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

// ── the cues a live game only produces by luck ────────────────────────────
// Whether an action card reaches a phone, and whether anyone busts, is up to the
// shuffle — so the checks above skip when the cards don't cooperate. These pin
// the rendering down directly instead: push a room in each state and read the DOM.
const rendered = await jack.page.evaluate(() => {
  const { store } = window.__flip7;
  const me = store.myId;
  const them = 'rival-seat';
  const hand = (over = {}) => ({
    numbers: [],
    mods: [],
    chance: false,
    busted: false,
    bustCard: null,
    ...over,
  });
  const seat = (name, over = {}) => ({
    name,
    order: 0,
    total: 20,
    history: [],
    state: 'active',
    waiting: false,
    lastSeen: Date.now(),
    hand: hand(),
    ...over,
  });

  const base = {
    code: store.state.code,
    kind: 'dealt',
    target: 200,
    round: 3,
    hostId: me,
    lobby: false,
    status: 'playing',
    roundOver: false,
    turnId: null,
    pending: null,
    feed: [],
    lastRound: null,
    deckLeft: 60,
    deckTally: store.state.deckTally,
    players: {
      [me]: seat('Jack'),
      [them]: seat('Nova', { order: 1, total: 30, isBot: true, hand: hand({ numbers: [4] }) }),
    },
  };
  const show = (room) => {
    store.state = room;
    store._emit();
  };
  const mine = (over) => ({ ...base.players[me], ...over });

  // (a) You drew Flip Three and have to point it at somebody.
  show({
    ...base,
    pending: { action: 'flip3', card: { kind: 'action', action: 'flip3' }, byId: me, targets: [me, them] },
  });
  const aim = {
    shown: !document.getElementById('aim').hidden,
    cards: document.querySelectorAll('#aim-card .card[data-action="flip3"]').length,
    text: document.getElementById('aim-text').textContent,
    turn: document.getElementById('dealt').dataset.turn,
    targets: document.querySelectorAll('.stand.is-target').length,
    status: document.getElementById('dealt-status').textContent,
  };

  // (b) Somebody else is aiming one, and it is not your decision.
  show({
    ...base,
    pending: {
      action: 'freeze',
      card: { kind: 'action', action: 'freeze' },
      byId: them,
      targets: [me, them],
    },
  });
  const theirAim = {
    shown: !document.getElementById('aim').hidden,
    status: document.getElementById('dealt-status').textContent,
  };

  // (c) A second 9 busted you.
  show({
    ...base,
    players: {
      ...base.players,
      [me]: mine({
        state: 'busted',
        hand: hand({ numbers: [9, 4], busted: true, bustCard: { kind: 'number', value: 9 } }),
      }),
    },
  });
  const bust = {
    killers: [...document.querySelectorAll('#hand .card.is-killer')].map((c) => c.dataset.value),
    clashes: [...document.querySelectorAll('#hand .card.is-clash')].map((c) => c.dataset.value),
    flag: document.getElementById('flag').hidden
      ? null
      : document.getElementById('flag').textContent,
    status: document.getElementById('dealt-status').textContent,
  };

  // (d) You were frozen out, holding 7.
  show({
    ...base,
    players: { ...base.players, [me]: mine({ state: 'frozen', hand: hand({ numbers: [7] }) }) },
  });
  const frozen = {
    flag: document.getElementById('flag').hidden
      ? null
      : document.getElementById('flag').textContent,
    status: document.getElementById('dealt-status').textContent,
    chips: [...document.querySelectorAll(`.stand[data-player="${me}"] .chip`)].map(
      (c) => c.textContent,
    ),
    round: document.querySelector(`.stand[data-player="${me}"] .stand__round`)?.textContent,
  };

  // (e) You banked 7 and are waiting the round out.
  show({
    ...base,
    players: { ...base.players, [me]: mine({ state: 'stayed', hand: hand({ numbers: [7] }) }) },
  });
  const banked = {
    flag: document.getElementById('flag').hidden
      ? null
      : document.getElementById('flag').textContent,
    status: document.getElementById('dealt-status').textContent,
    round: document.querySelector(`.stand[data-player="${me}"] .stand__round`)?.textContent,
  };

  return { aim, theirAim, bust, frozen, banked };
});

check('aiming an action card shows the card', rendered.aim.shown && rendered.aim.cards === 1, JSON.stringify(rendered.aim));
check(
  'and names it and says tapping a player is the move',
  /Flip Three/.test(rendered.aim.text) && /tap/i.test(rendered.aim.text),
  rendered.aim.text,
);
check('and marks every tappable row', rendered.aim.targets === 2, `${rendered.aim.targets}`);
check('and the turn cue reads as aiming', rendered.aim.turn === 'aim', rendered.aim.turn);
check('somebody else aiming does not offer you the choice', rendered.theirAim.shown === false);
check(
  'but does say who drew what',
  /Nova drew Freeze/.test(rendered.theirAim.status),
  rendered.theirAim.status,
);

check(
  'busting marks the card that did it',
  rendered.bust.killers.length === 1 && rendered.bust.killers[0] === '9',
  JSON.stringify(rendered.bust.killers),
);
check(
  'and marks the duplicate it clashed with',
  rendered.bust.clashes.includes('9'),
  JSON.stringify(rendered.bust.clashes),
);
check('and flags the hand as busted', rendered.bust.flag === 'Busted', String(rendered.bust.flag));
check('and says so in the status', /busted/i.test(rendered.bust.status), rendered.bust.status);

check('being frozen flags the hand', rendered.frozen.flag === 'Frozen', String(rendered.frozen.flag));
check(
  'and the status says why you cannot play',
  /frozen out/i.test(rendered.frozen.status),
  rendered.frozen.status,
);
check('and the scoreboard says frozen', rendered.frozen.chips.includes('frozen'), rendered.frozen.chips.join(','));
check('with the score it was frozen on', rendered.frozen.round === '+7 ❄', String(rendered.frozen.round));

check('banking flags the hand', rendered.banked.flag === 'Banked', String(rendered.banked.flag));
check(
  'and the status says what you banked',
  /banked 7/i.test(rendered.banked.status),
  rendered.banked.status,
);
check('and the scoreboard shows it settled', rendered.banked.round === '+7 ✓', String(rendered.banked.round));

await browser.close();
cleanup();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
