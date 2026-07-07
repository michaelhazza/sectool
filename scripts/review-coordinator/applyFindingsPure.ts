/**
 * applyFindingsPure.ts
 *
 * Pure logic for the coordinator auto-apply pipeline (§11a).
 * All functions are input-as-data, output-as-data. Zero I/O.
 * No imports of node:fs, node:child_process, node:path, or node:util.
 *
 * Consumed by applyFindings.ts (the I/O orchestrator).
 */

import type { Finding, ReviewResult } from '../chatgpt-reviewPure.js';
import { classifyAcceptanceCheck } from '../chatgpt-reviewPure.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Risk domains that always trigger the carve-out (§13). */
export const CARVE_OUT_RISK_DOMAINS = new Set([
  'tenant_isolation',
  'security',
  'auth_authorisation',
  'idempotency',
  'data_integrity',
  'compliance',
]);

/** Default maximum number of findings per auto-apply batch (§11a Step 4b). */
export const DEFAULT_BATCH_LIMIT = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoordinatorDecision =
  | 'applied'
  | 'overridden_to_surface'
  | 'auto_apply_failed'
  | 'quarantined'
  | 'already_applied_by_reviewer'
  | 'suppressed_advisory'
  | 'cumulative_verify_failed';

export type CoordinatorOverrideReason =
  | 'invalid_acceptance_check'
  | 'recommendation_not_implement'
  | 'auto_apply_not_eligible'
  | 'carve_out_risk_domain'
  | 'architectural'
  | 'user_facing'
  | 'technical_escalated'
  | 'suppressed'
  | 'overlapping_patch_surface'
  | 'auto_apply_batch_limit'
  | 'missing_affected_files'
  | 'anchor_not_found'
  | 'anchor_not_unique'
  | 'auto_apply_failed'
  | 'inline_apply_verification_failed'
  | 'cumulative_verify_failed';

export interface FourKeyGateResult {
  eligible: boolean;
  reason: CoordinatorOverrideReason | null;
}

export interface OverlapCheckResult {
  keep: Finding[];
  deferred: Array<{ finding: Finding; conflicting_id: string }>;
}

export interface ProductionDsnMatchResult {
  isProduction: boolean;
  matchedPattern: string | null;
}

export interface SuppressionEntry {
  suppression_id: string;
  pattern: string;
  scope: 'repo' | 'build_slug' | 'reviewer_mode';
  applies_to_reviewer: string;
  risk_domain: string;
  created_from: {
    finding_id: string;
    review_log: string;
    operator_decision: string;
  };
  expires_after?: string;
  expires_at_build_count?: number;
  created_at: string;
  build_slug?: string;
  reviewer_mode?: string;
  /** Internal: how many builds have passed since creation. */
  builds_since_created?: number;
  /** Whether the operator confirmed a repo-wide suppression. */
  repo_wide_confirmed?: boolean;
}

export interface SuppressionMatchResult {
  suppressed: boolean;
  suppression_id: string | null;
}

export type DisagreementCase =
  | 'second_order_regression'
  | 'openai_wins_pending'
  | 'keep_claude'
  | 'auto_elevate_severity';

export interface DisagreementRecord {
  earlier_reviewer: string;
  earlier_finding_id: string;
  earlier_decision: string;
  later_reviewer: string;
  later_finding_id: string;
  later_decision: DisagreementCase;
  operator_decision: 'revert' | 'keep' | 'amend' | 'pending';
}

// ---------------------------------------------------------------------------
// §11a Step 3: Four-key gate
// ---------------------------------------------------------------------------

/**
 * Run all eight sub-checks in §11a Step 3 for a single finding.
 * Returns eligible=true only when ALL pass. Returns the first failing
 * override reason when eligible=false.
 *
 * Sub-checks (in order per §11a Step 3):
 * 1. Anti-vagueness: acceptance_check must not be unknown
 * 2. Semantic validator: classifyAcceptanceCheck returns concrete kind
 * 3. Recommendation gate: must be "implement"
 * 4. Reviewer eligibility: auto_apply_eligible: true + local_one_obvious_fix
 * 5. Carve-out: risk_domain not in CARVE_OUT_RISK_DOMAINS
 * 6. Scope: scope_signal must be "local"
 * 7. Triage: triage_hint must be "technical"
 * 8. Suppression memory: not suppressed by an active entry
 */
