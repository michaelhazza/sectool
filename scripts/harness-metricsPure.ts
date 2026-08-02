/**
 * harness-metricsPure.ts
 *
 * Pure (I/O-free) core for the review-harness metrics aggregator. Parsing the
 * coordinator-decisions jsonl, slug extraction, timestamp normalization, and the
 * per-slug + rolling-30-day metric computation live here so they are deterministic
 * and unit-testable without touching the filesystem. The I/O module
 * (`harness-metrics.ts`) owns directory scans, file reads, and report writes.
 *
 * Metric definitions are pinned in references/harness-metrics.md (F12). The
 * METRIC_KEYS array below is the single source of the emit contract: F11 emits
 * exactly these keys, in this order, for every build and for the window summary.
 * A metric whose formula the current log shape cannot support is emitted with
 * status "not-derivable" and a reason — never a faked value.
 */

// ── metric contract ────────────────────────────────────────────────────────────

export type MetricStatus = 'ok' | 'no-data' | 'not-derivable';

export interface MetricDef {
  key: string;
  /** false → always emitted not-derivable against the current log shape. */
  derivable: boolean;
  /** required when derivable === false. */
  notDerivableReason?: string;
}

/**
 * The emit contract. Order is stable and matches references/harness-metrics.md's
 * summary table. Adding a field to future logs promotes a metric from
 * not-derivable to derivable by flipping `derivable` — the key never changes.
 */
export const METRIC_DEFS: MetricDef[] = [
  { key: 'findings-per-reviewer-per-build', derivable: true },
  { key: 'fp-proxy-rejected-per-reviewer-per-build', derivable: true },
  { key: 'fix-loop-iterations-per-build', derivable: true },
  { key: 'rounds-per-build', derivable: true },
  { key: 'quarantine-rate', derivable: true },
  { key: 'auto-apply-success-rate', derivable: true },
  {
    key: 'operator-override-rate',
    derivable: false,
    notDerivableReason: 'no record represents an operator overriding a coordinator-applied finding',
  },
  {
    key: 'schema-validation-rate',
    derivable: false,
    notDerivableReason: 'no per-output schema-validation field in current logs',
  },
  {
    key: 'openai-repair-retry-rate',
    derivable: false,
    notDerivableReason: 'no repair_retry_attempted field in current logs',
  },
  {
    key: 'cumulative-revert-rate',
    derivable: false,
    notDerivableReason: 'no revert / batch-outcome field in current logs',
  },
  {
    key: 'claude-first-pass-latency',
    derivable: false,
    notDerivableReason: 'no latency / duration field in current logs',
  },
  {
    key: 'claude-first-pass-token-cost',
    derivable: false,
    notDerivableReason: 'no token-count field in current logs',
  },
  {
    key: 'openai-review-cost',
    derivable: false,
    notDerivableReason: 'no cost field in current logs',
  },
  {
    key: 'suppression-false-negative-rate',
    derivable: false,
    notDerivableReason: 'no suppression field; metric is inherently longitudinal',
  },
  {
    key: 'disagreement-rate',
    derivable: false,
    notDerivableReason: 'no disagreements[] field in current logs',
  },
];

export const METRIC_KEYS: string[] = METRIC_DEFS.map((d) => d.key);

// ── parsed record shapes ─────────────────────────────────────────────────────

export interface DecisionRecord {
  reviewer: string | null;
  decision: string | null;
  round: number | null;
  /** 'passed' | 'failed' | 'deferred' per applyFindings.ts; null when absent (legacy rows). */
  acceptanceCheckOutcome: string | null;
  tsRaw: string | null;
  tsMs: number | null;
}

export interface ParsedFile {
  slug: string;
  fileName: string;
  fileTsMs: number | null;
  records: DecisionRecord[];
  malformedCount: number;
  /** first few malformed lines for the report (capped). */
  malformedSamples: string[];
}

export interface MetricValue {
  value: number | Record<string, number> | null;
  status: MetricStatus;
  note: string;
}

export interface BuildMetrics {
  slug: string;
  fileCount: number;
  recordCount: number;
  metrics: Record<string, MetricValue>;
}

export interface CorpusHeader {
  fileCount: number;
  recordCount: number;
  malformedSkipped: number;
  earliestTs: string | null;
  latestTs: string | null;
  slugs: string[];
}

export interface Window30dSummary {
  anchorTs: string | null;
  fromTs: string | null;
  recordCount: number;
  undatedExcluded: number;
  metrics: Record<string, MetricValue>;
}

export interface MetricsReport {
  header: CorpusHeader;
  builds: BuildMetrics[];
  window30d: Window30dSummary;
}

// ── slug + timestamp helpers ────────────────────────────────────────────────

/**
 * Trailing `-<timestamp>` matcher. Anchored to end-of-name and gated on a real
 * `YYYY-MM-DD` date prefix so a kebab slug can never be eaten. The optional time
 * branch requires the `T\d\d` structure, then tolerates every writer form:
 *   `2026-07-10T13-59-41`   auditLog.ts buildAuditLogPath (hyphenated time, NO Z)
 *   `2026-07-08T015917Z`    compact HHMMSS (real files on disk)
 *   `2026-07-08T01:59:17Z`  colon time
 *   `2026-07-08T14-35-17Z`  dashed time with Z
 *   `2026-07-08`            date-only (time branch absent)
 */
