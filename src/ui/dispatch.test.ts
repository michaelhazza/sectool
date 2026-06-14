import { describe, it, expect } from 'vitest';
import { dispatchScan } from './dispatch.js';
import type { GitHubHttpClient, GitHubRequest, GitHubResponse } from '../fix/github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpy(status: number): {
  client: GitHubHttpClient;
  calls: GitHubRequest[];
} {
  const calls: GitHubRequest[] = [];
  const client: GitHubHttpClient = (req: GitHubRequest): Promise<GitHubResponse> => {
    calls.push(req);
    return Promise.resolve({ status, body: {} });
  };
  return { client, calls };
}

const BASE_PARAMS = {
  workflowRepo: 'https://github.com/breakout/audit-workflows',
  targetRepo: 'my-app',
  stagingUrl: 'https://staging.my-app.com',
  jobId: 'aabbccdd11223344aabbccdd11223344',
  token: 'ghp_test_token',
  ref: 'main',
};

// ---------------------------------------------------------------------------
// Dispatch URL construction — system invariant #2
// ---------------------------------------------------------------------------

describe('dispatchScan — URL construction', () => {
  it('builds the dispatch URL from workflowRepo (AUDIT_WORKFLOW_REPO), not targetRepo', async () => {
    const { client, calls } = makeSpy(204);
    await dispatchScan(BASE_PARAMS, client);
    expect(calls.length).toBe(1);
    // URL must reference the workflow repo owner/repo, not the scan target
    expect(calls[0]!.url).toContain('/repos/breakout/audit-workflows/actions/workflows/on-demand-scan.yml/dispatches');
    expect(calls[0]!.url).not.toContain('my-app');
  });

  it('dispatches to a different workflowRepo than targetRepo without including targetRepo in the URL', async () => {
    const { client, calls } = makeSpy(204);
    await dispatchScan(
      {
        ...BASE_PARAMS,
        workflowRepo: 'https://github.com/acme/workflow-repo',
        targetRepo: 'completely-different-repo',
      },
      client,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain('/repos/acme/workflow-repo/actions/workflows/on-demand-scan.yml/dispatches');
    expect(calls[0]!.url).not.toContain('completely-different-repo');
  });

  it('sets method to POST', async () => {
    const { client, calls } = makeSpy(204);
    await dispatchScan(BASE_PARAMS, client);
    expect(calls[0]!.method).toBe('POST');
  });

  it('includes the correct Authorization Bearer header', async () => {
    const { client, calls } = makeSpy(204);
    await dispatchScan(BASE_PARAMS, client);
    expect(calls[0]!.headers['Authorization']).toBe('Bearer ghp_test_token');
  });

  it('sends ref and inputs (target_repo, staging_url, job_id) in the body', async () => {
    const { client, calls } = makeSpy(204);
    await dispatchScan(BASE_PARAMS, client);
    const body = calls[0]!.body as { ref: string; inputs: Record<string, string> };
    expect(body.ref).toBe('main');
    expect(body.inputs.target_repo).toBe('my-app');
    expect(body.inputs.staging_url).toBe('https://staging.my-app.com');
    expect(body.inputs.job_id).toBe('aabbccdd11223344aabbccdd11223344');
  });
});

// ---------------------------------------------------------------------------
// DispatchResult variants
// ---------------------------------------------------------------------------

describe('dispatchScan — result', () => {
  it('returns { ok: true } on 204', async () => {
    const { client } = makeSpy(204);
    const result = await dispatchScan(BASE_PARAMS, client);
    expect(result.ok).toBe(true);
  });

  it('returns { ok: false, status: 401 } on 401', async () => {
    const { client } = makeSpy(401);
    const result = await dispatchScan(BASE_PARAMS, client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it('returns { ok: false, status: 422 } on 422', async () => {
    const { client } = makeSpy(422);
    const result = await dispatchScan(BASE_PARAMS, client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });

  it('returns { ok: false, status: 500 } on 500', async () => {
    const { client } = makeSpy(500);
    const result = await dispatchScan(BASE_PARAMS, client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });
});
