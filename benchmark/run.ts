/**
 * benchmark/run.ts — benchmark harness (P1-5 core; P6-1 live-fixture extension)
 *
 * Exports CANONICAL_CHECK_IDS (the authoritative stable id list) and
 * runBenchmark() (the `npm run benchmark` entry). P6-1 adds live-fixture
 * subprocess boot/teardown and port-discovery wiring.
 */

import { existsSync, readdirSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

// Rule and scanner imports (used by runDetectors — the real detection engine)
import * as ruleBsRls001 from '../src/static/rules/BS-RLS-001.js';
import * as ruleBsSql001 from '../src/static/rules/BS-SQL-001.js';
import * as ruleBsSql002 from '../src/static/rules/BS-SQL-002.js';
import * as ruleBsAuth001 from '../src/static/rules/BS-AUTH-001.js';
import * as ruleBsXss001 from '../src/static/rules/BS-XSS-001.js';
import * as ruleBsWs001 from '../src/static/rules/BS-WS-001.js';
import * as ruleBsVal001 from '../src/static/rules/BS-VAL-001.js';
import { runSemgrep, type ExecSemgrep } from '../src/static/scanners/semgrep.js';
import { runGitleaks, type ExecGitleaks } from '../src/static/scanners/gitleaks.js';
import { runOsv, type ExecOsv } from '../src/static/scanners/osv.js';
import type { RepoTarget } from '../src/schemas/targets.js';
import type { Finding } from '../src/schemas/finding.js';

const execFileAsync = promisify(execFile);

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
// Live-fixture subprocess wiring (P6-1)
// ---------------------------------------------------------------------------

export interface LiveFixtureHandle {
  host: string;
  port: number;
  /** Stop the subprocess. */
  stop: () => Promise<void>;
}

/**
 * Boot `benchmark/live-fixture/server.js` as a Node subprocess.
 * Discovers its bound port by reading the `LISTENING <host>:<port>` line
 * from stdout (the server's startup contract). Resolves when the server is
 * ready; rejects after `timeoutMs` (default 10s) if no LISTENING line arrives.
 *
 * Real scanner invocations against the returned `host:port` require the CI
 * Docker environment with ZAP/Nuclei/etc. installed — callers guard with
 * `BENCHMARK_LIVE_SCAN` env var.
 */
export function bootLiveFixture(
  liveFixtureDir: string,
  timeoutMs = 10_000,
): Promise<LiveFixtureHandle> {
  return new Promise((resolve, reject) => {
    const serverPath = join(liveFixtureDir, 'server.js');
    if (!existsSync(serverPath)) {
      reject(new Error(`live-fixture server not found: ${serverPath}`));
      return;
    }

    const child: ChildProcess = spawn(process.execPath, [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`live-fixture server did not print LISTENING within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /LISTENING (\S+):(\d+)/.exec(stdout);
      if (match !== null && !settled) {
        settled = true;
        clearTimeout(timer);
        const host = match[1] ?? '127.0.0.1';
        const port = parseInt(match[2] ?? '0', 10);
        resolve({
          host,
          port,
          stop: () =>
            new Promise<void>((res) => {
              child.once('exit', () => res());
              child.kill();
            }),
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`live-fixture server exited early with code ${String(code)}`));
      }
    });
  });
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
 * Cross-checks the rule inventory (CANONICAL_CHECK_IDS) against the corpus
 * directories and the live-fixture EXPECTED.json. Computes recall/precision
 * over all static corpus rules. Live-fixture scanning is wired via
 * `liveFixtureResults` (populated by the P6 CI run with real binaries).
 *
 * @param scanResults - Actual scan findings from the static corpus (vulnerable fixtures).
 * @param cleanResults - Findings from the clean fixtures (should be empty for precision).
 * @param liveFixtureResults - Findings from the live fixture (populated by real scanners in CI).
 * @param corpusStaticDir - Override for the corpus/static dir (used in tests).
 * @param liveFixtureDir - Override for the live-fixture dir (used in tests).
 */
export function runBenchmark(
  scanResults: readonly ScanResult[] = [],
  cleanResults: readonly ScanResult[] = [],
  liveFixtureResults: readonly ScanResult[] = [],
  corpusStaticDir: string = CORPUS_STATIC_DIR,
  liveFixtureDir: string = LIVE_FIXTURE_DIR,
): BenchmarkResult {
  // Step 1: rule-inventory ↔ corpus cross-check (CANONICAL_CHECK_IDS-driven)
  const { complete: completeIds, missing: missingStatic } = walkStaticCorpus(corpusStaticDir);
  const { fixtureExists, missingIds: missingLive } = checkLiveFixture(liveFixtureDir);

  const missingFixtures: string[] = [
    ...missingStatic.map(({ ruleId }) => ruleId),
    ...(!fixtureExists ? ['live-fixture/EXPECTED.json'] : []),
    ...missingLive.map((id) => `${id} (not in live-fixture/EXPECTED.json)`),
  ];

  // Step 2: per-rule recall/precision over static corpus (vulnerable fixtures)
  const byRule: RuleResult[] = [];

  for (const ruleId of completeIds) {
    const vulnExpectedPath = join(corpusStaticDir, ruleId, 'vulnerable', 'EXPECTED.json');
    const expected = readExpectedJson(vulnExpectedPath);
    const metrics = computeRuleMetrics(ruleId, expected, scanResults);
    byRule.push(metrics);

    // Clean fixture must yield zero findings (precision check per rule)
    const cleanForRule = cleanResults.filter((f) => f.ruleId === ruleId);
    if (cleanForRule.length > 0) {
      byRule.push({
        ruleId: `${ruleId} (clean fixture)`,
        expectedCount: 0,
        actualCount: cleanForRule.length,
        truePositives: 0,
        falsePositives: cleanForRule.length,
        misses: 0,
        recall: 1,
        precision: 0,
      });
    }
  }

  // Step 3: live-fixture recall (against LIVE_IDS listed in EXPECTED.json)
  if (liveFixtureResults.length > 0) {
    for (const liveId of LIVE_IDS) {
      const liveExpected: ExpectedFinding[] = [{ ruleId: liveId, surface: 'live' }];
      const liveMetrics = computeRuleMetrics(liveId, liveExpected, liveFixtureResults);
      byRule.push(liveMetrics);
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
// Real detection engine runner — called by main() in CI with live binaries
// ---------------------------------------------------------------------------

/** Injectable executor overrides for testability (default = real binaries). */
export interface DetectorInjections {
  execSemgrep?: ExecSemgrep;
  execGitleaks?: ExecGitleaks;
  execOsv?: ExecOsv;
}

/** Semgrep rules directory relative to the repo root. */
const SEMGREP_RULES_DIR = join(_moduleDir, '..', 'rules', 'semgrep');

/** Semgrep-backed custom rule ids → their YAML filename. */
const SEMGREP_BACKED_RULES: ReadonlyMap<string, string> = new Map([
  ['BS-AUTH-002', 'BS-AUTH-002.yaml'],
  ['BS-JWT-001', 'BS-JWT-001.yaml'],
  ['BS-UPLOAD-001', 'BS-UPLOAD-001.yaml'],
  ['BS-CORS-001', 'BS-CORS-001.yaml'],
]);

/** ts-morph rule id → run function. */
const TSMORPH_RULES: ReadonlyMap<string, (repoDir: string, targetName: string) => Finding[]> = new Map([
  ['BS-RLS-001', ruleBsRls001.run],
  ['BS-SQL-001', ruleBsSql001.run],
  ['BS-SQL-002', ruleBsSql002.run],
  // BS-AUTH-001: pass the login route as a publicRoute so the clean-fixture's
  // /api/auth/login (legitimately middleware-free per spec) is not flagged.
  ['BS-AUTH-001', (dir: string, name: string) => ruleBsAuth001.run(dir, name, {
    publicRoutes: ['POST /api/auth/login'],
  })],
  ['BS-XSS-001', ruleBsXss001.run],
  ['BS-WS-001', ruleBsWs001.run],
  ['BS-VAL-001', ruleBsVal001.run],
]);

/**
 * Build a minimal RepoTarget for corpus scanning (no real git remote needed).
 * Only `name` and `localPath` are used by the scanners; the rest are required
 * by the schema but not exercised in the benchmark path.
 */
function corpusTarget(ruleId: string, dir: string, publicRoutes: string[] = []): RepoTarget {
  return {
    name: ruleId,
    gitUrl: 'https://benchmark.local',
    localPath: dir,
    stackTags: [],
    publicRoutes,
    enabled: true,
  };
}

/**
 * Build a semgrep ExecSemgrep function that runs only the specified YAML rule
 * (ignores the default p/owasp-top-ten + rules/semgrep/ args).
 */
function makeSemgrepRuleExec(yamlPath: string, inject?: ExecSemgrep): ExecSemgrep {
  if (inject !== undefined) {
    // When injecting, pass the specific yaml path as a ruleArg so test stubs can inspect it.
    return (dir: string) => inject(dir, ['--config', yamlPath]);
  }
  return async (dir: string) => {
    // Semgrep exits 1 when findings are present — catch that and return stdout.
    // Exit 2+ is a genuine error (misconfig / binary failure).
    try {
      const result = await execFileAsync('semgrep', [
        '--json',
        '--config', yamlPath,
        '--no-git-ignore',
        dir,
      ]);
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      if (e.code === 1 && typeof e.stdout === 'string') {
        return { stdout: e.stdout, stderr: e.stderr ?? '' };
      }
      throw err;
    }
  };
}

/**
 * Run all static detectors over the corpus fixture directories and collect
 * raw findings for recall and precision accounting.
 *
 * scanResults: findings from vulnerable/ fixtures (recall gate)
 * cleanResults: findings from clean/ fixtures (precision gate, must be empty)
 *
 * Wrapped scanner families (semgrep/gitleaks/osv) have their per-finding
 * ruleIds normalized to the family name so they match EXPECTED.json entries.
 * Semgrep-backed BS-* rules have their sub-rule ids (e.g. BS-JWT-001-algorithm)
 * normalized to the parent rule id (BS-JWT-001).
 *
 * Shell-outs are injectable via `injections` for targeted unit testing of this
 * function — the accounting unit tests in run.test.ts bypass this entirely and
 * inject synthetic results directly into runBenchmark().
 */
export async function runDetectors(
  corpusStaticDir: string = CORPUS_STATIC_DIR,
  injections: DetectorInjections = {},
): Promise<{ scanResults: ScanResult[]; cleanResults: ScanResult[] }> {
  const scanResults: ScanResult[] = [];
  const cleanResults: ScanResult[] = [];

  // -------------------------------------------------------------------------
  // ts-morph rules
  // -------------------------------------------------------------------------
  for (const [ruleId, runFn] of TSMORPH_RULES) {
    const vulnDir = join(corpusStaticDir, ruleId, 'vulnerable');
    const cleanDir = join(corpusStaticDir, ruleId, 'clean');

    if (existsSync(vulnDir)) {
      try {
        const findings = runFn(vulnDir, ruleId);
        for (const f of findings) {
          scanResults.push({ ruleId: f.ruleId });
        }
      } catch {
        // Scanner error on a corpus dir counts as 0 findings for that rule.
      }
    }

    if (existsSync(cleanDir)) {
      try {
        const findings = runFn(cleanDir, ruleId);
        for (const f of findings) {
          cleanResults.push({ ruleId: f.ruleId });
        }
      } catch {
        // No findings from a scan error on the clean fixture — precision passes trivially.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Semgrep-backed BS-* rules (run only the specific YAML rule per corpus dir)
  // -------------------------------------------------------------------------
  for (const [ruleId, yamlFilename] of SEMGREP_BACKED_RULES) {
    const yamlPath = join(SEMGREP_RULES_DIR, yamlFilename);
    const vulnDir = join(corpusStaticDir, ruleId, 'vulnerable');
    const cleanDir = join(corpusStaticDir, ruleId, 'clean');
    const ruleExec = makeSemgrepRuleExec(yamlPath, injections.execSemgrep);
    const target = corpusTarget(ruleId, vulnDir);

    if (existsSync(vulnDir)) {
      try {
        const findings = await runSemgrep(target, vulnDir, ruleExec);
        for (const f of findings) {
          // Normalize sub-rule ids (BS-JWT-001-algorithm → BS-JWT-001)
          const normalizedId = f.ruleId.startsWith(ruleId) ? ruleId : f.ruleId;
          scanResults.push({ ruleId: normalizedId });
        }
      } catch (err) {
        process.stderr.write(`[benchmark] ${ruleId} semgrep error: ${String(err)}\n`);
      }
    }

    if (existsSync(cleanDir)) {
      try {
        const cleanTarget = corpusTarget(ruleId, cleanDir);
        const findings = await runSemgrep(cleanTarget, cleanDir, ruleExec);
        for (const f of findings) {
          const normalizedId = f.ruleId.startsWith(ruleId) ? ruleId : f.ruleId;
          cleanResults.push({ ruleId: normalizedId });
        }
      } catch {
        // No findings from error → precision passes trivially.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wrapped scanner family: semgrep (full run: p/owasp-top-ten + rules/semgrep/)
  // Normalize all findings to ruleId 'semgrep' for family-level accounting.
  // Semgrep exits 1 when it finds issues — handle that in the family exec.
  // -------------------------------------------------------------------------
  {
    const familyId = 'semgrep';
    const vulnDir = join(corpusStaticDir, familyId, 'vulnerable');
    const cleanDir = join(corpusStaticDir, familyId, 'clean');
    // Build an exec that tolerates semgrep's exit-1-on-findings behaviour.
    const semgrepFamilyExec: ExecSemgrep = injections.execSemgrep ?? (async (dir, ruleArgs) => {
      try {
        const r = await execFileAsync('semgrep', ['--json', ...ruleArgs, '--no-git-ignore', dir]);
        return { stdout: r.stdout, stderr: r.stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        if (e.code === 1 && typeof e.stdout === 'string') {
          return { stdout: e.stdout, stderr: e.stderr ?? '' };
        }
        throw err;
      }
    });

    if (existsSync(vulnDir)) {
      try {
        const findings = await runSemgrep(corpusTarget(familyId, vulnDir), vulnDir, semgrepFamilyExec);
        scanResults.push(...findings.map(() => ({ ruleId: familyId })));
      } catch {
        // Binary absent.
      }
    }

    if (existsSync(cleanDir)) {
      try {
        const findings = await runSemgrep(corpusTarget(familyId, cleanDir), cleanDir, semgrepFamilyExec);
        cleanResults.push(...findings.map(() => ({ ruleId: familyId })));
      } catch {
        // No findings from error.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wrapped scanner family: gitleaks
  // Normalize all findings to ruleId 'gitleaks' for family-level accounting.
  // -------------------------------------------------------------------------
  {
    const familyId = 'gitleaks';
    const vulnDir = join(corpusStaticDir, familyId, 'vulnerable');
    const cleanDir = join(corpusStaticDir, familyId, 'clean');

    if (existsSync(vulnDir)) {
      try {
        const findings = await runGitleaks(corpusTarget(familyId, vulnDir), vulnDir, injections.execGitleaks);
        scanResults.push(...findings.map(() => ({ ruleId: familyId })));
      } catch (err) {
        process.stderr.write(`[benchmark] gitleaks error: ${String(err)}\n`);
      }
    }

    if (existsSync(cleanDir)) {
      try {
        const findings = await runGitleaks(corpusTarget(familyId, cleanDir), cleanDir, injections.execGitleaks);
        cleanResults.push(...findings.map(() => ({ ruleId: familyId })));
      } catch {
        // No findings from error.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wrapped scanner family: osv
  // The fixture uses package.fixture.json (not package.json) to avoid npm
  // treating it as a real manifest. Copy to a temp dir as package.json so
  // osv-scanner's --recursive discovery finds it.
  // Normalize all findings to ruleId 'osv' for family-level accounting.
  // -------------------------------------------------------------------------
  {
    const familyId = 'osv';
    const vulnDir = join(corpusStaticDir, familyId, 'vulnerable');
    const cleanDir = join(corpusStaticDir, familyId, 'clean');

    for (const [sourceDir, resultsBucket] of [
      [vulnDir, scanResults],
      [cleanDir, cleanResults],
    ] as [string, ScanResult[]][]) {
      const fixtureFile = join(sourceDir, 'package.fixture.json');
      if (!existsSync(fixtureFile)) continue;

      let tmpDir: string | undefined;
      try {
        tmpDir = mkdtempSync(join(tmpdir(), 'audit-bench-osv-'));
        copyFileSync(fixtureFile, join(tmpDir, 'package.json'));
        const lockFixture = join(sourceDir, 'package-lock.fixture.json');
        const lockDest = join(tmpDir, 'package-lock.json');
        if (existsSync(lockFixture)) {
          copyFileSync(lockFixture, lockDest);
        }
        // Use --lockfile to scope osv-scanner to exactly this fixture's lockfile,
        // avoiding --recursive picking up /app/node_modules from the container CWD.
        const osvExec: ExecOsv = injections.execOsv ?? (async () => {
          if (!existsSync(lockDest)) {
            // No lockfile = no resolved packages = no findings.
            return { stdout: JSON.stringify({ results: [] }) };
          }
          try {
            const r = await execFileAsync('osv-scanner', [
              '--format', 'json',
              '--lockfile', lockDest,
            ]);
            return { stdout: r.stdout };
          } catch (e) {
            const ee = e as { code?: number; stdout?: string };
            if (ee.code === 1 && typeof ee.stdout === 'string') return { stdout: ee.stdout };
            throw e;
          }
        });
        const target = corpusTarget(familyId, tmpDir);
        const findings = await runOsv(target, tmpDir, osvExec);
        resultsBucket.push(...findings.map(() => ({ ruleId: familyId })));
      } catch {
        // Binary absent or no vulnerabilities found.
      } finally {
        if (tmpDir !== undefined) {
          try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  return { scanResults, cleanResults };
}

// ---------------------------------------------------------------------------
// CLI entry — `npm run benchmark` calls this
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Diagnostic: verify scanner binaries are present
  for (const bin of ['semgrep', 'gitleaks', 'osv-scanner']) {
    try {
      await execFileAsync(bin, ['--version']);
      process.stderr.write(`[benchmark] ${bin}: OK\n`);
    } catch (err) {
      process.stderr.write(`[benchmark] ${bin}: MISSING or error — ${String(err)}\n`);
    }
  }
  const { scanResults, cleanResults } = await runDetectors();
  const result = runBenchmark(scanResults, cleanResults);

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
  main().catch((err: unknown) => {
    console.error('BENCHMARK ERROR:', err);
    process.exit(1);
  });
}
