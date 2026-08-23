/**
 * review-preflightPure.ts
 *
 * Pure helpers for the review-tier preflight (spec §6 C3): parsing the status
 * block `scripts/review-preflight.sh` emits, and mapping each per-tier status
 * to the caller's defined action. Kept separate from the shell script so the
 * CALLER side is unit-testable — the spec requires caller-parser tests, not
 * probe tests alone, because "what does the coordinator do with FAIL" is where
 * the contract actually bites.
 *
 * Run via: npx tsx --test scripts/__tests__/review-preflight.test.ts
 */

/** Transport capabilities. NOT review tiers — see the naming note in §6 C3. */
export type Capability = 'codex' | 'openai-api';
export type TierStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'SKIPPED';

export const STATUS_VALUES: readonly TierStatus[] = ['PASS', 'FAIL', 'UNAVAILABLE', 'SKIPPED'];
export const BLOCK_PREFIX = 'REVIEW TIER PREFLIGHT:';

export interface PreflightResult {
  statuses: Record<string, TierStatus>;
  /** true when the block was absent or malformed (callers treat as UNAVAILABLE). */
  malformed: boolean;
}

/**
 * Parse the machine-readable status block out of the preflight's stdout.
 * Tolerates surrounding output; returns malformed:true when no well-formed
 * block is present. A block with an unrecognised status value is malformed —
 * silently coercing an unknown token would be exactly the fail-open the
 * preflight exists to prevent.
 */
export function parseStatusBlock(stdout: string): PreflightResult {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(BLOCK_PREFIX));
  if (!line) return { statuses: {}, malformed: true };

  const body = line.slice(line.indexOf(BLOCK_PREFIX) + BLOCK_PREFIX.length).trim();
  if (!body) return { statuses: {}, malformed: true };

  const statuses: Record<string, TierStatus> = {};
  for (const token of body.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    if (eq <= 0) return { statuses: {}, malformed: true };
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!(STATUS_VALUES as readonly string[]).includes(value)) return { statuses: {}, malformed: true };
    statuses[name] = value as TierStatus;
  }
  if (Object.keys(statuses).length === 0) return { statuses: {}, malformed: true };
  return { statuses, malformed: false };
}

export type Phase = 'step0' | 'jit';

export interface TierAction {
  capability: string;
  status: TierStatus;
  required: boolean;
  /**
   * proceed          — PASS, or a SKIPPED tier that is not required.
   * warn-and-continue— Step 0 forecast on a required red tier: record it in
   *                    progress.md AND surface it to the operator; the pipeline
   *                    continues (the forecast is advisory, never silent).
   * retry-then-fallback — just-in-time on a required red tier: one bounded
   *                    retry, then the coordinator's EXISTING per-tier fallback.
   *                    A COMPLETED fallback is not a gap.
   * contract-violation — SKIPPED on a REQUIRED tier: the preflight may only
   *                    skip tiers that are not required.
   */
  action: 'proceed' | 'warn-and-continue' | 'retry-then-fallback' | 'contract-violation';
}

/**
 * Resolve the caller's actions from a preflight invocation.
 *
 * Load-bearing rule (spec §6 C3, round-5 finding 4): a non-zero exit AND an
 * exit-0-with-unparseable-block are treated IDENTICALLY — UNAVAILABLE for every
 * required tier. A crashed preflight must never be softer than a failed probe.
 */
export function resolvePreflight(args: {
  exitCode: number;
  stdout: string;
  required: readonly string[];
  phase: Phase;
}): { statuses: Record<string, TierStatus>; degraded: boolean; actions: TierAction[] } {
  const required = [...new Set(args.required)];
  const parsed = parseStatusBlock(args.stdout);
  const degraded = args.exitCode !== 0 || parsed.malformed;

  const statuses: Record<string, TierStatus> = degraded ? {} : { ...parsed.statuses };
  if (degraded) for (const cap of required) statuses[cap] = 'UNAVAILABLE';

  const names = [...new Set([...Object.keys(statuses), ...required])];
  const actions: TierAction[] = names.map((capability) => {
    const status = statuses[capability] ?? 'UNAVAILABLE';
    const isRequired = required.includes(capability);
    let action: TierAction['action'];
    if (status === 'PASS') action = 'proceed';
    else if (status === 'SKIPPED') action = isRequired ? 'contract-violation' : 'proceed';
    else if (!isRequired) action = 'proceed';                       // red but not needed
    else action = args.phase === 'step0' ? 'warn-and-continue' : 'retry-then-fallback';
    return { capability, status, required: isRequired, action };
  });

  return { statuses, degraded, actions };
}

/**
 * Build the `--require` argument from the resolved task class and review mode.
 *
 * Both inputs are REQUIRED because the capability set is not knowable from the
 * class alone (round-4 finding 1): `openai-api` probes the Responses API, which
 * a manual ChatGPT-web review never touches, so requiring it in manual mode
 * would manufacture a gap that does not exist.
 */
export function buildRequiredTiers(args: {
  /** Standard+ paths run spec-reviewer / plan-reviewer / verify-phase — all Codex. */
  taskClass: 'Trivial' | 'Standard' | 'Significant' | 'Major';
  reviewMode: 'manual' | 'automated' | 'parallel';
  /** finalisation always needs Codex (verify-phase), regardless of class. */
  alwaysRequireCodex?: boolean;
}): Capability[] {
  const out: Capability[] = [];
  if (args.alwaysRequireCodex || args.taskClass !== 'Trivial') out.push('codex');
  if (args.reviewMode === 'automated' || args.reviewMode === 'parallel') out.push('openai-api');
  return out;
}
