import { describe, it, expect, vi } from 'vitest';
import type { Finding } from '../schemas/finding.js';
import type { RemediationPack } from './pack.js';
import type { GitHubHttpClient, GitHubResponse } from './github.js';
import {
  fileFixRequest,
  commentOnIssue,
  MissingFixTokenError,
  buildIssueMarker,
  buildCommentMarker,
  parseOwnerRepo,
} from './github.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_FP = 'b'.repeat(64);
const DISPLAY_ID = `f-${'b'.repeat(16)}`;
const REPO_URL = 'https://github.com/breakout/automation-v1.git';

function makeStaticFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: DISPLAY_ID,
    fingerprint: FULL_FP,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'critical',
    baseSeverity: 'critical',
    confidence: 'probable',
    target: { kind: 'repo', name: 'automation-v1', commit: 'abc123' },
    location: {
      path: 'server/routes/users.ts',
      symbol: 'GET /api/users/:id',
      startLine: 42,
    },
    evidence: { snippet: 'db.execute(sql`SELECT * FROM users`)', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
}

function makePack(): RemediationPack {
  return {
    json: {
      fingerprint: FULL_FP,
      id: DISPLAY_ID,
      ruleId: 'BS-SQL-001',
      problemStatement: 'SQL injection via unsanitized request parameter.',
      location: 'server/routes/users.ts — GET /api/users/:id',
      severity: 'critical',
      severityRationale: 'Base severity: critical',
      fixGuidance: 'Use parameterized queries.',
      acceptanceCriteria: {
        ruleId: 'BS-SQL-001',
        fingerprint: FULL_FP,
        description: 'The finding must no longer fire.',
      },
      generatedAt: '2026-06-13T00:00:00.000Z',
    },
    markdown: '# Remediation Pack\n\nSQL injection.',
    prompt: 'Fix this SQL injection.',
  };
}

// Reusable env helpers — avoid inline lambdas with unused params
function envWithToken(token: string): (name: string) => string | undefined {
  return (name) => (name === 'AUDIT_GITHUB_FIX_TOKEN' ? token : undefined);
}

function envNoToken(): (name: string) => string | undefined {
  return (name) => (name === 'AUDIT_GITHUB_FIX_TOKEN' ? undefined : undefined);
}

// ---------------------------------------------------------------------------
// Helpers for building mock HTTP clients
// ---------------------------------------------------------------------------

/** A GitHub HTTP client that records all calls made to it. */
function makeRecordingClient(
  handler: (url: string, method: string, body: unknown) => GitHubResponse,
): { client: GitHubHttpClient; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const client: GitHubHttpClient = (req) => {
    calls.push({ url: req.url, method: req.method, body: req.body });
    return Promise.resolve(handler(req.url, req.method, req.body));
  };
  return { client, calls };
}

/** Empty search result (no matching issues). */
function emptySearchResponse(): GitHubResponse {
  return { status: 200, body: { items: [] } };
}

/** Search result with a matching issue bearing the fingerprint marker. */
function matchingIssueResponse(fingerprint: string): GitHubResponse {
  return {
    status: 200,
    body: {
      items: [
        {
          number: 42,
          html_url: 'https://github.com/breakout/automation-v1/issues/42',
          body: `Some body text\n\n${buildIssueMarker(fingerprint)}`,
          state: 'open',
        },
      ],
    },
  };
}

/** Search result with an issue that has the label but NO fingerprint marker. */
function labelOnlyIssueResponse(): GitHubResponse {
  return {
    status: 200,
    body: {
      items: [
        {
          number: 99,
          html_url: 'https://github.com/breakout/automation-v1/issues/99',
          body: 'Issue body with audit-fix label but no fingerprint marker.',
          state: 'open',
        },
      ],
    },
  };
}

/** Created issue response. */
function createdIssueResponse(): GitHubResponse {
  return {
    status: 201,
    body: {
      number: 7,
      html_url: 'https://github.com/breakout/automation-v1/issues/7',
      body: null,
      state: 'open',
    },
  };
}

/** Empty comment list (first page). */
function emptyCommentsResponse(): GitHubResponse {
  return { status: 200, body: [] };
}

/** Comment list containing a matching marker. */
function matchingCommentResponse(marker: string): GitHubResponse {
  return {
    status: 200,
    body: [
      {
        id: 1001,
        body: `Some comment text\n\n${marker}`,
      },
    ],
  };
}

/** Created comment response. */
function createdCommentResponse(): GitHubResponse {
  return {
    status: 201,
    body: { id: 2002, body: 'comment body' },
  };
}

// ---------------------------------------------------------------------------
// parseOwnerRepo
// ---------------------------------------------------------------------------

