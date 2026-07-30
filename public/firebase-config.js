/**
 * Firebase project config — paste yours in to switch on online rooms.
 *
 * Where to find it: Firebase console → your project → Project settings →
 * General → "Your apps" → SDK setup and configuration → Config.
 *
 * You also need a Realtime Database (Build → Realtime Database → Create), and
 * the `databaseURL` below must be that database's URL. Deploy the access rules
 * in database.rules.json with:
 *
 *     firebase deploy --only database,hosting
 *
 * Until this is filled in, the app runs in same-device mode: one phone can keep
 * score for the whole table, but scores won't sync to anyone else.
 *
 * These values are not secrets — a web Firebase config is public by design, and
 * database.rules.json is what actually controls access.
 */

export const firebaseConfig = {
  apiKey: 'PASTE_YOUR_API_KEY',
  authDomain: 'PASTE_YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'PASTE_YOUR_DATABASE_URL',
  projectId: 'PASTE_YOUR_PROJECT_ID',
  appId: 'PASTE_YOUR_APP_ID',
};
