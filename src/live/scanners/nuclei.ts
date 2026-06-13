import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AllowedTarget } from '../gate.js';
import type { Session } from '../auth.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding, Severity } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// Nuclei wrapper — scope-confined passive + active scan (§7.3)
//
// Nuclei runs in two modes:
//   Passive: exposed-endpoint/version-leak/known-CVE templates
//   Active:  fuzzing templates (only when activeScan:true)
//
// Template selection:
//   Passive templates: exposed-panels, technologies, misconfiguration, cves
//   Active templates: fuzzing, file-inclusion, injection (only with active flag)
//
// Scope: Nuclei target list = exactly the allowlisted host URL (§4.4).
// Off-host findings are filtered out.
//
// Subprocess is injectable (ExecNuclei) so unit tests use captured fixture
// output without running a real Nuclei binary.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Nuclei native output types (JSONL — each line is one NucleiResult)
// ---------------------------------------------------------------------------

/** Severity levels used by Nuclei */
type NucleiSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';

export interface NucleiResult {
  /** Template id, e.g. "CVE-2021-44228" */
  readonly 'template-id': string;
  /** Full template path */
  readonly template?: string | undefined;
  /** Severity info object */
  readonly info: {
    readonly name: string;
    readonly severity: NucleiSeverity;
    readonly description?: string | undefined;
    readonly tags?: readonly string[] | undefined;
  };
  /** Matched URL */
  readonly 'matched-at': string;
  /** Matched URL (alternate field name in some versions) */
  readonly url?: string | undefined;
  /** Extracted values / evidence */
  readonly 'extracted-results'?: readonly string[] | undefined;
  /** Request / response pair (trimmed) */
  readonly request?: string | undefined;
  readonly response?: string | undefined;
  /** Matcher name */
  readonly 'matcher-name'?: string | undefined;
  /** Host */
  readonly host?: string | undefined;
  /** Type: http, dns, etc */
  readonly type?: string | undefined;
  /** CVE reference if present */
  readonly 'curl-command'?: string | undefined;
}

// ---------------------------------------------------------------------------
// Injectable subprocess type
// ---------------------------------------------------------------------------

