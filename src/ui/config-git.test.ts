/**
 * config-git.test.ts
 *
 * Tests for src/ui/config-git.ts against a local temp bare repo (no network).
 *
 * Safety-critical tests (marked with [SAFETY]):
 * - token never appears in commit, .git/config, error strings, returned values, or process.env
 * - dirty config worktree → ConfigWorktreeDirtyError (no reset)
 * - push failure rolls back config paths only, non-config state preserved
 * - git add -A never invoked (verified by checking staged set after commit)
 * - computeConfigRevert: valid config(dashboard) commit → parent contents
 * - computeConfigRevert: non-config commit → NotARevertableConfigCommitError
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ensureClone,
  commitConfigChange,
  assertConfigWorktreeClean,
  recentConfigCommits,
  computeConfigRevert,
  CONFIG_PATHS,
  ConfigWorktreeDirtyError,
  GitPushError,
  NotARevertableConfigCommitError,
  type ConfigFileWrite,
  type CommitConfigChangeOpts,
} from './config-git.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await git(args, cwd);
  return stdout.trim();
}

/**
 * Create a temp bare repo to act as the "remote" (no network).
 * Seeds it with an initial commit containing config files on branch 'main'.
 * Uses core.autocrlf=false to avoid Windows CRLF false-dirty issues.
 */
async function createBareRemote(dir: string): Promise<string> {
  const bare = join(dir, 'remote.git');
  await mkdir(bare);

  // Init the bare repo with 'main' as the default branch
  await git(['init', '--bare', '--initial-branch=main', bare], dir);

  // Clone it to a temp location to make the initial commit.
  // Disable autocrlf so committed LF blobs check out as LF on Windows too.
  const seed = join(dir, 'seed');
  await git(['clone', '-c', 'core.autocrlf=false', bare, seed], dir);
  await git(['config', 'user.name', 'test'], seed);
  await git(['config', 'user.email', 'test@test.com'], seed);
  await git(['config', 'core.autocrlf', 'false'], seed);

  // Create initial config files with LF line endings
  await mkdir(join(seed, 'config'));
  const initialTargets = JSON.stringify({ repos: [], stagingTargets: [] }, null, 2);
  const initialAllowlist = JSON.stringify({ hosts: [] }, null, 2);
  await writeFile(join(seed, 'config', 'targets.json'), initialTargets, 'utf8');
  await writeFile(join(seed, 'config', 'allowed-staging-hosts.json'), initialAllowlist, 'utf8');

  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'chore: initial config'], seed);
  await git(['push', 'origin', 'HEAD:main'], seed);

  return bare;
}

/**
 * Clone the bare remote into a working dir (simulating ensureClone's output).
 * Uses core.autocrlf=false to avoid Windows CRLF false-dirty issues.
 */
async function cloneWorking(bareUrl: string, dir: string): Promise<string> {
  const working = join(dir, 'working');
  await git(['clone', '-c', 'core.autocrlf=false', bareUrl, working], dir);
  await git(['config', 'user.name', 'sectool-dashboard'], working);
  await git(['config', 'user.email', 'ops@test.com'], working);
  await git(['config', 'core.autocrlf', 'false'], working);
  return working;
}

// Fake token — never a real value; used to test that it never leaks.
const FAKE_TOKEN = 'ghp_FAKE_TEST_TOKEN_NEVER_REAL';

function makeCommitOpts(configRepoDir: string, bareUrlArg: string): CommitConfigChangeOpts {
  return {
    configRepoDir,
    remoteUrl: bareUrlArg,
    branch: 'main',
    token: FAKE_TOKEN,
    actor: 'ops',
    action: 'test-action',
    target: 'test-target',
  };
}

// ---------------------------------------------------------------------------
// Test fixture state
// ---------------------------------------------------------------------------

