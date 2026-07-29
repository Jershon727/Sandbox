# Flip 7

A push-your-luck card game for the browser, plus a score helper for when you're
playing with the real deck.

Two modes:

**Play a game** — you against up to five house bots, racing to 200. Cards fly in
from the deck, the Hit button shows your live bust odds, and busts, freezes and
Flip 7s all announce themselves.

**Score helper** — a calculator for a game at a real table. Tap the cards as they
land and it keeps each player's hand, works out the round score (including `×2`
and the `+` modifiers and the Flip 7 bonus), and tracks running totals. Numbers
you already hold are marked on the keypad, so you can see your bust cards at a
glance — and tapping one is the bust, same as at the table.

## Running it

```bash
npm install     # only needed for the screenshot helper
npm start       # → http://localhost:5173
npm test        # rules engine + scoring tests
```

There is no build step. The `public/` directory is the app: plain ES modules,
one stylesheet, no runtime dependencies.

## Deploying

Hosted on Firebase Hosting:

```bash
firebase deploy --only hosting
```

`firebase.json` serves `public/`, and marks `index.html` and `sw.js` as
`no-cache` so a deploy is picked up immediately.

## How it's put together

```
public/
  index.html      all screens and dialogs
  css/styles.css  tokens, themes, components, motion
  js/
    engine.js     the rules, as a deterministic state machine
    scoring.js    round scoring — shared by the game and the score helper
    cards.js      the 94-card deck
    odds.js       bust risk and expected value
    ai.js         bot personalities and their decisions
    rng.js        seedable PRNG, so games are reproducible in tests
    tally.js      the score helper
    main.js       screen routing and the game driver
    cardview.js   card DOM
    views.js      modals, toasts, banners, scoreboards
    sound.js      Web Audio effects — no audio files
    fx.js         canvas confetti
    storage.js    settings, stats, and the saved score-helper session
  sw.js           app-shell service worker, so it opens offline
tests/            node:test suites for the engine and scoring
scripts/
  serve.mjs       dependency-free dev server
  shots.mjs       drives the app in Chromium, screenshots, fails on console errors
```

### The engine

`engine.js` never touches the DOM. It exposes `request()` (what the game needs
now: a move, a target, or nothing) and `tick()` (perform one automatic step),
and it pushes every meaningful change onto an event queue. `main.js` drains that
queue and animates it. That split is why the rules are testable and why the
animation timing can change without touching a rule.

Card conservation is an invariant: the deck, the discard pile and every hand
always add up to exactly 94 cards, and the tests assert it across 60 randomised
full games. Cancelled action cards — a Freeze that never resolved because the
holder busted first — go to the discard rather than vanishing.

`scoring.js` is deliberately shared. A hand tapped in by a player at a real
table goes through the same function as one the engine dealt, so the two modes
can't drift apart.

## The rules

94 cards: one 0, one 1, two 2s, up to twelve 12s (79 number cards), five `+`
modifiers and `×2`, and three each of Freeze, Flip Three and Second Chance.

- Hit to flip a card, stay to bank your points and sit out the round.
- Draw a number you already have and you bust — zero for the round.
- Seven *different* numbers is a **Flip 7**: `+15` and the round ends
  immediately. Everyone else scores what they're holding.
- Modifiers can't bust you and don't count toward Flip 7. `×2` doubles your
  number cards only, then the `+` modifiers are added.
- **Freeze** makes any player still in the round bank and sit out (you may pick
  yourself). **Flip Three** makes them flip three cards one at a time; busting
  stops it early, and action cards drawn during the run resolve after it.
  **Second Chance** discards your next duplicate instead of busting you; draw a
  second one and you must give it away.
- First past the target score wins. A tie at the top plays another round.

**House rule in this version:** the deck is reshuffled at the start of every
round rather than running down across the game, which keeps the displayed bust
risk exact. Because every card in Flip 7 is dealt face up, that risk figure is
public information — the app is doing arithmetic you're allowed to do, not
showing you anything hidden.

## Notes

- Mobile-first, and installable — the service worker means the score helper
  opens at a table with no signal.
- Sound is synthesised at runtime, so the whole app is a few tens of KB.
- Respects `prefers-reduced-motion`; dark and light themes both ship.
- The score-helper session is written to `localStorage` on every tap, so an
  accidental refresh half an hour into a game doesn't lose the scores.
