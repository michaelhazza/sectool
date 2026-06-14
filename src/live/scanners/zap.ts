import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AllowedTarget } from '../gate.js';
import type { Session } from '../auth.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding, Severity } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// ZAP wrapper — scope-confined passive + active scan (§7.3)
//
// Orchestration mode decision (§16 open question): we use the ZAP
// Automation Framework YAML mode (`zap.sh -autorun <script.yaml>`) rather
// than the daemon/API mode. Reasons:
//   1. The automation-framework YAML produces structured JSON output in a
//      single subprocess invocation — no daemon lifecycle management needed.
//   2. ZAP 2.14+ ships the automation framework as a built-in component, so
//      no extra add-on install is required in the pinned Dockerfile image.
//   3. The wrapper interface (AllowedTarget in → Finding[] out) is identical
//      either way; the YAML generation and report parsing are both hidden
//      behind this module.
// The daemon-API mode would be preferable for interactive/incremental use;
// the automation-framework mode is preferable for single-pass CI execution,
// which is our primary use case.
//
// Subprocess is injectable (ExecZap) so unit tests use captured fixture output
// without running a real ZAP binary.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// ZAP native output types (subset of the ZAP automation-framework JSON report)
// ---------------------------------------------------------------------------

interface ZapAlert {
  /** ZAP alert id (numeric string) */
  readonly alertId?: string | undefined;
  /** Human-readable alert name */
  readonly name: string;
  /** Alert risk: Informational | Low | Medium | High | Critical */
  readonly riskdesc: string;
  /** Confidence: False Positive | Low | Medium | High | Confirmed */
  readonly confidence: string;
  /** Affected URL */
  readonly url: string;
  /** HTTP parameter involved, if any */
  readonly param?: string | undefined;
  /** Attack string used (active only) */
  readonly attack?: string | undefined;
  /** Evidence snippet */
  readonly evidence?: string | undefined;
  /** CWE identifier (numeric) */
  readonly cweid?: number | undefined;
  /** WASC identifier (numeric) */
  readonly wascid?: number | undefined;
  /** ZAP plugin id */
  readonly pluginId?: string | undefined;
  /** Alert description */
  readonly description?: string | undefined;
  /** Solution text */
  readonly solution?: string | undefined;
  /** Other info */
  readonly otherinfo?: string | undefined;
}

interface ZapSiteAlerts {
  readonly site?: string | undefined;
  readonly alerts: readonly ZapAlert[];
}

/** Minimal subset of ZAP automation-framework JSON output we parse. */
export interface ZapReport {
  /** Array of sites with their alert lists */
  readonly sites?: readonly ZapSiteAlerts[] | undefined;
  /** Flat alert list (some ZAP report formats use this) */
  readonly alerts?: readonly ZapAlert[] | undefined;
}

// ---------------------------------------------------------------------------
// Injectable subprocess type
// ---------------------------------------------------------------------------

export type ExecZap = (args: readonly string[]) => Promise<ZapReport>;

// ---------------------------------------------------------------------------
// Severity + family mapping helpers
// ---------------------------------------------------------------------------

function mapZapRisk(riskdesc: string): Severity {
  const lower = riskdesc.toLowerCase();
  if (lower.startsWith('critical')) return 'critical';
  if (lower.startsWith('high')) return 'high';
  if (lower.startsWith('medium')) return 'medium';
  return 'low';
}

/**
 * Derive the checkId prefix from a ZAP alert.
 * Passive alerts are reported by ZAP in all scan modes.
 * Active alerts are only generated when activeScan:true (we gate on that
 * before calling runZap with an active policy).
 *
 * We use ZAP-P-* for passive and ZAP-A-* for active. ZAP plugin id ranges:
 *   Passive scanners: < 40000 (e.g. 10021 = X-Content-Type-Options missing)
 *   Active scanners:  40000+ (e.g. 40018 = SQL Injection, 40012 = XSS Reflected)
 * This is the de-facto ZAP convention; passive scanners run on all traffic
 * while active scanners only fire in active scan mode. Fall back to ZAP-P-*
 * when the plugin id is unknown.
 */
