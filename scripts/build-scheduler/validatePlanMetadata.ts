/**
 * validatePlanMetadata.ts
 *
 * Plan-metadata contract: parse + validate chunk metadata blocks.
 *
 * Public contract:
 *   parsePlanMetadata(raw)      — single snake→camel normalisation point.
 *   validatePlanMetadata(chunks) — structural validator; NEVER throws.
 *
 * Path canonicalisation contract (round-2 HIGH):
 *   parsePlanMetadata canonicalises EVERY declared_files entry:
 *     - replaces \ → /
 *     - collapses // → /
 *     - resolves . segments
 *     - rejects absolute paths, .. segments, and empty strings (→ ValidationError)
 *     - de-duplicates within a chunk after normalisation
 *     - case-folded canonical form used for intersection; original casing preserved for display
 *
 * This module does NOT implement wave logic (see computeWaves.ts).
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RawChunkMetadata {
  id?: string;
  specSections?: string[];
  declaredFiles?: string[];   // required, non-empty
  dependsOn?: string[];       // required, may be empty array
  exclusiveResources?: string[]; // optional
}

export interface ValidationError {
  chunkId: string | '<unknown>';
  field: string;
  message: string;
}

export interface ValidatePlanResult {
  ok: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal: error-message formatting
// ---------------------------------------------------------------------------

/**
 * Formats an arbitrary value for inclusion in a ValidationError message without
 * ever throwing. `JSON.stringify` throws on BigInt and on circular references;
 * this module's parse/validate functions are contractually NEVER-throws, so all
 * value interpolation in error messages MUST route through here.
 */
function safeStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    // JSON.stringify returns undefined for functions/symbols/undefined.
    return out ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ---------------------------------------------------------------------------
// Internal: path canonicalisation
// ---------------------------------------------------------------------------

/**
 * Canonicalises a single declared_files path entry.
 * Returns the normalised path, or null if the path is invalid (caller emits error).
 */
