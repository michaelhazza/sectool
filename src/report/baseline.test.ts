import { describe, it, expect } from 'vitest';
import { applyBaseline } from './baseline.js';
import type { Finding } from '../schemas/finding.js';
import type { Baseline } from '../schemas/baseline.js';

// Helper to build a minimal valid static Finding
function makeStaticFinding(overrides: {
  fingerprint: string;
  ruleId?: string;
  targetName?: string;
  locationSymbol?: string;
}): Finding {
  const fp = overrides.fingerprint;
  const id = `f-${fp.slice(0, 16)}`;
  return {
    id,
    fingerprint: fp,
    ruleId: overrides.ruleId ?? 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    target: { kind: 'repo', name: overrides.targetName ?? 'repo-a' },
    location: {
      path: 'src/db/query.ts',
      symbol: overrides.locationSymbol ?? 'GET /api/users/:id',
      startLine: 42,
    },
    evidence: { snippet: 'db.execute(sql`...`)', cvss: null, raw: {} },
    reachability: 'unauthenticated',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-12T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
  };
}

// A full 64-hex fingerprint for target A
const FP_A = 'a'.repeat(64);
// A full 64-hex fingerprint for target B — same 16-hex prefix as FP_A, different full value
const FP_B = 'a'.repeat(16) + 'b'.repeat(48);

