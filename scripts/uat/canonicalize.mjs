/**
 * canonicalize.mjs — RFC 8785 (JSON Canonicalization Scheme, JCS) serialization
 * plus SHA-256 digest helpers, shared by the whole UAT acceptance gate.
 *
 * WHY THIS FILE IS THE SINGLE SOURCE OF CANONICALISATION
 * Every hash the gate relies on — blind-plan digest, per-scenario digest,
 * input-manifest digest, harness-manifest digest, evidence_sha256 — must be
 * computed the SAME way by three independent producers: the snapshot builder,
 * the deterministic validator, and the fresh Codex executor. "Just call
 * JSON.stringify" is not sufficient: key order, Unicode escaping, and numeric
 * representation are all implementation-dependent in plain stringify and would
 * fork the digest between a Node producer and a Codex/Python producer. RFC 8785
 * pins all three. This module is the one implementation; callers import it and
 * never re-derive canonicalisation.
 *
 * Pinned algorithm (plan §A6, round-4 finding 7): RFC 8785 / JCS.
 *   - Object property names sorted by UTF-16 code units (JS default string
 *     comparison — the same ordering RFC 8785 §3.2.3 mandates).
 *   - Primitives serialized via ES `JSON.stringify` (ECMAScript Number-to-String
 *     for numbers, minimal-escape for strings) — the exact forms JCS requires.
 *   - No insignificant whitespace.
 *   - Non-finite numbers (NaN/Infinity) and undefined/function values are
 *     REJECTED — JCS forbids them, and silently coercing to null would fork a
 *     digest against a stricter implementation.
 *
 * A digest is ALWAYS computed over the canonical form of the object with its own
 * digest field removed (a document cannot contain its own hash). `digestOf`
 * takes the field name(s) to strip so this rule is never left to the caller.
 */

import { createHash } from 'node:crypto';

/**
 * Produce the RFC 8785 canonical string for a JSON value.
 * @param {*} value — a JSON-compatible value (object/array/string/number/boolean/null)
 * @returns {string} the canonical serialization
 */
export function canonicalize(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number is not valid JCS (${value})`);
    }
    // JSON.stringify emits the ECMAScript Number-to-String form JCS mandates,
    // including -0 -> "0" and >=1e21 -> exponential.
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new Error('canonicalize: bigint is not valid JSON/JCS');
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serialize).join(',') + ']';
  }
  if (t === 'object') {
    // UTF-16 code-unit ordering === JS default string sort === RFC 8785 §3.2.3.
    const keys = Object.keys(value).sort(compareCodeUnits);
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined || typeof v === 'function') {
        // JSON.stringify silently drops these; JCS has no representation for
        // them. Reject loudly rather than fork a digest by omission.
        throw new Error(`canonicalize: unserializable property value at key "${k}" (${typeof v})`);
      }
      parts.push(JSON.stringify(k) + ':' + serialize(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalize: unserializable value of type ${t}`);
}

function compareCodeUnits(a, b) {
  // Explicit UTF-16 code-unit comparison. JS's default `<` on strings already
  // does this; spelled out so the ordering contract is visible and stable.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * SHA-256 hex digest of a UTF-8 string or Buffer.
 * @param {string|Buffer} input
 * @returns {string} lowercase hex
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical SHA-256 of a JSON value: sha256 over its RFC 8785 canonical string.
 * @param {*} value
 * @returns {string} lowercase hex
 */
export function canonicalSha256(value) {
  return sha256Hex(Buffer.from(canonicalize(value), 'utf8'));
}

/**
 * Digest of an object with one or more of its own fields excluded — the pinned
 * "a document never contains its own hash" rule. Excluded keys are removed at
 * the TOP LEVEL only (a scenario's `digest` field, a plan's whole-document
 * digest field), matching the plan's contract that a scenario digest is over
 * the canonical scenario "excluding its own digest field".
 * @param {object} obj
 * @param {string[]} excludeKeys — top-level keys to strip before hashing
 * @returns {string} lowercase hex
 */
export function digestOf(obj, excludeKeys = []) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('digestOf: expects a plain object');
  }
  if (excludeKeys.length === 0) return canonicalSha256(obj);
  const stripped = {};
  const exclude = new Set(excludeKeys);
  for (const k of Object.keys(obj)) {
    if (!exclude.has(k)) stripped[k] = obj[k];
  }
  return canonicalSha256(stripped);
}
