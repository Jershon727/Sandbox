/**
 * Build a single self-contained HTML file.
 *
 * Useful for sharing the game as one file, and required by sandboxes that block
 * external requests entirely (no separate .css/.js, no font CDN).
 *
 *   node scripts/bundle.mjs              → dist/flip7.html         (standalone)
 *   node scripts/bundle.mjs --fragment   → dist/flip7.fragment.html (no <html> wrapper)
 *
 * The JS is flattened rather than kept as separate modules, which is only safe
 * while every top-level name across the modules is unique — so the build fails
 * loudly if two modules ever declare the same one.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('../public/', import.meta.url);
const OUT = new URL('../dist/', import.meta.url);
const fragmentOnly = process.argv.includes('--fragment');

/** Dependency order: every module appears after everything it imports. */
const MODULES = [
  'rng.js',
  'scoring.js',
  'cards.js',
  'room.js',
  'odds.js',
  'engine.js',
  'ai.js',
  'dealer.js',
  'table.js',
  'storage.js',
  'avatar.js',
  'views.js',
  'sound.js',
  'fx.js',
  'cardview.js',
  'sync-local.js',
  'store.js',
  'scorer.js',
  'main.js',
];

const read = (path) => readFile(new URL(path, ROOT), 'utf8');

/** Strip the module syntax, leaving plain script-scope code. */
function flatten(source) {
  return (
    source
      // import ... from '...';  (including multi-line named imports)
      .replace(/^import\s[\s\S]*?from\s*'[^']*';[ \t]*$/gm, '')
      // export { a, b };  re-export lists
      .replace(/^export\s*\{[^}]*\}\s*;[ \t]*$/gm, '')
      // export const / function / class / async function
      .replace(/^export\s+(?=(?:const|let|var|function|async|class)\b)/gm, '')
      .trim()
  );
}

const TOP_LEVEL =
  /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)|^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;

function declaredNames(source) {
  const names = [];
  for (const m of source.matchAll(TOP_LEVEL)) names.push(m[1] ?? m[2]);
  return names;
}

// ── collect and check ─────────────────────────────────────────────────────

const parts = [];
const owner = new Map();
const clashes = [];

for (const name of MODULES) {
  const flat = flatten(await read(`js/${name}`));
  for (const decl of declaredNames(flat)) {
    if (owner.has(decl)) clashes.push(`${decl} — in both ${owner.get(decl)} and ${name}`);
    else owner.set(decl, name);
  }
  parts.push(`/* ── ${name} ─────────────────────────────── */\n${flat}`);
}

if (clashes.length) {
  console.error('Cannot flatten: duplicate top-level names.\n');
  for (const c of clashes) console.error(`  ✗ ${c}`);
  console.error('\nRename one of each pair, then rebuild.');
  process.exit(1);
}

let js = parts.join('\n\n');

// Tell the app it is a single file: there are no sibling modules to import, so
// the online backend must not even be attempted.
js = `globalThis.__FLIP7_SINGLE_FILE = true;\n\n${js}`;

// The service worker lives at a URL that doesn't exist in a single file, so the
// app skips registering it when __FLIP7_SINGLE_FILE is set. That used to be done
// here by cutting the block out with a regex, which broke the moment the code
// was reshaped — a runtime check the source states outright is harder to lose.
if (!/Store\.singleFile\) return;/.test(js)) {
  console.error('The single-file guard on the service worker registration has gone missing.');
  process.exit(1);
}

const css = await read('css/styles.css');
const html = await read('index.html');

// ── pull the pieces out of index.html ─────────────────────────────────────

const pick = (re, what) => {
  const m = html.match(re);
  if (!m) {
    console.error(`Could not find ${what} in index.html`);
    process.exit(1);
  }
  return m[1];
};

const sprite = pick(/(<svg class="sprite"[\s\S]*?<\/svg>)/, 'the icon sprite');
// Everything from the effects canvas down to the module script tag: the app
// markup and every dialog.
const body = pick(
  /(<canvas id="fx"[\s\S]*?)\s*<script type="module"/,
  'the app markup',
);

for (const required of ['id="fx"', 'screen-room', 'screen-join', 'modal-rules', 'standings', 'id="pad"']) {
  if (!body.includes(required)) {
    console.error(`The extracted markup is missing ${required} — check index.html's structure.`);
    process.exit(1);
  }
}

// The single-file build has no font CDN, so state the fallback stack explicitly
// rather than letting a failed webfont decide the typography.
const fontFix = `
    /* Single-file build: no webfont request, so the stack is the design. */
    :root {
      --font: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto,
        'Helvetica Neue', Arial, sans-serif;
    }`;

const inner = `${sprite}
${body}
    <style>
${css}
${fontFix}
    </style>
    <script type="module">
${js}
    </script>`;

await mkdir(OUT, { recursive: true });

if (fragmentOnly) {
  const file = new URL('flip7.fragment.html', OUT);
  await writeFile(file, `<title>Flip 7</title>\n${inner}\n`);
  console.log(`dist/flip7.fragment.html — ${Math.round((inner.length / 1024) * 10) / 10} KB`);
} else {
  const page = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Flip 7 — keep score together</title>
    <meta name="theme-color" content="#0a0918" />
  </head>
  <body>
${inner}
  </body>
</html>
`;
  const file = new URL('flip7.html', OUT);
  await writeFile(file, page);
  console.log(`dist/flip7.html — ${Math.round((page.length / 1024) * 10) / 10} KB`);
}