function zapCheckId(alert: ZapAlert): string {
  const id = alert.pluginId ?? alert.alertId ?? '';
  const numId = parseInt(id, 10);
  const isActive = !isNaN(numId) && numId >= 40000;
  const suffix = id.length > 0 ? id : alert.name.replace(/\s+/g, '-').slice(0, 32);
  return isActive ? `ZAP-A-${suffix}` : `ZAP-P-${suffix}`;
}

// ---------------------------------------------------------------------------
// Scope-confinement check (§4.4)
//
// Returns true if the alert URL belongs to the expected host.
// Off-host alerts are skipped (recorded in scope-excluded metadata, but we
// never create findings for them here — a higher-level engine layer would
// record them as scope-excluded; in this normalizer we simply filter them).
// ---------------------------------------------------------------------------

function isInScope(alertUrl: string, target: AllowedTarget): boolean {
  try {
    const parsed = new URL(alertUrl);
    return parsed.hostname === target.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Finding normalizer: ZapAlert → Finding (raw stage, live surface)
// ---------------------------------------------------------------------------

function normalizeAlert(alert: ZapAlert, target: AllowedTarget): Finding {
  const checkId = zapCheckId(alert);
  const severity = mapZapRisk(alert.riskdesc);
  const urlPath = (() => {
    try {
      return new URL(alert.url).pathname;
    } catch {
      return '/';
    }
  })();
  const normalizedPath = normalizeUrlPath(urlPath);
  const parameter = alert.param ?? '';
  const evidenceClass = alert.evidence ? 'evidence' : 'alert';

  const fp = fingerprint({
    kind: 'live',
    checkId,
    host: target.hostname,
    urlPath: normalizedPath,
    parameter,
    evidenceClass,
  });

  const rawEvidence: Record<string, unknown> = {
    name: alert.name,
    riskdesc: alert.riskdesc,
    confidence: alert.confidence,
    url: alert.url,
  };
  if (alert.param !== undefined) rawEvidence['param'] = alert.param;
  if (alert.attack !== undefined) rawEvidence['attack'] = alert.attack;
  if (alert.evidence !== undefined) rawEvidence['evidence'] = alert.evidence;
  if (alert.description !== undefined) rawEvidence['description'] = alert.description;
  if (alert.cweid !== undefined) rawEvidence['cweid'] = alert.cweid;

  const snippet = alert.evidence
    ? `${alert.name}: ${alert.evidence.slice(0, 200)}`
    : alert.name;

  return {
    id: displayId(fp),
    fingerprint: fp,
    ruleId: checkId,
    source: 'zap',
    surface: 'live',
    vulnClass: 'misconfiguration',
    severity,
    baseSeverity: severity,
    confidence: 'probable',
    target: { kind: 'staging', host: target.hostname },
    location: {
      url: alert.url,
      parameter: parameter.length > 0 ? parameter : undefined,
      method: 'GET',
    },
    evidence: {
      snippet,
      cvss: null,
      raw: redact(rawEvidence) as Record<string, unknown>,
    },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: new Date().toISOString(),
    suppressed: false,
    suppression: null,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// Collect alerts from the ZAP report structure (handles both layouts)
// ---------------------------------------------------------------------------

function collectAlerts(report: ZapReport): readonly ZapAlert[] {
  if (report.alerts && report.alerts.length > 0) {
    return report.alerts;
  }
  if (report.sites) {
    const out: ZapAlert[] = [];
    for (const site of report.sites) {
      for (const alert of site.alerts) {
        out.push(alert);
      }
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ZapOpts {
  /** RPS budget for the host (passed to withHostBudget) */
  readonly rps: number;
  /** When true, run active scan policy (only called when activeScan:true) */
  readonly activeScan: boolean;
  /** Sessions for the two test users (required when activeScan:true) */
  readonly sessions?: readonly [Session, Session] | undefined;
}

/**
 * Run ZAP against the given AllowedTarget.
 *
 * Passive scan (ZAP-P-*): always run.
 * Active scan (ZAP-A-*): only when opts.activeScan is true and both sessions
 * are provided. Missing/failed sessions on an activeScan:true target → throws
 * so the caller can mark the target failed (§6.2, §7.3).
 *
 * Scope: ZAP context and Nuclei target list set to exactly the allowlisted
 * host. Off-host alerts are filtered out (§4.4).
 *
 * The subprocess is injectable for unit testing.
 */
export async function runZap(
  target: AllowedTarget,
  opts: ZapOpts,
  execZap: ExecZap = defaultExecZap,
): Promise<Finding[]> {
  if (opts.activeScan && (opts.sessions === undefined || opts.sessions.length < 2)) {
    throw new Error(
      `ZAP active scan requires 2 established sessions for IDOR checks on ${target.hostname} — ` +
        'mark this target failed if sessions could not be established (§7.3)',
    );
  }

  let report: ZapReport;
  await withHostBudget(target.hostname, opts.rps, async (acquireToken) => {
    // Acquire a rate-limit token before handing off to the ZAP subprocess.
    // ZAP manages its own internal rate; we count one token for the entire
    // ZAP run (ZAP is always serialized per host via withHostBudget).
    await acquireToken();
    report = await execZap(buildZapArgs(target, opts));
  });

  const alerts = collectAlerts(report!);
  return alerts
    .filter((a) => isInScope(a.url, target))
    .map((a) => normalizeAlert(a, target));
}

// ---------------------------------------------------------------------------
// ZAP automation-framework YAML argument builder
//
// ZAP automation-framework mode: zap.sh -autorun <yaml>
// We generate the YAML inline and pass it via stdin (using -autorun /dev/stdin
// on Unix or a temp file path). For the injectable exec pattern used in tests,
// we pass a descriptive args array; the real ExecZap builds the subprocess.
// ---------------------------------------------------------------------------

function buildZapArgs(target: AllowedTarget, opts: ZapOpts): readonly string[] {
  // The real defaultExecZap uses these args to construct the automation YAML
  // and invoke ZAP. The test injectable ignores this and returns fixture JSON.
  const args = ['-autorun', '-host', target.url, '-passive', '-rate-limit', String(opts.rps)];
  if (opts.activeScan) {
    args.push('-active');
    if (opts.sessions) {
      const [s1, s2] = opts.sessions;
      args.push('-session1', s1.carrier, '-session2', s2.carrier);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Default real subprocess implementation (ZAP automation-framework mode)
// ---------------------------------------------------------------------------

/**
 * Real ZAP execution via automation-framework YAML.
 *
 * Generates a minimal automation-framework YAML targeting the given host,
 * runs `zap.sh -autorun -`, and parses the resulting JSON report from stdout.
 *
 * This implementation is exercised in P6 real-binary Docker integration tests.
 * Unit tests inject a fake ExecZap instead.
 */
export const defaultExecZap: ExecZap = async (args: readonly string[]): Promise<ZapReport> => {
  // Extract target URL from args (built by buildZapArgs above)
  const hostIdx = args.indexOf('-host');
  const targetUrl = hostIdx !== -1 ? (args[hostIdx + 1] ?? '') : '';

  const isActive = args.includes('-active');

  const rateLimitIdx = args.indexOf('-rate-limit');
  const rateLimitRps = rateLimitIdx !== -1 ? Number(args[rateLimitIdx + 1] ?? 10) : 10;

  // Write ZAP JSON report to a temp file (cross-platform; avoids /dev/stdout dependency).
  const reportFile = join(tmpdir(), `zap-report-${Date.now()}.json`);

  // Minimal automation-framework YAML for ZAP 2.14+
  const zapYaml = buildZapAutomationYaml(targetUrl, isActive, rateLimitRps, reportFile);

  // Write the YAML to a temp file; execFile does not accept stdin input.
  const tmpFile = join(tmpdir(), `zap-autorun-${Date.now()}.yaml`);
  writeFileSync(tmpFile, zapYaml, 'utf8');

  let reportContent: string;
  try {
    // `-cmd` MUST come before `-autorun`: it puts ZAP in headless inline mode.
    // Without it ZAP tries to start the desktop GUI and aborts in a headless
    // container (no X display) — the failure mode that marked the zap family
    // failed while the Go/Node scanners succeeded.
    await execFileAsync('zap.sh', ['-cmd', '-autorun', tmpFile, '-silent'], {
      timeout: 300_000, // 5 min cap per §5 scanner-timeout
      encoding: 'utf8',
    });
    // Read the report from the temp file ZAP wrote to (set in the YAML)
    reportContent = readFileSync(reportFile, 'utf8');
  } catch (err) {
    // ZAP -autorun exits non-zero in two distinct cases:
    //   exit 1: alerts found at or above the configured threshold (expected — the report is valid)
    //   exit 2+: genuine tool error (bad args, binary not found, internal crash)
    // Discriminate by checking whether the report file was written. If it exists
    // and is parseable, treat the run as successful (findings-present path).
    // If not, re-throw so the orchestrator marks the family failed.
    const execErr = err as NodeJS.ErrnoException & { code?: number };
    const exitCode = execErr.code;
    if (typeof exitCode === 'number' && exitCode === 1) {
      try {
        reportContent = readFileSync(reportFile, 'utf8');
        // Report was written — clean up yaml tmp and proceed to parse
        try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
        try { unlinkSync(reportFile); } catch { /* ignore cleanup errors */ }
        try {
          return JSON.parse(reportContent) as ZapReport;
        } catch {
          return { alerts: [] };
        }
      } catch {
        // Report file not written — genuine tool error
      }
    }
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    try { unlinkSync(reportFile); } catch { /* ignore cleanup errors */ }
    // Surface the real ZAP failure (exit code + stderr/stdout tail) rather than
    // a bare "Command failed" — the orchestrator records this in the run report
    // so a failed zap family is diagnosable without shelling into the container.
    // The automation framework prints plan/job errors to STDOUT, while the JVM
    // banner goes to stderr — capture BOTH so the failure cause is visible.
    const stderr = (execErr as { stderr?: string }).stderr ?? '';
    const stdout = (execErr as { stdout?: string }).stdout ?? '';
    const detail = [
      stdout.trim() ? `stdout: ${stdout.trim().slice(-1400)}` : '',
      stderr.trim() ? `stderr: ${stderr.trim().slice(-600)}` : '',
    ].filter(Boolean).join(' || ') || execErr.message;
    throw new Error(`zap.sh exited ${typeof exitCode === 'number' ? exitCode : 'unknown'}: ${detail}`);
  }
  try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  try { unlinkSync(reportFile); } catch { /* ignore cleanup errors */ }

  try {
    return JSON.parse(reportContent) as ZapReport;
  } catch {
    // Empty or unparseable output — return empty report (no alerts)
    return { alerts: [] };
  }
};

/**
 * YAML-quote a string value: wrap in double quotes and escape embedded
 * backslashes, double-quotes, and control characters (including newlines)
 * so the value cannot inject YAML directives.
 */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export function buildZapAutomationYaml(targetUrl: string, activeMode: boolean, rateLimitRps: number, reportFilePath: string): string {
  const quotedUrl = yamlQuote(targetUrl);
  // The include-path regex suffix MUST be inside the quotes — quoting the URL
  // and then appending `.*` produces `"https://host/".*`, which is invalid YAML
  // (a quoted scalar followed by a bare scalar) and aborts the ZAP plan parse.
  const quotedIncludePath = yamlQuote(`${targetUrl}.*`);
  const scanPolicy = activeMode
    ? `    - type: activeScan
      parameters:
        policy: Default Policy
`
    : '';
  return `---
env:
  contexts:
    - name: default
      urls:
        - ${quotedUrl}
      includePaths:
        - ${quotedIncludePath}
  parameters:
    maxRequestsPerSecond: ${rateLimitRps}
jobs:
  - type: spider
    parameters:
      maxDuration: 2
  - type: passiveScan-wait
${scanPolicy}  - type: report
    parameters:
      reportFile: ${yamlQuote(reportFilePath)}
      reportTitle: audit-tool-zap
      template: traditional-json
`;
}
