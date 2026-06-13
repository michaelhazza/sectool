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
  return fetchJson<TrendPoint[]>('/api/history/trend');
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
