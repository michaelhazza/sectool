/**
 * src/fix/status.ts — Fix-request status derivation (§5.3 step 4, §14)
 *
 * Derives one of the 6 fix-request states from GitHub issue/PR state + scan
 * state, using ONLY read scopes (issues:read, pull_requests:read).
 *
 * State machine (closed 6-token set):
 *   requested → in-progress → awaiting-review → merged-awaiting-verification
 *     → verified-fixed | reopened
 *
 * verified-fixed is fenced by scanner-family completion (§5.3 step 4, §6.5
 * parity): a merged fix graduates ONLY when the originating (target ×
 * scannerFamily) ran to `complete` in this run. A failed/skipped family does
 * NOT graduate — the fingerprint's absence is not evidence of a fix.
 *
 * fixes.json reads/writes are fingerprint-keyed, atomic (tmp+rename) under
 * the workspace lock from src/report/lock.ts.
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixEntry, FixesFile } from '../schemas/fix.js';
import { FixesFileSchema } from '../schemas/fix.js';
import type { FixStatus } from '../schemas/fix.js';
import { withWorkspaceLock } from '../report/lock.js';
import type { WorkspaceLockedError } from '../report/lock.js';

export type { FixStatus, FixEntry, FixesFile };
export type { WorkspaceLockedError };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// Default fixes.json path (injectable for tests)
export const DEFAULT_FIXES_PATH = resolve(REPO_ROOT, 'reports', 'fixes.json');

// ---------------------------------------------------------------------------
// GitHub state shapes (read-scope-only derivation)
// ---------------------------------------------------------------------------

/**
 * Minimal GitHub issue state needed for status derivation.
 * All fields are derived using issues:read alone.
 *
 * `hasMarker` — true iff the issue body contains the canonical fingerprint
 * marker `<!-- audit-fix:<fingerprint>:initial -->`. An issue with the
 * `audit-fix` label but no marker is NOT treated as canonical (§P8-2
 * "exists ≠ correct" pin).
 */
export interface IssueState {
  /** Whether the issue is open. */
  open: boolean;
  /** Whether the issue is assigned to anyone. */
  assigned: boolean;
  /** Whether the issue body contains the canonical fingerprint marker. */
  hasMarker: boolean;
}

/**
 * Minimal GitHub PR state needed for status derivation.
 * Derived using pull_requests:read alone.
 *
 * There may be multiple PRs referencing an issue over its lifetime; the caller
 * passes the most relevant one. `null` means no PR references the issue.
 */
export interface PrState {
  /** Whether this PR is a draft. */
  draft: boolean;
  /** Whether this PR is currently open (not merged, not closed). */
  open: boolean;
  /** Whether this PR has been merged. */
  merged: boolean;
}

/**
 * Scan-state input for the verified-fixed / reopened determination.
 *
 * Used ONLY once the fix is in `merged-awaiting-verification` state — i.e.
 * after the PR has merged and the next audit run has completed.
 *
 * `familyCompleted` must be set to true iff the originating
 * (target × scannerFamily) ran to `complete` in this run (per
 * `meta.scannerStatus`, §6.8). If the family failed or was skipped, this
 * must be false — and the absence of the fingerprint from scan results is
 * NOT treated as evidence of a fix (partial-run masquerade guard, §5.3 step 4).
 */
export interface ScanState {
  /** Whether the fingerprint still fires in this scan run. */
  fingerprintStillFires: boolean;
  /**
   * Whether the originating (target × scannerFamily) ran to `complete`.
   * false → stay at merged-awaiting-verification regardless of fingerprint.
   */
  familyCompleted: boolean;
}

// ---------------------------------------------------------------------------
// Core status derivation
// ---------------------------------------------------------------------------

