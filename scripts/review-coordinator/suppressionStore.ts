/**
 * suppressionStore.ts
 *
 * I/O for the false-positive suppression store (§11c).
 *
 * Reads from:
 *  - .claude-framework/suppressions/*.json  (framework defaults)
 *  - tasks/review-suppressions/*.json       (per-repo overrides)
 *
 * Per F10 R1: missing directories return [] (no suppressions), never throw.
 * Invalid entries are skipped with a stderr warning — they never silently
 * silence a finding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  validateSuppressionEntry,
  isSuppressionActive,
  type SuppressionEntry,
} from './applyFindingsPure.js';

export interface SuppressionStoreOptions {
  projectRoot: string;
  buildSlug?: string;
  reviewer?: string;
  currentDate?: Date;
  /** Number of builds since the consuming repo started using the framework. */
  buildCount?: number;
}

/**
 * Read all active suppression entries from the two store locations.
 * Missing directories are silently treated as empty stores (per F10 R1).
 * Malformed or expired entries are skipped.
 */
export function readSuppressions(options: SuppressionStoreOptions): SuppressionEntry[] {
  const { projectRoot, buildSlug, reviewer, currentDate = new Date(), buildCount = 0 } = options;

  const frameworkDir = resolve(projectRoot, '.claude-framework/suppressions');
  const repoDir = resolve(projectRoot, 'tasks/review-suppressions');

  const entries: SuppressionEntry[] = [];

  for (const dir of [frameworkDir, repoDir]) {
    entries.push(...loadFromDirectory(dir, currentDate, buildCount));
  }

  return filterByContext(entries, buildSlug, reviewer);
}

/**
 * Load and validate suppression entries from a single directory.
 * Returns [] if the directory does not exist or cannot be read.
 */
function loadFromDirectory(
  dir: string,
  currentDate: Date,
  buildCount: number,
): SuppressionEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    // Directory absent or unreadable — per F10 R1 return empty list, never throw
    return [];
  }

  const entries: SuppressionEntry[] = [];

  for (const file of files) {
    const filePath = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `[suppressionStore] warning: could not read ${filePath}: ${String(err)}\n`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `[suppressionStore] warning: invalid JSON in ${filePath}: ${String(err)}\n`,
      );
      continue;
    }

    // Support both a single object and an array of objects in one file
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const candidate of candidates) {
      const validationError = validateSuppressionEntry(candidate);
      if (validationError !== null) {
        process.stderr.write(
          `[suppressionStore] warning: invalid suppression entry in ${filePath}: ${validationError}\n`,
        );
        continue;
      }

      const entry = candidate as SuppressionEntry;
      const buildsSinceCreated = entry.builds_since_created ?? buildCount;

      if (!isSuppressionActive(entry, currentDate, buildsSinceCreated)) {
        // Expired — skip silently
        continue;
      }

      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Filter active entries to only those applicable to the current build/reviewer context.
 */
function filterByContext(
  entries: SuppressionEntry[],
  buildSlug?: string,
  reviewer?: string,
): SuppressionEntry[] {
  return entries.filter((entry) => {
    if (entry.scope === 'build_slug') {
      if (buildSlug === undefined || entry.build_slug !== buildSlug) return false;
    }
    if (entry.scope === 'reviewer_mode') {
      if (reviewer === undefined || entry.applies_to_reviewer !== reviewer) return false;
    }
    return true;
  });
}

/**
 * Validate and (if valid) write a new suppression entry to the per-repo store.
 * Returns the error message if validation fails.
 *
 * Repo-wide entries (scope: 'repo') require repo_wide_confirmed: true to be set
 * on the entry before calling this function; callers are responsible for
 * surfacing the confirmation prompt to the operator.
 */
export async function writeSuppressionEntry(
  entry: SuppressionEntry,
  projectRoot: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const validationError = validateSuppressionEntry(entry);
  if (validationError !== null) {
    return { success: false, error: validationError };
  }

  if (entry.scope === 'repo' && entry.repo_wide_confirmed !== true) {
    return {
      success: false,
      error: 'repo-wide suppressions require repo_wide_confirmed: true (present a confirmation prompt to the operator first)',
    };
  }

  const storeDir = resolve(projectRoot, 'tasks/review-suppressions');

  try {
    const { mkdirSync: mkDir, writeFileSync: writeFile } = await import('node:fs');
    mkDir(storeDir, { recursive: true });
    const filePath = join(storeDir, `${entry.suppression_id}.json`);
    writeFile(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
