# Flip 7 review findings — implementation reference

Working copy: this repo, branch `design-ux-improvements`. All paths relative to repo root.
This file is a working doc for implementation agents; it is deleted before the final commit is pushed.

Game context: Flip 7 press-your-luck card game. Number cards 0-12, bust on duplicate number, 7 unique numbers = +15 bonus. Action cards: Freeze, Flip Three, Second Chance. Modifiers: +2/+4/+6/+8/+10/x2. Two app modes: "scorekeeping" (physical cards, phones track score) and "dealt" (app deals, online multiplayer via Firebase or relay server). The dealt online mode is what the owner and friends actually play — it is the priority.

Preserve (do not regress): turn-cue system / pass-to-player banner (main.js:773-826), killer-card "busted you" display (scorer.js:610-670), optimistic local writes (store.js:347-361), reduced-motion support (styles.css:1973, :2670), the `--speed` factor and fx/sound/advice toggles, mid-round-joiner messaging (main.js:846-855).

---

## BATCH 1 — Visual polish (styles.css, cardview.js, views.js, scorer.js avatar bits, index.html)

1. **Card ink contrast (HIGH).** White 900-weight numerals on --n9 #ffbe33 (~1.7:1), --n10 #d3dc45 and gold modifiers #ffca47 (~1.5:1). styles.css:246-276 (--card-ink), palette 17-33, gold 285-291; applied cardview.js:16. Fix: per-value dark ink, e.g. `.card[data-value='9'], .card[data-value='10'], .card[data-kind='modifier'] { --card-ink: #241a00; text-shadow: 0 1px 0 rgba(255,255,255,.25); }`. Verify ≥3:1 on every face.
2. **8-10px text tier (HIGH).** Killer label 0.5rem (styles.css:1947), status chips 0.56rem (1018, 1857), "Claude recommends" 0.58rem (1595), meter label 0.62rem (1505), roomchip meta 0.66rem (898). `.card__tag` is calc(cw*0.15) (315) → ~6.6px at 44px cards. Fix: floor of 0.6875rem (11px) for informational text; `.card__tag` → `max(9px, ...)` or hide tag at small --cw.
3. **Standings density at >4 players (HIGH).** .standings min-height 92px + ~40px rows (styles.css:911-921, 947-953) shows ~2 of 8 rows on short phones. Fix: compact mode when player count > 4 (add a class from JS): ~30-32px single-line rows, score inline, drop per-row progress hairline (1072-1089), raise standings min-height.
4. **Hover states + desktop layout (MED).** Zero :hover rules exist; desktop is a 720px column (styles.css:203-208, 2639-2650). Fix: `@media (hover:hover)` lift/brighten for .btn, .pad__key, .mode, .stand rows using existing --ease; at min-width:900px two-column room layout (standings+feed left, tally card+pad/actions right).
5. **Weight rebalance (MED).** Nearly all text 600-900 (feed 1651-1699 etc.). Fix: body/feed/hints/prose 400-500; reserve 800-900 for numerals, titles, primary action buttons. Outfit 400/500 already loaded (index.html:21).
6. **Cards read as chips (MED).** .card styles.css:237-276, built cardview.js:14-21. Fix: inset ring `box-shadow: inset 0 0 0 1.5px rgba(255,255,255,.35)`, small top-left corner index (~0.22em), and a card-back state for dealIn (solid --surface-solid with "7" motif) revealed at 50% keyframe of existing rotateY (styles.css:2551-2568).
7. **Avatars (MED).** Everyone is 🙂 (dealer.js:67), rendered views.js:139; standings rank-only scorer.js:502. Fix: deterministic monogram chips — first initial on a circle colored from the --n* ramp by seat index — in standings rows, score rows, and feed dots (styles.css:1701-1710).
8. **Light theme washout (MED).** styles.css:79-99. Fix: --surface ~0.07 alpha, --line ~0.16, soft drop shadow on .tally__card/.stand in light theme, --card-mix-amt ≥45%.
9. **Segmented control selected state (MED).** styles.css:515-519 too subtle. Fix: `background: color-mix(in oklab, var(--volt) 22%, transparent); color: var(--ink); border: 1px solid color-mix(in oklab, var(--volt) 45%, transparent)`.
10. **Bust-O-meter color-only band (LOW/MED).** styles.css:1521-1578. data-band already set — mirror it as text ("safe / risky / danger") next to the %.
11. **Dead CSS (LOW).** Delete: .hud/.topbar--game (735-762), .mode__art--pad/.mode__pip (680-697), .stats/.stat (2460-2491), .pod/.felt/.deck (2647-2664 — NOTE batch 3 adds a real deck; delete only if truly unused after that, otherwise leave), deckPush keyframe (2621 — batch 3 will use it, LEAVE IT), duplicate .banner block (merge 765-773 with 833-839). Also views.js:116-119 setStatus writes to nonexistent #felt-status — remove or fix.
12. **Fonts (LOW).** Attempt to self-host Outfit 500+900 woff2 subsets with font-display:swap, preload, add to sw.js cache. If network access to fetch font files fails, SKIP and note it.
13. **Ramp near-twins (LOW).** styles.css:20-30: rotate --n2 toward #3d9bff, --n4 toward #b46cff.

