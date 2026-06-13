import { describe, it, expect } from 'vitest';
import { toSarif } from './sarif.js';
import type { RunReport, RunMeta, RunTarget } from '../schemas/report.js';
import type { Finding } from '../schemas/finding.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFingerprint(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

function makeStaticFinding(overrides: Partial<Finding> = {}): Finding {
  const fp = makeFingerprint('aaaa1111');
  return {
    id: `f-${fp.slice(0, 16)}`,
    fingerprint: fp,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    target: { kind: 'repo', name: 'repo-a' },
    location: { path: 'src/index.ts', symbol: 'GET /api/users/:id', startLine: 42 },
    evidence: { snippet: 'db.query(id)', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    docs: 'docs/rules/BS-SQL-001.md',
    externalRefs: [],
    firstSeen: '2026-06-01T00:00:00Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
}

function makeLiveFinding(overrides: Partial<Finding> = {}): Finding {
  const fp = makeFingerprint('live1234');
  return {
    id: `f-${fp.slice(0, 16)}`,
    fingerprint: fp,
    ruleId: 'LIVE-TLS-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'tls',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    target: { kind: 'staging', host: 'staging.example.com' },
    location: { url: 'https://staging.example.com/api/login', method: 'GET' },
    evidence: { snippet: undefined, cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    docs: 'docs/rules/LIVE-TLS-001.md',
    externalRefs: [],
    firstSeen: '2026-06-01T00:00:00Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
}

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    status: 'success',
    failures: [],
    scannerStatus: [],
    startedAt: '2026-06-12T03:00:00Z',
    finishedAt: '2026-06-12T03:08:11Z',
    toolVersion: 'audit-tool/1.0.0',
    ...overrides,
  };
}

function makeTarget(name: string): RunTarget {
  return { kind: 'repo', name, coverageGaps: [] };
}

function makeReport(findings: Finding[], metaOverrides: Partial<RunMeta> = {}): RunReport {
  return {
    runId: '2026-06-12T03-00-00Z-abcd',
    date: '2026-06-12',
    findings,
    targets: [makeTarget('repo-a')],
    meta: makeMeta(metaOverrides),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSarif(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 structure
// ---------------------------------------------------------------------------

describe('toSarif — SARIF 2.1.0 structure', () => {
  it('emits version 2.1.0 and $schema', () => {
    const out = parseSarif(toSarif(makeReport([])));
    expect(out['version']).toBe('2.1.0');
    expect(typeof out['$schema']).toBe('string');
    expect(out['$schema'] as string).toMatch(/sarif-schema-2\.1\.0/);
  });

  it('emits a single runs[] entry with tool.driver.name = audit-tool', () => {
    const out = parseSarif(toSarif(makeReport([])));
    const runs = out['runs'] as Array<{ tool: { driver: { name: string; version: string } } }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.tool.driver.name).toBe('audit-tool');
  });

  it('strips the "audit-tool/" prefix from toolVersion in driver.version', () => {
    const out = parseSarif(toSarif(makeReport([], { toolVersion: 'audit-tool/2.3.1' })));
    const runs = out['runs'] as Array<{ tool: { driver: { name: string; version: string } } }>;
    expect(runs[0]?.tool.driver.version).toBe('2.3.1');
  });
});

// ---------------------------------------------------------------------------
// tool.driver.rules — reportingDescriptors
// ---------------------------------------------------------------------------

describe('toSarif — tool.driver.rules', () => {
  it('emits one reportingDescriptor per distinct ruleId', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const fp3 = makeFingerprint('cccc3333');
    const f1 = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, ruleId: 'BS-SQL-001' });
    const f2 = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}`, ruleId: 'BS-SQL-002' });
    // Same ruleId as f1 — should NOT produce a second rule entry
    const f3 = makeStaticFinding({ fingerprint: fp3, id: `f-${fp3.slice(0, 16)}`, ruleId: 'BS-SQL-001' });

    const out = parseSarif(toSarif(makeReport([f1, f2, f3])));
    const runs = out['runs'] as Array<{ tool: { driver: { rules: Array<{ id: string }> } } }>;
    const ruleIds = runs[0]?.tool.driver.rules.map((r) => r.id) ?? [];
    expect(ruleIds.filter((id) => id === 'BS-SQL-001')).toHaveLength(1);
    expect(ruleIds.filter((id) => id === 'BS-SQL-002')).toHaveLength(1);
    expect(ruleIds).toHaveLength(2);
  });

  it('each rule descriptor has a helpUri and shortDescription', () => {
    const f = makeStaticFinding();
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      tool: { driver: { rules: Array<{ id: string; helpUri: string; shortDescription: { text: string } }> } };
    }>;
    const rule = runs[0]?.tool.driver.rules[0];
    expect(rule?.helpUri).toMatch(/docs\/rules\/BS-SQL-001/);
    expect(typeof rule?.shortDescription.text).toBe('string');
    expect(rule?.shortDescription.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// results — one per finding
// ---------------------------------------------------------------------------

describe('toSarif — results', () => {
  it('emits one result per finding', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const f1 = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}` });
    const f2 = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}` });
    const out = parseSarif(toSarif(makeReport([f1, f2])));
    const runs = out['runs'] as Array<{ results: unknown[] }>;
    expect(runs[0]?.results).toHaveLength(2);
  });

  it('result.fingerprints.auditToolFingerprintV1 = full 64-hex fingerprint (not truncated id)', () => {
    const fp = makeFingerprint('deadbeef1234');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ fingerprints: { auditToolFingerprintV1: string } }>;
    }>;
    const result = runs[0]?.results[0];
    expect(result?.fingerprints.auditToolFingerprintV1).toBe(fp);
    expect(result?.fingerprints.auditToolFingerprintV1).toHaveLength(64);
    // Must NOT be the truncated display id (16 hex chars)
    expect(result?.fingerprints.auditToolFingerprintV1).not.toMatch(/^f-/);
  });
});

// ---------------------------------------------------------------------------
// Severity → level mapping
// ---------------------------------------------------------------------------

describe('toSarif — severity level mapping', () => {
  it.each([
    ['critical', 'error'],
    ['high', 'error'],
    ['medium', 'warning'],
    ['low', 'note'],
  ])('severity "%s" → level "%s"', (severity, expectedLevel) => {
    const fp = makeFingerprint('lvltest1');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      severity: severity as Finding['severity'],
      baseSeverity: severity as Finding['severity'],
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{ results: Array<{ level: string }> }>;
    expect(runs[0]?.results[0]?.level).toBe(expectedLevel);
  });

  it('emits result.rank for each finding', () => {
    const fp = makeFingerprint('ranktest1');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{ results: Array<{ rank: number }> }>;
    expect(runs[0]?.results[0]?.rank).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Suppression — reads from report-stage suppression field
// ---------------------------------------------------------------------------

describe('toSarif — suppression', () => {
  it('suppressed:true findings emit result.suppressions[] with kind:external', () => {
    const fp = makeFingerprint('suppressed1');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      suppressed: true,
      suppression: {
        justification: 'test-only endpoint',
        approvedBy: 'alice',
        expiry: '2099-12-31',
      },
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ suppressions?: Array<{ kind: string; justification: string }> }>;
    }>;
    const result = runs[0]?.results[0];
    expect(result?.suppressions).toBeDefined();
    expect(result?.suppressions).toHaveLength(1);
    expect(result?.suppressions?.[0]?.kind).toBe('external');
    expect(result?.suppressions?.[0]?.justification).toBe('test-only endpoint');
  });

  it('suppression.justification comes from the finding suppression field, not config', () => {
    // The report-stage suppression field is the source of truth (§6.10/§6.1)
    const fp = makeFingerprint('suppressed2');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      suppressed: true,
      suppression: {
        justification: 'legacy code scheduled for Q3 removal',
        approvedBy: 'bob',
        expiry: '2099-06-30',
      },
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ suppressions?: Array<{ justification: string }> }>;
    }>;
    expect(runs[0]?.results[0]?.suppressions?.[0]?.justification).toBe(
      'legacy code scheduled for Q3 removal',
    );
  });

  it('unsuppressed findings do NOT emit suppressions[]', () => {
    const fp = makeFingerprint('notsupp001');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ suppressions?: unknown }>;
    }>;
    expect(runs[0]?.results[0]?.suppressions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Location — static vs live
// ---------------------------------------------------------------------------

describe('toSarif — location', () => {
  it('static finding emits physicalLocation + logicalLocation', () => {
    const fp = makeFingerprint('static001');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      location: { path: 'server/routes/users.ts', symbol: 'GET /api/users/:id', startLine: 42 },
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{
        locations: Array<{
          physicalLocation?: { artifactLocation: { uri: string }; region?: { startLine: number } };
          logicalLocation?: { fullyQualifiedName: string };
        }>;
      }>;
    }>;
    const loc = runs[0]?.results[0]?.locations[0];
    expect(loc?.physicalLocation?.artifactLocation.uri).toBe('server/routes/users.ts');
    expect(loc?.physicalLocation?.region?.startLine).toBe(42);
    expect(loc?.logicalLocation?.fullyQualifiedName).toBe('GET /api/users/:id');
  });

  it('live finding emits logicalLocation only (no physicalLocation)', () => {
    const f = makeLiveFinding();
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{
        locations: Array<{ physicalLocation?: unknown; logicalLocation?: { fullyQualifiedName: string } }>;
      }>;
    }>;
    const loc = runs[0]?.results[0]?.locations[0];
    expect(loc?.physicalLocation).toBeUndefined();
    expect(loc?.logicalLocation?.fullyQualifiedName).toMatch(/GET/);
  });
});

// ---------------------------------------------------------------------------
// externalRefs → workItemUris
// ---------------------------------------------------------------------------

describe('toSarif — workItemUris', () => {
  it('externalRefs are mapped to result.workItemUris', () => {
    const fp = makeFingerprint('witest001');
    const issueUrl = 'https://github.com/org/repo/issues/42';
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      externalRefs: [issueUrl],
    });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ workItemUris?: string[] }>;
    }>;
    expect(runs[0]?.results[0]?.workItemUris).toContain(issueUrl);
  });

  it('findings with no externalRefs do not emit workItemUris', () => {
    const fp = makeFingerprint('wino001');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}`, externalRefs: [] });
    const out = parseSarif(toSarif(makeReport([f])));
    const runs = out['runs'] as Array<{
      results: Array<{ workItemUris?: unknown }>;
    }>;
    expect(runs[0]?.results[0]?.workItemUris).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deterministic byte order
