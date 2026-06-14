/**
 * src/ui/config-write.ts — config-write service (deep module).
 *
 * Owns: read-current → mutate-in-memory → validate-post-change → commitConfigChange → audit → re-read.
 * Never spawns git directly — all git operations go through config-git.ts (M4).
 *
 * Safety invariants (carried here):
 *   ImplInv-4: revert only applies to config(dashboard) commits; full re-validation before commit.
 *   ImplInv-5: pushed commit is source of truth; audit cache is best-effort.
 *   ImplInv-8: every mutation is schema-validated before commitConfigChange is called.
 *   ImplInv-9: readers and writers share the same configDir (post-push re-read uses same path).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AllowlistSchema } from '../schemas/allowlist.js';
import { TargetRegistrySchema } from '../schemas/targets.js';
import type { Allowlist, AllowlistEntry } from '../schemas/allowlist.js';
import type { TargetRegistry, RepoTarget, StagingTarget } from '../schemas/targets.js';
import {
  commitConfigChange,
  recentConfigCommits,
  computeConfigRevert,
  NotARevertableConfigCommitError,
  ConfigWorktreeDirtyError,
  GitPushError,
  GitRollbackFailedError,
  scrubToken,
} from './config-git.js';
import type { ConfigFileWrite } from './config-git.js';
import { appendAuditEntry, readAuditChain, CONFIG_AUDIT_PATH } from './config-audit-cache.js';
import type { AuditEntry } from './config-audit-cache.js';

// ---------------------------------------------------------------------------
// Types: mutation opts shared by all write service calls
// ---------------------------------------------------------------------------

export interface WriteServiceOpts {
  configRepoDir: string;
  configDir: string;
  remoteUrl: string;
  branch: string;
  token: string;
  actor: string;
  historyDir: string;
}

// Result returned on success
export interface WriteResult {
  state: { targets: TargetRegistry; allowlist: Allowlist };
  sha: string;
  auditWarning?: string;
}

// ---------------------------------------------------------------------------
// Read helpers — read current on-disk state for mutation base
// ---------------------------------------------------------------------------

function readTargets(configDir: string): TargetRegistry {
  const raw = JSON.parse(readFileSync(join(configDir, 'targets.json'), 'utf8')) as unknown;
  const result = TargetRegistrySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid targets config: ${result.error.message}`);
  }
  return result.data;
}

function readAllowlist(configDir: string): Allowlist {
  const raw = JSON.parse(readFileSync(join(configDir, 'allowed-staging-hosts.json'), 'utf8')) as unknown;
  const result = AllowlistSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid allowlist: ${result.error.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Validation: validate post-change projection (D7 — same schemas the CLI uses)
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly kind = 'ValidationError' as const;
  readonly issues: unknown[];
  constructor(message: string, issues: unknown[]) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class HostInUseError extends Error {
  readonly kind = 'HostInUseError' as const;
  readonly host: string;
  constructor(host: string) {
    super(`Host "${host}" is still in use by an enabled staging target`);
    this.name = 'HostInUseError';
    this.host = host;
  }
}

export class NoChangeError extends Error {
  readonly kind = 'NoChangeError' as const;
  constructor() {
    super('No change — proposed config content is identical to current');
    this.name = 'NoChangeError';
  }
}

export type WriteServiceError =
  | ValidationError
  | HostInUseError
  | NoChangeError
  | ConfigWorktreeDirtyError
  | GitPushError
  | GitRollbackFailedError
  | NotARevertableConfigCommitError;

/**
 * Validate the proposed targets + allowlist together.
 * The cross-check (enabled staging target host ∈ allowlist) is run here
 * against the IN-MEMORY post-change state (D7 — never a disk re-read).
 */
