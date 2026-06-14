/**
 * src/fix/github.ts — GitHub fix-request integration (§5.3 step 2, §14)
 *
 * Files the remediation pack as a GitHub issue in the target repo labelled
 * `audit-fix`, carrying the full fingerprint as a stable marker.
 *
 * Idempotent at two levels (§5.3, §14):
 * 1. Issue level  — search-before-create: an open `audit-fix` issue bearing
 *    the fingerprint marker `<!-- audit-fix:<fingerprint>:initial -->` is
 *    reused, never duplicated. A label-only match without the marker is NOT
 *    treated as canonical.
 * 2. Comment level — search-before-comment: each comment carries a
 *    deterministic `<!-- audit-fix:<fingerprint>:<reason> -->` HTML marker;
 *    a comment with the same marker already present is a no-op (no new
 *    comment posted).
 *
 * Token: AUDIT_GITHUB_FIX_TOKEN — fine-grained PAT, issues:write +
 * issues:read + pull_requests:read. NEVER contents:write.
 * Missing token → MissingFixTokenError (named error, no HTTP call).
 *
 * The GitHub HTTP client is injectable so tests never hit the network.
 */

import type { RemediationPack } from './pack.js';
import type { Finding } from '../schemas/finding.js';

// ---------------------------------------------------------------------------
// Named errors
// ---------------------------------------------------------------------------

export class MissingFixTokenError extends Error {
  readonly kind = 'MissingFixTokenError' as const;
  constructor() {
    super(
      'AUDIT_GITHUB_FIX_TOKEN is not set. ' +
      'Configure a fine-grained PAT with issues:write + issues:read + pull_requests:read ' +
      'and set the environment variable to enable fix-request filing.',
    );
    this.name = 'MissingFixTokenError';
  }
}

export class GitHubApiError extends Error {
  readonly kind = 'GitHubApiError' as const;
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Injectable HTTP client contract
// ---------------------------------------------------------------------------

export interface GitHubRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface GitHubResponse {
  status: number;
  body: unknown;
}

export type GitHubHttpClient = (req: GitHubRequest) => Promise<GitHubResponse>;

// ---------------------------------------------------------------------------
// Injectable env reader
// ---------------------------------------------------------------------------

export type EnvReader = (name: string) => string | undefined;

// ---------------------------------------------------------------------------
// Marker helpers (deterministic, stable)
// ---------------------------------------------------------------------------

/**
 * Build the HTML fingerprint marker embedded in the issue body.
 * The `initial` reason is always present in the issue body at creation.
 */
export function buildIssueMarker(fingerprint: string): string {
  return `<!-- audit-fix:${fingerprint}:initial -->`;
}

/**
 * Build the HTML fingerprint marker embedded in a comment.
 */
export function buildCommentMarker(fingerprint: string, reason: string): string {
  return `<!-- audit-fix:${fingerprint}:${reason} -->`;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/**
 * Parse owner/repo from a GitHub git URL or HTTPS repo URL.
 * Accepts:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 */
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  // HTTPS form: https://github.com/owner/repo[.git]
  const httpsMatch = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  // SSH form: git@github.com:owner/repo[.git]
  const sshMatch = /github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // Bare "owner/repo" form (exactly two non-slash segments) — the documented
  // shape of AUDIT_WORKFLOW_REPO (e.g. "breakoutsolutions/sectool"). Anchored so
  // it only matches a bare pair, never a URL (which the patterns above handle).
  const bareMatch = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(repoUrl.trim());
  if (bareMatch?.[1] && bareMatch[2]) {
    return { owner: bareMatch[1], repo: bareMatch[2] };
  }
  throw new Error(`Cannot parse owner/repo from: ${repoUrl}`);
}

export function authHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Issue search
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  html_url: string;
  body: string | null;
  state: string;
}

interface GitHubComment {
  id: number;
  body: string | null;
}

/**
 * Search for an open `audit-fix` issue in the repo that carries the
 * fingerprint marker in its body.
 *
 * Uses GitHub Issues Search API to find open issues with the `audit-fix`
 * label, then checks each result's body for the exact fingerprint marker.
 * A label-only match without the marker is NOT treated as canonical (§P8-2
 * state-based idempotency content check).
 *
 * Returns the matching issue (number + URL) or null if none found.
 */
async function findExistingIssue(
  owner: string,
  repo: string,
  fingerprint: string,
  token: string,
  client: GitHubHttpClient,
): Promise<{ number: number; html_url: string } | null> {
  const marker = buildIssueMarker(fingerprint);
  // Search open issues with the audit-fix label in the target repo
  const searchUrl =
    `https://api.github.com/search/issues?q=repo:${owner}/${repo}+label:audit-fix+state:open+is:issue&per_page=100`;

  const resp = await client({
    method: 'GET',
    url: searchUrl,
    headers: authHeaders(token),
  });

  if (resp.status !== 200) {
    throw new GitHubApiError(
      `GitHub issue search failed: HTTP ${resp.status}`,
      resp.status,
    );
  }

  const data = resp.body as { items: GitHubIssue[] };
  for (const issue of data.items) {
    if (issue.body !== null && issue.body.includes(marker)) {
      return { number: issue.number, html_url: issue.html_url };
    }
  }
  return null;
}

/**
 * Search existing comments on an issue for a specific marker.
 * Returns true if a comment with the exact marker already exists (no-op case).
 */
