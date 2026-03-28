import { Card, Combo, ClientGameState, Seat, getPartnerSeat, getTeamForSeat } from '@tichu/shared';
import { sumPoints } from '@tichu/shared';

/**
 * Choose which combo to play when following (there's a current trick to beat).
 * Returns the combo to play, or null to pass.
 */
export function chooseFollow(state: ClientGameState, playable: Combo[]): Combo | null {
  const seat = state.mySeat;
  const hand = state.myHand;
  const partner = getPartnerSeat(seat);
  const partnerOut = state.players[partner].isOut;
  const myCards = hand.length;

  const nonBombs = playable.filter(c =>
    c.type !== 'fourOfAKindBomb' && c.type !== 'straightFlushBomb'
  );
  const bombs = playable.filter(c =>
    c.type === 'fourOfAKindBomb' || c.type === 'straightFlushBomb'
  );

  const opponents = ([0, 1, 2, 3] as Seat[]).filter(
    s => getTeamForSeat(s) !== getTeamForSeat(seat) && !state.players[s].isOut
  );
  const minOpponentCards = Math.min(...opponents.map(s => state.players[s].cardCount), 14);
  const opponentAboutToOut = minOpponentCards <= 2;

  // Is partner winning the trick?
  const partnerWinning = state.lastPlayedBy !== null &&
    getTeamForSeat(state.lastPlayedBy as Seat) === getTeamForSeat(seat);

  // --- Partner winning: usually pass ---
  if (partnerWinning) {
    // Play if we can go out
    const goOutPlay = nonBombs.find(c => c.cards.length === myCards);
    if (goOutPlay) return goOutPlay;
    return null; // pass
  }

  // --- Opponent about to go out: beat with whatever we can ---
  if (opponentAboutToOut && nonBombs.length > 0) {
    return findMinBeat(nonBombs);
  }

  // --- Can we go out by playing? ---
  const goOutPlay = nonBombs.find(c => c.cards.length === myCards);
  if (goOutPlay) return goOutPlay;

  // --- Try minimum beat ---
  if (nonBombs.length > 0) {
    // If trick has high points, consider playing a stronger card
    const trickPoints = sumPoints(state.currentTrickCards.flat());
    if (trickPoints >= 20 && nonBombs.length > 1) {
      // Play a mid-strength card to secure the points
      const sorted = [...nonBombs].sort((a, b) => a.rank - b.rank);
      return sorted[Math.min(1, sorted.length - 1)]; // second-lowest if available
    }
    return findMinBeat(nonBombs);
  }

  // --- Consider bombing ---
  if (bombs.length > 0) {
    const trickPoints = sumPoints(state.currentTrickCards.flat());
    const shouldBomb = trickPoints >= 15 || opponentAboutToOut ||
      (myCards <= 5 && partnerOut) || myCards <= 3;

    if (shouldBomb) {
      // Use weakest bomb
      bombs.sort((a, b) => a.rank - b.rank);
      return bombs[0];
    }
  }

  // Pass
  return null;
}

function findMinBeat(plays: Combo[]): Combo {
  let min = plays[0];
  for (const p of plays) {
    if (p.rank < min.rank) min = p;
  }
  return min;
}
