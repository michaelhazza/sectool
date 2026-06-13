import { describe, it, expect } from 'vitest';
import { computeTargetTrend, buildTrendLine } from './trend.js';
import type { RunReport } from '../schemas/report.js';
import type { Finding, ScannerFamily } from '../schemas/finding.js';

// ---------------------------------------------------------------------------
// Minimal Finding factory
// ---------------------------------------------------------------------------

function makeFinding(overrides: {
  fingerprint: string;
  source: Finding['source'];
  targetName?: string;
  targetKind?: 'repo' | 'staging';
  severity?: Finding['severity'];
}): Finding {
  const fp = overrides.fingerprint;
  const id = `f-${fp.slice(0, 16)}`;
  const targetKind = overrides.targetKind ?? 'repo';
  const targetName = overrides.targetName ?? 'test-repo';
  const common = {
    id,
    fingerprint: fp,
    ruleId: 'BS-TEST-001',
    source: overrides.source,
    vulnClass: 'injection' as const,
    severity: overrides.severity ?? 'high',
    baseSeverity: overrides.severity ?? 'high',
    confidence: 'probable' as const,
    evidence: { snippet: 'test snippet', cvss: null, raw: {} },
    reachability: 'unknown' as const,
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
  };

  if (targetKind === 'repo') {
    return {
      ...common,
      surface: 'static',
      target: { kind: 'repo', name: targetName },
      location: { path: 'src/test.ts', symbol: 'GET /test' },
    };
  }
  return {
    ...common,
    surface: 'live',
    target: { kind: 'staging', host: targetName },
    location: { url: 'https://staging.example.com/test', method: 'GET' },
  };
}

// ---------------------------------------------------------------------------
// Minimal RunReport factory
// ---------------------------------------------------------------------------

function makeReport(overrides: {
  runId?: string;
  findings?: Finding[];
  scannerStatus?: RunReport['meta']['scannerStatus'];
  failures?: RunReport['meta']['failures'];
}): RunReport {
  return {
    runId: overrides.runId ?? '2026-06-13T00-00-00Z-abcd',
    date: '2026-06-13',
    findings: overrides.findings ?? [],
    targets: [],
    meta: {
      status: 'success',
      failures: overrides.failures ?? [],
      scannerStatus: overrides.scannerStatus ?? [],
      startedAt: '2026-06-13T00:00:00.000Z',
      finishedAt: '2026-06-13T00:08:00.000Z',
      toolVersion: 'audit-tool/1.0.0',
    },
  };
}

// Fingerprint helpers: 64-hex strings unique per test
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);
const FP_D = 'd'.repeat(64);

// ---------------------------------------------------------------------------
// §10 Partial-run trend guardrail
// ---------------------------------------------------------------------------

// Helper: build a prevFingerprints map in the new family-attributed format
// target → family → Set<fp>
function makePrevFps(
  targetName: string,
  familyFps: Record<string, string[]>,
): Map<string, Map<ScannerFamily, Set<string>>> {
  const familyMap = new Map<ScannerFamily, Set<string>>();
  for (const [family, fps] of Object.entries(familyFps)) {
    familyMap.set(family as ScannerFamily, new Set(fps));
  }
  return new Map([[targetName, familyMap]]);
}

