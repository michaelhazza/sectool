/**
 * execution-policyPure.mjs — normalization and canonical hashing for the
 * work-packet `execution_policy` contract (references/execution-policy.md).
 *
 * WHY THIS EXISTS
 * `execution_policy` is capability-REMOVING metadata, and a completion packet
 * echoes back the policy it believed it was bound by. If the dispatching
 * coordinator and the executing runtime each computed "the effective policy"
 * their own way, the echo would prove nothing — two producers could disagree
 * while both reporting success. This module is the single sanctioned
 * computation, so "same work packet" always means "same hash".
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No path matching, no checkout access, no glob library. The effective policy
 * is a CONJUNCTION OF CONSTRAINT LISTS, not a merged pattern set: glob
 * intersection is not computable over pattern strings (intersecting
 * `server/**` with `**\/*.test.ts` is "test files under server/", which no
 * string operation yields). Carrying the lists and evaluating the conjunction
 * per path keeps this function pure and checkout-independent.
 *
 * The hash therefore covers the normalized DECLARATIONS, never a resolved file
 * set. Two reasons: a coordinator must be able to recompute it from the work
 * packet alone to detect mutation, and a resolved set cannot express authority
 * over files that do not exist yet — which is most of what a builder writes.
 *
 * Enforcement (recompute-and-compare, expiry checks, symlink escape, matching
 * an actual path) belongs to the enforcement build and is out of scope here.
 */
import { createHash } from 'node:crypto';

/** Policy keys carried through normalization unchanged, in canonical order. */
const SCALAR_KEYS = [
  'destructive_actions',
  'credential_access',
  'network_egress',
  'deploy_authority',
  'expires_at',
];

/** Policy keys holding repo-relative path patterns. */
const PATH_LIST_KEYS = ['allowed_files', 'write_scope', 'protected_paths'];

/**
 * Normalizes one repo-relative path pattern.
 *
 * Lexical only — the filesystem is never consulted. Returns the normalized
 * pattern, or an error string naming why the pattern is unusable.
 *
 * @param {unknown} pattern
 * @returns {{value: string|null, error: string|null}}
 */
export function normalizePathPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { value: null, error: `pattern must be a non-empty string: ${JSON.stringify(pattern)}` };
  }
  if (pattern.includes('\\')) {
    return { value: null, error: `pattern must use forward slashes: ${pattern}` };
  }
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    return { value: null, error: `pattern must be repo-relative, not absolute: ${pattern}` };
  }

  // Collapse duplicate slashes and drop redundant leading/interior "./".
  const collapsed = pattern.replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  const segments = collapsed.split('/').filter((s) => s !== '.');
  if (segments.includes('..')) {
    return { value: null, error: `pattern must not traverse upward with "..": ${pattern}` };
  }

  const value = segments.join('/');
  if (value.length === 0) {
    return { value: null, error: `pattern normalizes to an empty path: ${pattern}` };
  }
  const syntax = patternSyntaxError(value);
  if (syntax) return { value: null, error: `${syntax}: ${pattern}` };

  return { value, error: null };
}

/**
 * Bounded syntax check for the pinned glob dialect (picomatch semantics with
 * dot:true, per references/execution-policy.md).
 *
 * Deliberately NOT a glob parser: the framework ships zero runtime
 * dependencies, and nothing in this build matches a pattern against a path.
 * This catches the unbalanced-delimiter class that would make a pattern mean
 * something different than its author intended; the enforcement build takes
 * the matcher dependency and gets full parsing with it.
 *
 * @param {string} pattern
 * @returns {string|null} error message, or null when the syntax is usable
 */
function patternSyntaxError(pattern) {
  for (const [open, close, name] of [
    ['[', ']', 'character class'],
    ['{', '}', 'brace expansion'],
    ['(', ')', 'group'],
  ]) {
    let depth = 0;
    for (const ch of pattern) {
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      if (depth < 0) return `unbalanced ${name} in pattern`;
    }
    if (depth !== 0) return `unbalanced ${name} in pattern`;
  }
  return null;
}

/** Sorted, de-duplicated copy — canonical order for hashing. */
function canonicalList(values) {
  return [...new Set(values)].sort();
}

/**
 * Canonical serialization of a normalized policy: sorted keys, sorted and
 * de-duplicated arrays, no whitespace, UTF-8 JSON. Key order in the source
 * object never changes the result, so neither does the hash.
 *
 * @param {Record<string, unknown>} policy
 * @returns {string}
 */
export function canonicalizePolicy(policy) {
  const canonical = {};
  for (const key of Object.keys(policy).sort()) {
    const value = policy[key];
    canonical[key] = Array.isArray(value) ? canonicalList(value) : value;
  }
  return JSON.stringify(canonical);
}

/**
 * Normalizes a work packet's declared policy into the self-contained effective
 * policy a completion packet echoes, plus its canonical hash.
 *
 * Returns `{normalized_policy: null, effective_policy_hash: null}` when the
 * packet declares neither `allowed_files` nor `execution_policy` — that is
 * "unspecified", which is NOT the same as "unrestricted"; see
 * references/execution-policy.md. Never throws: malformed input comes back as
 * `errors`, so a caller can report every problem at once.
 *
 * @param {unknown} workPacket
 * @returns {{normalized_policy: object|null, effective_policy_hash: string|null, errors: string[]}}
 */
export function normalizeExecutionPolicy(workPacket) {
  const empty = { normalized_policy: null, effective_policy_hash: null, errors: [] };
  if (workPacket === null || typeof workPacket !== 'object' || Array.isArray(workPacket)) {
    return { ...empty, errors: ['work packet must be a JSON object'] };
  }

  const declared = workPacket.execution_policy;
  const hasPolicy = declared !== undefined;
  if (hasPolicy && (declared === null || typeof declared !== 'object' || Array.isArray(declared))) {
    return { ...empty, errors: ['execution_policy must be a JSON object'] };
  }
  if (workPacket.allowed_files === undefined && !hasPolicy) return empty;

  const errors = [];
  const normalized = {};

  for (const key of PATH_LIST_KEYS) {
    const source = key === 'allowed_files' ? workPacket.allowed_files : declared?.[key];
    if (source === undefined) continue;
    if (!Array.isArray(source)) {
      errors.push(`${key} must be an array`);
      continue;
    }
    const patterns = [];
    for (const entry of source) {
      const { value, error } = normalizePathPattern(entry);
      if (error) errors.push(`${key}: ${error}`);
      else patterns.push(value);
    }
    // An empty array is meaningful ("nothing allowed") and is preserved as such.
    normalized[key] = canonicalList(patterns);
  }

  if (hasPolicy) {
    for (const key of SCALAR_KEYS) {
      if (declared[key] !== undefined) normalized[key] = declared[key];
    }
    if (declared.egress_allowlist !== undefined) {
      if (!Array.isArray(declared.egress_allowlist)) {
        errors.push('egress_allowlist must be an array');
      } else {
        normalized.egress_allowlist = canonicalList(
          declared.egress_allowlist.filter((h) => typeof h === 'string' && h.length > 0),
        );
        if (normalized.egress_allowlist.length !== declared.egress_allowlist.length) {
          errors.push('egress_allowlist entries must be non-empty strings');
        }
      }
    }
  }

  if (errors.length > 0) return { normalized_policy: null, effective_policy_hash: null, errors };
  if (Object.keys(normalized).length === 0) return empty;

  const canonical = canonicalizePolicy(normalized);
  return {
    normalized_policy: normalized,
    effective_policy_hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    errors: [],
  };
}