let tmpDir: string;
let bareUrl: string;
let workingDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'config-git-test-'));
  bareUrl = await createBareRemote(tmpDir);
  workingDir = await cloneWorking(bareUrl, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write + commit + push via the module
// ---------------------------------------------------------------------------

async function doCommit(
  files: ConfigFileWrite[],
  message: string,
  opts?: Partial<CommitConfigChangeOpts>,
): Promise<{ sha: string }> {
  return commitConfigChange(files, message, {
    ...makeCommitOpts(workingDir, bareUrl),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('commitConfigChange — happy path', () => {
  it('writes, commits, pushes and returns a SHA', async () => {
    // Use content distinct from the initial seed to ensure there is something to commit.
    const newTargets = JSON.stringify(
      { repos: [{ name: 'test-repo', url: 'https://github.com/test/repo' }], stagingTargets: [] },
      null,
      2,
    );
    const result = await doCommit(
      [{ path: 'config/targets.json', content: newTargets }],
      'config(dashboard): update targets test-target',
    );

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the committed content matches what we wrote
    const committed = await gitOut(['show', `${result.sha}:config/targets.json`], workingDir);
    expect(committed).toBe(newTargets);
  });

  it('committed tree matches the proposed config for both files', async () => {
    const newTargets = JSON.stringify(
      { repos: [{ name: 'r1', url: 'https://github.com/x/y' }], stagingTargets: [] },
      null,
      2,
    );
    const newAllowlist = JSON.stringify(
      { hosts: [{ host: 'example.com', owner: 'ops', addedAt: '2026-01-01T00:00:00Z' }] },
      null,
      2,
    );

    const result = await doCommit(
      [
        { path: 'config/targets.json', content: newTargets },
        { path: 'config/allowed-staging-hosts.json', content: newAllowlist },
      ],
      'config(dashboard): add repo and host test-target',
    );

    const committedTargets = await gitOut(['show', `${result.sha}:config/targets.json`], workingDir);
    const committedAllowlist = await gitOut(
      ['show', `${result.sha}:config/allowed-staging-hosts.json`],
      workingDir,
    );

    expect(committedTargets).toBe(newTargets);
    expect(committedAllowlist).toBe(newAllowlist);
  });

  it('includes audit trailers in the commit message', async () => {
    const result = await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): add repo test-repo',
      { actor: 'admin', action: 'add-repo', target: 'test-repo' },
    );

    const commitMsg = await gitOut(['log', '--format=%B', '-1', result.sha], workingDir);
    expect(commitMsg).toContain('Audit-Actor: admin');
    expect(commitMsg).toContain('Audit-Action: add-repo');
    expect(commitMsg).toContain('Audit-Target: test-repo');
    expect(commitMsg).toContain('Audit-Time:');
  });

  it('rejects paths not in CONFIG_PATHS whitelist', async () => {
    await expect(
      doCommit(
        [{ path: 'src/evil.ts', content: 'malicious' }],
        'config(dashboard): smuggle code',
      ),
    ).rejects.toThrow("path 'src/evil.ts' is not in CONFIG_PATHS whitelist");
  });
});

describe('assertConfigWorktreeClean — dirty config worktree [SAFETY]', () => {
  it('throws ConfigWorktreeDirtyError when a config path has uncommitted changes', async () => {
    // Dirty a config file without staging it
    await writeFile(join(workingDir, 'config', 'targets.json'), 'dirty', 'utf8');

    await expect(
      assertConfigWorktreeClean({ configRepoDir: workingDir, branch: 'main' }),
    ).rejects.toThrow(ConfigWorktreeDirtyError);
  });

  it('throws ConfigWorktreeDirtyError when a config path is staged', async () => {
    await writeFile(join(workingDir, 'config', 'targets.json'), 'staged', 'utf8');
    await git(['add', 'config/targets.json'], workingDir);

    await expect(
      assertConfigWorktreeClean({ configRepoDir: workingDir, branch: 'main' }),
    ).rejects.toThrow(ConfigWorktreeDirtyError);
  });

  it('does NOT throw when only non-config files are dirty', async () => {
    // Dirty a non-config file — should be ignored
    await writeFile(join(workingDir, 'some-other-file.txt'), 'ignored', 'utf8');

    await expect(
      assertConfigWorktreeClean({ configRepoDir: workingDir, branch: 'main' }),
    ).resolves.toBeUndefined();
  });

  it('throws when HEAD is detached', async () => {
    // Detach HEAD by checking out the current commit SHA
    const sha = await gitOut(['rev-parse', 'HEAD'], workingDir);
    await git(['checkout', '--detach', sha], workingDir);

    await expect(
      assertConfigWorktreeClean({ configRepoDir: workingDir, branch: 'main' }),
    ).rejects.toThrow(ConfigWorktreeDirtyError);
  });

  it('throws when on the wrong branch', async () => {
    await git(['checkout', '-b', 'other-branch'], workingDir);

    await expect(
      assertConfigWorktreeClean({ configRepoDir: workingDir, branch: 'main' }),
    ).rejects.toThrow(ConfigWorktreeDirtyError);
  });

  it('commitConfigChange throws ConfigWorktreeDirtyError without resetting state', async () => {
    // Dirty the worktree with a known string
    const dirtyContent = 'deliberately dirty config';
    await writeFile(join(workingDir, 'config', 'targets.json'), dirtyContent, 'utf8');

    await expect(
      doCommit(
        [{ path: 'config/targets.json', content: '{"repos":[],"stagingTargets":[]}' }],
        'config(dashboard): should fail',
      ),
    ).rejects.toThrow(ConfigWorktreeDirtyError);

    // The dirty content must still be there — no reset performed
    const afterContent = await readFile(join(workingDir, 'config', 'targets.json'), 'utf8');
    expect(afterContent).toBe(dirtyContent);
  });
});

describe('push failure rollback [SAFETY]', () => {
  it('rolls back config paths only, leaving a non-config modified file AND a non-config staged file untouched', async () => {
    // Seed: add a non-config tracked file and commit it to the repo
    const nonConfigFile = join(workingDir, 'README.md');
    await writeFile(nonConfigFile, 'original content', 'utf8');
    await git(['add', 'README.md'], workingDir);
    await git(['commit', '-m', 'chore: add readme'], workingDir);
    await git(['push', 'origin', 'main'], workingDir);

    // (a) Modify the non-config file in the worktree (unstaged)
    await writeFile(nonConfigFile, 'modified non-config', 'utf8');
    // (b) Stage a separate non-config file
    const stagedNonConfig = join(workingDir, 'STAGED.md');
    await writeFile(stagedNonConfig, 'staged non-config', 'utf8');
    await git(['add', 'STAGED.md'], workingDir);

    // Record the config state before the failed commit attempt
    const priorTargets = await readFile(join(workingDir, 'config', 'targets.json'), 'utf8');

    // Use a nonexistent remote URL to force a hard push failure (not non-FF)
    const badRemoteUrl = join(tmpDir, 'does-not-exist.git');

    await expect(
      commitConfigChange(
        [
          {
            path: 'config/targets.json',
            content: JSON.stringify({ repos: [], stagingTargets: [] }, null, 2),
          },
        ],
        'config(dashboard): should fail and rollback',
        { ...makeCommitOpts(workingDir, badRemoteUrl) },
      ),
    ).rejects.toThrow(GitPushError);

    // Config must be back to prior state
    const afterTargets = await readFile(join(workingDir, 'config', 'targets.json'), 'utf8');
    expect(afterTargets).toBe(priorTargets);

    // Non-config worktree file must be untouched
    const afterReadme = await readFile(nonConfigFile, 'utf8');
    expect(afterReadme).toBe('modified non-config');

    // Non-config staged file must still be staged
    const { stdout: cachedFiles } = await git(['diff', '--cached', '--name-only'], workingDir);
    expect(cachedFiles).toContain('STAGED.md');

    // Config paths must NOT be staged after rollback
    const { stdout: cachedConfigFiles } = await git(
      ['diff', '--cached', '--name-only', '--', ...CONFIG_PATHS],
      workingDir,
    );
    expect(cachedConfigFiles.trim()).toBe('');
  });
});

describe('token never leaks [SAFETY]', () => {
  it('token does not appear in process.env after a successful write', async () => {
    // Before: ensure token is not on process.env
    expect(process.env['AUDIT_GIT_ASKPASS_TOKEN']).toBeUndefined();

    await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): token leak test',
    );

    // After: token must not be on process.env
    expect(process.env['AUDIT_GIT_ASKPASS_TOKEN']).toBeUndefined();
    // Verify none of the env keys has our fake token as a value
    const envValues = Object.values(process.env).join('');
    expect(envValues).not.toContain(FAKE_TOKEN);
  });

  it('token does not appear in .git/config', async () => {
    await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): token in git config test',
    );

    const gitConfig = await readFile(join(workingDir, '.git', 'config'), 'utf8');
    expect(gitConfig).not.toContain(FAKE_TOKEN);
  });

  it('token does not appear in a forced-push-failure error message', async () => {
    const badRemoteUrl = join(tmpDir, 'nonexistent.git');

    let caughtError: Error | undefined;
    try {
      await commitConfigChange(
        [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
        'config(dashboard): error message scrub test',
        { ...makeCommitOpts(workingDir, badRemoteUrl) },
      );
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).not.toContain(FAKE_TOKEN);
    if (caughtError!.cause instanceof Error) {
      expect(caughtError!.cause.message).not.toContain(FAKE_TOKEN);
    }
  });

  it('token does not appear in any committed blob', async () => {
    const result = await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): blob check',
    );

    // Check commit message
    const commitMsg = await gitOut(['log', '--format=%B', '-1', result.sha], workingDir);
    expect(commitMsg).not.toContain(FAKE_TOKEN);

    // Check the committed blob
    const blob = await gitOut(['show', `${result.sha}:config/targets.json`], workingDir);
    expect(blob).not.toContain(FAKE_TOKEN);
  });

  it('token does not appear in process.env after a failed push', async () => {
    expect(process.env['AUDIT_GIT_ASKPASS_TOKEN']).toBeUndefined();

    const badRemoteUrl = join(tmpDir, 'nonexistent.git');
    try {
      await commitConfigChange(
        [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
        'config(dashboard): env check after failure',
        { ...makeCommitOpts(workingDir, badRemoteUrl) },
      );
    } catch {
      // expected
    }

    expect(process.env['AUDIT_GIT_ASKPASS_TOKEN']).toBeUndefined();
    const envValues = Object.values(process.env).join('');
    expect(envValues).not.toContain(FAKE_TOKEN);
  });
});

