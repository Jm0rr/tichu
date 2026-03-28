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
const BOT_COUNT = parseInt(process.env.BOT_COUNT ?? '1');

class BotInstance {
  private roomCode: string = '';
  private mySeat: Seat = 0 as Seat;
  private smallTichuDecided = false;
  private lastPhase: string = '';
  private name: string;
  private es: EventSource | null = null;

  constructor(name: string) {
    this.name = name;
  }

  private log(msg: string) {
    console.log(`[${this.name} seat=${this.mySeat}] ${msg}`);
  }

  async start() {
    this.log(`Starting...`);

    const joinInfo = await this.joinRoom();
    this.roomCode = joinInfo.roomCode;
    this.mySeat = joinInfo.seat as Seat;
    this.log(`Joined room ${this.roomCode}`);

    const streamUrl = `${BASE_URL}/rooms/${this.roomCode}/stream?seat=${this.mySeat}`;
    this.es = new EventSource(streamUrl);

    this.es.addEventListener('game-state', (event: MessageEvent) => {
      const state: ClientGameState = JSON.parse(event.data);
      this.handleGameState(state).catch(err => this.log(`Error: ${err}`));
    });

    this.es.addEventListener('need-mah-jong-wish', () => {
      this.handleMahJongWish().catch(err => this.log(`Wish error: ${err}`));
    });

    this.es.addEventListener('need-dragon-choice', () => {
      // Handled via game-state dragonGiveaway flag
    });

    this.es.addEventListener('round-result', (event: MessageEvent) => {
      const result = JSON.parse(event.data);
      this.log(`Round result: Team 0 = ${result.totalScores[0]}, Team 1 = ${result.totalScores[1]}`);
    });

    this.es.onerror = () => {
      this.log('SSE error, reconnecting...');
    };
  }

  close() {
    this.es?.close();
  }

  private async joinRoom(): Promise<{ seat: number; roomCode: string }> {
    if (ROOM_CODE) {
      const body: Record<string, unknown> = { name: this.name };
      if (PREFERRED_SEAT !== undefined && BOT_COUNT === 1) body.seat = PREFERRED_SEAT;
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
      body: JSON.stringify({ name: this.name }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`Failed to join: ${err.error}`);
    }
    return resp.json();
  }

  private async act(action: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${BASE_URL}/rooms/${this.roomCode}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat: this.mySeat, action }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'unknown' }));
      this.log(`Action failed: ${action.type} ${err.error}`);
    }
  }

  private async handleGameState(state: ClientGameState): Promise<void> {
    const me = state.players[this.mySeat];

    // Reset small tichu flag on new round
    if (state.phase !== this.lastPhase && state.phase === 'playing') {
      this.smallTichuDecided = false;
    }
    this.lastPhase = state.phase;

    // --- Grand Tichu ---
    if (state.phase === 'grandTichuWindow' && !me.grandTichuDecided) {
      const call = shouldCallGrandTichu(state.myHand);
      this.log(`Grand Tichu: ${call ? 'CALLING' : 'pass'} (${state.myHand.length} cards)`);
      await this.act({ type: 'call-grand-tichu', call });
      return;
    }

    // --- Passing ---
    if (state.phase === 'passing' && !me.passedCards) {
      const [left, partner, right] = choosePassCards(state.myHand);
      this.log(`Passing: left=${cardStr(left)}, partner=${cardStr(partner)}, right=${cardStr(right)}`);
      await this.act({ type: 'pass-cards', left, partner, right });
      return;
    }

    // --- Playing ---
    if (state.phase === 'playing') {
      // Dragon giveaway
      if (state.dragonGiveaway && state.dragonGiveawayBy === this.mySeat) {
        const opps = ([0, 1, 2, 3] as Seat[]).filter(
          s => getTeamForSeat(s) !== getTeamForSeat(this.mySeat) && !state.players[s].isOut
        );
        let target = opps[0] ?? ((this.mySeat + 1) % 4 as Seat);
        let maxCards = 0;
        for (const opp of opps) {
          if (state.players[opp].cardCount > maxCards) {
            maxCards = state.players[opp].cardCount;
            target = opp;
          }
        }
        this.log(`Giving dragon trick to seat ${target}`);
        await this.act({ type: 'give-dragon-trick', to: target });
        return;
      }

      // Not my turn
      if (state.turnIndex !== this.mySeat) return;

      // Small Tichu decision (before first card)
      if (!me.hasPlayedFirstCard && !this.smallTichuDecided && me.tichuCall === 'none') {
        this.smallTichuDecided = true;
        if (shouldCallSmallTichu(state.myHand)) {
          this.log('Calling Small Tichu!');
          await this.act({ type: 'call-small-tichu' });
        }
      }

      // Find playable combos
      const playable = findPlayableCombos(state.myHand, state.currentTrick);

      if (playable.length === 0) {
        if (state.currentTrick) {
          await this.act({ type: 'pass-turn' });
        }
        return;
      }

      // Single option: play it
      if (playable.length === 1 && state.currentTrick === null) {
        this.log(`Only option: ${comboStr(playable[0])}`);
        await this.act({ type: 'play-cards', cards: playable[0].cards });
        return;
      }

      // Use ISMCTS for play decisions
      let chosen: Combo | null;

      if (state.currentTrick === null && playable.length <= 2) {
        chosen = chooseLead(state, playable);
      } else if (playable.length === 1) {
        chosen = playable[0];
      } else if (MCTS_ITERATIONS > 0) {
        const start = Date.now();
        chosen = ismctsSearch(state, playable, MCTS_ITERATIONS);
        const elapsed = Date.now() - start;
        if (elapsed > 1000) {
          this.log(`ISMCTS search: ${elapsed}ms (${MCTS_ITERATIONS} iterations)`);
        }
      } else {
        if (state.currentTrick === null) {
          chosen = chooseLead(state, playable);
        } else {
          chosen = chooseFollow(state, playable);
        }
      }

      if (chosen) {
        this.log(`Playing: ${comboStr(chosen)}`);
        await this.act({ type: 'play-cards', cards: chosen.cards });
      } else {
        this.log('Passing');
        await this.act({ type: 'pass-turn' });
      }
      return;
    }

    // --- Round End / Game End ---
    if ((state.phase === 'roundEnd' || state.phase === 'gameEnd') &&
        !state.roundEndReady.includes(this.mySeat)) {
      await this.act({ type: 'next-round' });
      return;
    }
  }

  private async handleMahJongWish(): Promise<void> {
    this.log('Wishing for Ace (14)');
    await this.act({ type: 'mah-jong-wish', rank: 14 });
  }
}

function cardStr(card: Card): string {
  if (card.type === 'special') return card.name;
  return `${card.suit}-${card.rank}`;
}

function comboStr(combo: Combo): string {
  return `${combo.type}(${combo.cards.map(cardStr).join(', ')})`;
}

async function main() {
  console.log(`=== Tichu ISMCTS Bot ===`);
  console.log(`Server: ${BASE_URL}`);
  console.log(`MCTS iterations: ${MCTS_ITERATIONS}`);
  console.log(`Bot count: ${BOT_COUNT}`);

  const bots: BotInstance[] = [];

  for (let i = 0; i < BOT_COUNT; i++) {
    const name = BOT_COUNT === 1 ? BOT_NAME : `${BOT_NAME}-${i + 1}`;
    const bot = new BotInstance(name);
    bots.push(bot);
    await bot.start();
    // Small delay between joins to avoid race conditions
    if (i < BOT_COUNT - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  process.on('SIGINT', () => {
    console.log('Shutting down all bots...');
    for (const bot of bots) bot.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
