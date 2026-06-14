/**
 * Service-level tests for config-write.ts.
 * All tests use a local temp git repo as the remote (no network).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import {
  addRepo, editRepo, removeRepo,
  addStagingTarget, editStagingTarget, removeStagingTarget,
  addHost, removeHost,
  revertConfigCommit, listHistory,
  ValidationError, HostInUseError, NoChangeError, NotARevertableConfigCommitError,
} from './config-write.js';
import type { WriteServiceOpts } from './config-write.js';
import { loadAllowlist, loadTargets } from '../config/load.js';

// ---------------------------------------------------------------------------
// Helpers: create a temp git environment
// ---------------------------------------------------------------------------

interface GitEnv {
  bare: string;     // The "remote" bare repo
  clone: string;    // The working clone
  configDir: string;
  historyDir: string;
}

const BASE_TARGETS = {
  repos: [{ name: 'test-repo', gitUrl: 'https://github.com/example/test.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }],
  stagingTargets: [],
};

const BASE_ALLOWLIST = { hosts: [] };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
    encoding: 'utf8',
  }).toString().trim();
}

function setupGitEnv(): GitEnv {
  const base = mkdtempSync(join(tmpdir(), 'config-write-test-'));
  const bare = join(base, 'bare.git');
  const clone = join(base, 'clone');
  const historyDir = join(base, 'history');

  mkdirSync(base, { recursive: true });
  mkdirSync(historyDir, { recursive: true });

  // Create bare repo (explicitly set default branch to main)
  execSync(`git init --bare -b main "${bare}"`, {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    encoding: 'utf8',
  });

  // Create a working clone
  execSync(`git clone -c core.autocrlf=false "${bare}" "${clone}"`, {
    env: { ...process.env },
    encoding: 'utf8',
  });

  // Configure user in clone
  git(['config', 'user.name', 'Test'], clone);
  git(['config', 'user.email', 'test@test.com'], clone);
  git(['config', 'core.autocrlf', 'false'], clone);
  git(['config', 'init.defaultBranch', 'main'], clone);

  // Create initial config files
  const configDir = join(clone, 'config');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(join(configDir, 'targets.json'), JSON.stringify(BASE_TARGETS, null, 2) + '\n', 'utf8');
  writeFileSync(join(configDir, 'allowed-staging-hosts.json'), JSON.stringify(BASE_ALLOWLIST, null, 2) + '\n', 'utf8');

  // Initial commit + push
  git(['add', 'config/targets.json', 'config/allowed-staging-hosts.json'], clone);
  git(['commit', '-m', 'initial config'], clone);
  // Rename the local branch to main (in case git.init.defaultBranch is master on this system)
  try { git(['branch', '-m', 'main'], clone); } catch { /* already named main */ }
  git(['push', 'origin', 'HEAD:main'], clone);

  return { bare, clone, configDir, historyDir };
}

