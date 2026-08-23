/**
 * enforcement.mjs — the §10 enforcement matrix and refusal rows 9-10 as
 * EXECUTABLE POLICY (fresh-context-uat-gate plan §10, R2.2/R2.4). The
 * finalisation coordinator and acceptance-phase are prose playbooks; this module
 * is the machine-checkable model of the transitions they must follow, so the
 * matrix is tested rather than merely described.
 *
 * `enforcement` is the SINGLE downstream control (round-4 finding 3): everything
 * keys on it, never on the raw rollout mode or the raw verdict.
 */

export const ROLLOUT_MODES = ['disabled', 'shadow', 'high-risk', 'default'];

// Risk tags that GRADUATE to blocking under `high-risk` mode (§10): UI+DB,
// money, auth/authz, migration, external-provider, async-state, major
// cross-system. Ungraduated applicable risks still run, with advisory enforcement.
export const GRADUATED_HIGH_RISK_TAGS = new Set([
  'ui-browser',
  'money-precision',
  'auth-tenant',
  'database-route-migration',
  'external-provider',
  'async-state-retry',
]);

/**
 * Derive whether the gate runs and, if so, the enforcement level.
 * Absent/unknown rollout mode = disabled (plan A9).
 * @param {{rolloutMode?: string, riskTags?: string[]}} p
 * @returns {{run: boolean, enforcement: ('advisory'|'blocking'|null)}}
 */
export function deriveEnforcement({ rolloutMode, riskTags = [] } = {}) {
  const mode = rolloutMode || 'disabled';
  if (mode === 'disabled' || !ROLLOUT_MODES.includes(mode)) return { run: false, enforcement: null };
  if (mode === 'shadow') return { run: true, enforcement: 'advisory' };
  if (mode === 'default') return { run: true, enforcement: 'blocking' };
  // high-risk: blocking iff a graduated risk tag is present; else advisory.
  const graduated = riskTags.some((t) => GRADUATED_HIGH_RISK_TAGS.has(t));
  return { run: true, enforcement: graduated ? 'blocking' : 'advisory' };
}

/** Monotonic escalation: enforcement only ever advisory -> blocking, never back. */
export function escalate(current, next) {
  if (current === 'blocking' || next === 'blocking') return 'blocking';
  return 'advisory';
}

/**
 * The §10 transition for a (enforcement, verdict) pair.
 * @returns {{action: ('continue'|'back-edge'|'halt'|'record-advisory'), writesBlocker: boolean, advisory: boolean}}
 */
export function pipelineAction({ enforcement, verdict }) {
  const isPassLike = verdict === 'pass' || verdict === 'proceed';
  if (isPassLike) return { action: 'continue', writesBlocker: false, advisory: false };
  if (enforcement === 'advisory') {
    // fail/incomplete under advisory: recorded + surfaced, never machine-blocking.
    return { action: 'record-advisory', writesBlocker: false, advisory: true };
  }
  // blocking:
  if (verdict === 'fail') return { action: 'back-edge', writesBlocker: true, advisory: false };
  if (verdict === 'incomplete') return { action: 'halt', writesBlocker: false, advisory: false };
  return { action: 'halt', writesBlocker: false, advisory: false };
}

/** Strict up-to-date base freshness is required ONLY under blocking (round-7 finding 1). */
export function baseFreshnessRequired(enforcement) {
  return enforcement === 'blocking';
}

/**
 * Refusal Row 9 — enforcement + verdict together, plus hard override rejection.
 * A present override field ALWAYS refuses (no override ships). Under advisory,
 * any schema-valid verdict passes the row (fail/incomplete surface elsewhere).
 * @returns {boolean} true = row passes (merge may proceed past this row)
 */
export function row9Passes({ enforcement, verdict, hasOverrideField = false }) {
  if (hasOverrideField) return false;
  if (enforcement === 'blocking') return verdict === 'pass' || verdict === 'proceed';
  return true; // advisory (or disabled/inert)
}

/**
 * Refusal Row 10 — head identity + evidence binding + staleness (always), and
 * strict-protection base freshness ONLY under blocking.
 * @param {{enforcement: string, evidenceBound: boolean, staleTail: boolean, hasStrictProtection: boolean, headMatches: boolean}} p
 * @returns {boolean} true = row passes
 */
export function row10Passes({ enforcement, evidenceBound, staleTail, hasStrictProtection, headMatches }) {
  if (!evidenceBound) return false;      // evidence_sha256 must match — regardless of enforcement
  if (staleTail) return false;           // no application/harness change in the tail — regardless
  if (headMatches === false) return false; // expected-remote-head precondition (always)
  if (baseFreshnessRequired(enforcement)) {
    return hasStrictProtection === true; // four-fact strict protection, blocking only
  }
  return true; // advisory: strict protection is telemetry, never a refusal
}
