import { Card } from '@tichu/shared';
import { analyzeHand } from './eval.js';

/** Decide whether to call Grand Tichu (first 8 cards visible). */
export function shouldCallGrandTichu(hand: Card[]): boolean {
  const analysis = analyzeHand(hand);
  return analysis.strength >= 18.0;
}

/** Decide whether to call Small Tichu (full 14 cards visible). */
export function shouldCallSmallTichu(hand: Card[]): boolean {
  const analysis = analyzeHand(hand);
  return analysis.tempo <= 5 && analysis.highCardCount >= 3;
}