describe('git add -A never invoked [SAFETY]', () => {
  it('only CONFIG_PATHS are in the committed tree (no extra files staged)', async () => {
    // Write a non-config file in the worktree — must NOT appear in the commit
    await writeFile(join(workingDir, 'should-not-be-committed.txt'), 'extra', 'utf8');

    const result = await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): staged-set check',
    );

    // The commit should only touch the config file, not the extra file
    const { stdout: changedFiles } = await git(
      ['diff-tree', '--no-commit-id', '-r', '--name-only', result.sha],
      workingDir,
    );
    expect(changedFiles).not.toContain('should-not-be-committed.txt');

    // The extra file must still be untracked in the worktree
    const { stdout: status } = await git(['status', '--short'], workingDir);
    expect(status).toContain('should-not-be-committed.txt');
  });
});

describe('non-fast-forward → fetch + replay-once', () => {
  it('retries once on non-FF push and succeeds if the retry push works', async () => {
    // Advance the remote with a non-conflicting commit (different file path)
    const second = join(tmpDir, 'second-nff');
    await git(['clone', '-c', 'core.autocrlf=false', bareUrl, second], tmpDir);
    await git(['config', 'user.name', 'second'], second);
    await git(['config', 'user.email', 'second@test.com'], second);
    // Push a commit to allowed-staging-hosts.json so targets.json is still patchable
    await writeFile(
      join(second, 'config', 'allowed-staging-hosts.json'),
      JSON.stringify({
        hosts: [{ host: 'replay.example.com', owner: 'ops', addedAt: '2026-01-01T00:00:00Z' }],
      }),
      'utf8',
    );
    await git(['add', 'config/allowed-staging-hosts.json'], second);
    await git(['commit', '-m', 'chore: advance for non-ff test'], second);
    await git(['push', 'origin', 'main'], second);

    // Our working clone is now behind — first push will fail non-FF, should fetch+replay
    const updatedContent = JSON.stringify(
      { repos: [{ name: 'replayed', url: 'https://github.com/x/y' }], stagingTargets: [] },
      null,
      2,
    );
    const result = await doCommit(
      [{ path: 'config/targets.json', content: updatedContent }],
      'config(dashboard): non-ff replay test',
    );

    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the pushed commit contains our content
    const committed = await gitOut(['show', `${result.sha}:config/targets.json`], workingDir);
    expect(JSON.parse(committed)).toMatchObject({ repos: [{ name: 'replayed' }] });
  });
});

