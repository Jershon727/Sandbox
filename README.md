# Flip 7 — keep score together

A scorekeeper for Flip 7 played with real cards. One person starts a game and
reads out a four-letter code; everyone else joins on their own phone. As cards
land you tap them, and the whole table watches the scores move.

It does the arithmetic nobody wants to do at the end of a round — `×2` before the
bonuses, the +15 for a Flip 7, a bust that wipes the round — and it keeps the
running totals.

## Two ways to run it

**Everyone on their own phone** (needs Firebase, see below). The host creates a
room, shares the code or the link, and each player taps their own cards. Scores
sync live.

**Just one phone.** No setup at all. One device keeps score for the whole table:
add everyone from the menu and tap for each player in turn. This is also the
fallback whenever Firebase isn't configured.

## Turning on live sync

Online rooms need a Firebase Realtime Database. The app works without one — it
just stays in single-phone mode and tells you so.

1. In the [Firebase console](https://console.firebase.google.com), open your
   project (or make one).
2. **Build → Realtime Database → Create Database.** Any region is fine.
3. **Project settings → General → Your apps.** Add a web app if there isn't one,
   then copy the config object.
4. Paste that snippet into `npm run set-config` (then Ctrl-D). It writes
   `public/firebase-config.js` and points `.firebaserc` at the same project.

   Worth using rather than editing the file by hand, because the console omits
   `databaseURL` until a Realtime Database exists — so a config pasted before
   step 2 looks complete but leaves online rooms dead. `set-config` catches
   exactly that.
5. Log in and deploy:

   ```bash
   npx firebase login
   npm run deploy
   ```

   `npm run deploy` runs `firebase deploy --only database,hosting`. The `database` part
   matters — it uploads `database.rules.json`. Without it the database keeps
   whatever rules it was created with, which is either locked (nothing works) or
   wide open (anything works).

`npm run deploy` refuses to run while `firebase-config.js` still has placeholder
values, because that deploy *succeeds* and serves an app with no database behind
it — a failure you'd discover with friends already sitting around the table. To
ship single-phone mode on purpose, use `npm run deploy:offline`.

Deploying needs you to be logged in (`npx firebase login`) and the target
project named in `.firebaserc`, which is set to `flip7-46611`. Change it if
that's the wrong project.

A web Firebase config is public by design; it isn't a secret. `database.rules.json`
is what actually controls access. Those rules let anyone who knows a room's
four-character code read and write that room, and nothing else — the same trust
model as reading the code out at the table. Rooms are disposable: start a new one
and the old code stops mattering.

Rooms are not cleaned up automatically. If you play a lot, delete old ones from
the console occasionally, or add a scheduled function to drop rooms older than a
day.

## Running it locally

```bash
npm install        # only needed for the browser-driven checks
npm start          # → http://localhost:5173
npm test           # scoring and room logic
npm run test:e2e   # two phones in one room, in a real browser
```

There is no build step. `public/` is the app: plain ES modules, one stylesheet,
no runtime dependencies.

`npm run bundle` writes `dist/flip7.html`, the whole app as a single
self-contained file — handy for sharing or opening straight off disk. Single-file
builds are same-device only, since there's no config file to read.

## How it's put together

```
public/
  index.html            every screen and dialog
  firebase-config.js    paste your project config here
  css/styles.css        tokens, themes, components, motion
  js/
    room.js             room shape + the pure functions over it
    store.js            the live room: identity, presence, permissions
    sync-local.js       same-device backend (localStorage + BroadcastChannel)
    sync-firebase.js    Realtime Database backend, loaded on demand
    scorer.js           standings, the hand, the keypad
    main.js             screens, hosting, joining, the round lifecycle
    scoring.js          round scoring — the only place it's calculated
    cards.js            the 94-card deck
    cardview.js         card DOM
    views.js            modals, toasts, banners, scoreboards
    sound.js            Web Audio effects — no audio files
    fx.js               canvas confetti
    storage.js          preferences
  sw.js                 app-shell service worker, so it opens offline
tests/                  node:test suites
scripts/
  serve.mjs             dependency-free dev server
  e2e.mjs               drives two pages through a shared room
  bundle.mjs            single-file build
  shots.mjs             screenshots, and fails on console errors
```

### Why writes are paths, not objects

Every change is a set of paths — `{"players/ab12/hand": {...}}` — rather than a
new copy of the room. Two people tapping at the same instant touch different
paths, so neither can clobber the other. The host's "end round" is one atomic
multi-path write, so nobody sees half a round banked.

`sync-local.js` and `sync-firebase.js` implement the same interface, and
`applyPaths` in `room.js` reproduces Firebase's merge semantics locally. That's
what makes the sync logic testable: `npm run test:e2e` runs two real browser
pages through a shared room over a BroadcastChannel, exercising the same code
paths the network backend uses.

### Who can edit what

You can always edit your own hand. The host can edit anybody's — for the friend
whose battery died, or the player who isn't holding a phone at all. Only the host
ends a round, so the whole table banks on the same beat.

Rejoining uses your name: come back after a crash with the same name and you get
your seat and your score back rather than a duplicate row.

## The rules it implements

94 cards: one 0, one 1, two 2s, up to twelve 12s (79 number cards), five `+`
modifiers and `×2`, and three each of Freeze, Flip Three and Second Chance.

- A second copy of a number you hold is a bust: zero for the round.
- Seven *different* numbers is a Flip 7 — `+15`, and the round ends for
  everyone.
- `×2` doubles your number cards only; `+` modifiers are added after. Modifiers
  can't bust you and don't count toward Flip 7.
- Second Chance discards your next duplicate instead of busting you.
- First past the target wins. A tie at the top plays another round.

Freeze and Flip Three don't need buttons: they change what lands in front of
you, and you tap what lands.

## Notes

- Mobile-first and installable. The service worker means it opens with no
  signal — single-phone scoring works fully offline.
- Sound is synthesised at runtime; the whole app is a few tens of KB.
- Dark and light themes, following the system by default.
- Reopening the app rejoins the room you were in. Nothing is lost to a locked
  screen or an accidental refresh.