export function runFourKeyGate(
  finding: Finding,
  suppressionEntries: SuppressionEntry[],
  buildSlug?: string,
): FourKeyGateResult {
  // Sub-check 1 + 2: acceptance_check anti-vagueness + semantic classifier
  const acceptanceKind = classifyAcceptanceCheck(finding.acceptance_check ?? '');
  if (acceptanceKind === 'unknown') {
    return { eligible: false, reason: 'invalid_acceptance_check' };
  }

  // Sub-check 3: recommendation must be "implement"
  if (finding.recommendation !== 'implement') {
    return { eligible: false, reason: 'recommendation_not_implement' };
  }

  // Sub-check 4: reviewer declared eligible + reason
  if (
    finding.auto_apply_eligible !== true ||
    finding.auto_apply_reason !== 'local_one_obvious_fix'
  ) {
    return { eligible: false, reason: 'auto_apply_not_eligible' };
  }

  // Sub-check 5: carve-out (§13)
  if (CARVE_OUT_RISK_DOMAINS.has(finding.risk_domain ?? '')) {
    return { eligible: false, reason: 'carve_out_risk_domain' };
  }

  // Sub-check 6: scope
  if (finding.scope_signal !== 'local') {
    return { eligible: false, reason: 'architectural' };
  }

  // Sub-check 7: triage
  if (finding.triage_hint === 'user-facing') {
    return { eligible: false, reason: 'user_facing' };
  }
  if (finding.triage_hint === 'technical-escalated') {
    return { eligible: false, reason: 'technical_escalated' };
  }

  // Sub-check 8: suppression memory (§11c)
  const suppressed = matchSuppression(finding, suppressionEntries, buildSlug);
  if (suppressed.suppressed) {
    return { eligible: false, reason: 'suppressed' };
  }

  return { eligible: true, reason: null };
}

// ---------------------------------------------------------------------------
// §11a Step 4a: Overlap detection
// ---------------------------------------------------------------------------

/**
 * Given a list of eligible findings, detect overlapping affected_files.
 * For each overlap pair, the first-queued (lowest id sort) keeps eligibility;
 * later ones are deferred to the surfaced bucket.
 *
 * "Overlap" = same file path in affected_files[] (line-range comparison is
 * not available without the actual diff; we treat same-file as overlapping
 * per the conservative fallback described in §11a Step 4a).
 */
export function detectOverlaps(findings: Finding[]): OverlapCheckResult {
  const keep: Finding[] = [];
  const deferred: Array<{ finding: Finding; conflicting_id: string }> = [];
  const seenFiles = new Map<string, string>(); // file -> finding id that owns it

  for (const finding of findings) {
    const files = finding.affected_files ?? [];
    let conflict: string | null = null;

    for (const file of files) {
      if (seenFiles.has(file)) {
        conflict = seenFiles.get(file)!;
        break;
      }
    }

    if (conflict !== null) {
      deferred.push({ finding, conflicting_id: conflict });
    } else {
      keep.push(finding);
      for (const file of files) {
        seenFiles.set(file, finding.id);
      }
    }
  }

  return { keep, deferred };
}

// ---------------------------------------------------------------------------
// §11a Step 4b: Batch-size limiter
// ---------------------------------------------------------------------------

/**
 * Enforce the batch-size cap. Returns the capped set (at most `limit`) and
 * the overflow set with their batch position annotated.
 */
export function applyBatchLimit(
  findings: Finding[],
  limit: number = DEFAULT_BATCH_LIMIT,
): {
  batch: Finding[];
  overflow: Array<{ finding: Finding; batch_overflow_at: number }>;
} {
  const batch = findings.slice(0, limit);
  const overflow = findings.slice(limit).map((finding, i) => ({
    finding,
    batch_overflow_at: limit + 1 + i,
  }));
  return { batch, overflow };
}

// ---------------------------------------------------------------------------
// §3d / §11a Step 5: Production-DSN matcher
// ---------------------------------------------------------------------------

