import {
  GameState, Seat, Card, Combo,
  getTeamForSeat, getPartnerSeat,
  findPlayableCombos, sumPoints,
} from '@tichu/shared';
import { playCards, passTurn, giveDragonTrick, awardTrick } from '@tichu/shared';

/**
 * Play out the rest of a round using heuristic policy.
 * Returns +1 if perspective's team wins the round, -1 if loses, 0 if tie.
 */
export function rollout(state: GameState, perspective: Seat): number {
  const myTeam = getTeamForSeat(perspective);
  let safety = 0;

  while (state.phase === 'playing') {
    if (++safety > 500) break;

    if (state.dragonGiveaway) {
      const seat = state.dragonGiveawayBy!;
      // Give to opponent with most cards
      const opps = ([0, 1, 2, 3] as Seat[]).filter(
        s => getTeamForSeat(s) !== getTeamForSeat(seat) && !state.players[s].isOut
      );
      let target = opps[0] ?? ((seat + 1) % 4 as Seat);
      let maxCards = 0;
      for (const opp of opps) {
        if (state.players[opp].hand.length > maxCards) {
          maxCards = state.players[opp].hand.length;
          target = opp;
        }
      }
      const result = giveDragonTrick(state, seat, target);
      if ('state' in result) state = result.state;
      else break;
      continue;
    }

    const seat = state.turnIndex;
    const hand = state.players[seat].hand;
    const playable = findPlayableCombos(hand, state.currentTrick);

    if (playable.length === 0) {
      // Must pass
      if (state.currentTrick) {
        const result = passTurn(state, seat);
        state = result.state;
        // Auto-award trick if countdown started
        if (state.trickCountdown) {
          const awardResult = awardTrick(state);
          state = awardResult.state;
        }
      } else {
        break; // No legal action at all
      }
      continue;
    }

    // Use heuristic to choose
    const combo = heuristicChoose(state, seat, playable);
    const result = playCards(state, seat, combo.cards);
    state = result.state;

    // Handle mah jong wish
    if (result.needMahJongWish) {
      state = { ...state, mahJongWish: 14 as any };
    }

    // Auto-award trick countdowns (skip the timer in simulation)
    if (state.trickCountdown) {
      const awardResult = awardTrick(state);
      state = awardResult.state;
    }
  }

  // Evaluate outcome from round history
  if (state.roundHistory && state.roundHistory.length > 0) {
    const last = state.roundHistory[state.roundHistory.length - 1];
    const myScore = last.roundTotal[myTeam];
    const oppScore = last.roundTotal[1 - myTeam];
    if (myScore > oppScore) return 1;
    if (myScore < oppScore) return -1;
    return 0;
  }

  // Fallback: check cumulative scores
  const myScore = state.teams[myTeam].score;
  const oppScore = state.teams[1 - myTeam].score;
  if (myScore > oppScore) return 1;
  if (myScore < oppScore) return -1;
  return 0;
}

/** Simple heuristic action choice for rollout. */
function heuristicChoose(state: GameState, seat: Seat, playable: Combo[]): Combo {
  const isLeading = state.currentTrick === null;

  if (isLeading) {
    // Lead: prefer multi-card combos, lowest rank
    let best = playable[0];
    for (const c of playable) {
      if (c.cards.length > best.cards.length ||
          (c.cards.length === best.cards.length && c.rank < best.rank)) {
        best = c;
      }
    }
    return best;
  } else {
    // Following: check if partner is winning
    const partner = getPartnerSeat(seat);
    if (state.lastPlayedBy !== null && getTeamForSeat(state.lastPlayedBy as Seat) === getTeamForSeat(seat)) {
      // Partner winning - play to go out or use weakest play
      const goOut = playable.find(c => c.cards.length === state.players[seat].hand.length);
      if (goOut) return goOut;
    }

    // Minimum beat (non-bomb preferred)
    const nonBombs = playable.filter(c =>
      c.type !== 'fourOfAKindBomb' && c.type !== 'straightFlushBomb'
    );
    const candidates = nonBombs.length > 0 ? nonBombs : playable;
    let min = candidates[0];
    for (const c of candidates) {
      if (c.rank < min.rank) min = c;
    }
    return min;
  }
}
