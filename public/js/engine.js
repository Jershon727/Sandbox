/**
 * Flip 7 rules engine.
 *
 * The engine is a deterministic state machine that never touches the DOM. It
 * exposes two things to the driver:
 *
 *   request() — what the game needs right now ('move', 'target', 'auto', ...)
 *   tick()    — perform exactly one automatic step (deal a card, resolve a
 *               queued action, advance the turn, score the round)
 *
 * Every meaningful change pushes an event onto a queue that the UI drains and
 * animates, which is what keeps rules and presentation cleanly separated.
 */

import { makeRng } from './rng.js';
import { buildDeck } from './cards.js';
import { scoreHand, FLIP7_BONUS, FLIP7_TARGET } from './scoring.js';
import { tallyOf, bustChanceOf } from './odds.js';

export const Status = {
  ACTIVE: 'active',
  STAYED: 'stayed',
  BUSTED: 'busted',
  FROZEN: 'frozen',
  FLIP7: 'flip7',
};

export { FLIP7_BONUS, FLIP7_TARGET };

/** A player is done for the round unless they're active. */
export const isOut = (p) => p.status !== Status.ACTIVE;

export class Flip7Game {
  constructor({ players, targetScore = 200, seed, pressBets = false } = {}) {
    this.rng = makeRng(seed);
    this.targetScore = targetScore;
    // House rule: before a hit, a player may wager points that the next card
    // won't bust them. Off by default — the host turns it on.
    this.pressBets = !!pressBets;
    this.players = players.map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: p.name ?? `Player ${i + 1}`,
      isBot: !!p.isBot,
      style: p.style ?? 'balanced',
      avatar: p.avatar ?? '🙂',
      seat: i,
      total: 0,
      history: [],
      numbers: [],
      modifiers: [],
      secondChance: null,
      status: Status.ACTIVE,
      roundScore: 0,
      bustCard: null,
      bet: null, // a live press bet: { wager, payout }
      betUsed: false, // one press per round
      roundBets: 0, // net press winnings this round, for the summary
    }));

    this.round = 0;
    this.deck = [];
    this.discard = [];
    this.dealerIndex = this.players.length - 1;
    this.turnIndex = 0;
    this.phase = 'idle'; // idle | round | round-over | game-over
    this.pending = null; // { type, by, card, targets:[id] }
    this.flipQueue = null; // { playerId, remaining }
    this.deferred = []; // action cards drawn mid-Flip-Three, resolved after
    this.needAdvance = false;
    this.winner = null;
    this.events = [];
  }

  // ---------------------------------------------------------------- helpers

  byId(id) {
    return this.players.find((p) => p.id === id);
  }

  get current() {
    return this.players[this.turnIndex];
  }

  get activePlayers() {
    return this.players.filter((p) => p.status === Status.ACTIVE);
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  /** Cancel queued action cards, sending them to the discard so none go missing. */
  _dropDeferred(predicate = () => true) {
    const kept = [];
    for (const entry of this.deferred) {
      if (predicate(entry)) this.discard.push(entry.card);
      else kept.push(entry);
    }
    this.deferred = kept;
  }

  /** Hand the queued events to the caller and clear them. */
  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------------ round

  startRound() {
    this.round += 1;
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;

    for (const p of this.players) {
      p.numbers = [];
      p.modifiers = [];
      p.secondChance = null;
      p.status = Status.ACTIVE;
      p.roundScore = 0;
      p.bustCard = null;
      p.bet = null;
      p.betUsed = false;
      p.roundBets = 0;
    }

    // A freshly shuffled deck each round keeps the odds readable for players
    // (and makes the risk meter exact rather than a running count).
    this.deck = this.rng.shuffle(buildDeck());
    this.discard = [];
    this.pending = null;
    this.flipQueue = null;
    this.deferred = [];
    this.phase = 'round';
    this.winner = null;

    // One card to each player, starting left of the dealer, then normal turns.
    this.dealQueue = [];
    for (let i = 1; i <= this.players.length; i++) {
      this.dealQueue.push(this.players[(this.dealerIndex + i) % this.players.length].id);
    }
    this.turnIndex = this.dealerIndex;
    this.needAdvance = true;

    this.emit('round-start', { round: this.round, dealerId: this.players[this.dealerIndex].id });
  }

  /** What does the game need from the outside world right now? */
  request() {
    if (this.phase === 'game-over') return { type: 'game-over' };
    if (this.phase === 'round-over') return { type: 'round-over' };
    if (this.phase !== 'round') return { type: 'idle' };
    if (this.pending) {
      return {
        type: 'target',
        action: this.pending.type,
        playerId: this.pending.by,
        card: this.pending.card,
        targets: this.pending.targets.slice(),
      };
    }
    if (this.dealQueue.length || this.flipQueue || this.deferred.length || this.needAdvance) {
      return { type: 'auto' };
    }
    if (!this.activePlayers.length) return { type: 'auto' };
    return { type: 'move', playerId: this.current.id };
  }

  /** Run one automatic step. Returns true if anything happened. */
  tick() {
    if (this.phase !== 'round' || this.pending) return false;

    if (this.dealQueue.length) {
      const player = this.byId(this.dealQueue.shift());
      if (player.status === Status.ACTIVE) this._deal(player, 'deal');
      return true;
    }

    if (this.flipQueue) {
      const player = this.byId(this.flipQueue.playerId);
      if (this.flipQueue.remaining > 0 && player.status === Status.ACTIVE) {
        this.flipQueue.remaining -= 1;
        this._deal(player, 'flip3');
      } else {
        this.emit('flip3-end', { playerId: player.id });
        this.flipQueue = null;
      }
      return true;
    }

    if (this.deferred.length) {
      const { player, card } = this.deferred.shift();
      this._openAction(player, card);
      return true;
    }

    if (this.needAdvance) {
      this.needAdvance = false;
      this._advanceTurn();
      return true;
    }

    if (!this.activePlayers.length) {
      this._finalizeRound();
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------ moves

  hit() {
    const req = this.request();
    if (req.type !== 'move') return false;
    const player = this.current;
    this.emit('hit', { playerId: player.id });
    this._deal(player, 'hit');
    // The pressed bet rides on exactly this card, whatever it turned out to be.
    this._settleBet(player);
    this.needAdvance = true;
    return true;
  }

  stay() {
    const req = this.request();
    if (req.type !== 'move') return false;
    const player = this.current;
    // Banking instead of drawing calls the bet off — nothing was ever staked
    // until a card actually moves.
    player.bet = null;
    player.status = Status.STAYED;
    player.roundScore = this.scoreOf(player);
    this.emit('stay', { playerId: player.id, score: player.roundScore });
    this.needAdvance = true;
    return true;
  }

  /**
   * The Press bet house rule: before hitting, wager that the next card won't
   * bust you. The payout is set at the odds you took — wager × p/(1−p), the
   * exact bust chance from the exact remaining deck — so the bet is fair by
   * construction: pressing is pure nerve, not a strategy that always pays.
   * One press per round; you can't stake points you don't have.
   */
  placeBet(playerId, wager) {
    if (!this.pressBets) return false;
    const req = this.request();
    if (req.type !== 'move' || req.playerId !== playerId) return false;
    const player = this.byId(playerId);
    const amount = Math.floor(Number(wager));
    if (!Number.isFinite(amount) || amount < 1) return false;
    if (player.betUsed || player.bet) return false;
    if (amount > player.total) return false;

    const risk = bustChanceOf(tallyOf(this.deck), {
      numbers: player.numbers.map((c) => c.value),
      doubled: player.modifiers.some((c) => c.op === 'mul'),
      chance: !!player.secondChance,
      busted: false,
      standing: this.scoreOf(player),
    });
    // A hand that can't bust has nothing to bet on, and a certainty pays nothing.
    if (risk <= 0 || risk >= 1) return false;

    const payout = Math.max(1, Math.ceil((amount * risk) / (1 - risk)));
    player.bet = { wager: amount, payout };
    player.betUsed = true;
    this.emit('bet', { playerId, wager: amount, payout, risk });
    return true;
  }

  _settleBet(player) {
    const bet = player.bet;
    if (!bet) return;
    player.bet = null;
    if (player.status === Status.BUSTED) {
      player.total = Math.max(0, player.total - bet.wager);
      player.roundBets -= bet.wager;
      this.emit('bet-lost', { playerId: player.id, wager: bet.wager });
    } else {
      player.total += bet.payout;
      player.roundBets += bet.payout;
      this.emit('bet-won', { playerId: player.id, payout: bet.payout, wager: bet.wager });
    }
  }

  /** Resolve the action card currently awaiting a target. */
  resolveTarget(targetId) {
    if (!this.pending) return false;
    const { type, by, card, targets } = this.pending;
    if (!targets.includes(targetId)) return false;
    this.pending = null;

    const actor = this.byId(by);
    const target = this.byId(targetId);
    this.discard.push(card);

    if (type === 'freeze') {
      target.status = Status.FROZEN;
      target.roundScore = this.scoreOf(target);
      if (this.flipQueue && this.flipQueue.playerId === targetId) this.flipQueue = null;
      this._dropDeferred((d) => d.player.id === targetId);
      this.emit('freeze', { playerId: actor.id, targetId, score: target.roundScore });
    } else if (type === 'flip3') {
      this.flipQueue = { playerId: targetId, remaining: 3 };
      this.emit('flip3-start', { playerId: actor.id, targetId });
    } else if (type === 'gift') {
      target.secondChance = card;
      this.discard.pop();
      this.emit('gift', { playerId: actor.id, targetId });
    }

    return true;
  }

  // --------------------------------------------------------------- internals

  _draw() {
    if (!this.deck.length) {
      // Recycle what has left play. In practice a round never gets this far,
      // but a stalled game would be worse than a reshuffle.
      const recycled = this.discard.length ? this.discard : buildDeck();
      this.deck = this.rng.shuffle(recycled);
      this.discard = [];
      this.emit('reshuffle', { count: this.deck.length });
    }
    return this.deck.pop();
  }

  _deal(player, reason) {
    const card = this._draw();
    if (!card) return;
    this.emit('draw', { playerId: player.id, card, reason, deckLeft: this.deck.length });
    this._apply(player, card, reason);
  }

  _apply(player, card, reason) {
    if (card.kind === 'number') {
      const duplicate = player.numbers.some((c) => c.value === card.value);

      if (duplicate && player.secondChance) {
        const shield = player.secondChance;
        player.secondChance = null;
        this.discard.push(shield, card);
        this.emit('second-chance', { playerId: player.id, card });
        return;
      }

      if (duplicate) {
        this._bust(player, card);
        return;
      }

      player.numbers.push(card);
      this.emit('gain', { playerId: player.id, card });
      if (player.numbers.length === FLIP7_TARGET) this._flip7(player);
      return;
    }

    if (card.kind === 'modifier') {
      player.modifiers.push(card);
      this.emit('gain', { playerId: player.id, card });
      return;
    }

    // Action card.
    if (card.action === 'chance' && !player.secondChance) {
      player.secondChance = card;
      this.emit('gain', { playerId: player.id, card });
      return;
    }

    // Actions drawn during a Flip Three wait until all three flips are done.
    if (reason === 'flip3' && this.flipQueue && this.flipQueue.playerId === player.id) {
      this.deferred.push({ player, card });
      this.emit('defer', { playerId: player.id, card });
      return;
    }

    this._openAction(player, card);
  }

  _openAction(player, card) {
    if (player.status !== Status.ACTIVE) {
      this.discard.push(card);
      this.emit('discard-action', { playerId: player.id, card, reason: 'out' });
      return;
    }

    if (card.action === 'chance') {
      if (!player.secondChance) {
        player.secondChance = card;
        this.emit('gain', { playerId: player.id, card });
        return;
      }
      // Already holding one: it must be given away, or discarded if nobody can take it.
      const targets = this.activePlayers.filter((p) => p.id !== player.id && !p.secondChance);
      if (!targets.length) {
        this.discard.push(card);
        this.emit('discard-action', { playerId: player.id, card, reason: 'no-target' });
        return;
      }
      this.pending = { type: 'gift', by: player.id, card, targets: targets.map((p) => p.id) };
    } else {
      const targets = this.activePlayers.map((p) => p.id);
      if (!targets.length) {
        this.discard.push(card);
        this.emit('discard-action', { playerId: player.id, card, reason: 'no-target' });
        return;
      }
      this.pending = { type: card.action, by: player.id, card, targets };
    }

    this.emit('action-pending', {
      playerId: player.id,
      card,
      action: this.pending.type,
      targets: this.pending.targets.slice(),
    });
  }

  _bust(player, card) {
    player.status = Status.BUSTED;
    player.roundScore = 0;
    // The hand stays put so the player can see exactly what killed them; it is
    // simply out of play, like the discard pile, until the next round resets it.
    player.bustCard = card;
    // Busting discards your whole hand, including actions you hadn't resolved.
    this._dropDeferred((d) => d.player.id === player.id);
    if (this.flipQueue && this.flipQueue.playerId === player.id) this.flipQueue = null;
    this.emit('bust', { playerId: player.id, card, hand: player.numbers.map((c) => c.value) });
  }

  _flip7(player) {
    player.status = Status.FLIP7;
    player.roundScore = this.scoreOf(player);
    this.flipQueue = null;
    // Nothing queued matters any more, but the cards still have to land somewhere.
    this._dropDeferred();
    if (this.pending) {
      this.discard.push(this.pending.card);
      this.pending = null;
    }

    // Flip 7 ends the round for everyone; the others still score what they hold.
    const alsoScoring = [];
    for (const other of this.players) {
      if (other !== player && other.status === Status.ACTIVE) {
        other.status = Status.STAYED;
        other.roundScore = this.scoreOf(other);
        alsoScoring.push(other.id);
      }
    }
    this.emit('flip7', { playerId: player.id, score: player.roundScore, alsoScoring });
  }

  _advanceTurn() {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.turnIndex + i) % n;
      if (this.players[idx].status === Status.ACTIVE) {
        this.turnIndex = idx;
        this.emit('turn', { playerId: this.players[idx].id });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- scoring

  /** The hand in the shape the shared scoring module expects. */
  handOf(player) {
    return {
      numbers: player.numbers.map((c) => c.value),
      addMods: player.modifiers.filter((c) => c.op === 'add').map((c) => c.value),
      doubled: player.modifiers.some((c) => c.op === 'mul'),
      flip7: player.status === Status.FLIP7,
      busted: player.status === Status.BUSTED,
    };
  }

  /** Round score for a hand: numbers (doubled by x2) plus the + modifiers. */
  scoreOf(player) {
    return scoreHand(this.handOf(player));
  }

  /** Itemised breakdown, used by the round summary screen. */
  breakdown(player) {
    const hand = this.handOf(player);
    return {
      base: hand.numbers.reduce((sum, v) => sum + v, 0),
      doubled: hand.doubled,
      bonus: hand.addMods.reduce((sum, v) => sum + v, 0),
      flip7: hand.flip7 ? FLIP7_BONUS : 0,
      busted: hand.busted,
      total: scoreHand(hand),
    };
  }

  _finalizeRound() {
    const results = this.players.map((p) => {
      p.roundScore = this.scoreOf(p);
      p.total += p.roundScore;
      p.history.push(p.roundScore);
      return { playerId: p.id, score: p.roundScore, total: p.total, status: p.status };
    });

    this.phase = 'round-over';
    this.emit('round-end', { round: this.round, results });

    const best = Math.max(...this.players.map((p) => p.total));
    if (best >= this.targetScore) {
      const leaders = this.players.filter((p) => p.total === best);
      // A tie at the top means one more round to break it.
      if (leaders.length === 1) {
        this.winner = leaders[0];
        this.phase = 'game-over';
        this.emit('game-over', { winnerId: this.winner.id });
      } else {
        this.emit('tiebreak', { playerIds: leaders.map((p) => p.id) });
      }
    }
  }
}