const TS_TAIL = /-(\d{4}-\d{2}-\d{2}(?:T\d{2}[:-]?\d{2}[:-]?\d{2}(?:\.\d+)?Z?)?)$/;

/**
 * Extract the build slug from a coordinator-decisions filename. Strips the
 * `coordinator-decisions-` prefix and `.jsonl` suffix, then strips a trailing
 * `-<timestamp>` when present. Files without a recognizable timestamp keep the
 * full remainder as the slug.
 */
export function extractSlug(fileName: string): string {
  const base = fileName.replace(/\.jsonl$/i, '');
  const body = base.replace(/^coordinator-decisions-/, '');
  const stripped = body.replace(TS_TAIL, '');
  return stripped.length > 0 ? stripped : body;
}

/** Pull the trailing timestamp string out of a filename, or null. */
export function extractFileTs(fileName: string): string | null {
  const base = fileName.replace(/\.jsonl$/i, '');
  const m = base.match(TS_TAIL);
  return m ? m[1] : null;
}

/**
 * Normalize the several observed timestamp shapes to epoch ms, or null.
 * Handles: date-only (2026-07-08), compact time (2026-07-08T015917Z),
 * colon time (2026-07-08T01:59:17Z), dash time (2026-07-08T14-35-17Z), and the
 * auditLog.ts writer form with no trailing Z (2026-07-10T13-59-41).
 * A parsed time without a trailing Z is treated as UTC — the reconstructed ISO
 * string below always appends Z, so all writer forms map to the same instant.
 */
export function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;

  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const t = Date.parse(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`);
    return Number.isNaN(t) ? null : t;
  }

  const dateTime = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-]?(\d{2})[:-]?(\d{2})(?:\.\d+)?Z?$/,
  );
  if (dateTime) {
    const iso = `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }

  const fallback = Date.parse(s);
  return Number.isNaN(fallback) ? null : fallback;
}

export function tsToIso(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toISOString();
}

// ── line parsing ──────────────────────────────────────────────────────────────

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * Parse one coordinator-decisions jsonl blob into a ParsedFile. Malformed lines
 * (invalid JSON or non-object) are skipped and counted, never fail the parse.
 */
export function parseDecisionsFile(fileName: string, content: string): ParsedFile {
  const slug = extractSlug(fileName);
  const fileTs = extractFileTs(fileName);
  const records: DecisionRecord[] = [];
  let malformedCount = 0;
  const malformedSamples: string[] = [];

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      malformedCount++;
      if (malformedSamples.length < 5) malformedSamples.push(`${fileName}:${i + 1}`);
      continue;
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      malformedCount++;
      if (malformedSamples.length < 5) malformedSamples.push(`${fileName}:${i + 1} (not an object)`);
      continue;
    }
    const o = obj as Record<string, unknown>;
    const tsRaw = firstString(o, ['ts', 'timestamp']);
    records.push({
      reviewer: firstString(o, ['reviewer']),
      decision: firstString(o, ['decision']),
      round: firstNumber(o, ['round', 'iteration']),
      acceptanceCheckOutcome: firstString(o, ['acceptance_check_outcome']),
      tsRaw,
      tsMs: normalizeTimestamp(tsRaw),
    });
  }

  return {
    slug,
    fileName,
    fileTsMs: normalizeTimestamp(fileTs),
    records,
    malformedCount,
    malformedSamples,
  };
}

// ── decision classification ────────────────────────────────────────────────

function norm(d: string | null): string {
  return (d ?? '').trim().toLowerCase();
}

export function isRejected(d: string | null): boolean {
  return norm(d) === 'rejected';
}

export function isQuarantined(d: string | null): boolean {
  return norm(d) === 'quarantined';
}

// ── metric computation ─────────────────────────────────────────────────────