function canonicalisePath(raw: string): { canonical: string; caseFolded: string } | null {
  if (raw === '') return null;

  // Replace backslashes with forward slashes (Windows path separators).
  const p = raw.replace(/\\/g, '/');

  // Reject absolute paths (Unix: leading /, Windows: drive letter C:/).
  if (/^\//.test(p) || /^[a-zA-Z]:/.test(p)) return null;

  // Reject paths containing .. segments.
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
  }

  // Resolve . segments (keep non-. segments only).
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '') continue; // handles // via split
    resolved.push(seg);
  }

  const canonical = resolved.join('/');

  // After resolution, if empty (e.g. was just './' or '') — reject.
  if (canonical === '') return null;

  return { canonical, caseFolded: canonical.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an array of raw (snake_case) chunk metadata objects into camelCase
 * RawChunkMetadata[]. This is the SINGLE normalisation point for snake→camel
 * key mapping. Also canonicalises every declared_files path entry.
 *
 * Invalid paths are surfaced as ValidationError objects in the returned tuple.
 * This function NEVER throws.
 */
export function parsePlanMetadata(
  raw: unknown,
): { chunks: RawChunkMetadata[]; pathErrors: ValidationError[] } {
  const chunks: RawChunkMetadata[] = [];
  const pathErrors: ValidationError[] = [];

  if (!Array.isArray(raw)) {
    pathErrors.push({
      chunkId: '<unknown>',
      field: 'metadata',
      message: 'plan metadata must be an array',
    });
    return { chunks, pathErrors };
  }

  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      pathErrors.push({
        chunkId: '<unknown>',
        field: 'metadata',
        message: `chunk metadata block must be an object: ${safeStringify(item)}`,
      });
      continue;
    }

    const rec = item as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;
    const chunkId: string | '<unknown>' = id ?? '<unknown>';

    // snake_case → camelCase mapping.
    const specSections = Array.isArray(rec['spec_sections'])
      ? (rec['spec_sections'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : Array.isArray(rec['specSections'])
        ? (rec['specSections'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;

    // depends_on: collect string entries; surface non-string entries as errors
    // rather than silently dropping them. A dropped dependency edge is a safety
    // hole — the chunk would be scheduled concurrently with one it depends on.
    // A scalar (non-array) value is also an error — fail closed, not silently.
    const rawDependsOn = rec['depends_on'] ?? rec['dependsOn'];
    let dependsOn: string[] | undefined;
    if (Array.isArray(rawDependsOn)) {
      const kept: string[] = [];
      for (const entry of rawDependsOn as unknown[]) {
        if (typeof entry === 'string') {
          kept.push(entry);
        } else {
          pathErrors.push({
            chunkId,
            field: 'dependsOn',
            message: `depends_on entry is not a string: ${safeStringify(entry)}`,
          });
        }
      }
      dependsOn = kept;
    } else if (rawDependsOn !== undefined) {
      pathErrors.push({
        chunkId,
        field: 'dependsOn',
        message: `depends_on must be a list, got: ${safeStringify(rawDependsOn)}`,
      });
    }

    // exclusive_resources: same treatment — non-string entries are errors, not
    // silently erased, so a malformed singleton claim cannot weaken serialisation.
    // A scalar (non-array) value is also an error — fail closed, not silently.
    const rawExclusiveResources = rec['exclusive_resources'] ?? rec['exclusiveResources'];
    let exclusiveResources: string[] | undefined;
    if (Array.isArray(rawExclusiveResources)) {
      const kept: string[] = [];
      for (const entry of rawExclusiveResources as unknown[]) {
        if (typeof entry === 'string') {
          kept.push(entry);
        } else {
          pathErrors.push({
            chunkId,
            field: 'exclusiveResources',
            message: `exclusive_resources entry is not a string: ${safeStringify(entry)}`,
          });
        }
      }
      exclusiveResources = kept;
    } else if (rawExclusiveResources !== undefined) {
      pathErrors.push({
        chunkId,
        field: 'exclusiveResources',
        message: `exclusive_resources must be a list, got: ${safeStringify(rawExclusiveResources)}`,
      });
    }

    // Canonicalise declared_files entries.
    const rawDeclaredFiles = rec['declared_files'] ?? rec['declaredFiles'];
    let declaredFiles: string[] | undefined;

    if (Array.isArray(rawDeclaredFiles)) {
      const seen = new Set<string>(); // case-folded for de-dup
      const canonicalised: string[] = [];

      for (const entry of rawDeclaredFiles as unknown[]) {
        if (typeof entry !== 'string') {
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: `declared_files entry is not a string: ${safeStringify(entry)}`,
          });
          continue;
        }

        if (entry === '') {
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: 'declared_files entry is an empty string',
          });
          continue;
        }

        const result = canonicalisePath(entry);
        if (result === null) {
          // Determine specific rejection reason for the error message.
          let reason = 'invalid path';
          const forwardSlashed = entry.replace(/\\/g, '/');
          if (/^\//.test(forwardSlashed) || /^[a-zA-Z]:/.test(forwardSlashed)) {
            reason = 'absolute paths are not permitted';
          } else if (forwardSlashed.split('/').includes('..')) {
            reason = '".." segments are not permitted';
          } else if (entry === '' || forwardSlashed.replace(/\//g, '') === '') {
            reason = 'empty path after normalisation';
          }
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: `declared_files entry rejected (${reason}): ${entry}`,
          });
          continue;
        }

        // De-duplicate by case-folded canonical form.
        if (!seen.has(result.caseFolded)) {
          seen.add(result.caseFolded);
          canonicalised.push(result.canonical);
        }
      }

      declaredFiles = canonicalised;
    } else if (rawDeclaredFiles !== undefined) {
      pathErrors.push({
        chunkId,
        field: 'declaredFiles',
        message: `declared_files must be a list, got: ${safeStringify(rawDeclaredFiles)}`,
      });
    }

    chunks.push({
      id,
      specSections,
      declaredFiles,
      dependsOn,
      exclusiveResources,
    });
  }

  return { chunks, pathErrors };
}

