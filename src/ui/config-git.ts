/**
 * src/ui/config-git.ts — git adapter for config writes.
 *
 * Owns: working clone, token channel (GIT_ASKPASS / scoped spawn-env),
 * explicit-path staging, path-limited rollback, push-failure replay-once,
 * and the constrained revert primitive.
 *
 * Safety invariants carried here (binding — a violation is wrong even if a test passes):
 *   ImplInv-1: only CONFIG_PATHS are ever staged (never git add -A / git add .)
 *   ImplInv-2: assertConfigWorktreeClean() runs before writes and before fetch/ff
 *   ImplInv-3: token reaches git ONLY via GIT_ASKPASS in the explicit spawn env
 *              of authenticated calls; never on process.env; scrubbed from all output
 *   ImplInv-7: rollback is reset --soft + restore --staged --worktree; never reset --hard;
 *              post-rollback: no CONFIG_PATH staged; non-config state preserved
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm, access, chmod } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withWorkspaceLock } from '../report/lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ImplInv-1: frozen whitelist — the ONLY paths ever staged.
const CONFIG_PATHS: readonly string[] = Object.freeze([
  'config/targets.json',
  'config/allowed-staging-hosts.json',
]);

// Path to the GIT_ASKPASS helper shipped with this module.
const ASKPASS_HELPER_PATH = join(__dirname, 'git-askpass.cjs');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfigFileWrite {
  /** Relative path within the repo, e.g. 'config/targets.json'. Must be in CONFIG_PATHS. */
  path: string;
  content: string;
}

