/**
 * benchmark/run.ts — minimal benchmark harness (P1-5)
 *
 * Exports CANONICAL_CHECK_IDS (the authoritative stable id list) and
 * runBenchmark() (the `npm run benchmark` entry). P6-1 extends this with
 * live-fixture integration and real scanner invocations.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const CORPUS_STATIC_DIR = join(_moduleDir, 'corpus', 'static');
const LIVE_FIXTURE_DIR = join(_moduleDir, 'live-fixture');

// ---------------------------------------------------------------------------
// Canonical check-id inventory (MEDIUM-2) — single source of truth.
// P6-1 corpus cross-check and P6-3 docs-completeness check both import this.
// ---------------------------------------------------------------------------

/** 11 custom AST/Semgrep rules (§7.1). */
const CUSTOM_RULES = [
  'BS-RLS-001',
  'BS-SQL-001',
  'BS-SQL-002',
  'BS-AUTH-001',
  'BS-AUTH-002',
  'BS-JWT-001',
  'BS-UPLOAD-001',
  'BS-XSS-001',
  'BS-CORS-001',
  'BS-WS-001',
  'BS-VAL-001',
] as const;

/** 3 wrapped static scanner families (§7.2). Corpus dirs use the family name. */
const WRAPPED_SCANNER_FAMILIES = ['semgrep', 'gitleaks', 'osv'] as const;

/** Enumerated live check ids (§7.3 direct probes + IDOR/session). */
const LIVE_CHECK_IDS = [
  'LIVE-TLS-001',
  'LIVE-HDR-001',
  'LIVE-COOKIE-001',
  'LIVE-EXPOSE-001',
  'LIVE-LEAK-001',
  'LIVE-IDOR-001',
  'LIVE-SESSION-001',
] as const;

/**
 * Wildcard families at FAMILY granularity (§11 — one doc per family, NOT per
 * upstream template). The literal strings are the family identifiers.
 */
const WILDCARD_FAMILIES = ['ZAP-P-*', 'ZAP-A-*', 'NUCLEI-*'] as const;

/** Complete canonical check-id list. P6-1 and P6-3 import this constant. */
export const CANONICAL_CHECK_IDS: readonly string[] = [
  ...CUSTOM_RULES,
  ...WRAPPED_SCANNER_FAMILIES,
  ...LIVE_CHECK_IDS,
  ...WILDCARD_FAMILIES,
];

// ---------------------------------------------------------------------------
// EXPECTED.json schema (the corpus contract)
// ---------------------------------------------------------------------------

export interface ExpectedFinding {
  /** Must match the rule/check that produces this finding. */
  ruleId: string;
  vulnClass?: string;
  surface?: 'static' | 'live';
  /** Optional human note — ignored by harness. */
  _note?: string;
  _comment?: string;
  _schema?: string;
}

export interface ExpectedJson {
  findings: ExpectedFinding[];
  _comment?: string;
  _schema?: string;
}

// ---------------------------------------------------------------------------
// Accounting types
// ---------------------------------------------------------------------------

export interface RuleResult {
  ruleId: string;
  expectedCount: number;
  /** Actual findings produced by the scanner/rule for this fixture. */
  actualCount: number;
  truePositives: number;
  falsePositives: number;
  /** Expected findings not matched by any actual finding. */
  misses: number;
  recall: number;
  precision: number;
}