function makeOpts(env: GitEnv): WriteServiceOpts {
  return {
    configRepoDir: env.clone,
    configDir: env.configDir,
    remoteUrl: env.bare,
    branch: 'main',
    token: 'test-token-not-used-locally',
    actor: 'test-actor <test@test.com>',
    historyDir: env.historyDir,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let env: GitEnv;

beforeEach(() => {
  env = setupGitEnv();
});

afterEach(() => {
  try {
    rmSync(resolve(env.bare, '..'), { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// addRepo — happy path: validate → commit → re-read
// ---------------------------------------------------------------------------

describe('addRepo', () => {
  it('happy path: validate → commit → re-read', async () => {
    const opts = makeOpts(env);
    const result = await addRepo(
      { name: 'new-repo', gitUrl: 'https://github.com/example/new.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );
    expect(result.sha).toBeTruthy();
    expect(result.state.targets.repos).toHaveLength(2);
    expect(result.state.targets.repos.find((r) => r.name === 'new-repo')).toBeDefined();

    // Verify the committed allowlist is exactly what a subsequent loadTargets reads (consistency — ImplInv-9)
    const allowlist = loadAllowlist({ configDir: env.configDir });
    const targets = loadTargets(allowlist, { configDir: env.configDir });
    expect(targets.repos.find((r) => r.name === 'new-repo')).toBeDefined();
  });

  it('schema rejection → 422 (ValidationError thrown, nothing committed)', async () => {
    const opts = makeOpts(env);
    const headBefore = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();

    await expect(addRepo(
      { name: '', gitUrl: 'not-a-url', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    )).rejects.toBeInstanceOf(ValidationError);

    const headAfter = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// removeRepo
// ---------------------------------------------------------------------------

describe('removeRepo', () => {
  it('removes an existing repo', async () => {
    const opts = makeOpts(env);
    const result = await removeRepo('test-repo', opts);
    expect(result.state.targets.repos).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// editRepo
// ---------------------------------------------------------------------------

describe('editRepo', () => {
  it('disables an existing repo', async () => {
    const opts = makeOpts(env);
    const result = await editRepo('test-repo', { enabled: false }, opts);
    const repo = result.state.targets.repos.find((r) => r.name === 'test-repo');
    expect(repo?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addStagingTarget — with addHost = ONE commit touching both files
// ---------------------------------------------------------------------------

describe('addStagingTarget', () => {
  it('addHost=true → ONE commit touching both files', async () => {
    const opts = makeOpts(env);
    const stagingTarget = {
      name: 'staging-1',
      url: 'https://staging.example.com',
      repo: 'test-repo',
      activeScan: false,
      enabled: true,
    };

    const result = await addStagingTarget(stagingTarget, true, opts);

    expect(result.sha).toBeTruthy();
    expect(result.state.targets.stagingTargets).toHaveLength(1);
    expect(result.state.allowlist.hosts.some((h) => h.host === 'staging.example.com')).toBe(true);

    // Verify ONE commit (not two) touched BOTH files
    const commitFiles = execSync(
      `git diff-tree --no-commit-id -r --name-only ${result.sha}`,
      { cwd: env.clone, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort();

    expect(commitFiles).toContain('config/allowed-staging-hosts.json');
    expect(commitFiles).toContain('config/targets.json');
    // Must be exactly two files in one commit
    expect(commitFiles).toHaveLength(2);
  });

  it('addHost=false → only targets.json changed', async () => {
    // First add the host
    const opts = makeOpts(env);
    await addHost({ host: 'staging.example.com', owner: 'test', addedAt: new Date().toISOString() }, opts);

    const stagingTarget = {
      name: 'staging-1',
      url: 'https://staging.example.com',
      repo: 'test-repo',
      activeScan: false,
      enabled: true,
    };

    const result = await addStagingTarget(stagingTarget, false, opts);

    const commitFiles = execSync(
      `git diff-tree --no-commit-id -r --name-only ${result.sha}`,
      { cwd: env.clone, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort();

    expect(commitFiles).toContain('config/targets.json');
    expect(commitFiles).not.toContain('config/allowed-staging-hosts.json');
  });

  it('enabled staging target with non-allowlisted host → 422 ValidationError', async () => {
    const opts = makeOpts(env);
    const stagingTarget = {
      name: 'staging-bad',
      url: 'https://not-allowlisted.example.com',
      repo: 'test-repo',
      activeScan: false,
      enabled: true,
    };

    await expect(addStagingTarget(stagingTarget, false, opts)).rejects.toBeInstanceOf(ValidationError);
  });

  it('malformed host rejected by schema before commit', async () => {
    const opts = makeOpts(env);
    const headBefore = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();

    const stagingTarget = {
      name: 'staging-bad',
      url: 'https://192.168.1.1',  // IP literal — rejected by allowlist schema
      repo: 'test-repo',
      activeScan: false,
      enabled: true,
    };

    // This will fail because the addHost would add an IP which is rejected by AllowlistSchema
    await expect(addStagingTarget(stagingTarget, true, opts)).rejects.toBeInstanceOf(ValidationError);

    const headAfter = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// editStagingTarget, removeStagingTarget
// ---------------------------------------------------------------------------

describe('editStagingTarget + removeStagingTarget', () => {
  beforeEach(async () => {
    // Set up a staging target with its host on the allowlist
    const opts = makeOpts(env);
    await addStagingTarget(
      { name: 'staging-1', url: 'https://staging.example.com', repo: 'test-repo', activeScan: false, enabled: true },
      true,
      opts,
    );
  });

  it('editStagingTarget disables a target', async () => {
    const opts = makeOpts(env);
    const result = await editStagingTarget('staging-1', { enabled: false }, opts);
    expect(result.state.targets.stagingTargets.find((s) => s.name === 'staging-1')?.enabled).toBe(false);
  });

  it('removeStagingTarget removes a target', async () => {
    const opts = makeOpts(env);
    const result = await removeStagingTarget('staging-1', opts);
    expect(result.state.targets.stagingTargets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addHost + removeHost
// ---------------------------------------------------------------------------

describe('addHost', () => {
  it('adds a host to the allowlist', async () => {
    const opts = makeOpts(env);
    const result = await addHost({ host: 'example.com', owner: 'test', addedAt: new Date().toISOString() }, opts);
    expect(result.state.allowlist.hosts.some((h) => h.host === 'example.com')).toBe(true);
  });
});

describe('removeHost', () => {
  beforeEach(async () => {
    const opts = makeOpts(env);
    await addHost({ host: 'example.com', owner: 'test', addedAt: new Date().toISOString() }, opts);
  });

  it('removes a host not in use', async () => {
    const opts = makeOpts(env);
    const result = await removeHost('example.com', opts);
    expect(result.state.allowlist.hosts.some((h) => h.host === 'example.com')).toBe(false);
  });

  it('host in use by an enabled staging target → 409 HostInUseError, nothing committed', async () => {
    const opts = makeOpts(env);
    // Add a staging target using the host
    await addStagingTarget(
      { name: 'staging-1', url: 'https://example.com', repo: 'test-repo', activeScan: false, enabled: true },
      false,
      opts,
    );

    const headBefore = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();
    await expect(removeHost('example.com', opts)).rejects.toBeInstanceOf(HostInUseError);
    const headAfter = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// revertConfigCommit
// ---------------------------------------------------------------------------

describe('revertConfigCommit', () => {
  it('revert makes a reverting commit that restores the previous state', async () => {
    const opts = makeOpts(env);
    // Add a repo
    const addResult = await addRepo(
      { name: 'to-revert', gitUrl: 'https://github.com/example/rev.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );
    expect(addResult.state.targets.repos).toHaveLength(2);

    // Revert the add
    const revertResult = await revertConfigCommit(addResult.sha, opts);
    expect(revertResult.sha).toBeTruthy();
    expect(revertResult.sha).not.toBe(addResult.sha);
    expect(revertResult.state.targets.repos).toHaveLength(1);
    expect(revertResult.state.targets.repos.find((r) => r.name === 'to-revert')).toBeUndefined();

    // The revert commit should have the config(dashboard): prefix
    const revertMsg = execSync(`git log --format=%s -1 ${revertResult.sha}`, { cwd: env.clone, encoding: 'utf8' }).trim();
    expect(revertMsg).toMatch(/^config\(dashboard\):/);
  });

  it('revert of a non-config(dashboard) commit → NotARevertableConfigCommitError', async () => {
    // Create a non-config commit manually
    git(['config', 'user.name', 'Test'], env.clone);
    git(['config', 'user.email', 'test@test.com'], env.clone);

    writeFileSync(join(env.clone, 'README.md'), 'hello\n', 'utf8');
    git(['add', 'README.md'], env.clone);
    git(['commit', '-m', 'add readme'], env.clone);
    git(['push', 'origin', 'HEAD:main'], env.clone);

    const nonConfigSha = execSync('git rev-parse HEAD', { cwd: env.clone, encoding: 'utf8' }).trim();
    const opts = makeOpts(env);

    await expect(revertConfigCommit(nonConfigSha, opts)).rejects.toBeInstanceOf(NotARevertableConfigCommitError);
  });
});

// ---------------------------------------------------------------------------
// listHistory
// ---------------------------------------------------------------------------

describe('listHistory', () => {
  it('history reads back after a write', async () => {
    const opts = makeOpts(env);
    const addResult = await addRepo(
      { name: 'for-history', gitUrl: 'https://github.com/example/h.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );

    const { entries } = await listHistory(10, { configRepoDir: env.clone, historyDir: env.historyDir });
    expect(entries.some((e) => e.sha === addResult.sha)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit cache append failure after push → 200 + auditWarning (D1)
// ---------------------------------------------------------------------------

describe('audit append failure → auditWarning (D1)', () => {
  it('audit-append-failure-after-push → result has auditWarning, sha is set', async () => {
    // Make the audit path invalid by using a null-byte in the path (invalid on all platforms)
    // Use a file path that points to an existing DIRECTORY (so appendFileSync fails)
    const tmpBase = mkdtempSync(join(tmpdir(), 'audit-warn-test-'));
    // The historyDir is the tmpBase dir, but config-audit.jsonl path IS the dir itself
    // We simulate by making the path a directory: create a dir named 'config-audit.jsonl'
    const fakeHistoryDir = join(tmpBase, 'history');
    mkdirSync(fakeHistoryDir, { recursive: true });
    // Create a directory where the JSONL file would be — writing to a dir fails
    mkdirSync(join(fakeHistoryDir, 'config-audit.jsonl'), { recursive: true });

    const opts: WriteServiceOpts = {
      ...makeOpts(env),
      historyDir: fakeHistoryDir,
    };

    // The write should still succeed (git push happened), just with auditWarning
    const result = await addRepo(
      { name: 'audit-warn-repo', gitUrl: 'https://github.com/example/aw.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );

    expect(result.sha).toBeTruthy();
    expect(result.auditWarning).toBeDefined();
    expect(result.auditWarning).toContain('Audit append failed');

    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
});

// ---------------------------------------------------------------------------
// Consistency: committed allowlist is exactly what loadTargets reads (ImplInv-9)
// ---------------------------------------------------------------------------

describe('consistency: committed allowlist == what loadTargets reads (ImplInv-9)', () => {
  it('write then read via loadTargets/loadAllowlist sees same state', async () => {
    const opts = makeOpts(env);
    const writeResult = await addRepo(
      { name: 'consistency-repo', gitUrl: 'https://github.com/example/c.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );

    const allowlist = loadAllowlist({ configDir: env.configDir });
    const targets = loadTargets(allowlist, { configDir: env.configDir });

    // What the UI returned == what loadTargets reads
    expect(targets.repos).toEqual(writeResult.state.targets.repos);
    expect(allowlist.hosts).toEqual(writeResult.state.allowlist.hosts);
  });
});

// ---------------------------------------------------------------------------
// Commit message has config(dashboard): prefix (required for revert filter)
// ---------------------------------------------------------------------------

describe('commit message prefix', () => {
  it('every write uses config(dashboard): prefix', async () => {
    const opts = makeOpts(env);
    const result = await addRepo(
      { name: 'prefix-test', gitUrl: 'https://github.com/example/pt.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      opts,
    );

    const msg = execSync(`git log --format=%s -1 ${result.sha}`, { cwd: env.clone, encoding: 'utf8' }).trim();
    expect(msg).toMatch(/^config\(dashboard\):/);
  });
});

// ---------------------------------------------------------------------------
// NoChangeError when content is identical
// ---------------------------------------------------------------------------

describe('NoChangeError on no-op write', () => {
  it('editing a repo with no change → NoChangeError', async () => {
    // First read the current state to get accurate existing data
    const opts = makeOpts(env);
    // Attempt to add the same repo that already exists with identical data
    // editRepo with an empty patch will generate identical content
    await expect(
      editRepo('test-repo', {}, opts),
    ).rejects.toBeInstanceOf(NoChangeError);
  });
});
