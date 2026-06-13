import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprint, displayId, normalizePath, normalizeSnippet } from '../../correlate/fingerprint.js';
import { redact } from '../../report/redaction.js';
import type { Finding, Severity, VulnClass } from '../../schemas/finding.js';
import type { RepoTarget } from '../../schemas/targets.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Native semgrep JSON types
// ---------------------------------------------------------------------------

interface SemgrepExtra {
  message?: string;
  severity?: string;
  metadata?: Record<string, unknown>;
  lines?: string;
}

interface SemgrepResult {
  check_id: string;
  path: string;
  start?: { line?: number };
  extra?: SemgrepExtra;
}

interface SemgrepOutput {
  results?: SemgrepResult[];
}

// ---------------------------------------------------------------------------
// vulnClass mapping for semgrep findings
// ---------------------------------------------------------------------------

// Semgrep metadata owasp and categories → our vulnClass
const SEMGREP_VULN_CLASS_MAP: Record<string, VulnClass> = {
  injection: 'injection',
  sqli: 'injection',
  'sql-injection': 'injection',
  'command-injection': 'injection',
  xss: 'xss',
  'cross-site-scripting': 'xss',
  csrf: 'csrf',
  'open-redirect': 'open-redirect',
  'insecure-configuration': 'misconfiguration',
  misconfiguration: 'misconfiguration',
  'missing-security-headers': 'misconfiguration',
  secrets: 'secrets',
  'sensitive-data-exposure': 'info-disclosure',
  'information-disclosure': 'info-disclosure',
  authentication: 'auth-access-control',
  authorization: 'auth-access-control',
  'broken-authentication': 'auth-access-control',
  'broken-access-control': 'auth-access-control',
  'access-control': 'auth-access-control',
  'session-management': 'session-management',
  tls: 'tls',
  cors: 'misconfiguration',
};

function semgrepVulnClass(result: SemgrepResult): VulnClass {
  // Try to infer from check_id name
  const id = result.check_id.toLowerCase();

  // Check explicit metadata categories first
  const meta = result.extra?.metadata;
  if (meta) {
    const categories = meta['category'] ?? meta['categories'] ?? meta['owasp'];
    if (Array.isArray(categories)) {
      for (const cat of categories) {
        if (typeof cat === 'string') {
          const mapped = SEMGREP_VULN_CLASS_MAP[cat.toLowerCase()];
          if (mapped !== undefined) return mapped;
        }
      }
    } else if (typeof categories === 'string') {
      const mapped = SEMGREP_VULN_CLASS_MAP[categories.toLowerCase()];
      if (mapped !== undefined) return mapped;
    }
  }

  // Fallback: check rule id tokens
  for (const [token, vulnClass] of Object.entries(SEMGREP_VULN_CLASS_MAP)) {
    if (id.includes(token)) return vulnClass;
  }

  return 'misconfiguration';
}

function semgrepSeverity(result: SemgrepResult): Severity {
  const raw = (result.extra?.severity ?? '').toUpperCase();
  if (raw === 'ERROR' || raw === 'CRITICAL') return 'critical';
  if (raw === 'WARNING' || raw === 'HIGH') return 'high';
  if (raw === 'INFO' || raw === 'MEDIUM') return 'medium';
  return 'low';
}

function normalizeSemgrepResult(result: SemgrepResult, target: RepoTarget): Finding {
  const path = normalizePath(result.path);
  const symbol = result.check_id;
  const snippet = normalizeSnippet(result.extra?.lines ?? '');
  const baseSeverity = semgrepSeverity(result);
  const vulnClass = semgrepVulnClass(result);
  const startLine = result.start?.line;

  const fp = fingerprint({
    kind: 'static',
    ruleId: result.check_id,
    targetName: target.name,
    path,
    symbol,
    snippet,
  });

  const finding: Finding = {
    id: displayId(fp),
    fingerprint: fp,
    ruleId: result.check_id,
    source: 'semgrep',
    surface: 'static',
    vulnClass,
    severity: baseSeverity,
    baseSeverity,
    confidence: 'probable',
    target: { kind: 'repo', name: target.name },
    location: {
      path,
      symbol,
      ...(startLine !== undefined ? { startLine } : {}),
    },
    evidence: {
      snippet: snippet || undefined,
      cvss: null,
      raw: redact(result.extra ?? {}) as Record<string, unknown>,
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
// Injectable subprocess interface (enables unit testing without live binary)
// ---------------------------------------------------------------------------

export type ExecSemgrep = (
  dir: string,
  ruleArgs: string[],
) => Promise<{ stdout: string; stderr: string }>;

async function defaultExecSemgrep(
  dir: string,
  ruleArgs: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('semgrep', [
    '--json',
    ...ruleArgs,
    '--no-git-ignore',
    dir,
  ]);
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run semgrep against a repo directory.
 * Runs both the `p/owasp-top-ten` curated registry subset and any local
 * YAML rules under `rules/semgrep/` (the custom rule pack, §7.2).
 *
 * Shell-outs are injectable for unit testing — pass `exec` to override.
 * Returns raw-stage `Finding[]` with redaction applied at the normalizer
 * boundary (§5.4).
 *
 * Non-zero semgrep exit / parse failure → throws so the orchestrator can
 * mark this family `failed` for the target.
 */
export async function runSemgrep(
  target: RepoTarget,
  dir: string,
  exec: ExecSemgrep = defaultExecSemgrep,
): Promise<Finding[]> {
  const ruleArgs = [
    '--config', 'p/owasp-top-ten',
    '--config', 'rules/semgrep/',
  ];

  const { stdout } = await exec(dir, ruleArgs);

  let parsed: SemgrepOutput;
  try {
    parsed = JSON.parse(stdout) as SemgrepOutput;
  } catch {
    throw new Error(`semgrep: failed to parse JSON output: ${stdout.slice(0, 200)}`);
  }

  const results = parsed.results ?? [];
  return results.map((r) => normalizeSemgrepResult(r, target));
}
