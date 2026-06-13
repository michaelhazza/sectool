import { describe, it, expect } from 'vitest';
import { toMarkdown } from './markdown.js';
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
// §8.1 report order
// ---------------------------------------------------------------------------

describe('toMarkdown — §8.1 report order', () => {
  it('renders critical findings before high before medium before low', () => {
    const fp1 = makeFingerprint('crit001');
    const fp2 = makeFingerprint('high001');
    const fp3 = makeFingerprint('low0001');
    const critical = makeStaticFinding({
      fingerprint: fp1,
      id: `f-${fp1.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
    });
    const high = makeStaticFinding({
      fingerprint: fp2,
      id: `f-${fp2.slice(0, 16)}`,
      severity: 'high',
      baseSeverity: 'high',
    });
    const low = makeStaticFinding({
      fingerprint: fp3,
      id: `f-${fp3.slice(0, 16)}`,
      severity: 'low',
      baseSeverity: 'low',
      vulnClass: 'tls',
    });
    const out = toMarkdown(makeReport([high, low, critical]));
    const critPos = out.indexOf('Fix now (Critical)');
    const highPos = out.indexOf('Fix soon (High)');
    const lowPos = out.indexOf('Low risk (Low)');
    expect(critPos).toBeGreaterThanOrEqual(0);
    expect(highPos).toBeGreaterThanOrEqual(0);
    expect(lowPos).toBeGreaterThanOrEqual(0);
    expect(critPos).toBeLessThan(highPos);
    expect(highPos).toBeLessThan(lowPos);
  });

  it('is deterministic regardless of input finding order', () => {
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
    const out1 = toMarkdown(makeReport([f1, f2]));
    const out2 = toMarkdown(makeReport([f2, f1]));
    expect(out1).toBe(out2);
  });
});

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

describe('toMarkdown — summary table', () => {
  it('summary section lists severity counts', () => {
    const fp1 = makeFingerprint('summ001');
    const fp2 = makeFingerprint('summ002');
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
    const out = toMarkdown(makeReport([f1, f2]));
    expect(out).toMatch(/Fix now \(Critical\).*1/);
    expect(out).toMatch(/Fix soon \(High\).*1/);
    expect(out).toMatch(/Total.*2/);
  });

  it('suppressed finding count is shown in summary', () => {
    const fp = makeFingerprint('suppcount');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      suppressed: true,
      suppression: { justification: 'known risk', approvedBy: 'alice', expiry: '2099-12-31' },
    });
    const out = toMarkdown(makeReport([f]));
    expect(out).toMatch(/Acknowledged risks.*1/);
  });
});

// ---------------------------------------------------------------------------
// Finding detail
// ---------------------------------------------------------------------------

describe('toMarkdown — finding detail', () => {
  it('renders the finding id and ruleId in the heading', () => {
    const fp = makeFingerprint('detail001');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('BS-SQL-001');
    expect(out).toContain(`f-${fp.slice(0, 16)}`);
  });

  it('renders the full fingerprint in finding detail', () => {
    const fp = makeFingerprint('detail002');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain(fp);
  });

  it('renders "In the code" for static findings', () => {
    const fp = makeFingerprint('surfstatic');
    const f = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('In the code');
  });

  it('renders "On the live test site" for live findings', () => {
    const f = makeLiveFinding();
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('On the live test site');
  });

  it('renders plain-language severity labels', () => {
    const fp = makeFingerprint('sev001');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
    });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('Fix now (Critical)');
  });

  it('renders suppression justification for suppressed findings', () => {
    const fp = makeFingerprint('supprender');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      suppressed: true,
      suppression: {
        justification: 'accepted for Q3 sprint',
        approvedBy: 'charlie',
        expiry: '2099-09-30',
      },
    });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('accepted for Q3 sprint');
    expect(out).toContain('charlie');
  });

  it('renders expired baseline note', () => {
    const fp = makeFingerprint('expired01');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      suppressed: false,
      suppression: null,
      note: 'baseline expired 2026-01-01',
    });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('baseline expired 2026-01-01');
  });

  it('renders evidence snippet in a code block', () => {
    const fp = makeFingerprint('snippet01');
    const f = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      evidence: { snippet: 'db.query(userId)', cvss: null, raw: {} },
    });
    const out = toMarkdown(makeReport([f]));
    expect(out).toContain('db.query(userId)');
  });

  it('renders no findings message when findings list is empty', () => {
    const out = toMarkdown(makeReport([]));
    expect(out).toContain('No findings.');
  });
});

// ---------------------------------------------------------------------------
// Run metadata
// ---------------------------------------------------------------------------

describe('toMarkdown — run metadata', () => {
  it('includes runId in the header', () => {
    const out = toMarkdown(makeReport([]));
    expect(out).toContain('2026-06-12T03-00-00Z-abcd');
  });

  it('includes run status in the header', () => {
    const out = toMarkdown(makeReport([], { status: 'partial' }));
    expect(out).toContain('partial');
  });

  it('renders failures section when failures are present', () => {
    const out = toMarkdown(
      makeReport([], {
        status: 'partial',
        failures: [{ target: 'repo-a', family: 'zap', reason: 'timeout after 900s' }],
      }),
    );
    expect(out).toContain('Failures');
    expect(out).toContain('timeout after 900s');
  });

  it('renders scanner status table when scanner status entries are present', () => {
    const out = toMarkdown(
      makeReport([], {
        scannerStatus: [{ target: 'repo-a', family: 'ast', state: 'complete' }],
      }),
    );
    expect(out).toContain('Scanner status');
    expect(out).toContain('complete');
  });
});

// ---------------------------------------------------------------------------
// Redaction pass — no raw secret leakage (§5.4 / §10 guardrail)
// ---------------------------------------------------------------------------

describe('toMarkdown — redaction pass', () => {
  it('credential material in evidence.raw.secret does not appear in Markdown output', () => {
    const fp = makeFingerprint('mdredact1');
    const rawSecret = 'super-secret-token-markdown-abc';
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
    const out = toMarkdown(makeReport([f]));
    expect(out).not.toContain(rawSecret);
  });

  it('Authorization header value in evidence.raw is replaced with a redacted placeholder in Markdown', () => {
    const fp = makeFingerprint('mdredact2');
    const rawToken = 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-part.sig';
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
    const out = toMarkdown(makeReport([f]));
    expect(out).not.toContain(rawToken);
  });
});
