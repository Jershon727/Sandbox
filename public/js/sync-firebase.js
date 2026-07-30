/**
 * Firebase Realtime Database backend — the one that syncs across phones.
 *
 * The SDK is imported from the CDN on demand, so nothing is downloaded unless
 * somebody actually hosts or joins an online game. Config comes from
 * firebase-config.js; if that file still has its placeholder values the app
 * stays in same-device mode and says so.
 */

// Pinned so a CDN release can't change behaviour underneath us. Safe to bump.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export function hasFirebaseConfig(config) {
  return !!(
    config &&
    config.apiKey &&
    config.databaseURL &&
    !String(config.apiKey).startsWith('PASTE_') &&
    !String(config.databaseURL).startsWith('PASTE_')
  );
}

export async function createFirebaseSync(config) {
  if (!hasFirebaseConfig(config)) {
    const err = new Error('Firebase is not configured');
    err.code = 'not-configured';
    throw err;
  }

  const [{ initializeApp, getApps }, db] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-database.js`),
  ]);

  const app = getApps().length ? getApps()[0] : initializeApp(config);
  const database = db.getDatabase(app);
  const roomRef = (code) => db.ref(database, `rooms/${code}`);

  return {
    kind: 'firebase',
    label: 'online',

    async create(code, room) {
      const snap = await db.get(roomRef(code));
      if (snap.exists()) {
        const err = new Error('That code is already in use');
        err.code = 'code-taken';
        throw err;
      }
      await db.set(roomRef(code), room);
      return room;
    },

    async join(code) {
      const snap = await db.get(roomRef(code));
      return snap.exists() ? snap.val() : null;
    },

    watch(code, onChange, onError) {
      const unsubscribe = db.onValue(
        roomRef(code),
        (snap) => {
          if (snap.exists()) onChange(snap.val());
          else onError?.(Object.assign(new Error('This game has ended'), { code: 'room-missing' }));
        },
        (error) => onError?.(error),
      );
      return unsubscribe;
    },

    async update(code, paths) {
      await db.update(roomRef(code), paths);
    },

    /** Drop this player from the room if their phone goes away for good. */
    async onDisconnectClear(code, path) {
      try {
        await db.onDisconnect(db.ref(database, `rooms/${code}/${path}`)).cancel();
      } catch {
        /* best effort — presence also falls back to the heartbeat */
      }
    },

    async close() {
      /* onValue unsubscribers are returned per-watch; nothing global to tear down */
    },
  };
}
