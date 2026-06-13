import * as https from 'node:https';
import * as http from 'node:http';
import type { AllowedTarget } from '../gate.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// Cookie flags probe — LIVE-COOKIE-001 (§7.3 passive family)
//
// Inspects Set-Cookie response headers for missing security flags:
// HttpOnly, Secure, SameSite.
//
// Injectable `CookiesClient` so unit tests never hit the network.
// Response Set-Cookie values are redacted via the redaction chokepoint (§5.4)
// before appearing in any Finding field.
// ---------------------------------------------------------------------------

export interface CookieResponse {
  status: number;
  /** Raw Set-Cookie header values (one per cookie). May carry credential material. */
  setCookieHeaders: string[];
}

export type CookiesClient = (target: AllowedTarget) => Promise<CookieResponse>;

interface ParsedCookie {
  name: string;
  rawValue: string;
  hasHttpOnly: boolean;
  hasSecure: boolean;
  sameSite: string | null;
}

function parseCookieLine(line: string): ParsedCookie {
  const parts = line.split(';').map((p) => p.trim());
  // First part is name=value
  const nameValuePart = parts[0] ?? '';
  const eqIdx = nameValuePart.indexOf('=');
  const name = eqIdx === -1 ? nameValuePart : nameValuePart.slice(0, eqIdx);
  const rawValue = eqIdx === -1 ? '' : nameValuePart.slice(eqIdx + 1);

  const flags = parts.slice(1).map((p) => p.toLowerCase());
  const hasHttpOnly = flags.some((f) => f === 'httponly');
  const hasSecure = flags.some((f) => f === 'secure');
  const sameSiteFlag = flags.find((f) => f.startsWith('samesite'));
  let sameSite: string | null = null;
  if (sameSiteFlag !== undefined) {
    const eqI = sameSiteFlag.indexOf('=');
    sameSite = eqI === -1 ? 'present' : sameSiteFlag.slice(eqI + 1).trim();
  }

  return { name, rawValue, hasHttpOnly, hasSecure, sameSite };
}

interface CookieIssue {
  issueKind: string;
  cookieName: string;
  detail: string;
  rawCookie: string;
}

function checkCookie(cookie: ParsedCookie, rawLine: string): CookieIssue[] {
  const issues: CookieIssue[] = [];

  if (!cookie.hasHttpOnly) {
    issues.push({
      issueKind: 'missing-httponly',
      cookieName: cookie.name,
      detail: `Cookie "${cookie.name}" is missing the HttpOnly flag, making it accessible to JavaScript.`,
      rawCookie: rawLine,
    });
  }

  if (!cookie.hasSecure) {
    issues.push({
      issueKind: 'missing-secure',
      cookieName: cookie.name,
      detail: `Cookie "${cookie.name}" is missing the Secure flag, allowing transmission over non-TLS connections.`,
      rawCookie: rawLine,
    });
  }

  if (cookie.sameSite === null) {
    issues.push({
      issueKind: 'missing-samesite',
      cookieName: cookie.name,
      detail: `Cookie "${cookie.name}" is missing the SameSite flag (recommend SameSite=Strict or SameSite=Lax).`,
      rawCookie: rawLine,
    });
  } else if (cookie.sameSite === 'none') {
    issues.push({
      issueKind: 'weak-samesite-none',
      cookieName: cookie.name,
      detail: `Cookie "${cookie.name}" has SameSite=None, which permits cross-site sending. Prefer Strict or Lax.`,
      rawCookie: rawLine,
    });
  }

  return issues;
}

function buildFinding(
  target: AllowedTarget,
  issue: CookieIssue,
): Finding {
  const urlPath = new URL(target.url).pathname || '/';
  const normalizedPath = normalizeUrlPath(urlPath);
  const fp = fingerprint({
    kind: 'live',
    checkId: 'LIVE-COOKIE-001',
    host: target.hostname,
    urlPath: normalizedPath,
    parameter: issue.cookieName,
    evidenceClass: issue.issueKind,
  });
  const id = displayId(fp);
  const now = new Date().toISOString();

  // Redact the raw cookie line before putting it in evidence (§5.4)
  const redactedRaw = redact({ 'set-cookie': issue.rawCookie }) as Record<string, unknown>;

  return {
    id,
    fingerprint: fp,
    ruleId: 'LIVE-COOKIE-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'session-management',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    target: { kind: 'staging', host: target.hostname },
    location: { url: target.url, parameter: issue.cookieName, method: 'GET' },
    evidence: {
      snippet: issue.detail,
      cvss: null,
      raw: redactedRaw,
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
 * Real HTTP/HTTPS client for the cookies probe.
 * Makes a GET request to the target URL and returns all Set-Cookie headers.
 * Does not follow redirects — only the direct response cookies are inspected.
 */
export const defaultCookiesClient: CookiesClient = (target: AllowedTarget): Promise<CookieResponse> => {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.startsWith('https://');
    const client = isHttps ? https : http;
    const req = client.request(
      target.url,
      { method: 'GET', headers: { 'User-Agent': 'audit-tool/1.0.0' }, rejectUnauthorized: false },
      (res) => {
        const status = res.statusCode ?? 0;
        // Node's http module returns set-cookie as string[] (already split)
        const raw = res.headers['set-cookie'] ?? [];
        const setCookieHeaders = Array.isArray(raw) ? raw : [raw];
        res.resume(); // drain the response body
        resolve({ status, setCookieHeaders });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Cookies probe request to ${target.url} timed out`));
    });
    req.end();
  });
};

/**
 * Run the cookie flags probe against the given AllowedTarget.
 *
 * Returns findings for cookies missing HttpOnly, Secure, or SameSite flags.
 * Set-Cookie values are redacted in the emitted findings (§5.4).
 */
export async function runCookiesProbe(
  target: AllowedTarget,
  rps: number,
  client: CookiesClient,
): Promise<Finding[]> {
  let response!: CookieResponse;

  await withHostBudget(target.hostname, rps, async (acquireToken) => {
    await acquireToken();
    response = await client(target);
  });

  const findings: Finding[] = [];

  for (const rawLine of response.setCookieHeaders) {
    const cookie = parseCookieLine(rawLine);
    const issues = checkCookie(cookie, rawLine);
    for (const issue of issues) {
      findings.push(buildFinding(target, issue));
    }
  }

  return findings;
}
