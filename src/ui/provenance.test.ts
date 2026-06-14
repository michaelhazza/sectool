import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyOnDemand, verifyGithubRun, runIdExistsOnVolume } from './provenance.js';
import type { Clock } from './provenance.js';
import type { FoldedJob } from './scan-jobs.js';
import type { GitHubResponse } from '../fix/github.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFoldedJob(overrides: Partial<FoldedJob> = {}): FoldedJob {
  return {
    jobId: 'aabbcc1122334455aabbcc1122334455',
    targetRepo: 'my-app',
    stagingUrl: 'https://staging.example.com',
    state: 'in_progress',
    requestedAt: '2026-06-14T10:00:00.000Z',
    runId: null,
    ...overrides,
  };
}

const fixedNow = new Date('2026-06-14T12:00:00.000Z').getTime();
const fakeClock: Clock = { now: () => fixedNow };

// ---------------------------------------------------------------------------
// verifyOnDemand
// ---------------------------------------------------------------------------

describe('verifyOnDemand', () => {
  it('returns ok for a matching in_progress job', () => {
    const jobs: FoldedJob[] = [makeFoldedJob()];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'my-app', stagingUrl: 'https://staging.example.com' },
      jobs,
    );
    expect(result.ok).toBe(true);
  });

  it('returns not-ok for an unknown jobId → 409', () => {
    const result = verifyOnDemand(
      { jobId: 'unknown-job-id', targetRepo: 'my-app', stagingUrl: 'https://staging.example.com' },
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown jobId/);
  });

  it('returns not-ok for a mismatched jobId (different job in list)', () => {
    const jobs: FoldedJob[] = [makeFoldedJob({ jobId: 'other-job-id-00000000000000000000' })];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'my-app', stagingUrl: 'https://staging.example.com' },
      jobs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown jobId/);
  });

  it('returns not-ok for already-uploaded (complete) job → replay guard 409', () => {
    const jobs: FoldedJob[] = [makeFoldedJob({ state: 'complete', runId: '2026-06-14T10-00-00Z-abcd' })];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'my-app', stagingUrl: 'https://staging.example.com' },
      jobs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already uploaded/);
  });

  it('returns not-ok for a failed job (not in_progress state)', () => {
    const jobs: FoldedJob[] = [makeFoldedJob({ state: 'failed' })];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'my-app', stagingUrl: 'https://staging.example.com' },
      jobs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in dispatched state/);
  });

  it('returns not-ok when targetRepo does not match', () => {
    const jobs: FoldedJob[] = [makeFoldedJob()];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'wrong-app', stagingUrl: 'https://staging.example.com' },
      jobs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/targetRepo mismatch/);
  });

  it('returns not-ok when stagingUrl does not match', () => {
    const jobs: FoldedJob[] = [makeFoldedJob()];
    const result = verifyOnDemand(
      { jobId: 'aabbcc1122334455aabbcc1122334455', targetRepo: 'my-app', stagingUrl: 'https://wrong.example.com' },
      jobs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stagingUrl mismatch/);
  });
});

// ---------------------------------------------------------------------------
// verifyGithubRun
// ---------------------------------------------------------------------------

const EXPECTED_REPO = 'https://github.com/acme/audit-workflows';
const TOKEN = 'ghp_test_token';

function makeGoodRun(overrides: Partial<{
  id: number;
  status: string | null;
  head_sha: string;
  path: string;
  workflow_id: number;
  run_started_at: string;
}> = {}): Record<string, unknown> {
  return {
    id: 12345,
    status: 'completed',
    head_sha: 'abc123def456abc123def456abc123def456abc123',
    path: '.github/workflows/on-demand-scan.yml',
    workflow_id: 99,
    run_started_at: new Date(fixedNow - 30 * 60 * 1000).toISOString(), // 30 minutes ago
    ...overrides,
  };
}

