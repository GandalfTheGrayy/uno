import type { Card, GameState } from './types.js';

const COLOR_PRIORITY: GameState['activeColor'][] = ['red', 'yellow', 'green', 'blue'];

export function pickColorFromHand(hand: Card[], skipCardId?: string): GameState['activeColor'] {
  const counts: Record<GameState['activeColor'], number> = {
    red: 0,
    yellow: 0,
    green: 0,
    blue: 0,
  };
  for (const card of hand) {
    if (card.id === skipCardId) continue;
    if (card.color) counts[card.color]++;
  }
  let best: GameState['activeColor'] = 'red';
  for (const color of COLOR_PRIORITY) {
    if (counts[color] > counts[best]) {
      best = color;
    }
  }
  return best;
}


