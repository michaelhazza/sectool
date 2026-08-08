/**
 * packet-semanticsPure.mjs — bounded semantic checks layered on top of packet
 * schema validation.
 *
 * WHY THIS EXISTS
 * validate-packet.mjs degrades to a structural floor when Ajv is unavailable,
 * and that floor only reads top-level `required`, `enum` and `const` out of the
 * schema JSON. It cannot see nested objects, `additionalProperties`,
 * `minProperties`, array constraints, formats, or draft-07 conditionals — so
 * every invariant added for `execution_policy` would be enforced with Ajv and
 * silently ignored without it. A security-shaped constraint that holds only on
 * machines with a devDependency installed is not a constraint.
 *
 * This module is deliberately NOT a JSON Schema reimplementation. It hand-codes
 * the specific invariants this contract cannot afford to lose, and nothing
 * else. The schemas keep their conditionals (Ajv users get better messages);
 * this layer is what keeps fallback mode honest.
 *
 * The enum constants below are duplicated from the schema files by hand.
 * validate-packet.test.mjs asserts they still match the schemas, so the
 * duplication cannot drift silently.
 */
import { normalizeExecutionPolicy } from './execution-policyPure.mjs';

/** Nested policy enums, mirrored from the packet schemas. */
export const POLICY_ENUMS = {
  destructive_actions: ['forbidden', 'require_approval'],
  credential_access: ['none', 'read'],
  network_egress: ['none', 'allowlist'],
};

/** Policy keys holding repo-relative pattern lists. */
export const POLICY_PATH_KEYS = ['allowed_files', 'write_scope', 'protected_paths'];

/**
 * Every key a work packet's `execution_policy` may carry, mirrored from the
 * schema's `properties`. `effective_policy` additionally permits
 * `allowed_files` (folded in so the echo is self-contained).
 *
 * Needed because `additionalProperties: false` lives in the schema, which the
 * structural floor never reads: without this list, a fallback-mode packet
 * could smuggle an undeclared key past validation — precisely the
 * authority-shaped hole this layer exists to close.
 */
export const POLICY_KEYS = [
  'write_scope',
  'protected_paths',
  'destructive_actions',
  'credential_access',
  'network_egress',
  'egress_allowlist',
  'deploy_authority',
  'expires_at',
];

/** Every key `release_evidence` may carry, mirrored from the schema. */
export const RELEASE_EVIDENCE_KEYS = ['release_control_id', 'canary_result', 'evidence_paths'];

/** Release-evidence enum, mirrored from completion-packet.schema.json. */
export const CANARY_RESULTS = ['pass', 'fail', 'not_run'];

/**
 * Schema paths whose value-level constraints (`items.minLength`, `uniqueItems`,
 * `minLength`, `pattern`, `format`) this layer re-implements, so they hold with
 * and without Ajv.
 *
 * The coverage test in validate-packet.test.mjs walks both schemas, collects
 * every constrained path, and fails if one is missing from here or from
 * FLOOR_UNCOVERED_LEGACY_PATHS. Two review rounds each found a different field
 * with an unmirrored constraint; this list is what turns the third occurrence
 * into a build failure rather than a fourth review round.
 */
export const SEMANTICALLY_COVERED_PATHS = [
  'work:execution_policy.write_scope',
  'work:execution_policy.protected_paths',
  'work:execution_policy.egress_allowlist',
  'work:execution_policy.expires_at',
  'completion:<executionPolicy>.allowed_files',
  'completion:<executionPolicy>.write_scope',
  'completion:<executionPolicy>.protected_paths',
  'completion:<executionPolicy>.egress_allowlist',
  'completion:<executionPolicy>.expires_at',
  'completion:effective_policy_hash',
  'completion:policy_violations',
  'completion:changed_docs',
  'completion:doc_exemption_reason',
  'completion:release_evidence.release_control_id',
  'completion:release_evidence.evidence_paths',
];