describe('applyBaseline', () => {
  it('suppresses a finding when ALL scope fields match (full fingerprint, ruleId, target)', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A, targetName: 'repo-a' });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'test-only endpoint',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result).toBeDefined();
    expect(result!.suppressed).toBe(true);
    expect(result!.suppression).toEqual({
      justification: 'test-only endpoint',
      approvedBy: 'alice',
      expiry: '2099-01-01',
    });
    expect(result!.note).toBeNull();
  });

  it('does NOT suppress when ruleId differs', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A, targetName: 'repo-a' });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-AUTH-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'different rule',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(false);
    expect(result!.suppression).toBeNull();
  });

  // §10 scoped suppression guardrail (a): entry scoped to one target does NOT
  // suppress the same finding on a different target
  it('§10 guardrail (a): entry scoped to repo-a does not suppress the same fingerprint on repo-b', () => {
    const findingA = makeStaticFinding({ fingerprint: FP_A, targetName: 'repo-a' });
    const findingB = makeStaticFinding({ fingerprint: FP_A, targetName: 'repo-b' });

    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'scoped to repo-a only',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const results = applyBaseline([findingA, findingB], baseline, new Date('2026-06-13'));
    const resultA = results.find((f) => f.target.kind === 'repo' && f.target.name === 'repo-a');
    const resultB = results.find((f) => f.target.kind === 'repo' && f.target.name === 'repo-b');

    expect(resultA!.suppressed).toBe(true);
    expect(resultB!.suppressed).toBe(false);
    expect(resultB!.suppression).toBeNull();
  });

  // §10 scoped suppression guardrail (b): two findings sharing a 16-hex id prefix
  // but differing in full fingerprint are suppressed independently
  it('§10 guardrail (b): two findings with same 16-hex prefix but different full fingerprint are suppressed independently', () => {
    // FP_A and FP_B share the first 16 hex chars
    expect(FP_A.slice(0, 16)).toBe(FP_B.slice(0, 16));

    const findingA = makeStaticFinding({ fingerprint: FP_A });
    const findingB = makeStaticFinding({ fingerprint: FP_B });

    // Baseline only covers FP_A
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'only FP_A suppressed',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const results = applyBaseline([findingA, findingB], baseline, new Date('2026-06-13'));
    const rA = results.find((f) => f.fingerprint === FP_A);
    const rB = results.find((f) => f.fingerprint === FP_B);

    expect(rA!.suppressed).toBe(true);
    expect(rB!.suppressed).toBe(false);
  });

  // §6.4 expired entry: stops suppressing, finding re-alerts with note
  it('expired entry does not suppress; finding carries "baseline expired <date>" note', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'expired entry',
          expiry: '2026-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(false);
    expect(result!.suppression).toBeNull();
    expect(result!.note).toMatch(/baseline expired 2026-01-01/);
  });

  it('unexpired entry on today\'s date suppresses (expiry is inclusive)', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A });
    const today = new Date('2026-06-13');
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'expires today',
          expiry: '2026-06-13',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, today);
    expect(result!.suppressed).toBe(true);
  });

  it('entry expired yesterday does not suppress', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A });
    const today = new Date('2026-06-13');
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'expired yesterday',
          expiry: '2026-06-12',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, today);
    expect(result!.suppressed).toBe(false);
    expect(result!.note).toMatch(/baseline expired 2026-06-12/);
  });

  // locationKey match: present in entry → must also match finding's location symbol
  it('suppresses when locationKey matches finding symbol', () => {
    const finding = makeStaticFinding({
      fingerprint: FP_A,
      locationSymbol: 'GET /api/users/:id',
    });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          locationKey: 'GET /api/users/:id',
          justification: 'known safe',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(true);
  });

  it('does NOT suppress when locationKey is present but does not match finding symbol', () => {
    const finding = makeStaticFinding({
      fingerprint: FP_A,
      locationSymbol: 'GET /api/users/:id',
    });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          locationKey: 'POST /api/users',
          justification: 'different route',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(false);
  });

  it('suppresses when locationKey is absent (entry applies to all locations with matching fingerprint)', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A, locationSymbol: 'POST /api/data' });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: FP_A,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'no location restriction',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(true);
  });

  it('does not modify findings with no matching entry', () => {
    const finding = makeStaticFinding({ fingerprint: FP_A });
    const baseline: Baseline = { entries: [] };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(false);
    expect(result!.suppression).toBeNull();
    expect(result!.note).toBeNull();
  });

  it('returns an empty array for empty findings input', () => {
    const baseline: Baseline = { entries: [] };
    const result = applyBaseline([], baseline, new Date('2026-06-13'));
    expect(result).toEqual([]);
  });

  it('handles live (staging) targets correctly', () => {
    const fp = 'c'.repeat(64);
    const id = `f-${fp.slice(0, 16)}`;
    const finding: Finding = {
      id,
      fingerprint: fp,
      ruleId: 'LIVE-TLS-001',
      source: 'probe',
      surface: 'live',
      vulnClass: 'tls',
      severity: 'medium',
      baseSeverity: 'medium',
      confidence: 'confirmed',
      target: { kind: 'staging', host: 'staging.example.breakout.dev' },
      location: {
        url: 'https://staging.example.breakout.dev/',
        method: 'GET',
      },
      evidence: { cvss: null, raw: {} },
      reachability: 'unknown',
      correlatedWith: [],
      externalRefs: [],
      firstSeen: '2026-06-12T00:00:00.000Z',
      suppressed: false,
      suppression: null,
      note: null,
    };

    const baseline: Baseline = {
      entries: [
        {
          fingerprint: fp,
          ruleId: 'LIVE-TLS-001',
          target: { kind: 'staging', host: 'staging.example.breakout.dev' },
          justification: 'known TLS quirk',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(true);
    expect(result!.suppression?.justification).toBe('known TLS quirk');
  });

  it('does NOT suppress live finding when staging host does not match entry host', () => {
    const fp = 'c'.repeat(64);
    const id = `f-${fp.slice(0, 16)}`;
    const finding: Finding = {
      id,
      fingerprint: fp,
      ruleId: 'LIVE-TLS-001',
      source: 'probe',
      surface: 'live',
      vulnClass: 'tls',
      severity: 'medium',
      baseSeverity: 'medium',
      confidence: 'confirmed',
      target: { kind: 'staging', host: 'staging.other.breakout.dev' },
      location: {
        url: 'https://staging.other.breakout.dev/',
        method: 'GET',
      },
      evidence: { cvss: null, raw: {} },
      reachability: 'unknown',
      correlatedWith: [],
      externalRefs: [],
      firstSeen: '2026-06-12T00:00:00.000Z',
      suppressed: false,
      suppression: null,
      note: null,
    };

    const baseline: Baseline = {
      entries: [
        {
          fingerprint: fp,
          ruleId: 'LIVE-TLS-001',
          target: { kind: 'staging', host: 'staging.example.breakout.dev' },
          justification: 'entry for different host',
          expiry: '2099-01-01',
          approvedBy: 'alice',
        },
      ],
    };

    const [result] = applyBaseline([finding], baseline, new Date('2026-06-13'));
    expect(result!.suppressed).toBe(false);
  });
});