function derivableMetricsFor(records: DecisionRecord[]): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};

  // findings-per-reviewer-per-build
  const perReviewer: Record<string, number> = {};
  for (const r of records) {
    const key = r.reviewer ?? '(unknown)';
    perReviewer[key] = (perReviewer[key] ?? 0) + 1;
  }
  out['findings-per-reviewer-per-build'] =
    records.length === 0
      ? { value: null, status: 'no-data', note: 'no decision records' }
      : { value: perReviewer, status: 'ok', note: 'count of decision records per reviewer' };

  // fp-proxy-rejected-per-reviewer-per-build
  const perReviewerRejected: Record<string, number> = {};
  for (const r of records) {
    if (!isRejected(r.decision)) continue;
    const key = r.reviewer ?? '(unknown)';
    perReviewerRejected[key] = (perReviewerRejected[key] ?? 0) + 1;
  }
  out['fp-proxy-rejected-per-reviewer-per-build'] =
    records.length === 0
      ? { value: null, status: 'no-data', note: 'no decision records' }
      : { value: perReviewerRejected, status: 'ok', note: 'rejected findings (false-positive proxy) per reviewer' };

  // fix-loop-iterations-per-build = max round/iteration
  const rounds = records.map((r) => r.round).filter((n): n is number => n !== null);
  out['fix-loop-iterations-per-build'] =
    rounds.length === 0
      ? { value: null, status: 'no-data', note: 'no round/iteration field on any record' }
      : { value: Math.max(...rounds), status: 'ok', note: 'deepest fix-loop iteration reached' };

  // rounds-per-build = distinct round values
  const distinct = new Set(rounds);
  out['rounds-per-build'] =
    rounds.length === 0
      ? { value: null, status: 'no-data', note: 'no round/iteration field on any record' }
      : { value: distinct.size, status: 'ok', note: 'distinct review rounds' };

  // quarantine-rate = quarantined / total
  if (records.length === 0) {
    out['quarantine-rate'] = { value: null, status: 'no-data', note: 'no decision records' };
  } else {
    const q = records.filter((r) => isQuarantined(r.decision)).length;
    out['quarantine-rate'] = {
      value: q / records.length,
      status: 'ok',
      note: `${q} quarantined of ${records.length} decisions`,
    };
  }

  // auto-apply-success-rate = passed / (passed + failed).
  // 'deferred' outcomes (never attempted) and rows missing the field (legacy
  // hand-written logs) are excluded from BOTH numerator and denominator. When
  // no attempts exist, the metric is still live — emit null with a no-attempts
  // note, never 'not-derivable'.
  const passed = records.filter((r) => r.acceptanceCheckOutcome === 'passed').length;
  const failed = records.filter((r) => r.acceptanceCheckOutcome === 'failed').length;
  const attempts = passed + failed;
  out['auto-apply-success-rate'] =
    attempts === 0
      ? { value: null, status: 'no-data', note: 'no auto-apply attempts in corpus' }
      : {
          value: passed / attempts,
          status: 'ok',
          note: `${passed} passed of ${attempts} auto-apply attempts (denominator = passed + failed; deferred and rows missing acceptance_check_outcome excluded)`,
        };

  return out;
}

function notDerivableMetrics(): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const def of METRIC_DEFS) {
    if (def.derivable) continue;
    out[def.key] = {
      value: null,
      status: 'not-derivable',
      note: def.notDerivableReason ?? 'not derivable from current logs',
    };
  }
  return out;
}

/** Full metric set (derivable + not-derivable) for a record set. Emits every key. */
export function computeMetrics(records: DecisionRecord[]): Record<string, MetricValue> {
  return { ...derivableMetricsFor(records), ...notDerivableMetrics() };
}

// ── aggregation ────────────────────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Aggregate parsed files into the full report: corpus header, per-slug build
 * metrics, and a rolling 30-day window summary anchored to the latest source
 * timestamp in the corpus (deterministic — not wall-clock).
 */
export function aggregate(files: ParsedFile[]): MetricsReport {
  const allRecords: DecisionRecord[] = [];
  const tsValues: number[] = [];
  let malformedSkipped = 0;

  // group files by slug
  const bySlug = new Map<string, ParsedFile[]>();
  for (const f of files) {
    malformedSkipped += f.malformedCount;
    if (f.fileTsMs !== null) tsValues.push(f.fileTsMs);
    for (const r of f.records) {
      allRecords.push(r);
      if (r.tsMs !== null) tsValues.push(r.tsMs);
    }
    const arr = bySlug.get(f.slug) ?? [];
    arr.push(f);
    bySlug.set(f.slug, arr);
  }

  const earliest = tsValues.length ? Math.min(...tsValues) : null;
  const latest = tsValues.length ? Math.max(...tsValues) : null;

  const slugs = [...bySlug.keys()].sort();
  const builds: BuildMetrics[] = slugs.map((slug) => {
    const slugFiles = bySlug.get(slug)!;
    const records = slugFiles.flatMap((f) => f.records);
    return {
      slug,
      fileCount: slugFiles.length,
      recordCount: records.length,
      metrics: computeMetrics(records),
    };
  });

  // rolling 30-day window anchored to the latest source timestamp
  const anchor = latest;
  const from = anchor === null ? null : anchor - THIRTY_DAYS_MS;
  let undatedExcluded = 0;
  const windowRecords = allRecords.filter((r) => {
    if (r.tsMs === null) {
      undatedExcluded++;
      return false;
    }
    if (from === null) return true;
    return r.tsMs >= from;
  });

  return {
    header: {
      fileCount: files.length,
      recordCount: allRecords.length,
      malformedSkipped,
      earliestTs: tsToIso(earliest),
      latestTs: tsToIso(latest),
      slugs,
    },
    builds,
    window30d: {
      anchorTs: tsToIso(anchor),
      fromTs: tsToIso(from),
      recordCount: windowRecords.length,
      undatedExcluded,
      metrics: computeMetrics(windowRecords),
    },
  };
}
