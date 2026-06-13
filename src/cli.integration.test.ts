/**
 * AUD-001 integration test — verifies that `scan-source` (via scanRepos) with the
 * real `ast` scanner family produces >0 findings over a seeded vulnerable fixture.
 *
 * Network-free: only the `ast` family runs the real ts-morph rules.
 * semgrep, gitleaks, and osv are injected with no-op stubs so no binaries
 * are required.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepos } from './static/orchestrator.js';
import { buildStaticScannerMap } from './cli.js';
import type { ScannerMap } from './static/orchestrator.js';
import type { RepoTarget } from './schemas/targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Vulnerable fixture directory containing a SQL injection pattern (BS-SQL-001)
const FIXTURE_DIR = resolve(
  __dirname,
  '..',
  'benchmark',
  'corpus',
  'static',
  'BS-SQL-001',
  'vulnerable',
);

const FIXTURE_REPO: RepoTarget = {
  name: 'fixture-repo',
  gitUrl: 'https://github.com/example/fixture.git',
  localPath: FIXTURE_DIR,
  stackTags: [],
  publicRoutes: [],
  enabled: true,
};

describe('AUD-001 — real ast scanner produces findings over vulnerable fixture', () => {
  it('scanRepos with real ast scanner returns >0 findings for the SQL injection fixture', async () => {
    // Build the full scanner map but override semgrep/gitleaks/osv with stubs
    // so this test needs no external binaries and stays network-free.
    const realMap = buildStaticScannerMap();
    // buildStaticScannerMap always sets ast, so the assertion below is guaranteed
    const astRunner = realMap.ast;
    if (astRunner === undefined) throw new Error('buildStaticScannerMap did not set ast runner');

    const scannerMap: ScannerMap = {
      ast: astRunner,
      // Stub out the binary-shelling scanners
      semgrep: () => Promise.resolve([]),
      gitleaks: () => Promise.resolve([]),
      osv: () => Promise.resolve([]),
    };

    const result = await scanRepos(
      [FIXTURE_REPO],
      scannerMap,
      { scannerTimeoutMs: 30_000, maxParallelTargets: 1 },
      // Use the real localPath acquirer (no git clone needed)
      (target) => Promise.resolve({
        dir: target.localPath!,
        commit: undefined,
        cleanup: () => Promise.resolve(),
      }),
    );

    // The fixture contains SQL injection patterns — the ast scanner must find them
    expect(result.findings.length).toBeGreaterThan(0);

    // All findings should come from the ast family
    const astFindings = result.findings.filter((f) => f.source === 'ast');
    expect(astFindings.length).toBeGreaterThan(0);

    // Scanner status should show ast completed for the fixture repo
    const astStatus = result.scannerStatus.find(
      (s) => s.target === 'fixture-repo' && s.family === 'ast',
    );
    expect(astStatus?.state).toBe('complete');
  });

  it('buildStaticScannerMap returns a map with all 4 expected families', () => {
    const scannerMap = buildStaticScannerMap();
    expect(typeof scannerMap.ast).toBe('function');
    expect(typeof scannerMap.semgrep).toBe('function');
    expect(typeof scannerMap.gitleaks).toBe('function');
    expect(typeof scannerMap.osv).toBe('function');
  });
});