/**
 * Derive the fix-request status from GitHub issue/PR state and (optionally)
 * the latest scan state.
 *
 * The derivation uses ONLY read scopes and carries no local progress flags.
 *
 * Rules (applied in priority order):
 *
 * 1. No canonical issue (issue absent or lacks the fingerprint marker):
 *    → `requested`  (the fix request was filed but we cannot locate the issue)
 *
 * 2. PR is merged (and was the tracking PR):
 *    a. scanState present AND familyCompleted AND fingerprint no longer fires
 *       → `verified-fixed`
 *    b. scanState present AND familyCompleted AND fingerprint STILL fires
 *       → `reopened`
 *    c. otherwise (no scan yet, or family did not complete)
 *       → `merged-awaiting-verification`
 *
 * 3. Non-draft PR is open and referencing the issue:
 *    → `awaiting-review`
 *
 * 4. Issue is open AND (assigned OR a draft PR references it):
 *    → `in-progress`
 *
 * 5. Issue is open, not assigned, no PR:
 *    → `requested`
 *
 * @param issue  GitHub issue state (or null if no issue found yet).
 * @param pr     GitHub PR state (or null if no PR references the issue).
 * @param scan   Latest scan state (or null if no scan has been run since filing).
 */
export function deriveStatus(
  issue: IssueState | null,
  pr: PrState | null,
  scan: ScanState | null,
): FixStatus {
  // No canonical issue → requested
  if (issue === null || !issue.hasMarker) {
    return 'requested';
  }

  // PR merged path
  if (pr !== null && pr.merged) {
    if (scan !== null && scan.familyCompleted) {
      if (!scan.fingerprintStillFires) {
        return 'verified-fixed';
      }
      return 'reopened';
    }
    return 'merged-awaiting-verification';
  }

  // Non-draft PR open → awaiting-review
  if (pr !== null && pr.open && !pr.draft) {
    return 'awaiting-review';
  }

  // Issue open + (assigned OR draft PR) → in-progress
  if (issue.open && (issue.assigned || (pr !== null && pr.draft))) {
    return 'in-progress';
  }

  // Issue open, unassigned, no non-draft open PR → requested
  return 'requested';
}

// ---------------------------------------------------------------------------
// fixes.json helpers
// ---------------------------------------------------------------------------

/**
 * Read fixes.json from `fixesPath`. Returns an empty object when the file does
 * not exist. Throws on parse/schema error.
 */
export function readFixesFile(fixesPath: string = DEFAULT_FIXES_PATH): FixesFile {
  if (!existsSync(fixesPath)) {
    return {};
  }
  const raw = readFileSync(fixesPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return FixesFileSchema.parse(parsed);
}

/**
 * Write `data` atomically to `fixesPath` via tmp+rename.
 * Does NOT acquire the workspace lock — callers must already hold it
 * (use `upsertFix` for the full locked read-modify-write).
 */
function atomicWriteFixesFile(data: FixesFile, fixesPath: string): void {
  const tmp = `${fixesPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, fixesPath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup; ignore failure
    }
    throw err;
  }
}

/**
 * Fingerprint-keyed read-modify-write on fixes.json, under the workspace lock.
 *
 * Creates `reports/fixes.json` if it does not exist.
 * Performs an atomic write (tmp+rename) per §14.
 *
 * @param fingerprint  Full 64-hex fingerprint (the canonical key, §6.6).
 * @param update       Function that receives the existing entry (or undefined)
 *                     and returns the new entry to write.
 * @param opts         Injectable paths for testing.
 */
export async function upsertFix(
  fingerprint: string,
  update: (existing: FixEntry | undefined) => FixEntry,
  opts?: {
    fixesPath?: string;
    lockPath?: string;
  },
): Promise<void> {
  const fixesPath = opts?.fixesPath ?? DEFAULT_FIXES_PATH;
  const lockOpts = opts?.lockPath !== undefined ? { lockPath: opts.lockPath } : undefined;

  // Ensure the reports directory exists before acquiring the lock
  await mkdir(dirname(fixesPath), { recursive: true });

  await withWorkspaceLock(() => {
    const data = readFixesFile(fixesPath);
    const existing = data[fingerprint];
    const updated = update(existing);
    data[fingerprint] = updated;
    atomicWriteFixesFile(data, fixesPath);
    return Promise.resolve();
  }, lockOpts);
}
