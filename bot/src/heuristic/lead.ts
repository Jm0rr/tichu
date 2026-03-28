import { Card, Combo, ClientGameState, Seat, getPartnerSeat, getTeamForSeat } from '@tichu/shared';
import { analyzeHand } from './eval.js';

/** Choose which combo to play when leading (no current trick). */
export function chooseLead(state: ClientGameState, playable: Combo[]): Combo {
  const seat = state.mySeat;
  const hand = state.myHand;
  const analysis = analyzeHand(hand);
  const partner = getPartnerSeat(seat);
  const partnerOut = state.players[partner].isOut;
  const partnerCards = state.players[partner].cardCount;

  const opponents = ([0, 1, 2, 3] as Seat[]).filter(
    s => getTeamForSeat(s) !== getTeamForSeat(seat) && !state.players[s].isOut
  );
  const minOpponentCards = Math.min(...opponents.map(s => state.players[s].cardCount), 14);

  // Filter out bombs for normal play
  const nonBombs = playable.filter(c =>
    c.type !== 'fourOfAKindBomb' && c.type !== 'straightFlushBomb'
  );
  const plays = nonBombs.length > 0 ? nonBombs : playable;

  // --- Dog logic ---
  const dogPlay = plays.find(c =>
    c.cards.length === 1 && c.cards[0].type === 'special' && c.cards[0].name === 'dog'
  );
  if (dogPlay && !partnerOut) {
    if (partnerCards < hand.length || analysis.tempo <= 6 ||
        (minOpponentCards <= 3 && partnerCards <= hand.length)) {
      return dogPlay;
    }
  }

  // --- Opponent about to go out: play aggressively ---
  if (minOpponentCards <= 3) {
    return chooseAggressiveLead(plays, hand);
  }

  // --- Strong hand: lead multi-card combos ---
  if (analysis.tempo <= 6) {
    const strongLead = findBestStrongLead(plays);
    if (strongLead) return strongLead;
  }

  // --- Partner out: go out fast ---
  if (partnerOut) {
    return chooseFastestExitLead(plays);
  }

  // --- Default: largest combo, lowest rank ---
  return chooseWeakHandLead(plays);
}

function chooseAggressiveLead(plays: Combo[], hand: Card[]): Combo {
  let best = plays[0];
  for (const combo of plays) {
    if (combo.cards.length === 1 && combo.cards[0].type === 'special' && combo.cards[0].name === 'dog') continue;
    if (combo.cards.length > best.cards.length ||
        (combo.cards.length === best.cards.length && combo.rank > best.rank)) {
      best = combo;
    }
  }
  return best;
}

function findBestStrongLead(plays: Combo[]): Combo | null {
  // Prefer multi-card combos that are hard to beat
  const multiCard = plays.filter(c =>
    c.cards.length >= 2 &&
    c.type !== 'fourOfAKindBomb' && c.type !== 'straightFlushBomb' &&
    !(c.cards.length === 1 && c.cards[0].type === 'special' && c.cards[0].name === 'dog')
  );

  if (multiCard.length > 0) {
    // Sort: prefer straights/consec pairs, then length, then low rank
    multiCard.sort((a, b) => {
      const typeScore = (c: Combo) => {
        if (c.type === 'straight' || c.type === 'consecutivePairs') return 3;
        if (c.type === 'fullHouse') return 2;
        if (c.type === 'triple' || c.type === 'pair') return 1;
        return 0;
      };
      return (typeScore(b) - typeScore(a)) || (b.cards.length - a.cards.length) || (a.rank - b.rank);
    });
    return multiCard[0];
  }

  // No multi-card: lead lowest single
  const singles = plays.filter(c => c.type === 'single' && c.rank > 0);
  if (singles.length > 0) {
    singles.sort((a, b) => a.rank - b.rank);
    return singles[0];
  }
  return null;
}

function chooseFastestExitLead(plays: Combo[]): Combo {
  let best = plays[0];
  for (const combo of plays) {
    if (combo.cards.length === 1 && combo.cards[0].type === 'special' && combo.cards[0].name === 'dog') continue;
    if (combo.cards.length > best.cards.length ||
        (combo.cards.length === best.cards.length && combo.rank < best.rank)) {
      best = combo;
    }
  }
  return best;
}

function chooseWeakHandLead(plays: Combo[]): Combo {
  let best = plays[0];
  for (const combo of plays) {
    if (combo.cards.length > best.cards.length ||
        (combo.cards.length === best.cards.length && combo.rank < best.rank)) {
      best = combo;
    }
  }
  return best;
}
