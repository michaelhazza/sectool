export type Direction = 'higher' | 'lower';

export interface DecisionInput {
  currentMetric: number;
  bestSoFar: number | null;
  direction: Direction;
  minDelta: number;
}

export type Decision = 'keep' | 'discard';

export function decideKeepOrDiscard(input: DecisionInput): Decision {
  const { currentMetric, bestSoFar, direction, minDelta } = input;

  // Validate direction explicitly. The TypeScript type pins it to
  // 'higher' | 'lower' at compile time, but callers may pass JavaScript
  // inputs (e.g. agent-routed strings). A typo such as 'lowerer' or 'min'
  // would previously fall through to the `higher` branch and produce a
  // deterministic-but-wrong keep/discard decision instead of failing fast.
  if (direction !== 'higher' && direction !== 'lower') {
    throw new Error(`direction must be 'higher' or 'lower', got ${JSON.stringify(direction)}`);
  }

  if (!Number.isFinite(minDelta) || minDelta <= 0) {
    throw new Error('minDelta must be a finite positive number');
  }

  if (!Number.isFinite(currentMetric)) {
    throw new Error('currentMetric must be finite');
  }

  if (bestSoFar === null) {
    return 'keep';
  }

  if (!Number.isFinite(bestSoFar)) {
    throw new Error('bestSoFar must be finite');
  }

  const improvement =
    direction === 'lower'
      ? bestSoFar - currentMetric
      : currentMetric - bestSoFar;

  return improvement >= minDelta ? 'keep' : 'discard';
}