describe('verifyGithubRun', () => {
  it('returns ok for a matching completed run (path match)', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun() });

    const result = await verifyGithubRun(
      {
        githubRunId: '12345',
        githubWorkflow: '.github/workflows/on-demand-scan.yml',
        githubSha: 'abc123def456abc123def456abc123def456abc123',
        expectedRepo: EXPECTED_REPO,
      },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok for a matching completed run (numeric workflow_id match)', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun({ path: 'totally-different-path' }) });

    const result = await verifyGithubRun(
      {
        githubRunId: '12345',
        githubWorkflow: '99', // numeric id
        githubSha: 'abc123def456abc123def456abc123def456abc123',
        expectedRepo: EXPECTED_REPO,
      },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when run is not found (404)', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 404, body: {} });

    const result = await verifyGithubRun(
      { githubRunId: '99999', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc', expectedRepo: EXPECTED_REPO },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it('rejects when status is not completed', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun({ status: 'in_progress' }) });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc123def456abc123def456abc123def456abc123', expectedRepo: EXPECTED_REPO },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not completed/);
  });

  it('rejects when head_sha does not match', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun({ head_sha: 'completely-different-sha' }) });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'expected-sha', expectedRepo: EXPECTED_REPO },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/head_sha mismatch/);
  });

  it('rejects when workflow path does not match AND numeric id does not match — display name match is NOT sufficient', async () => {
    // The run has a `name` field that would match (display name), but path and workflow_id do NOT match.
    // This is the named §4.2 test: workflow must be matched by path/id, never name.
    const runWithNameMatch = {
      ...makeGoodRun({ path: 'completely/wrong/path.yml', workflow_id: 999 }),
      name: 'on-demand-scan', // display name matches — must NOT be used for matching
    };
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: runWithNameMatch });

    const result = await verifyGithubRun(
      {
        githubRunId: '12345',
        githubWorkflow: '.github/workflows/on-demand-scan.yml', // path that does NOT match run.path
        githubSha: 'abc123def456abc123def456abc123def456abc123',
        expectedRepo: EXPECTED_REPO,
      },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/[Ww]orkflow mismatch/);
  });

  it('rejects when run is outside freshness window (non-replay)', async () => {
    const oldStartedAt = new Date(fixedNow - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago → outside 2h window
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun({ run_started_at: oldStartedAt }) });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc123def456abc123def456abc123def456abc123', expectedRepo: EXPECTED_REPO },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/freshness window/);
  });

  it('accepts an old run when relaxFreshness=true (replay mode)', async () => {
    const oldStartedAt = new Date(fixedNow - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago — stale for normal, ok for replay
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun({ run_started_at: oldStartedAt }) });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc123def456abc123def456abc123def456abc123', expectedRepo: EXPECTED_REPO, relaxFreshness: true },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when GitHub API errors (non-200/non-404)', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 500, body: {} });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc', expectedRepo: EXPECTED_REPO },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/500/);
  });

  it('rejects when expectedRepo cannot be parsed', async () => {
    const client = (): Promise<GitHubResponse> =>
      Promise.resolve({ status: 200, body: makeGoodRun() });

    const result = await verifyGithubRun(
      { githubRunId: '12345', githubWorkflow: '.github/workflows/on-demand-scan.yml', githubSha: 'abc', expectedRepo: 'not-a-github-url' },
      client,
      fakeClock,
      TOKEN,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Cannot parse expectedRepo/);
  });
});

// ---------------------------------------------------------------------------
// runIdExistsOnVolume
// ---------------------------------------------------------------------------

describe('runIdExistsOnVolume', () => {
  const tmpBase = resolve(tmpdir(), `audit-provenance-test-${process.pid}`);

  it('returns false when the runId directory does not exist', () => {
    const reportsDir = resolve(tmpBase, 'reports-nonexistent');
    expect(runIdExistsOnVolume('2026-06-14T10-00-00Z-abcd', reportsDir)).toBe(false);
  });

  it('returns true when the runId directory exists', () => {
    const reportsDir = resolve(tmpBase, 'reports-exists');
    const runDir = resolve(reportsDir, '2026-06-14T10-00-00Z-abcd');
    try {
      mkdirSync(runDir, { recursive: true });
      expect(runIdExistsOnVolume('2026-06-14T10-00-00Z-abcd', reportsDir)).toBe(true);
    } finally {
      try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns false when only other runId directories exist', () => {
    const reportsDir = resolve(tmpBase, 'reports-other');
    const otherDir = resolve(reportsDir, '2026-06-14T10-00-00Z-ffff');
    try {
      mkdirSync(otherDir, { recursive: true });
      expect(runIdExistsOnVolume('2026-06-14T10-00-00Z-abcd', reportsDir)).toBe(false);
    } finally {
      try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
