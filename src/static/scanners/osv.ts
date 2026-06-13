import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprint, displayId } from '../../correlate/fingerprint.js';
import type { Finding, Severity } from '../../schemas/finding.js';
import type { RepoTarget } from '../../schemas/targets.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Native osv-scanner JSON types
// ---------------------------------------------------------------------------

interface OsvVulnerabilityAlias {
  id: string;
}

interface OsvVulnerability {
  id: string;
  aliases?: OsvVulnerabilityAlias[];
  summary?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: Record<string, unknown>;
}

interface OsvPackage {
  name: string;
  version: string;
  ecosystem: string;
}

interface OsvGroup {
  ids: string[];
  aliases?: string[];
  max_severity?: string;
}

interface OsvResult {
  packages?: Array<{
    package: OsvPackage;
    vulnerabilities?: OsvVulnerability[];
    groups?: OsvGroup[];
  }>;
}

interface OsvOutput {
  results?: OsvResult[];
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function osvSeverity(vuln: OsvVulnerability, group?: OsvGroup): Severity {
  // Prefer the aggregated max_severity from the group (osv-scanner computes this)
  const maxSev = group?.max_severity;
  if (maxSev) {
    const s = maxSev.toUpperCase();
    if (s === 'CRITICAL') return 'critical';
    if (s === 'HIGH') return 'high';
    if (s === 'MEDIUM' || s === 'MODERATE') return 'medium';
    if (s === 'LOW') return 'low';
  }

  // Fallback: parse the first CVSS score from the vulnerability
  const severities = vuln.severity ?? [];
  for (const sev of severities) {
    const score = parseFloat(sev.score);
    if (!isNaN(score)) {
      if (score >= 9.0) return 'critical';
      if (score >= 7.0) return 'high';
      if (score >= 4.0) return 'medium';
      return 'low';
    }
  }

  return 'medium';
}

function normalizeOsvVuln(
  vuln: OsvVulnerability,
  pkg: OsvPackage,
  group: OsvGroup | undefined,
  target: RepoTarget,
): Finding {
  const ruleId = vuln.id;
  // OSV findings have no file location — the symbol is package@version
  const symbol = `${pkg.name}@${pkg.version}`;
  const path = 'package.json';
  const snippet = vuln.summary ?? ruleId;

  const fp = fingerprint({
    kind: 'static',
    ruleId,
    targetName: target.name,
    path,
    symbol,
    snippet,
  });

  const baseSeverity = osvSeverity(vuln, group);

  const finding: Finding = {
    id: displayId(fp),
    fingerprint: fp,
    ruleId,
    source: 'osv',
    surface: 'static',
    vulnClass: 'dependency-cve',
    severity: baseSeverity,
    baseSeverity,
    confidence: 'probable',
    target: { kind: 'repo', name: target.name },
    location: {
      path,
      symbol,
    },
    evidence: {
      snippet: vuln.summary,
      cvss: null,
      raw: {
        package: pkg,
        vulnerabilityId: ruleId,
        aliases: vuln.aliases?.map((a) => a.id) ?? [],
      },
    },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: new Date().toISOString(),
    suppressed: false,
    suppression: null,
    note: null,
  };

  return finding;
}

// ---------------------------------------------------------------------------
// Injectable subprocess interface
// ---------------------------------------------------------------------------

export type ExecOsv = (dir: string) => Promise<{ stdout: string }>;

async function defaultExecOsv(dir: string): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync('osv-scanner', [
    '--format', 'json',
    '--recursive',
    dir,
  ]);
  return { stdout };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run osv-scanner against a repo directory.
 *
 * Parses the osv-scanner JSON output and normalizes each vulnerability into a
 * raw-stage `Finding` with `source: 'osv'` and `vulnClass: 'dependency-cve'`.
 *
 * Shell-outs are injectable for unit testing — pass `exec` to override.
 * Non-zero exit / parse failure → throws so the orchestrator marks this family
 * `failed` for the target.
 */
export async function runOsv(
  target: RepoTarget,
  dir: string,
  exec: ExecOsv = defaultExecOsv,
): Promise<Finding[]> {
  const { stdout } = await exec(dir);

  if (!stdout.trim()) {
    return [];
  }

  let parsed: OsvOutput;
  try {
    parsed = JSON.parse(stdout) as OsvOutput;
  } catch {
    throw new Error(`osv-scanner: failed to parse JSON output: ${stdout.slice(0, 200)}`);
  }

  const findings: Finding[] = [];

  for (const result of parsed.results ?? []) {
    for (const pkgEntry of result.packages ?? []) {
      const pkg = pkgEntry.package;
      const vulnerabilities = pkgEntry.vulnerabilities ?? [];
      const groups = pkgEntry.groups ?? [];

      for (const vuln of vulnerabilities) {
        // Match this vuln to its group for max_severity lookup
        const group = groups.find((g) => g.ids.includes(vuln.id));
        findings.push(normalizeOsvVuln(vuln, pkg, group, target));
      }
    }
  }

  return findings;
}
