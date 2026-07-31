/**
 * Does it fit on the phone in your hand?
 *
 * The room screen is a fixed screen, not a document: the scoreboard scrolls
 * inside itself when the table is big, and everything below it — your hand, the
 * keypad, Hit and Stay — must stay reachable. This measures that on real iPhone
 * viewports, because "it looked fine on mine" is how the controls ended up off
 * the bottom of an SE in the first place.
 *
 *   node scripts/e2e-fit.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 5177);
const BASE = process.env.BASE ?? `http://localhost:${PORT}`;

/**
 * Height available to the page in Safari, portrait, with the address bar and
 * toolbar showing — which is the state a phone is actually in.
 */
const PHONES = [
  { name: 'iPhone SE', w: 375, h: 553 },
  { name: 'iPhone 13 mini', w: 375, h: 629 },
  { name: 'iPhone 14/15', w: 390, h: 664 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 745 },
];

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const started = [];
const up = async (url, attempts = 60) => {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return false;
};

if (!(await up(BASE, 1))) {
  started.push(
    spawn(process.execPath, ['scripts/serve.mjs'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (!(await up(BASE))) {
    console.error(`Could not serve the app on ${BASE}`);
    process.exit(1);
  }
}
process.on('exit', () => started.forEach((s) => s.kill()));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

/** What must stay on screen, and whether anything is scrolling that shouldn't. */
const measure = (page) =>
  page.evaluate(() => {
    const screen = document.querySelector('.screen.is-active');
    const seen = (el) => {
      if (!el || el.hidden || el.offsetParent === null) return null;
      const b = el.getBoundingClientRect();
      return {
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
        onScreen: b.top >= -1 && b.bottom <= window.innerHeight + 1,
      };
    };
    return {
      viewport: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      screenOverflow: screen.scrollHeight - screen.clientHeight,
      standingsScrolls: (() => {
        const s = document.getElementById('standings');
        return s.scrollHeight > s.clientHeight + 1;
      })(),
      must: {
        topbar: seen(document.querySelector('.topbar--room')),
        hand: seen(document.getElementById('hand-card')),
        pad: seen(document.getElementById('pad')),
        dealt: seen(document.getElementById('dealt')),
        actions: seen(document.getElementById('dealt-actions')),
        foot: seen(document.querySelector('.tally__foot')),
      },
    };
  });

for (const phone of PHONES) {
  for (const mode of ['scoring', 'dealt']) {
    const ctx = await browser.newContext({ viewport: { width: phone.w, height: phone.h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${phone.name}/${mode}: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem('flip7:relay', 'same-origin'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !!window.__flip7);

    await page.click('[data-goto="host"]');
    await page.fill('#host-name', 'Jack');
    if (mode === 'dealt') {
      await page.evaluate(() => {
        [...document.querySelectorAll('#host-cards .seg__opt')]
          .find((b) => b.textContent === 'Deal for us')
          ?.click();
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        [...document.querySelectorAll('#host-bots .seg__opt')]
          .find((b) => b.textContent === '3')
          ?.click();
      });
    }
    await page.click('#btn-host');
    await page.waitForFunction(() => window.__flip7.store.state, null, { timeout: 8000 });

    // A full table, because that's the case that overflows.
    await page.evaluate(async () => {
      for (const n of ['Sam', 'Mo']) await window.__flip7.store.addPlayer(n);
    });
    await page.waitForTimeout(300);

    if (mode === 'dealt') {
      await page.click('#btn-deal-next').catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      await page.evaluate(async () => {
        const s = window.__flip7.store;
        const paths = {};
        Object.keys(s.state.players).forEach((id, i) => {
          paths[`players/${id}/hand`] = {
            numbers: [4, 9, 12].slice(0, (i % 3) + 1),
            mods: i % 2 ? [{ op: 'add', value: 4 }] : [],
            chance: false,
            busted: false,
          };
          paths[`players/${id}/total`] = 40 + i * 13;
        });
        await s.update(paths);
      });
      await page.waitForTimeout(300);
    }

    const m = await measure(page);
    const where = `${phone.name} ${mode}`;

    check(`${where}: the page itself never scrolls`, m.pageScroll <= 0, `${m.pageScroll}px over`);
    check(`${where}: nothing overflows the screen`, m.screenOverflow <= 0, `${m.screenOverflow}px over`);

    for (const [part, box] of Object.entries(m.must)) {
      if (!box) continue;
      check(`${where}: ${part} is fully on screen`, box.onScreen, `${box.top}→${box.bottom} of ${m.viewport}`);
    }

    await ctx.close();
  }
}

// ── the setup screens ─────────────────────────────────────────────────────
// They're forms, so they may be taller than the phone — but their own button has
// to be reachable by scrolling. Checked on the shortest phone only: if it fits
// there it fits everywhere.
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 553 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`setup: ${e.message}`));
  await page.addInitScript(() => localStorage.setItem('flip7:relay', 'same-origin'));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__flip7);

  for (const [screen, button] of [
    ['host', '#btn-host'],
    ['join', '#btn-join'],
  ]) {
    await page.click(`[data-goto="${screen}"]`);
    if (screen === 'host') {
      // The longest form: dealing shows the bot fields as well as the mode.
      await page.evaluate(() => {
        [...document.querySelectorAll('#host-cards .seg__opt')]
          .find((b) => b.textContent === 'Deal for us')
          ?.click();
      });
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(150);

    // Scroll whatever the inner scroller is, the way a thumb would.
    await page.evaluate(() => {
      const el = document.querySelector('.screen.is-active');
      for (const s of [el, ...el.querySelectorAll('*')]) {
        if (s.scrollHeight > s.clientHeight + 1) s.scrollTop = s.scrollHeight;
      }
    });
    await page.waitForTimeout(200);

    const reach = await page.evaluate((sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { bottom: Math.round(b.bottom), top: Math.round(b.top), viewport: window.innerHeight };
    }, button);
    check(
      `iPhone SE ${screen}: the form's own button can be reached`,
      reach.bottom <= reach.viewport && reach.top >= 0,
      `${reach.top}→${reach.bottom} of ${reach.viewport}`,
    );
    await page.click('[data-goto="home"]').catch(() => {});
  }
  await ctx.close();
}

await browser.close();

console.log(results.join('\n'));
if (errors.length) {
  console.log('\npage errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || errors.length ? 1 : 0);
