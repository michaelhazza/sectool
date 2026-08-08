/**
 * recovery-checks.mjs — resume/recovery diagnostics for one build (FR-12).
 *
 * WHY THIS EXISTS
 * FR-12 requires recovering from repository artefacts and Git state, not
 * chat history: "Detect dirty branches, orphaned worktrees, partial
 * integration, stale status, missing CI and already-completed work."
 * This module is the deterministic probe a coordinator runs before resuming
 * a build, so resume decisions are grounded in what the repo actually shows
 * rather than in what a session transcript claims happened.
 *
 * CONTRACT
 * `detectRecoveryState({repo, slug, root})` is Git/artefact-driven, NEVER
 * mutates repo state (read-only `git`/`gh` invocations only), and FAILS
 * SOFT: it never throws. A probe that cannot run (missing `gh`, no network,
 * unknown ref, no status.json) is recorded as `probeError` on the affected
 * check rather than raised as an exception, so a partial environment still
 * returns a usable report.
 *
 * STRUCTURE FOR TESTABILITY (mirrors classify-rejection.mjs's split, B1):
 * the decision logic lives in the pure, exported `evaluateRecoveryState`,
 * which takes an already-gathered `probes` object and a deterministic `now`
 * — no fs, no git, no wall clock. `gatherRecoveryProbes` is the thin I/O
 * layer that shells out to `git`/`gh`; each probe there is independently
 * try/caught so one unavailable probe cannot suppress the others. Tests
 * exercise `evaluateRecoveryState` directly with fabricated probe fixtures,
 * the same convention board-sync.mjs and status-contract.mjs use for their
 * gh/fs-touching I/O layers.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const STALE_AFTER_HOURS = Number(process.env.RECOVERY_STALE_AFTER_HOURS ?? 48);
const STALE_AFTER_MS = STALE_AFTER_HOURS * 60 * 60 * 1000;

// build-status.v2 terminal statuses. Duplicated in miniature from
// transition-validator.mjs's (unexported) TERMINAL_STATUSES rather than
// importing it, since that module exposes no public terminal-status API and
// this chunk does not touch transition-validator.mjs.
const TERMINAL_STATUSES = new Set(['MERGED', 'ABANDONED']);

function makeCheck(flagged, detail = null, probeError = null) {
  return { flagged: Boolean(flagged), detail, probeError };
}

/** Parses `git worktree list --porcelain` into `{path, branch}` entries. */
function parseWorktreePorcelain(output) {
  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/**
 * Thin I/O layer: gathers raw Git/gh/filesystem observations for one
 * {repo, slug}. Read-only throughout — no probe here ever mutates repo
 * state. Every probe is independently try/caught, so a missing `gh` binary
 * or an unreachable remote degrades that one probe to a recorded error
 * instead of aborting the rest.
 */
export async function gatherRecoveryProbes({ repo, slug, root }) {
  const probes = {
    statusRecord: null,
    statusError: null,
    worktree: null,
    worktreeError: null,
    workingTreeDirty: null,
    workingTreeError: null,
    branchMergedToDefault: null,
    mergeCheckError: null,
    ciFound: null,
    ciError: null,
  };

  const statusPath = path.join(root, 'tasks', 'builds', slug, 'status.json');
  try {
    probes.statusRecord = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch (err) {
    probes.statusError = `cannot read tasks/builds/${slug}/status.json: ${err.message}`;
  }

  const branch = probes.statusRecord?.branch;
  if (!branch) {
    const reason = 'no branch recorded in status.json — cannot probe git state';
    probes.worktreeError = reason;
    probes.workingTreeError = reason;
    probes.mergeCheckError = reason;
    probes.ciError = reason;
    return probes;
  }

  let worktrees = [];
  try {
    const out = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    worktrees = parseWorktreePorcelain(out);
  } catch (err) {
    probes.worktreeError = `git worktree list failed: ${err.message}`;
  }

  if (!probes.worktreeError) {
    probes.worktree = worktrees.find((w) => w.branch === branch) ?? null;
  }

  const worktreePath = probes.worktree?.path;
  if (worktreePath && existsSync(worktreePath)) {
    try {
      const out = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
      probes.workingTreeDirty = out.trim().length > 0;
    } catch (err) {
      probes.workingTreeError = `git status failed in ${worktreePath}: ${err.message}`;
    }
  } else if (!probes.worktreeError && !probes.worktree) {
    probes.workingTreeError = `no worktree found for branch "${branch}" — cannot check for uncommitted changes`;
  }

  // Derived from PR state via `gh`, not git ancestry: this framework merges
  // via `--admin squash` (finalisation Step 12), which leaves no ancestry
  // link, so an `--is-ancestor` check is always false for a squash-merged
  // branch — the exact FR-12 resume scenario this probe exists to catch.
  // `pr list --state merged` is decisive on success (empty = not merged,
  // non-empty = merged) and never errors merely because no PR was ever
  // opened, unlike `pr view`.
  try {
    const args = ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'mergedAt,state'];
    if (repo) args.push('--repo', repo);
    const out = execFileSync('gh', args, { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    probes.branchMergedToDefault = Array.isArray(parsed) && parsed.some((pr) => Boolean(pr.mergedAt));
  } catch (err) {
    probes.mergeCheckError = `cannot determine merge state of "${branch}" via gh pr list: ${err.message}`;
  }

  // Best-effort: pinning gh's exact `pr checks` output shape against a live
  // repo is out of scope for this chunk (no live PR fixture here). Any
  // failure — missing gh, no PR yet, network — degrades to ciError, which
  // evaluateRecoveryState treats as "cannot tell", never as "missing CI".
  try {
    const args = ['pr', 'checks', branch, '--json', 'state'];
    if (repo) args.push('--repo', repo);
    const out = execFileSync('gh', args, { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    probes.ciFound = Array.isArray(parsed) && parsed.length > 0;
  } catch (err) {
    probes.ciError = `cannot read CI status for "${branch}": ${err.message}`;
  }

  return probes;
}

/**
 * Pure decision layer. Never throws — an unrecognised/partial `probes`
 * shape degrades individual checks to `probeError`, never to a thrown
 * exception, mirroring `validateTransition`'s never-throws contract.
 */
export function evaluateRecoveryState({ repo = null, slug = null } = {}, probes = {}, now = new Date()) {
  const statusRecord = probes.statusRecord ?? null;
  const status = statusRecord?.status ?? null;

  const dirtyBranch = probes.workingTreeError
    ? makeCheck(false, null, probes.workingTreeError)
    : makeCheck(
        probes.workingTreeDirty === true,
        probes.workingTreeDirty === true ? 'the build\'s worktree has uncommitted changes' : null
      );

  const orphanedWorktree = probes.worktreeError
    ? makeCheck(false, null, probes.worktreeError)
    : (!probes.worktree
        ? makeCheck(false)
        : (() => {
            const flagged = !statusRecord || TERMINAL_STATUSES.has(status);
            return makeCheck(
              flagged,
              flagged
                ? `worktree at ${probes.worktree.path} (branch ${probes.worktree.branch}) is still registered but the build is `
                  + `${statusRecord ? `already "${status}"` : 'unknown (no status.json)'} — it was never cleaned up`
                : null
            );
          })());

  const alreadyCompleted = (() => {
    if (statusRecord && TERMINAL_STATUSES.has(status)) {
      return makeCheck(true, `status.json already records "${status}" — no work remains to resume`);
    }
    if (probes.branchMergedToDefault === true) {
      return makeCheck(true, 'the branch is already merged into the default branch, even though status.json has not caught up');
    }
    if (probes.statusError && probes.mergeCheckError) {
      return makeCheck(false, null, `${probes.statusError}; ${probes.mergeCheckError}`);
    }
    return makeCheck(false);
  })();

  const partialIntegration = (() => {
    if (!statusRecord) return makeCheck(false, null, probes.statusError);
    if (probes.mergeCheckError) return makeCheck(false, null, probes.mergeCheckError);
    if (probes.branchMergedToDefault === true && !TERMINAL_STATUSES.has(status)) {
      return makeCheck(true, `the branch is merged into the default branch but status.json still reads "${status}" — status was never advanced`);
    }
    return makeCheck(false);
  })();

  const staleStatus = (() => {
    if (!statusRecord) return makeCheck(false, null, probes.statusError);
    if (TERMINAL_STATUSES.has(status)) return makeCheck(false);
    const updatedAt = new Date(statusRecord.updated_at);
    if (Number.isNaN(updatedAt.getTime())) {
      return makeCheck(false, null, `status.json updated_at "${statusRecord.updated_at}" is not a parseable date`);
    }
    const ageMs = now.getTime() - updatedAt.getTime();
    if (ageMs >= STALE_AFTER_MS) {
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
      return makeCheck(true, `status "${status}" has not been updated in ${ageHours}h (threshold ${STALE_AFTER_HOURS}h)`);
    }
    return makeCheck(false);
  })();

  const missingCI = (() => {
    if (!statusRecord || TERMINAL_STATUSES.has(status)) return makeCheck(false);
    if (probes.ciError) return makeCheck(false, null, probes.ciError);
    if (probes.ciFound === false) {
      return makeCheck(true, 'no CI check runs were found for the build branch, though the build is in progress');
    }
    return makeCheck(false);
  })();

  const checks = { dirtyBranch, orphanedWorktree, partialIntegration, staleStatus, missingCI, alreadyCompleted };

  return {
    slug,
    repo,
    checks,
    anyFlagged: Object.values(checks).some((c) => c.flagged),
    probeErrors: Object.values(checks).map((c) => c.probeError).filter(Boolean),
  };
}

/**
 * Public entry point (FR-12). Gathers probes for {repo, slug} against
 * `root` (default: cwd) and evaluates them into a structured report.
 * Fails soft end-to-end: even an unexpected error while gathering probes
 * degrades to a report carrying a probeError, never a thrown exception.
 */
export async function detectRecoveryState({ repo = null, slug = null, root = process.cwd() } = {}) {
  if (!slug) {
    return evaluateRecoveryState({ repo, slug: null }, { statusError: 'no slug supplied — cannot locate a build to check' }, new Date());
  }
  try {
    const probes = await gatherRecoveryProbes({ repo, slug, root });
    return evaluateRecoveryState({ repo, slug }, probes, new Date());
  } catch (err) {
    return evaluateRecoveryState(
      { repo, slug },
      { statusError: `unexpected error gathering recovery state: ${err?.message ?? String(err)}` },
      new Date()
    );
  }
}
