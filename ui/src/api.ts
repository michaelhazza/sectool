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
  ConfigHistoryEntry,
  ConfigHealthResponse,
} from './types.js';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchReportList(): Promise<ReportListEntry[]> {
  // The server returns run-id strings, sorted ascending (oldest first). The UI
  // screens take list[0] as the LATEST run, so map to entries and reverse so the
  // newest run is first.
  const ids = await fetchJson<string[]>('/api/reports');
  return ids.map((runId) => ({ runId })).reverse();
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

/**
 * Fetch config write dependency health from GET /api/config/health.
 * Returns whether editing is enabled and the list of missing secrets.
 */
export async function fetchConfigHealth(): Promise<ConfigHealthResponse> {
  return fetchJson<ConfigHealthResponse>('/api/config/health');
}

/**
 * Exchange a TOTP code for a step-up session cookie.
 * On success, the server sets the step-up cookie (credentials:'same-origin').
 * Returns 200 on success; throws on wrong/expired code (403) or other errors.
 */
export async function stepUp(code: string): Promise<void> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch('/api/config/step-up', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Audit-CSRF': csrfToken,
    },
    credentials: 'same-origin',
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
}

/**
 * Generic config-write helper — mirrors sendForFixing's CSRF pattern.
 * Returns the parsed JSON response, or throws with a plain-language message.
 * A 403 is re-thrown as-is so callers can detect and open the step-up modal.
 */
async function configWrite<T>(method: string, path: string, body?: unknown): Promise<T> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Audit-CSRF': csrfToken,
    },
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string; issues?: unknown };
    const msg = err.error ?? `HTTP ${res.status}`;
    const e = new Error(msg) as Error & { status: number; issues?: unknown };
    e.status = res.status;
    e.issues = err.issues;
    throw e;
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Repo mutations
// ---------------------------------------------------------------------------

export async function addRepo(entry: Record<string, unknown>): Promise<unknown> {
  return configWrite('POST', '/api/config/repos', entry);
}

export async function editRepo(name: string, patch: Record<string, unknown>): Promise<unknown> {
  return configWrite('PUT', `/api/config/repos/${encodeURIComponent(name)}`, patch);
}

export async function removeRepo(name: string): Promise<unknown> {
  return configWrite('DELETE', `/api/config/repos/${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// Staging target mutations
// ---------------------------------------------------------------------------

export async function addStagingTarget(
  entry: Record<string, unknown>,
  opts?: { addHost?: boolean },
): Promise<unknown> {
  const payload = opts?.addHost === true ? { ...entry, addHost: true } : entry;
  return configWrite('POST', '/api/config/staging-targets', payload);
}

export async function editStagingTarget(name: string, patch: Record<string, unknown>): Promise<unknown> {
  return configWrite('PUT', `/api/config/staging-targets/${encodeURIComponent(name)}`, patch);
}

export async function removeStagingTarget(name: string): Promise<unknown> {
  return configWrite('DELETE', `/api/config/staging-targets/${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// Allowlist host mutations
// ---------------------------------------------------------------------------

export async function addHost(entry: Record<string, unknown>): Promise<unknown> {
  return configWrite('POST', '/api/config/allowlist', entry);
}

export async function removeHost(host: string): Promise<unknown> {
  return configWrite('DELETE', `/api/config/allowlist/${encodeURIComponent(host)}`);
}

// ---------------------------------------------------------------------------
// History + revert
// ---------------------------------------------------------------------------

/** Raw server shape of GET /api/config/history (commit-centric; auditEntry may be absent). */
interface RawHistoryEntry {
  sha: string;
  message: string;
  authorDate: string;
  auditEntry?: { at: string; actor: string; action: string; target: string; commitSha: string } | undefined;
}

export async function fetchConfigHistory(n = 20): Promise<{ entries: ConfigHistoryEntry[]; integrityOk: boolean }> {
  const raw = await fetchJson<{ entries: RawHistoryEntry[]; auditIntegrityOk: boolean }>(`/api/config/history?n=${n}`);
  // Map the server's commit-centric shape to the flat ConfigHistoryEntry the UI
  // renders. The audit cache may not have an entry for every commit (e.g. the
  // seed commit), so fall back to the commit message/date when auditEntry is absent.
  const entries: ConfigHistoryEntry[] = (raw.entries ?? []).map((e) => {
    const a = e.auditEntry;
    // Derive a readable action/target from the commit subject when no audit entry:
    // "config(dashboard): add host x" → action "add host", target "x".
    const subject = e.message.replace(/^config\(dashboard\):\s*/, '');
    return {
      commitSha: e.sha,
      at: a?.at ?? e.authorDate,
      actor: a?.actor ?? '—',
      action: a?.action ?? subject,
      target: a?.target ?? '',
    };
  });
  return { entries, integrityOk: raw.auditIntegrityOk !== false };
}

export async function revertConfig(commitSha: string): Promise<unknown> {
  return configWrite('POST', `/api/config/revert/${encodeURIComponent(commitSha)}`);
}