// ---------------------------------------------------------------------------

describe('toSarif — deterministic output', () => {
  it('produces identical output for two calls on the same report (byte-stable)', () => {
    const fp1 = makeFingerprint('det000001');
    const fp2 = makeFingerprint('det000002');
    const f1 = makeStaticFinding({
      fingerprint: fp1,
      id: `f-${fp1.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
    });
    const f2 = makeStaticFinding({
      fingerprint: fp2,
      id: `f-${fp2.slice(0, 16)}`,
      severity: 'high',
      baseSeverity: 'high',
    });
    const report = makeReport([f1, f2]);
    const out1 = toSarif(report);
    const out2 = toSarif(report);
    expect(out1).toBe(out2);
  });

  it('produces the same order regardless of input finding order', () => {
    const fp1 = makeFingerprint('ord000001');
    const fp2 = makeFingerprint('ord000002');
    const f1 = makeStaticFinding({
      fingerprint: fp1,
      id: `f-${fp1.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
    });
    const f2 = makeStaticFinding({
      fingerprint: fp2,
      id: `f-${fp2.slice(0, 16)}`,
      severity: 'low',
      baseSeverity: 'low',
      vulnClass: 'tls',
    });
    const out1 = toSarif(makeReport([f1, f2]));
    const out2 = toSarif(makeReport([f2, f1]));
    expect(out1).toBe(out2);
  });
});

// ---------------------------------------------------------------------------
// Redaction pass (§5.4 / §10 guardrail)
// ---------------------------------------------------------------------------

describe('toSarif — redaction pass', () => {
  it('credential material in evidence.raw.secret does not appear in SARIF output', () => {
    const fp = makeFingerprint('sarifredact');
    const rawSecret = 'super-secret-token-sarif-xyz';
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      vulnClass: 'secrets',
      source: 'gitleaks',
      evidence: {
        snippet: 'API_KEY = "PLACEHOLDER"',
        cvss: null,
        raw: { secret: rawSecret },
      },
    });
    const out = toSarif(makeReport([f]));
    expect(out).not.toContain(rawSecret);
  });

  it('Authorization header value in evidence.raw is replaced with a redacted placeholder', () => {
    const fp = makeFingerprint('sarifredact2');
    const rawToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-part.sig';
    const f = makeLiveFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: {
        snippet: undefined,
        cvss: null,
        // 'authorization' is a credential key in redaction.ts
        raw: { authorization: rawToken },
      },
    });
    const out = toSarif(makeReport([f]));
    expect(out).not.toContain(rawToken);
  });
});
