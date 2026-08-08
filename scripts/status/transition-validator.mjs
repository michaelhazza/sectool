/**
 * transition-validator.mjs — writer-side legal-transition check for
 * tasks/builds/<slug>/status.json's `status` field (FR-5).
 *
 * WHY THIS EXISTS
 * schemas/build-status.schema.json validates one status.json document in
 * isolation and cannot express cross-write rules (previous->next legality,
 * terminal immutability, blocker-gated back-edges). That $comment named this
 * module as a deferred hardening, built the first time a bad transition is
 * observed in any repo.
 *
 * CONTRACT
 * `validateTransition(from, to, opts)` is PURE and NEVER THROWS. It returns
 * `{ok: true}` for a legal transition, or `{ok: false, error}` for an
 * illegal one or an unknown status name. On `{ok: false}` the CALLER must
 * leave the prior state unchanged (fail closed) -- this module only judges,
 * it does not write.
 *
 * IDEMPOTENT SELF-TRANSITIONS (PR-003): `from === to` is always `{ok: true}`
 * when `from` is a known status, including for terminal states -- re-writing
 * MERGED as MERGED is a harmless no-op re-stamp, not an outbound edge, so it
 * is exempt from the terminal-immutability rule below. An unknown status is
 * still rejected even when `from === to`.
 *
 * The legal status vocabulary is read from schemas/build-status.schema.json
 * via readStatusEnum() (status-contract.mjs), never hardcoded here, so this
 * module cannot drift from the schema enum -- the same anti-drift discipline
 * status-vocabulary.test.mjs enforces on prose.
 *
 * TRANSITION GRAPH (source: build-status.schema.json properties.status
 * $comment, cross-checked against schemas/CHANGELOG.md)
 *   Forward path (each state legal only to its immediate successor):
 *     SPECIFYING -> PLANNING -> BUILDING -> REVIEWING -> TESTING
 *       -> FINALISING -> MERGE_READY -> MERGED
 *   ABANDONED is reachable from any non-terminal state.
 *   Blocker-gated back-edges (legal ONLY when opts.hasBlocker === true):
 *     MERGE_READY -> FINALISING  (the label-pull CI fix loop)
 *     FINALISING  -> TESTING     (a doc/review finding needing a code change)
 *     TESTING     -> BUILDING    (a failing test that is a product defect)
 *     REVIEWING   -> BUILDING    (review findings)
 *   MERGED and ABANDONED are terminal: no outbound transition from either.
 */
import { readStatusEnum } from './status-contract.mjs';

const FORWARD_EDGES = {
  SPECIFYING: 'PLANNING',
  PLANNING: 'BUILDING',
  BUILDING: 'REVIEWING',
  REVIEWING: 'TESTING',
  TESTING: 'FINALISING',
  FINALISING: 'MERGE_READY',
  MERGE_READY: 'MERGED',
};

const TERMINAL_STATUSES = new Set(['MERGED', 'ABANDONED']);

const BLOCKER_GATED_BACK_EDGES = new Set([
  'MERGE_READY->FINALISING',
  'FINALISING->TESTING',
  'TESTING->BUILDING',
  'REVIEWING->BUILDING',
]);

/**
 * Judges one status transition against the graph above.
 *
 * @param {string} from - current status.
 * @param {string} to - proposed status.
 * @param {{hasBlocker?: boolean}} [opts] - hasBlocker gates the back-edges.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function validateTransition(from, to, opts = {}) {
  const hasBlocker = opts.hasBlocker === true;

  const enum_ = await readStatusEnum();
  if (!enum_) {
    return { ok: false, error: 'cannot read the status enum from the schema — unable to validate this transition' };
  }

  if (!enum_.includes(from)) {
    return { ok: false, error: `unknown status "${from}" — not in the schema enum` };
  }
  if (!enum_.includes(to)) {
    return { ok: false, error: `unknown status "${to}" — not in the schema enum` };
  }

  if (from === to) {
    return { ok: true };
  }

  if (TERMINAL_STATUSES.has(from)) {
    return { ok: false, error: `"${from}" is terminal — no outbound transition is legal` };
  }

  if (to === 'ABANDONED') {
    return { ok: true };
  }

  if (FORWARD_EDGES[from] === to) {
    return { ok: true };
  }

  const edgeKey = `${from}->${to}`;
  if (BLOCKER_GATED_BACK_EDGES.has(edgeKey)) {
    if (hasBlocker) return { ok: true };
    return { ok: false, error: `"${edgeKey}" is a blocker-gated back-edge and requires an open blocker (opts.hasBlocker)` };
  }

  return { ok: false, error: `"${from}" -> "${to}" is not a legal transition` };
}
