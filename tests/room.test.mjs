import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  makeRoomCode,
  normalizeCode,
  isCompleteCode,
  makeId,
  emptyHand,
  newPlayer,
  blankRoom,
  readHand,
  handShape,
  roundScore,
  playerList,
  standings,
  isAway,
  hostAwayFor,
  HOST_AWAY_TAKEOVER,
  roundStarted,
  roundLooksDone,
  nextOrder,
  endRoundUpdates,
  rematchUpdates,
  tiedLeaders,
  applyPaths,
  canRailbird,
} from '../public/js/room.js';

/** Deterministic stand-in for Math.random. */
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const hand = (numbers = [], mods = [], extra = {}) => ({
  numbers,
  mods,
  chance: false,
  busted: false,
  ...extra,
});

function roomWith(players, extra = {}) {
  return {
    code: 'ABCD',
    target: 200,
    round: 1,
    hostId: 'h',
    status: 'playing',
    winnerId: null,
    players,
    ...extra,
  };
}

// ── codes ─────────────────────────────────────────────────────────────────

test('room codes avoid characters people misread aloud', () => {
  for (const c of 'IO01') assert.ok(!CODE_ALPHABET.includes(c), `${c} should not be in the alphabet`);
});

test('room codes are the right length and shape', () => {
  const code = makeRoomCode(seq([0, 0.5, 0.99, 0.25]));
  assert.equal(code.length, CODE_LENGTH);
  for (const c of code) assert.ok(CODE_ALPHABET.includes(c));
});

test('codes are forgiving about how they were typed', () => {
  assert.equal(normalizeCode('abcd'), 'ABCD');
  assert.equal(normalizeCode(' a b c d '), 'ABCD');
  assert.equal(normalizeCode('AB-CD'), 'ABCD');
  assert.equal(normalizeCode('ABCDEFG'), 'ABCD', 'extra characters are dropped');
  assert.equal(normalizeCode('AB1O'), 'AB', 'characters not in the alphabet are ignored');
  assert.equal(normalizeCode(null), '');
});

test('a code is only complete at full length', () => {
  assert.equal(isCompleteCode('ABC'), false);
  assert.equal(isCompleteCode('ABCD'), true);
  assert.equal(isCompleteCode('abcd'), true);
});

test('player ids are distinct', () => {
  const ids = new Set(Array.from({ length: 500 }, () => makeId()));
  assert.equal(ids.size, 500);
});

// ── shape ─────────────────────────────────────────────────────────────────

test('a new room starts with the host in seat zero', () => {
  const room = blankRoom({ code: 'ABCD', hostId: 'h', hostName: 'Jack', now: 1000 });
  assert.equal(room.round, 1);
  assert.equal(room.target, 200);
  assert.equal(room.status, 'playing');
  assert.deepEqual(Object.keys(room.players), ['h']);
  assert.equal(room.players.h.name, 'Jack');
  assert.equal(room.players.h.order, 0);
  assert.equal(room.players.h.total, 0);
});

test('missing arrays from the database read back as empty', () => {
  // Firebase drops empty arrays and false-y fields entirely.
  assert.deepEqual(readHand(undefined), {
    numbers: [],
    mods: [],
    chance: false,
    busted: false,
    bustCard: null,
  });
  assert.deepEqual(readHand({ numbers: [4] }).mods, []);
  assert.equal(readHand({ busted: true }).busted, true);
  // A dealt game says which card busted you; tapping your own cards does not.
  assert.equal(readHand({ busted: true }).bustCard, null);
  assert.deepEqual(readHand({ busted: true, bustCard: { kind: 'number', value: 9 } }).bustCard, {
    kind: 'number',
    value: 9,
  });
});

test('a hand converts to the shape the shared scorer expects', () => {
  const shape = handShape(hand([4, 9, 12], [{ op: 'mul', value: 2 }, { op: 'add', value: 10 }]));
  assert.deepEqual(shape, {
    numbers: [4, 9, 12],
    addMods: [10],
    doubled: true,
    flip7: false,
    busted: false,
  });
  assert.equal(roundScore(hand([4, 9, 12], [{ op: 'mul', value: 2 }, { op: 'add', value: 10 }])), 60);
});

