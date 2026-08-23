/**
 * status-contract.mjs — the single reader-side contract for status.json.
 *
 * WHY THIS EXISTS
 * `generate-current-focus.mjs` validated records against
 * schemas/build-status.schema.json; `board-sync.mjs` checked only that the JSON
 * parsed and the slug matched its directory. So the two consumers of the same
 * file could disagree: the generator would classify a record INVALID and refuse
 * to render it while board-sync happily published it to a card. Worse, a
 * malformed record reaching board-sync surfaced as a "gh failure" — a
 * misleading diagnosis pointing at GitHub for a defect in local data.
 * (External review round 3.)
 *
 * Both readers now share this module, so "valid" means one thing.
 *
 * Ajv is loaded dynamically and the module degrades to a structural floor when
 * it is unavailable: these scripts are stdlib-only by design so they can run in
 * a bare consumer checkout, and a hard dependency would trade a real capability
 * for a validation nicety.
 *
 * THE FLOOR IS DERIVED FROM THE SCHEMA, NOT HAND-WRITTEN (external review round
 * 4). The first version listed six checks by hand and claimed to cover "the
 * dereferences the renderers actually perform". It did not: it checked that
 * `blockers` was an array but never the shape of its elements, so
 * `blockers: [null]` passed the floor and then threw on `blocker.cleared_at`
 * inside buildCardBody — which the per-record catch reported as a "gh failure",
 * pointing the operator at GitHub for a defect in local data. It also missed
 * `title`, `branch` and `pr`, all of which the card renderer dereferences.
 *
 * A hand-maintained mirror of a schema is the exact drift class this build
 * already wrote a guard for, so the floor now reads the schema JSON and walks
 * it generically. Parsing JSON needs no dependency; only ajv's richer keywords
 * are lost. That makes the schema file itself a hard runtime requirement, which
 * it already was in practice: readStatusEnum() cannot resolve the board's
 * columns without it either.
 *
 * THE FLOOR IS NOW GENUINELY RECURSIVE (framework-status-sync-hardening, W2.1).
 * The prior version recursed exactly one level, into arrays-of-objects (the
 * `blockers[]` shape), and never descended into a schema-valued
 * `additionalProperties` — which is precisely how `gate_evidence` entries are
 * typed. Consequence: in bare-consumer mode
 * `gate_evidence.merge_gate.run_ids: [32310798762]` (a number where the schema
 * demands string items) PASSED the floor, and a schema-invalid load-bearing
 * record advanced silently — the exact D2 defect that stranded a card during
 * the PR #828 finalisation. The floor now implements, at any depth: `required`,
 * `type` (including the `oneOf`/`anyOf` nullable shapes), `enum`, `const`,
 * `format: date-time`, `minLength`, `maxLength`, `pattern`, `minItems`,
 * `maxItems`, nested-object `properties`, schema-valued `additionalProperties`,
 * and `additionalProperties: false`. It does NOT implement the keywords this
 * schema never uses (`allOf`, `if/then`, `$ref`, numeric bounds); introducing
 * one of those to the schema without teaching the floor would be caught by the
 * Ajv-vs-floor agreement test in status-contract.test.mjs, which is the guard
 * that keeps the two paths from silently diverging.
 *
 * enum and const are not optional niceties here (external review round 5).
 * board-sync has no status check of its own, unlike the generator, so a
 * types-only floor let `status: "TESTNG"` through to the board: the card body
 * was written saying TESTNG, setFieldValues found no such option, warned,
 * skipped the field, and the card disagreed with its own column -- reopening
 * the exact split-brain defect checkBoardContract exists to prevent.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'build-status.schema.json'
);

let compiledValidator = null;

/** Compiled ajv validator, or `false` when ajv/the schema are unavailable. */
export async function getSchemaValidator() {
  if (compiledValidator !== null) return compiledValidator;
  try {
    const [{ default: Ajv }, formats] = await Promise.all([
      import('ajv'),
      import('ajv-formats').catch(() => ({ default: null })),
    ]);
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: false, strict: false });
    if (formats.default) formats.default(ajv);
    compiledValidator = ajv.compile(schema);
  } catch {
    compiledValidator = false;
  }
  return compiledValidator;
}

let cachedSchema = null;

/** The parsed schema, or null when it cannot be read or parsed. */
async function readSchema() {
  if (cachedSchema !== null) return cachedSchema;
  try {
    cachedSchema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  } catch {
    cachedSchema = false;
  }
  return cachedSchema || null;
}

/** The status enum from the schema, or null when the schema cannot be read. */
export async function readStatusEnum() {
  const schema = await readSchema();
  return schema?.properties?.status?.enum ?? null;
}

/** JSON Schema's `type` semantics, which differ from typeof for null and arrays. */
function matchesJsonType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    // JSON Schema's `object` excludes null and arrays; plain typeof does not.
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true; // unknown keyword — do not invent a constraint
  }
}

/** The type names a property definition permits, flattening the `oneOf` shapes
 *  the schema uses for nullable fields (`pr`, `blocker.cleared_at`). */
function permittedTypes(propSchema) {
  if (!propSchema) return [];
  if (typeof propSchema.type === 'string') return [propSchema.type];
  if (Array.isArray(propSchema.type)) return propSchema.type;
  const branches = propSchema.oneOf ?? propSchema.anyOf;
  if (Array.isArray(branches)) return branches.flatMap(permittedTypes);
  return [];
}

