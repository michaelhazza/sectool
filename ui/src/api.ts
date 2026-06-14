// Read-only fetch helpers for the P7-1 JSON endpoints.
// All calls are to the same origin (127.0.0.1) — no CORS concerns.

import type {
  RunReport,
  ReportListEntry,
  TrendPoint,
  FixesJson,
  TargetsConfig,
  AllowlistConfig,
  BaselineConfig,
  ScanJob,
} from './types.js';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchReportList(): Promise<ReportListEntry[]> {
  return fetchJson<ReportListEntry[]>('/api/reports');
}

export async function fetchReport(runId: string): Promise<RunReport> {
  return fetchJson<RunReport>(`/api/reports/${encodeURIComponent(runId)}/report.json`);
}

export async function fetchTrend(): Promise<TrendPoint[]> {
  // Server route is /api/trend (see src/ui/server.ts handleApi + its test).
  return fetchJson<TrendPoint[]>('/api/trend');
}

export async function fetchFixes(): Promise<FixesJson> {
  return fetchJson<FixesJson>('/api/fixes');
}

export async function fetchTargetsConfig(): Promise<TargetsConfig> {
  return fetchJson<TargetsConfig>('/api/config/targets');
}

export async function fetchAllowlistConfig(): Promise<AllowlistConfig> {
  return fetchJson<AllowlistConfig>('/api/config/allowlist');
}

export async function fetchBaselineConfig(): Promise<BaselineConfig> {
  return fetchJson<BaselineConfig>('/api/config/baseline');
}

// Copy text to clipboard (local only — no network)
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Fetch the per-process CSRF nonce from the server.
 * The nonce is used to protect the mutating POST /api/fix endpoint (§5.2).
 */
export async function fetchCsrfToken(): Promise<string> {
  const data = await fetchJson<{ csrfToken: string }>('/api/csrf');
  return data.csrfToken;
}

/**
 * Send a finding for fixing — files a fix-request GitHub issue via the
 * CSRF/origin-gated POST /api/fix endpoint (§5.2).
 *
 * Fetches the CSRF nonce first, then POSTs with the nonce + same-origin
 * headers. Returns the issue URL on success.
 */
export async function sendForFixing(fingerprint: string): Promise<{ issueUrl: string }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch('/api/fix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Audit-CSRF': csrfToken,
    },
    body: JSON.stringify({ fingerprint }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ issueUrl: string }>;
}

/**
 * Trigger an on-demand scan via the CSRF/origin-gated POST /api/scan endpoint.
 * Mirrors the sendForFixing CSRF pattern: fetches the nonce first, then POSTs.
 * Returns the correlation jobId on 202 Accepted.
 */
export async function triggerScan(repo: string, stagingUrl: string): Promise<{ jobId: string }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Audit-CSRF': csrfToken,
    },
    body: JSON.stringify({ repo, stagingUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ jobId: string }>;
}

/**
 * Fetch the current list of scan jobs (folded from the append-only event log).
 * Returns most-recent-first, matching Contract C3.
 */
export async function fetchScanJobs(): Promise<ScanJob[]> {
  return fetchJson<ScanJob[]>('/api/scan-jobs');
}
