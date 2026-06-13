import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprint, displayId, normalizePath } from '../../correlate/fingerprint.js';
import { redactString } from '../../report/redaction.js';
import type { Finding } from '../../schemas/finding.js';
import type { RepoTarget } from '../../schemas/targets.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Native gitleaks JSON types
// ---------------------------------------------------------------------------

interface GitleaksResult {
  /** The matched secret value (raw credential). */
  Secret?: string;
  /** The full matched text around the secret. */
  Match?: string;
  /** Rule / detector id that fired. */
  RuleID?: string;
  /** Description of what was detected. */
  Description?: string;
  /** Relative file path. */
  File?: string;
  /** Line number of the match. */
  StartLine?: number;
  /** Commit SHA (may be absent for working-tree scans). */
  Commit?: string;
  /** The specific entropy/pattern that triggered. */
  Entropy?: number;
  /** Author email (may be present for commit-scoped scans). */
  Author?: string;
  /** Date of commit. */
  Date?: string;
  /** Symbolic tag (e.g. "generic-api-key"). */
  Tags?: string[];
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

function normalizeGitleaksResult(result: GitleaksResult, target: RepoTarget): Finding {
  const ruleId = result.RuleID ?? 'gitleaks-unknown';
  const path = normalizePath(result.File ?? '');
  const startLine = result.StartLine;

  // The symbol for a secrets finding is the rule id (no route context).
  const symbol = ruleId;

  // The snippet for fingerprinting: the Description (stable) rather than the
  // raw secret value (volatile). This keeps the fingerprint stable even after
  // redaction (the raw secret is NEVER part of the preimage — redaction runs
  // at this boundary).
  const snippet = result.Description ?? ruleId;

  const fp = fingerprint({
    kind: 'static',
    ruleId,
    targetName: target.name,
    path,
    symbol,
    snippet,
  });

  // Redact the secret value before it appears on any Finding field (§5.4).
  const rawSecret = result.Secret ?? '';
  const redactedSecret = rawSecret ? redactString(rawSecret) : '';

  const rawMatch = result.Match ?? '';
  const redactedMatch = rawMatch ? redactString(rawMatch) : '';

  // Build a redacted snapshot of the raw result for evidence.raw — the secret
  // and match fields are replaced by their stable placeholders.
  const redactedRaw: Record<string, unknown> = {
    ...result,
    ...(rawSecret ? { Secret: redactedSecret } : {}),
    ...(rawMatch ? { Match: redactedMatch } : {}),
  };

  const finding: Finding = {
    id: displayId(fp),
    fingerprint: fp,
    ruleId,
    source: 'gitleaks',
    surface: 'static',
    vulnClass: 'secrets',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    target: { kind: 'repo', name: target.name },
    location: {
      path,
      symbol,
      ...(startLine !== undefined ? { startLine } : {}),
    },
    evidence: {
      snippet: redactedSecret || undefined,
      cvss: null,
      raw: redactedRaw,
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

export type ExecGitleaks = (dir: string) => Promise<{ stdout: string; exitCode: number }>;

async function defaultExecGitleaks(
  dir: string,
): Promise<{ stdout: string; exitCode: number }> {
  // gitleaks exits 1 when leaks are found, 0 when clean — both are valid.
  // We treat exit code 2+ as a hard error (misconfiguration / unreadable repo).
  try {
    const { stdout } = await execFileAsync('gitleaks', [
      'detect',
      '--source', dir,
      '--report-format', 'json',
      '--report-path', '/dev/stdout',
      '--no-banner',
      '--exit-code', '1',
    ]);
    return { stdout, exitCode: 0 };
  } catch (err) {
    // execFile throws on non-zero exit. Capture stdout from the error object.
    const execErr = err as { stdout?: string; code?: number };
    const code = execErr.code ?? 1;
    const stdout = execErr.stdout ?? '';
    // Exit code 1 = leaks found (normal); anything else is a tool error.
    if (code === 1) {
      return { stdout, exitCode: 1 };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run gitleaks against a repo directory.
 *
 * gitleaks exits 1 when leaks are found (normal) and 0 when none — both are
 * non-error conditions. Exit 2+ is a tool error and throws so the orchestrator
 * can mark this family `failed`.
 *
 * Secret values are redacted at the normalizer boundary via `redactString`
 * before they appear on any `Finding` field (§5.4).
 *
 * Shell-outs are injectable for unit testing — pass `exec` to override.
 */
export async function runGitleaks(
  target: RepoTarget,
  dir: string,
  exec: ExecGitleaks = defaultExecGitleaks,
): Promise<Finding[]> {
  const { stdout } = await exec(dir);

  if (!stdout.trim()) {
    return [];
  }

  let parsed: GitleaksResult[];
  try {
    parsed = JSON.parse(stdout) as GitleaksResult[];
  } catch {
    throw new Error(`gitleaks: failed to parse JSON output: ${stdout.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('gitleaks: expected JSON array output');
  }

  return parsed.map((r) => normalizeGitleaksResult(r, target));
}
