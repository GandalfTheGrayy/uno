import crypto from 'crypto';
import { Server, Socket } from 'socket.io';
import { generateDeck } from './game/deck.js';
import type { GameState } from './game/types.js';
import { dealInitial, playCard, applyPendingDrawAndSkip, drawCards, callUno, penalizeMissingUno, nextIndex, canPlayOnTop } from './game/logic.js';
import { pickColorFromHand } from './game/botUtils.js';

interface Player {
  id: string; // socket id or persistent id
  name: string;
  isBot: boolean;
}

interface Room {
  id: string;
  players: Player[];
  hostId: string;
  game?: GameState;
  startedAt?: number;
  turnDeadlineAt?: number;
  turnTimer?: ReturnType<typeof setTimeout> | null;
  botActionTimeout?: ReturnType<typeof setTimeout> | null;
  unoTimers?: Map<string, ReturnType<typeof setTimeout>>;
  unoGraceUntil?: Map<string, number>;
  maxPlayers: number;
}

const rooms = new Map<string, Room>();

const MAX_PLAYERS = 10;
const BOT_THINK_DELAY_MS = 1000;
const BOT_NAMES = ['Bot Ada', 'Bot Berk', 'Bot Cem', 'Bot Deniz'];

function botId(roomId: string, slot: number) {
  return `${roomId}-bot-${slot}`;
}

function botNameForSlot(slot: number) {
  return BOT_NAMES[slot] ?? `Bot ${slot + 1}`;
}

function makeBot(room: Room, slot: number): Player {
  return {
    id: botId(room.id, slot),
    name: botNameForSlot(slot),
    isBot: true,
  };
}

function findNextBotSlot(room: Room): number {
  for (let i = 0; i < room.maxPlayers; i++) {
    const id = botId(room.id, i);
    if (!room.players.some(p => p.id === id)) {
      return i;
    }
  }
  return room.players.length;
}

function ensureBotSeats(room: Room) {
  while (room.players.length < room.maxPlayers) {
    const slot = findNextBotSlot(room);
    room.players.push(makeBot(room, slot));
  }
}

function removeOneBot(room: Room): Player | undefined {
  const idx = room.players.findIndex(p => p.isBot);
  if (idx === -1) return undefined;
  const [bot] = room.players.splice(idx, 1);
  return bot;
}

function getHumanCount(room: Room): number {
  return room.players.filter(p => !p.isBot).length;
}

function clearUnoTimer(room: Room, playerId: string) {
  const timer = room.unoTimers?.get(playerId);
  if (timer) clearTimeout(timer);
  room.unoTimers?.delete(playerId);
  room.unoGraceUntil?.delete(playerId);
}

function scheduleUnoPenalty(io: Server, room: Room, playerId: string) {
  clearUnoTimer(room, playerId);
  const until = Date.now() + UNO_GRACE_MS;
  room.unoGraceUntil?.set(playerId, until);
  const timer = setTimeout(() => {
    const latest = rooms.get(room.id);
    if (!latest || !latest.game) return;
    penalizeMissingUno(latest.game, playerId);
    clearUnoTimer(latest, playerId);
    broadcastState(io, latest);
  }, UNO_GRACE_MS);
  room.unoTimers?.set(playerId, timer);
}

const TURN_MS = 20000;
const UNO_GRACE_MS = 3000;

function broadcastState(io: Server, room: Room) {
  if (!room.game) return;
  const snapshot = room.game;
  const base = {
    roomId: room.id,
    players: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })),
    currentPlayerId: snapshot.players[snapshot.currentPlayerIndex],
    direction: snapshot.direction,
    activeColor: snapshot.activeColor,
    discardTop: snapshot.discardPile[snapshot.discardPile.length - 1],
    handsCount: Object.fromEntries(Object.entries(snapshot.hands).map(([pid, h]) => [pid, h.length])),
    remainingMs: Math.max(0, (room.turnDeadlineAt ?? Date.now()) - Date.now()),
    pendingDraw: snapshot.pendingDraw,
  } as const;

  for (const p of room.players) {
    if (p.isBot) continue;
    io.to(p.id).emit('state_update', {
      ...base,
      you: {
        id: p.id,
        hand: snapshot.hands[p.id],
      },
      unoGraceRemainingMs: Math.max(0, (room.unoGraceUntil?.get(p.id) ?? 0) - Date.now()),
    });
  }
}

