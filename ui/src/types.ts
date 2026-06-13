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

export interface Finding {
  fingerprint: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  target: {
    kind: Surface;
    name: string;
  };
  vulnClass: string;
  title?: string | undefined;
  description?: string | undefined;
  location?: {
    file?: string | undefined;
    line?: number | undefined;
    symbol?: string | undefined;
  } | undefined;
  evidence?: {
    snippet?: string | undefined;
  } | undefined;
  suppressed?: boolean | undefined;
  suppression?: {
    justification?: string | undefined;
    approvedBy?: string | undefined;
    expiry?: string | undefined;
  } | undefined;
  correlatedWith?: string[] | undefined;
  externalRefs?: Array<{ url: string; status: FixStatus }> | undefined;
  reachability?: 'authenticated' | 'unauthenticated' | 'admin' | 'unknown' | undefined;
  firstSeen?: string | undefined;
  note?: string | undefined;
}

export interface RunMeta {
  runId: string;
  startedAt: string;
  completedAt?: string | undefined;
  status: RunStatus;
  toolVersion: string;
  failures?: string[] | undefined;
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
  startedAt: string;
  status: RunStatus;
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
