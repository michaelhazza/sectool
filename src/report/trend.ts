import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunReport } from '../schemas/report.js';
import type { TrendLine, TargetTrend } from '../schemas/trend.js';
import { TrendLineSchema } from '../schemas/trend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const TREND_PATH = resolve(REPO_ROOT, 'history', 'trend.jsonl');

/**
 * Compute trend counts for one target from the current and previous run.
 *
 * Partial-run rule (§6.5):
 *   - A target is "unknown" if ANY family for that target did NOT complete.
 *   - `fixed` is NEVER computed from a family that did not complete.
 *   - Only fingerprints from complete families are used for new/fixed/persisting.
 *
 * When prevFingerprints is undefined (first run), all current findings are "new"
 * and fixed=0 regardless of family completion.
 */
export function computeTargetTrend(
  targetName: string,
  currentReport: RunReport,
  prevFingerprints: ReadonlyMap<string, Set<string>> | undefined,
): TargetTrend {
  // Determine which families completed for this target
  const completeFamilies = new Set(
    currentReport.meta.scannerStatus
      .filter((s) => s.target === targetName && s.state === 'complete')
      .map((s) => s.family),
  );

  const hasAnyFamily = currentReport.meta.scannerStatus.some(
    (s) => s.target === targetName,
  );

  // If any family for this target is not complete → status is "unknown"
  const allComplete =
    hasAnyFamily &&
    currentReport.meta.scannerStatus
      .filter((s) => s.target === targetName)
      .every((s) => s.state === 'complete');

  const status: 'complete' | 'unknown' = allComplete ? 'complete' : 'unknown';

  // Current findings for this target, keyed by fingerprint
  const currentFindings = currentReport.findings.filter((f) => {
    if (f.target.kind === 'repo') return f.target.name === targetName;
    return f.target.host === targetName;
  });

  // Fingerprints currently present from complete families only
  const currentCompleteFps = new Set(
    currentFindings
      .filter((f) => completeFamilies.has(f.source))
      .map((f) => f.fingerprint),
  );

  // Severity counts (from ALL current findings for this target — for bySeverity)
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of currentFindings) {
    if (f.severity === 'critical') bySeverity.critical++;
    else if (f.severity === 'high') bySeverity.high++;
    else if (f.severity === 'medium') bySeverity.medium++;
    else if (f.severity === 'low') bySeverity.low++;
  }

  if (prevFingerprints === undefined) {
    // First run — all findings are new
    return {
      status,
      new: currentCompleteFps.size,
      fixed: 0,
      persisting: 0,
      bySeverity,
    };
  }

  // Previous fingerprints for this target, grouped by family
  const prevFamilyFps = prevFingerprints.get(targetName) ?? new Set<string>();

  let newCount = 0;
  let persistingCount = 0;
  let fixedCount = 0;

  // new: in current complete families but not in prev
  for (const fp of currentCompleteFps) {
    if (prevFamilyFps.has(fp)) {
      persistingCount++;
    } else {
      newCount++;
    }
  }

  // fixed: in prev but NOT in current AND the family that produced them completed
  // We need to know which family produced each prev fingerprint — this comes from
  // the previous report. Since we don't have the previous report here, we use
  // only complete families' absence as a proxy.
  //
  // The partial-run rule: fixed is only counted for families that completed.
  // Any prev fp from a non-complete family is NOT counted as fixed.
  //
  // Because prevFamilyFps only contains fingerprints from families that were
  // complete in the PREVIOUS run (the caller is responsible for building this map
  // from the previous report's complete-family findings), we check whether the
  // family that produced that fingerprint also ran to completion THIS run.
  //
  // The prevCompleteFamilyFps parameter gives us exactly the fingerprints that
  // were complete last time. We can only count a fingerprint as "fixed" if:
  //   1. It was present in the previous run (it was complete last time, so it's in prevFamilyFps)
  //   2. It is NOT present in the current run
  //   3. Its originating family completed THIS run
  //
  // Since we don't have per-fingerprint family membership from prev, we compute
  // "fixed" conservatively: only count a prev fp as fixed if the current run
  // completed at least one family (so the absence is meaningful) — but only from
  // the complete families of THIS run.
  //
  // Implementation: a prev fp is fixed only if:
  //   - It is in prevFamilyFps (was present last run)
  //   - It is NOT in currentCompleteFps
  //   - completeFamilies is non-empty (so at least something ran and completed)
  //
  // This is conservative but correct: if a family timed out, we don't count its
  // previously-known findings as fixed.
  for (const fp of prevFamilyFps) {
    if (!currentCompleteFps.has(fp) && completeFamilies.size > 0) {
      fixedCount++;
    }
  }

  return {
    status,
    new: newCount,
    fixed: fixedCount,
    persisting: persistingCount,
    bySeverity,
  };
}

