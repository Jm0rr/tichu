import { Combo, Card, cardId } from '@tichu/shared';

export type MctsAction = {
  type: 'play';
  combo: Combo;
} | {
  type: 'pass';
};

export type MctsNode = {
  id: number;
  parent: number | null;
  children: number[];
  action: MctsAction | null;
  visits: number;
  totalReward: number;
};

export class MctsTree {
  nodes: MctsNode[] = [];

  constructor() {
    // Create root node
    this.nodes.push({
      id: 0,
      parent: null,
      children: [],
      action: null,
      visits: 0,
      totalReward: 0,
    });
  }

  root(): number {
    return 0;
  }

  expand(parentId: number, action: MctsAction): number {
    const id = this.nodes.length;
    const node: MctsNode = {
      id,
      parent: parentId,
      children: [],
      action,
      visits: 0,
      totalReward: 0,
    };
    this.nodes.push(node);
    this.nodes[parentId].children.push(id);
    return id;
  }

  /** Get actions already expanded from this node. */
  expandedActions(nodeId: number): MctsAction[] {
    return this.nodes[nodeId].children
      .map(childId => this.nodes[childId].action!)
      .filter(a => a !== null);
  }

  /** Select best child matching one of the legal actions using UCB1. */
  selectChild(nodeId: number, legalActions: MctsAction[], exploration: number): number | null {
    const parent = this.nodes[nodeId];
    if (parent.children.length === 0) return null;

    const lnParent = Math.log(parent.visits + 1);
    let bestChild: number | null = null;
    let bestScore = -Infinity;

    for (const childId of parent.children) {
      const child = this.nodes[childId];
      // Check if this child's action is legal in current determinization
      if (!legalActions.some(a => actionsMatch(a, child.action!))) continue;

      if (child.visits === 0) {
        return childId; // Unvisited = infinite UCB1
      }

      const exploit = child.totalReward / child.visits;
      const explore = exploration * Math.sqrt(lnParent / child.visits);
      const score = exploit + explore;

      if (score > bestScore) {
        bestScore = score;
        bestChild = childId;
      }
    }

    return bestChild;
  }

  backpropagate(nodeId: number, reward: number): void {
    let id: number | null = nodeId;
    while (id !== null) {
      this.nodes[id].visits++;
      this.nodes[id].totalReward += reward;
      id = this.nodes[id].parent;
    }
  }

  /** Return the most-visited root action. */
  bestRootAction(): MctsAction | null {
    const root = this.nodes[0];
    if (root.children.length === 0) return null;

    let bestChild = root.children[0];
    let bestVisits = 0;

    for (const childId of root.children) {
      if (this.nodes[childId].visits > bestVisits) {
        bestVisits = this.nodes[childId].visits;
        bestChild = childId;
      }
    }

    return this.nodes[bestChild].action;
  }
}

export function actionsMatch(a: MctsAction, b: MctsAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'pass') return true;
  if (a.type === 'play' && b.type === 'play') {
    return comboMatch(a.combo, b.combo);
  }
  return false;
}

function comboMatch(a: Combo, b: Combo): boolean {
  if (a.type !== b.type || a.cards.length !== b.cards.length) return false;
  const aIds = a.cards.map(c => cardId(c)).sort();
  const bIds = b.cards.map(c => cardId(c)).sort();
  return aIds.every((id, i) => id === bIds[i]);
}