describe('parseOwnerRepo', () => {
  it('parses HTTPS URL with .git suffix', () => {
    const result = parseOwnerRepo('https://github.com/breakout/automation-v1.git');
    expect(result.owner).toBe('breakout');
    expect(result.repo).toBe('automation-v1');
  });

  it('parses HTTPS URL without .git suffix', () => {
    const result = parseOwnerRepo('https://github.com/breakout/automation-v1');
    expect(result.owner).toBe('breakout');
    expect(result.repo).toBe('automation-v1');
  });

  it('parses SSH URL', () => {
    const result = parseOwnerRepo('git@github.com:breakout/automation-v1.git');
    expect(result.owner).toBe('breakout');
    expect(result.repo).toBe('automation-v1');
  });

  it('parses the bare owner/repo form (documented AUDIT_WORKFLOW_REPO shape)', () => {
    const result = parseOwnerRepo('breakoutsolutions/sectool');
    expect(result.owner).toBe('breakoutsolutions');
    expect(result.repo).toBe('sectool');
  });

  it('throws on an unrecognized format (no slash)', () => {
    expect(() => parseOwnerRepo('not-a-github-url')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildIssueMarker / buildCommentMarker
// ---------------------------------------------------------------------------

describe('marker helpers', () => {
  it('buildIssueMarker embeds the full fingerprint', () => {
    const marker = buildIssueMarker(FULL_FP);
    expect(marker).toMatch(new RegExp(FULL_FP));
    expect(marker).toMatch(/<!-- audit-fix:/);
    expect(marker).toMatch(/:initial -->/);
  });

  it('buildCommentMarker embeds the fingerprint and reason', () => {
    const marker = buildCommentMarker(FULL_FP, 'reopened');
    expect(marker).toMatch(new RegExp(FULL_FP));
    expect(marker).toMatch(/:reopened -->/);
  });
});

// ---------------------------------------------------------------------------
// fileFixRequest — missing token
// ---------------------------------------------------------------------------

describe('fileFixRequest — missing token', () => {
  it('throws MissingFixTokenError when AUDIT_GITHUB_FIX_TOKEN is absent', async () => {
    const { client, calls } = makeRecordingClient(() => emptySearchResponse());

    await expect(
      fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
        client,
        env: envNoToken(),
      }),
    ).rejects.toThrow(MissingFixTokenError);

    expect(calls).toHaveLength(0);
  });

  it('makes zero HTTP calls when the token is missing', async () => {
    const { client, calls } = makeRecordingClient(() => emptySearchResponse());

    await expect(
      fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
        client,
        env: envNoToken(),
      }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it('MissingFixTokenError has a descriptive message mentioning the env var name', () => {
    const err = new MissingFixTokenError();
    expect(err.message).toMatch(/AUDIT_GITHUB_FIX_TOKEN/);
    expect(err.kind).toBe('MissingFixTokenError');
  });
});

// ---------------------------------------------------------------------------
// fileFixRequest — no existing issue → creates one
// ---------------------------------------------------------------------------

describe('fileFixRequest — no existing issue', () => {
  it('creates a new issue when no open audit-fix issue has the fingerprint marker', async () => {
    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    const result = await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-001'),
    });

    expect(result.reused).toBe(false);
    expect(result.issueUrl).toMatch(/github\.com.*issues/);
    expect(result.issueNumber).toBe(7);

    // Search call + create call
    expect(calls).toHaveLength(2);
    const createCall = calls[1];
    expect(createCall).toBeDefined();
    expect(createCall!.method).toBe('POST');
    expect(createCall!.url).toMatch(/repos\/breakout\/automation-v1\/issues$/);
  });

  it('the created issue body contains the audit-fix label', async () => {
    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-002'),
    });

    const createCall = calls[1];
    expect(createCall).toBeDefined();
    const body = createCall!.body as { labels: string[] };
    expect(body.labels).toContain('audit-fix');
  });

  it('the created issue body contains the fingerprint marker', async () => {
    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-003'),
    });

    const createCall = calls[1];
    expect(createCall).toBeDefined();
    const body = createCall!.body as { body: string };
    expect(body.body).toMatch(new RegExp(FULL_FP));
    expect(body.body).toMatch(/<!-- audit-fix:/);
  });
});

// ---------------------------------------------------------------------------
// fileFixRequest — existing open issue with fingerprint marker → reused, comments
// ---------------------------------------------------------------------------

describe('fileFixRequest — existing issue with fingerprint marker', () => {
  it('reuses the existing issue and does not create a duplicate', async () => {
    // search finds matching issue, comment list empty, post comment succeeds
    const callResponses = [
      matchingIssueResponse(FULL_FP),   // search
      emptyCommentsResponse(),           // list comments page 1
      createdCommentResponse(),          // post comment
    ];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    const result = await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-004'),
    });

    expect(result.reused).toBe(true);
    expect(result.issueUrl).toBe('https://github.com/breakout/automation-v1/issues/42');
    expect(result.issueNumber).toBe(42);

    // No issue creation call — only search, comment-list, comment-post
    const createCalls = calls.filter(
      (c) => c.method === 'POST' && /\/issues$/.test(c.url),
    );
    expect(createCalls).toHaveLength(0);
  });

  it('returned issueUrl is correct', async () => {
    const callResponses = [
      matchingIssueResponse(FULL_FP),
      emptyCommentsResponse(),
      createdCommentResponse(),
    ];
    let callIdx = 0;
    const { client } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    const result = await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-005'),
    });

    expect(result.issueUrl).toBe('https://github.com/breakout/automation-v1/issues/42');
  });
});