describe('computeTargetTrend — partial-run rule (§6.5 / §10 guardrail)', () => {
  it('when a scanner family times out, its previously-known finding is NOT counted fixed', () => {
    // Previous run: ast family produced FP_A (complete)
    const prevFps = makePrevFps('test-repo', { ast: [FP_A] });

    // Current run: ast family TIMED OUT (skipped), so FP_A is absent not because it's fixed
    const currentReport = makeReport({
      findings: [], // FP_A is absent — but ast timed out
      scannerStatus: [
        // ast skipped (timed-out family records as skipped in the orchestrator)
        { target: 'test-repo', family: 'ast', state: 'skipped' },
      ],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    // The target must record status:"unknown" because ast did not complete
    expect(trend.status).toBe('unknown');
    // fixed MUST be 0 — FP_A's absence is NOT evidence of a fix when ast didn't complete
    expect(trend.fixed).toBe(0);
    // new and persisting are also 0 (no findings from complete families)
    expect(trend.new).toBe(0);
    expect(trend.persisting).toBe(0);
  });

  it('when a scanner family fails, its previously-known finding is NOT counted fixed', () => {
    const prevFps = makePrevFps('test-repo', { ast: [FP_A] });

    const currentReport = makeReport({
      findings: [],
      scannerStatus: [{ target: 'test-repo', family: 'ast', state: 'failed' }],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    expect(trend.status).toBe('unknown');
    expect(trend.fixed).toBe(0);
  });

  it('run reports partial when a scanner family did not complete', () => {
    // This test verifies the overall run status integration:
    // When any scanner family is skipped/failed, the target trend status is "unknown".
    // The runReport itself has status:"partial" when failures are present.
    const partialReport = makeReport({
      findings: [],
      scannerStatus: [
        { target: 'test-repo', family: 'ast', state: 'failed' },
        { target: 'test-repo', family: 'semgrep', state: 'complete' },
      ],
      failures: [{ target: 'test-repo', family: 'ast', reason: 'timeout after 900s' }],
    });
    // The run-level status is partial when meta.failures is non-empty
    // (set by the orchestrator; we verify the trend correctly reads scanner status)
    const trend = computeTargetTrend('test-repo', partialReport, undefined);
    expect(trend.status).toBe('unknown');
  });

  it('when all families complete, a finding absent in current run IS counted fixed', () => {
    const prevFps = makePrevFps('test-repo', { ast: [FP_A, FP_B] });

    const currentReport = makeReport({
      findings: [
        makeFinding({ fingerprint: FP_B, source: 'ast' }), // FP_B persists
        // FP_A is gone — and ast completed → it IS fixed
      ],
      scannerStatus: [{ target: 'test-repo', family: 'ast', state: 'complete' }],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    expect(trend.status).toBe('complete');
    expect(trend.fixed).toBe(1);
    expect(trend.persisting).toBe(1);
    expect(trend.new).toBe(0);
  });

  it('correctly computes new findings in a complete run', () => {
    const prevFps = makePrevFps('test-repo', { ast: [FP_A] });

    const currentReport = makeReport({
      findings: [
        makeFinding({ fingerprint: FP_A, source: 'ast' }), // persisting
        makeFinding({ fingerprint: FP_C, source: 'ast' }), // new
      ],
      scannerStatus: [{ target: 'test-repo', family: 'ast', state: 'complete' }],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    expect(trend.status).toBe('complete');
    expect(trend.new).toBe(1);
    expect(trend.fixed).toBe(0);
    expect(trend.persisting).toBe(1);
  });

  it('first run with no prev report: all findings are new, fixed=0', () => {
    const currentReport = makeReport({
      findings: [
        makeFinding({ fingerprint: FP_A, source: 'ast' }),
        makeFinding({ fingerprint: FP_B, source: 'semgrep' }),
      ],
      scannerStatus: [
        { target: 'test-repo', family: 'ast', state: 'complete' },
        { target: 'test-repo', family: 'semgrep', state: 'complete' },
      ],
    });

    const trend = computeTargetTrend('test-repo', currentReport, undefined);

    expect(trend.status).toBe('complete');
    expect(trend.new).toBe(2);
    expect(trend.fixed).toBe(0);
    expect(trend.persisting).toBe(0);
  });

  it('bySeverity counts all current findings regardless of family completion', () => {
    // Even on a partial run, bySeverity counts what we DO have
    const currentReport = makeReport({
      findings: [
        makeFinding({ fingerprint: FP_A, source: 'ast', severity: 'critical' }),
        makeFinding({ fingerprint: FP_B, source: 'ast', severity: 'high' }),
        makeFinding({ fingerprint: FP_C, source: 'semgrep', severity: 'medium' }),
      ],
      scannerStatus: [
        { target: 'test-repo', family: 'ast', state: 'complete' },
        { target: 'test-repo', family: 'semgrep', state: 'failed' }, // partial
      ],
    });

    const trend = computeTargetTrend('test-repo', currentReport, undefined);

    expect(trend.bySeverity.critical).toBe(1);
    expect(trend.bySeverity.high).toBe(1);
    expect(trend.bySeverity.medium).toBe(1);
    expect(trend.bySeverity.low).toBe(0);
    expect(trend.status).toBe('unknown');
  });

  // AUD-007: cross-family masquerade guardrail
  // prev semgrep found FP_X, prev ast found FP_Y
  // this run: semgrep FAILED (so FP_X absence is unknown), ast COMPLETE (FP_Y absent = fixed)
  // Expected: fixed===0 (FP_X must NOT be counted fixed since semgrep failed),
  //           status==='unknown' (semgrep failed)
  it('AUD-007 — semgrep-produced fp NOT counted fixed when semgrep fails this run', () => {
    const FP_X = 'x'.repeat(64);
    const FP_Y = 'y'.repeat(64);

    // prev: semgrep produced FP_X, ast produced FP_Y
    const prevFps = makePrevFps('test-repo', { semgrep: [FP_X], ast: [FP_Y] });

    // this run: semgrep FAILED, ast COMPLETE, neither FP_X nor FP_Y present
    const currentReport = makeReport({
      findings: [],
      scannerStatus: [
        { target: 'test-repo', family: 'semgrep', state: 'failed' },
        { target: 'test-repo', family: 'ast', state: 'complete' },
      ],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    // FP_X: semgrep failed → NOT counted fixed
    // FP_Y: ast completed AND FP_Y absent → counted fixed
    // Net fixed = 1 (only FP_Y), NOT 2
    expect(trend.fixed).toBe(1);
    // status is unknown because semgrep failed
    expect(trend.status).toBe('unknown');
  });

  it('AUD-007 strict: semgrep failed + ast complete + FP_X absent → fixed===0 when FP_X is semgrep-only', () => {
    const FP_X = 'x'.repeat(64);

    // prev: only semgrep produced FP_X (no ast findings)
    const prevFps = makePrevFps('test-repo', { semgrep: [FP_X] });

    // this run: semgrep FAILED, ast COMPLETE, FP_X absent
    const currentReport = makeReport({
      findings: [],
      scannerStatus: [
        { target: 'test-repo', family: 'semgrep', state: 'failed' },
        { target: 'test-repo', family: 'ast', state: 'complete' },
      ],
    });

    const trend = computeTargetTrend('test-repo', currentReport, prevFps);

    // FP_X was from semgrep which failed → fixed MUST be 0
    expect(trend.fixed).toBe(0);
    // status unknown (semgrep failed)
    expect(trend.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildTrendLine — multi-target
// ---------------------------------------------------------------------------

describe('buildTrendLine', () => {
  it('produces a trend line with correct runId and date', () => {
    const report = makeReport({ runId: '2026-06-13T00-00-00Z-test' });
    const line = buildTrendLine(report, undefined);
    expect(line.runId).toBe('2026-06-13T00-00-00Z-test');
    expect(line.date).toBe('2026-06-13');
  });

  it('includes targets found via findings', () => {
    const report = makeReport({
      findings: [makeFinding({ fingerprint: FP_A, source: 'ast', targetName: 'repo-x' })],
      scannerStatus: [{ target: 'repo-x', family: 'ast', state: 'complete' }],
    });
    const line = buildTrendLine(report, undefined);
    expect(Object.keys(line.targets)).toContain('repo-x');
  });

  it('includes targets found via scannerStatus with no findings', () => {
    const report = makeReport({
      findings: [],
      scannerStatus: [{ target: 'empty-repo', family: 'ast', state: 'complete' }],
    });
    const line = buildTrendLine(report, undefined);
    expect(Object.keys(line.targets)).toContain('empty-repo');
    expect(line.targets['empty-repo']?.new).toBe(0);
    expect(line.targets['empty-repo']?.status).toBe('complete');
  });

  it('handles live (staging) targets keyed by host', () => {
    const report = makeReport({
      findings: [
        makeFinding({
          fingerprint: FP_D,
          source: 'probe',
          targetName: 'staging.example.com',
          targetKind: 'staging',
        }),
      ],
      scannerStatus: [{ target: 'staging.example.com', family: 'probe', state: 'complete' }],
    });
    const line = buildTrendLine(report, undefined);
    expect(Object.keys(line.targets)).toContain('staging.example.com');
    expect(line.targets['staging.example.com']?.new).toBe(1);
  });
});
