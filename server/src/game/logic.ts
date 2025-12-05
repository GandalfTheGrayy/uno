import type { Card, GameState, Result } from './types.js';

export function canPlayOnTop(card: Card, top: Card, activeColor: GameState['activeColor']): boolean {
  if (card.value === 'wild' || card.value === 'wild4') return true;
  if (top.value === 'wild' || top.value === 'wild4') {
    // When top is wild, color is chosen via activeColor
    return card.color === activeColor;
  }
  return card.color === top.color || card.value === top.value;
}

export function dealInitial(players: string[], drawPile: Card[]): GameState {
  const hands: GameState['hands'] = {};
  for (const p of players) hands[p] = [];

  for (let r = 0; r < 7; r++) {
    for (const p of players) hands[p]!.push(drawPile.shift()!);
  }

  // Flip first non-wild card to discard
  let first = drawPile.shift()!;
  while (first.value === 'wild' || first.value === 'wild4') {
    drawPile.push(first); // put back and get another
    first = drawPile.shift()!;
  }

  const discardPile = [first];
  const state: GameState = {
    players,
    hands,
    drawPile,
    discardPile,
    currentPlayerIndex: 0,
    direction: 1,
    activeColor: first.color!,
    pendingDraw: 0,
    unoCalledPlayerIds: [],
  };

  // Apply first card action if action card
  if (first.value === 'skip') {
    state.currentPlayerIndex = nextIndex(state);
  } else if (first.value === 'reverse') {
    state.direction = -1;
  } else if (first.value === 'draw2') {
    state.pendingDraw += 2;
  }

  return state;
}

export function nextIndex(state: GameState, step = 1): number {
  const total = state.players.length;
  let idx = state.currentPlayerIndex;
  for (let i = 0; i < step; i++) {
    idx = (idx + state.direction + total) % total;
  }
  return idx;
}

export function drawCards(state: GameState, playerId: string, count: number) {
  const hand = state.hands[playerId];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      // reshuffle from discard (leave top)
      const top = state.discardPile[state.discardPile.length - 1]!;
      const rest = state.discardPile.slice(0, -1);
      // naive shuffle
      for (let j = rest.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        const tmp = rest[j]!;
        rest[j] = rest[k]!;
        rest[k] = tmp;
      }
      state.drawPile.push(...rest);
      state.discardPile = [top];
    }
    const c = state.drawPile.shift();
    if (c) hand!.push(c);
  }
  // If this draw was due to a pendingDraw penalty, after drawing the required number, the player's turn ends.
}

export function playCard(state: GameState, playerId: string, cardId: string, chosenColor?: GameState['activeColor']): Result<GameState> {
  const currentPlayerId = state.players[state.currentPlayerIndex];
  if (playerId !== currentPlayerId) return { ok: false, error: 'not_your_turn' };

  const hand = state.hands[playerId];
  const idx = hand!.findIndex(c => c.id === cardId);
  if (idx === -1) return { ok: false, error: 'card_not_in_hand' };

  const card = hand![idx]!;

  // Handle pending draw (stacking enabled: allow draw2 / wild4, including cross-stacking)
  if (state.pendingDraw > 0) {
    if (card.value === 'draw2') {
      // allow stacking regardless of color
      hand!.splice(idx, 1);
      state.discardPile.push(card);
      state.pendingDraw += 2;
      state.activeColor = card.color!;
      state.currentPlayerIndex = nextIndex(state);
      return { ok: true, value: state };
    }
    if (card.value === 'wild4') {
      if (!chosenColor) return { ok: false, error: 'color_required' };
      hand!.splice(idx, 1);
      state.discardPile.push(card);
      state.pendingDraw += 4;
      state.activeColor = chosenColor;
      state.currentPlayerIndex = nextIndex(state);
      return { ok: true, value: state };
    }
    return { ok: false, error: 'must_stack_draw' };
  }

  const top = state.discardPile[state.discardPile.length - 1]!;
  if (!canPlayOnTop(card, top, state.activeColor)) return { ok: false, error: 'invalid_move' };

  // Move card to discard
  hand!.splice(idx, 1);
  state.discardPile.push(card);

  // Effect
  if (card.value === 'wild') {
    if (!chosenColor) return { ok: false, error: 'color_required' };
    state.activeColor = chosenColor;
  } else if (card.value === 'wild4') {
    if (!chosenColor) return { ok: false, error: 'color_required' };
    state.activeColor = chosenColor;
    state.pendingDraw += 4;
  } else if (card.value === 'reverse') {
    state.direction = (state.direction === 1 ? -1 : 1);
    // 2 players case: reverse acts like skip
    if (state.players.length === 2) {
      state.currentPlayerIndex = nextIndex(state);
    }
    state.activeColor = card.color!;
  } else if (card.value === 'skip') {
    state.currentPlayerIndex = nextIndex(state);
    state.activeColor = card.color!;
  } else if (card.value === 'draw2') {
    state.pendingDraw += 2;
    state.activeColor = card.color!;
  } else {
    // numeric
    state.activeColor = card.color!;
  }

  // UNO tracking
  if (hand!.length === 1) {
    // must call UNO
  } else {
    // clear any prior UNO call since hand size changed
    const i = state.unoCalledPlayerIds.indexOf(playerId);
    if (i >= 0) state.unoCalledPlayerIds.splice(i, 1);
  }

  // Advance turn normally (unless pending draw causes skip next)
  state.currentPlayerIndex = nextIndex(state);
  return { ok: true, value: state };
}

export function applyPendingDrawAndSkip(state: GameState) {
  if (state.pendingDraw > 0) {
    const pid = state.players[state.currentPlayerIndex]!;
    drawCards(state, pid, state.pendingDraw);
    state.pendingDraw = 0;
    state.currentPlayerIndex = nextIndex(state);
  }
}

export function callUno(state: GameState, playerId: string): Result<GameState> {
  const hand = state.hands[playerId];
  if (!hand) return { ok: false, error: 'no_such_player' };
  if (hand.length !== 1) return { ok: false, error: 'uno_only_at_one_card' };
  if (!state.unoCalledPlayerIds.includes(playerId)) state.unoCalledPlayerIds.push(playerId);
  return { ok: true, value: state };
}

export function penalizeMissingUno(state: GameState, playerId: string) {
  const hand = state.hands[playerId];
  if (hand && hand.length === 1 && !state.unoCalledPlayerIds.includes(playerId)) {
    drawCards(state, playerId, 2);
  }
}


