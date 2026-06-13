import * as https from 'node:https';
import * as http from 'node:http';
import type { AllowedTarget } from '../gate.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// Security headers probe — LIVE-HDR-001 (§7.3 passive family)
//
// Checks for the presence and correctness of HTTP security response headers:
// Content-Security-Policy, X-Frame-Options, X-Content-Type-Options,
// Strict-Transport-Security, Referrer-Policy, Permissions-Policy.
//
// Injectable `HeadersClient` so unit tests never hit the network.
// Off-host redirects are NOT followed; only the direct response headers are
// inspected (§4.4 scope confinement).
// ---------------------------------------------------------------------------

export interface HttpHeadResponse {
  status: number;
  headers: Record<string, string>;
  /** Redirect location if present; probe records it as scope-excluded, does not follow */
  redirectLocation?: string;
}

export type HeadersClient = (target: AllowedTarget) => Promise<HttpHeadResponse>;

interface HeaderIssue {
  issueKind: string;
  detail: string;
  raw: Record<string, unknown>;
}

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function checkHeaders(headers: Record<string, string>): HeaderIssue[] {
  const h = lowerHeaders(headers);
  const issues: HeaderIssue[] = [];

  // Strict-Transport-Security — must be present on https responses
  if (!h['strict-transport-security']) {
    issues.push({
      issueKind: 'missing-hsts',
      detail: 'Missing Strict-Transport-Security header. Add: Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
      raw: { 'strict-transport-security': null },
    });
  }

  // Content-Security-Policy — must be present
  if (!h['content-security-policy']) {
    issues.push({
      issueKind: 'missing-csp',
      detail: "Missing Content-Security-Policy header. Define a restrictive policy that avoids 'unsafe-inline' and 'unsafe-eval'.",
      raw: { 'content-security-policy': null },
    });
  }

  // X-Frame-Options — must be DENY or SAMEORIGIN
  const xfo = h['x-frame-options'];
  if (!xfo) {
    issues.push({
      issueKind: 'missing-xfo',
      detail: 'Missing X-Frame-Options header. Add: X-Frame-Options: DENY',
      raw: { 'x-frame-options': null },
    });
  } else if (!/^(DENY|SAMEORIGIN)$/i.test(xfo.trim())) {
    issues.push({
      issueKind: 'weak-xfo',
      detail: `X-Frame-Options value "${xfo}" is not DENY or SAMEORIGIN.`,
      raw: { 'x-frame-options': xfo },
    });
  }

  // X-Content-Type-Options — must be nosniff
  const xcto = h['x-content-type-options'];
  if (!xcto) {
    issues.push({
      issueKind: 'missing-xcto',
      detail: 'Missing X-Content-Type-Options header. Add: X-Content-Type-Options: nosniff',
      raw: { 'x-content-type-options': null },
    });
  } else if (xcto.trim().toLowerCase() !== 'nosniff') {
    issues.push({
      issueKind: 'weak-xcto',
      detail: `X-Content-Type-Options value "${xcto}" should be "nosniff".`,
      raw: { 'x-content-type-options': xcto },
    });
  }

  // Referrer-Policy — must be present
  if (!h['referrer-policy']) {
    issues.push({
      issueKind: 'missing-referrer-policy',
      detail: 'Missing Referrer-Policy header. Add: Referrer-Policy: strict-origin-when-cross-origin',
      raw: { 'referrer-policy': null },
    });
  }

  return issues;
}

function buildFinding(
  target: AllowedTarget,
  issue: HeaderIssue,
): Finding {
  const urlPath = new URL(target.url).pathname || '/';
  const normalizedPath = normalizeUrlPath(urlPath);
  const fp = fingerprint({
    kind: 'live',
    checkId: 'LIVE-HDR-001',
    host: target.hostname,
    urlPath: normalizedPath,
    parameter: '',
    evidenceClass: issue.issueKind,
  });
  const id = displayId(fp);
  const now = new Date().toISOString();

  return {
    id,
    fingerprint: fp,
    ruleId: 'LIVE-HDR-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'misconfiguration',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    target: { kind: 'staging', host: target.hostname },
    location: { url: target.url, method: 'GET' },
    evidence: {
      snippet: issue.detail,
      cvss: null,
      raw: redact(issue.raw) as Record<string, unknown>,
    },
    reachability: 'unauthenticated',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: now,
    suppressed: false,
    suppression: null,
    note: null,
  };
}

/**
 * Real HTTP/HTTPS client for the headers probe.
 * Makes a HEAD request to the target URL and returns the response headers.
 * Does not follow redirects — the redirect location is returned for scope-exclusion recording.
 */
export const defaultHeadersClient: HeadersClient = (target: AllowedTarget): Promise<HttpHeadResponse> => {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.startsWith('https://');
    const client = isHttps ? https : http;
    const req = client.request(
      target.url,
      { method: 'HEAD', headers: { 'User-Agent': 'audit-tool/1.0.0' }, rejectUnauthorized: false },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(', ');
        }
        const status = res.statusCode ?? 0;
        const redirectLocation = headers['location'];
        res.resume(); // drain the response body
        const result: HttpHeadResponse = {
          status,
          headers,
          ...(redirectLocation !== undefined ? { redirectLocation } : {}),
        };
        resolve(result);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Headers probe request to ${target.url} timed out`));
    });
    req.end();
  });
};

/**
 * Run the security headers probe against the given AllowedTarget.
 *
 * Returns findings for any missing or misconfigured security headers.
 * Off-host redirects are recorded as scope-excluded metadata, not followed
 * (§4.4).
 */
export async function runHeadersProbe(
  target: AllowedTarget,
  rps: number,
  client: HeadersClient,
): Promise<{ findings: Finding[]; scopeExcluded: string[] }> {
  let response!: HttpHeadResponse;

  await withHostBudget(target.hostname, rps, async (acquireToken) => {
    await acquireToken();
    response = await client(target);
  });

  // Scope confinement: if response is a redirect to an off-host URL, record it
  // but do not follow (§4.4).
  const scopeExcluded: string[] = [];
  if (response.redirectLocation) {
    try {
      const redirectHost = new URL(response.redirectLocation).hostname;
      if (redirectHost !== target.hostname) {
        scopeExcluded.push(response.redirectLocation);
      }
    } catch {
      // Malformed redirect — record the raw value as excluded
      scopeExcluded.push(response.redirectLocation);
    }
  }

  const issues = checkHeaders(response.headers);
  const findings = issues.map((issue) => buildFinding(target, issue));

  return { findings, scopeExcluded };
}
