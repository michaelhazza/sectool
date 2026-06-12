/**
 * auditLog.ts
 *
 * Append-only audit log writer for coordinator decisions (§11a Step 9, §11b).
 *
 * Output: coordinator-decisions-<slug>-<timestamp>.jsonl
 * One JSON object per line. Includes disagreement-stitched records (§11b).
 *
 * Fields per §11a Step 9:
 *   timestamp, reviewer, finding_id, decision, coordinator_override_reason (optional),
 *   versioning quartet, acceptance_check_outcome, defer_reason (optional),
 *   rollback_diff_hash (optional), disagreements[] (optional, coordinator-stitched records)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DisagreementRecord } from './applyFindingsPure.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcceptanceCheckOutcome = 'passed' | 'failed' | 'deferred';

export interface AuditLogEntry {
  timestamp: string;
  reviewer: string;
  finding_id: string;
  decision:
    | 'applied'
    | 'overridden_to_surface'
    | 'auto_apply_failed'
    | 'quarantined'
    | 'already_applied_by_reviewer'
    | 'suppressed_advisory'
    | 'cumulative_verify_failed';
  coordinator_override_reason?: string;
  contract_version: string;
  prompt_version?: string;
  reviewer_version?: string;
  stitched_from?: string[];
  project_context_version?: string;
  source_artifact_sha?: string;
  acceptance_check_outcome: AcceptanceCheckOutcome;
  defer_reason?: string;
  rollback_diff_hash?: string;
  openai_repair_retry_attempted?: boolean;
  openai_repair_retry_succeeded?: boolean;
  disagreements?: DisagreementRecord[];
  suppressed_by?: string;
}

export interface AuditLogOptions {
  logPath: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Append a single audit log entry to the JSONL file.
 * Creates the file and parent directories if they don't exist.
 */
export function appendAuditLogEntry(entry: AuditLogEntry, options: AuditLogOptions): void {
  const { logPath } = options;
  const absPath = resolve(logPath);
  mkdirSync(dirname(absPath), { recursive: true });
  appendFileSync(absPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Build the standard audit log path for a build slug.
 * Format: tasks/review-logs/coordinator-decisions-<slug>-<timestamp>.jsonl
 */
export function buildAuditLogPath(
  projectRoot: string,
  buildSlug: string,
  timestamp?: string,
): string {
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return resolve(projectRoot, `tasks/review-logs/coordinator-decisions-${buildSlug}-${ts}.jsonl`);
}

/**
 * Build a quarantine log path for a failed reviewer output.
 * Format: tasks/review-logs/quarantined/<reviewer>-<timestamp>.json
 */
export function buildQuarantineLogPath(
  projectRoot: string,
  reviewer: string,
  timestamp?: string,
): string {
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return resolve(projectRoot, `tasks/review-logs/quarantined/${reviewer}-${ts}.json`);
}
