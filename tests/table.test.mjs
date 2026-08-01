import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable, request, REACTIONS } from '../public/js/table.js';

const newTable = () =>
  createTable({
    code: 'ABCD',
    setup: { hostId: 'me', hostName: 'Jack', target: 200, bots: 1 },
    deal: false,
  });

test('a reaction from a seated player lands in the feed and the projection', () => {
  const table = newTable();
  const result = request(table, 'me', { do: 'react', emoji: '🔥' });
  assert.equal(result.ok, true);

  const line = table.feed.at(-1);
  assert.equal(line.type, 'react');
  assert.equal(line.emoji, '🔥');
  assert.equal(line.who, 'me');
  // Renders as plain text on clients that predate reactions.
  assert.match(line.text, /Jack 🔥/);
  // The projection every phone reads carries it too.
  assert.equal(table.room.feed.at(-1).emoji, '🔥');
});

test('reactions are limited to the shared vocabulary and to seated players', () => {
  const table = newTable();
  // Anything outside the tray is refused — a client can't inject arbitrary text.
  assert.equal(request(table, 'me', { do: 'react', emoji: 'not-an-emoji' }).ok, false);
  assert.equal(request(table, 'me', { do: 'react' }).ok, false);
  // Somebody the dealer never seated can't heckle either.
  assert.equal(request(table, 'ghost', { do: 'react', emoji: REACTIONS[0] }).ok, false);
});

test('a reaction is allowed off-turn and never advances the game', () => {
  const table = newTable();
  const bot = table.game.players.find((p) => p.isBot);
  const before = {
    phase: table.game.phase,
    round: table.game.round,
    deck: table.game.deck.length,
  };
  // From the lobby, where gameplay intents like hit/stay would be refused.
  assert.equal(request(table, bot.id, { do: 'react', emoji: '😂' }).ok, true);
  assert.deepEqual(
    { phase: table.game.phase, round: table.game.round, deck: table.game.deck.length },
    before,
  );
});

test('reactions survive the round but a new deal clears them with the feed', () => {
  const table = newTable();
  request(table, 'me', { do: 'react', emoji: '👏' });
  assert.equal(table.feed.length, 1);
  assert.equal(request(table, 'me', { do: 'next-round' }).ok, true);
  assert.equal(table.feed.length, 0);
});