function scheduleTurn(io: Server, room: Room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnDeadlineAt = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(io, room.id);
  }, TURN_MS);
  maybeTriggerBotTurn(io, room);
}

function handleTurnTimeout(io: Server, roomId: string) {
  const room = rooms.get(roomId);
  if (!room || !room.game) return;
  const game = room.game;
  // Apply pending draw or draw one and pass
  if (game.pendingDraw > 0) {
    applyPendingDrawAndSkip(game);
  } else {
    const pid = game.players[game.currentPlayerIndex]!;
    drawCards(game, pid, 1);
    game.currentPlayerIndex = nextIndex(game);
  }
  scheduleTurn(io, room);
  broadcastState(io, room);
}

function finishGame(io: Server, room: Room, winnerId: string) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
  if (room.botActionTimeout) clearTimeout(room.botActionTimeout);
  room.botActionTimeout = null;
  delete room.turnDeadlineAt;
  room.unoTimers?.forEach(t => clearTimeout(t));
  room.unoTimers?.clear();
  room.unoGraceUntil?.clear();
  io.to(room.id).emit('game_over', { roomId: room.id, winnerId });
  delete room.game;
}

function maybeTriggerBotTurn(io: Server, room: Room) {
  if (!room.game) return;
  const currentId = room.game.players[room.game.currentPlayerIndex];
  if (!currentId) return;
  const player = room.players.find(p => p.id === currentId);
  if (!player?.isBot) return;
  if (room.botActionTimeout) return;
  room.botActionTimeout = setTimeout(() => {
    room.botActionTimeout = null;
    runBotTurn(io, room);
  }, BOT_THINK_DELAY_MS);
}

function runBotTurn(io: Server, room: Room) {
  if (!room.game) return;
  const game = room.game;
  const currentId = game.players[game.currentPlayerIndex];
  if (!currentId) return;
  const player = room.players.find(p => p.id === currentId);
  if (!player?.isBot) return;

  const hand = game.hands[currentId];
  if (!hand) {
    game.currentPlayerIndex = nextIndex(game);
    scheduleTurn(io, room);
    broadcastState(io, room);
    return;
  }

  let actionComplete = false;

  if (game.pendingDraw > 0) {
    const stacked = tryStackPenaltyCard(game, currentId);
    if (stacked) {
      actionComplete = true;
      if (handleBotAfterPlay(io, room, currentId)) return;
    } else {
      const n = game.pendingDraw;
      drawCards(game, currentId, n);
      game.pendingDraw = 0;
      clearUnoTimer(room, currentId);
    }
  }

  if (!actionComplete) {
    actionComplete = tryRegularBotPlay(game, currentId);
    if (actionComplete && handleBotAfterPlay(io, room, currentId)) return;
  }

  if (!actionComplete) {
    drawCards(game, currentId, 1);
    clearUnoTimer(room, currentId);
    actionComplete = tryRegularBotPlay(game, currentId);
    if (actionComplete && handleBotAfterPlay(io, room, currentId)) return;
  }

  if (!actionComplete) {
    game.currentPlayerIndex = nextIndex(game);
  }

  scheduleTurn(io, room);
  broadcastState(io, room);
}

function tryStackPenaltyCard(state: GameState, playerId: string): boolean {
  const hand = state.hands[playerId] ?? [];
  for (const card of hand) {
    if (card.value !== 'draw2' && card.value !== 'wild4') continue;
    const chosenColor = card.value === 'wild4'
      ? pickColorFromHand(hand, card.id)
      : card.color ?? pickColorFromHand(hand, card.id);
    const res = playCard(state, playerId, card.id, chosenColor);
    if (res.ok) return true;
  }
  return false;
}

function tryRegularBotPlay(state: GameState, playerId: string): boolean {
  const hand = state.hands[playerId] ?? [];
  if (hand.length === 0) return false;
  const top = state.discardPile[state.discardPile.length - 1];
  for (const card of hand) {
    if (!top) break;
    if (!canPlayOnTop(card, top, state.activeColor)) continue;
    let chosenColor: GameState['activeColor'] | undefined;
    if (card.value === 'wild' || card.value === 'wild4') {
      chosenColor = pickColorFromHand(hand, card.id);
    }
    const res = playCard(state, playerId, card.id, chosenColor);
    if (res.ok) return true;
  }
  return false;
}

