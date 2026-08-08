/**
 * transition-validator.test.mjs
 *
 * Covers every legal forward edge, each blocker-gated back-edge with and
 * without a blocker, terminal immutability (MERGED/ABANDONED have no
 * outbound transition), ABANDONED reachable from any non-terminal status,
 * and an unknown-status input. This is the FR-5 "invalid transition
 * rejection" scenario (spec §14).
 */
import { describe, expect, it } from 'vitest';
import { validateTransition } from './transition-validator.mjs';

const NON_TERMINAL_STATUSES = [
  'SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING',
  'FINALISING', 'MERGE_READY',
];

const FORWARD_EDGES = [
  ['SPECIFYING', 'PLANNING'],
  ['PLANNING', 'BUILDING'],
  ['BUILDING', 'REVIEWING'],
  ['REVIEWING', 'TESTING'],
  ['TESTING', 'FINALISING'],
  ['FINALISING', 'MERGE_READY'],
  ['MERGE_READY', 'MERGED'],
];

const BACK_EDGES = [
  ['MERGE_READY', 'FINALISING'],
  ['FINALISING', 'TESTING'],
  ['TESTING', 'BUILDING'],
  ['REVIEWING', 'BUILDING'],
];

describe('validateTransition — forward path', () => {
  it.each(FORWARD_EDGES)('accepts %s -> %s', async (from, to) => {
    expect(await validateTransition(from, to)).toEqual({ ok: true });
  });

  it('rejects skipping a forward step', async () => {
    const result = await validateTransition('SPECIFYING', 'BUILDING');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('validateTransition — blocker-gated back-edges', () => {
  it.each(BACK_EDGES)('accepts %s -> %s with hasBlocker: true', async (from, to) => {
    expect(await validateTransition(from, to, { hasBlocker: true })).toEqual({ ok: true });
  });

  it.each(BACK_EDGES)('rejects %s -> %s without a blocker', async (from, to) => {
    const result = await validateTransition(from, to);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it.each(BACK_EDGES)('rejects %s -> %s with hasBlocker: false', async (from, to) => {
    const result = await validateTransition(from, to, { hasBlocker: false });
    expect(result.ok).toBe(false);
  });
});

describe('validateTransition — terminal immutability', () => {
  // MERGED and ABANDONED are excluded from these two lists: from===to is an
  // idempotent no-op re-stamp, not an outbound transition, and is legal even
  // for terminal states (PR-003) — see the dedicated describe block below.
  it.each(['SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING', 'FINALISING', 'MERGE_READY', 'ABANDONED'])(
    'rejects MERGED -> %s',
    async (to) => {
      const result = await validateTransition('MERGED', to);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
  );

  it.each(['SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING', 'FINALISING', 'MERGE_READY', 'MERGED'])(
    'rejects ABANDONED -> %s',
    async (to) => {
      const result = await validateTransition('ABANDONED', to);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
  );

  it('rejects a terminal -> non-terminal transition even with hasBlocker: true', async () => {
    const result = await validateTransition('MERGED', 'BUILDING', { hasBlocker: true });
    expect(result.ok).toBe(false);
  });
});

describe('validateTransition — idempotent same-status re-stamp (PR-003)', () => {
  it('accepts a mid-state self-transition as a no-op', async () => {
    expect(await validateTransition('BUILDING', 'BUILDING')).toEqual({ ok: true });
  });

  it('accepts a terminal-state self-transition as a no-op (re-writing MERGED as MERGED)', async () => {
    expect(await validateTransition('MERGED', 'MERGED')).toEqual({ ok: true });
  });

  it('still rejects an unknown status even when from === to', async () => {
    const result = await validateTransition('BOGUS', 'BOGUS');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('BOGUS');
  });
});

describe('validateTransition — ABANDONED reachable from any non-terminal state', () => {
  it.each(NON_TERMINAL_STATUSES)('accepts %s -> ABANDONED', async (from) => {
    expect(await validateTransition(from, 'ABANDONED')).toEqual({ ok: true });
  });
});

describe('validateTransition — unknown status input', () => {
  it('rejects an unknown "from" status', async () => {
    const result = await validateTransition('TESTNG', 'FINALISING');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TESTNG');
  });

  it('rejects an unknown "to" status', async () => {
    const result = await validateTransition('TESTING', 'FINISHED');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('FINISHED');
  });

  it('never throws on garbage input', async () => {
    await expect(validateTransition(undefined, null)).resolves.toMatchObject({ ok: false });
    await expect(validateTransition('', '')).resolves.toMatchObject({ ok: false });
  });
});
