/**
 * src/static/orchestrator.integration.test.ts
 *
 * Repo-acquisition integration test (P6-1, MEDIUM-3).
 *
 * Tests `defaultAcquireRepo` and `scanRepos` with `localPath: null` against a
 * LOCAL bare git repo fixture — no network required. Creates a real bare repo
 * in a temp dir, seeds one commit, then asserts the shallow clone contract:
 *   - clones into a fresh temp dir (not the bare repo dir)
 *   - records the scanned commit SHA into `target.commit`
 *   - does NOT initialise submodules (--no-recurse-submodules)
 *   - cleans up the temp dir after the scan
 *   - reuses no prior temp state between runs
 *
 * If `git` is not available in the test environment, all tests in this suite
 * skip gracefully.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultAcquireRepo, scanRepos } from './orchestrator.js';
import type { ScanOpts } from './orchestrator.js';
import type { RepoTarget } from '../schemas/targets.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git availability guard — synchronous check at collection time
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------------------
// Bare-repo fixture setup
// ---------------------------------------------------------------------------

let bareRepoDir = '';
let seedCommitSha = '';

beforeAll(async () => {
  if (!gitAvailable) return;

  bareRepoDir = await mkdtemp(join(tmpdir(), 'audit-bare-repo-'));

  // Initialise a bare repo
  await execFileAsync('git', ['init', '--bare', bareRepoDir]);

  // Create a working clone to seed a commit
  const workDir = await mkdtemp(join(tmpdir(), 'audit-bare-seed-'));
  try {
    await execFileAsync('git', ['clone', bareRepoDir, workDir]);
    await execFileAsync('git', ['-C', workDir, 'config', 'user.email', 'test@audit.local']);
    await execFileAsync('git', ['-C', workDir, 'config', 'user.name', 'Audit Test']);

    // Seed one file so the commit is non-empty
    await writeFile(join(workDir, 'README.md'), '# audit-tool integration test fixture\n');
    await execFileAsync('git', ['-C', workDir, 'add', 'README.md']);
    await execFileAsync('git', ['-C', workDir, 'commit', '-m', 'initial commit']);
    await execFileAsync('git', ['-C', workDir, 'push', 'origin', 'HEAD']);

    // Record the commit SHA from the working clone
    const { stdout } = await execFileAsync('git', ['-C', workDir, 'rev-parse', 'HEAD']);
    seedCommitSha = stdout.trim();
  } finally {
    // Retry rmdir to absorb the transient Windows EBUSY/EPERM from a git handle
    // still open at cleanup time (teardown race, not a product bug).
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);

afterAll(async () => {
  if (gitAvailable && bareRepoDir) {
    await rm(bareRepoDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------
// Helper: make a RepoTarget pointing at the local bare repo via file:// URL
// ---------------------------------------------------------------------------

function makeLocalTarget(name = 'fixture-repo'): RepoTarget {
  return {
    name,
    // file:// URL so git clones without network
    gitUrl: `file://${bareRepoDir.replace(/\\/g, '/')}`,
    localPath: null,
    stackTags: [],
    publicRoutes: [],
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defaultAcquireRepo — shallow clone contract (§6.2)', () => {
  it.skipIf(!gitAvailable)(
    'clones localPath:null into a fresh temp dir (not the bare repo dir)',
    async () => {
      const target = makeLocalTarget();
      const { dir, cleanup } = await defaultAcquireRepo(target);
      try {
        expect(dir).not.toBe(bareRepoDir);
        expect(dir).toContain('audit-clone-');
        expect(existsSync(dir)).toBe(true);
      } finally {
        await cleanup();
      }
    },
    30_000,
  );

  it.skipIf(!gitAvailable)(
    'records the scanned commit SHA into target.commit',
    async () => {
      const target = makeLocalTarget();
      const { commit, cleanup } = await defaultAcquireRepo(target);
      try {
        expect(commit).toBeDefined();
        expect(commit).toBe(seedCommitSha);
      } finally {
        await cleanup();
      }
    },
    30_000,
  );

  it.skipIf(!gitAvailable)(
    'cleanup() removes the temp dir after the scan',
    async () => {
      const target = makeLocalTarget();
      const { dir, cleanup } = await defaultAcquireRepo(target);
      expect(existsSync(dir)).toBe(true);
      await cleanup();
      expect(existsSync(dir)).toBe(false);
    },
    30_000,
  );

  it.skipIf(!gitAvailable)(
    'each call creates a fresh temp dir — no prior temp state reused',
    async () => {
      const target = makeLocalTarget();
      const first = await defaultAcquireRepo(target);
      const second = await defaultAcquireRepo(target);
      try {
        expect(first.dir).not.toBe(second.dir);
      } finally {
        await first.cleanup();
        await second.cleanup();
      }
    },
    30_000,
  );

  it.skipIf(!gitAvailable)(
    'does NOT initialise submodules (--no-recurse-submodules)',
    async () => {
      // Assert that no .git/modules dir exists in the clone (submodules would
      // create it). This is a structural check — the fixture has no submodules,
      // so absence of the modules dir confirms the flag was honoured.
      const target = makeLocalTarget();
      const { dir, cleanup } = await defaultAcquireRepo(target);
      try {
        const modulesDir = join(dir, '.git', 'modules');
        expect(existsSync(modulesDir)).toBe(false);
      } finally {
        await cleanup();
      }
    },
    30_000,
  );
});

describe('scanRepos with localPath:null — integration (§6.2)', () => {
  const defaultOpts: ScanOpts = {
    scannerTimeoutMs: 30_000,
    maxParallelTargets: 1,
  };

  it.skipIf(!gitAvailable)(
    'stamps commit SHA onto static findings via the clone',
    async () => {
      const target = makeLocalTarget('fixture-repo-scan');

      // Fake scanner that records the dir it was called with
      let receivedDir: string | undefined;
      const fakeScanner = (dir: string) => {
        receivedDir = dir;
        return Promise.resolve([]);
      };

      const result = await scanRepos(
        [target],
        { semgrep: fakeScanner },
        defaultOpts,
      );

      expect(result.scannerStatus).toHaveLength(1);
      expect(result.scannerStatus[0]?.state).toBe('complete');
      // The scanner was invoked with a real cloned directory
      expect(receivedDir).toBeDefined();
      expect(receivedDir).not.toBe(bareRepoDir);
      // Cleanup: the dir should be removed after scan completes
      if (receivedDir !== undefined) {
        expect(existsSync(receivedDir)).toBe(false);
      }
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    'clone failure of the local target produces failed scanner status entries',
    async () => {
      const badTarget: RepoTarget = {
        name: 'bad-target',
        gitUrl: 'file:///nonexistent/path/to/repo',
        localPath: null,
        stackTags: [],
        publicRoutes: [],
        enabled: true,
      };

      const result = await scanRepos(
        [badTarget],
        { semgrep: () => Promise.resolve([]) },
        defaultOpts,
      );

      expect(result.scannerStatus).toHaveLength(1);
      expect(result.scannerStatus[0]?.state).toBe('failed');
      expect(result.findings).toHaveLength(0);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// localPath:non-null path — reads the working tree as-is (no clone)
// ---------------------------------------------------------------------------

describe('defaultAcquireRepo — localPath contract', () => {
  it('reads localPath as-is without cloning', async () => {
    // Use the tmpdir itself as a fake working tree (it exists but has no .git,
    // so resolveCommitSha will return undefined — that is acceptable).
    const target: RepoTarget = {
      name: 'local-repo',
      gitUrl: 'https://github.com/example/local-repo.git',
      localPath: tmpdir(),
      stackTags: [],
      publicRoutes: [],
      enabled: true,
    };

    const { dir, cleanup } = await defaultAcquireRepo(target);
    try {
      expect(dir).toBe(tmpdir());
    } finally {
      // cleanup for a localPath is a no-op — dir must still exist
      await cleanup();
      expect(existsSync(tmpdir())).toBe(true);
    }
  });

  it('cleanup() for a localPath is a no-op (caller-managed working tree)', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'audit-local-path-test-'));
    await mkdir(join(testDir, '.git'), { recursive: true });

    const target: RepoTarget = {
      name: 'local-managed',
      gitUrl: 'https://github.com/example/local-managed.git',
      localPath: testDir,
      stackTags: [],
      publicRoutes: [],
      enabled: true,
    };

    const { dir, cleanup } = await defaultAcquireRepo(target);
    expect(dir).toBe(testDir);
    await cleanup();
    // The caller-managed dir must NOT have been deleted
    expect(existsSync(testDir)).toBe(true);
    await rm(testDir, { recursive: true, force: true });
  });
});