function handleBotAfterPlay(io: Server, room: Room, playerId: string): boolean {
  if (!room.game) return false;
  const hand = room.game.hands[playerId];
  if (!hand) return false;
  if (hand.length === 0) {
    finishGame(io, room, playerId);
    return true;
  }
  if (hand.length === 1) {
    callUno(room.game, playerId);
    clearUnoTimer(room, playerId);
  } else {
    clearUnoTimer(room, playerId);
  }
  return false;
}

export function setupRooms(io: Server) {
  io.on('connection', (socket: Socket) => {
    socket.on('join_room', ({ roomId, name, maxPlayers }: { roomId?: string; name: string, maxPlayers?: number }) => {
      if (!name) return socket.emit('error', { code: 'name_required' });
      let room: Room | undefined;
      if (roomId) {
        room = rooms.get(roomId);
        if (!room) return socket.emit('error', { code: 'room_not_found' });
      } else {
        const mp = Math.max(2, Math.min(MAX_PLAYERS, maxPlayers || 4));
        room = { id: crypto.randomBytes(3).toString('hex'), players: [], hostId: socket.id, unoTimers: new Map(), unoGraceUntil: new Map(), maxPlayers: mp };
        rooms.set(room.id, room);
      }
      if (!room.unoTimers) room.unoTimers = new Map();
      if (!room.unoGraceUntil) room.unoGraceUntil = new Map();

      // Check if game is in progress
      if (room.game) {
        // Try to find a bot to replace
        const botIndex = room.players.findIndex(p => p.isBot);
        if (botIndex === -1) {
          return socket.emit('error', { code: 'room_full' });
        }

        // Replace the bot
        const bot = room.players[botIndex];
        if (!bot) return socket.emit('error', { code: 'room_full' });

        const oldId = bot.id;
        const newId = socket.id;

        // Update player info
        room.players[botIndex] = { id: newId, name, isBot: false };

        // Migrate Game State
        const game = room.game;
        const pIdx = game.players.indexOf(oldId);
        if (pIdx !== -1) {
          game.players[pIdx] = newId;
        }

        // Migrate Hand
        if (game.hands[oldId]) {
          game.hands[newId] = game.hands[oldId];
          delete game.hands[oldId];
        }

        // Migrate Timers
        if (room.unoTimers?.has(oldId)) {
          const t = room.unoTimers.get(oldId);
          room.unoTimers.delete(oldId);
          if (t) room.unoTimers.set(newId, t);
        }
        if (room.unoGraceUntil?.has(oldId)) {
          const g = room.unoGraceUntil.get(oldId);
          room.unoGraceUntil.delete(oldId);
          if (g) room.unoGraceUntil.set(newId, g);
        }

        // Join Socket
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.playerId = newId;

        socket.emit('joined', { roomId: room.id, playerId: newId, hostId: room.hostId, players: room.players });
        io.to(room.id).emit('players_update', room.players);

        // Broadcast new state so everyone sees the name change and new player enters game view
        broadcastState(io, room);
        return;
      }

      // Normal Join (Lobby)
      const humanCount = getHumanCount(room);
      if (humanCount >= room.maxPlayers) return socket.emit('error', { code: 'room_full' });

      if (room.players.length >= room.maxPlayers) {
        const removed = removeOneBot(room);
        if (!removed) return socket.emit('error', { code: 'room_full' });
      }

      const player: Player = { id: socket.id, name, isBot: false };
      room.players.push(player);
      ensureBotSeats(room);
      socket.join(room.id);
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;
      socket.emit('joined', { roomId: room.id, playerId: player.id, hostId: room.hostId, players: room.players });
      io.to(room.id).emit('players_update', room.players);
    });

    socket.on('start_game', () => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.hostId !== socket.id) return socket.emit('error', { code: 'not_host' });
      ensureBotSeats(room);
      if (room.players.length !== room.maxPlayers) return socket.emit('error', { code: 'need_more_players' });

      const deck = generateDeck();
      const playerIds = room.players.map(p => p.id);
      room.game = dealInitial(playerIds, deck);
      room.startedAt = Date.now();
      io.to(room.id).emit('game_started');
      scheduleTurn(io, room);
      broadcastState(io, room);
    });

    socket.on('restart_game', () => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.hostId !== socket.id) return socket.emit('error', { code: 'not_host' });
      ensureBotSeats(room);
      if (room.players.length !== room.maxPlayers) return socket.emit('error', { code: 'need_more_players' });
      const deck = generateDeck();
      const playerIds = room.players.map(p => p.id);
      room.game = dealInitial(playerIds, deck);
      room.startedAt = Date.now();
      io.to(room.id).emit('game_started');
      scheduleTurn(io, room);
      broadcastState(io, room);
    });

    socket.on('play_card', ({ cardId, color }: { cardId: string; color?: GameState['activeColor'] }) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || !room.game) return;
      const res = playCard(room.game, socket.id, cardId, color);
      if (!res.ok) return socket.emit('error', { code: res.error });
      // Game over check
      const playedHand = room.game.hands[socket.id];
      if (playedHand && playedHand.length === 0) {
        finishGame(io, room, socket.id);
        return;
      }
      // If the player now has 1 card, start UNO grace timer
      const hand = room.game.hands[socket.id];
      if (hand && hand.length === 1) {
        scheduleUnoPenalty(io, room, socket.id);
      } else {
        clearUnoTimer(room, socket.id);
      }
      scheduleTurn(io, room);
      broadcastState(io, room);
    });

    socket.on('draw_card', () => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || !room.game) return;
      const game = room.game;
      const currentId = game.players[game.currentPlayerIndex];
      if (currentId !== socket.id) return socket.emit('error', { code: 'not_your_turn' });
      if (game.pendingDraw > 0) {
        // Draw the accumulated penalty but keep the turn (house rule)
        const n = game.pendingDraw;
        drawCards(game, socket.id, n);
        game.pendingDraw = 0;

        // Fix: Force next turn after penalty
        game.currentPlayerIndex = nextIndex(game);

        // reset UNO timer for this player since hand changed
        clearUnoTimer(room, socket.id);
        scheduleTurn(io, room);
      } else {
        // Draw one and keep the turn; player may play if possible
        drawCards(game, socket.id, 1);
        clearUnoTimer(room, socket.id);
        scheduleTurn(io, room);
      }
      broadcastState(io, room);
    });

    socket.on('choose_color', ({ color }: { color: GameState['activeColor'] }) => {
      // color is handled in play_card in this MVP; this event can be a no-op or used by UI
    });

    socket.on('call_uno', () => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || !room.game) return;
      const res = callUno(room.game, socket.id);
      if (!res.ok) {
        // Invalid UNO call -> Penalty
        socket.emit('error', { code: 'invalid_uno_call' });
        drawCards(room.game, socket.id, 1);
        scheduleTurn(io, room);
        broadcastState(io, room);
        return;
      }
      clearUnoTimer(room, socket.id);
      broadcastState(io, room);
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) return;
      const leaving = room.players[idx];
      if (!leaving) return;
      if (room.game) {
        room.players[idx] = {
          ...leaving,
          name: leaving.name.startsWith('Bot ') ? leaving.name : `Bot ${leaving.name}`,
          isBot: true,
        };
        clearUnoTimer(room, socket.id);
        maybeTriggerBotTurn(io, room);
      } else {
        room.players.splice(idx, 1);
        ensureBotSeats(room);
      }

      if (room.hostId === socket.id) {
        const nextHuman = room.players.find(p => !p.isBot);
        if (nextHuman) {
          room.hostId = nextHuman.id;
        } else if (room.players[0]) {
          room.hostId = room.players[0].id;
        }
      }

      const humansLeft = getHumanCount(room);
      if (humansLeft === 0) {
        if (room.turnTimer) clearTimeout(room.turnTimer);
        if (room.botActionTimeout) clearTimeout(room.botActionTimeout);
        room.unoTimers?.forEach(t => clearTimeout(t));
        room.unoTimers?.clear();
        room.unoGraceUntil?.clear();
        rooms.delete(room.id);
        return;
      }

      io.to(room.id).emit('players_update', room.players);
    });
  });
}


