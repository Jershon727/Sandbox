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

There are two ways to sync phones, and the app uses whichever is configured:

- **Your own relay** — a small WebSocket server in this repo. See
  [Running your own relay](#running-your-own-relay). No Google account.
- **Firebase Realtime Database** — no server to run, but a project to set up.

With neither, the app stays in single-phone mode and says so.

### Firebase

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

## Deploying from GitHub instead

`firebase login` opens a browser, so it can't run on a phone or in a sandbox.
`.github/workflows/deploy.yml` moves the deploy to GitHub: the credential lives
in repository secrets, and you trigger it from the Actions tab. No terminal, and
nothing sensitive passes through a chat window.

Set up once:

1. **Make a service account.** Google Cloud console → IAM & Admin → Service
   Accounts → Create. Grant it **Firebase Hosting Admin** and **Firebase
   Realtime Database Admin**. Then Keys → Add key → JSON, and download it.
2. **Add it as a secret.** GitHub repo → Settings → Secrets and variables →
   Actions → New repository secret, named `FIREBASE_SERVICE_ACCOUNT`. Paste the
   whole JSON file as the value.
3. **Add the web config as a secret** named `FIREBASE_WEB_CONFIG`, pasting the
   snippet from the Firebase console (the same one `set-config` takes). This
   isn't secret information — it just saves editing a file. Skip it and the
   workflow deploys single-phone mode and warns you.

Then: **Actions → Deploy to Firebase → Run workflow.**

It only runs when you ask it to. A deploy should be a decision rather than a
side effect of pushing a work-in-progress branch — there's a commented-out
`push:` trigger in the workflow if you'd rather it went out automatically from a
stable branch.

The workflow deploys to whichever project the service account belongs to, read
from the key's own `project_id`, so the deploy target can't drift away from the
credential that authorises it. Tests run first — a broken scorekeeper is worse
than an old one.

A web Firebase config is public by design; it isn't a secret. `database.rules.json`
is what actually controls access. Those rules let anyone who knows a room's
four-character code read and write that room, and nothing else — the same trust
model as reading the code out at the table. Rooms are disposable: start a new one
and the old code stops mattering.

Rooms are not cleaned up automatically. If you play a lot, delete old ones from
the console occasionally, or add a scheduled function to drop rooms older than a
day.

## Running your own relay

The relay is `server/relay.mjs`: one small WebSocket server that holds each room
and forwards updates. It borrows `applyPaths` from the app's own `room.js`, so the
server and the browsers can't disagree about what an update means. Nothing about
Flip 7 is encoded in it beyond that.

Locally:

```bash
npm run relay        # → ws://localhost:8787
```

Then point a device at it without editing any files:

```js
localStorage.setItem('flip7:relay', 'ws://localhost:8787')
```

### Deploying it (Railway, from a phone)

The relay serves the app as well as syncing it, so **one deploy gets you both**,
on one domain, and there's nothing to configure afterwards — `relay-config.js`
ships as `'same-origin'`, meaning "wherever this page came from".

Entirely in a browser:

1. [railway.app](https://railway.app) → log in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick this repo. It builds the
   `Dockerfile` (pinned in `railway.json`, so it can't accidentally run the dev
   server instead).
3. **Settings → Networking → Generate Domain.** That's your game's address.
4. Optional but worth it: **Settings → Volumes → new volume, mount path `/data`**,
   so rooms survive redeploys as well as restarts.

Open the domain, tap **Start a game**, read the code out. Railway's domains are
https, so the sockets are `wss://` automatically.

Any other host works the same way — Fly, Render, a VPS — the image respects
`PORT`. If you'd rather host the app somewhere else and the relay here, point
`relay-config.js` at it explicitly:

```js
export const relayUrl = 'wss://flip7-relay.up.railway.app';
```

Use `wss://`, not `ws://`: a page served over https can't open a plain socket.

The app checks that a relay is actually answering before it offers online rooms,
so `'same-origin'` is safe on a host that only serves files — Firebase Hosting,
say. There it quietly falls back to single-phone mode instead of offering rooms
that can't connect.

**Rooms survive a restart.** They're saved to `ROOM_STORE` (a JSON file, written
atomically) and reloaded on boot, because hosting platforms restart containers and
losing a game halfway through the evening would undo the point of having a relay.
Mount a volume at `/data` to keep them across redeploys as well. Rooms idle for
12 hours are dropped.

There is nothing secret in the relay address. Knowing it only lets you join a room
whose four-character code you already have — the same trust model as reading the
code out at the table. The limits in `LIMITS` (rooms, room size, sockets per room,
message size) are there so one bad client can't sink the box; all are
environment-overridable.

**Relay or Firebase?** Whichever is configured. If both are, the relay wins —
it's the one you host. The menu names which is in use.

## Running it locally

```bash
npm install        # only needed for the browser-driven checks
npm start          # → http://localhost:5173
npm test           # scoring, room logic and the Bust-O-meter
npm run test:e2e   # two phones in one room, in a real browser
npm run test:relay # two separate devices over a real relay, production shape
npm run relay      # the relay on its own → ws://localhost:8787
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
    sync-relay.js       WebSocket backend, loaded on demand
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
    odds.js             the Bust-O-meter's maths and the recommendation
  sw.js                 app-shell service worker, so it opens offline
  relay-config.js       your relay's address
server/
  relay.mjs             the relay: rooms in memory, saved across restarts
tests/                  node:test suites
scripts/
  serve.mjs             dependency-free dev server
  e2e.mjs               drives two pages through a shared room
  e2e-relay.mjs         two separate browser contexts over a real relay
  set-config.mjs        turns a pasted Firebase config into firebase-config.js
  check-config.mjs      pre-deploy guard
  bundle.mjs            single-file build
  shots.mjs             screenshots, and fails on console errors
```

### Why writes are paths, not objects

Every change is a set of paths — `{"players/ab12/hand": {...}}` — rather than a
new copy of the room. Two people tapping at the same instant touch different
paths, so neither can clobber the other. The host's "end round" is one atomic
multi-path write, so nobody sees half a round banked.

Writes are also applied locally before they're sent. Tapping a card rewrites the
whole hand, so a tap that lands before the previous one's echo would otherwise be
computed from a hand that no longer exists — and over a network that loses cards.
Tapping six numbers quickly used to leave one. Since the server merges with the
same `applyPaths`, the local copy and the server's converge, and taps register
instantly however far away the relay is.

All three backends — `sync-local.js`, `sync-relay.js`, `sync-firebase.js` —
implement the same five methods (`create`, `join`, `watch`, `update`, `close`), and
`applyPaths` in `room.js` reproduces Firebase's merge semantics everywhere else,
including on the relay server. Swapping transports changes no app code.

That's also what makes the sync logic testable. `npm run test:e2e` runs two pages
through a shared room over a BroadcastChannel. `npm run test:relay` goes further:
two *separate* browser contexts with nothing in common, talking over a real
WebSocket relay it starts itself — so the only thing that can carry state between
them is the network. It runs the production shape — one relay process serving the app *and* the
sockets, with the client finding it via `'same-origin'` — so it exercises what
actually gets deployed. It checks that a tap on one phone lands on the other,
that the room outlives the host closing their phone, that a reload rejoins, that
killing and restarting the relay loses neither the game nor a tap made while it
was down, and that a static host with no relay behind it falls back to
single-phone mode rather than offering rooms that can't connect.

### Who can edit what

You can always edit your own hand. The host can edit anybody's — for the friend
whose battery died, or the player who isn't holding a phone at all. Only the host
ends a round, so the whole table banks on the same beat.

Rejoining uses your name: come back after a crash with the same name and you get
your seat and your score back rather than a duplicate row.

## The Bust-O-meter

Under your hand sits a meter: a fixed green-to-red scale with a needle that
slides to your current chance of busting on the next card, and a hit-or-stay
call beside it. The scale staying put is the point — you learn where the danger
starts, and you watch the needle creep toward it as your hand grows. In the red
zone it pulses. Tap the row for the reasoning:

> 21 of the 78 unseen cards would bust you (27%). Risking 60 points is not worth
> the average gain.

This isn't insider knowledge. Every card in Flip 7 is dealt face up, so the app
is doing arithmetic anyone at the table could do with a good memory — it counts
the full 94-card deck, subtracts everything currently showing, and divides.

The recommendation is expected value over one more card. For each unseen card it
weighs what that card would do: a duplicate costs you the whole round (unless a
Second Chance covers it), a new number pays its face value, doubled if you hold
`×2`, plus 15 if it completes a Flip 7. If the average outcome is positive it
says hit. It looks one card ahead deliberately, because that's the decision in
front of you and you get to ask again afterwards. It also recognises a hand that
already wins the game and tells you to bank it.

**What it can't see**, stated in the panel rather than buried here:

- Cards dealt in earlier rounds. It assumes each round starts from a full deck,
  which is exactly right for round one and drifts optimistic after that.
- Freeze and Flip Three cards, which nobody taps because they don't score. Six
  cards that may already be gone still count as available.

Both errors point the same way — real risk is a little higher than shown — so
treat it as a guide, not a guarantee. Turn the Bust-O-meter off in Settings if
you'd rather play on instinct.

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
