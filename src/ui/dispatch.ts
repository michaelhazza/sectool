/**
 * src/ui/dispatch.ts — workflow_dispatch call for on-demand scan triggering.
 *
 * System invariant #2: the dispatch URL owner/repo always comes from
 * AUDIT_WORKFLOW_REPO (parseOwnerRepo(workflowRepo)), NEVER from the scan
 * target provided by the caller. This is enforced here and must not be changed.
 *
 * Reuses GitHubHttpClient + authHeaders from src/fix/github.ts so no new HTTP
 * dependency is introduced (architecture decision — see plan gap 1).
 */

import { parseOwnerRepo, authHeaders, defaultGitHubClient } from '../fix/github.js';
import type { GitHubHttpClient } from '../fix/github.js';

export interface DispatchParams {
  /** AUDIT_WORKFLOW_REPO — the repo that owns the on-demand-scan.yml workflow. */
  workflowRepo: string;
  /** The scan target repo name (passed as input to the workflow, not used for URL). */
  targetRepo: string;
  /** The registered staging URL to scan (passed as input to the workflow). */
  stagingUrl: string;
  /** Correlation nonce minted by /api/scan (passed as input to the workflow). */
  jobId: string;
  /** AUDIT_GH_DISPATCH_TOKEN — fine-grained PAT with Actions write on workflowRepo. */
  token: string;
  /** Git ref to dispatch against (e.g. "main"). */
  ref: string;
}

export type DispatchResult =
  | { ok: true }
  | { ok: false; status: number };

/**
 * Dispatch the on-demand-scan.yml workflow via GitHub workflow_dispatch API.
 *
 * Invariant: the dispatch URL is built from workflowRepo (AUDIT_WORKFLOW_REPO),
 * never from targetRepo. The scan target is passed only as a workflow input.
 *
 * 204 → { ok: true }; any other status → { ok: false, status }.
 */
export async function dispatchScan(
  params: DispatchParams,
  client: GitHubHttpClient = defaultGitHubClient,
): Promise<DispatchResult> {
  const { workflowRepo, targetRepo, stagingUrl, jobId, token, ref } = params;

  // owner/repo come from workflowRepo (AUDIT_WORKFLOW_REPO), NOT from the scan target.
  const { owner, repo } = parseOwnerRepo(workflowRepo);

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/on-demand-scan.yml/dispatches`;

  const resp = await client({
    method: 'POST',
    url,
    headers: authHeaders(token),
    body: {
      ref,
      inputs: {
        target_repo: targetRepo,
        staging_url: stagingUrl,
        job_id: jobId,
      },
    },
  });

  if (resp.status === 204) {
    return { ok: true };
  }
  return { ok: false, status: resp.status };
}
