import { Card, Combo } from '@tichu/shared';
import { findPlayableCombos } from '@tichu/shared';

export type HandAnalysis = {
  numCards: number;
  hasDragon: boolean;
  hasPhoenix: boolean;
  hasDog: boolean;
  hasMahjong: boolean;
  bombCount: number;
  highCardCount: number;
  tempo: number;
  strength: number;
};

function isSpecial(card: Card, name: string): boolean {
  return card.type === 'special' && card.name === name;
}

export function analyzeHand(hand: Card[]): HandAnalysis {
  const hasDragon = hand.some(c => isSpecial(c, 'dragon'));
  const hasPhoenix = hand.some(c => isSpecial(c, 'phoenix'));
  const hasDog = hand.some(c => isSpecial(c, 'dog'));
  const hasMahjong = hand.some(c => isSpecial(c, 'mahjong'));

  const highCardCount = hand.filter(c =>
    (c.type === 'normal' && c.rank >= 12) || isSpecial(c, 'dragon')
  ).length;

  const allCombos = findPlayableCombos(hand, null);
  const bombCount = allCombos.filter(c =>
    c.type === 'fourOfAKindBomb' || c.type === 'straightFlushBomb'
  ).length;

  const tempo = estimateTempo(hand);

  // Composite strength score
  let strength = 0;
  strength -= tempo * 2.0;        // group penalty
  strength += highCardCount * 1.5;
  if (hasDragon) strength += 5.0;
  if (hasPhoenix) strength += 4.0;
  strength += bombCount * 8.0;

  return {
    numCards: hand.length,
    hasDragon,
    hasPhoenix,
    hasDog,
    hasMahjong,
    bombCount,
    highCardCount,
    tempo,
    strength,
  };
}

/** Estimate minimum plays to empty hand using greedy largest-combo-first. */
export function estimateTempo(hand: Card[]): number {
  let remaining = [...hand];
  let plays = 0;

  while (remaining.length > 0) {
    const combos = findPlayableCombos(remaining, null);
    if (combos.length === 0) {
      plays += remaining.length;
      break;
    }

    // Pick the largest combo (most cards)
    let best = combos[0];
    for (const c of combos) {
      if (c.cards.length > best.cards.length ||
          (c.cards.length === best.cards.length && c.rank < best.rank)) {
        best = c;
      }
    }

    remaining = removeCards(remaining, best.cards);
    plays++;
  }

  return plays;
}

export function removeCards(hand: Card[], toRemove: Card[]): Card[] {
  const result = [...hand];
  for (const card of toRemove) {
    const idx = result.findIndex(c => cardEqual(c, card));
    if (idx >= 0) result.splice(idx, 1);
  }
  return result;
}

function cardEqual(a: Card, b: Card): boolean {
  if (a.type === 'special' && b.type === 'special') return a.name === b.name;
  if (a.type === 'normal' && b.type === 'normal') return a.suit === b.suit && a.rank === b.rank;
  return false;
}