/** Returns parsed Nuclei results (parsed from JSONL output). */
export type ExecNuclei = (args: readonly string[]) => Promise<readonly NucleiResult[]>;

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function mapNucleiSeverity(s: NucleiSeverity): Severity {
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium') return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// checkId derivation
//
// We map each Nuclei template-id to NUCLEI-<template-id>.
// The template-id is stable across runs for a given template.
// ---------------------------------------------------------------------------

function nucleiCheckId(result: NucleiResult): string {
  return `NUCLEI-${result['template-id']}`;
}

// ---------------------------------------------------------------------------
// Scope-confinement (§4.4)
// ---------------------------------------------------------------------------

function isInScope(matchedAt: string, target: AllowedTarget): boolean {
  try {
    const parsed = new URL(matchedAt);
    return parsed.hostname === target.hostname;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Finding normalizer: NucleiResult → Finding (raw stage, live surface)
// ---------------------------------------------------------------------------

function normalizeResult(result: NucleiResult, target: AllowedTarget): Finding {
  const checkId = nucleiCheckId(result);
  const matchedUrl = result['matched-at'] ?? result.url ?? target.url;
  const severity = mapNucleiSeverity(result.info.severity);

  const urlPath = (() => {
    try {
      return new URL(matchedUrl).pathname;
    } catch {
      return '/';
    }
  })();
  const normalizedPath = normalizeUrlPath(urlPath);
  const matcherName = result['matcher-name'] ?? '';
  const evidenceClass = matcherName.length > 0 ? matcherName : result.info.severity;

  const fp = fingerprint({
    kind: 'live',
    checkId,
    host: target.hostname,
    urlPath: normalizedPath,
    parameter: '',
    evidenceClass,
  });

  const rawEvidence: Record<string, unknown> = {
    templateId: result['template-id'],
    name: result.info.name,
    severity: result.info.severity,
    matchedAt: matchedUrl,
  };
  if (result['extracted-results'] !== undefined) {
    rawEvidence['extractedResults'] = result['extracted-results'];
  }
  if (result['matcher-name'] !== undefined) {
    rawEvidence['matcherName'] = result['matcher-name'];
  }
  if (result.info.description !== undefined) {
    rawEvidence['description'] = result.info.description;
  }

  const extracted = result['extracted-results']?.[0];
  const snippet = extracted
    ? `${result.info.name}: ${extracted.slice(0, 200)}`
    : result.info.name;

  return {
    id: displayId(fp),
    fingerprint: fp,
    ruleId: checkId,
    source: 'nuclei',
    surface: 'live',
    vulnClass: 'info-disclosure',
    severity,
    baseSeverity: severity,
    confidence: 'probable',
    target: { kind: 'staging', host: target.hostname },
    location: {
      url: matchedUrl,
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
// Public API
// ---------------------------------------------------------------------------

export interface NucleiOpts {
  /** RPS budget for the host */
  readonly rps: number;
  /** When true, run fuzzing / active templates */
  readonly activeScan: boolean;
  /** Session for authenticated scanning (optional even in active mode) */
  readonly session?: Session | undefined;
}

/**
 * Run Nuclei against the given AllowedTarget.
 *
 * Passive templates (exposed-panels, technologies, misconfiguration, cves):
 * always run.
 * Active/fuzzing templates: only when opts.activeScan is true.
 *
 * Scope: target list = exactly the allowlisted host URL (§4.4).
 * Off-host results are filtered out.
 *
 * The subprocess is injectable for unit testing.
 */
export async function runNuclei(
  target: AllowedTarget,
  opts: NucleiOpts,
  execNuclei: ExecNuclei = defaultExecNuclei,
): Promise<Finding[]> {
  let results: readonly NucleiResult[] = [];

  await withHostBudget(target.hostname, opts.rps, async (acquireToken) => {
    // Acquire one token before the Nuclei subprocess run.
    await acquireToken();
    results = await execNuclei(buildNucleiArgs(target, opts));
  });

  return results
    .filter((r) => {
      const url = r['matched-at'] ?? r.url ?? '';
      return isInScope(url, target);
    })
    .map((r) => normalizeResult(r, target));
}

// ---------------------------------------------------------------------------
// Nuclei argument builder
// ---------------------------------------------------------------------------

/** Template tags for passive scanning (exposed-endpoint / version-leak / CVE). */
const PASSIVE_TAGS = ['exposed-panels', 'technologies', 'misconfiguration', 'cves'];
/** Additional template tags for active/fuzzing mode. */
const ACTIVE_TAGS = ['fuzzing', 'file-inclusion', 'injection'];

function buildNucleiArgs(target: AllowedTarget, opts: NucleiOpts): readonly string[] {
  const tags = opts.activeScan ? [...PASSIVE_TAGS, ...ACTIVE_TAGS] : PASSIVE_TAGS;
  const args: string[] = [
    '-target', target.url,
    '-tags', tags.join(','),
    '-jsonl',            // JSONL output (one JSON object per line)
    '-no-interactsh',    // disable OOB callbacks in CI
    '-rate-limit', String(opts.rps),
    '-header', `User-Agent: BreakoutSolutions-audit-tool/1 (+security@breakoutsolutions.com)`,
  ];

  if (opts.session) {
    if (opts.session.carrier === 'bearer' && opts.session.bearerToken) {
      args.push('-H', `Authorization: Bearer ${opts.session.bearerToken}`);
    } else if (opts.session.carrier === 'cookie' && opts.session.cookieHeader) {
      args.push('-H', `Cookie: ${opts.session.cookieHeader}`);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Default real subprocess implementation
// ---------------------------------------------------------------------------

/**
 * Real Nuclei execution.
 * Runs `nuclei` with JSONL output, parses each line as a NucleiResult.
 * Exits 0 when no findings; exits non-zero when findings found (like gitleaks).
 * We treat exit 1 as "findings found" (parse the JSONL), other non-zero as error.
 */
export const defaultExecNuclei: ExecNuclei = async (
  args: readonly string[],
): Promise<readonly NucleiResult[]> => {
  let stdout = '';
  try {
    const result = await execFileAsync('nuclei', args as string[], {
      timeout: 300_000,
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (err) {
    // nuclei exits non-zero when it finds issues — parse what we got
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; code?: number };
    if (execErr.code === 1 && typeof execErr.stdout === 'string') {
      stdout = execErr.stdout;
    } else {
      throw err;
    }
  }

  return parseNucleiJsonl(stdout);
};

function parseNucleiJsonl(jsonl: string): readonly NucleiResult[] {
  const results: NucleiResult[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      results.push(JSON.parse(trimmed) as NucleiResult);
    } catch {
      // Skip non-JSON lines (Nuclei prints progress to stdout in some modes)
    }
  }
  return results;
}