export interface BenchmarkResult {
  /** Per-rule recall/precision. */
  byRule: RuleResult[];
  /** Aggregate over all rules. */
  aggregate: {
    totalExpected: number;
    totalActual: number;
    totalTruePositives: number;
    totalFalsePositives: number;
    totalMisses: number;
    recall: number;
    precision: number;
  };
  /** Rules lacking both vulnerable/ and clean/ fixture dirs. */
  missingFixtures: string[];
  /** Whether the overall benchmark passed (100% recall, 0 FP, no missing fixtures). */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Recall/precision accounting (pure — unit-testable without filesystem)
// ---------------------------------------------------------------------------

/**
 * Compute recall/precision for one rule given expected and actual findings.
 *
 * Matching is by ruleId: an actual finding is a true positive iff its ruleId
 * appears in the expected list. This is the minimum-viable matcher; P6-1
 * refines to richer evidence-level matching.
 */
export function computeRuleMetrics(
  ruleId: string,
  expected: readonly ExpectedFinding[],
  actual: readonly { ruleId: string }[],
): RuleResult {
  const actualForRule = actual.filter((f) => f.ruleId === ruleId);
  const expectedForRule = expected.filter((e) => e.ruleId === ruleId);

  const truePositives = Math.min(actualForRule.length, expectedForRule.length);
  const falsePositives = actualForRule.length - truePositives;
  const misses = expectedForRule.length - truePositives;

  const recall = expectedForRule.length === 0 ? 1 : truePositives / expectedForRule.length;
  const precision = actualForRule.length === 0 ? 1 : truePositives / actualForRule.length;

  return {
    ruleId,
    expectedCount: expectedForRule.length,
    actualCount: actualForRule.length,
    truePositives,
    falsePositives,
    misses,
    recall,
    precision,
  };
}

/**
 * Aggregate per-rule results into a single summary.
 */
export function aggregateResults(ruleResults: readonly RuleResult[]): BenchmarkResult['aggregate'] {
  let totalExpected = 0;
  let totalActual = 0;
  let totalTruePositives = 0;
  let totalFalsePositives = 0;
  let totalMisses = 0;

  for (const r of ruleResults) {
    totalExpected += r.expectedCount;
    totalActual += r.actualCount;
    totalTruePositives += r.truePositives;
    totalFalsePositives += r.falsePositives;
    totalMisses += r.misses;
  }

  const recall = totalExpected === 0 ? 1 : totalTruePositives / totalExpected;
  const precision = totalActual === 0 ? 1 : totalTruePositives / totalActual;

  return {
    totalExpected,
    totalActual,
    totalTruePositives,
    totalFalsePositives,
    totalMisses,
    recall,
    precision,
  };
}

// ---------------------------------------------------------------------------
// Static IDs: the ones that need corpus/static/<id>/{vulnerable,clean}/ dirs
// ---------------------------------------------------------------------------

/** Ids that require static corpus directories (not live-fixture). */
const STATIC_CORPUS_IDS: readonly string[] = [...CUSTOM_RULES, ...WRAPPED_SCANNER_FAMILIES];

/** Live ids (require live-fixture/EXPECTED.json entries). */
const LIVE_IDS: readonly string[] = [...LIVE_CHECK_IDS, ...WILDCARD_FAMILIES];

// ---------------------------------------------------------------------------
// Corpus directory walker
// ---------------------------------------------------------------------------

/**
 * Walk corpus/static/ and return the set of rule ids that have BOTH a
 * vulnerable/ directory (with EXPECTED.json) AND a clean/ directory.
 */
export function walkStaticCorpus(corpusStaticDir: string): {
  complete: string[];
  missing: { ruleId: string; reason: string }[];
} {
  const complete: string[] = [];
  const missing: { ruleId: string; reason: string }[] = [];

  for (const ruleId of STATIC_CORPUS_IDS) {
    const ruleDir = join(corpusStaticDir, ruleId);
    const vulnDir = join(ruleDir, 'vulnerable');
    const cleanDir = join(ruleDir, 'clean');
    const expectedJson = join(vulnDir, 'EXPECTED.json');

    const hasVuln = existsSync(vulnDir);
    const hasClean = existsSync(cleanDir);
    const hasExpected = existsSync(expectedJson);

    if (!hasVuln || !hasClean || !hasExpected) {
      const reasons: string[] = [];
      if (!hasVuln) reasons.push('missing vulnerable/ directory');
      if (!hasClean) reasons.push('missing clean/ directory');
      if (hasVuln && !hasExpected) reasons.push('missing vulnerable/EXPECTED.json');
      missing.push({ ruleId, reason: reasons.join('; ') });
    } else {
      complete.push(ruleId);
    }
  }

  return { complete, missing };
}

/**
 * Check whether the live-fixture EXPECTED.json exists and contains entries for
 * each live check id. Returns missing live check ids.
 */
export function checkLiveFixture(liveFixtureDir: string): {
  fixtureExists: boolean;
  missingIds: string[];
} {
  const expectedPath = join(liveFixtureDir, 'EXPECTED.json');
  if (!existsSync(expectedPath)) {
    return { fixtureExists: false, missingIds: [...LIVE_IDS] };
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(expectedPath, 'utf-8'));
  } catch {
    return { fixtureExists: true, missingIds: [...LIVE_IDS] };
  }

  const dataRecord = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const entries =
    dataRecord !== null &&
    'checks' in dataRecord &&
    Array.isArray(dataRecord['checks'])
      ? (dataRecord['checks'] as string[])
      : [];

  const presentIds = new Set(entries);
  const missingIds = LIVE_IDS.filter((id) => !presentIds.has(id));
  return { fixtureExists: true, missingIds };
}

// ---------------------------------------------------------------------------
// EXPECTED.json reader
// ---------------------------------------------------------------------------

function readExpectedJson(path: string): ExpectedFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  const rawRecord = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (rawRecord === null || !('findings' in rawRecord) || !Array.isArray(rawRecord['findings'])) {
    return [];
  }
  return (raw as ExpectedJson).findings;
}

