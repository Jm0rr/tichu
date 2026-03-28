import {
  ClientGameState, GameState, Combo, Seat,
  findPlayableCombos, getTeamForSeat,
} from '@tichu/shared';
import { playCards, passTurn, giveDragonTrick, awardTrick } from '@tichu/shared';
import { determinize } from './determinize.js';
import { rollout } from './rollout.js';
import { MctsTree, MctsAction } from './tree.js';

const EXPLORATION = 1.0; // UCB1 exploration constant (lower than sqrt(2) for exploitation focus)

/**
 * Run ISMCTS search and return the best combo to play, or null to pass.
 */
export function ismctsSearch(
  clientState: ClientGameState,
  playable: Combo[],
  iterations: number,
): Combo | null {
  const tree = new MctsTree();
  const mySeat = clientState.mySeat;

  // Convert playable combos to MctsActions
  const rootActions: MctsAction[] = [];
  for (const combo of playable) {
    rootActions.push({ type: 'play', combo });
  }
  // Can always pass if there's a current trick
  if (clientState.currentTrick !== null) {
    rootActions.push({ type: 'pass' });
  }

  if (rootActions.length <= 1) {
    // Only one option, no need to search
    if (rootActions.length === 1 && rootActions[0].type === 'play') {
      return rootActions[0].combo;
    }
    return null;
  }

  for (let i = 0; i < iterations; i++) {
    // 1. Determinize
    const detState = determinize(clientState);

    // 2. Select + Expand + Rollout + Backprop
    runIteration(tree, detState, mySeat, rootActions);
  }

  // Return best action
  const bestAction = tree.bestRootAction();
  if (bestAction && bestAction.type === 'play') {
    return bestAction.combo;
  }
  return null; // pass
}

function runIteration(
  tree: MctsTree,
  detState: GameState,
  perspective: Seat,
  rootActions: MctsAction[],
): void {
  let simState = structuredClone(detState);
  let nodeId = tree.root();

  // Selection / Expansion
  const MAX_DEPTH = 20;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (simState.phase !== 'playing') break;

    // Get legal actions at this node
    const legal = nodeId === tree.root()
      ? rootActions
      : getLegalActions(simState);

    if (legal.length === 0) break;

    // Check for untried actions
    const expanded = tree.expandedActions(nodeId);
    const untried = legal.filter(a => !expanded.some(e => actionsMatch(a, e)));

    if (untried.length > 0) {
      // Expand: add one new child
      const action = untried[0];
      const childId = tree.expand(nodeId, action);
      applyAction(simState, action);
      nodeId = childId;
      break;
    }

    // All tried: select best child
    const childId = tree.selectChild(nodeId, legal, EXPLORATION);
    if (childId === null) break;

    const childAction = tree.nodes[childId].action!;
    applyAction(simState, childAction);
    nodeId = childId;
  }

  // Rollout
  const reward = rollout(simState, perspective);

  // Backpropagate
  tree.backpropagate(nodeId, reward);
}

function getLegalActions(state: GameState): MctsAction[] {
  const seat = state.turnIndex;
  const hand = state.players[seat].hand;
  const playable = findPlayableCombos(hand, state.currentTrick);
  const actions: MctsAction[] = [];

  for (const combo of playable) {
    actions.push({ type: 'play', combo });
  }

  if (state.currentTrick !== null) {
    actions.push({ type: 'pass' });
  }

  return actions;
}

function applyAction(state: GameState, action: MctsAction): void {
  const seat = state.turnIndex;
  let result;
  if (action.type === 'pass') {
    result = passTurn(state, seat);
  } else {
    result = playCards(state, seat, action.combo.cards);
  }
  Object.assign(state, result.state);
  // Auto-award trick if countdown started
  if (state.trickCountdown) {
    const award = awardTrick(state);
    Object.assign(state, award.state);
  }
}

function actionsMatch(a: MctsAction, b: MctsAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'pass') return true;
  if (a.type === 'play' && b.type === 'play') {
    if (a.combo.type !== b.combo.type || a.combo.cards.length !== b.combo.cards.length) return false;
    const aCards = a.combo.cards.map(c => c.type === 'special' ? c.name : `${c.suit}-${c.rank}`).sort();
    const bCards = b.combo.cards.map(c => c.type === 'special' ? c.name : `${c.suit}-${c.rank}`).sort();
    return aCards.every((id, i) => id === bCards[i]);
  }
  return false;
}
