/**
 * src/ui/provenance.ts — pure provenance-binding verification module (Chunk 6).
 *
 * System invariants 3 and 4:
 *   - Every upload is provenance-bound, not just bearer-authed.
 *   - runId is validated against RUN_ID_RE before any path is built.
 *
 * This module is pure of HTTP (injectable client) and pure of time (injectable
 * clock) so tests never hit the network or real clock.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GitHubHttpClient } from '../fix/github.js';
import { authHeaders, parseOwnerRepo } from '../fix/github.js';
import type { FoldedJob } from './scan-jobs.js';

// ---------------------------------------------------------------------------
// Clock injectable (mirrors src/report/lock.ts Clock interface)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// on-demand provenance — jobId must be in `dispatched` state with matching
// targetRepo and stagingUrl (C6 contract §4.2, system invariant 3).
// ---------------------------------------------------------------------------

export interface OnDemandParams {
  jobId: string;
  targetRepo: string;
  stagingUrl: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify on-demand provenance by matching the jobId to a `dispatched` job
 * in the folded job list. The job must:
 *   - exist in the list (known jobId),
 *   - be currently in `in_progress` state (i.e. dispatched but not yet uploaded),
 *   - have a matching targetRepo and stagingUrl from its `requested` event.
 *
 * Already-`complete` jobs → 409 (replay guard: won't accept a second upload).
 */
export function verifyOnDemand(
  { jobId, targetRepo, stagingUrl }: OnDemandParams,
  foldedJobs: FoldedJob[],
): VerifyResult {
  const job = foldedJobs.find((j) => j.jobId === jobId);

  if (job === undefined) {
    return { ok: false, reason: `Unknown jobId: ${jobId}` };
  }

  if (job.state === 'complete') {
    return { ok: false, reason: `Job ${jobId} is already uploaded (replay guard)` };
  }

  if (job.state !== 'in_progress') {
    return { ok: false, reason: `Job ${jobId} is not in dispatched state (state: ${job.state})` };
  }

  if (job.targetRepo !== targetRepo) {
    return { ok: false, reason: `targetRepo mismatch: expected ${job.targetRepo}, got ${targetRepo}` };
  }

  if (job.stagingUrl !== stagingUrl) {
    return { ok: false, reason: `stagingUrl mismatch: expected ${job.stagingUrl}, got ${stagingUrl}` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// GitHub run verification — scheduled/replay provenance (C6 contract §4.2).
//
// Verifies by file path or numeric workflow_id — NEVER the mutable `name`
// field (display name). This is an explicit named invariant from the spec.
// ---------------------------------------------------------------------------

const FRESHNESS_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours default
const FRESHNESS_WINDOW_RELAXED_MS = 14 * 24 * 60 * 60 * 1000; // 14 days for replay

export interface GitHubRunParams {
  githubRunId: string;
  githubWorkflow: string;
  githubSha: string;
  expectedRepo: string;
  relaxFreshness?: boolean;
}

interface GitHubRunRecord {
  id: number;
  status: string | null;
  head_sha: string;
  path?: string;
  workflow_id?: number;
  run_started_at?: string | null;
  created_at?: string | null;
}

/**
 * Verify a GitHub Actions run by:
 *   1. run exists (GET /repos/{owner}/{repo}/actions/runs/{githubRunId})
 *   2. workflow matches by file path OR numeric workflow_id (NEVER `name`)
 *   3. status === "completed"
 *   4. head_sha === githubSha
 *   5. run_started_at / created_at within freshness window (relaxed for replay)
 *
 * Reuses GitHubHttpClient + authHeaders + parseOwnerRepo from fix/github.ts.
 * The token is read from process.env inside the route handler and passed in
 * via the authHeaders helper used in the underlying request.
 */
export async function verifyGithubRun(
  { githubRunId, githubWorkflow, githubSha, expectedRepo, relaxFreshness }: GitHubRunParams,
  client: GitHubHttpClient,
  clock: Clock,
  token: string,
): Promise<VerifyResult> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseOwnerRepo(expectedRepo));
  } catch (err) {
    return { ok: false, reason: `Cannot parse expectedRepo: ${err instanceof Error ? err.message : String(err)}` };
  }

  let response;
  try {
    response = await client({
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${githubRunId}`,
      headers: authHeaders(token),
    });
  } catch (err) {
    return { ok: false, reason: `GitHub API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (response.status === 404) {
    return { ok: false, reason: `GitHub run ${githubRunId} not found` };
  }

  if (response.status !== 200) {
    return { ok: false, reason: `GitHub API returned ${response.status} for run ${githubRunId}` };
  }

  const run = response.body as GitHubRunRecord;

  // Verify workflow by file path or numeric workflow_id — NEVER the mutable `name`.
  // githubWorkflow from CI context is the workflow file path (e.g. ".github/workflows/on-demand-scan.yml")
  // or may be a numeric id in edge cases. We check both.
  const pathMatches = typeof run.path === 'string' && run.path === githubWorkflow;
  const idAsNumber = Number(githubWorkflow);
  const idMatches =
    !isNaN(idAsNumber) &&
    typeof run.workflow_id === 'number' &&
    run.workflow_id === idAsNumber;

  if (!pathMatches && !idMatches) {
    return {
      ok: false,
      reason: `Workflow mismatch: run has path=${run.path ?? 'unknown'} workflow_id=${run.workflow_id ?? 'unknown'}, expected ${githubWorkflow}`,
    };
  }

  if (run.status !== 'completed') {
    return { ok: false, reason: `Run ${githubRunId} is not completed (status: ${run.status ?? 'null'})` };
  }

  if (run.head_sha !== githubSha) {
    return { ok: false, reason: `head_sha mismatch: run has ${run.head_sha}, expected ${githubSha}` };
  }

  // Freshness check: run_started_at or created_at must be within the window.
  const runTime = run.run_started_at ?? run.created_at;
  if (runTime !== null && runTime !== undefined) {
    const runMs = new Date(runTime).getTime();
    if (!isNaN(runMs)) {
      const windowMs = relaxFreshness === true ? FRESHNESS_WINDOW_RELAXED_MS : FRESHNESS_WINDOW_MS;
      if (clock.now() - runMs > windowMs) {
        return { ok: false, reason: `Run ${githubRunId} is outside the freshness window (started: ${runTime})` };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Duplicate-runId dedup check — does reports/<runId>/ already exist?
// ---------------------------------------------------------------------------

/**
 * Returns true when a reports/<runId>/ directory already exists on the volume.
 * Used to detect duplicate uploads and force the `replay` recovery path.
 */
export function runIdExistsOnVolume(runId: string, reportsDir: string): boolean {
  const runDir = resolve(reportsDir, runId);
  return existsSync(runDir);
}