/**
 * Detect whether an acceptance_check string contains a production DSN pattern.
 * Returns true if the check must be deferred per the §3d production-safety rule.
 *
 * Patterns per spec §3d:
 * - PROD_DATABASE_URL
 * - *_PROD_* variable references
 * - postgresql:// / postgres:// DSNs with "prod" in the host or db name
 */
export function matchProductionDsn(acceptanceCheck: string): ProductionDsnMatchResult {
  const patterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /PROD_DATABASE_URL/i, name: 'PROD_DATABASE_URL' },
    { regex: /_PROD_/i, name: '_PROD_ variable' },
    { regex: /postgresql:\/\/[^"'\s]*prod[^"'\s]*/i, name: 'postgresql prod DSN' },
    { regex: /postgres:\/\/[^"'\s]*prod[^"'\s]*/i, name: 'postgres prod DSN' },
    { regex: /prod[-.].*\.internal/i, name: 'prod.internal host' },
    { regex: /prod-db\./i, name: 'prod-db. host' },
  ];

  for (const { regex, name } of patterns) {
    if (regex.test(acceptanceCheck)) {
      return { isProduction: true, matchedPattern: name };
    }
  }

  return { isProduction: false, matchedPattern: null };
}

// ---------------------------------------------------------------------------
// §11a Step 5: acceptance_check execution allowlist
// ---------------------------------------------------------------------------

/**
 * Binaries an acceptance_check command may start with. Note this is only the
 * FIRST gate — the command must also match one of the allowed COMMAND SHAPES
 * below. Binary-level allowlisting alone is an unsafe boundary: `git clean
 * -fdx`, `npx rimraf .`, and `npm exec rimraf .` all start with an
 * allowlisted binary yet mutate the working tree arbitrarily.
 */
export const ACCEPTANCE_CHECK_ALLOWED_BINARIES: ReadonlySet<string> = new Set([
  'npm',
  'npx',
  'vitest',
  'git',
]);

/** npm scripts an acceptance_check may run (`npm run <script>` only). */
export const ACCEPTANCE_CHECK_ALLOWED_NPM_SCRIPTS: ReadonlySet<string> = new Set([
  'lint',
  'typecheck',
  'build',
  'build:server',
  'build:client',
]);

/** Read-only git subcommands an acceptance_check may run. */
export const ACCEPTANCE_CHECK_ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff',
  'status',
  'rev-parse',
]);

/**
 * A test-file argument for `vitest run` / `tsx --test`: plain path token,
 * no leading dash (so no flags can smuggle behaviour in), path charset only.
 */
const ACCEPTANCE_CHECK_TEST_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * A git argument: revisions, ranges, paths, and plain `--flags`, but nothing
 * that can write. `--output(=…)` is explicitly rejected below because
 * `git diff --output=<file>` writes to disk.
 */
const ACCEPTANCE_CHECK_GIT_ARG_RE = /^[A-Za-z0-9._/^~:*=-]+$/;

/**
 * Shell metacharacters that must not appear ANYWHERE in an acceptance_check
 * command: backtick, $, (, ), ;, &, |, <, > — no substitution, chaining,
 * subshells, background jobs, or redirection. Quotes and backslash are also
 * rejected: the executor tokenises on whitespace and runs WITHOUT a shell,
 * so quoting has no meaning there and would reach the binary literally.
 */
const ACCEPTANCE_CHECK_SHELL_METACHARACTERS = [
  '`',
  '$',
  '(',
  ')',
  ';',
  '&',
  '|',
  '<',
  '>',
  "'",
  '"',
  '\\',
] as const;

/**
 * Control characters (C0 range + DEL) are rejected wholesale. Newline and CR
 * are shell command separators — `npm run lint\nrm -rf /tmp/x` passes a
 * leading-binary check yet a shell would execute the second line — and
 * NUL/escape sequences have no place in a verify command. Space is the only
 * permitted separator (tab is a control char and is rejected with the rest).
 */
const ACCEPTANCE_CHECK_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface AcceptanceCheckCommandResult {
  allowed: boolean;
  /** Human-readable rejection reason; null when allowed. */
  reason: string | null;
}