/**
 * Pre-existing fields whose value constraints the floor has never enforced.
 *
 * NOT introduced by the execution-policy work and deliberately left alone —
 * closing them is a behaviour change to contracts consumers already emit, and
 * belongs in its own change with its own migration note. Listed explicitly so
 * the coverage test cannot pass by accident, and so the gap is inventoried
 * rather than merely unnoticed.
 */
export const FLOOR_UNCOVERED_LEGACY_PATHS = [
  'work:packet_id',
  'work:initiative_id',
  'work:feature_slug',
  'work:repo',
  'work:branch',
  'work:objective',
  'work:governing_artefacts',
  'work:allowed_files',
  'work:allowed_resources',
  'work:dependencies',
  'work:verification_commands',
  'work:output_locations',
  'work:prohibited_actions',
  'work:resume_id',
  'work:role',
  'work:runtime',
  'completion:packet_id',
  'completion:role',
  'completion:runtime',
  'completion:changed_files',
  'completion:spec_sections',
  'completion:summary',
  'completion:findings',
  'completion:unresolved_risks',
  'completion:produced_artefacts',
  'completion:did_not_touch',
];

/** Strict RFC 3339 date-time: full date, full time, mandatory offset. */
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** Days per month, with February resolved against the proleptic Gregorian leap rule. */
function daysInMonth(year, month) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return lengths[month - 1];
}

/**
 * True for a strict RFC 3339 date-time.
 *
 * `Date.parse` is NOT usable here: it accepts a date-only `2026-01-01`, a
 * timezone-less `2026-08-03T12:00:00`, and silently rolls `2026-02-31` into
 * March — all of which `ajv-formats` rejects. Using it would mean the same
 * packet is valid or invalid depending on whether a devDependency happens to
 * be installed, which is the divergence this layer exists to prevent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  if (Number(hour) > 23 || Number(minute) > 59) return false;
  // 60 is a legal leap second under RFC 3339 §5.6.
  if (Number(second) > 60) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

/**
 * Path prefixes and suffixes that count as documentation for the advisory
 * doc-impact check. Generated indexes and machine-written regions do not
 * count — only hand-authored prose.
 */
const DOC_PREFIXES = ['docs/', 'references/', 'tasks/'];
const DOC_SUFFIXES = ['.md', '.mdx', '.rst'];

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** True when a changed-file path is hand-authored documentation. */
function isDocPath(file) {
  if (typeof file !== 'string') return false;
  return (
    DOC_PREFIXES.some((p) => file.startsWith(p)) ||
    DOC_SUFFIXES.some((s) => file.endsWith(s))
  );
}

/** True for a plain (non-array, non-null) object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mirrors the schemas' `items: {type: string, minLength: 1}` plus
 * `uniqueItems: true` for an optional array field.
 *
 * The floor sees none of that — array CONTENTS are invisible to it — so a
 * `["", 42, "dup", "dup"]` would validate without Ajv while failing with it.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{unique?: boolean}} options
 * @returns {string[]}
 */
function nonEmptyStringArrayErrors(value, label, { unique = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${label} must be an array`];

  const errors = [];
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    errors.push(`${label} entries must be non-empty strings`);
  }
  if (unique && new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicate entries`);
  }
  return errors;
}

/** Mirrors a schema `{type: string, minLength: 1}` for an optional scalar. */
function nonEmptyStringErrors(value, label) {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.length === 0) {
    return [`${label} must be a non-empty string`];
  }
  return [];
}

/**
 * Invariants shared by work-packet `execution_policy` and completion-packet
 * `effective_policy`.
 *
 * @param {unknown} policy
 * @param {string} label field name, used in error text
 * @param {{allowAllowedFiles: boolean}} options
 * @returns {string[]}
 */