## BATCH 2 — Dealt-mode UX (main.js, scorer.js, dealer.js, engine.js, room.js, store.js, index.html)

1. **Spectator hand view (HIGH).** Dealt mode forces selectedId null (scorer.js:304); tapping others' rows toasts an error (scorer.js:113-117). Fix: when it's someone else's turn in dealt mode, render a compact read-only strip of the active player's face-up cards (reuse createCard at small --cw) above the feed, with their live total and bust odds: "Maya — holding 34 · 41% bust" (odds engine already computes; deckTally ships to all clients, dealer.js:147-169, 210-211). Keep targeting behavior when `pending` is active.
2. **Duplicate-name seat hijack (HIGH).** store.js:258-266 and dealer.js:95-106 silently hand over an existing seat on case-insensitive name match. Fix: if matched seat active recently, require confirmation — "Sam is already playing. Rejoin as them, or join as Sam 2?"
3. **Target confirm (MED).** scorer.js:109-112 → intent target, resolveTarget instant (engine.js:225-251). Fix: two-step arm/confirm on standings-row tap ("Freeze Dana? Tap again to confirm / Cancel"); aim panel text (main.js:752-762) should say "tap a name on the scoreboard above".
4. **Tiebreak invisible (MED).** engine emits tiebreak (engine.js:457) but describeEvent has no case (dealer.js:328-358); room.js:213 `tied` never read by main.js (609-612). Fix: banner + summary line "Sam and Dana tied at 212 — one more round decides it."
5. **Non-host summary button lies (MED).** main.js:1047-1049 shows "Deal round N" to everyone; non-host click just closes (214-216). Fix: non-hosts see "Close — waiting for {host} to deal". Same for lobby deal state.
6. **Hit/Stay guard (MED).** Buttons appear at turn start (main.js:699), instantly live, no undo in dealt (684). Fix: visible but inert ~400ms after appearing; keep Stay left / Hit right always.
7. **Rules modal wrong mode (MED).** index.html:411-421 "Using this app" is physical-cards only. Fix: swap that section content based on store.isDealt.
8. **Deck counter (LOW).** deckLeft broadcast but never rendered. Fix: "N cards left" near room chip or above feed. (Batch 3 adds a visual deck; a simple text counter here is fine, batch 3 will build on it.)
9. **Home/meta copy (LOW).** index.html:97 tagline + meta 8-10 describe scorekeeper only. Fix: broaden tagline ("Deal in the app, or keep score for a real deck").

## BATCH 3 — Game feel (main.js, scorer.js, sound.js, fx.js, cardview.js, dealer.js, ai.js, styles.css)

