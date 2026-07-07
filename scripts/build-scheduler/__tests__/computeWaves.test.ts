/**
 * computeWaves.test.ts
 *
 * Unit tests for the computeWaves pure scheduler.
 * Run via: npx vitest run scripts/build-scheduler/__tests__/computeWaves.test.ts
 */

import { describe, it, expect } from 'vitest';
import { computeWaves } from '../computeWaves.js';
import type { ChunkNode, ComputeWavesInput } from '../computeWaves.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk(
  id: string,
  declaredFiles: string[],
  dependsOn: string[] = [],
  exclusiveResources?: string[],
): ChunkNode {
  return { id, declaredFiles, dependsOn, ...(exclusiveResources !== undefined ? { exclusiveResources } : {}) };
}

function input(chunks: ChunkNode[], concurrencyCap: number): ComputeWavesInput {
  return { chunks, concurrencyCap };
}

// ---------------------------------------------------------------------------
// A1: 3 disjoint chunks, cap >= 3 → one wave of 3
// ---------------------------------------------------------------------------

describe('A1 — disjoint chunks fit in one wave', () => {
  it('produces a single wave containing all three chunks when cap >= 3', () => {
    const chunks = [
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts']),
      chunk('3', ['src/c.ts']),
    ];
    const result = computeWaves(input(chunks, 3));
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].chunkIds).toEqual(['1', '2', '3']);
    expect(result.serialisedReasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A2: fully-chained (2→1, 3→2) → 3 waves of 1
// ---------------------------------------------------------------------------

describe('A2 — fully chained chain', () => {
  it('produces 3 waves of 1 for a strictly linear dependency chain', () => {
    const chunks = [
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts'], ['1']),
      chunk('3', ['src/c.ts'], ['2']),
    ];
    const result = computeWaves(input(chunks, 3));
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0].chunkIds).toEqual(['1']);
    expect(result.waves[1].chunkIds).toEqual(['2']);
    expect(result.waves[2].chunkIds).toEqual(['3']);
    // Lone chunks in layer 1+ get 'dependency' reason.
    const reasons = result.serialisedReasons;
    expect(reasons).toHaveLength(2);
    expect(reasons.find((r) => r.chunkId === '2')?.reason).toBe('dependency');
    expect(reasons.find((r) => r.chunkId === '3')?.reason).toBe('dependency');
    // dependency reason has no conflictsWith.
    expect(reasons.find((r) => r.chunkId === '2')?.conflictsWith).toBeUndefined();
    expect(reasons.find((r) => r.chunkId === '3')?.conflictsWith).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A3 (core safety): same declared file → never co-scheduled
// ---------------------------------------------------------------------------

describe('A3 — shared declared file forces serialisation', () => {
  it('places two chunks sharing a file into separate waves (never concurrent)', () => {
    const chunks = [
      chunk('1', ['src/shared.ts', 'src/a.ts']),
      chunk('2', ['src/shared.ts', 'src/b.ts']),
    ];
    const result = computeWaves(input(chunks, 10));
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].chunkIds).toEqual(['1']);
    expect(result.waves[1].chunkIds).toEqual(['2']);
    const reason = result.serialisedReasons.find((r) => r.chunkId === '2');
    expect(reason?.reason).toBe('file-overlap');
    expect(reason?.conflictsWith).toBe('1');
  });

  it('never places shared-file chunks in the same wave regardless of cap', () => {
    const chunks = [
      chunk('A', ['manifest.json']),
      chunk('B', ['manifest.json']),
    ];
    const result = computeWaves(input(chunks, 100));
    // Core safety: A and B must never be in the same wave.
    for (const wave of result.waves) {
      const hasA = wave.chunkIds.includes('A');
      const hasB = wave.chunkIds.includes('B');
      expect(hasA && hasB).toBe(false);
    }
    expect(result.waves).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A3b (regression): case-insensitive file identity — src/Foo.ts vs src/foo.ts
// ---------------------------------------------------------------------------

describe('A3b — case-insensitive file identity (Windows/macOS safety)', () => {
  it('places chunk A (src/Foo.ts) and chunk B (src/foo.ts) into different waves', () => {
    const chunks = [
      chunk('A', ['src/Foo.ts']),
      chunk('B', ['src/foo.ts']),
    ];
    const result = computeWaves(input(chunks, 2));
    // Must NOT be co-scheduled — two separate waves required.
    expect(result.waves).toHaveLength(2);
    // A and B must never appear in the same wave.
    for (const wave of result.waves) {
      const hasA = wave.chunkIds.includes('A');
      const hasB = wave.chunkIds.includes('B');
      expect(hasA && hasB).toBe(false);
    }
    // B is serialised after A; its reason must be file-overlap conflicting with A.
    const reason = result.serialisedReasons.find((r) => r.chunkId === 'B');
    expect(reason?.reason).toBe('file-overlap');
    expect(reason?.conflictsWith).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// A4: shared exclusive resource → serialised
// ---------------------------------------------------------------------------

describe('A4 — shared exclusive resource forces serialisation', () => {
  it('serialises two chunks sharing an exclusive resource even if files are disjoint', () => {
    const chunks = [
      chunk('1', ['src/a.ts'], [], ['migration:v2.24.0']),
      chunk('2', ['src/b.ts'], [], ['migration:v2.24.0']),
    ];
    const result = computeWaves(input(chunks, 10));
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].chunkIds).toEqual(['1']);
    expect(result.waves[1].chunkIds).toEqual(['2']);
    const reason = result.serialisedReasons.find((r) => r.chunkId === '2');
    expect(reason?.reason).toBe('exclusive-resource');
    expect(reason?.conflictsWith).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// A5: determinism — same input twice → deep-equal output
// ---------------------------------------------------------------------------

describe('A5 — determinism', () => {
  it('produces byte-identical results on two calls with the same input', () => {
    const chunks = [
      chunk('3', ['src/c.ts'], ['1']),
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts'], ['1']),
    ];
    const result1 = computeWaves(input(chunks, 2));
    const result2 = computeWaves(input(chunks, 2));
    expect(result1).toEqual(result2);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});

// ---------------------------------------------------------------------------
// A8 support: cap=1 → 1-per-wave (sequential dispatch)
// ---------------------------------------------------------------------------

describe('A8 support — cap=1 produces one-per-wave output', () => {
  it('produces 3 waves of 1 when cap=1, even for fully-disjoint chunks', () => {
    const chunks = [
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts']),
      chunk('3', ['src/c.ts']),
    ];
    const result = computeWaves(input(chunks, 1));
    expect(result.waves).toHaveLength(3);
    for (const wave of result.waves) {
      expect(wave.chunkIds).toHaveLength(1);
    }
    // All spills are cap-spill.
    const reasons = result.serialisedReasons;
    for (const r of reasons) {
      expect(r.reason).toBe('cap-spill');
    }
  });
});

// ---------------------------------------------------------------------------
// serialisedReasons reason + priority (OAI-007)
// ---------------------------------------------------------------------------

describe('serialisedReasons reason and priority', () => {
  it('records dependency reason (no conflictsWith) for a lone chunk in a later layer', () => {
    const chunks = [
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts'], ['1']),
    ];
    const result = computeWaves(input(chunks, 5));
    expect(result.waves).toHaveLength(2);
    const r = result.serialisedReasons.find((x) => x.chunkId === '2');
    expect(r?.reason).toBe('dependency');
    expect(r?.conflictsWith).toBeUndefined();
  });

  it('records exclusive-resource over file-overlap when chunk shares both with an earlier chunk', () => {
    // Two chunks sharing a file AND an exclusive resource in the same layer.
    // Priority: exclusive-resource > file-overlap.
    const chunks = [
      chunk('1', ['manifest.json'], [], ['manifest.json']),
      chunk('2', ['manifest.json'], [], ['manifest.json']),
    ];
    const result = computeWaves(input(chunks, 10));
    expect(result.waves).toHaveLength(2);
    const r = result.serialisedReasons.find((x) => x.chunkId === '2');
    expect(r?.reason).toBe('exclusive-resource');
    expect(r?.conflictsWith).toBe('1');
  });

  it('records file-overlap (not exclusive-resource) when only files conflict', () => {
    const chunks = [
      chunk('1', ['src/shared.ts']),
      chunk('2', ['src/shared.ts']),
    ];
    const result = computeWaves(input(chunks, 10));
    const r = result.serialisedReasons.find((x) => x.chunkId === '2');
    expect(r?.reason).toBe('file-overlap');
    expect(r?.conflictsWith).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Cap-spill
// ---------------------------------------------------------------------------

describe('cap-spill', () => {
  it('produces wave of 2 then wave of 1 when 3 disjoint chunks and cap=2', () => {
    const chunks = [
      chunk('1', ['src/a.ts']),
      chunk('2', ['src/b.ts']),
      chunk('3', ['src/c.ts']),
    ];
    const result = computeWaves(input(chunks, 2));
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].chunkIds).toEqual(['1', '2']);
    expect(result.waves[1].chunkIds).toEqual(['3']);
    const r = result.serialisedReasons.find((x) => x.chunkId === '3');
    expect(r?.reason).toBe('cap-spill');
    expect(r?.conflictsWith).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe('cycle detection', () => {
  it('throws on a direct cycle between two chunks', () => {
    const chunks = [
      chunk('1', ['src/a.ts'], ['2']),
      chunk('2', ['src/b.ts'], ['1']),
    ];
    expect(() => computeWaves(input(chunks, 3))).toThrow(/dependency cycle/);
  });

  it('throws on a longer cycle (3 nodes)', () => {
    const chunks = [
      chunk('A', ['src/a.ts'], ['C']),
      chunk('B', ['src/b.ts'], ['A']),
      chunk('C', ['src/c.ts'], ['B']),
    ];
    expect(() => computeWaves(input(chunks, 3))).toThrow(/dependency cycle/);
  });
});

// ---------------------------------------------------------------------------
// Unknown dependency id
// ---------------------------------------------------------------------------

describe('unknown dependency id', () => {
  it('throws when a dependsOn references an id not in the chunk list', () => {
    const chunks = [
      chunk('1', ['src/a.ts'], ['nonexistent']),
    ];
    expect(() => computeWaves(input(chunks, 3))).toThrow(/unknown dependency id/);
  });
});

// ---------------------------------------------------------------------------
// Empty chunk list
// ---------------------------------------------------------------------------

describe('empty chunk list', () => {
  it('returns empty waves and empty serialisedReasons for an empty input', () => {
    const result = computeWaves(input([], 3));
    expect(result.waves).toHaveLength(0);
    expect(result.serialisedReasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cap < 1 (invalid)
// ---------------------------------------------------------------------------

describe('invalid cap', () => {
  it('throws when concurrencyCap is 0', () => {
    expect(() => computeWaves(input([chunk('1', ['a.ts'])], 0))).toThrow();
  });

  it('throws when concurrencyCap is negative', () => {
    expect(() => computeWaves(input([chunk('1', ['a.ts'])], -1))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix 3: numeric-aware chunk-id ordering (1, 2, 10 — not 1, 10, 2)
// ---------------------------------------------------------------------------

describe('Fix 3 — numeric-aware chunk-id ordering', () => {
  it('disjoint chunks with ids 10, 2, 1 (cap >= 10) → waves[0].chunkIds equals [1, 2, 10]', () => {
    const chunks = [
      chunk('10', ['src/j.ts']),
      chunk('2', ['src/b.ts']),
      chunk('1', ['src/a.ts']),
    ];
    const result = computeWaves(input(chunks, 10));
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].chunkIds).toEqual(['1', '2', '10']);
  });
});

// ---------------------------------------------------------------------------
// Wave ordering stability
// ---------------------------------------------------------------------------

describe('stable ordering', () => {
  it('sorts chunk ids ascending within each wave', () => {
    // Chunks with ids that would be in different order if not sorted.
    const chunks = [
      chunk('z', ['src/z.ts']),
      chunk('a', ['src/a.ts']),
      chunk('m', ['src/m.ts']),
    ];
    const result = computeWaves(input(chunks, 10));
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].chunkIds).toEqual(['a', 'm', 'z']);
  });

  it('processes chunks within a layer in stable id-ascending order', () => {
    // Three chunks: z and a are independent; b depends on z.
    // Without stable ordering, the wave structure could vary.
    const chunks = [
      chunk('z', ['src/z.ts']),
      chunk('a', ['src/a.ts']),
      chunk('b', ['src/b.ts'], ['z']),
    ];
    const result1 = computeWaves(input(chunks, 10));
    const result2 = computeWaves(input(chunks, 10));
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    // Layer 0: a and z (sorted: a, z) in one wave.
    expect(result1.waves[0].chunkIds).toEqual(['a', 'z']);
    // Layer 1: b alone (depends on z).
    expect(result1.waves[1].chunkIds).toEqual(['b']);
  });
});