function policyErrors(policy, label, { allowAllowedFiles }) {
  if (!isPlainObject(policy)) return [`${label} must be a JSON object`];

  const errors = [];
  if (Object.keys(policy).length === 0) {
    errors.push(`${label} must declare at least one constraint (a bare {} is indistinguishable from an authoring mistake)`);
  }

  // Closed key set. The schema says additionalProperties: false, but the
  // structural floor never reads it, so without this an undeclared key —
  // including one a future consumer might read as an authority grant — would
  // pass in fallback mode while failing under Ajv.
  const allowedKeys = allowAllowedFiles ? ['allowed_files', ...POLICY_KEYS] : POLICY_KEYS;
  const unknown = Object.keys(policy).filter((k) => !allowedKeys.includes(k));
  if (unknown.length > 0) {
    errors.push(`${label} has undeclared field(s): ${unknown.sort().join(', ')}`);
  }

  if (!allowAllowedFiles && policy.allowed_files !== undefined) {
    errors.push(
      `${label} must not carry allowed_files — the work packet's top-level allowed_files is authoritative`,
    );
  }

  for (const [key, allowed] of Object.entries(POLICY_ENUMS)) {
    if (policy[key] !== undefined && !allowed.includes(policy[key])) {
      errors.push(`${label}.${key} must be one of ${allowed.join(', ')}`);
    }
  }

  // A policy can withhold deploy authority; it can never confer it.
  if (policy.deploy_authority !== undefined && policy.deploy_authority !== false) {
    errors.push(`${label}.deploy_authority must be false — a policy cannot grant deploy authority`);
  }

  const hasAllowlist = policy.egress_allowlist !== undefined;
  const allowlistMode = policy.network_egress === 'allowlist';
  if (allowlistMode && (!Array.isArray(policy.egress_allowlist) || policy.egress_allowlist.length === 0)) {
    errors.push(`${label}.egress_allowlist must be a non-empty array when network_egress is allowlist`);
  }
  if (hasAllowlist && !allowlistMode) {
    errors.push(`${label}.egress_allowlist requires network_egress: allowlist`);
  }

  for (const key of POLICY_PATH_KEYS) {
    errors.push(...nonEmptyStringArrayErrors(policy[key], `${label}.${key}`));
  }
  errors.push(...nonEmptyStringArrayErrors(policy.egress_allowlist, `${label}.egress_allowlist`));

  if (policy.expires_at !== undefined && !isRfc3339DateTime(policy.expires_at)) {
    errors.push(
      `${label}.expires_at must be an RFC 3339 date-time with a timezone offset (e.g. 2026-08-03T12:00:00Z)`,
    );
  }

  // Pattern-level normalization errors (absolute paths, "..", unbalanced globs).
  const probe = allowAllowedFiles
    ? { allowed_files: policy.allowed_files, execution_policy: policy }
    : { execution_policy: policy };
  for (const error of normalizeExecutionPolicy(probe).errors) {
    errors.push(`${label}: ${error}`);
  }

  return errors;
}

/**
 * Semantic checks for one packet. Never throws.
 *
 * `errors` block validation; `warnings` are advisory and reported without
 * failing the packet.
 *
 * @param {'work'|'completion'} kind
 * @param {unknown} packet
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePacketSemantics(kind, packet) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(packet)) return { errors, warnings };

  if (kind === 'work' && packet.execution_policy !== undefined) {
    errors.push(...policyErrors(packet.execution_policy, 'execution_policy', { allowAllowedFiles: false }));
  }

  if (kind === 'completion') {
    if (packet.effective_policy !== undefined) {
      errors.push(...policyErrors(packet.effective_policy, 'effective_policy', { allowAllowedFiles: true }));
    }
    if (packet.effective_policy_hash !== undefined) {
      if (typeof packet.effective_policy_hash !== 'string' || !SHA256_HEX.test(packet.effective_policy_hash)) {
        errors.push('effective_policy_hash must be a lowercase hex SHA-256 digest');
      }
    }
    const violations = packet.policy_violations;
    errors.push(...nonEmptyStringArrayErrors(violations, 'policy_violations'));
    if (violations !== undefined && !Array.isArray(violations)) {
      // Shape already reported above; skip the contradiction checks.
    } else {
      const listed = Array.isArray(violations) ? violations : [];
      // Checked against the field being ABSENT as well as empty: claiming a
      // violation while listing none is the same contradiction either way.
      if (packet.policy_evaluation === 'violated' && listed.length === 0) {
        errors.push('policy_evaluation is violated but no policy_violations are listed');
      }
      if (listed.length > 0 && packet.policy_evaluation !== undefined && packet.policy_evaluation !== 'violated') {
        errors.push(
          `policy_violations is non-empty but policy_evaluation is ${packet.policy_evaluation} — report violated`,
        );
      }
    }

    errors.push(...releaseEvidenceErrors(packet.release_evidence));
    const doc = documentationImpact(packet);
    errors.push(...doc.errors);
    warnings.push(...doc.warnings);
  }

  return { errors, warnings };
}

/**
 * `release_evidence` invariants. A `pass`/`fail` canary must point at the
 * evidence behind the claim; `not_run` needs nothing.
 *
 * @param {unknown} evidence
 * @returns {string[]}
 */
