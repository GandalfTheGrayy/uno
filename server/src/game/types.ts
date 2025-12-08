export type Color = 'red' | 'yellow' | 'green' | 'blue' | null;

export type NumericValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type ActionValue = 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';
export type CardValue = NumericValue | ActionValue;

export interface Card {
  id: string;
  color: Color;
  value: CardValue;
}

export interface GameState {
  players: string[];
  hands: Record<string, Card[]>;
  drawPile: Card[];
  discardPile: Card[];
  currentPlayerIndex: number; // index in players
  direction: 1 | -1;
  activeColor: Exclude<Color, null>;
  pendingDraw: number; // when > 0, current player must draw this many and lose turn
  unoCalledPlayerIds: string[]; // players who have pressed UNO while at 1 card
  hasDrawnThisTurn: boolean; // prevents multiple draws in the same turn
  unoAttemptedThisRound: string[]; // players who have attempted UNO this round
}

export interface ResultOk<T> { ok: true; value: T }
export interface ResultErr { ok: false; error: string }
export type Result<T> = ResultOk<T> | ResultErr;







