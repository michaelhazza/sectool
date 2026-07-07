/**
 * validatePlanMetadata.test.ts
 *
 * Tests for parsePlanMetadata (snake→camel normalisation + path canonicalisation)
 * and validatePlanMetadata (structural validation).
 *
 * Run via: npx vitest run scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts
 */

import { describe, it, expect } from 'vitest';
import { parsePlanMetadata, validatePlanMetadata } from '../validatePlanMetadata.js';
import { computeWaves } from '../computeWaves.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid camelCase chunk for validatePlanMetadata. */
function validChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    declaredFiles: [`scripts/${id}.ts`],
    dependsOn: [] as string[],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validatePlanMetadata — structural rules
// ---------------------------------------------------------------------------

describe('validatePlanMetadata', () => {
  it('A6: chunk missing declaredFiles → ok:false, error names field + chunk', () => {
    const result = validatePlanMetadata([{ id: 'c1', dependsOn: [] }]);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.field === 'declaredFiles');
    expect(err).toBeDefined();
    expect(err!.chunkId).toBe('c1');
    expect(err!.message).toMatch(/declaredFiles/);
  });

  it('empty declaredFiles array is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: [], dependsOn: [] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });

  it('missing dependsOn is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: ['src/a.ts'] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'dependsOn')).toBe(true);
  });

  it('dependsOn: [] (empty array) is accepted', () => {
    const result = validatePlanMetadata([validChunk('c1')]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('dangling dependsOn id is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: ['c99'] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'dependsOn' && e.message.includes('c99'))).toBe(true);
  });

  it('duplicate chunk ids are rejected', () => {
    const result = validatePlanMetadata([validChunk('c1'), validChunk('c1')]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'id' && e.message.includes('c1'))).toBe(true);
  });

  it('fully-valid 3-chunk plan → ok:true', () => {
    const result = validatePlanMetadata([
      validChunk('1'),
      validChunk('2'),
      { id: '3', declaredFiles: ['src/c.ts'], dependsOn: ['1', '2'] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('exclusiveResources with non-empty strings is valid', () => {
    const result = validatePlanMetadata([
      { id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: [], exclusiveResources: ['manifest.json'] },
    ]);
    expect(result.ok).toBe(true);
  });

  it('exclusiveResources with an empty string entry is rejected', () => {
    const result = validatePlanMetadata([
      { id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: [], exclusiveResources: [''] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'exclusiveResources')).toBe(true);
  });

  it('never throws on any malformed input', () => {
    // Completely empty object — should not throw.
    expect(() => validatePlanMetadata([{}])).not.toThrow();
    // null-ish fields — should not throw.
    expect(() => validatePlanMetadata([{ id: undefined, declaredFiles: undefined, dependsOn: undefined }])).not.toThrow();
  });

  it('missing id → ok:false with an id error (scheduler keys on id)', () => {
    const result = validatePlanMetadata([{ declaredFiles: ['scripts/a.ts'], dependsOn: [] }]);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.field === 'id');
    expect(err).toBeDefined();
    expect(err!.chunkId).toBe('<unknown>');
    expect(err!.message).toMatch(/id is required/);
  });

  it('empty-string id → ok:false with an id error', () => {
    const result = validatePlanMetadata([{ id: '', declaredFiles: ['scripts/a.ts'], dependsOn: [] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'id')).toBe(true);
  });

  it('null input → ok:false, does NOT throw (Fix 3)', () => {
    expect(() => validatePlanMetadata(null as never)).not.toThrow();
    const result = validatePlanMetadata(null as never);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'metadata')).toBe(true);
  });

  it('array with null/undefined/string elements → ok:false, does NOT throw (Fix 3)', () => {
    expect(() => validatePlanMetadata([null, undefined, 'x'] as never)).not.toThrow();
    const result = validatePlanMetadata([null, undefined, 'x'] as never);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'metadata')).toBe(true);
  });

  it('valid array still returns ok:true after Fix 3 hardening (regression)', () => {
    const result = validatePlanMetadata([validChunk('c1'), validChunk('c2')]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parsePlanMetadata — snake→camel normalisation (OAI-002)
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — snake→camel (OAI-002)', () => {
  it('snake_case fixture from Chunk 1 metadata → ok:true after parsePlanMetadata + validatePlanMetadata', () => {
    // This is the actual Chunk 1 metadata block verbatim from the plan.
    const snakeRaw = [
      {
        id: '1',
        declared_files: [
          'scripts/build-scheduler/computeWaves.ts',
          'scripts/build-scheduler/__tests__/computeWaves.test.ts',
          'manifest.json',
        ],
        depends_on: [] as string[],
        exclusive_resources: ['manifest.json'],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(snakeRaw);
    expect(pathErrors).toHaveLength(0);

    // camelCase fields must be populated.
    expect(chunks[0].declaredFiles).toBeDefined();
    expect(chunks[0].dependsOn).toBeDefined();
    expect(chunks[0].exclusiveResources).toEqual(['manifest.json']);

    const result = validatePlanMetadata(chunks);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('malformed snake_case block (missing declared_files) → ok:false', () => {
    const snakeRaw = [
      {
        id: 'c1',
        // declared_files intentionally omitted
        depends_on: [] as string[],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(snakeRaw);
    expect(pathErrors).toHaveLength(0);

    const result = validatePlanMetadata(chunks);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });

  it('camelCase keys are also accepted (idempotent normalisation)', () => {
    const camelRaw = [
      {
        id: 'c1',
        declaredFiles: ['src/a.ts'],
        dependsOn: [] as string[],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(camelRaw);
    expect(pathErrors).toHaveLength(0);
    expect(validatePlanMetadata(chunks).ok).toBe(true);
  });

  it('spec_sections is normalised to specSections', () => {
    const raw = [
      {
        id: 'c1',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
        spec_sections: ['§3.1', '§4'],
      },
    ];

    const { chunks } = parsePlanMetadata(raw);
    expect(chunks[0].specSections).toEqual(['§3.1', '§4']);
  });
});

// ---------------------------------------------------------------------------
// parsePlanMetadata — path canonicalisation (round-2 HIGH)
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — path canonicalisation', () => {
  it('./src/a.ts and src/a.ts canonicalise to the same path', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['./src/a.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Both should resolve to 'src/a.ts'.
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
    expect(chunks[1].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src\\\\a.ts (backslash) and src/a.ts canonicalise to the same path', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['src\\a.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
    expect(chunks[1].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src//a.ts (double slash) canonicalises to src/a.ts', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src//a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src/Foo.ts and src/foo.ts treated as same file under case-fold (de-duplication within a chunk)', () => {
    // When both appear in the same chunk they are de-duplicated; only one survives.
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/Foo.ts', 'src/foo.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Only one should survive (case-fold de-dup).
    expect(chunks[0].declaredFiles).toHaveLength(1);
  });

  it('src/Foo.ts in chunkA and src/foo.ts in chunkB are treated as the same file by computeWaves (serialised into separate waves)', () => {
    // Verifies the intra-parse path preserves original casing AND that
    // computeWaves enforces file-identity case-insensitively across chunks.
    // See computeWaves.test.ts A3b for the end-to-end case-fold regression.
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['src/Foo.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/foo.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Original casing is preserved in storage (required for git on Linux CI).
    expect(chunks[0].declaredFiles![0]).toBe('src/Foo.ts');
    expect(chunks[1].declaredFiles![0]).toBe('src/foo.ts');

    // Route through computeWaves: chunkA and chunkB must be serialised.
    const result = computeWaves({ chunks, concurrencyCap: 2 });
    expect(result.waves).toHaveLength(2);
    for (const wave of result.waves) {
      const hasA = wave.chunkIds.includes('chunkA');
      const hasB = wave.chunkIds.includes('chunkB');
      expect(hasA && hasB).toBe(false);
    }
    const reason = result.serialisedReasons.find((r) => r.chunkId === 'chunkB');
    expect(reason?.reason).toBe('file-overlap');
  });

  it('absolute path (Unix /absolute/path.ts) → ValidationError (not accepted)', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['/absolute/path.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].chunkId).toBe('c1');
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(pathErrors[0].message).toMatch(/absolute/i);
    // The file entry should not appear in the canonicalised output.
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('absolute path (Windows C:/path.ts) → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['C:/path/file.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].message).toMatch(/absolute/i);
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('.. segment → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/../secret.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(pathErrors[0].message).toMatch(/\.\./);
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('empty string entry → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: [''],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('valid and invalid entries mixed: valid ones survive, invalid ones produce errors', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/good.ts', '/bad/absolute.ts', 'src/also-good.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(1);
    expect(chunks[0].declaredFiles).toEqual(['src/good.ts', 'src/also-good.ts']);
  });

  it('de-duplicates identical entries within a chunk after normalisation', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/a.ts', './src/a.ts', 'src//a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // All three resolve to 'src/a.ts'; only one should survive.
    expect(chunks[0].declaredFiles).toHaveLength(1);
    expect(chunks[0].declaredFiles![0]).toBe('src/a.ts');
  });
});

// ---------------------------------------------------------------------------
// parsePlanMetadata — malformed depends_on / exclusive_resources entries
// must surface as errors, never be silently dropped (a dropped dependency
// edge would let a dependent chunk schedule concurrently — a safety hole).
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — malformed non-string array entries', () => {
  it('non-string depends_on entry surfaces a pathError and is not silently dropped', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c2',
        declared_files: ['src/b.ts'],
        depends_on: [1, 'c1'],
      },
    ]);

    const err = pathErrors.find((e) => e.field === 'dependsOn');
    expect(err).toBeDefined();
    expect(err!.chunkId).toBe('c2');
    expect(err!.message).toMatch(/not a string/);
    // The valid string entry is still kept.
    expect(chunks[0].dependsOn).toEqual(['c1']);
  });

  it('non-string exclusive_resources entry surfaces a pathError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
        exclusive_resources: ['migration:v1', 42],
      },
    ]);

    const err = pathErrors.find((e) => e.field === 'exclusiveResources');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not a string/);
    expect(chunks[0].exclusiveResources).toEqual(['migration:v1']);
  });

  it('NEVER throws when a malformed entry is non-JSON-serialisable (BigInt / circular)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() =>
      parsePlanMetadata([
        {
          id: 'c1',
          declared_files: ['src/a.ts', BigInt(7) as unknown as string],
          depends_on: [circular],
          exclusive_resources: [BigInt(9) as unknown as string],
        },
      ]),
    ).not.toThrow();

    const { pathErrors } = parsePlanMetadata([
      { id: 'c1', declared_files: [BigInt(7) as unknown as string], depends_on: [] as string[] },
    ]);
    // The malformed entry is reported, not silently dropped.
    expect(pathErrors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: scalar (non-array) values for depends_on / exclusive_resources /
// declared_files must fail closed with a pathError, not be silently dropped.
// Fix 2: null block entry and non-array raw must produce structured errors
// and NEVER throw.
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — scalar fields and non-object guards (Fix 1 + Fix 2)', () => {
  it('scalar exclusive_resources (string, not list) → non-empty pathErrors (serialisation guard)', () => {
    const { pathErrors } = parsePlanMetadata([
      { id: '1', declared_files: ['a.ts'], depends_on: [], exclusive_resources: 'migration:v2.24.0' },
    ]);
    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors.some((e) => e.field === 'exclusiveResources')).toBe(true);
  });

  it('scalar depends_on (string, not list) → non-empty pathErrors (dependency-edge guard)', () => {
    const { pathErrors } = parsePlanMetadata([
      { id: '1', declared_files: ['a.ts'], depends_on: 'chunk-0', exclusive_resources: [] },
    ]);
    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors.some((e) => e.field === 'dependsOn')).toBe(true);
  });

  it('scalar declared_files (string, not list) → non-empty pathErrors', () => {
    const { pathErrors } = parsePlanMetadata([
      { id: '1', declared_files: 'a.ts', depends_on: [], exclusive_resources: [] },
    ]);
    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });

  it('null block entry → structured error, does NOT throw', () => {
    expect(() => parsePlanMetadata([null])).not.toThrow();
    const { chunks, pathErrors } = parsePlanMetadata([null]);
    expect(chunks).toHaveLength(0);
    expect(pathErrors.some((e) => e.field === 'metadata')).toBe(true);
    expect(pathErrors[0].chunkId).toBe('<unknown>');
  });

  it('non-array raw (object) → structured error, does NOT throw', () => {
    expect(() => parsePlanMetadata({ id: '1' })).not.toThrow();
    const { chunks, pathErrors } = parsePlanMetadata({ id: '1' });
    expect(chunks).toHaveLength(0);
    expect(pathErrors.some((e) => e.field === 'metadata')).toBe(true);
  });

  it('non-array raw (string) → structured error, does NOT throw', () => {
    expect(() => parsePlanMetadata('not an array')).not.toThrow();
    const { pathErrors } = parsePlanMetadata('not an array');
    expect(pathErrors.some((e) => e.field === 'metadata')).toBe(true);
  });
});