// RFC 3339 date-time. Deliberately stricter than Date.parse, which accepts a
// much broader set (bare '2026', '29 Jul 2026', and other Date-constructor
// forms) than JSON Schema's `date-time` permits. The time-of-day and offset
// ranges are bounded (hour 00-23, minute 00-59, second 00-60 for a leap
// second, offset hour 00-23) so the floor rejects the same out-of-range values
// ajv-formats does — an unbounded `\d{2}` accepted `T00:75:00Z`, which Ajv
// rejects, reopening the floor-vs-Ajv divergence W2.1 exists to close. The
// trailing calendar check then rejects well-shaped but impossible DATES such as
// 2026-02-31.
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** True when the Y-M-D of an RFC 3339 string is a date that actually exists.
 *  Date.parse alone is not enough: it silently ROLLS OVER, so '2026-02-31'
 *  becomes 3 March and parses finite. ajv-formats rejects it, so accepting it
 *  here would put the two validation paths back out of step. */
function isRealCalendarDate(value) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isFinite(asUtc.getTime())
    && asUtc.getUTCFullYear() === year
    && asUtc.getUTCMonth() === month - 1
    && asUtc.getUTCDate() === day
  );
}

/** A human-readable label for a JSON path. Root is '' so a root-level message
 *  reads " missing required field(s): …" exactly as the prior floor did. */
function label(jsonPath) {
  return jsonPath;
}

function joinPath(jsonPath, key) {
  return jsonPath === '' ? key : `${jsonPath}.${key}`;
}

/**
 * Generic recursive validator for the JSON Schema keyword subset this schema
 * uses. Returns the FIRST error string found (paths dotted, array indices
 * bracketed), or null when the value satisfies the fragment.
 *
 * WHY date-time / minLength / etc. live here and not in a per-property helper:
 * a nullable field declares `format: date-time` inside a `oneOf` branch
 * (`cleared_at`), and a schema-valued `additionalProperties` (`gate_evidence`
 * entries) declares `run_ids.items.type` two levels down — both are only
 * reachable by walking the schema recursively, so every keyword is evaluated on
 * the node it sits on, wherever that node is.
 */
function validateAgainstSchema(value, schema, jsonPath) {
  if (!schema || typeof schema !== 'object') return null;

  // oneOf / anyOf — the value is valid when it satisfies at least one branch.
  // This is how every nullable field in the schema is declared, and it must be
  // evaluated fully (including each branch's `format`) rather than reduced to a
  // union of permitted types, or a malformed timestamp in a nullable field
  // would slip through.
  const branches = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      if (validateAgainstSchema(value, branch, jsonPath) === null) return null;
    }
    const allowed = permittedTypes(schema);
    return `${label(jsonPath)} must be ${allowed.length ? allowed.join(' or ') : 'a permitted shape'}`;
  }

  // type
  const types = permittedTypes(schema);
  if (types.length > 0 && !types.some((t) => matchesJsonType(value, t))) {
    return `${label(jsonPath)} must be ${types.join(' or ')}`;
  }

  // const / enum — VOCABULARY constraints. Object.is, not ===/includes: NaN
  // never equals itself under ===, and -0/+0 compare equal when they are
  // distinct JSON-schema values.
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(value, schema.const)) {
    return `${label(jsonPath)} must equal ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((c) => Object.is(c, value))) {
    return `${label(jsonPath)} must be one of ${schema.enum.join(', ')}`;
  }

  // string keywords
  if (typeof value === 'string') {
    if (schema.format === 'date-time'
        && (!RFC3339_DATE_TIME.test(value) || !isRealCalendarDate(value))) {
      return `${label(jsonPath)} must be an RFC 3339 date-time`;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${label(jsonPath)} must be at least ${schema.minLength} character(s)`;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${label(jsonPath)} must be at most ${schema.maxLength} character(s)`;
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      return `${label(jsonPath)} must match pattern ${schema.pattern}`;
    }
  }

  // array keywords + element recursion
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${label(jsonPath)} must have at least ${schema.minItems} item(s)`;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${label(jsonPath)} must have at most ${schema.maxItems} item(s)`;
    }
    if (schema.items) {
      for (const [i, element] of value.entries()) {
        const err = validateAgainstSchema(element, schema.items, `${jsonPath}[${i}]`);
        if (err) return err;
      }
    }
  }

  // object keywords: required, properties, additionalProperties
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const missing = (schema.required ?? []).filter(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    );
    if (missing.length > 0) {
      return `${label(jsonPath)} missing required field(s): ${missing.join(', ')}`;
    }

    const properties = schema.properties ?? {};
    const additional = schema.additionalProperties;
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const err = validateAgainstSchema(child, properties[key], joinPath(jsonPath, key));
        if (err) return err;
      } else if (additional === false) {
        return `${joinPath(jsonPath, key)} is not a permitted field`;
      } else if (additional && typeof additional === 'object') {
        const err = validateAgainstSchema(child, additional, joinPath(jsonPath, key));
        if (err) return err;
      }
      // additionalProperties true / undefined → the extra key is allowed.
    }
  }

  return null;
}

/**
 * Returns an error string for a malformed record, or null.
 *
 * Ajv when available; otherwise the schema-derived recursive floor above.
 * A missing or unparseable schema is an ERROR, not a pass: without it neither
 * path can say what a valid record is, and returning null there would mean
 * "valid" — silently disabling the check this module exists to perform.
 */
export async function validateRecordShape(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'record must be a JSON object';
  }

  const validate = await getSchemaValidator();
  if (validate) {
    if (validate(data)) return null;
    const err = validate.errors?.[0];
    return `schema-invalid: ${err ? `${err.instancePath || '(root)'} ${err.message}` : 'unknown validation error'}`;
  }

  const schema = await readSchema();
  if (!schema) {
    return `cannot read ${path.basename(SCHEMA_PATH)} — unable to validate this record. `
      + 'The schema ships with the framework; a missing or unparseable copy means a broken sync, not an optional file.';
  }
  return validateAgainstSchema(data, schema, '');
}
