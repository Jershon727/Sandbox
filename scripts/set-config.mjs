/**
 * Paste the Firebase config snippet in; this writes firebase-config.js.
 *
 *   npm run set-config          then paste, then Ctrl-D
 *   npm run set-config -- f.txt
 *
 * Worth doing rather than editing by hand because of one trap: the console's
 * snippet only includes `databaseURL` if a Realtime Database already exists.
 * Paste it without one and everything looks filled in, yet online rooms stay
 * dead. This checks for that specifically and says so.
 */

import { readFile, writeFile } from 'node:fs/promises';

const CONFIG = new URL('../public/firebase-config.js', import.meta.url);
const FIREBASERC = new URL('../.firebaserc', import.meta.url);

const FIELDS = [
  'apiKey',
  'authDomain',
  'databaseURL',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];
const REQUIRED = ['apiKey', 'databaseURL', 'projectId'];

async function input() {
  const file = process.argv[2];
  if (file) return readFile(file, 'utf8');
  if (process.stdin.isTTY) {
    console.log('Paste the config from the Firebase console, then press Ctrl-D:\n');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await input();

// Accept whatever shape they pasted: the full `const firebaseConfig = {...};`
// snippet, a bare object, or JSON.
const found = {};
for (const field of FIELDS) {
  const match = raw.match(new RegExp(`["']?${field}["']?\\s*:\\s*["']([^"']+)["']`));
  if (match) found[field] = match[1].trim();
}

if (!Object.keys(found).length) {
  console.error(`
✗ Nothing recognisable in that.

  Expected the snippet from Firebase console → Project settings → General →
  Your apps → SDK setup and configuration → Config, which looks like:

    const firebaseConfig = {
      apiKey: "AIza...",
      authDomain: "your-project.firebaseapp.com",
      databaseURL: "https://your-project-default-rtdb.firebaseio.com",
      projectId: "your-project",
      appId: "1:123:web:abc"
    };
`);
  process.exit(1);
}

const missing = REQUIRED.filter((f) => !found[f]);

if (missing.includes('databaseURL')) {
  console.error(`
✗ That config has no databaseURL, so there is no database to sync through.

  The console leaves it out until a Realtime Database exists. Create one:
    Build → Realtime Database → Create Database

  Then copy the config again — it will include databaseURL — and re-run this.
`);
  process.exit(1);
}

if (missing.length) {
  console.error(`✗ Missing required field(s): ${missing.join(', ')}`);
  process.exit(1);
}

if (!/^https?:\/\//.test(found.databaseURL)) {
  console.error(`✗ databaseURL should be a URL, got: ${found.databaseURL}`);
  process.exit(1);
}

const header = (await readFile(CONFIG, 'utf8')).split('export const')[0].trimEnd();
const body = FIELDS.filter((f) => found[f])
  .map((f) => `  ${f}: '${found[f].replace(/'/g, "\\'")}',`)
  .join('\n');

await writeFile(CONFIG, `${header}\n\nexport const firebaseConfig = {\n${body}\n};\n`);
console.log(`✓ Wrote public/firebase-config.js (${Object.keys(found).length} fields)`);

// Keep the deploy target in step with the project the config points at.
try {
  const rc = JSON.parse(await readFile(FIREBASERC, 'utf8'));
  const current = rc.projects?.default;
  if (current !== found.projectId) {
    rc.projects = { ...rc.projects, default: found.projectId };
    await writeFile(FIREBASERC, `${JSON.stringify(rc, null, 2)}\n`);
    console.log(`✓ Deploy target set to ${found.projectId}${current ? ` (was ${current})` : ''}`);
  }
} catch {
  await writeFile(
    FIREBASERC,
    `${JSON.stringify({ projects: { default: found.projectId } }, null, 2)}\n`,
  );
  console.log(`✓ Created .firebaserc for ${found.projectId}`);
}

console.log('\nNext:  npx firebase login    then    npm run deploy');