/**
 * Validates an array of RawChunkMetadata (already camelCase, paths canonicalised).
 * Returns a ValidatePlanResult. NEVER throws — all errors are returned as structured
 * ValidationError objects. Accepts `unknown` input and narrows at runtime so callers
 * cannot cause a throw by passing a non-array or a null/non-object element.
 */
export function validatePlanMetadata(chunks: unknown): ValidatePlanResult {
  const errors: ValidationError[] = [];

  if (!Array.isArray(chunks)) {
    return {
      ok: false,
      errors: [{ chunkId: '<unknown>', field: 'metadata', message: 'plan metadata must be an array' }],
    };
  }

  const knownIds = new Set<string>();
  const seenIds = new Set<string>();

  // Collect all ids first (needed for dangling-dep check).
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) {
      // Non-object element — skip id collection; will be reported in the main loop.
      continue;
    }
    const c = chunk as RawChunkMetadata;
    if (typeof c.id === 'string' && c.id !== '') {
      knownIds.add(c.id);
    }
  }

  for (const rawChunk of chunks) {
    if (rawChunk === null || typeof rawChunk !== 'object' || Array.isArray(rawChunk)) {
      errors.push({
        chunkId: '<unknown>',
        field: 'metadata',
        message: `chunk metadata block must be an object: ${safeStringify(rawChunk)}`,
      });
      continue;
    }

    const chunk = rawChunk as RawChunkMetadata;
    const chunkId: string | '<unknown>' = typeof chunk.id === 'string' && chunk.id !== ''
      ? chunk.id
      : '<unknown>';

    // id: required, non-empty. The scheduler (computeWaves) and the merge-back
    // loop key on it; a missing id cannot be scheduled deterministically.
    if (chunkId === '<unknown>') {
      errors.push({
        chunkId,
        field: 'id',
        message: 'id is required but missing or empty',
      });
    }

    // Duplicate id check.
    if (chunkId !== '<unknown>') {
      if (seenIds.has(chunk.id as string)) {
        errors.push({
          chunkId,
          field: 'id',
          message: `duplicate chunk id: "${chunk.id}"`,
        });
      } else {
        seenIds.add(chunk.id as string);
      }
    }

    // declaredFiles: required, non-empty.
    if (!Array.isArray(chunk.declaredFiles)) {
      errors.push({
        chunkId,
        field: 'declaredFiles',
        message: 'declaredFiles is required but missing',
      });
    } else if (chunk.declaredFiles.length === 0) {
      errors.push({
        chunkId,
        field: 'declaredFiles',
        message: 'declaredFiles must not be empty',
      });
    }

    // dependsOn: required (empty array is OK).
    if (!Array.isArray(chunk.dependsOn)) {
      errors.push({
        chunkId,
        field: 'dependsOn',
        message: 'dependsOn is required but missing',
      });
    } else {
      // Dangling dependency id check.
      for (const depId of chunk.dependsOn) {
        if (!knownIds.has(depId)) {
          errors.push({
            chunkId,
            field: 'dependsOn',
            message: `depends_on references unknown chunk id: "${depId}"`,
          });
        }
      }
    }

    // exclusiveResources: if present, must be an array of non-empty strings.
    if (chunk.exclusiveResources !== undefined) {
      if (!Array.isArray(chunk.exclusiveResources)) {
        errors.push({
          chunkId,
          field: 'exclusiveResources',
          message: 'exclusiveResources must be an array when present',
        });
      } else {
        for (const res of chunk.exclusiveResources) {
          if (typeof res !== 'string' || res === '') {
            errors.push({
              chunkId,
              field: 'exclusiveResources',
              message: `exclusiveResources entry must be a non-empty string: ${safeStringify(res)}`,
            });
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