/**
 * Classify an acceptance_check command against the execution allowlist.
 *
 * acceptance_check is untrusted reviewer (model) output, so the command must
 * pass ALL of:
 *   1. no control characters (newline/CR are shell command separators; tab,
 *      NUL, ESC etc. are rejected with them);
 *   2. none of the shell metacharacters ` $ ( ) ; & | < > nor
 *      quotes/backslash; and
 *   3. an exact COMMAND-SHAPE match — not merely an allowlisted leading
 *      binary. Binary-level allowlisting is overbroad authorization:
 *      `git clean -fdx`, `git reset --hard`, `npx rimraf .`, `npm exec …`,
 *      and `node -e …` all pass a binary check while mutating the tree or
 *      executing arbitrary code. Allowed shapes:
 *        npm run <lint|typecheck|build|build:server|build:client>
 *        npx vitest run <test-path…>
 *        npx tsx --test <test-path…>
 *        vitest run <test-path…>
 *        git <diff|status|rev-parse> [safe args…]   (no --output)
 *
 * The executor (runAcceptanceCheck) additionally tokenises on whitespace and
 * runs the command via spawnSync WITHOUT a shell, so even a string that
 * slipped the classifier has no shell to abuse.
 *
 * This gate complements (does not replace) the production-DSN denylist in
 * matchProductionDsn, which the caller applies first as defence-in-depth.
 */
export function classifyAcceptanceCheckCommand(check: string): AcceptanceCheckCommandResult {
  const trimmed = check.trim();
  if (trimmed === '') {
    return { allowed: false, reason: 'empty acceptance_check command' };
  }

  if (ACCEPTANCE_CHECK_CONTROL_CHARS.test(check)) {
    return {
      allowed: false,
      reason:
        'control character (e.g. newline/CR/tab) is not allowed in ' +
        'acceptance_check — newlines are shell command separators',
    };
  }

  for (const meta of ACCEPTANCE_CHECK_SHELL_METACHARACTERS) {
    if (check.includes(meta)) {
      return {
        allowed: false,
        reason: `shell metacharacter "${meta}" is not allowed in acceptance_check`,
      };
    }
  }

  const tokens = trimmed.split(/\s+/);
  const binary = tokens[0];
  if (!ACCEPTANCE_CHECK_ALLOWED_BINARIES.has(binary)) {
    return {
      allowed: false,
      reason:
        `leading binary "${binary}" is not allowlisted ` +
        `(allowed: ${[...ACCEPTANCE_CHECK_ALLOWED_BINARIES].join(', ')})`,
    };
  }

  return classifyCommandShape(tokens);
}

/** Validate one or more test-path arguments (no flags, path charset only). */
function validateTestPaths(paths: string[], shape: string): AcceptanceCheckCommandResult {
  if (paths.length === 0) {
    return { allowed: false, reason: `${shape} requires at least one test-file path` };
  }
  for (const p of paths) {
    if (!ACCEPTANCE_CHECK_TEST_PATH_RE.test(p)) {
      return {
        allowed: false,
        reason: `"${p}" is not a plain test-file path (flags and non-path tokens are not allowed after ${shape})`,
      };
    }
  }
  return { allowed: true, reason: null };
}

