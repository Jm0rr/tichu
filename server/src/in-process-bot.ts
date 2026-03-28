import { Server } from 'socket.io';
import {
  toClientState, Seat, PlayResult, NormalRank,
  findPlayableCombos, getTeamForSeat, Combo,
} from '@tichu/shared';
import {
  Room, isApiPlayer,
  handleGrandTichu, handleSmallTichu, handlePassCards,
  handlePlayCards, handlePassTurn, handleDragonGiveaway, handleMahJongWish,
  startNextRound,
} from './rooms.js';

// Bot logic imports from the bot package
import {
  chooseLead, chooseFollow, choosePassCards,
  shouldCallGrandTichu, shouldCallSmallTichu,
  ismctsSearch,
} from '@tichu/bot/logic';

const MCTS_ITERATIONS = 250;
const PLAY_DELAY_MS = 800;  // delay for play decisions (visible to humans)
const FAST_DELAY_MS = 200;  // delay for admin actions (grand tichu, passing, round end)

// Registered callbacks (set via setup to avoid circular imports with handler.ts)
let _io: Server;
let _broadcastState: (io: Server, room: Room) => void;
let _processPlayResult: (io: Server, room: Room, seat: Seat, result: PlayResult) => void;

export function setupBotRunner(
  io: Server,
  broadcastState: typeof _broadcastState,
  processPlayResult: typeof _processPlayResult,
): void {
  _io = io;
  _broadcastState = broadcastState;
  _processPlayResult = processPlayResult;
}

const pendingTicks = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a bot tick for a room. Called after broadcastState.
 * Uses setTimeout to avoid recursive call stacks.
 */
export function scheduleTickBots(room: Room): void {
  if (!_io) return;
  if (pendingTicks.has(room.code)) return;

  // Quick check: any AI players?
  let hasAi = false;
  for (const [sid] of room.playerSockets) {
    if (isApiPlayer(sid)) { hasAi = true; break; }
  }
  if (!hasAi) return;

  // Determine delay based on phase
  const delay = room.state.phase === 'playing' ? PLAY_DELAY_MS : FAST_DELAY_MS;

  const timer = setTimeout(() => {
    pendingTicks.delete(room.code);
    tickBots(room);
  }, delay);
  pendingTicks.set(room.code, timer);
}

function tickBots(room: Room): void {
  const state = room.state;

  // --- Grand Tichu phase: all AI decide at once ---
  if (state.phase === 'grandTichuWindow') {
    let acted = false;
    for (const [socketId, seat] of room.playerSockets) {
      if (!isApiPlayer(socketId)) continue;
      if (state.players[seat].grandTichuDecided) continue;
      const cs = toClientState(state, seat);
      const call = shouldCallGrandTichu(cs.myHand);
      handleGrandTichu(room, seat, call);
      acted = true;
    }
    if (acted) {
      _broadcastState(_io, room);
      scheduleTickBots(room);
    }
    return;
  }

  // --- Passing phase: all AI pass at once ---
  if (state.phase === 'passing') {
    let acted = false;
    for (const [socketId, seat] of room.playerSockets) {
      if (!isApiPlayer(socketId)) continue;
      if (room.passes.has(seat)) continue;
      if (state.players[seat].hand.length === 0) continue;
      const cs = toClientState(state, seat);
      const [left, partner, right] = choosePassCards(cs.myHand);
      handlePassCards(room, seat, { left, partner, right });
      acted = true;
    }
    if (acted) {
      _broadcastState(_io, room);
      scheduleTickBots(room);
    }
    return;
  }

  // --- Playing phase: one bot acts per tick ---
  if (state.phase === 'playing') {
    // Don't act during countdowns or bomb windows
    if (state.trickCountdown || state.bombWindow) return;

    // Handle dragon giveaway
    if (state.dragonGiveaway && state.dragonGiveawayBy != null) {
      const seat = state.dragonGiveawayBy;
      const socketId = room.seatPlayers.get(seat);
      if (socketId && isApiPlayer(socketId)) {
        const opps = ([0, 1, 2, 3] as Seat[]).filter(
          s => getTeamForSeat(s) !== getTeamForSeat(seat) && !state.players[s].isOut
        );
        let target = opps[0] ?? ((seat + 1) % 4 as Seat);
        let maxCards = 0;
        for (const opp of opps) {
          if (state.players[opp].hand.length > maxCards) {
            maxCards = state.players[opp].hand.length;
            target = opp;
          }
        }
        const result = handleDragonGiveaway(room, seat, target);
        _processPlayResult(_io, room, seat, result);
        scheduleTickBots(room);
      }
      return;
    }

    // Check if current turn is an AI player
    const turnSeat = state.turnIndex;
    const turnSocketId = room.seatPlayers.get(turnSeat);
    if (!turnSocketId || !isApiPlayer(turnSocketId)) return;

    // Small Tichu decision (before first play)
    if (!state.players[turnSeat].hasPlayedFirstCard &&
        state.players[turnSeat].tichuCall === 'none') {
      const cs = toClientState(state, turnSeat);
      if (shouldCallSmallTichu(cs.myHand)) {
        handleSmallTichu(room, turnSeat);
        _broadcastState(_io, room);
      }
    }

    // Find playable combos
    const clientState = toClientState(state, turnSeat);
    const playable = findPlayableCombos(clientState.myHand, state.currentTrick);

    if (playable.length === 0) {
      if (state.currentTrick) {
        const result = handlePassTurn(room, turnSeat);
        _processPlayResult(_io, room, turnSeat, result);
        scheduleTickBots(room);
      }
      return;
    }

    // Decide what to play
    let chosen: Combo | null;
    if (playable.length === 1) {
      chosen = playable[0];
    } else if (playable.length > 2 && MCTS_ITERATIONS > 0) {
      chosen = ismctsSearch(clientState, playable, MCTS_ITERATIONS);
    } else if (state.currentTrick === null) {
      chosen = chooseLead(clientState, playable);
    } else {
      chosen = chooseFollow(clientState, playable);
    }

    if (chosen) {
      const result = handlePlayCards(room, turnSeat, chosen.cards);
      _processPlayResult(_io, room, turnSeat, result);
      // Handle MahJong wish immediately
      if (result.needMahJongWish) {
        handleMahJongWish(room, turnSeat, 14 as NormalRank);
        _broadcastState(_io, room);
      }
    } else {
      if (state.currentTrick) {
        const result = handlePassTurn(room, turnSeat);
        _processPlayResult(_io, room, turnSeat, result);
      }
    }
    scheduleTickBots(room);
    return;
  }

  // --- Round End / Game End: all AI auto-acknowledge ---
  if (state.phase === 'roundEnd' || state.phase === 'gameEnd') {
    let acted = false;
    for (const [socketId, seat] of room.playerSockets) {
      if (!isApiPlayer(socketId)) continue;
      if (state.roundEndReady.includes(seat)) continue;
      state.roundEndReady.push(seat);
      acted = true;
    }
    if (acted) {
      if (state.roundEndReady.length === 4 && state.phase === 'roundEnd') {
        startNextRound(room);
      }
      _broadcastState(_io, room);
      scheduleTickBots(room);
    }
    return;
  }
}
