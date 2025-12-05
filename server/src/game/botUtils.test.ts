import assert from 'node:assert/strict';
import { pickColorFromHand } from './botUtils.js';
import type { Card } from './types.js';

const sampleHand: Card[] = [
  { id: 'r1', color: 'red', value: 5 },
  { id: 'r2', color: 'red', value: 'skip' },
  { id: 'g1', color: 'green', value: 2 },
  { id: 'w1', color: null, value: 'wild' },
];

assert.equal(pickColorFromHand(sampleHand), 'red', 'Bot should prefer most common color');

const tieBreakerHand: Card[] = [
  { id: 'y1', color: 'yellow', value: 8 },
  { id: 'g2', color: 'green', value: 6 },
  { id: 'b1', color: 'blue', value: 1 },
  { id: 'w4', color: null, value: 'wild4' },
];

assert.equal(
  pickColorFromHand(tieBreakerHand, 'b1'),
  'yellow',
  'Bot should fall back to priority order when counts equal',
);

console.log('Bot utility tests passed.');