1. **Dealt-mode flip animation + sound (HIGH).** dealIn (styles.css:2552) only fires via dealFrom() gated on this.dealSource (scorer.js:692) = keypad only. Dealt renderHand replaceChildren = silent swap; `gain` events never play sfx.gain (main.js:864 ignores them). Fix: diff hand length per render; on growth, insert card face-down, hold ~250ms, rotateY reveal, sfx.gain(value), 10ms haptic tick. Route through fx/sound/reduced-motion gates.
2. **Tension escalation (HIGH).** Nothing changes card 1→6. Fix: at 5+ cards a soft low heartbeat tick (Web Audio interval, rate scaled by bust %), warm glow on hand card intensifying per card, at 6 cards Hit button restyle ("Flip for the 7") with slow pulse. Kill all instantly on stay/bust.
3. **Flip 7 jackpot undersold + modal stomps it (HIGH).** scorer.js:449-468, sound.js:120; showRoundSummary (main.js:1033) opens same tick. Fix: stagger-glow the 7 number cards left-to-right (80ms), gold screen flash, full-screen celebrate() not just burstFrom, "+15" flies to score, haptic fanfare, delay summary modal ~2.5s.
4. **Bust dread beat (MED).** Own bust instant (main.js:907-915); others' busts feed-only. Fix: land duplicate, ring both copies (is-clash exists, styles.css:1957), ~400ms silence, then Busted banner. Others' busts: muted thud sfx + red flicker on their standings row.
5. **Second Chance moment (MED).** main.js:924-931 routine banner. Fix: shield-break sequence — Chance card intercepts duplicate, both shatter/fade, mint burstFrom on hand, sub quantifies save: "that would've cost you 34."
6. **Haptics (MED).** buzz() chained to sound setting (main.js:829-836), patchy coverage. Fix: separate "Vibrate" settings toggle; light tick per card drawn, escalating double-tick cards 5-6, celebration pattern on flip7/win. (Note iOS Safari lacks navigator.vibrate — degrade silently.)
7. **Emoji reactions (MED).** No social layer. Fix: 6-emoji tray (😱🔥😂❄️👏💀) sent as new intent → feed event through existing pipe (noteFeed, table.js:57); render floating up from sender's standings row via CSS keyframes; rate-limit 1/sec. Must work in both dealt (relay + firebase) and scorekeeping modes — reuse the existing event plumbing.
8. **Round summary dynamics (MED).** views.js:127 fillScores static. Fix: count deltas up (reuse tweenPct easing pattern, scorer.js:425); detect lead changes → gold pulse + "Maya takes the lead" line; "comeback" note when round's biggest score came from bottom half.
9. **Everyone celebrates the winner (LOW-MED).** main.js:1076-1081 confetti only for winner. Fix: confetti for all, winner's row gets gold banner treatment, final standings bars fill in rank order; keep sfx.lose for runners-up.
10. **Bot presence (LOW).** ai.js has personalities + tension-scaled thinking (ai.js:147-151) but table shows generic chip. Fix: pulsing "thinking…" ellipsis on bot's row during delay; occasional style-flavored feed lines ("Rex hits again. Of course he does.").
11. **Visible deck (LOW).** deckLeft/reshuffle projected (dealer.js:210, 354) never rendered; deckPush keyframe unused (styles.css:2621); dealFrom accepts source element (cardview.js:67). Fix: small face-down deck with count badge in dealt view; deal animations originate from it; deckPush on each deal; riffle cue on "Deck reshuffled".

## BATCH 4 — Multiplayer resilience (server/relay.mjs, sync-relay.js, sync-firebase.js, dealer.js, main.js, scorer.js, room.js)

1. **Presence in dealt rooms (HIGH).** relay drops heartbeats in dealt rooms (server/relay.mjs:375-378); projection fakes lastSeen (dealer.js:193) so away chip (scorer.js:524-526) never appears. Fix: track real socket presence per seat on the relay, project it, surface away chip in dealt games.
2. **Connection indicator (HIGH).** sync-relay.js reconnects silently (131-136), queues writes (247-255). Fix: expose socket state from sync layer; persistent small pill "Reconnecting… / Back online" near room chip; while disconnected in dealt mode disable Hit/Stay/target taps (scorekeeping taps can keep queuing).
3. **Stalled turn recovery (HIGH).** advance() waits forever on humans (dealer.js:298-314); removeSeat bots-only (108-117). Fix: after ~45s on a disconnected player's turn, auto-stay them with feed line "Dana lost connection — banked N"; host gets skip/remove control for human seats. Timer runs on the dealer (host) side.
4. **Host-away in scorekeeping (MED).** Only host ends rounds (main.js:600-612); isAway exists (room.js:121). Fix: when host away, change waiting copy to "{host} looks offline"; allow any player to end the round after host away ≥2 min.

## Notes for all agents

- `npm test` must pass after your batch. Add/extend tests only where the repo already has a matching test file pattern (tests/*.test.mjs) and the logic is non-trivial engine/dealer/room logic; UI-only changes need no new tests.
- Commit your batch when done: `git add -A && git commit -m "<batch summary>"` on branch design-ux-improvements. Do not push.
- Vanilla JS/CSS only, no new dependencies.
- Match existing code style (modules, naming, comment density).
- If a finding proves infeasible or the cited code has moved, adapt sensibly or skip with a note in your final report.