describe('recentConfigCommits', () => {
  it('returns commits with config(dashboard): prefix', async () => {
    await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): first change',
    );
    await doCommit(
      [
        {
          path: 'config/allowed-staging-hosts.json',
          content: JSON.stringify({ hosts: [] }),
        },
      ],
      'config(dashboard): second change',
    );

    const commits = await recentConfigCommits(10, { configRepoDir: workingDir });
    expect(commits.length).toBeGreaterThanOrEqual(2);
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.message).toContain('config(dashboard):');
    }
  });

  it('does not return non-config commits', async () => {
    // After two config commits, all results should have the prefix
    await doCommit(
      [{ path: 'config/targets.json', content: JSON.stringify({ repos: [], stagingTargets: [] }) }],
      'config(dashboard): only-config commit',
    );
    const commits = await recentConfigCommits(10, { configRepoDir: workingDir });
    for (const c of commits) {
      expect(c.message).toMatch(/^config\(dashboard\):/);
    }
  });
});

describe('computeConfigRevert', () => {
  it('returns parent config content for a config(dashboard) commit', async () => {
    // Push an intermediate "before" state (distinct from the seed content)
    const originalContent = JSON.stringify(
      { repos: [{ name: 'before', url: 'https://github.com/b/b' }], stagingTargets: [] },
      null,
      2,
    );
    await doCommit(
      [{ path: 'config/targets.json', content: originalContent }],
      'config(dashboard): set original',
    );

    // Push the "after" state
    const updatedContent = JSON.stringify(
      { repos: [{ name: 'new-repo', url: 'https://github.com/x/y' }], stagingTargets: [] },
      null,
      2,
    );
    const result = await doCommit(
      [{ path: 'config/targets.json', content: updatedContent }],
      'config(dashboard): add new-repo',
    );

    // computeConfigRevert on the second commit should return originalContent
    const revert = await computeConfigRevert(result.sha, { configRepoDir: workingDir });

    expect(revert.files).toHaveLength(1);
    expect(revert.files[0]!.path).toBe('config/targets.json');
    expect(revert.files[0]!.content).toBe(originalContent);
  });

  it('throws NotARevertableConfigCommitError for a non-config(dashboard) commit', async () => {
    // First make a config(dashboard) commit so we have a SHA to check
    // then create a non-config commit directly via raw git
    await writeFile(join(workingDir, 'not-config.txt'), 'not a config file', 'utf8');
    await git(['add', 'not-config.txt'], workingDir);
    await git(['commit', '-m', 'chore: non-config commit'], workingDir);
    await git(['push', 'origin', 'main'], workingDir);

    const sha = await gitOut(['rev-parse', 'HEAD'], workingDir);

    await expect(
      computeConfigRevert(sha, { configRepoDir: workingDir }),
    ).rejects.toThrow(NotARevertableConfigCommitError);
  });

  it('throws NotARevertableConfigCommitError for a commit touching non-config paths', async () => {
    // Create a commit that has the right message prefix but touches non-config paths
    await writeFile(join(workingDir, 'non-config.txt'), 'not config', 'utf8');
    await git(['add', 'non-config.txt'], workingDir);
    await git(['commit', '-m', 'config(dashboard): sneaky non-config commit'], workingDir);
    await git(['push', 'origin', 'main'], workingDir);

    const sha = await gitOut(['rev-parse', 'HEAD'], workingDir);

    await expect(
      computeConfigRevert(sha, { configRepoDir: workingDir }),
    ).rejects.toThrow(NotARevertableConfigCommitError);
  });
});

