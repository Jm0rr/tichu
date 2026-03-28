import EventSource from 'eventsource';
import {
  ClientGameState, Card, Combo, Seat, NormalRank,
  findPlayableCombos, getPartnerSeat, getTeamForSeat,
} from '@tichu/shared';
import { chooseLead } from './heuristic/lead.js';
import { chooseFollow } from './heuristic/follow.js';
import { choosePassCards } from './heuristic/pass.js';
import { shouldCallGrandTichu, shouldCallSmallTichu } from './heuristic/tichu.js';
import { ismctsSearch } from './ismcts/search.js';

// --- Configuration ---
const BASE_URL = process.env.TICHU_URL ?? 'http://localhost:3000/api';
const BOT_NAME = process.env.BOT_NAME ?? 'ISMCTS-Bot';
const ROOM_CODE = process.env.ROOM_CODE; // optional: join specific room
const PREFERRED_SEAT = process.env.SEAT ? parseInt(process.env.SEAT) as Seat : undefined;
const MCTS_ITERATIONS = parseInt(process.env.MCTS_ITERATIONS ?? '100');

let roomCode: string;
let mySeat: Seat;
let smallTichuDecided = false;
let lastPhase: string = '';

async function main() {
  console.log(`=== Tichu ISMCTS Bot: ${BOT_NAME} ===`);
  console.log(`Server: ${BASE_URL}`);
  console.log(`MCTS iterations: ${MCTS_ITERATIONS}`);

  // Join a room
  const joinInfo = await joinRoom();
  roomCode = joinInfo.roomCode;
  mySeat = joinInfo.seat as Seat;
  console.log(`Joined room ${roomCode} at seat ${mySeat}`);

  // Open SSE stream
  const streamUrl = `${BASE_URL}/rooms/${roomCode}/stream?seat=${mySeat}`;
  console.log(`Opening stream: ${streamUrl}`);
  const es = new EventSource(streamUrl);

  es.addEventListener('game-state', (event: MessageEvent) => {
    const state: ClientGameState = JSON.parse(event.data);
    handleGameState(state).catch(err => console.error('Error handling state:', err));
  });

  es.addEventListener('need-mah-jong-wish', () => {
    handleMahJongWish().catch(err => console.error('Error handling wish:', err));
  });

  es.addEventListener('need-dragon-choice', () => {
    // Handled via game-state dragonGiveaway flag
  });

  es.addEventListener('round-result', (event: MessageEvent) => {
    const result = JSON.parse(event.data);
    console.log(`Round result: Team 0 = ${result.totalScores[0]}, Team 1 = ${result.totalScores[1]}`);
  });

  es.onerror = (err: Event) => {
    console.error('SSE error, reconnecting...', err);
  };

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    es.close();
    process.exit(0);
  });
}

async function joinRoom(): Promise<{ seat: number; roomCode: string }> {
  if (ROOM_CODE) {
    const body: Record<string, unknown> = { name: BOT_NAME };
    if (PREFERRED_SEAT !== undefined) body.seat = PREFERRED_SEAT;
    const resp = await fetch(`${BASE_URL}/rooms/${ROOM_CODE}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`Failed to join room ${ROOM_CODE}: ${err.error}`);
    }
    return resp.json();
  }

  // Matchmaking
  const resp = await fetch(`${BASE_URL}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BOT_NAME }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Failed to join: ${err.error}`);
  }
  return resp.json();
}

async function act(action: Record<string, unknown>): Promise<void> {
  const resp = await fetch(`${BASE_URL}/rooms/${roomCode}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seat: mySeat, action }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'unknown' }));
    console.error(`Action failed:`, action.type, err.error);
  }
}

