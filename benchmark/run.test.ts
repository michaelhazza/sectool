import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CANONICAL_CHECK_IDS,
  computeRuleMetrics,
  aggregateResults,
  runBenchmark,
  walkStaticCorpus,
  checkLiveFixture,
  type ExpectedFinding,
  type RuleResult,
} from './run.js';

// ---------------------------------------------------------------------------
// CANONICAL_CHECK_IDS contract
// ---------------------------------------------------------------------------

describe('CANONICAL_CHECK_IDS', () => {
  it('contains all 11 custom rules', () => {
    const customRules = [
      'BS-RLS-001', 'BS-SQL-001', 'BS-SQL-002', 'BS-AUTH-001', 'BS-AUTH-002',
      'BS-JWT-001', 'BS-UPLOAD-001', 'BS-XSS-001', 'BS-CORS-001', 'BS-WS-001',
      'BS-VAL-001',
    ];
    for (const id of customRules) {
      expect(CANONICAL_CHECK_IDS).toContain(id);
    }
  });

  it('contains the 3 wrapped scanner families', () => {
    expect(CANONICAL_CHECK_IDS).toContain('semgrep');
    expect(CANONICAL_CHECK_IDS).toContain('gitleaks');
    expect(CANONICAL_CHECK_IDS).toContain('osv');
  });

  it('contains the enumerated LIVE-* check ids', () => {
    const liveIds = [
      'LIVE-TLS-001', 'LIVE-HDR-001', 'LIVE-COOKIE-001', 'LIVE-EXPOSE-001',
      'LIVE-LEAK-001', 'LIVE-IDOR-001', 'LIVE-SESSION-001',
    ];
    for (const id of liveIds) {
      expect(CANONICAL_CHECK_IDS).toContain(id);
    }
  });

  it('contains the 3 wildcard families at family granularity', () => {
    expect(CANONICAL_CHECK_IDS).toContain('ZAP-P-*');
    expect(CANONICAL_CHECK_IDS).toContain('ZAP-A-*');
    expect(CANONICAL_CHECK_IDS).toContain('NUCLEI-*');
  });

  it('has exactly 24 entries (11 custom + 3 wrapped + 7 live + 3 wildcard)', () => {
    expect(CANONICAL_CHECK_IDS).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------
// computeRuleMetrics — pure accounting math
// ---------------------------------------------------------------------------

describe('computeRuleMetrics', () => {
  it('100% recall + 100% precision when actual matches expected exactly', () => {
    const expected: ExpectedFinding[] = [{ ruleId: 'BS-SQL-001', vulnClass: 'injection' }];
    const actual = [{ ruleId: 'BS-SQL-001' }];
    const result = computeRuleMetrics('BS-SQL-001', expected, actual);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(0);
    expect(result.misses).toBe(0);
  });

  it('recall = 0 when expected finding is not in actual (miss)', () => {
    const expected: ExpectedFinding[] = [{ ruleId: 'BS-SQL-001' }];
    const actual: { ruleId: string }[] = [];
    const result = computeRuleMetrics('BS-SQL-001', expected, actual);
    expect(result.recall).toBe(0);
    expect(result.precision).toBe(1); // no actual findings → precision trivially 1
    expect(result.misses).toBe(1);
    expect(result.truePositives).toBe(0);
  });

  it('precision = 0 when actual finding has no expected counterpart (false positive)', () => {
    const expected: ExpectedFinding[] = [];
    const actual = [{ ruleId: 'BS-SQL-001' }];
    const result = computeRuleMetrics('BS-SQL-001', expected, actual);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(1); // no expected → recall trivially 1
    expect(result.falsePositives).toBe(1);
    expect(result.truePositives).toBe(0);
  });

  it('partial recall: 1 of 2 expected findings detected', () => {
    const expected: ExpectedFinding[] = [
      { ruleId: 'BS-SQL-001' },
      { ruleId: 'BS-SQL-001' },
    ];
    const actual = [{ ruleId: 'BS-SQL-001' }];
    const result = computeRuleMetrics('BS-SQL-001', expected, actual);
    expect(result.recall).toBe(0.5);
    expect(result.truePositives).toBe(1);
    expect(result.misses).toBe(1);
  });

  it('ignores findings for other rule ids', () => {
    const expected: ExpectedFinding[] = [{ ruleId: 'BS-SQL-001' }];
    const actual = [{ ruleId: 'BS-AUTH-001' }, { ruleId: 'BS-SQL-001' }];
    const result = computeRuleMetrics('BS-SQL-001', expected, actual);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(0);
    expect(result.actualCount).toBe(1);
  });

  it('empty expected and empty actual → recall=1 precision=1', () => {
    const result = computeRuleMetrics('BS-RLS-001', [], []);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// aggregateResults — aggregate over multiple rule results
// ---------------------------------------------------------------------------

describe('aggregateResults', () => {
  it('sums counts across rules correctly', () => {
    const rules: RuleResult[] = [
      {
        ruleId: 'A', expectedCount: 2, actualCount: 2,
        truePositives: 2, falsePositives: 0, misses: 0, recall: 1, precision: 1,
      },
      {
        ruleId: 'B', expectedCount: 1, actualCount: 2,
        truePositives: 1, falsePositives: 1, misses: 0, recall: 1, precision: 0.5,
      },
    ];
    const agg = aggregateResults(rules);
    expect(agg.totalExpected).toBe(3);
    expect(agg.totalActual).toBe(4);
    expect(agg.totalTruePositives).toBe(3);
    expect(agg.totalFalsePositives).toBe(1);
    expect(agg.totalMisses).toBe(0);
    expect(agg.recall).toBe(1);
    expect(agg.precision).toBeCloseTo(0.75);
  });

  it('empty rule list → 100% recall, 100% precision', () => {
    const agg = aggregateResults([]);
    expect(agg.recall).toBe(1);
    expect(agg.precision).toBe(1);
    expect(agg.totalExpected).toBe(0);
    expect(agg.totalActual).toBe(0);
  });

  it('aggregate recall reflects misses correctly', () => {
    const rules: RuleResult[] = [
      {
        ruleId: 'A', expectedCount: 2, actualCount: 1,
        truePositives: 1, falsePositives: 0, misses: 1, recall: 0.5, precision: 1,
      },
    ];
    const agg = aggregateResults(rules);
    expect(agg.recall).toBe(0.5);
    expect(agg.totalMisses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// walkStaticCorpus — filesystem-based, using a temp dir
// ---------------------------------------------------------------------------

describe('walkStaticCorpus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `audit-bench-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRuleFixture(ruleId: string, withExpected = true): void {
    const vulnDir = join(tmpDir, ruleId, 'vulnerable');
    const cleanDir = join(tmpDir, ruleId, 'clean');
    mkdirSync(vulnDir, { recursive: true });
    mkdirSync(cleanDir, { recursive: true });
    if (withExpected) {
      writeFileSync(
        join(vulnDir, 'EXPECTED.json'),
        JSON.stringify({ findings: [{ ruleId }] }),
      );
    }
  }

  it('marks a rule complete when both dirs + EXPECTED.json exist', () => {
    makeRuleFixture('BS-SQL-001');
    // Only BS-SQL-001 fixture exists; the rest are missing
    const { complete } = walkStaticCorpus(tmpDir);
    expect(complete).toContain('BS-SQL-001');
  });

  it('marks a rule missing when vulnerable/ dir is absent', () => {
    // Create only clean/ dir
    mkdirSync(join(tmpDir, 'BS-SQL-001', 'clean'), { recursive: true });
    const { missing } = walkStaticCorpus(tmpDir);
    const miss = missing.find((m) => m.ruleId === 'BS-SQL-001');
    expect(miss).toBeDefined();
    expect(miss?.reason).toMatch(/vulnerable/);
  });

  it('marks a rule missing when clean/ dir is absent', () => {
    const vulnDir = join(tmpDir, 'BS-SQL-001', 'vulnerable');
    mkdirSync(vulnDir, { recursive: true });
    writeFileSync(join(vulnDir, 'EXPECTED.json'), JSON.stringify({ findings: [] }));
    const { missing } = walkStaticCorpus(tmpDir);
    const miss = missing.find((m) => m.ruleId === 'BS-SQL-001');
    expect(miss).toBeDefined();
    expect(miss?.reason).toMatch(/clean/);
  });

  it('marks a rule missing when EXPECTED.json is absent in vulnerable/', () => {
    mkdirSync(join(tmpDir, 'BS-SQL-001', 'vulnerable'), { recursive: true });
    mkdirSync(join(tmpDir, 'BS-SQL-001', 'clean'), { recursive: true });
    const { missing } = walkStaticCorpus(tmpDir);
    const miss = missing.find((m) => m.ruleId === 'BS-SQL-001');
    expect(miss).toBeDefined();
    expect(miss?.reason).toMatch(/EXPECTED\.json/);
  });

  it('all 14 static ids missing when corpus dir is empty', () => {
    const { missing } = walkStaticCorpus(tmpDir);
    // 11 custom rules + 3 wrapped scanner families = 14
    expect(missing.length).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// checkLiveFixture
// ---------------------------------------------------------------------------

describe('checkLiveFixture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `audit-bench-live-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns fixtureExists=false when live-fixture dir has no EXPECTED.json', () => {
    const { fixtureExists, missingIds } = checkLiveFixture(tmpDir);
    expect(fixtureExists).toBe(false);
    expect(missingIds.length).toBeGreaterThan(0);
  });

  it('returns missingIds for all live ids when EXPECTED.json exists but has empty checks', () => {
    writeFileSync(join(tmpDir, 'EXPECTED.json'), JSON.stringify({ checks: [] }));
    const { fixtureExists, missingIds } = checkLiveFixture(tmpDir);
    expect(fixtureExists).toBe(true);
    expect(missingIds).toContain('LIVE-TLS-001');
    expect(missingIds).toContain('ZAP-P-*');
    expect(missingIds).toContain('NUCLEI-*');
  });

  it('returns no missing ids when all live checks are present', () => {
    const allLiveIds = [
      'LIVE-TLS-001', 'LIVE-HDR-001', 'LIVE-COOKIE-001', 'LIVE-EXPOSE-001',
      'LIVE-LEAK-001', 'LIVE-IDOR-001', 'LIVE-SESSION-001',
      'ZAP-P-*', 'ZAP-A-*', 'NUCLEI-*',
    ];
    writeFileSync(join(tmpDir, 'EXPECTED.json'), JSON.stringify({ checks: allLiveIds }));
    const { fixtureExists, missingIds } = checkLiveFixture(tmpDir);
    expect(fixtureExists).toBe(true);
    expect(missingIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runBenchmark — integration: cross-check + accounting
// ---------------------------------------------------------------------------

describe('runBenchmark', () => {
  let tmpCorpusDir: string;
  let tmpLiveDir: string;

  beforeEach(() => {
    const base = join(tmpdir(), `audit-bench-run-test-${Date.now()}`);
    tmpCorpusDir = join(base, 'corpus', 'static');
    tmpLiveDir = join(base, 'live-fixture');
    mkdirSync(tmpCorpusDir, { recursive: true });
    mkdirSync(tmpLiveDir, { recursive: true });
  });

  afterEach(() => {
    const base = join(tmpCorpusDir, '..', '..');
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true });
    }
  });

  function makeStaticFixture(ruleId: string, expectedFindings: ExpectedFinding[]): void {
    const vulnDir = join(tmpCorpusDir, ruleId, 'vulnerable');
    const cleanDir = join(tmpCorpusDir, ruleId, 'clean');
    mkdirSync(vulnDir, { recursive: true });
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(
      join(vulnDir, 'EXPECTED.json'),
      JSON.stringify({ findings: expectedFindings }),
    );
  }

  function makeAllStaticFixtures(): void {
    const ids = [
      'BS-RLS-001', 'BS-SQL-001', 'BS-SQL-002', 'BS-AUTH-001', 'BS-AUTH-002',
      'BS-JWT-001', 'BS-UPLOAD-001', 'BS-XSS-001', 'BS-CORS-001', 'BS-WS-001',
      'BS-VAL-001', 'semgrep', 'gitleaks', 'osv',
    ];
    for (const id of ids) {
      makeStaticFixture(id, [{ ruleId: id }]);
    }
  }

  function makeAllLiveFixtures(): void {
    const allLiveIds = [
      'LIVE-TLS-001', 'LIVE-HDR-001', 'LIVE-COOKIE-001', 'LIVE-EXPOSE-001',
      'LIVE-LEAK-001', 'LIVE-IDOR-001', 'LIVE-SESSION-001',
      'ZAP-P-*', 'ZAP-A-*', 'NUCLEI-*',
    ];
    writeFileSync(
      join(tmpLiveDir, 'EXPECTED.json'),
      JSON.stringify({ checks: allLiveIds }),
    );
  }

  it('passed=false and missingFixtures non-empty when static corpus is empty', () => {
    const result = runBenchmark([], tmpCorpusDir, tmpLiveDir);
    expect(result.passed).toBe(false);
    expect(result.missingFixtures.length).toBeGreaterThan(0);
  });

  it('passed=false when live fixture is missing', () => {
    makeAllStaticFixtures();
    // no live fixture
    const result = runBenchmark([], tmpCorpusDir, tmpLiveDir);
    expect(result.passed).toBe(false);
    expect(result.missingFixtures.some((m) => m.includes('live-fixture'))).toBe(true);
  });

  it('passed=false when recall < 100% (expected finding not produced)', () => {
    makeAllStaticFixtures();
    makeAllLiveFixtures();
    // No actual scan results → misses on expected findings
    const result = runBenchmark([], tmpCorpusDir, tmpLiveDir);
    // All rules have expected findings but no actuals → recall = 0
    expect(result.passed).toBe(false);
    expect(result.aggregate.recall).toBeLessThan(1);
    expect(result.aggregate.totalMisses).toBeGreaterThan(0);
  });

  it('passed=true when all fixtures present and 100% recall + 0 FP', () => {
    makeAllStaticFixtures();
    makeAllLiveFixtures();
    // Provide scan results matching all expected findings for all 14 static ids
    const ids = [
      'BS-RLS-001', 'BS-SQL-001', 'BS-SQL-002', 'BS-AUTH-001', 'BS-AUTH-002',
      'BS-JWT-001', 'BS-UPLOAD-001', 'BS-XSS-001', 'BS-CORS-001', 'BS-WS-001',
      'BS-VAL-001', 'semgrep', 'gitleaks', 'osv',
    ];
    const scanResults = ids.map((id) => ({ ruleId: id }));
    const result = runBenchmark(scanResults, tmpCorpusDir, tmpLiveDir);
    expect(result.passed).toBe(true);
    expect(result.aggregate.recall).toBe(1);
    expect(result.aggregate.totalFalsePositives).toBe(0);
    expect(result.missingFixtures).toHaveLength(0);
  });

  it('passed=false when a false positive is emitted on a complete corpus', () => {
    makeAllStaticFixtures();
    makeAllLiveFixtures();
    // All correct findings + one extra unexpected finding
    const ids = [
      'BS-RLS-001', 'BS-SQL-001', 'BS-SQL-002', 'BS-AUTH-001', 'BS-AUTH-002',
      'BS-JWT-001', 'BS-UPLOAD-001', 'BS-XSS-001', 'BS-CORS-001', 'BS-WS-001',
      'BS-VAL-001', 'semgrep', 'gitleaks', 'osv',
    ];
    const scanResults = [
      ...ids.map((id) => ({ ruleId: id })),
      { ruleId: 'BS-SQL-001' }, // extra unexpected finding = FP
    ];
    const result = runBenchmark(scanResults, tmpCorpusDir, tmpLiveDir);
    expect(result.passed).toBe(false);
    expect(result.aggregate.totalFalsePositives).toBeGreaterThan(0);
  });

  it('missingFixtures lists each static id without both fixtures', () => {
    // Only create BS-SQL-001; all others missing
    makeStaticFixture('BS-SQL-001', [{ ruleId: 'BS-SQL-001' }]);
    makeAllLiveFixtures();
    const result = runBenchmark([], tmpCorpusDir, tmpLiveDir);
    // 13 of 14 static ids missing
    expect(result.missingFixtures).toContain('BS-RLS-001');
    expect(result.missingFixtures).not.toContain('BS-SQL-001');
  });
});