export interface ConfigCommit {
  sha: string;
  message: string;
  authorDate: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class ConfigWorktreeDirtyError extends Error {
  readonly kind = 'ConfigWorktreeDirtyError' as const;
  constructor(detail: string) {
    super(`Config worktree dirty — manual reconciliation needed: ${detail}`);
    this.name = 'ConfigWorktreeDirtyError';
  }
}

export class GitPushError extends Error {
  readonly kind = 'GitPushError' as const;
  constructor(detail: string) {
    super(`Git push failed: ${detail}`);
    this.name = 'GitPushError';
  }
}

export class GitRollbackFailedError extends Error {
  readonly kind = 'GitRollbackFailedError' as const;
  constructor(detail: string) {
    super(`Git rollback left config paths staged — index is dirty: ${detail}`);
    this.name = 'GitRollbackFailedError';
  }
}

export class NotARevertableConfigCommitError extends Error {
  readonly kind = 'NotARevertableConfigCommitError' as const;
  constructor(detail: string) {
    super(`Not a revertable config commit: ${detail}`);
    this.name = 'NotARevertableConfigCommitError';
  }
}

// ---------------------------------------------------------------------------
// Internal git runner
// ---------------------------------------------------------------------------

interface RunGitOpts {
  /** When true, supplies the write token via GIT_ASKPASS (scoped spawn env only). */
  withToken?: boolean;
  /**
   * The write token. Required when withToken is true.
   * NEVER passed to read-only git calls.
   */
  token?: string;
  /** Working directory for the git command. */
  cwd?: string;
  /** Environment variables to add to the minimal env. */
  extraEnv?: Record<string, string>;
  /** Hard timeout (ms) — kills the git process so a hung remote can't hold the lock. Default 30s. */
  timeoutMs?: number;
}

interface RunGitResult {
  stdout: string;
  stderr: string;
}

/**
 * Redact the token pattern from any string surface before it is thrown or returned.
 * Handles the raw token value wherever it might appear.
 */
function scrubToken(text: string, token: string | undefined): string {
  if (!token || token.length === 0) return text;
  // Escape regex special chars in the token, then replace all occurrences.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '<REDACTED>');
}

/**
 * Single internal git runner. Token scoping + scrubbing in one place.
 *
 * IMPORTANT (ImplInv-3):
 * - Read-only calls (status, diff, log, show): withToken MUST be false/absent.
 * - Authenticated calls (clone, fetch, push): withToken: true, token: <value>.
 * - The token is NEVER placed on process.env.
 * - All surfaced output (stdout, stderr, thrown errors) passes through scrubToken.
 */
async function runGit(args: string[], opts: RunGitOpts = {}): Promise<RunGitResult> {
  const { withToken = false, token, cwd, extraEnv } = opts;

  // Build a minimal environment — inherit only what git needs.
  // ImplInv-3: token lives ONLY in the spawn env of authenticated calls.
  const spawnEnv: Record<string, string> = {
    HOME: process.env['HOME'] ?? '',
    PATH: process.env['PATH'] ?? '',
    // Needed on some systems for git to locate SSL certs
    GIT_SSL_CAINFO: process.env['GIT_SSL_CAINFO'] ?? '',
    // Allow git to find its system config
    GIT_CONFIG_SYSTEM: process.env['GIT_CONFIG_SYSTEM'] ?? '',
    GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'] ?? '',
    // Windows-specific: git needs these for the credential store
    USERPROFILE: process.env['USERPROFILE'] ?? '',
    APPDATA: process.env['APPDATA'] ?? '',
    // Disable interactive prompts so git fails fast instead of blocking
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: withToken ? ASKPASS_HELPER_PATH : '',
  };

  if (withToken) {
    if (!token) throw new Error('runGit: withToken=true but no token provided');
    // ImplInv-3: token ONLY in scoped spawn env, only for authenticated spawns.
    spawnEnv['AUDIT_GIT_ASKPASS_TOKEN'] = token;
  }

  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      spawnEnv[k] = v;
    }
  }

  return new Promise((resolveP, rejectP) => {
    const proc = spawn('git', args, {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Bound every git op so a slow/hung remote (clone/fetch on the request path)
    // can't hold the config-write lock indefinitely (adversarial 5-B).
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectP(new Error(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
        return;
      }
      const stdout = scrubToken(Buffer.concat(stdoutChunks).toString('utf8'), token);
      const stderr = scrubToken(Buffer.concat(stderrChunks).toString('utf8'), token);

      if (code === 0) {
        resolveP({ stdout, stderr });
      } else {
        const err = new Error(
          scrubToken(`git ${args[0] ?? ''} failed (exit ${code ?? 'null'}): ${stderr.trim()}`, token),
        );
        rejectP(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const scrubbed = new Error(scrubToken(err.message, token));
      rejectP(scrubbed);
    });
  });
}

// ---------------------------------------------------------------------------
// Opts type for ensureClone
// ---------------------------------------------------------------------------

export interface EnsureCloneOpts {
  configRepoDir: string;
  remoteUrl: string;
  branch: string;
  token: string;
  /** Git author identity, e.g. "sectool <ops@example.com>". */
  gitAuthor?: string;
}

// ---------------------------------------------------------------------------
// Derive lock path from configRepoDir — shared by ensureClone and commitConfigChange.
// ---------------------------------------------------------------------------

function configLockPath(configRepoDir: string): string {
  return resolve(configRepoDir, '.config-write-lock');
}

// ---------------------------------------------------------------------------
// ensureClone
// ---------------------------------------------------------------------------

/**
 * Ensure the working config clone exists at configRepoDir.
 * - If absent (or not a git repo): git clone.
 * - If present: assertConfigWorktreeClean() + git fetch + fast-forward.
 *
 * Runs under the config-specific lock (ImplInv concurrency).
 * Token is supplied via GIT_ASKPASS (ImplInv-3).
 */
export async function ensureClone(opts: EnsureCloneOpts): Promise<void> {
  const { configRepoDir, remoteUrl, branch, token, gitAuthor } = opts;
  const lockPath = configLockPath(configRepoDir);

  await withWorkspaceLock(async () => {
    const isGitRepo = await access(join(configRepoDir, '.git'), fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);

    const tokenOpts = { withToken: true, token };

    if (!isGitRepo) {
      // git clone creates configRepoDir itself; ensure only the parent exists.
      await mkdir(join(configRepoDir, '..'), { recursive: true });
      // Remove the dir if it exists but is not a git repo (so clone can create it)
      try {
        await rm(configRepoDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      await runGit(
        ['clone', '-c', 'core.autocrlf=false', '--branch', branch, remoteUrl, configRepoDir],
        { ...tokenOpts },
      );
    } else {
      // ImplInv-2: fail closed if config paths are dirty before fetch/ff
      await assertConfigWorktreeClean({ configRepoDir, branch });

      await runGit(['fetch', 'origin'], { ...tokenOpts, cwd: configRepoDir });

      // Fast-forward current branch to origin/<branch>
      await runGit(['merge', '--ff-only', `origin/${branch}`], {
        cwd: configRepoDir,
        // read-only merge — no token (ImplInv-3)
      });
    }

    // Configure author identity if provided
    if (gitAuthor) {
      const match = /^(.+?)\s+<(.+?)>$/.exec(gitAuthor);
      if (match) {
        const [, name, email] = match;
        await runGit(['config', 'user.name', name!], { cwd: configRepoDir });
        await runGit(['config', 'user.email', email!], { cwd: configRepoDir });
      }
    }
  }, { lockPath });
}

// ---------------------------------------------------------------------------
// assertConfigWorktreeClean
// ---------------------------------------------------------------------------

interface AssertCleanOpts {
  configRepoDir: string;
  branch: string;
}

/**
 * Assert that:
 * 1. HEAD is on the expected branch (not detached).
 * 2. None of the CONFIG_PATHS have uncommitted changes in the index or worktree.
 *
 * Non-config paths are ignored (ImplInv-2).
 * Throws ConfigWorktreeDirtyError or a plain Error on wrong branch / detached HEAD.
 */
export async function assertConfigWorktreeClean(opts: AssertCleanOpts): Promise<void> {
  const { configRepoDir, branch } = opts;

  // Check HEAD is on the right branch (not detached)
  let headBranch: string;
  try {
    const { stdout } = await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: configRepoDir });
    headBranch = stdout.trim();
  } catch {
    throw new ConfigWorktreeDirtyError('HEAD is detached — cannot write config');
  }

  if (headBranch !== branch) {
    throw new ConfigWorktreeDirtyError(
      `HEAD is on branch '${headBranch}', expected '${branch}'`,
    );
  }

  // Check config paths for dirty state (ImplInv-2)
  const { stdout } = await runGit(
    ['status', '--porcelain', '--', ...CONFIG_PATHS],
    { cwd: configRepoDir },
  );

  if (stdout.trim().length > 0) {
    throw new ConfigWorktreeDirtyError(
      `Uncommitted changes in config paths:\n${stdout.trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// commitConfigChange
// ---------------------------------------------------------------------------

export interface CommitConfigChangeOpts {
  configRepoDir: string;
  remoteUrl: string;
  branch: string;
  token: string;
  /** Audit trailer fields */
  actor: string;
  action: string;
  target: string;
}

/**
 * Write config files, stage (CONFIG_PATHS only — never git add -A), commit, and push.
 * Returns the pushed commit SHA.
 *
 * On push failure: path-limited rollback (reset --soft + restore), then:
 * - Non-FF: fetch + replay-once before giving up.
 * - Still fails: rollback + GitPushError.
 *
 * ImplInv-1,2,3,7 are all enforced here.
 */
export async function commitConfigChange(
  files: ConfigFileWrite[],
  message: string,
  opts: CommitConfigChangeOpts,
): Promise<{ sha: string }> {
  const { configRepoDir, remoteUrl, branch, token } = opts;
  // Sanitize audit-trailer fields: strip CR/LF so a value can't forge an extra
  // trailer line in the commit message (adversarial 4-A — defence in depth; the
  // Zod schemas already reject newlines in host/repo names, but the trailer
  // assembly must not rely on that implicitly).
  const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
  const actor = oneLine(opts.actor);
  const action = oneLine(opts.action);
  const target = oneLine(opts.target);

  // Validate that callers only pass whitelisted paths (ImplInv-1)
  for (const f of files) {
    if (!CONFIG_PATHS.includes(f.path)) {
      throw new Error(
        `commitConfigChange: path '${f.path}' is not in CONFIG_PATHS whitelist`,
      );
    }
  }

  const lockPath = configLockPath(configRepoDir);

  return withWorkspaceLock(async () => {
    // ImplInv-2: assert clean before writing
    await assertConfigWorktreeClean({ configRepoDir, branch });

    // Capture priorHead before any mutation (ImplInv-7)
    const { stdout: headOut } = await runGit(['rev-parse', 'HEAD'], { cwd: configRepoDir });
    const priorHead = headOut.trim();

    // Write the files to disk
    for (const f of files) {
      const absPath = join(configRepoDir, f.path);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, f.content, 'utf8');
    }

    // Stage ONLY the whitelisted CONFIG_PATHS (ImplInv-1: NEVER git add -A / git add .)
    await runGit(['add', '--', ...CONFIG_PATHS], { cwd: configRepoDir });

    // Build commit message with audit trailers
    const now = new Date().toUTCString();
    const fullMessage = [
      message,
      '',
      `Audit-Actor: ${actor}`,
      `Audit-Action: ${action}`,
      `Audit-Target: ${target}`,
      `Audit-Time: ${now}`,
    ].join('\n');

    // Commit (no push yet — this is reversible)
    await runGit(['commit', '--message', fullMessage], { cwd: configRepoDir });

    // Push is the commit point (ImplInv-7)
    const pushResult = await tryPush({ configRepoDir, remoteUrl, branch, token, priorHead });

    if (pushResult.kind === 'non-ff') {
      // Replay-once: fetch + merge ff + retry push
      await runGit(['fetch', 'origin'], { withToken: true, token, cwd: configRepoDir });

      // We're on the same branch; first roll back our commit to re-apply on top
      await runGit(['reset', '--soft', priorHead], { cwd: configRepoDir });
      await runGit(['restore', '--staged', '--worktree', '--source', priorHead, '--', ...CONFIG_PATHS], {
        cwd: configRepoDir,
      });

      // Fast-forward to origin
      await runGit(['merge', '--ff-only', `origin/${branch}`], { cwd: configRepoDir });

      // Re-stage and re-commit
      for (const f of files) {
        const absPath = join(configRepoDir, f.path);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, f.content, 'utf8');
      }
      await runGit(['add', '--', ...CONFIG_PATHS], { cwd: configRepoDir });

      const newHead = (await runGit(['rev-parse', 'HEAD'], { cwd: configRepoDir })).stdout.trim();

      await runGit(['commit', '--message', fullMessage], { cwd: configRepoDir });

      const retryPush = await tryPush({ configRepoDir, remoteUrl, branch, token, priorHead: newHead });

      if (retryPush.kind !== 'ok') {
        // Still failing — path-limited rollback + error
        await pathLimitedRollback(configRepoDir, newHead);
        throw new GitPushError(scrubToken(retryPush.detail, token));
      }

      return { sha: retryPush.sha };
    }

    if (pushResult.kind === 'error') {
      // Path-limited rollback (ImplInv-7)
      await pathLimitedRollback(configRepoDir, priorHead);
      throw new GitPushError(scrubToken(pushResult.detail, token));
    }

    return { sha: pushResult.sha };
  }, { lockPath });
}

/**
 * Read the current HEAD SHA of the config working clone (read-only; NO token).
 * Used to pin a scan dispatch to the exact committed config (ImplInv-6 — so a
 * scan reads the same config the dashboard shows). Returns null if the dir is
 * not a git repo (or git fails), so callers can omit config_sha.
 */
export async function currentConfigSha(configRepoDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: configRepoDir });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: tryPush
// ---------------------------------------------------------------------------

type PushResult =
  | { kind: 'ok'; sha: string }
  | { kind: 'non-ff'; detail: string }
  | { kind: 'error'; detail: string };

async function tryPush(opts: {
  configRepoDir: string;
  remoteUrl: string;
  branch: string;
  token: string;
  priorHead: string;
}): Promise<PushResult> {
  const { configRepoDir, remoteUrl, branch, token } = opts;

  try {
    await runGit(['push', remoteUrl, `HEAD:refs/heads/${branch}`], {
      withToken: true,
      token,
      cwd: configRepoDir,
    });

    // Capture the pushed SHA
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: configRepoDir });
    return { kind: 'ok', sha: stdout.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect non-fast-forward by git's standard message
    if (/non-fast-forward|fetch first|remote rejected/i.test(msg)) {
      return { kind: 'non-ff', detail: msg };
    }
    return { kind: 'error', detail: msg };
  }
}

// ---------------------------------------------------------------------------
// Internal: pathLimitedRollback (ImplInv-7)
// ---------------------------------------------------------------------------

/**
 * Roll back a failed push:
 * 1. git reset --soft <priorHead>  — un-commit; leaves config files staged.
 * 2. git restore --staged --worktree --source=<priorHead> -- <CONFIG_PATHS>
 *    — restore config files in BOTH index and worktree from priorHead.
 * 3. Assert no CONFIG_PATH remains staged (else GitRollbackFailedError → 500).
 * NEVER uses reset --hard (would destroy non-config state).
 */
async function pathLimitedRollback(configRepoDir: string, priorHead: string): Promise<void> {
  await runGit(['reset', '--soft', priorHead], { cwd: configRepoDir });
  await runGit(
    ['restore', '--staged', '--worktree', '--source', priorHead, '--', ...CONFIG_PATHS],
    { cwd: configRepoDir },
  );

  // Post-rollback assertion: no CONFIG_PATH may remain staged (ImplInv-7)
  const { stdout } = await runGit(
    ['diff', '--cached', '--name-only', '--', ...CONFIG_PATHS],
    { cwd: configRepoDir },
  );

  const remaining = stdout.trim().split('\n').filter((l) => l.length > 0);
  if (remaining.length > 0) {
    throw new GitRollbackFailedError(
      `Config paths still staged after rollback: ${remaining.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// recentConfigCommits
// ---------------------------------------------------------------------------

/**
 * Return the N most recent commits on the current branch whose messages
 * start with 'config(dashboard):'.
 */
export async function recentConfigCommits(
  n: number,
  opts: { configRepoDir: string },
): Promise<ConfigCommit[]> {
  const { configRepoDir } = opts;

  const { stdout } = await runGit(
    [
      'log',
      `--max-count=${n}`,
      '--grep=^config(dashboard):',
      '--format=%H%x1f%s%x1f%aI',
    ],
    { cwd: configRepoDir },
  );

  const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
  return lines.map((line) => {
    const parts = line.split('\x1f');
    return {
      sha: parts[0] ?? '',
      message: parts[1] ?? '',
      authorDate: parts[2] ?? '',
    };
  });
}

// ---------------------------------------------------------------------------
// computeConfigRevert
// ---------------------------------------------------------------------------

/**
 * Validate that commitSha is a revertable config(dashboard) commit, then
 * return the PARENT's config blob contents (what reverting would produce).
 *
 * Validation rules (ImplInv-4):
 * 1. Commit message must start with 'config(dashboard):'.
 * 2. Diff must touch ONLY paths in CONFIG_PATHS.
 *
 * Returns the files to pass to commitConfigChange (caller validates schema + commits).
 * Uses only read-only git (git show, git diff-tree) — NO token.
 */
export async function computeConfigRevert(
  commitSha: string,
  opts: { configRepoDir: string },
): Promise<{ files: ConfigFileWrite[] }> {
  const { configRepoDir } = opts;

  // SAFETY (adversarial 2-A): the commitSha comes from a URL route param and is
  // interpolated into git revspecs (log/diff-tree/rev-parse/show). Without this
  // guard, an attacker with a step-up cookie could pass an arbitrary revspec
  // (`HEAD`, `HEAD~2`, a tag, `refs/...`) and revert a commit they didn't name.
  // Require a full 40-hex SHA-1 — this collapses the entire revspec surface to a
  // bare object id, excluding every symbolic/relative form (they contain non-hex
  // chars) before any git call runs.
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new NotARevertableConfigCommitError(
      `Invalid commit ref: must be a full 40-hex commit SHA`,
    );
  }

  // Validate commit message prefix
  const { stdout: msgOut } = await runGit(
    ['log', '--format=%s', '-1', commitSha],
    { cwd: configRepoDir },
  );
  const subject = msgOut.trim();

  if (!subject.startsWith('config(dashboard):')) {
    throw new NotARevertableConfigCommitError(
      `Commit ${commitSha} message '${subject}' does not start with 'config(dashboard):'`,
    );
  }

  // Validate that the diff touches ONLY config paths
  const { stdout: diffOut } = await runGit(
    ['diff-tree', '--no-commit-id', '-r', '--name-only', commitSha],
    { cwd: configRepoDir },
  );

  const changedPaths = diffOut.trim().split('\n').filter((l) => l.length > 0);
  const nonConfigPaths = changedPaths.filter((p) => !CONFIG_PATHS.includes(p));

  if (nonConfigPaths.length > 0) {
    throw new NotARevertableConfigCommitError(
      `Commit ${commitSha} touches non-config paths: ${nonConfigPaths.join(', ')}`,
    );
  }

  if (changedPaths.length === 0) {
    throw new NotARevertableConfigCommitError(
      `Commit ${commitSha} touches no config paths`,
    );
  }

  // Get the parent SHA
  const { stdout: parentOut } = await runGit(
    ['rev-parse', `${commitSha}^`],
    { cwd: configRepoDir },
  );
  const parentSha = parentOut.trim();

  // Read the parent's config blobs for all changed config paths
  const files: ConfigFileWrite[] = [];
  for (const p of changedPaths) {
    let content: string;
    try {
      const { stdout: blobOut } = await runGit(
        ['show', `${parentSha}:${p}`],
        { cwd: configRepoDir },
      );
      content = blobOut;
    } catch {
      // File didn't exist in parent (this commit added it) — revert means deleting.
      // We represent deletion as an empty JSON object placeholder for schema validation.
      // The caller (C4 revertConfigCommit) is responsible for interpreting this.
      content = '';
    }
    files.push({ path: p, content });
  }

  return { files };
}

// ---------------------------------------------------------------------------
// generateAskpassHelper (utility for testing / first-time setup)
// ---------------------------------------------------------------------------

/**
 * Ensure the askpass helper is executable on Unix-like systems.
 * On Windows this is a no-op (git for Windows handles the shebang).
 * Called lazily — only once per process start if needed.
 */
export async function ensureAskpassExecutable(): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(ASKPASS_HELPER_PATH, 0o700);
  } catch {
    // Best-effort — if the file is already executable or doesn't exist, ignore.
  }
}

// Ensure the askpass helper is executable on module load (non-blocking side-effect).
void ensureAskpassExecutable();

// Export CONFIG_PATHS for consumers that need to know the whitelist (e.g. tests).
export { CONFIG_PATHS };

// Export scrubToken so C4 can redact the token from surfaced error bodies (ImplInv-3).
export { scrubToken };
