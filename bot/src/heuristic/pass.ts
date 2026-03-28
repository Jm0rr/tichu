import { Card } from '@tichu/shared';

/** Choose 3 cards to pass: returns [left, partner, right]. */
export function choosePassCards(hand: Card[]): [Card, Card, Card] {
  // Never pass Dragon or Phoenix
  let candidates = hand.filter(c =>
    !(c.type === 'special' && (c.name === 'dragon' || c.name === 'phoenix'))
  );

  // Never pass cards in a four-of-a-kind bomb
  const bombCards = findBombCards(hand);
  candidates = candidates.filter(c => !bombCards.some(b => cardEqual(b, c)));

  // Sort by rank (low to high)
  candidates.sort((a, b) => sortKey(a) - sortKey(b));

  if (candidates.length < 3) {
    return [hand[0], hand[1], hand[2]];
  }

  // To partner: lowest card
  const toPartner = candidates[0];
  // To opponents: next lowest cards
  const toLeft = candidates[1];
  const toRight = candidates[2];

  return [toLeft, toPartner, toRight];
}

function findBombCards(hand: Card[]): Card[] {
  const rankGroups = new Map<number, Card[]>();
  for (const card of hand) {
    if (card.type === 'normal') {
      const group = rankGroups.get(card.rank) ?? [];
      group.push(card);
      rankGroups.set(card.rank, group);
    }
  }
  const result: Card[] = [];
  for (const cards of rankGroups.values()) {
    if (cards.length === 4) result.push(...cards);
  }
  return result;
}

function sortKey(card: Card): number {
  if (card.type === 'normal') return card.rank;
  switch (card.name) {
    case 'mahjong': return 1;
    case 'dog': return 0;
    case 'phoenix': return 15;
    case 'dragon': return 16;
  }
}

function cardEqual(a: Card, b: Card): boolean {
  if (a.type === 'special' && b.type === 'special') return a.name === b.name;
  if (a.type === 'normal' && b.type === 'normal') return a.suit === b.suit && a.rank === b.rank;
  return false;
}
