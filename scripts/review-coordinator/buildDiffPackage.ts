/**
 * buildDiffPackage.ts
 *
 * I/O wrapper around buildDiffPackagePure.ts.
 *
 * Calls resolveBaseRef(), runs git diff <baseRef>...HEAD --name-only
 * to get the changed file list, reads each file's diff content, then
 * calls the pure helper to build the focused diff package.
 *
 * The caller (coordinator) inspects the returned omittedAlwaysIncluded
 * list and surfaces NEEDS_DISCUSSION per §3c rule 2 when it is non-empty.
 */

import { execSync, spawnSync } from 'node:child_process';
import { resolveBaseRef } from './resolveBaseRef.js';
import {
  buildFocusedDiffPackage,
  type ArchitectureExcerpt,
  type ChangedFile,
  type DiffPackage,
} from './buildDiffPackagePure.js';

/**
 * Run a command and return stdout trimmed, or throw on failure.
 */
function runGit(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf-8' }).trim();
}

/**
 * Read the full diff for a single file against the base ref.
 */
function getFileDiff(filePath: string, baseRef: string): string {
  // spawnSync with array args avoids shell interpretation of filePath — a
  // path containing quotes or shell metacharacters cannot break out of the
  // argument (same rationale as sync.js getSubmoduleCommit).
  const result = spawnSync('git', ['diff', `${baseRef}...HEAD`, '--', filePath], {
    encoding: 'utf-8',
  });
  if (result.error || result.status !== 0) return '';
  return result.stdout ?? '';
}

/**
 * Build the focused diff package for the current branch.
 *
 * @param arch - architecture excerpt from PROJECT_CONTEXT
 * @param repoRoot - absolute path to the repo root (defaults to process.cwd())
 * @returns DiffPackage (manifest + diff + omittedAlwaysIncluded)
 * @throws when git diff fails or cannot resolve base ref after all fallbacks
 */
export function buildDiffPackage(arch: ArchitectureExcerpt): DiffPackage {
  const baseRef = resolveBaseRef();

  // Get the list of changed files
  let changedFilesRaw: string;
  try {
    changedFilesRaw = runGit(`diff ${baseRef}...HEAD --name-only`);
  } catch (err) {
    throw new Error(
      `cannot_resolve_base_ref: git diff failed with base ref '${baseRef}': ${String(err)}`,
      { cause: err },
    );
  }

  const changedPaths = changedFilesRaw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Read each file's diff content and measure size
  const changedFiles: ChangedFile[] = changedPaths.map((filePath) => {
    const diffContent = getFileDiff(filePath, baseRef);
    const sizeBytes = Buffer.byteLength(diffContent, 'utf-8');
    return { path: filePath, diffContent, sizeBytes };
  });

  return buildFocusedDiffPackage(changedFiles, arch, baseRef);
}