// ---------------------------------------------------------------------------
// fileFixRequest — label-only issue (no marker) → treated as new, creates issue
// ---------------------------------------------------------------------------

describe('fileFixRequest — label-only issue without fingerprint marker', () => {
  it('does NOT reuse a label-only issue that lacks the fingerprint marker', async () => {
    const callResponses = [labelOnlyIssueResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    const result = await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken('EXAMPLE-fake-token-006'),
    });

    // A new issue should have been created
    expect(result.reused).toBe(false);
    expect(result.issueNumber).toBe(7);

    const createCalls = calls.filter(
      (c) => c.method === 'POST' && /\/issues$/.test(c.url),
    );
    expect(createCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// commentOnIssue — idempotent (search-before-comment)
// ---------------------------------------------------------------------------

describe('commentOnIssue — idempotency', () => {
  const OWNER = 'breakout';
  const REPO_NAME = 'automation-v1';
  const ISSUE_NUM = 42;
  const REASON = 'reopened';

  it('posts a comment when no existing comment has the marker', async () => {
    const callResponses = [emptyCommentsResponse(), createdCommentResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await commentOnIssue(
      OWNER, REPO_NAME, ISSUE_NUM, REASON,
      'Re-filing this finding.',
      FULL_FP,
      'EXAMPLE-fake-token-007',
      client,
    );

    const postCalls = calls.filter((c) => c.method === 'POST');
    expect(postCalls).toHaveLength(1);
  });

  it('is a no-op when a comment with the same marker already exists', async () => {
    const marker = buildCommentMarker(FULL_FP, REASON);
    const { client, calls } = makeRecordingClient(() =>
      matchingCommentResponse(marker),
    );

    await commentOnIssue(
      OWNER, REPO_NAME, ISSUE_NUM, REASON,
      'Re-filing this finding.',
      FULL_FP,
      'EXAMPLE-fake-token-008',
      client,
    );

    // Only the comment-list GET was made; no POST
    const postCalls = calls.filter((c) => c.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('the comment body embeds the deterministic marker', async () => {
    const callResponses = [emptyCommentsResponse(), createdCommentResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await commentOnIssue(
      OWNER, REPO_NAME, ISSUE_NUM, REASON,
      'Some body text.',
      FULL_FP,
      'EXAMPLE-fake-token-009',
      client,
    );

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall).toBeDefined();
    const body = postCall!.body as { body: string };
    const expectedMarker = buildCommentMarker(FULL_FP, REASON);
    expect(body.body).toMatch(new RegExp(expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

// ---------------------------------------------------------------------------
// Token never logged or persisted
// ---------------------------------------------------------------------------

describe('token not exposed', () => {
  it('the token value does not appear in the created issue body', async () => {
    const TOKEN = 'EXAMPLE-fake-token-010';
    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken(TOKEN),
    });

    const createCall = calls[1];
    expect(createCall).toBeDefined();
    const bodyStr = JSON.stringify(createCall!.body);
    expect(bodyStr).not.toMatch(TOKEN);
  });

  it('the token value is not present in the URL of any request', async () => {
    const TOKEN = 'EXAMPLE-fake-token-011';
    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const { client, calls } = makeRecordingClient(() => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      return resp;
    });

    await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envWithToken(TOKEN),
    });

    for (const call of calls) {
      expect(call.url).not.toMatch(TOKEN);
    }
  });
});

// ---------------------------------------------------------------------------
// Spy-based test: injected env reader is called with the correct key
// ---------------------------------------------------------------------------

describe('fileFixRequest — env reader spy', () => {
  it('calls the injected env reader with AUDIT_GITHUB_FIX_TOKEN', async () => {
    const envSpy = vi.fn((name: string): string | undefined =>
      name === 'AUDIT_GITHUB_FIX_TOKEN' ? 'EXAMPLE-fake-token-012' : undefined,
    );

    const callResponses = [emptySearchResponse(), createdIssueResponse()];
    let callIdx = 0;
    const client: GitHubHttpClient = (req) => {
      const resp = callResponses[callIdx];
      if (!resp) throw new Error('unexpected call');
      callIdx++;
      void req;
      return Promise.resolve(resp);
    };

    await fileFixRequest(makeStaticFinding(), makePack(), REPO_URL, {
      client,
      env: envSpy,
    });

    expect(envSpy).toHaveBeenCalledWith('AUDIT_GITHUB_FIX_TOKEN');
  });
});
