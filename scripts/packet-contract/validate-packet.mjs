/**
 * validate-packet.mjs — the single validation contract for work-packet.v1 and
 * completion-packet.v1 (spec §12.A Chunk A2).
 *
 * WHY THIS EXISTS
 * A1 shipped schemas/work-packet.schema.json and schemas/completion-packet.schema.json
 * as the runtime-neutral dispatch/return contracts (FR-2, FR-3). This module is
 * the one place that checks an object against either schema, so every caller —
 * Claude Code dispatch, a future OpenClaw runtime, or a test fixture — agrees
 * on what "valid" means.
 *
 * Ajv is loaded dynamically and the module degrades to a structural floor when
 * it is unavailable, mirroring scripts/status/status-contract.mjs: the floor
 * checks `required` and `enum` (status) straight out of the schema JSON rather
 * than hand-duplicating the rules, so the two paths cannot silently drift.
 *
 * The floor only reaches TOP-LEVEL required/enum/const, which is why every
 * result also runs through validatePacketSemantics: the nested execution-policy
 * and release-evidence invariants are invisible to the floor, and a constraint
 * that holds only when a devDependency happens to be installed is not a
 * constraint. Both paths therefore reject the same malformed packets.
 *
 * `validatePacket` never throws — it returns `{ok, errors[], warnings[]}` so a
 * caller can report a malformed packet without a try/catch at every call site.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePacketSemantics } from './packet-semanticsPure.mjs';

const SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
);

const SCHEMA_PATH = {
  work: path.join(SCHEMA_DIR, 'work-packet.schema.json'),
  completion: path.join(SCHEMA_DIR, 'completion-packet.schema.json'),
};

const compiledValidators = { work: undefined, completion: undefined };

/** Compiled ajv validator for `kind`, or `false` when ajv is unavailable. */
async function getSchemaValidator(kind) {
  if (compiledValidators[kind] !== undefined) return compiledValidators[kind];
  try {
    const [{ default: Ajv }, formats] = await Promise.all([
      import('ajv'),
      import('ajv-formats').catch(() => ({ default: null })),
    ]);
    const schema = JSON.parse(await readFile(SCHEMA_PATH[kind], 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    if (formats.default) formats.default(ajv);
    compiledValidators[kind] = ajv.compile(schema);
  } catch {
    compiledValidators[kind] = false;
  }
  return compiledValidators[kind];
}

const cachedSchemas = { work: undefined, completion: undefined };

/** The parsed schema for `kind`, or null when it cannot be read or parsed. */
async function readSchema(kind) {
  if (cachedSchemas[kind] !== undefined) return cachedSchemas[kind];
  try {
    cachedSchemas[kind] = JSON.parse(await readFile(SCHEMA_PATH[kind], 'utf8'));
  } catch {
    cachedSchemas[kind] = false;
  }
  return cachedSchemas[kind] || null;
}

/** Structural floor: required-keys + enum, derived from the schema JSON. */
function checkAgainstFloor(value, schema) {
  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['packet must be a JSON object'];
  }

  const missing = (schema.required ?? []).filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing.length > 0) {
    errors.push(`missing required field(s): ${missing.join(', ')}`);
  }

  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(value[key])) {
      errors.push(`${key} must be one of ${propSchema.enum.join(', ')}`);
    }
    if (typeof propSchema.const === 'string' && value[key] !== propSchema.const) {
      errors.push(`${key} must equal ${JSON.stringify(propSchema.const)}`);
    }
  }

  return errors;
}

/**
 * Validates `obj` against the work-packet.v1 or completion-packet.v1 schema.
 *
 * Runs the structural check (Ajv when available, the derived floor otherwise)
 * and then the shared semantic layer, combining both error sets so the verdict
 * is identical in either mode.
 *
 * @param {'work'|'completion'} kind
 * @param {unknown} obj
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[]}>}
 */
export async function validatePacket(kind, obj) {
  if (kind !== 'work' && kind !== 'completion') {
    return { ok: false, errors: [`unknown packet kind: ${kind}`], warnings: [] };
  }

  const structuralErrors = await checkStructure(kind, obj);
  const { errors: semanticErrors, warnings } = validatePacketSemantics(kind, obj);
  const errors = [...structuralErrors, ...semanticErrors];
  return { ok: errors.length === 0, errors, warnings };
}

/** Ajv when it is installed, the schema-derived floor when it is not. */
async function checkStructure(kind, obj) {
  const validate = await getSchemaValidator(kind);
  if (validate) {
    if (validate(obj)) return [];
    const errors = (validate.errors ?? []).map(
      (err) => `${err.instancePath || '(root)'} ${err.message}`,
    );
    return errors.length > 0 ? errors : ['schema-invalid'];
  }

  const schema = await readSchema(kind);
  if (!schema) {
    return [`cannot read ${path.basename(SCHEMA_PATH[kind])} — unable to validate this packet`];
  }
  return checkAgainstFloor(obj, schema);
}