test('seven uniques in a room hand scores the bonus', () => {
  assert.equal(roundScore(hand([1, 2, 3, 4, 5, 6, 7])), 43);
});

test('players come back in seat order', () => {
  const room = roomWith({
    c: { name: 'C', order: 2, total: 0 },
    a: { name: 'A', order: 0, total: 0 },
    b: { name: 'B', order: 1, total: 0 },
  });
  assert.deepEqual(playerList(room).map((p) => p.name), ['A', 'B', 'C']);
});

test('standings rank by total, then by the round in progress', () => {
  const room = roomWith({
    a: { name: 'A', order: 0, total: 50, hand: hand([3]) },
    b: { name: 'B', order: 1, total: 50, hand: hand([12]) },
    c: { name: 'C', order: 2, total: 90, hand: hand() },
  });
  assert.deepEqual(standings(room).map((p) => p.name), ['C', 'B', 'A']);
});

test('a quiet phone reads as away', () => {
  const now = 100_000;
  assert.equal(isAway({ lastSeen: now - 1000 }, now), false);
  assert.equal(isAway({ lastSeen: now - 60_000 }, now), true);
  assert.equal(isAway({}, now), true, 'never seen counts as away');
});

test('a vanished host eventually forfeits the end-round button', () => {
  const now = 1_000_000_000;
  const room = blankRoom({ code: 'ABCD', hostId: 'h', hostName: 'Jack', now });
  assert.equal(hostAwayFor(room, now), 0, 'a fresh room has a present host');
  assert.ok(
    hostAwayFor(room, now + HOST_AWAY_TAKEOVER - 1) < HOST_AWAY_TAKEOVER,
    'not handed over a moment early',
  );
  assert.ok(hostAwayFor(room, now + HOST_AWAY_TAKEOVER) >= HOST_AWAY_TAKEOVER);
  assert.equal(hostAwayFor({ players: {} }, now), 0, 'no host, no takeover clock');
});

test('seats are assigned after the highest one taken', () => {
  assert.equal(nextOrder(roomWith({})), 0);
  assert.equal(nextOrder(roomWith({ a: { order: 0 }, b: { order: 3 } })), 4);
});

// ── round progress ────────────────────────────────────────────────────────

test('a round has not started until someone taps a card', () => {
  assert.equal(roundStarted(roomWith({ a: { hand: hand() } })), false);
  assert.equal(roundStarted(roomWith({ a: { hand: hand([5]) } })), true);
  assert.equal(
    roundStarted(roomWith({ a: { hand: hand([], [{ op: 'add', value: 2 }]) } })),
    true,
    'a modifier counts',
  );
  assert.equal(
    roundStarted(roomWith({ a: { hand: hand([], [], { busted: true }) } })),
    true,
    'so does busting with nothing',
  );
});

test('the round looks done once everyone has busted or hit seven', () => {
  assert.equal(
    roundLooksDone(
      roomWith({
        a: { hand: hand([], [], { busted: true }) },
        b: { hand: hand([1, 2, 3, 4, 5, 6, 7]) },
      }),
    ),
    true,
  );
  assert.equal(
    roundLooksDone(roomWith({ a: { hand: hand([], [], { busted: true }) }, b: { hand: hand([5]) } })),
    false,
    'someone is still going',
  );
  assert.equal(roundLooksDone(roomWith({})), false, 'an empty room is not a finished round');
});

// ── ending a round ────────────────────────────────────────────────────────