/** Shape gate — see classifyAcceptanceCheckCommand doc for the allowed set. */
function classifyCommandShape(tokens: string[]): AcceptanceCheckCommandResult {
  const [binary, ...rest] = tokens;

  switch (binary) {
    case 'npm': {
      if (rest[0] !== 'run' || rest.length !== 2 || !ACCEPTANCE_CHECK_ALLOWED_NPM_SCRIPTS.has(rest[1])) {
        return {
          allowed: false,
          reason:
            'npm is allowed only as `npm run <script>` with script in ' +
            `{${[...ACCEPTANCE_CHECK_ALLOWED_NPM_SCRIPTS].join(', ')}} — ` +
            'npm exec / arbitrary scripts are not allowlisted',
        };
      }
      return { allowed: true, reason: null };
    }
    case 'npx': {
      if (rest[0] === 'vitest' && rest[1] === 'run') {
        return validateTestPaths(rest.slice(2), 'npx vitest run');
      }
      if (rest[0] === 'tsx' && rest[1] === '--test') {
        return validateTestPaths(rest.slice(2), 'npx tsx --test');
      }
      return {
        allowed: false,
        reason:
          'npx is allowed only as `npx vitest run <test-path…>` or ' +
          '`npx tsx --test <test-path…>` — arbitrary npx packages (rimraf, ' +
          'shx, …) are not allowlisted',
      };
    }
    case 'vitest': {
      if (rest[0] === 'run') {
        return validateTestPaths(rest.slice(1), 'vitest run');
      }
      return { allowed: false, reason: 'vitest is allowed only as `vitest run <test-path…>`' };
    }
    case 'git': {
      const sub = rest[0];
      if (!sub || !ACCEPTANCE_CHECK_ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
        return {
          allowed: false,
          reason:
            `git subcommand "${sub ?? ''}" is not allowlisted (read-only ` +
            `only: ${[...ACCEPTANCE_CHECK_ALLOWED_GIT_SUBCOMMANDS].join(', ')}) — ` +
            'clean/reset/checkout/config/push are never allowed',
        };
      }
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('--output')) {
          return { allowed: false, reason: '`git --output` writes to disk and is not allowed' };
        }
        if (!ACCEPTANCE_CHECK_GIT_ARG_RE.test(arg)) {
          return { allowed: false, reason: `git argument "${arg}" is not a safe revision/path/flag token` };
        }
      }
      return { allowed: true, reason: null };
    }
    default:
      // Unreachable: the binary gate above already filtered to the four cases.
      return { allowed: false, reason: `leading binary "${binary}" is not allowlisted` };
  }
}

// ---------------------------------------------------------------------------
// §11c: Suppression-store matcher
// ---------------------------------------------------------------------------

/**
 * Validate a suppression entry against the §11c mandatory-fields rule.
 * Returns null if valid, or an error message if invalid.
 */
export function validateSuppressionEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) {
    return 'entry is not an object';
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.suppression_id !== 'string' || !e.suppression_id) {
    return 'missing suppression_id';
  }
  if (typeof e.risk_domain !== 'string' || !e.risk_domain) {
    return 'missing risk_domain';
  }
  if (typeof e.applies_to_reviewer !== 'string' || !e.applies_to_reviewer) {
    return 'missing applies_to_reviewer';
  }
  if (typeof e.pattern !== 'string' || !e.pattern) {
    return 'missing pattern';
  }
  if (!['repo', 'build_slug', 'reviewer_mode'].includes(e.scope as string)) {
    return 'invalid scope (must be repo, build_slug, or reviewer_mode)';
  }
  if (!e.expires_after && !e.expires_at_build_count) {
    return 'missing expiry (expires_after or expires_at_build_count required)';
  }
  if (typeof e.created_from !== 'object' || e.created_from === null) {
    return 'missing created_from';
  }
  const cf = e.created_from as Record<string, unknown>;
  if (!cf.finding_id || !cf.review_log || !cf.operator_decision) {
    return 'created_from missing finding_id, review_log, or operator_decision';
  }
  if (!e.created_at) {
    return 'missing created_at';
  }

  // §11c: carve-out risk_domain values cannot be suppressed
  if (CARVE_OUT_RISK_DOMAINS.has(e.risk_domain as string)) {
    return `risk_domain "${e.risk_domain}" is a carve-out domain and cannot be suppressed`;
  }

  return null;
}

/**
 * Check whether a finding is suppressed by any active suppression entry.
 * Entries are pre-validated and pre-expired before this call.
 */
export function matchSuppression(
  finding: Finding,
  entries: SuppressionEntry[],
  buildSlug?: string,
): SuppressionMatchResult {
  for (const entry of entries) {
    // Scope filter
    if (entry.scope === 'build_slug' && entry.build_slug !== buildSlug) {
      continue;
    }

    // Reviewer filter (loose — coordinators pass 'all' to skip)
    if (entry.applies_to_reviewer !== 'all' && finding.auto_apply_reason !== undefined) {
      // We don't have the reviewer name on the finding; suppression by reviewer is
      // enforced at the suppressionStore level when loading.
    }

    // Risk domain filter: can only suppress non-carve-out findings
    if (entry.risk_domain !== finding.risk_domain && entry.risk_domain !== 'all') {
      continue;
    }

    // Pattern match: against title or rationale
    try {
      const regex = new RegExp(entry.pattern, 'i');
      if (regex.test(finding.title) || regex.test(finding.rationale ?? '')) {
        return { suppressed: true, suppression_id: entry.suppression_id };
      }
    } catch {
      // Invalid regex pattern in entry — treat as no-match (entry will be
      // flagged invalid by validateSuppressionEntry on next load)
    }
  }

  return { suppressed: false, suppression_id: null };
}