describe('ensureClone', () => {
  it('clones the repo when configRepoDir does not exist', async () => {
    const freshDir = join(tmpDir, 'fresh-clone');
    // Note: freshDir must NOT exist — ensureClone creates it via git clone

    await ensureClone({
      configRepoDir: freshDir,
      remoteUrl: bareUrl,
      branch: 'main',
      token: FAKE_TOKEN,
    });

    // The clone should have the config files
    const targets = await readFile(join(freshDir, 'config', 'targets.json'), 'utf8');
    expect(JSON.parse(targets)).toBeDefined();
  });

  it('fetches and fast-forwards when configRepoDir already exists', async () => {
    // Push a new commit to the bare remote from a second clone
    const updatedContent = JSON.stringify(
      {
        repos: [{ name: 'fetched-repo', url: 'https://github.com/x/y' }],
        stagingTargets: [],
      },
      null,
      2,
    );
    const second = join(tmpDir, 'second-clone');
    await git(['clone', '-c', 'core.autocrlf=false', bareUrl, second], tmpDir);
    await git(['config', 'user.name', 'second'], second);
    await git(['config', 'user.email', 'second@test.com'], second);
    await writeFile(join(second, 'config', 'targets.json'), updatedContent, 'utf8');
    await git(['add', 'config/targets.json'], second);
    await git(['commit', '-m', 'chore: update for fetch test'], second);
    await git(['push', 'origin', 'main'], second);

    // ensureClone on existing workingDir should fetch+ff
    await ensureClone({
      configRepoDir: workingDir,
      remoteUrl: bareUrl,
      branch: 'main',
      token: FAKE_TOKEN,
    });

    const targets = await readFile(join(workingDir, 'config', 'targets.json'), 'utf8');
    expect(targets).toBe(updatedContent);
  });
});

describe('CONFIG_PATHS whitelist', () => {
  it('exports the expected frozen array', () => {
    expect(CONFIG_PATHS).toContain('config/targets.json');
    expect(CONFIG_PATHS).toContain('config/allowed-staging-hosts.json');
    expect(CONFIG_PATHS).toHaveLength(2);
    // Verify it is frozen (immutable)
    expect(Object.isFrozen(CONFIG_PATHS)).toBe(true);
  });
});