test('ending a round banks every hand and clears the table', () => {
  const room = roomWith({
    a: { name: 'A', order: 0, total: 10, history: [10], hand: hand([12, 8]) },
    b: { name: 'B', order: 1, total: 4, history: [4], hand: hand([3], [], { busted: true }) },
  });

  const { paths, results } = endRoundUpdates(room);

  assert.equal(paths['players/a/total'], 30);
  assert.deepEqual(paths['players/a/history'], [10, 20]);
  assert.deepEqual(paths['players/a/hand'], emptyHand());
  assert.equal(paths['players/b/total'], 4, 'a bust adds nothing');
  assert.deepEqual(paths['players/b/history'], [4, 0]);
  assert.equal(paths.round, 2);
  assert.ok(!('status' in paths), 'nobody has won yet');

  const a = results.find((r) => r.id === 'a');
  assert.equal(a.delta, 20);
  assert.equal(results.find((r) => r.id === 'b').busted, true);
});

test('the writes only ever touch a player’s own subtree plus room fields', () => {
  const room = roomWith({ a: { name: 'A', order: 0, total: 0, hand: hand([5]) } });
  for (const key of Object.keys(endRoundUpdates(room).paths)) {
    assert.ok(
      /^players\/[^/]+\/(total|history|hand)$/.test(key) ||
        ['round', 'status', 'winnerId', 'lastRound'].includes(key),
      `unexpected write path: ${key}`,
    );
  }
});

test('passing the target ends the game', () => {
  const room = roomWith(
    {
      a: { name: 'A', order: 0, total: 190, hand: hand([12]) },
      b: { name: 'B', order: 1, total: 20, hand: hand([5]) },
    },
    { target: 200 },
  );
  const { paths, winner } = endRoundUpdates(room);
  assert.equal(paths.status, 'finished');
  assert.equal(paths.winnerId, 'a');
  assert.equal(winner.name, 'A');
  assert.equal(winner.total, 202);
});

test('a tie at the finish line plays on', () => {
  const room = roomWith(
    {
      a: { name: 'A', order: 0, total: 190, hand: hand([12]) },
      b: { name: 'B', order: 1, total: 190, hand: hand([12]) },
    },
    { target: 200 },
  );
  const { paths, winner, tied } = endRoundUpdates(room);
  assert.equal(winner, null);
  assert.ok(!('status' in paths), 'the game is not over');
  assert.equal(tied.length, 2);
  assert.equal(paths.round, 2);

  // Every phone reads the same tie off the published summary — the host isn't
  // the only one who can know why another round is being dealt.
  const fromResults = tiedLeaders(paths.lastRound.results, room.target);
  assert.deepEqual(
    fromResults.map((r) => r.name).sort(),
    ['A', 'B'],
  );
  assert.equal(fromResults[0].total, 202);
});

test('tiedLeaders only reports a tie that forces another round', () => {
  const results = (totals) => totals.map((total, i) => ({ id: `p${i}`, name: `P${i}`, total }));

  // Nobody past the target: level scores are just level scores.
  assert.equal(tiedLeaders(results([120, 120]), 200), null);
  // A clear winner is not a tie.
  assert.equal(tiedLeaders(results([212, 196]), 200), null);
  // Past the target together, level at the top.
  assert.equal(tiedLeaders(results([212, 212, 40]), 200).length, 2);
  // Second place matching itself doesn't matter — only the top spot does.
  assert.equal(tiedLeaders(results([212, 205, 205]), 200), null);
  // Degenerate inputs stay quiet.
  assert.equal(tiedLeaders([], 200), null);
  assert.equal(tiedLeaders(results([212, 212]), 0), null);
});

test('clearing the target with the top score, but not alone, is not a win', () => {
  // Highest score wins; someone else also past the target does not stop that.
  const room = roomWith(
    {
      a: { name: 'A', order: 0, total: 190, hand: hand([12, 10]) },
      b: { name: 'B', order: 1, total: 195, hand: hand([1]) },
    },
    { target: 200 },
  );
  const { winner } = endRoundUpdates(room);
  assert.equal(winner.name, 'A', 'A finishes on 212, B on 196');
  assert.equal(winner.total, 212);
});

