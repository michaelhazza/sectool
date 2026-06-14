// TypeScript types for the P7-1 read-only JSON endpoints.
// These mirror the Zod schemas in src/schemas/ but are defined independently
// for the SPA (no direct import of src/ — UI is a separate TS project).

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RunStatus = 'success' | 'partial' | 'failed';
export type Surface = 'static' | 'live';
export type Confidence = 'confirmed' | 'probable' | 'possible';

export type ScannerState = 'complete' | 'failed' | 'skipped' | 'running';

export interface ScannerStatusEntry {
  target: string;
  family: string;
  state: ScannerState;
  errorMessage?: string | undefined;
}

/**
 * The real runtime target shape differs by scan surface:
 *   static → { kind: 'repo',    name, commit? }   (has `name`, no `host`)
 *   live   → { kind: 'staging', host }            (has `host`, no `name`)
 * Both `name` and `host` are typed optional here so consumers MUST go through
 * targetLabel() / findingSurface() rather than dereferencing one unconditionally.
 * The legacy 'static' | 'live' kind values are kept for backward compatibility.
 */
export interface FindingTarget {
  kind: 'repo' | 'staging' | 'static' | 'live';
  name?: string | undefined;
  host?: string | undefined;
  commit?: string | undefined;
}

export interface Finding {
  fingerprint: string;
  // `id` and `ruleId` both appear on live-scan findings; id is optional.
  id?: string | undefined;
  ruleId: string;
  severity: Severity;
  // baseSeverity appears on live findings before reachability modifiers.
  baseSeverity?: Severity | undefined;
  confidence: Confidence;
  // Authoritative surface marker on real findings ('static' | 'live').
  surface?: Surface | undefined;
  // Static findings emit source 'rule'; live findings 'probe'. Pragmatic open union.
  source?: string | undefined;
  target: FindingTarget;
  vulnClass: string;
  title?: string | undefined;
  description?: string | undefined;
  remediation?: string | undefined;
  // Static findings carry file/line/symbol; live findings carry url/method.
  location?: {
    file?: string | undefined;
    line?: number | undefined;
    symbol?: string | undefined;
    url?: string | undefined;
    method?: string | undefined;
  } | undefined;
  evidence?: {
    snippet?: string | undefined;
    // cvss can be null on live findings (no score computed).
    cvss?: number | null | undefined;
    raw?: unknown;
  } | undefined;
  reachability?: 'authenticated' | 'unauthenticated' | 'admin' | 'unknown' | undefined;
  correlatedWith?: string[] | undefined;
  externalRefs?: Array<{ url: string; status: FixStatus }> | undefined;
  firstSeen?: string | undefined;
  // suppressed flag plus the (nullable) detail object and free-text note.
  suppressed?: boolean | undefined;
  suppression?: {
    justification?: string | undefined;
    approvedBy?: string | undefined;
    expiry?: string | undefined;
  } | null | undefined;
  note?: string | null | undefined;
}

/** A single scanner-family failure, as emitted in report.meta.failures. */
export interface RunFailure {
  target?: string | undefined;
  family?: string | undefined;
  reason?: string | undefined;
}

export interface RunMeta {
  runId: string;
  startedAt: string;
  completedAt?: string | undefined;
  status: RunStatus;
  toolVersion: string;
  failures?: RunFailure[] | undefined;
  scannerStatus?: ScannerStatusEntry[] | undefined;
}

export interface RunReport {
  meta: RunMeta;
  findings: Finding[];
  targets?: Array<{
    name: string;
    kind: Surface;
    url?: string | undefined;
    repo?: string | undefined;
    activeScan?: boolean | undefined;
  }> | undefined;
}

export type FixStatus =
  | 'requested'
  | 'in-progress'
  | 'awaiting-review'
  | 'merged-awaiting-verification'
  | 'verified-fixed'
  | 'reopened';

export interface FixEntry {
  fingerprint: string;
  ruleId?: string | undefined;
  title?: string | undefined;
  status: FixStatus;
  issueUrl?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface FixesJson {
  entries: FixEntry[];
}

export interface TrendPoint {
  runId: string;
  timestamp: string;
  status: RunStatus | 'unknown';
  totals: {
    critical?: number | undefined;
    high?: number | undefined;
    medium?: number | undefined;
    low?: number | undefined;
    new?: number | undefined;
    fixed?: number | undefined;
    persisting?: number | undefined;
  };
  targets?: Array<{
    name: string;
    status: RunStatus | 'unknown';
    critical?: number | undefined;
    high?: number | undefined;
    medium?: number | undefined;
    low?: number | undefined;
  }> | undefined;
}

export interface ReportListEntry {
  runId: string;
  // /api/reports returns run-id strings only; these come from the full report
  // when needed, so they're optional on the list entry.
  startedAt?: string;
  status?: RunStatus;
}

export interface TargetRegistryEntry {
  name: string;
  kind: 'repo' | 'staging';
  enabled: boolean;
  url?: string | undefined;
  repo?: string | undefined;
  activeScan?: boolean | undefined;
  host?: string | undefined;
}

export interface TargetsConfig {
  repoTargets: TargetRegistryEntry[];
  stagingTargets: TargetRegistryEntry[];
}

export interface AllowlistEntry {
  host: string;
  owner?: string | undefined;
  addedAt?: string | undefined;
  note?: string | undefined;
}

export interface AllowlistConfig {
  hosts: AllowlistEntry[];
}

export interface BaselineEntry {
  fingerprint: string;
  ruleId: string;
  target: string;
  justification?: string | undefined;
  approvedBy?: string | undefined;
  expiry?: string | undefined;
  addedAt?: string | undefined;
}

export interface BaselineConfig {
  entries: BaselineEntry[];
}

// Scan job state — Contract C3 from the plan (folded from scan-jobs.jsonl)
export type ScanJobState = 'pre_dispatch' | 'in_progress' | 'complete' | 'failed' | 'timed_out';

export interface ScanJob {
  jobId: string;
  targetRepo: string;
  stagingUrl: string;
  state: ScanJobState;
  requestedAt: string;
  runId: string | null;
}

// Trigger provenance — matches the trigger field on scan-jobs events and upload envelopes
export type TriggerKind = 'on-demand' | 'scheduled' | 'replay';

// Config edit history entry (from GET /api/config/history)
export interface ConfigHistoryEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
  commitSha: string;
  integrityOk?: boolean | undefined;
}

// Config write dependency health (from GET /api/config/health)
export interface ConfigWriteDeps {
  ok: boolean;
  missing: string[];
}

// Response shape from GET /api/config/health
export interface ConfigHealthResponse {
  editingEnabled: boolean;
  configWriteDeps: ConfigWriteDeps;
}