/**
 * Check whether a suppression entry has expired.
 * Returns true if the entry is still active (not expired).
 */
export function isSuppressionActive(
  entry: SuppressionEntry,
  currentDate: Date,
  buildsSinceCreated: number,
): boolean {
  if (entry.expires_at_build_count !== undefined) {
    if (buildsSinceCreated >= entry.expires_at_build_count) return false;
  }
  if (entry.expires_after && entry.expires_after !== 'never') {
    const expiryDate = new Date(entry.expires_after);
    if (!isNaN(expiryDate.getTime()) && currentDate >= expiryDate) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// §11b: Disagreement classifier
// ---------------------------------------------------------------------------

/**
 * Classify a disagreement between reviewers per the §11b case table.
 *
 * Cases:
 * - later_reviewer flags an applied finding → second_order_regression
 * - codex approves, openai flags critical/high → openai_wins_pending
 * - claude flags high, openai misses → keep_claude
 * - codex + openai both flag what claude missed → auto_elevate_severity
 */
export function classifyDisagreement(params: {
  earlier_reviewer: string;
  earlier_decision: string;
  later_reviewer: string;
  later_finding_severity?: string;
  codex_approved?: boolean;
  claude_flagged?: boolean;
  openai_missed?: boolean;
  all_flag_same_issue?: boolean;
}): DisagreementCase {
  const {
    earlier_decision,
    later_reviewer,
    later_finding_severity,
    codex_approved,
    claude_flagged,
    openai_missed,
    all_flag_same_issue,
  } = params;

  // Case: codex + openai both flag what claude missed
  if (all_flag_same_issue === true) {
    return 'auto_elevate_severity';
  }

  // Case: later reviewer flags an applied finding as a regression
  if (earlier_decision === 'applied') {
    return 'second_order_regression';
  }

  // Case: codex approves, openai flags critical/high
  if (
    codex_approved === true &&
    (later_reviewer.includes('openai') || later_reviewer.includes('chatgpt')) &&
    (later_finding_severity === 'critical' || later_finding_severity === 'high')
  ) {
    return 'openai_wins_pending';
  }

  // Case: claude flags high, openai misses it
  if (claude_flagged === true && openai_missed === true) {
    return 'keep_claude';
  }

  // Default: treat as second_order_regression
  return 'second_order_regression';
}

// ---------------------------------------------------------------------------
// Inline-apply detection (F2 R2)
// ---------------------------------------------------------------------------

/**
 * Determine whether a finding was applied inline by the reviewer.
 * When true, the coordinator verifies via acceptance_check but does NOT re-apply.
 */
export function isInlineApplied(finding: Finding): boolean {
  return finding.applied_inline_by_reviewer === true;
}

// ---------------------------------------------------------------------------
// Result-level versioning check (§11a Step 2)
// ---------------------------------------------------------------------------

export interface VersioningCheckResult {
  valid: boolean;
  reason: string | null;
}

export function checkResultVersioning(
  result: ReviewResult,
  expectedContractVersion: string,
  expectedSourceArtifactSha?: string,
): VersioningCheckResult {
  if (result.contract_version !== expectedContractVersion) {
    return {
      valid: false,
      reason: `contract_version mismatch: expected "${expectedContractVersion}", got "${result.contract_version}"`,
    };
  }
  if (
    expectedSourceArtifactSha !== undefined &&
    result.source_artifact_sha !== expectedSourceArtifactSha
  ) {
    return {
      valid: false,
      reason: `source_artifact_sha mismatch: expected "${expectedSourceArtifactSha}", got "${result.source_artifact_sha}"`,
    };
  }
  if (!result.prompt_version && !result.reviewer_version && !result.stitched_from) {
    return {
      valid: false,
      reason: 'missing prompt_version or reviewer_version (or stitched_from for coordinator records)',
    };
  }
  return { valid: true, reason: null };
}
