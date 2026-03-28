import {
  Card, ClientGameState, GameState, Seat,
  getTeamForSeat, createInitialState,
} from '@tichu/shared';
import { sortHand, createDeck } from '@tichu/shared';

/**
 * Build a full GameState from a ClientGameState by randomly assigning
 * unknown cards to opponents. This enables MCTS simulation.
 */
export function determinize(clientState: ClientGameState): GameState {
  const state = createInitialState(clientState.settings);
  const mySeat = clientState.mySeat;

  // Copy over the known state
  state.phase = 'playing';
  state.currentTrick = clientState.currentTrick;
  state.currentTrickCards = clientState.currentTrickCards;
  state.passCount = clientState.passCount;
  state.turnIndex = clientState.turnIndex;
  state.lastPlayedBy = clientState.lastPlayedBy;
  state.mahJongWish = clientState.mahJongWish;
  state.outCount = clientState.outCount;
  state.roundNumber = clientState.roundNumber;
  state.bombWindow = false;
  state.trickCountdown = null;
  state.dragonGiveaway = clientState.dragonGiveaway;
  state.dragonGiveawayBy = clientState.dragonGiveawayBy;
  state.playedCards = clientState.playedCards;
  state.teams = JSON.parse(JSON.stringify(clientState.teams));

  // Set up players
  for (let s = 0; s < 4; s++) {
    const cp = clientState.players[s];
    const p = state.players[s];
    p.name = cp.name;
    p.seat = cp.seat;
    p.tichuCall = cp.tichuCall;
    p.hasPlayedFirstCard = cp.hasPlayedFirstCard;
    p.isOut = cp.isOut;
    p.outOrder = cp.outOrder;
    p.grandTichuDecided = cp.grandTichuDecided;
    p.passedCards = cp.passedCards;
    p.isAi = cp.isAi;
  }

  // My hand is known
  state.players[mySeat].hand = [...clientState.myHand];

  // Build pool of unknown cards
  const knownCards = new Set<string>();
  for (const card of clientState.myHand) {
    knownCards.add(cardKey(card));
  }
  for (const card of clientState.playedCards) {
    knownCards.add(cardKey(card));
  }
  for (const trickCards of clientState.currentTrickCards) {
    for (const card of trickCards) {
      knownCards.add(cardKey(card));
    }
  }

  const fullDeck = createDeck();
  const unknown = fullDeck.filter(c => !knownCards.has(cardKey(c)));

  // Shuffle unknown cards
  shuffleArray(unknown);

  // Distribute to other players
  let idx = 0;
  for (let s = 0; s < 4; s++) {
    if (s === mySeat) continue;
    const handSize = clientState.players[s].cardCount;
    state.players[s].hand = unknown.slice(idx, idx + handSize);
    sortHand(state.players[s].hand);
    idx += handSize;
  }

  return state;
}

function cardKey(card: Card): string {
  if (card.type === 'special') return card.name;
  return `${card.suit}-${card.rank}`;
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
