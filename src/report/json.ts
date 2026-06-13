import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, VulnClass } from '../schemas/finding.js';
import type { Baseline } from '../schemas/baseline.js';
import type { RunReport, RunMeta, RunTarget, ScannerStatusEntry } from '../schemas/report.js';
import type { FixesFile } from '../schemas/fix.js';
import { FixesFileSchema } from '../schemas/fix.js';
import { applyBaseline } from './baseline.js';
import { computeSeverity } from '../correlate/severity.js';
import { redact } from './redaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');

// §8.1 vulnClass criticality ordering (lower index = more critical in ordering)
const VULN_CLASS_ORDER: Record<VulnClass, number> = {
  'tenant-isolation': 0,
  'injection': 1,
  'secrets': 2,
  'auth-access-control': 3,
  'xss': 4,
  'csrf': 5,
  'session-management': 6,
  'open-redirect': 7,
  'info-disclosure': 8,
  'tls': 9,
  'misconfiguration': 10,
  'dependency-cve': 11,
};

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CONFIDENCE_ORDER: Record<string, number> = {
  confirmed: 0,
  probable: 1,
  tentative: 2,
};

/**
 * Sort findings per §8.1 report order:
 * severity desc → confidence desc → vulnClass criticality → target name →
 * ruleId asc → full fingerprint asc (total tiebreaker).
 *
 * Pure function — returns a new sorted array.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    // 1. severity desc
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    if (sevDiff !== 0) return sevDiff;

    // 2. confidence desc
    const confDiff = (CONFIDENCE_ORDER[a.confidence] ?? 99) - (CONFIDENCE_ORDER[b.confidence] ?? 99);
    if (confDiff !== 0) return confDiff;

    // 3. vulnClass criticality
    const vcDiff = (VULN_CLASS_ORDER[a.vulnClass] ?? 99) - (VULN_CLASS_ORDER[b.vulnClass] ?? 99);
    if (vcDiff !== 0) return vcDiff;

    // 4. target name asc
    const targetA = a.target.kind === 'repo' ? a.target.name : a.target.host;
    const targetB = b.target.kind === 'repo' ? b.target.name : b.target.host;
    const targetDiff = targetA.localeCompare(targetB);
    if (targetDiff !== 0) return targetDiff;

    // 5. ruleId asc
    const ruleIdDiff = a.ruleId.localeCompare(b.ruleId);
    if (ruleIdDiff !== 0) return ruleIdDiff;

    // 6. full fingerprint asc (total tiebreaker)
    return a.fingerprint.localeCompare(b.fingerprint);
  });
}

/**
 * Load and parse fixes.json from disk. Returns an empty object when the file
 * does not exist or cannot be parsed. Never throws.
 * This is a read-only operation — it never writes to the file.
 */
function loadFixesFile(fixesPath: string): FixesFile {
  try {
    const raw = readFileSync(fixesPath, 'utf8');
    const parsed = FixesFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    return {};
  } catch {
    return {};
  }
}

/**
 * Derive the report-stage derived fields for a finding:
 *   - severity: recomputed via §8.1 modifier chain
 *   - externalRefs: join to fixes.json by full fingerprint (read-only, §14)
 *
 * `correlatedWith` and `suppressed`/`suppression`/`note` are set by correlate()
 * and applyBaseline() respectively — this function does NOT touch them.
 */
function deriveReportFields(
  finding: Finding,
  fixesFile: FixesFile,
): Finding {
  // Recompute severity — liveConfirmed is true when correlatedWith is non-empty
  const liveConfirmed = finding.correlatedWith.length > 0;
  const { severity, confidence } = computeSeverity(
    {
      baseSeverity: finding.baseSeverity,
      reachability: finding.reachability,
      vulnClass: finding.vulnClass,
      confidence: finding.confidence,
    },
    { liveConfirmed },
  );

  // Rehydrate externalRefs via fingerprint join (pure read — never writes fixes.json)
  const fixEntry = fixesFile[finding.fingerprint];
  const externalRefs: string[] = fixEntry?.issueUrl !== undefined ? [fixEntry.issueUrl] : [];

  return {
    ...finding,
    severity,
    confidence,
    externalRefs,
  };
}

export interface BuildReportInput {
  readonly runId: string;
  readonly date: string;
  readonly rawFindings: readonly Finding[];
  readonly scannerStatus: readonly ScannerStatusEntry[];
  readonly targets: readonly RunTarget[];
  readonly meta: RunMeta;
  readonly baseline: Baseline;
  readonly fixesPath?: string;
}

/**
 * Assemble a RunReport from scanner outputs.
 *
 * Pipeline:
 * 1. Apply baseline suppression (P5-3)
 * 2. Derive report-stage fields (severity, externalRefs)
 * 3. Sort per §8.1 report order (total tiebreaker: ruleId → fingerprint)
 * 4. Redact the assembled report (§5.4)
 *
 * The fixes.json read is a pure projection — this function never mutates
 * fixes.json (§14 state-based idempotency note).
 */
export function buildReport(input: BuildReportInput): RunReport {
  const fixesPath =
    input.fixesPath ?? resolve(REPO_ROOT, 'reports', 'fixes.json');

  const fixesFile = loadFixesFile(fixesPath);

  // Step 1: apply baseline suppression
  const now = new Date();
  const suppressed = applyBaseline(input.rawFindings, input.baseline, now);

  // Step 2: derive report-stage fields for each finding
  const derived = suppressed.map((f) => deriveReportFields(f, fixesFile));

  // Step 3: sort per §8.1 total order
  const sorted = sortFindings(derived);

  const report: RunReport = {
    runId: input.runId,
    date: input.date,
    findings: sorted,
    targets: [...input.targets],
    meta: input.meta,
  };

  // Step 4: redact the report (§5.4 — every emitter applies the redaction chokepoint)
  return redact(report) as RunReport;
}

/**
 * Write a RunReport to `reports/<runId>/report.json` atomically (tmp+rename, §14).
 * Creates the directory if it does not exist.
 */
export async function writeReport(report: RunReport, reportsDir?: string): Promise<string> {
  const base = reportsDir ?? resolve(REPO_ROOT, 'reports');
  const runDir = resolve(base, report.runId);
  await mkdir(runDir, { recursive: true });

  const outPath = resolve(runDir, 'report.json');
  const tmp = `${outPath}.tmp.${process.pid}`;

  writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
  renameSync(tmp, outPath);

  return outPath;
}
