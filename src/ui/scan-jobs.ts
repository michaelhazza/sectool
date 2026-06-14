/**
 * src/ui/scan-jobs.ts — append-only scan-job event log.
 *
 * System invariant #7: this file is NEVER read-modify-written.
 * Each event is one newline-terminated append; state is derived by folding.
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// TTL for in-progress jobs — 30 minutes.
// A `dispatched` job with no subsequent `uploaded` after this window is
// surfaced as `timed_out` by foldJobs. Exported so tests can assert on it.
// ---------------------------------------------------------------------------
export const DISPATCH_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path — single source of truth (plan §9: "path defined once as a constant").
// ---------------------------------------------------------------------------

export function SCAN_JOBS_PATH(dataDir: string): string {
  return resolve(dataDir, 'history', 'scan-jobs.jsonl');
}

// ---------------------------------------------------------------------------
// Event union type (Contract C2)
// ---------------------------------------------------------------------------

export interface RequestedEvent {
  event: 'requested';
  jobId: string;
  targetRepo: string;
  stagingUrl: string;
  at: string;
}

export interface DispatchedEvent {
  event: 'dispatched';
  jobId: string;
  at: string;
}

export interface DispatchFailedEvent {
  event: 'dispatch_failed';
  jobId: string;
  reason: string;
  at: string;
}

export interface UploadedEvent {
  event: 'uploaded';
  jobId: string;
  runId: string;
  at: string;
}

export interface ReportIngestedEvent {
  event: 'report_ingested';
  trigger: string;
  runId: string;
  githubRunId?: string;
  replayed?: boolean;
  at: string;
  // No jobId — scheduled/replay events are audit-only, not folded into jobs.
}

export type ScanJobEvent =
  | RequestedEvent
  | DispatchedEvent
  | DispatchFailedEvent
  | UploadedEvent
  | ReportIngestedEvent;

// ---------------------------------------------------------------------------
// Folded job (Contract C3)
// ---------------------------------------------------------------------------

export type JobState = 'pre_dispatch' | 'in_progress' | 'timed_out' | 'complete' | 'failed';

export interface FoldedJob {
  jobId: string;
  targetRepo: string;
  stagingUrl: string;
  state: JobState;
  requestedAt: string;
  runId: string | null;
}

// ---------------------------------------------------------------------------
// appendEvent — single newline-terminated append, never read-modify-write.
// Creates the history/ dir if absent.
// ---------------------------------------------------------------------------

export function appendEvent(event: ScanJobEvent, dataDir: string): void {
  const path = SCAN_JOBS_PATH(dataDir);
  const dir = resolve(dataDir, 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path, JSON.stringify(event) + '\n', { flag: 'a' });
}

// ---------------------------------------------------------------------------
// foldJobs — derive current job states from the event log.
//
// Folding rule (§4.3 / C2 source-of-truth precedence):
//   - Identity fields (targetRepo, stagingUrl, requestedAt) come from the
//     `requested` event and are NEVER overwritten by later events.
//   - Current state = the latest STATUS event for that jobId.
//   - report_ingested events have no jobId and are excluded.
//   - Malformed TRAILING partial line is tolerated (incomplete write).
//   - A malformed INTERIOR line is skipped but does not corrupt valid lines.
// ---------------------------------------------------------------------------

export function foldJobs(dataDir: string, nowMs: number): FoldedJob[] {
  const path = SCAN_JOBS_PATH(dataDir);

  if (!fs.existsSync(path)) {
    return [];
  }

  const raw = fs.readFileSync(path, 'utf8');
  const lines = raw.split('\n');

  // Parse lines; tolerate a single malformed trailing partial line.
  const events: ScanJobEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Trailing partial line (last non-empty line after a partial write) is
      // expected and silently skipped. An interior malformed line is also
      // skipped so it does not corrupt the fold of the surrounding valid lines.
      continue;
    }

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'event' in parsed
    ) {
      events.push(parsed as ScanJobEvent);
    }
  }

  // Group by jobId; report_ingested has no jobId — exclude from folded jobs.
  const byJobId = new Map<string, ScanJobEvent[]>();
  for (const ev of events) {
    if (ev.event === 'report_ingested') continue;
    const { jobId } = ev;
    if (!byJobId.has(jobId)) byJobId.set(jobId, []);
    byJobId.get(jobId)!.push(ev);
  }

  const result: FoldedJob[] = [];

  for (const [jobId, jobEvents] of byJobId) {
    // Identity fields come from the `requested` event only.
    const requestedEv = jobEvents.find(
      (e): e is RequestedEvent => e.event === 'requested',
    );
    if (!requestedEv) continue; // Malformed log: no requested event; skip.

    const { targetRepo, stagingUrl, at: requestedAt } = requestedEv;

    // Current state = latest status event (all events that convey state).
    // Order: events appear in append order; last wins for state.
    let state: JobState = 'pre_dispatch';
    let runId: string | null = null;
    let dispatchedAt: string | null = null;

    for (const ev of jobEvents) {
      switch (ev.event) {
        case 'requested':
          state = 'pre_dispatch';
          break;
        case 'dispatched':
          state = 'in_progress';
          dispatchedAt = ev.at;
          break;
        case 'dispatch_failed':
          state = 'failed';
          dispatchedAt = null;
          break;
        case 'uploaded':
          state = 'complete';
          runId = ev.runId;
          dispatchedAt = null;
          break;
      }
    }

    // Derive timed_out: dispatched with no subsequent uploaded after TTL.
    if (state === 'in_progress' && dispatchedAt !== null) {
      const dispatchedMs = new Date(dispatchedAt).getTime();
      if (nowMs - dispatchedMs > DISPATCH_TTL_MS) {
        state = 'timed_out';
      }
    }

    result.push({ jobId, targetRepo, stagingUrl, state, requestedAt, runId });
  }

  return result;
}