// ---------------------------------------------------------------------------
// Main runBenchmark entry
// ---------------------------------------------------------------------------

export interface ScanResult {
  ruleId: string;
}

/**
 * Run the benchmark harness.
 *
 * In P1-5 this validates corpus structure and cross-checks the rule inventory
 * against corpus directories. Actual scanner invocations are wired in P6-1.
 *
 * @param scanResults - Actual scan findings (passed by P6-1; empty in P1-5).
 * @param corpusStaticDir - Override for the corpus/static dir (used in tests).
 * @param liveFixtureDir - Override for the live-fixture dir (used in tests).
 */
export function runBenchmark(
  scanResults: readonly ScanResult[] = [],
  corpusStaticDir: string = CORPUS_STATIC_DIR,
  liveFixtureDir: string = LIVE_FIXTURE_DIR,
): BenchmarkResult {
  // Step 1: rule-inventory ↔ corpus cross-check
  const { complete: completeIds, missing: missingStatic } = walkStaticCorpus(corpusStaticDir);
  const { fixtureExists, missingIds: missingLive } = checkLiveFixture(liveFixtureDir);

  const missingFixtures: string[] = [
    ...missingStatic.map(({ ruleId }) => ruleId),
    ...(!fixtureExists ? ['live-fixture/EXPECTED.json (not yet created — P4-7)'] : []),
    ...missingLive.map((id) => `${id} (not in live-fixture/EXPECTED.json)`),
  ];

  // Step 2: per-rule recall/precision over static corpus
  const byRule: RuleResult[] = [];

  for (const ruleId of completeIds) {
    const vulnExpectedPath = join(corpusStaticDir, ruleId, 'vulnerable', 'EXPECTED.json');
    const expected = readExpectedJson(vulnExpectedPath);
    const metrics = computeRuleMetrics(ruleId, expected, scanResults);
    byRule.push(metrics);

    // Clean fixture must yield zero findings (precision check for the rule)
    const cleanActual = scanResults.filter(
      (f) =>
        f.ruleId === ruleId &&
        // P6-1 provides target info; in P1-5 all results are treated as from
        // the vulnerable fixture. This guard is a placeholder for P6-1.
        false,
    );
    if (cleanActual.length > 0) {
      byRule.push({
        ruleId: `${ruleId} (clean fixture)`,
        expectedCount: 0,
        actualCount: cleanActual.length,
        truePositives: 0,
        falsePositives: cleanActual.length,
        misses: 0,
        recall: 1,
        precision: 0,
      });
    }
  }

  const aggregate = aggregateResults(byRule);
  const passed =
    missingFixtures.length === 0 &&
    aggregate.recall === 1 &&
    aggregate.totalFalsePositives === 0;

  return { byRule, aggregate, missingFixtures, passed };
}

// ---------------------------------------------------------------------------
// Walk existing static corpus directories (used by P6-1 to discover rules)
// ---------------------------------------------------------------------------

/**
 * List all rule ids in corpus/static/ that have a readable EXPECTED.json
 * in their vulnerable/ subdirectory.
 */
export function listCorpusRules(corpusStaticDir: string = CORPUS_STATIC_DIR): string[] {
  if (!existsSync(corpusStaticDir)) return [];
  const entries = readdirSync(corpusStaticDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) =>
      existsSync(join(corpusStaticDir, name, 'vulnerable', 'EXPECTED.json')),
    );
}

// ---------------------------------------------------------------------------
// CLI entry — `npm run benchmark` calls this
// ---------------------------------------------------------------------------

function main(): void {
  const result = runBenchmark();

  if (result.missingFixtures.length > 0) {
    console.error('BENCHMARK FAIL — missing fixtures for the following rule/check ids:');
    for (const id of result.missingFixtures) {
      console.error(`  missing: ${id}`);
    }
  }

  const { aggregate } = result;

  if (aggregate.recall < 1) {
    console.error(
      `BENCHMARK FAIL — recall ${(aggregate.recall * 100).toFixed(1)}% (target 100%)`,
    );
    const misses = result.byRule.filter((r) => r.misses > 0);
    for (const r of misses) {
      console.error(`  miss: ${r.ruleId} (expected ${r.expectedCount}, got ${r.actualCount})`);
    }
  }

  if (aggregate.totalFalsePositives > 0) {
    console.error(
      `BENCHMARK FAIL — ${aggregate.totalFalsePositives} false positive(s) (target 0)`,
    );
    const fps = result.byRule.filter((r) => r.falsePositives > 0);
    for (const r of fps) {
      console.error(`  fp: ${r.ruleId} (${r.falsePositives} unexpected finding(s))`);
    }
  }

  if (result.passed) {
    console.log('BENCHMARK PASS — 100% recall, 0 false positives');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  main();
}
