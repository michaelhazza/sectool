import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildReport, sortFindings, writeReport, type BuildReportInput } from './json.js';
import type { Finding } from '../schemas/finding.js';
import type { RunMeta, RunTarget } from '../schemas/report.js';
import type { Baseline } from '../schemas/baseline.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeFingerprint(seed: string): string {
  // Produce a deterministic 64-hex string from a short seed for test use
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
    location: { path: 'src/index.ts', symbol: 'GET /api/users/:id' },
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

function makeBaseline(): Baseline {
  return { entries: [] };
}

function makeTarget(name: string): RunTarget {
  return { kind: 'repo', name, coverageGaps: [] };
}

function makeBuildInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    runId: '2026-06-12T03-00-00Z-abcd',
    date: '2026-06-12',
    rawFindings: [],
    scannerStatus: [],
    targets: [makeTarget('repo-a')],
    meta: makeMeta(),
    baseline: makeBaseline(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortFindings — deterministic total order
// ---------------------------------------------------------------------------

describe('sortFindings — §8.1 total order', () => {
  it('sorts by severity desc', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const low = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, severity: 'low', baseSeverity: 'low' });
    const high = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}`, severity: 'high', baseSeverity: 'high' });
    const sorted = sortFindings([low, high]);
    expect(sorted[0]?.severity).toBe('high');
    expect(sorted[1]?.severity).toBe('low');
  });

  it('sorts by confidence desc when severity is equal', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const tentative = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, confidence: 'tentative' });
    const confirmed = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}`, confidence: 'confirmed' });
    const sorted = sortFindings([tentative, confirmed]);
    expect(sorted[0]?.confidence).toBe('confirmed');
    expect(sorted[1]?.confidence).toBe('tentative');
  });

  it('sorts by vulnClass criticality (tenant-isolation before injection)', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const injection = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, vulnClass: 'injection' });
    const tenantIsolation = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}`, vulnClass: 'tenant-isolation' });
    const sorted = sortFindings([injection, tenantIsolation]);
    expect(sorted[0]?.vulnClass).toBe('tenant-isolation');
    expect(sorted[1]?.vulnClass).toBe('injection');
  });

  it('total tiebreaker: same severity/confidence/vulnClass/target — ruleId then fingerprint', () => {
    const fp1 = makeFingerprint('aaaa1111');
    const fp2 = makeFingerprint('bbbb2222');
    const f1 = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, ruleId: 'BS-SQL-001' });
    const f2 = makeStaticFinding({ fingerprint: fp2, id: `f-${fp2.slice(0, 16)}`, ruleId: 'BS-SQL-002' });
    // Both share severity/confidence/vulnClass/target — ruleId asc decides
    const sorted1 = sortFindings([f2, f1]);
    expect(sorted1[0]?.ruleId).toBe('BS-SQL-001');
    expect(sorted1[1]?.ruleId).toBe('BS-SQL-002');

    // Same ruleId too — fingerprint decides
    const fp3 = makeFingerprint('cccc3333');
    const f3 = makeStaticFinding({ fingerprint: fp1, id: `f-${fp1.slice(0, 16)}`, ruleId: 'BS-SQL-001' });
    const f4 = makeStaticFinding({ fingerprint: fp3, id: `f-${fp3.slice(0, 16)}`, ruleId: 'BS-SQL-001' });
    const sorted2 = sortFindings([f4, f3]);
    expect(sorted2[0]?.fingerprint.localeCompare(sorted2[1]?.fingerprint ?? '')).toBeLessThanOrEqual(0);
  });

  it('is deterministic regardless of input order', () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 5; i++) {
      const fp = makeFingerprint(`test${i}1111`);
      findings.push(
        makeStaticFinding({
          fingerprint: fp,
          id: `f-${fp.slice(0, 16)}`,
          ruleId: `BS-SQL-00${i}`,
        }),
      );
    }
    const shuffled = [...findings].reverse();
    const sorted1 = sortFindings(findings);
    const sorted2 = sortFindings(shuffled);
    expect(sorted1.map((f) => f.fingerprint)).toEqual(sorted2.map((f) => f.fingerprint));
  });
});

// ---------------------------------------------------------------------------
// buildReport — derived fields and fixes.json join
// ---------------------------------------------------------------------------

describe('buildReport — derived fields', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'audit-json-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates externalRefs via fingerprint join to fixes.json (read-only)', () => {
    const fp = makeFingerprint('deadbeef1234');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    const issueUrl = 'https://github.com/org/repo/issues/42';
    writeFileSync(
      fixesPath,
      JSON.stringify({
        [fp]: {
          fingerprint: fp,
          ruleId: finding.ruleId,
          status: 'requested',
          issueUrl,
        },
      }),
      'utf8',
    );

    const fixesMtimeBefore = statSync(fixesPath).mtimeMs;

    const report = buildReport(
      makeBuildInput({ rawFindings: [finding], fixesPath }),
    );

    // externalRefs must be populated from fixes.json
    const resultFinding = report.findings[0];
    expect(resultFinding?.externalRefs).toContain(issueUrl);

    // fixes.json must NOT have been mutated (byte-identical, same mtime)
    const fixesMtimeAfter = statSync(fixesPath).mtimeMs;
    expect(fixesMtimeAfter).toBe(fixesMtimeBefore);
  });

  it('does NOT mutate fixes.json — bytes are unchanged after buildReport', () => {
    const fp = makeFingerprint('cafebabeface');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    const originalContent = JSON.stringify({
      [fp]: {
        fingerprint: fp,
        ruleId: finding.ruleId,
        status: 'in-progress',
        issueUrl: 'https://github.com/org/repo/issues/7',
      },
    });
    writeFileSync(fixesPath, originalContent, 'utf8');

    buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));

    const afterContent = readFileSync(fixesPath, 'utf8');
    expect(afterContent).toBe(originalContent);
  });

  it('externalRefs is empty when finding is not in fixes.json', () => {
    const fp = makeFingerprint('aabbccdd1234');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));
    expect(report.findings[0]?.externalRefs).toEqual([]);
  });

  it('externalRefs is empty when fixes.json does not exist', () => {
    const fp = makeFingerprint('0011223344aa');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'nonexistent-fixes.json');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));
    expect(report.findings[0]?.externalRefs).toEqual([]);
  });

  it('applies baseline suppression before deriving fields', () => {
    const fp = makeFingerprint('bbbbaaaaeeee');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const baseline: Baseline = {
      entries: [
        {
          fingerprint: fp,
          ruleId: finding.ruleId,
          target: { kind: 'repo', name: 'repo-a' },
          justification: 'accepted risk',
          expiry: '2099-12-31',
          approvedBy: 'alice',
        },
      ],
    };
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], baseline, fixesPath }));
    expect(report.findings[0]?.suppressed).toBe(true);
  });

  it('produces findings in §8.1 sort order (severity desc)', () => {
    const fp1 = makeFingerprint('aaaa0000ffff');
    const fp2 = makeFingerprint('bbbb1111eeee');
    // Use vulnClass that is NOT in the floor set so severity stays 'low'
    const low = makeStaticFinding({
      fingerprint: fp1,
      id: `f-${fp1.slice(0, 16)}`,
      severity: 'low',
      baseSeverity: 'low',
      vulnClass: 'tls',
    });
    const critical = makeStaticFinding({
      fingerprint: fp2,
      id: `f-${fp2.slice(0, 16)}`,
      severity: 'critical',
      baseSeverity: 'critical',
      vulnClass: 'tls',
    });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [low, critical], fixesPath }));
    expect(report.findings[0]?.severity).toBe('critical');
    expect(report.findings[1]?.severity).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// writeReport — atomic write
// ---------------------------------------------------------------------------

describe('writeReport — atomic tmp+rename', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'audit-write-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes report.json under reports/<runId>/ and returns its path', async () => {
    const fp = makeFingerprint('ffffeeeedddd');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));
    const outPath = await writeReport(report, tmpDir);

    expect(outPath).toMatch(/report\.json$/);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as { runId: string };
    expect(written.runId).toBe(report.runId);
  });

  it('is idempotent — re-writing the same report overwrites deterministically', async () => {
    const fp = makeFingerprint('11112222cccc');
    const finding = makeStaticFinding({ fingerprint: fp, id: `f-${fp.slice(0, 16)}` });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));

    const path1 = await writeReport(report, tmpDir);
    const path2 = await writeReport(report, tmpDir);
    expect(path1).toBe(path2);

    const content1 = readFileSync(path1, 'utf8');
    const content2 = readFileSync(path2, 'utf8');
    expect(content1).toBe(content2);
  });
});

// ---------------------------------------------------------------------------
// Redaction pass
// ---------------------------------------------------------------------------

describe('buildReport — redaction pass (§5.4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'audit-redact-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redacts credential-key fields (evidence.raw.secret) in the report', () => {
    const fp = makeFingerprint('secretseed00');
    const rawSecretValue = 'super-secret-token-abc123';
    const finding = makeStaticFinding({
      fingerprint: fp,
      id: `f-${fp.slice(0, 16)}`,
      vulnClass: 'secrets',
      source: 'gitleaks',
      evidence: {
        snippet: 'const apiKey = "PLACEHOLDER"',
        cvss: null,
        // The 'secret' key is a known credential key in redaction.ts
        raw: { secret: rawSecretValue },
      },
    });
    const fixesPath = resolve(tmpDir, 'fixes.json');
    writeFileSync(fixesPath, '{}', 'utf8');

    const report = buildReport(makeBuildInput({ rawFindings: [finding], fixesPath }));
    const serialized = JSON.stringify(report);

    // The raw secret value in the 'secret' key must NOT appear unredacted
    expect(serialized).not.toContain(rawSecretValue);
    // A redaction placeholder must be present instead
    expect(serialized).toMatch(/\[redacted:[0-9a-f]{8}\]/);
  });
});