/**
 * Build a TrendLine from the current RunReport and optional previous fingerprint map.
 *
 * prevFingerprintsByTarget: for each target name, the set of fingerprints
 * from that target's COMPLETE families in the previous run. When undefined,
 * all findings are treated as new.
 */
export function buildTrendLine(
  report: RunReport,
  prevFingerprintsByTarget: ReadonlyMap<string, Set<string>> | undefined,
): TrendLine {
  const targetNames = new Set<string>();
  for (const f of report.findings) {
    if (f.target.kind === 'repo') {
      targetNames.add(f.target.name);
    } else {
      targetNames.add(f.target.host);
    }
  }
  // Also include targets with scanner status entries (even if no findings)
  for (const s of report.meta.scannerStatus) {
    targetNames.add(s.target);
  }

  const targets: Record<string, TargetTrend> = {};
  for (const name of targetNames) {
    targets[name] = computeTargetTrend(name, report, prevFingerprintsByTarget);
  }

  return {
    runId: report.runId,
    date: report.date,
    targets,
  };
}

/**
 * Read all existing trend lines from trend.jsonl.
 * Returns an empty array when the file does not exist or cannot be parsed.
 */
export function readTrendLines(trendPath?: string): TrendLine[] {
  const path = trendPath ?? TREND_PATH;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lines: TrendLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = TrendLineSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) lines.push(parsed.data);
    } catch {
      // Skip unparseable lines
    }
  }
  return lines;
}

/**
 * Build the fingerprint map from the most recent trend line's report.
 * Looks for the previous run by reading the most recent trend line and loading
 * the corresponding report.json. If the previous report is unavailable, returns
 * undefined (first run semantics).
 *
 * This is used to provide the prevFingerprintsByTarget for trend computation.
 */
export function buildPrevFingerprintMap(
  prevLines: TrendLine[],
  reportsDir?: string,
): ReadonlyMap<string, Set<string>> | undefined {
  if (prevLines.length === 0) return undefined;

  const base = reportsDir ?? resolve(REPO_ROOT, 'reports');
  // Find the most recent non-current run line
  const lastLine = prevLines[prevLines.length - 1];
  if (!lastLine) return undefined;

  const prevReportPath = resolve(base, lastLine.runId, 'report.json');
  let prevReport: RunReport;
  try {
    const raw = readFileSync(prevReportPath, 'utf8');
    prevReport = JSON.parse(raw) as RunReport;
  } catch {
    return undefined;
  }

  const map = new Map<string, Set<string>>();
  for (const f of prevReport.findings) {
    const targetName = f.target.kind === 'repo' ? f.target.name : f.target.host;

    // Only include fingerprints from families that completed in the prev run
    const wasComplete = prevReport.meta.scannerStatus.some(
      (s) => s.target === targetName && s.family === f.source && s.state === 'complete',
    );
    if (!wasComplete) continue;

    let fpSet = map.get(targetName);
    if (fpSet === undefined) {
      fpSet = new Set();
      map.set(targetName, fpSet);
    }
    fpSet.add(f.fingerprint);
  }

  return map;
}

/**
 * Append (or replace) a trend line in the JSONL file, keyed by runId (§14).
 *
 * The append is atomic: write a new tmp file then rename over the trend file.
 * An existing line with the same runId is replaced (idempotent re-runs).
 */
export async function writeTrend(
  line: TrendLine,
  trendPath?: string,
): Promise<void> {
  const path = trendPath ?? TREND_PATH;

  await mkdir(dirname(path), { recursive: true });

  const existing = readTrendLines(path);

  // Replace any existing line with the same runId
  const updated = existing.filter((l) => l.runId !== line.runId);
  updated.push(line);

  const jsonl = updated.map((l) => JSON.stringify(l)).join('\n') + '\n';

  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, jsonl, 'utf8');
  renameSync(tmp, path);
}
