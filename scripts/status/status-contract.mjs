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
 * already wrote a guard for, so the floor now reads `required`, `properties`
 * and `items` straight out of the schema JSON and enforces them generically.
 * Parsing JSON needs no dependency; only ajv's richer keywords are lost. That
 * makes the schema file itself a hard runtime requirement, which it already
 * was in practice: readStatusEnum() cannot resolve the board's columns without
 * it either.
 *
 * The floor implements: required, type (including the oneOf/anyOf nullable
 * shapes), enum, const, minLength, `format: date-time`, and one level of
 * recursion into arrays-of-objects (the `blockers[]` shape the card renderer
 * dereferences). It does NOT implement `additionalProperties: false`, which is
 * pinned as a known divergence in status-contract.test.mjs rather than left to
 * a reader's assumption; an unknown extra key cannot crash a renderer or
 * corrupt a write.
 *
 * `format` was ALSO pinned as an acceptable divergence for one round, on the
 * stated grounds that a malformed timestamp produced only a wrong-looking
 * card. That was wrong, and the pin encoded the error as intended behaviour
 * (external review round 6). See checkFormat below for the three board-sync
 * paths that read `updated_at` as load-bearing data. The lesson generalises:
 * a divergence pin asserts "this cannot hurt us", which is a claim about
 * every consumer of the field, and it needs the same verification as any
 * other such claim.
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

/** `const` and `enum` for one property. Returns an error string, or null.
 *
 *  These are VOCABULARY constraints, and leaving them out reopened the exact
 *  split-brain defect the board contract check was written to close (external
 *  review round 5). `status: "TESTNG"` is a string, so a types-only floor
 *  accepted it; board-sync has no status check of its own — unlike the
 *  generator, which tests membership of STATUS_PRIORITY — so the typo reached
 *  the board, the card body was written saying TESTNG, setFieldValues found no
 *  such option, warned, skipped the field, and the card disagreed with its own
 *  column. The same omission accepted `contract_version: "build-status.v1"`
 *  against a `const` of v2, i.e. a record written under a superseded contract.
 */
// RFC 3339 date-time. Deliberately stricter than Date.parse, which accepts a
// much broader set (bare '2026', '29 Jul 2026', and other Date-constructor
// forms) than JSON Schema's `date-time` permits. The trailing Date.parse check
// then rejects well-shaped but impossible values such as 2026-02-31.
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** `format: date-time`, including inside the oneOf nullable shapes.
 *
 *  NOT presentation-only, which is what the round-5 write-up wrongly claimed
 *  when it pinned this as an acceptable divergence (external review round 6).
 *  `updated_at` is load-bearing in three places, all verified in board-sync:
 *
 *   - shouldSkipStale compares timestamps as PLAIN STRINGS. A malformed value
 *     sorting high defeats stale-write protection: '2026-07-29T10:00:00Z' >
 *     'zzzz' is false, so an older record overwrites a newer card. A value
 *     sorting low does the reverse and suppresses legitimate updates.
 *   - chooseSurvivor orders duplicates by the same string comparison, so the
 *     malformed card wins survivor selection and the real one is archived.
 *   - shouldArchive computes `now - new Date(updated_at)`, which is NaN for a
 *     malformed value, and `NaN >= threshold` is false — so terminal cards
 *     never age out.
 *
 *  And the damage compounds: the bad value is written back into the card body,
 *  poisoning every subsequent comparison.
 */
function checkFormat(value, propSchema, at, key) {
  if (typeof value !== 'string') return null; // null branch of a nullable field

  // The keyword may sit on the property, or inside a oneOf/anyOf branch that
  // accepts strings — which is how every nullable timestamp in this schema is
  // declared (`cleared_at`, and any future sibling).
  const branches = [propSchema, ...(propSchema.oneOf ?? propSchema.anyOf ?? [])];
  const wantsDateTime = branches.some(
    (b) => b?.format === 'date-time' && (b.type === undefined || b.type === 'string')
  );
  if (!wantsDateTime) return null;

  if (!RFC3339_DATE_TIME.test(value) || !isRealCalendarDate(value)) {
    return `${at}${key} must be an RFC 3339 date-time`;
  }
  return null;
}

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

function checkVocabulary(value, propSchema, at, key) {
  const formatError = checkFormat(value, propSchema, at, key);
  if (formatError) return formatError;

  if (Object.prototype.hasOwnProperty.call(propSchema, 'const') && value !== propSchema.const) {
    return `${at}${key} must equal ${JSON.stringify(propSchema.const)}`;
  }
  // Object.is, not includes: NaN never equals itself under ===, and -0/+0
  // compare equal when they are distinct JSON-schema values.
  if (Array.isArray(propSchema.enum) && !propSchema.enum.some((c) => Object.is(c, value))) {
    return `${at}${key} must be one of ${propSchema.enum.join(', ')}`;
  }
  // minLength was the last divergence the Ajv-vs-floor agreement test found.
  // An empty blocker text is not a crash, but it renders as a blank bullet on
  // the card, and any gap between the two paths makes "which validator loaded"
  // a correctness variable.
  if (typeof propSchema.minLength === 'number' && typeof value === 'string'
      && value.length < propSchema.minLength) {
    return `${at}${key} must be at least ${propSchema.minLength} character(s)`;
  }
  return null;
}

/** Generic required-keys + declared-types + vocabulary check against a schema
 *  fragment. Returns an error string, or null. `at` prefixes the path. */
function checkAgainstFragment(value, fragment, at) {
  const missing = (fragment.required ?? []).filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key)
  );
  if (missing.length > 0) return `${at} missing required field(s): ${missing.join(', ')}`;

  for (const [key, propSchema] of Object.entries(fragment.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue; // absent and not required
    const types = permittedTypes(propSchema);
    if (types.length > 0 && !types.some((t) => matchesJsonType(value[key], t))) {
      return `${at}${key} must be ${types.join(' or ')}`;
    }

    const vocabularyError = checkVocabulary(value[key], propSchema, at, key);
    if (vocabularyError) return vocabularyError;

    // One level into arrays-of-objects. This is not general recursion: it is
    // exactly the `blockers[]` shape, whose elements the card renderer
    // dereferences and whose malformed elements were the reported crash.
    if (propSchema.type === 'array' && propSchema.items && Array.isArray(value[key])) {
      for (const [i, element] of value[key].entries()) {
        const itemTypes = permittedTypes(propSchema.items);
        if (itemTypes.length > 0 && !itemTypes.some((t) => matchesJsonType(element, t))) {
          return `${at}${key}[${i}] must be ${itemTypes.join(' or ')}`;
        }
        // An items fragment can carry enum/const directly (array-of-scalars),
        // as well as nested inside its own properties via the recursion below.
        const itemVocabularyError = checkVocabulary(element, propSchema.items, `${at}${key}`, `[${i}]`);
        if (itemVocabularyError) return itemVocabularyError;
        if (element !== null && typeof element === 'object') {
          const nested = checkAgainstFragment(element, propSchema.items, `${at}${key}[${i}].`);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

/**
 * Returns an error string for a malformed record, or null.
 *
 * Ajv when available; otherwise the schema-derived structural floor above.
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
  return checkAgainstFragment(data, schema, '');
}
