import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Finding, ScannerFamily } from '../schemas/finding.js';
import type { RepoTarget } from '../schemas/targets.js';
import type { ScannerStatusEntry } from '../schemas/report.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScanOpts = {
  /** Hard timeout per scanner family in milliseconds. Default: 15 minutes. */
  scannerTimeoutMs: number;
  /** Maximum number of repos processed concurrently. Default: 2. */
  maxParallelTargets: number;
};

/** Result returned by scanRepos: raw-stage findings + per-(target×family) status. */
export type ScanReposResult = {
  findings: Finding[];
  scannerStatus: ScannerStatusEntry[];
};

// ---------------------------------------------------------------------------
// Injectable dependencies (hidden behind the public API; mockable for unit tests)
// ---------------------------------------------------------------------------

/**
 * Resolves a repo to a local directory path for scanning.
 * Returns `{ dir, commit, cleanup }` where `cleanup()` removes any temp dir
 * created when `localPath` was null.
 */
export type AcquireRepo = (
  target: RepoTarget,
) => Promise<{ dir: string; commit: string | undefined; cleanup: () => Promise<void> }>;

/**
 * A single scanner function: given a repo directory and the target metadata,
 * produces raw-stage findings.
 */
export type ScannerFn = (dir: string, target: RepoTarget) => Promise<Finding[]>;

/** Maps a scanner family to its runner function. */
export type ScannerMap = Partial<Record<ScannerFamily, ScannerFn>>;

// ---------------------------------------------------------------------------
// Default: real shallow-clone implementation (integration-tested in P6-1)
// ---------------------------------------------------------------------------

async function resolveCommitSha(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Default repo acquirer: reads localPath as-is, or performs a shallow
 * `--depth 1` single-branch default-HEAD clone using `AUDIT_GITHUB_READ_TOKEN`.
 * Submodule init is NOT performed (§6.2 v1 scope).
 */
export async function defaultAcquireRepo(
  target: RepoTarget,
): Promise<{ dir: string; commit: string | undefined; cleanup: () => Promise<void> }> {
  if (target.localPath !== null) {
    const commit = await resolveCommitSha(target.localPath);
    return {
      dir: target.localPath,
      commit,
      cleanup: async () => {
        // no-op: caller-managed working tree
      },
    };
  }

  const token = process.env['AUDIT_GITHUB_READ_TOKEN'];
  const gitUrl = token
    ? target.gitUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
    : target.gitUrl;

  const tmpDir = await mkdtemp(join(tmpdir(), `audit-clone-${target.name}-`));
  try {
    await execFileAsync('git', [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--no-recurse-submodules',
      gitUrl,
      tmpDir,
    ]);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const commit = await resolveCommitSha(tmpDir);
  return {
    dir: tmpDir,
    commit,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Timeout race helper
// ---------------------------------------------------------------------------

type RaceResult<T> =
  | { timedOut: false; error: undefined; value: T }
  | { timedOut: false; error: unknown; value: undefined }
  | { timedOut: true; error: undefined; value: undefined };

function raceWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<RaceResult<T>> {
  return new Promise<RaceResult<T>>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ timedOut: true, error: undefined, value: undefined });
      }
    }, timeoutMs);

    fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, error: undefined, value });
        }
      },
      (err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, error: err, value: undefined });
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Bounded pool helper
// ---------------------------------------------------------------------------

async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p: Promise<void> = task().then((result) => {
      results.push(result);
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ---------------------------------------------------------------------------
// Core: scan a single repo across all configured scanner families
// ---------------------------------------------------------------------------

async function scanSingleRepo(
  target: RepoTarget,
  dir: string,
  commit: string | undefined,
  scanners: ScannerMap,
  opts: ScanOpts,
): Promise<{ findings: Finding[]; statuses: ScannerStatusEntry[] }> {
  const families = Object.keys(scanners) as ScannerFamily[];
  const allFindings: Finding[] = [];
  const statuses: ScannerStatusEntry[] = [];

  const familyPromises = families.map(async (family) => {
    const scannerFn = scanners[family];
    if (scannerFn === undefined) {
      return {
        findings: [] as Finding[],
        status: { target: target.name, family, state: 'skipped' as const },
      };
    }

    const raceResult = await raceWithTimeout(() => scannerFn(dir, target), opts.scannerTimeoutMs);

    if (raceResult.timedOut) {
      return {
        findings: [] as Finding[],
        status: { target: target.name, family, state: 'skipped' as const },
      };
    }

    if (raceResult.error !== undefined) {
      return {
        findings: [] as Finding[],
        status: { target: target.name, family, state: 'failed' as const },
      };
    }

    // Stamp commit SHA onto each static finding's target
    const findings = raceResult.value;
    if (findings === undefined) {
      return {
        findings: [] as Finding[],
        status: { target: target.name, family, state: 'failed' as const },
      };
    }
    const stamped = findings.map((f): Finding => {
      if (f.surface === 'static' && commit !== undefined) {
        return { ...f, target: { ...f.target, commit } };
      }
      return f;
    });

    return {
      findings: stamped,
      status: { target: target.name, family, state: 'complete' as const },
    };
  });

  const results = await Promise.all(familyPromises);
  for (const r of results) {
    allFindings.push(...r.findings);
    statuses.push(r.status);
  }

  return { findings: allFindings, statuses };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a list of repo targets using the configured scanner families.
 *
 * - Repos are processed in a bounded pool (`opts.maxParallelTargets`).
 * - Each scanner family runs with a hard timeout (`opts.scannerTimeoutMs`).
 * - A clone/acquisition failure for one target fails that target only —
 *   other targets continue (§6.2 / §14).
 * - Per-(target×family) status is returned alongside raw-stage findings.
 *
 * @param targets   Enabled repo targets to scan.
 * @param scanners  Map of scanner family → scanner function.
 * @param opts      Pool size + timeout options.
 * @param acquire   Override for repo acquisition — injected in unit tests.
 */
export async function scanRepos(
  targets: RepoTarget[],
  scanners: ScannerMap,
  opts: ScanOpts,
  acquire: AcquireRepo = defaultAcquireRepo,
): Promise<ScanReposResult> {
  const allFindings: Finding[] = [];
  const allStatuses: ScannerStatusEntry[] = [];

  type TargetResult = {
    findings: Finding[];
    statuses: ScannerStatusEntry[];
  };

  const tasks = targets.map(
    (target) =>
      async (): Promise<TargetResult> => {
        let acquired: { dir: string; commit: string | undefined; cleanup: () => Promise<void> };
        try {
          acquired = await acquire(target);
        } catch {
          // Clone failure: fail all families for this target only; others continue.
          const families = Object.keys(scanners) as ScannerFamily[];
          return {
            findings: [],
            statuses: families.map((family) => ({
              target: target.name,
              family,
              state: 'failed' as const,
            })),
          };
        }

        const { dir, commit, cleanup } = acquired;
        try {
          const { findings, statuses } = await scanSingleRepo(
            target,
            dir,
            commit,
            scanners,
            opts,
          );
          return { findings, statuses };
        } finally {
          await cleanup();
        }
      },
  );

  const targetResults = await withConcurrencyLimit(tasks, opts.maxParallelTargets);
  for (const r of targetResults) {
    allFindings.push(...r.findings);
    allStatuses.push(...r.statuses);
  }

  return { findings: allFindings, scannerStatus: allStatuses };
}