function releaseEvidenceErrors(evidence) {
  if (evidence === undefined) return [];
  if (!isPlainObject(evidence)) return ['release_evidence must be a JSON object'];

  const errors = [];
  if (Object.keys(evidence).length === 0) {
    errors.push('release_evidence must carry at least one field rather than an empty object');
  }
  const unknown = Object.keys(evidence).filter((k) => !RELEASE_EVIDENCE_KEYS.includes(k));
  if (unknown.length > 0) {
    errors.push(`release_evidence has undeclared field(s): ${unknown.sort().join(', ')}`);
  }
  errors.push(...nonEmptyStringErrors(evidence.release_control_id, 'release_evidence.release_control_id'));
  errors.push(...nonEmptyStringArrayErrors(evidence.evidence_paths, 'release_evidence.evidence_paths'));
  if (evidence.canary_result !== undefined && !CANARY_RESULTS.includes(evidence.canary_result)) {
    errors.push(`release_evidence.canary_result must be one of ${CANARY_RESULTS.join(', ')}`);
  }
  if (evidence.canary_result === 'pass' || evidence.canary_result === 'fail') {
    if (!Array.isArray(evidence.evidence_paths) || evidence.evidence_paths.length === 0) {
      errors.push(
        `release_evidence.evidence_paths must be non-empty when canary_result is ${evidence.canary_result}`,
      );
    }
  }
  return errors;
}

/**
 * Documentation-impact convention (.claude/agents/builder.md).
 *
 * The subset rule is an ERROR because it is a factual contradiction inside one
 * packet. The missing-exemption rule is a WARNING: documentation judgement is
 * not mechanically decidable, and a hard failure here would make an optional
 * field effectively mandatory for every code change.
 *
 * @param {Record<string, unknown>} packet
 * @returns {{errors: string[], warnings: string[]}}
 */
function documentationImpact(packet) {
  const errors = [];
  const warnings = [];
  const impact = packet.documentation_impact;
  const changedDocs = packet.changed_docs;
  const changedFiles = Array.isArray(packet.changed_files) ? packet.changed_files : null;

  errors.push(...nonEmptyStringArrayErrors(changedDocs, 'changed_docs'));
  errors.push(...nonEmptyStringErrors(packet.doc_exemption_reason, 'doc_exemption_reason'));
  if (changedDocs !== undefined && !Array.isArray(changedDocs)) {
    return { errors, warnings };
  }

  if (Array.isArray(changedDocs) && changedFiles) {
    const known = new Set(changedFiles);
    const orphans = changedDocs.filter((d) => !known.has(d));
    if (orphans.length > 0) {
      errors.push(`changed_docs must be a subset of changed_files; not listed: ${orphans.join(', ')}`);
    }
  }

  if (impact !== undefined && impact !== 'none') {
    if (!Array.isArray(changedDocs) || changedDocs.length === 0) {
      errors.push(`documentation_impact is ${impact} but changed_docs is empty`);
    }
  }

  if (impact === 'none' && changedFiles) {
    const codeChanged = changedFiles.some((f) => !isDocPath(f));
    if (codeChanged && packet.doc_exemption_reason === undefined) {
      warnings.push(
        'documentation_impact is none while non-doc files changed — state a doc_exemption_reason',
      );
    }
  }

  return { errors, warnings };
}