function validateProjection(
  targets: TargetRegistry,
  allowlist: Allowlist,
): ValidationError | null {
  const targetsResult = TargetRegistrySchema.safeParse(targets);
  if (!targetsResult.success) {
    return new ValidationError(targetsResult.error.message, targetsResult.error.issues);
  }

  const allowlistResult = AllowlistSchema.safeParse(allowlist);
  if (!allowlistResult.success) {
    return new ValidationError(allowlistResult.error.message, allowlistResult.error.issues);
  }

  // Host↔allowlist cross-check (mirror of loadTargets logic)
  const allowedHosts = new Set(allowlist.hosts.map((e) => e.host));
  for (const target of targets.stagingTargets) {
    if (!target.enabled) continue;
    let host: string;
    try {
      host = new URL(target.url).hostname;
    } catch {
      const msg = `Invalid URL in staging target "${target.name}": ${target.url}`;
      return new ValidationError(msg, [{ message: msg }]);
    }
    if (!allowedHosts.has(host)) {
      const msg = `Enabled staging target "${target.name}" host "${host}" is not on the allowlist`;
      return new ValidationError(msg, [{ message: msg }]);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Files serializer — convert in-memory state to file writes
// ---------------------------------------------------------------------------

function targetsFile(targets: TargetRegistry): ConfigFileWrite {
  return {
    path: 'config/targets.json',
    content: JSON.stringify(targets, null, 2) + '\n',
  };
}

function allowlistFile(allowlist: Allowlist): ConfigFileWrite {
  return {
    path: 'config/allowed-staging-hosts.json',
    content: JSON.stringify(allowlist, null, 2) + '\n',
  };
}

// ---------------------------------------------------------------------------
// Core write executor
// ---------------------------------------------------------------------------

/**
 * Core write path:
 * 1. Validate post-change projection.
 * 2. Check for no-op (content identity).
 * 3. commitConfigChange.
 * 4. Best-effort audit append + re-read (D1).
 * Returns WriteResult or throws a typed error.
 */
async function executeWrite(
  files: ConfigFileWrite[],
  targets: TargetRegistry,
  allowlist: Allowlist,
  message: string,
  action: string,
  actionTarget: string,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configRepoDir, configDir, remoteUrl, branch, token, actor, historyDir } = opts;

  // Validate
  const validationErr = validateProjection(targets, allowlist);
  if (validationErr !== null) {
    throw validationErr;
  }

  // Check for content identity (no-op guard from C3 learnings)
  const currentContents = files.map((f) => {
    const absPath = join(configRepoDir, f.path);
    try {
      return readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
  });

  const isNoOp = files.every((f, i) => currentContents[i] === f.content);
  if (isNoOp) {
    throw new NoChangeError();
  }

  // Commit — the commit point (ImplInv-5)
  const { sha } = await commitConfigChange(files, message, {
    configRepoDir,
    remoteUrl,
    branch,
    token,
    actor,
    action,
    target: actionTarget,
  });

  // Best-effort audit + re-read (D1 — failure here does NOT imply rollback)
  let auditWarning: string | undefined;

  try {
    appendAuditEntry(
      { at: new Date().toISOString(), actor, action, target: actionTarget, commitSha: sha },
      CONFIG_AUDIT_PATH(historyDir),
    );
  } catch (auditErr) {
    auditWarning = `Audit append failed after successful push: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`;
  }

  let finalTargets: TargetRegistry;
  let finalAllowlist: Allowlist;
  try {
    finalTargets = readTargets(configDir);
    finalAllowlist = readAllowlist(configDir);
  } catch (rereadErr) {
    if (auditWarning === undefined) {
      auditWarning = `Re-read failed after successful push: ${rereadErr instanceof Error ? rereadErr.message : String(rereadErr)}`;
    }
    // Fall back to the in-memory projection we just validated
    finalTargets = targets;
    finalAllowlist = allowlist;
  }

  const result: WriteResult = {
    state: { targets: finalTargets, allowlist: finalAllowlist },
    sha,
  };
  if (auditWarning !== undefined) result.auditWarning = auditWarning;
  return result;
}

// ---------------------------------------------------------------------------
// Public mutation functions — one per mutation kind (§6)
// ---------------------------------------------------------------------------

export async function addRepo(
  repo: Partial<RepoTarget> & { name: string },
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  // Normalise a minimal UI payload ({ name, gitUrl }) into a schema-valid repo
  // entry by filling the fields the form doesn't collect. executeWrite still
  // validates the result, so an invalid gitUrl etc. is rejected before commit.
  const fullRepo: RepoTarget = {
    name: repo.name,
    gitUrl: repo.gitUrl ?? '',
    localPath: repo.localPath ?? null,
    stackTags: repo.stackTags ?? [],
    publicRoutes: repo.publicRoutes ?? [],
    enabled: repo.enabled ?? true,
  };

  const newTargets: TargetRegistry = {
    ...targets,
    repos: [...targets.repos, fullRepo],
  };

  const files = [targetsFile(newTargets)];
  return executeWrite(
    files, newTargets, allowlist,
    `config(dashboard): add repo ${fullRepo.name}`,
    'add-repo', fullRepo.name, opts,
  );
}

export async function editRepo(
  name: string,
  patch: Partial<RepoTarget>,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  const repos = targets.repos.map((r) =>
    r.name === name ? { ...r, ...patch } : r,
  );
  const newTargets: TargetRegistry = { ...targets, repos };

  const files = [targetsFile(newTargets)];
  return executeWrite(
    files, newTargets, allowlist,
    `config(dashboard): edit repo ${name}`,
    'edit-repo', name, opts,
  );
}

export async function removeRepo(
  name: string,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  const newTargets: TargetRegistry = {
    ...targets,
    repos: targets.repos.filter((r) => r.name !== name),
  };

  const files = [targetsFile(newTargets)];
  return executeWrite(
    files, newTargets, allowlist,
    `config(dashboard): remove repo ${name}`,
    'remove-repo', name, opts,
  );
}

/**
 * Add a staging target. When addHost is true, also adds the target's host to
 * the allowlist in the SAME commitConfigChange call (one commit, two files).
 */
export async function addStagingTarget(
  stagingTarget: Partial<StagingTarget> & { name: string; url: string },
  addHost: boolean,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  // Normalise the minimal UI payload into a schema-valid staging target. `repo`
  // and `url` are genuinely required by the schema (validated in executeWrite).
  const fullTarget: StagingTarget = {
    name: stagingTarget.name,
    url: stagingTarget.url,
    repo: stagingTarget.repo ?? '',
    activeScan: stagingTarget.activeScan ?? false,
    rateLimitRps: stagingTarget.rateLimitRps ?? 10,
    enabled: stagingTarget.enabled ?? true,
    ...(stagingTarget.auth !== undefined ? { auth: stagingTarget.auth } : {}),
  };

  const newTargets: TargetRegistry = {
    ...targets,
    stagingTargets: [...targets.stagingTargets, fullTarget],
  };

  let newAllowlist = allowlist;
  if (addHost) {
    const host = new URL(fullTarget.url).hostname;
    const alreadyPresent = allowlist.hosts.some((e) => e.host === host);
    if (!alreadyPresent) {
      const newEntry: AllowlistEntry = {
        host,
        owner: opts.actor,
        addedAt: new Date().toISOString().slice(0, 10),
      };
      newAllowlist = { hosts: [...allowlist.hosts, newEntry] };
    }
  }

  // addHost atomic: both files in ONE commitConfigChange call (§6 + ImplInv-1)
  const files: ConfigFileWrite[] = [targetsFile(newTargets)];
  if (addHost) files.push(allowlistFile(newAllowlist));

  return executeWrite(
    files, newTargets, newAllowlist,
    `config(dashboard): add staging target ${stagingTarget.name}`,
    'add-staging-target', stagingTarget.name, opts,
  );
}

export async function editStagingTarget(
  name: string,
  patch: Partial<StagingTarget>,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  const stagingTargets = targets.stagingTargets.map((s) =>
    s.name === name ? { ...s, ...patch } : s,
  );
  const newTargets: TargetRegistry = { ...targets, stagingTargets };

  const files = [targetsFile(newTargets)];
  return executeWrite(
    files, newTargets, allowlist,
    `config(dashboard): edit staging target ${name}`,
    'edit-staging-target', name, opts,
  );
}

export async function removeStagingTarget(
  name: string,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  const newTargets: TargetRegistry = {
    ...targets,
    stagingTargets: targets.stagingTargets.filter((s) => s.name !== name),
  };

  const files = [targetsFile(newTargets)];
  return executeWrite(
    files, newTargets, allowlist,
    `config(dashboard): remove staging target ${name}`,
    'remove-staging-target', name, opts,
  );
}

export async function addHost(
  entry: Partial<AllowlistEntry> & { host: string },
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  // Normalise the minimal UI payload: owner + addedAt are schema-required, so
  // default them when the form leaves them blank.
  const fullEntry: AllowlistEntry = {
    host: entry.host,
    owner: entry.owner !== undefined && entry.owner !== '' ? entry.owner : opts.actor,
    addedAt: entry.addedAt ?? new Date().toISOString().slice(0, 10),
    ...(entry.note !== undefined && entry.note !== '' ? { note: entry.note } : {}),
  };

  const newAllowlist: Allowlist = {
    hosts: [...allowlist.hosts, fullEntry],
  };

  const files = [allowlistFile(newAllowlist)];
  return executeWrite(
    files, targets, newAllowlist,
    `config(dashboard): add host ${fullEntry.host}`,
    'add-host', fullEntry.host, opts,
  );
}

/**
 * Remove a host from the allowlist. Rejects with HostInUseError (409)
 * if an enabled staging target still uses the host (schema cross-check).
 */
export async function removeHost(
  host: string,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir } = opts;
  const targets = readTargets(configDir);
  const allowlist = readAllowlist(configDir);

  // Check if any enabled staging target uses this host (§6 — 409 before commit)
  for (const target of targets.stagingTargets) {
    if (!target.enabled) continue;
    let targetHost: string;
    try {
      targetHost = new URL(target.url).hostname;
    } catch {
      continue;
    }
    if (targetHost === host) {
      throw new HostInUseError(host);
    }
  }

  const newAllowlist: Allowlist = {
    hosts: allowlist.hosts.filter((e) => e.host !== host),
  };

  const files = [allowlistFile(newAllowlist)];
  return executeWrite(
    files, targets, newAllowlist,
    `config(dashboard): remove host ${host}`,
    'remove-host', host, opts,
  );
}

/**
 * Revert a prior config(dashboard) commit (D6, ImplInv-4).
 * Composes computeConfigRevert (C3) → re-validate → commitConfigChange.
 * C4 NEVER spawns git directly.
 */
export async function revertConfigCommit(
  commitSha: string,
  opts: WriteServiceOpts,
): Promise<WriteResult> {
  const { configDir, configRepoDir } = opts;

  // Delegate to C3 primitive — validates config(dashboard) prefix + config-only paths
  const { files: revertFiles } = await computeConfigRevert(commitSha, { configRepoDir });

  // Build in-memory projection by applying the revert files on top of current disk state.
  // We start from current targets + allowlist, then overlay each file returned by computeConfigRevert.
  let targets = readTargets(configDir);
  let allowlist = readAllowlist(configDir);

  for (const f of revertFiles) {
    if (f.path === 'config/targets.json') {
      if (f.content === '') {
        // File was added in the commit being reverted → revert means removing it.
        // Represent as empty registry.
        targets = { repos: [], stagingTargets: [] };
      } else {
        const parsed = JSON.parse(f.content) as unknown;
        const result = TargetRegistrySchema.safeParse(parsed);
        if (!result.success) {
          throw new ValidationError(result.error.message, result.error.issues);
        }
        targets = result.data;
      }
    } else if (f.path === 'config/allowed-staging-hosts.json') {
      if (f.content === '') {
        allowlist = { hosts: [] };
      } else {
        const parsed = JSON.parse(f.content) as unknown;
        const result = AllowlistSchema.safeParse(parsed);
        if (!result.success) {
          throw new ValidationError(result.error.message, result.error.issues);
        }
        allowlist = result.data;
      }
    }
  }

  // Validate the resulting projection (same full validation as any write)
  const validationErr = validateProjection(targets, allowlist);
  if (validationErr !== null) {
    throw validationErr;
  }

  // Build the actual file writes to commit
  const filesToWrite: ConfigFileWrite[] = revertFiles.map((f) => {
    if (f.content === '') {
      // File was added in the reverted commit; reverting means restoring the content
      // we just validated. Use the validated in-memory state.
      if (f.path === 'config/targets.json') {
        return targetsFile(targets);
      }
      return allowlistFile(allowlist);
    }
    return f;
  });

  return executeWrite(
    filesToWrite, targets, allowlist,
    `config(dashboard): revert ${commitSha}`,
    'revert', commitSha, opts,
  );
}

// ---------------------------------------------------------------------------
// listHistory — READ operation (no step-up, no commit)
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  sha: string;
  message: string;
  authorDate: string;
  auditEntry?: AuditEntry;
}

/**
 * List recent config history. Joins the git log with the audit cache.
 * Falls back to git-only if the audit cache is missing or has an integrity warning.
 */
export async function listHistory(
  n: number,
  opts: { configRepoDir: string; historyDir: string },
): Promise<{ entries: HistoryEntry[]; auditIntegrityOk: boolean }> {
  const { configRepoDir, historyDir } = opts;

  const commits = await recentConfigCommits(n, { configRepoDir });
  const chain = readAuditChain(CONFIG_AUDIT_PATH(historyDir));

  // Build a map from commitSha to audit entry for O(1) join
  const auditBySha = new Map<string, AuditEntry>();
  for (const entry of chain.entries) {
    auditBySha.set(entry.commitSha, entry);
  }

  const entries: HistoryEntry[] = commits.map((c) => {
    const entry: HistoryEntry = {
      sha: c.sha,
      message: c.message,
      authorDate: c.authorDate,
    };
    const auditEntry = auditBySha.get(c.sha);
    if (auditEntry !== undefined) entry.auditEntry = auditEntry;
    return entry;
  });

  return { entries, auditIntegrityOk: chain.integrityOk };
}

// Re-export typed errors for route-layer use
export {
  ConfigWorktreeDirtyError,
  GitPushError,
  GitRollbackFailedError,
  NotARevertableConfigCommitError,
  scrubToken,
};
