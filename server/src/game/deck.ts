import type { Card, Color } from './types.js';

const COLORS: Exclude<Color, null>[] = ['red', 'yellow', 'green', 'blue'];

export function generateDeck(seedRandom: () => number = Math.random): Card[] {
  const cards: Card[] = [];
  let idCounter = 1;

  // Number cards: one 0 per color, two of 1-9 per color
  for (const color of COLORS) {
    cards.push({ id: String(idCounter++), color, value: 0 });
    for (let n = 1; n <= 9; n++) {
      cards.push({ id: String(idCounter++), color, value: n as any });
      cards.push({ id: String(idCounter++), color, value: n as any });
    }
    // Action cards: skip, reverse, draw2 (two each per color)
    for (let i = 0; i < 2; i++) {
      cards.push({ id: String(idCounter++), color, value: 'skip' });
      cards.push({ id: String(idCounter++), color, value: 'reverse' });
      cards.push({ id: String(idCounter++), color, value: 'draw2' });
    }
  }

  // Wild cards (color null): 4 wild, 4 wild4
  for (let i = 0; i < 4; i++) {
    cards.push({ id: String(idCounter++), color: null, value: 'wild' });
    cards.push({ id: String(idCounter++), color: null, value: 'wild4' });
  }

  return shuffle(cards, seedRandom);
}

export function shuffle<T>(arr: T[], rnd: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}