async function handleGameState(state: ClientGameState): Promise<void> {
  const me = state.players[mySeat];

  // Reset small tichu flag on new round
  if (state.phase !== lastPhase && state.phase === 'playing') {
    smallTichuDecided = false;
  }
  lastPhase = state.phase;

  // --- Grand Tichu ---
  if (state.phase === 'grandTichuWindow' && !me.grandTichuDecided) {
    const call = shouldCallGrandTichu(state.myHand);
    console.log(`Grand Tichu: ${call ? 'CALLING' : 'pass'} (${state.myHand.length} cards)`);
    await act({ type: 'call-grand-tichu', call });
    return;
  }

  // --- Passing ---
  if (state.phase === 'passing' && !me.passedCards) {
    const [left, partner, right] = choosePassCards(state.myHand);
    console.log(`Passing: left=${cardStr(left)}, partner=${cardStr(partner)}, right=${cardStr(right)}`);
    await act({ type: 'pass-cards', left, partner, right });
    return;
  }

  // --- Playing ---
  if (state.phase === 'playing') {
    // Dragon giveaway
    if (state.dragonGiveaway && state.dragonGiveawayBy === mySeat) {
      const opps = ([0, 1, 2, 3] as Seat[]).filter(
        s => getTeamForSeat(s) !== getTeamForSeat(mySeat) && !state.players[s].isOut
      );
      // Give to opponent with most cards
      let target = opps[0] ?? ((mySeat + 1) % 4 as Seat);
      let maxCards = 0;
      for (const opp of opps) {
        if (state.players[opp].cardCount > maxCards) {
          maxCards = state.players[opp].cardCount;
          target = opp;
        }
      }
      console.log(`Giving dragon trick to seat ${target}`);
      await act({ type: 'give-dragon-trick', to: target });
      return;
    }

    // Not my turn
    if (state.turnIndex !== mySeat) return;

    // Small Tichu decision (before first card)
    if (!me.hasPlayedFirstCard && !smallTichuDecided && me.tichuCall === 'none') {
      smallTichuDecided = true;
      if (shouldCallSmallTichu(state.myHand)) {
        console.log('Calling Small Tichu!');
        await act({ type: 'call-small-tichu' });
        // Don't return — still need to play
      }
    }

    // Find playable combos
    const playable = findPlayableCombos(state.myHand, state.currentTrick);

    if (playable.length === 0) {
      // Must pass
      if (state.currentTrick) {
        await act({ type: 'pass-turn' });
      }
      return;
    }

    // Single option: play it
    if (playable.length === 1 && state.currentTrick === null) {
      console.log(`Only option: ${comboStr(playable[0])}`);
      await act({ type: 'play-cards', cards: playable[0].cards });
      return;
    }

    // Use ISMCTS for play decisions (or heuristic fallback for simple cases)
    let chosen: Combo | null;

    if (state.currentTrick === null && playable.length <= 2) {
      // Simple leading decision: use heuristic
      chosen = chooseLead(state, playable);
    } else if (playable.length === 1) {
      chosen = playable[0];
    } else if (MCTS_ITERATIONS > 0) {
      // ISMCTS search
      const start = Date.now();
      chosen = ismctsSearch(state, playable, MCTS_ITERATIONS);
      const elapsed = Date.now() - start;
      if (elapsed > 1000) {
        console.log(`ISMCTS search: ${elapsed}ms (${MCTS_ITERATIONS} iterations)`);
      }
    } else {
      // Pure heuristic
      if (state.currentTrick === null) {
        chosen = chooseLead(state, playable);
      } else {
        chosen = chooseFollow(state, playable);
      }
    }

    if (chosen) {
      console.log(`Playing: ${comboStr(chosen)}`);
      await act({ type: 'play-cards', cards: chosen.cards });
    } else {
      console.log('Passing');
      await act({ type: 'pass-turn' });
    }
    return;
  }

  // --- Round End / Game End ---
  if ((state.phase === 'roundEnd' || state.phase === 'gameEnd') &&
      !state.roundEndReady.includes(mySeat)) {
    await act({ type: 'next-round' });
    return;
  }
}

async function handleMahJongWish(): Promise<void> {
  // Wish for Ace (high rank that's hard for opponents to play)
  console.log('Wishing for Ace (14)');
  await act({ type: 'mah-jong-wish', rank: 14 });
}

function cardStr(card: Card): string {
  if (card.type === 'special') return card.name;
  return `${card.suit}-${card.rank}`;
}

function comboStr(combo: Combo): string {
  return `${combo.type}(${combo.cards.map(cardStr).join(', ')})`;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