test('a rematch keeps the players and wipes the scores', () => {
  const room = roomWith(
    {
      a: { name: 'A', order: 0, total: 210, history: [210], hand: hand([4]) },
      b: { name: 'B', order: 1, total: 90, history: [90], hand: hand() },
    },
    { round: 7, status: 'finished', winnerId: 'a' },
  );
  const paths = rematchUpdates(room);
  assert.equal(paths.round, 1);
  assert.equal(paths.status, 'playing');
  assert.equal(paths.winnerId, null);
  assert.equal(paths.lastRound, null, 'otherwise the old summary reopens');
  assert.equal(paths['players/a/total'], 0);
  assert.deepEqual(paths['players/a/history'], []);
  assert.equal(paths['players/b/total'], 0);
});

// ── path writes ───────────────────────────────────────────────────────────

test('path updates write deep without disturbing their siblings', () => {
  const before = roomWith({
    a: { name: 'A', order: 0, total: 10, hand: hand([5]) },
    b: { name: 'B', order: 1, total: 20, hand: hand([7]) },
  });
  const after = applyPaths(before, {
    'players/a/hand': hand([5, 9]),
    'players/a/total': 12,
    round: 3,
  });

  assert.deepEqual(after.players.a.hand.numbers, [5, 9]);
  assert.equal(after.players.a.total, 12);
  assert.equal(after.players.a.name, 'A', 'untouched fields survive');
  assert.deepEqual(after.players.b.hand.numbers, [7], 'other players are untouched');
  assert.equal(after.round, 3);
  assert.deepEqual(before.players.a.hand.numbers, [5], 'the original is not mutated');
});

test('path updates can add a player and remove one', () => {
  const room = roomWith({ a: { name: 'A', order: 0, total: 0 } });
  const added = applyPaths(room, { 'players/z': newPlayer('Z', 1, 5) });
  assert.equal(added.players.z.name, 'Z');
  const removed = applyPaths(added, { 'players/a': null });
  assert.deepEqual(Object.keys(removed.players), ['z']);
});

test('the round summary is published for every phone to read', () => {
  const room = roomWith({ a: { name: 'A', order: 0, total: 0, hand: hand([9]) } });
  const { paths } = endRoundUpdates(room);
  assert.equal(paths.lastRound.round, 1);
  assert.equal(paths.lastRound.results[0].delta, 9);

  // A late-joining phone applying the same update lands in the same place.
  const after = applyPaths(room, paths);
  assert.equal(after.round, 2);
  assert.equal(after.players.a.total, 9);
  assert.deepEqual(after.players.a.hand, emptyHand());
});

test('a fresh player joins with nothing banked', () => {
  const p = newPlayer('Mo', 3, 500);
  assert.equal(p.total, 0);
  assert.deepEqual(p.history, []);
  assert.deepEqual(p.hand, emptyHand());
  assert.equal(p.lastSeen, 500);
});

test('the railbird window opens only for the dead, funded, and unbet', () => {
  const dealtRoom = (me) => ({
    kind: 'dealt',
    pressBets: true,
    status: 'playing',
    lobby: false,
    roundOver: false,
    players: {
      me: { name: 'Me', order: 0, total: 40, state: 'busted', ...me },
      horse: { name: 'H', order: 1, total: 10, state: 'active' },
    },
  });

  assert.equal(canRailbird(dealtRoom({}), 'me'), true);
  assert.equal(canRailbird(dealtRoom({ state: 'frozen' }), 'me'), true, 'frozen counts as out');
  assert.equal(canRailbird(dealtRoom({ state: 'active' }), 'me'), false, 'still playing');
  assert.equal(canRailbird(dealtRoom({ state: 'stayed' }), 'me'), false, 'banked is not out');
  assert.equal(canRailbird(dealtRoom({ total: 4 }), 'me'), false, 'broke');
  assert.equal(canRailbird(dealtRoom({ railbird: { targetId: 'horse' } }), 'me'), false, 'bet down');
  assert.equal(canRailbird({ ...dealtRoom({}), pressBets: false }, 'me'), false, 'rule off');
  assert.equal(canRailbird({ ...dealtRoom({}), roundOver: true }, 'me'), false, 'round closed');
  const noHorse = dealtRoom({});
  noHorse.players.horse.state = 'stayed';
  assert.equal(canRailbird(noHorse, 'me'), false, 'nobody left to back');
});
