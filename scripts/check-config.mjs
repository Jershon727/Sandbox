/**
 * Pre-deploy guard.
 *
 * A deploy with the placeholder Firebase config succeeds, serves a working app,
 * and quietly has no online rooms — the failure you'd only notice with friends
 * sitting around a table. So make it loud here instead.
 *
 * Deliberately shipping single-phone mode is fine: `npm run deploy:offline`.
 */

import { readFile } from 'node:fs/promises';

const CONFIG = new URL('../public/firebase-config.js', import.meta.url);
const allowOffline = process.argv.includes('--allow-offline');

const source = await readFile(CONFIG, 'utf8').catch(() => null);

if (source === null) {
  console.error('✗ public/firebase-config.js is missing.');
  process.exit(1);
}

const placeholders = [...source.matchAll(/^\s*(\w+):\s*'(PASTE_[^']*)'/gm)].map((m) => m[1]);

if (!placeholders.length) {
  console.log('✓ Firebase config is filled in — online rooms will work.');
  process.exit(0);
}

if (allowOffline) {
  console.log('› Deploying without a Firebase config: single-phone scoring only.');
  process.exit(0);
}

console.error(`
✗ public/firebase-config.js still has placeholder values:
    ${placeholders.join(', ')}

  Deploying like this works, but there is no database behind it — nobody can
  join a room, and the app will only keep score on one device.

  Fill it in from the Firebase console:
    Project settings → General → Your apps → SDK setup and configuration

  You also need a Realtime Database:
    Build → Realtime Database → Create Database

  Or, to ship single-phone mode on purpose:
    npm run deploy:offline
`);
process.exit(1);
