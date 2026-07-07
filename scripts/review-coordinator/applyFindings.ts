/**
 * applyFindings.ts
 *
 * I/O orchestrator for §11a coordinator-side auto-apply with rollback.
 *
 * For each queued finding:
 *   1. Snapshot via git stash
 *   2. Apply proposed_edits[] anchor-based edits
 *   3. Run npm run lint && npm run typecheck + acceptance_check
 *   4. On verify fail: revert via git checkout HEAD -- <files>
 *   5. Cumulative re-verify at the end; walk back failed cumulative cases
 *   6. Write audit log JSONL line per decision
 *   7. Write structured commit (one commit per apply batch)
 *
 * Anchor-apply contract (§A11):
 *   Each proposed_edit has {file_path, anchor, replacement}.
 *   Anchor must occur exactly once in the file — surfaced with
 *   coordinator_override_reason "anchor_not_found" or "anchor_not_unique"
 *   if not. Multi-edit findings apply atomically: all edits or none.
 *
 * Inline-applied findings (F2 R2 / §A11):
 *   When applied_inline_by_reviewer: true, run acceptance_check but do NOT
 *   re-apply. On failure: coordinator_override_reason "inline_apply_verification_failed".
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, sep, relative, isAbsolute } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import type { Finding, ReviewResult } from '../chatgpt-reviewPure.js';
import type { SuppressionEntry } from './applyFindingsPure.js';
import {
  runFourKeyGate,
  detectOverlaps,
  applyBatchLimit,
  matchProductionDsn,
  classifyAcceptanceCheckCommand,
  isInlineApplied,
  DEFAULT_BATCH_LIMIT,
} from './applyFindingsPure.js';
import { readSuppressions } from './suppressionStore.js';
import { appendAuditLogEntry, buildAuditLogPath, type AuditLogEntry } from './auditLog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyFindingsConfig {
  projectRoot: string;
  buildSlug: string;
  reviewer: string;
  batchLimit?: number;
  /** Regex pattern for production DSN detection — merged with built-in patterns */
  extraProdDsnPattern?: RegExp;
  /** Audit log path; auto-generated if omitted */
  auditLogPath?: string;
  /** Timestamp for reproducible test runs */
  timestamp?: string;
}

export interface ApplyFindingsResult {
  applied: Finding[];
  surfaced: Finding[];
  quarantined: Finding[];
  commit_sha: string | null;
  auditLogPath: string;
}

export interface GitAdapter {
  stashPush(files: string[]): void;
  stashPop(): void;
  revertFiles(files: string[]): void;
  commit(message: string): string;
  runVerify(projectRoot: string): { success: boolean; output: string };
  runAcceptanceCheck(check: string, projectRoot: string): { success: boolean; output: string };
}

// ---------------------------------------------------------------------------
// Default Git adapter (real I/O)
// ---------------------------------------------------------------------------

/**
 * Run git with array-form args via spawnSync — no shell interpretation, so
 * reviewer-supplied file paths or commit messages containing quotes/shell
 * metacharacters cannot break out of their argument (same rationale as
 * sync.js getSubmoduleCommit). Optional `input` is fed to stdin.
 * Throws on non-zero exit to preserve the execSync error semantics the
 * callers were written against.
 */