async function commentMarkerExists(
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  token: string,
  client: GitHubHttpClient,
): Promise<boolean> {
  let page = 1;
  // GitHub paginates at 100 per page; scan all pages
  while (true) {
    const url =
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;

    const resp = await client({
      method: 'GET',
      url,
      headers: authHeaders(token),
    });

    if (resp.status !== 200) {
      throw new GitHubApiError(
        `GitHub comment list failed: HTTP ${resp.status}`,
        resp.status,
      );
    }

    const comments = resp.body as GitHubComment[];
    for (const comment of comments) {
      if (comment.body !== null && comment.body.includes(marker)) {
        return true;
      }
    }
    // GitHub returns fewer than per_page items on the last page
    if (comments.length < 100) break;
    page++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Issue creation
// ---------------------------------------------------------------------------

function buildIssueBody(pack: RemediationPack, fingerprint: string): string {
  // The fingerprint marker is embedded in the body so the search-before-create
  // can locate this issue on retry (idempotency per §5.3).
  return `${pack.markdown}

---

${buildIssueMarker(fingerprint)}`;
}

async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  token: string,
  client: GitHubHttpClient,
): Promise<{ number: number; html_url: string }> {
  const resp = await client({
    method: 'POST',
    url: `https://api.github.com/repos/${owner}/${repo}/issues`,
    headers: authHeaders(token),
    body: {
      title,
      body,
      labels: ['audit-fix'],
    },
  });

  if (resp.status !== 201) {
    throw new GitHubApiError(
      `GitHub issue creation failed: HTTP ${resp.status}`,
      resp.status,
    );
  }

  const created = resp.body as GitHubIssue;
  return { number: created.number, html_url: created.html_url };
}

// ---------------------------------------------------------------------------
// Comment posting
// ---------------------------------------------------------------------------

/**
 * Post a comment on an existing issue, keyed by fingerprint + reason marker.
 * If a comment with the same marker already exists, this is a no-op (§5.3
 * search-before-comment idempotency).
 */
export async function commentOnIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  reason: string,
  body: string,
  fingerprint: string,
  token: string,
  client: GitHubHttpClient,
): Promise<void> {
  const marker = buildCommentMarker(fingerprint, reason);

  const alreadyExists = await commentMarkerExists(
    owner,
    repo,
    issueNumber,
    marker,
    token,
    client,
  );
  if (alreadyExists) return;

  const commentBody = `${body}\n\n${marker}`;
  const resp = await client({
    method: 'POST',
    url: `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    headers: authHeaders(token),
    body: { body: commentBody },
  });

  if (resp.status !== 201) {
    throw new GitHubApiError(
      `GitHub comment creation failed: HTTP ${resp.status}`,
      resp.status,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FileFixRequestResult {
  issueUrl: string;
  issueNumber: number;
  /** true when an existing issue was reused; false when a new one was created */
  reused: boolean;
}

/**
 * File a fix-request issue for a finding.
 *
 * Implements §5.3 step 2:
 * 1. Reads AUDIT_GITHUB_FIX_TOKEN from env (injectable for tests).
 *    Missing → MissingFixTokenError, zero HTTP calls.
 * 2. Parses owner/repo from finding.target.kind === 'repo' gitUrl, or from
 *    the explicit repoUrl parameter.
 * 3. Search-before-create: searches open `audit-fix` issues for the
 *    fingerprint marker. If found, posts a comment instead; if not, creates.
 * 4. Returns { issueUrl, issueNumber, reused }.
 *
 * The token value is never logged or persisted — it is consumed only in the
 * Authorization header of HTTP requests.
 */
export async function fileFixRequest(
  finding: Finding,
  pack: RemediationPack,
  repoUrl: string,
  opts?: {
    client?: GitHubHttpClient;
    env?: EnvReader;
  },
): Promise<FileFixRequestResult> {
  const env: EnvReader = opts?.env ?? ((name) => process.env[name]);
  const client: GitHubHttpClient = opts?.client ?? defaultGitHubClient;

  const token = env('AUDIT_GITHUB_FIX_TOKEN');
  if (!token) {
    throw new MissingFixTokenError();
  }

  const { owner, repo } = parseOwnerRepo(repoUrl);
  const fingerprint = finding.fingerprint;

  // Search-before-create: check for an existing open issue with this marker
  const existing = await findExistingIssue(owner, repo, fingerprint, token, client);

  if (existing !== null) {
    // Issue exists — post a re-file comment (idempotent via search-before-comment)
    await commentOnIssue(
      owner,
      repo,
      existing.number,
      'refiled',
      `This finding has been re-filed. The remediation pack is unchanged.\n\n**Fingerprint:** \`${fingerprint}\``,
      fingerprint,
      token,
      client,
    );
    return { issueUrl: existing.html_url, issueNumber: existing.number, reused: true };
  }

  // No existing issue — create a new one
  const title = `[audit-fix] ${finding.ruleId}: ${finding.vulnClass} in ${
    finding.surface === 'static'
      ? finding.target.name
      : finding.target.host
  }`;
  const body = buildIssueBody(pack, fingerprint);

  const created = await createIssue(owner, repo, title, body, token, client);
  return { issueUrl: created.html_url, issueNumber: created.number, reused: false };
}

// ---------------------------------------------------------------------------
// Default HTTP client (production — uses Node fetch)
// ---------------------------------------------------------------------------

export const defaultGitHubClient: GitHubHttpClient = async (req) => {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body };
};