function runGitChecked(args: string[], input?: string): string {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    ...(input !== undefined ? { input } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`,
    );
  }
  return result.stdout ?? '';
}

export function createGitAdapter(): GitAdapter {
  return {
    stashPush(files: string[]) {
      // Pathspecs go through stdin (--pathspec-from-file=-), not a shell
      // string, so no quoting/escaping of file names is needed.
      runGitChecked(
        ['stash', 'push', '--keep-index', '--include-untracked', '--pathspec-from-file=-'],
        files.join('\n'),
      );
    },
    stashPop() {
      // spawnSync does not throw on non-zero exit — stash may be empty if
      // nothing was stashed, which is fine.
      spawnSync('git', ['stash', 'pop'], { stdio: 'pipe' });
    },
    revertFiles(files: string[]) {
      runGitChecked(['checkout', 'HEAD', '--', ...files]);
    },
    commit(message: string): string {
      runGitChecked(['add', '-A']);
      runGitChecked(['commit', '-m', message]);
      return runGitChecked(['rev-parse', 'HEAD']).trim();
    },
    runVerify(projectRoot: string): { success: boolean; output: string } {
      try {
        const output = execSync('npm run lint && npm run typecheck', {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        return { success: true, output };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return {
          success: false,
          output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n'),
        };
      }
    },
    runAcceptanceCheck(check: string, projectRoot: string): { success: boolean; output: string } {
      // Allowlist gate BEFORE execution: acceptance_check is untrusted
      // reviewer (model) output. The leading binary must be allowlisted and
      // the string must be free of shell metacharacters, quotes, and control
      // characters (see classifyAcceptanceCheckCommand). The caller's
      // production-DSN denylist remains in place as defence-in-depth.
      const gate = classifyAcceptanceCheckCommand(check);
      if (!gate.allowed) {
        return {
          success: false,
          output: `acceptance_check rejected by execution allowlist: ${gate.reason}`,
        };
      }
      // Execute WITHOUT a shell: tokenise on whitespace and spawn the binary
      // directly. The classifier guarantees space-only separators and no
      // quoting, so naive tokenisation is exact — and with no shell in the
      // path, separators/substitution have nothing to exploit even if a
      // string slipped the classifier.
      //
      // Windows exception: npm/npx/tsx/vitest are .cmd shims there, and Node
      // (post CVE-2024-27980) refuses to spawn .cmd files without a shell.
      // On win32 we use shell: true — the classifier has already rejected
      // every separator, substitution, quote, and control character, so the
      // string that reaches the shell is a single space-separated command.
      const [binary, ...args] = check.trim().split(/\s+/);
      const result = spawnSync(binary, args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        shell: process.platform === 'win32',
        timeout: 600_000,
      });
      if (result.error || result.status !== 0) {
        return {
          success: false,
          output: [result.stdout, result.stderr, result.error?.message]
            .filter(Boolean)
            .join('\n'),
        };
      }
      return { success: true, output: result.stdout ?? '' };
    },
  };
}

// ---------------------------------------------------------------------------
// Anchor-based apply (§A11)
// ---------------------------------------------------------------------------

interface AnchorApplyResult {
  success: true;
  filesWritten: string[];
}

interface AnchorApplyFailure {
  success: false;
  reason: 'anchor_not_found' | 'anchor_not_unique';
  file_path: string;
  anchor: string;
}

type AnchorApplyOutcome = AnchorApplyResult | AnchorApplyFailure;

/**
 * Reject paths that escape the project root via absolute paths or `..` segments.
 * Reviewer-supplied file paths are untrusted model output.
 */
function isPathInsideRoot(absPath: string, projectRoot: string): boolean {
  const rootResolved = resolve(projectRoot);
  const rel = relative(rootResolved, absPath);
  if (rel === '') return true;
  return !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

/**
 * In-memory byte snapshot of the affected files BEFORE applying edits.
 * `null` content means the file did not exist (snapshot restore = delete).
 *
 * This preserves any pre-existing uncommitted operator changes in those
 * files — a `git checkout HEAD -- <file>` rollback would discard them.
 */
type FileSnapshot = { absPath: string; original: string | null };

function snapshotFiles(absPaths: string[]): FileSnapshot[] {
  const snapshots: FileSnapshot[] = [];
  for (const absPath of absPaths) {
    if (existsSync(absPath)) {
      try {
        snapshots.push({ absPath, original: readFileSync(absPath, 'utf-8') });
      } catch {
        snapshots.push({ absPath, original: null });
      }
    } else {
      snapshots.push({ absPath, original: null });
    }
  }
  return snapshots;
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snap of snapshots) {
    try {
      if (snap.original === null) {
        // File did not exist before — best-effort: leave on disk only if
        // it still doesn't exist; otherwise we'd need fs.rmSync. The apply
        // path never creates new files (anchor must already match), so
        // this branch is defensive and typically a no-op.
        continue;
      }
      writeFileSync(snap.absPath, snap.original, 'utf-8');
    } catch {
      // Best-effort restore — if we can't write, the worktree is in an
      // unknown state and the operator will see it via git status.
    }
  }
}

/**
 * Apply all proposed_edits[] for a single finding atomically.
 * If any edit fails (anchor not found / not unique), no files are written.
 */
export function applyAnchorEdits(
  finding: Finding,
  projectRoot: string,
): AnchorApplyOutcome {
  const edits = finding.proposed_edits ?? [];
  if (edits.length === 0) {
    return { success: true, filesWritten: [] };
  }

  // Pre-validate all edits before writing anything (atomicity)
  const pendingWrites: Array<{ absPath: string; newContent: string }> = [];

  for (const edit of edits) {
    const absPath = resolve(projectRoot, edit.file_path);

    // Path-traversal guard: reviewer output is untrusted — refuse paths
    // that escape projectRoot via absolute paths or `..` segments.
    if (!isPathInsideRoot(absPath, projectRoot)) {
      return {
        success: false,
        reason: 'anchor_not_found',
        file_path: edit.file_path,
        anchor: edit.anchor,
      };
    }

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      return {
        success: false,
        reason: 'anchor_not_found',
        file_path: edit.file_path,
        anchor: edit.anchor,
      };
    }

    const count = countOccurrences(content, edit.anchor);
    if (count === 0) {
      return {
        success: false,
        reason: 'anchor_not_found',
        file_path: edit.file_path,
        anchor: edit.anchor,
      };
    }
    if (count > 1) {
      return {
        success: false,
        reason: 'anchor_not_unique',
        file_path: edit.file_path,
        anchor: edit.anchor,
      };
    }

    const newContent = content.replace(edit.anchor, edit.replacement);
    pendingWrites.push({ absPath, newContent });
  }

  // All edits validated — now write
  for (const { absPath, newContent } of pendingWrites) {
    writeFileSync(absPath, newContent, 'utf-8');
  }

  return {
    success: true,
    filesWritten: edits.map((e) => resolve(projectRoot, e.file_path)),
  };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Structured commit message (§11a Step 8)
// ---------------------------------------------------------------------------

function buildCommitMessage(
  applied: Finding[],
  reviewer: string,
  versioningQuartet: {
    contract_version: string;
    prompt_version?: string;
    reviewer_version?: string;
    project_context_version?: string;
    source_artifact_sha?: string;
  },
): string {
  const lines = [
    `chore(review): coordinator-applied ${applied.length} findings from ${reviewer}`,
    '',
    'Applied:',
  ];

  for (const finding of applied) {
    const file = finding.affected_files?.[0] ?? '(unknown file)';
    lines.push(`- ${finding.id}: ${finding.title} — ${file}`);
  }

  lines.push('');
  lines.push('acceptance_check passed for all applied findings.');
  lines.push(`contract_version: ${versioningQuartet.contract_version}`);

  if (versioningQuartet.prompt_version) {
    lines.push(`prompt_version: ${versioningQuartet.prompt_version}`);
  }
  if (versioningQuartet.reviewer_version) {
    lines.push(`reviewer_version: ${versioningQuartet.reviewer_version}`);
  }
  if (versioningQuartet.project_context_version) {
    lines.push(`project_context_version: ${versioningQuartet.project_context_version}`);
  }
  if (versioningQuartet.source_artifact_sha) {
    lines.push(`source_artifact_sha: ${versioningQuartet.source_artifact_sha}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main apply loop
// ---------------------------------------------------------------------------

/**
 * Run the full §11a apply loop for a validated ReviewResult.
 * Takes an optional GitAdapter injection point for testing (mock).
 */
export async function applyFindings(
  result: ReviewResult,
  config: ApplyFindingsConfig,
  gitAdapter: GitAdapter = createGitAdapter(),
): Promise<ApplyFindingsResult> {
  const {
    projectRoot,
    buildSlug,
    reviewer,
    batchLimit = DEFAULT_BATCH_LIMIT,
    timestamp,
  } = config;

  const auditLogPath =
    config.auditLogPath ?? buildAuditLogPath(projectRoot, buildSlug, timestamp);

  const applied: Finding[] = [];
  const surfaced: Finding[] = [];
  const quarantined: Finding[] = [];

  const versioningQuartet = {
    contract_version: result.contract_version,
    prompt_version: result.prompt_version,
    reviewer_version: result.reviewer_version,
    project_context_version: result.project_context_version,
    source_artifact_sha: result.source_artifact_sha,
  };

  // Load active suppressions
  const suppressions: SuppressionEntry[] = readSuppressions({
    projectRoot,
    buildSlug,
    reviewer,
  });

  // Step 3: Four-key gate for each finding
  const eligible: Finding[] = [];

  for (const finding of result.findings) {
    // Handle inline-applied findings (F2 R2)
    if (isInlineApplied(finding)) {
      const acceptanceCheck = finding.acceptance_check ?? '';
      const prodDsn = matchProductionDsn(acceptanceCheck);

      if (prodDsn.isProduction) {
        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'overridden_to_surface',
          coordinator_override_reason: 'inline_apply_verification_failed',
          acceptance_check_outcome: 'deferred',
          defer_reason: 'production_sql_check',
          versioningQuartet,
        });
        surfaced.push(finding);
        continue;
      }

      const checkResult = gitAdapter.runAcceptanceCheck(acceptanceCheck, projectRoot);
      if (checkResult.success) {
        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'already_applied_by_reviewer',
          acceptance_check_outcome: 'passed',
          versioningQuartet,
        });
        applied.push(finding);
      } else {
        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'overridden_to_surface',
          coordinator_override_reason: 'inline_apply_verification_failed',
          acceptance_check_outcome: 'failed',
          versioningQuartet,
        });
        surfaced.push(finding);
      }
      continue;
    }

    const gateResult = runFourKeyGate(finding, suppressions, buildSlug);

    if (!gateResult.eligible) {
      const reason = gateResult.reason ?? undefined;

      // Check if suppressed
      if (reason === 'suppressed') {
        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'suppressed_advisory',
          coordinator_override_reason: 'suppressed',
          acceptance_check_outcome: 'deferred',
          versioningQuartet,
        });
        surfaced.push(finding);
      } else {
        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'overridden_to_surface',
          coordinator_override_reason: reason,
          acceptance_check_outcome: 'deferred',
          versioningQuartet,
        });
        surfaced.push(finding);
      }
      continue;
    }

    // Check for production DSN in acceptance_check (§3d production-safety rule)
    const prodDsn = matchProductionDsn(finding.acceptance_check ?? '');
    if (prodDsn.isProduction) {
      logDecision(auditLogPath, {
        finding,
        reviewer,
        decision: 'overridden_to_surface',
        acceptance_check_outcome: 'deferred',
        defer_reason: 'production_sql_check',
        versioningQuartet,
      });
      surfaced.push(finding);
      continue;
    }

    eligible.push(finding);
  }

  // Step 4: Affected-files manifest check + overlap detection
  const withFiles = eligible.filter((f) => {
    const hasFiles = Array.isArray(f.affected_files) && f.affected_files.length > 0;
    if (!hasFiles) {
      logDecision(auditLogPath, {
        finding: f,
        reviewer,
        decision: 'overridden_to_surface',
        coordinator_override_reason: 'missing_affected_files',
        acceptance_check_outcome: 'deferred',
        versioningQuartet,
      });
      surfaced.push(f);
    }
    return hasFiles;
  });

  const { keep, deferred: overlapDeferred } = detectOverlaps(withFiles);

  for (const { finding, conflicting_id } of overlapDeferred) {
    logDecision(auditLogPath, {
      finding,
      reviewer,
      decision: 'overridden_to_surface',
      coordinator_override_reason: 'overlapping_patch_surface',
      acceptance_check_outcome: 'deferred',
      versioningQuartet,
      extra: { conflicting_id },
    });
    surfaced.push(finding);
  }

  // Step 4b: Batch-size limit
  const { batch, overflow } = applyBatchLimit(keep, batchLimit);

  for (const { finding } of overflow) {
    logDecision(auditLogPath, {
      finding,
      reviewer,
      decision: 'overridden_to_surface',
      coordinator_override_reason: 'auto_apply_batch_limit',
      acceptance_check_outcome: 'deferred',
      versioningQuartet,
    });
    surfaced.push(finding);
  }

  // Step 5: One-finding-at-a-time apply
  // Track per-finding snapshots so rollback preserves any pre-existing
  // uncommitted operator changes in the same files (§11a Step 5 / 6).
  const successfullyApplied: Finding[] = [];
  const findingSnapshots = new Map<Finding, FileSnapshot[]>();

  for (const finding of batch) {
    // Filter `affected_files` through the same path-traversal guard used
    // by applyAnchorEdits. Reviewer-supplied paths that escape projectRoot
    // must not be snapshotted (and therefore cannot be written by the
    // rollback path either).
    const affectedFiles = (finding.affected_files ?? [])
      .map((f) => resolve(projectRoot, f))
      .filter((absPath) => isPathInsideRoot(absPath, projectRoot));

    // Snapshot affected files BEFORE the apply so we can restore exact
    // pre-apply bytes on failure (spec §11a Step 5.1).
    const snapshots = snapshotFiles(affectedFiles);

    // Apply anchor-based edits
    const applyResult = applyAnchorEdits(finding, projectRoot);

    if (!applyResult.success) {
      logDecision(auditLogPath, {
        finding,
        reviewer,
        decision: 'auto_apply_failed',
        coordinator_override_reason: applyResult.reason,
        acceptance_check_outcome: 'failed',
        versioningQuartet,
      });
      surfaced.push(finding);
      continue;
    }

    // Step 5 verify: lint + typecheck
    const verifyResult = gitAdapter.runVerify(projectRoot);

    if (!verifyResult.success) {
      // Step 6: Rollback on failure — restore exact pre-apply bytes
      restoreSnapshots(snapshots);
      logDecision(auditLogPath, {
        finding,
        reviewer,
        decision: 'auto_apply_failed',
        coordinator_override_reason: 'auto_apply_failed',
        acceptance_check_outcome: 'failed',
        versioningQuartet,
      });
      surfaced.push(finding);
      continue;
    }

    // Run per-finding acceptance_check
    const acceptanceCheck = finding.acceptance_check ?? '';
    const checkResult = gitAdapter.runAcceptanceCheck(acceptanceCheck, projectRoot);

    if (!checkResult.success) {
      restoreSnapshots(snapshots);
      logDecision(auditLogPath, {
        finding,
        reviewer,
        decision: 'auto_apply_failed',
        coordinator_override_reason: 'auto_apply_failed',
        acceptance_check_outcome: 'failed',
        versioningQuartet,
      });
      surfaced.push(finding);
      continue;
    }

    successfullyApplied.push(finding);
    findingSnapshots.set(finding, snapshots);
  }

  // Step 7: Cumulative re-verify
  if (successfullyApplied.length > 0) {
    const cumulativeResult = gitAdapter.runVerify(projectRoot);

    if (!cumulativeResult.success) {
      // Walk back last-applied findings one at a time until cumulative passes
      const toRevert = [...successfullyApplied].reverse();

      for (const finding of toRevert) {
        // Restore the exact pre-apply bytes captured before this finding
        // ran. Falls back to nothing if no snapshot recorded — preferable
        // to a destructive `git checkout HEAD --` that would also discard
        // any pre-existing uncommitted operator changes in those files.
        const snap = findingSnapshots.get(finding);
        if (snap) {
          restoreSnapshots(snap);
        }

        const recheckResult = gitAdapter.runVerify(projectRoot);

        logDecision(auditLogPath, {
          finding,
          reviewer,
          decision: 'cumulative_verify_failed',
          coordinator_override_reason: 'cumulative_verify_failed',
          acceptance_check_outcome: 'failed',
          versioningQuartet,
        });

        // Remove from successfullyApplied
        const idx = successfullyApplied.indexOf(finding);
        if (idx !== -1) successfullyApplied.splice(idx, 1);
        surfaced.push(finding);

        if (recheckResult.success) break;
      }
    }
  }

  // Log applied findings
  for (const finding of successfullyApplied) {
    logDecision(auditLogPath, {
      finding,
      reviewer,
      decision: 'applied',
      acceptance_check_outcome: 'passed',
      versioningQuartet,
    });
    applied.push(finding);
  }

  // Step 8: Commit
  let commitSha: string | null = null;
  if (successfullyApplied.length > 0) {
    const commitMessage = buildCommitMessage(successfullyApplied, reviewer, versioningQuartet);
    try {
      commitSha = gitAdapter.commit(commitMessage);
    } catch {
      // Commit failure is non-fatal; the files are still written
    }
  }

  return { applied, surfaced, quarantined, commit_sha: commitSha, auditLogPath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logDecision(
  auditLogPath: string,
  params: {
    finding: Finding;
    reviewer: string;
    decision: AuditLogEntry['decision'];
    coordinator_override_reason?: string;
    acceptance_check_outcome: AuditLogEntry['acceptance_check_outcome'];
    defer_reason?: string;
    rollback_diff_hash?: string;
    versioningQuartet: {
      contract_version: string;
      prompt_version?: string;
      reviewer_version?: string;
      project_context_version?: string;
      source_artifact_sha?: string;
    };
    extra?: Record<string, unknown>;
  },
): void {
  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    reviewer: params.reviewer,
    finding_id: params.finding.id,
    decision: params.decision,
    ...(params.coordinator_override_reason
      ? { coordinator_override_reason: params.coordinator_override_reason }
      : {}),
    contract_version: params.versioningQuartet.contract_version,
    ...(params.versioningQuartet.prompt_version
      ? { prompt_version: params.versioningQuartet.prompt_version }
      : {}),
    ...(params.versioningQuartet.reviewer_version
      ? { reviewer_version: params.versioningQuartet.reviewer_version }
      : {}),
    ...(params.versioningQuartet.project_context_version
      ? { project_context_version: params.versioningQuartet.project_context_version }
      : {}),
    ...(params.versioningQuartet.source_artifact_sha
      ? { source_artifact_sha: params.versioningQuartet.source_artifact_sha }
      : {}),
    acceptance_check_outcome: params.acceptance_check_outcome,
    ...(params.defer_reason ? { defer_reason: params.defer_reason } : {}),
    ...(params.rollback_diff_hash ? { rollback_diff_hash: params.rollback_diff_hash } : {}),
  };

  appendAuditLogEntry(entry, { logPath: auditLogPath });
}
