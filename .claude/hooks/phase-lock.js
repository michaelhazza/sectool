#!/usr/bin/env node
/**
 * PreToolUse hook: phase-lock
 *
 * Enforces the allowed-paths matrix for the current build phase.
 * Reads tasks/builds/{slug}/.phase and blocks Edit/Write/MultiEdit calls
 * that target paths outside the phase's allowed globs.
 *
 * Slug resolution (per write target, not global):
 *   - A write under tasks/builds/<slug>/… is governed by ITS OWN slug,
 *     derived from the path — a build-dir write is always governed by
 *     its own build's phase, regardless of what current-focus.md names.
 *   - A write outside any build directory falls back to the build_slug
 *     named in tasks/current-focus.md. When STATUS:GENERATED markers are
 *     present, only the marker region is searched (first match = the
 *     highest-priority in-flight build, generator contract). When no
 *     markers exist (pre-migration), the whole file is searched — same
 *     regex, same first-match semantics as before this fix.
 *   - Accepted v1 residual: all non-build-dir writes share ONE governing
 *     phase (the top generated entry's), mirroring the pre-fix single-
 *     pointer behaviour. A write whose slug cannot be derived at all
 *     (no path match AND no current-focus fallback) is allowed — fail
 *     OPEN per this hook's contract, scoped to that single write.
 *
 * Fails OPEN on any internal error — a bug in this hook must never
 * interrupt a legitimate edit.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — block the tool call; stderr is fed back to Claude as feedback
 *
 * Phase matrix:
 *   spec      — only spec/intent/progress/mockup/review-log/status/phase files + docs + prototypes
 *   plan      — above + plan.md
 *   build     — unrestricted (always allow)
 *   review    — unrestricted (silent no-op)
 *   finalise  — unrestricted (always allow)
 *   null/missing — no-op (fail-open)
 *
 * Tests: .claude/hooks/phase-lock.test.js
 *   Run with: node .claude/hooks/phase-lock.test.js
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Phase definitions ──────────────────────────────────────────────────────

/** @type {Set<string>} */
const VALID_PHASES = new Set(['spec', 'plan', 'build', 'review', 'finalise']);

/**
 * Returns the list of allowed-write globs for a given phase and slug.
 * `build`, `review`, `finalise` return null (unrestricted).
 *
 * @param {'spec'|'plan'|'build'|'review'|'finalise'} phase
 * @param {string} slug
 * @returns {string[]|null} null means unrestricted
 */
function allowedGlobsForPhase(phase, slug) {
  if (phase === 'build' || phase === 'review' || phase === 'finalise') {
    return null; // unrestricted
  }

  const specGlobs = [
    `tasks/builds/${slug}/intent.md`,
    `tasks/builds/${slug}/progress.md`,
    `tasks/builds/${slug}/spec.md`,
    `tasks/builds/${slug}/handoff.md`,
    `tasks/builds/${slug}/mockup-log.md`,
    `tasks/builds/${slug}/mockup-review-log-*.md`,
    `tasks/builds/${slug}/status.json`,
    `tasks/builds/${slug}/.phase`,
    'tasks/current-focus.md',
    'docs/superpowers/specs/**',
    'prototypes/**',
    'tasks/review-logs/**',
  ];

  if (phase === 'spec') return specGlobs;
  if (phase === 'plan') return [...specGlobs, `tasks/builds/${slug}/plan.md`];

  return null;
}

// ── Dependency-free glob matcher ───────────────────────────────────────────
// No import of minimatch / micromatch / picomatch / glob.
// ** matches across directories; * does not cross /; ? matches single non-/ char.

/**
 * Convert a glob pattern to a RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      // ** matches anything including /
      pattern += '.*';
      i += 2;
      // consume trailing slash after ** if present
      if (glob[i] === '/') i++;
    } else if (glob[i] === '*') {
      // * matches anything except /
      pattern += '[^/]*';
      i++;
    } else if (glob[i] === '?') {
      // ? matches single non-/ char
      pattern += '[^/]';
      i++;
    } else {
      // escape regex special characters
      pattern += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + pattern + '$');
}

/**
 * Returns true if the POSIX-normalised path matches the glob.
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
function globMatch(glob, path) {
  return globToRegex(glob).test(path);
}

// ── Path normalisation ─────────────────────────────────────────────────────

/**
 * Normalise a path to repo-root-relative POSIX form:
 * - Replace backslashes with forward slashes
 * - Strip leading ./
 * - DOES NOT strip absolute-path prefix (caller handles relativity)
 * @param {string} p
 * @returns {string}
 */
function normalisePath(p) {
  let n = p.replace(/\\/g, '/');
  if (n.startsWith('./')) n = n.slice(2);
  return n;
}

/**
 * Returns true if path contains a `..` segment.
 * @param {string} p POSIX-normalised path
 * @returns {boolean}
 */
function hasDotDot(p) {
  return p.split('/').some((seg) => seg === '..');
}

/**
 * Derive the governing build slug from a repo-relative write target, when
 * the target lives inside a build directory (tasks/builds/<slug>/…). A
 * build-dir write is always governed by its own build's phase — this is
 * the natural key, so no current-focus.md fallback applies here.
 * @param {string} relPath repo-relative path (any separator; normalised internally)
 * @returns {string|null}
 */
export function deriveSlugFromPath(relPath) {
  const m = normalisePath(relPath).match(/^tasks\/builds\/([a-zA-Z0-9_-]+)\//);
  return m ? m[1] : null;
}

/**
 * Convert an absolute path to a repo-root-relative path using
 * CLAUDE_PROJECT_DIR when available.
 * @param {string} absPath
 * @returns {string} relative POSIX path, or the input if conversion not possible
 */
export function toRelative(absPath) {
  const normed = normalisePath(absPath);
  // Fall back to process.cwd() when CLAUDE_PROJECT_DIR is unset — the same
  // fallback main() uses. Without it, absolute paths inside the repo could
  // not be made relative and spec/plan phases would block legitimate edits.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (projectDir) {
    const normedDir = normalisePath(projectDir).replace(/\/$/, '');
    // On Windows the same physical path can be presented with mixed drive-letter
    // case (e.g. "c:/users/..." vs "C:/Users/..."). Match case-insensitively on
    // win32 so legitimate absolute paths still strip the project-dir prefix and
    // reach the relative-glob matcher.
    const ci = process.platform === 'win32';
    const lhs = ci ? normed.toLowerCase() : normed;
    const rhs = ci ? normedDir.toLowerCase() : normedDir;
    if (lhs.startsWith(rhs + '/')) {
      return normed.slice(rhs.length + 1);
    }
    // Exact-match branch: the absPath IS the project directory itself. Without
    // the strict equality, a bare startsWith would also catch sibling-of-repo
    // paths whose string prefix coincidentally matches the project dir (e.g.
    // /tmp/repotasks given PROJECT_DIR=/tmp/repo), producing a falsely
    // repo-relative path that could match a permissive phase allow-list.
    if (lhs === rhs) {
      return normed.slice(rhs.length); // always returns ''
    }
  }
  // If the path looks relative already, return as-is
  if (!normed.startsWith('/') && !/^[A-Za-z]:/.test(normed)) {
    return normed;
  }
  // Absolute path outside the project dir — return as-is. It stays absolute,
  // so it will NOT match any repo-relative allow-glob and spec/plan phases
  // will block it. That is deliberate: writes outside the repo root during a
  // restricted phase are suspect and should be surfaced, not waved through.
  return normed;
}

// ── Pure decision helper ───────────────────────────────────────────────────

/**
 * @typedef {'spec'|'plan'|'build'|'review'|'finalise'} Phase
 * @typedef {'allow'|'block'} Disposition
 * @typedef {{ toolName: string, targetPath: string, currentPhase: Phase|null, buildSlug: string|null }} PhaseLockDecisionInput
 * @typedef {{ disposition: Disposition, reason: string }} PhaseLockDecisionResult
 */

/**
 * Pure decision helper — no clock, no filesystem I/O.
 * @param {PhaseLockDecisionInput} input
 * @returns {PhaseLockDecisionResult}
 */
export function decidePhaseLock({ toolName, targetPath, currentPhase, buildSlug }) {
  // Fail-open for unrecognised tool names
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
    return { disposition: 'allow', reason: `phase-lock: tool ${toolName} not in enforcement set, allowing` };
  }

  // Normalise path for matching
  const normedPath = normalisePath(targetPath);

  // No active phase — no-op
  if (currentPhase === null) {
    return { disposition: 'allow', reason: 'no .phase enforcement (missing/empty/invalid)' };
  }

  // Build / review / finalise — unrestricted
  if (currentPhase === 'build' || currentPhase === 'review' || currentPhase === 'finalise') {
    return { disposition: 'allow', reason: `phase-lock: ${currentPhase} phase, unrestricted` };
  }

  // Reject .. traversal in the restricted phases only. Unrestricted phases
  // and null-phase must never block (header contract: build/review/finalise
  // are "always allow" and missing phase is a no-op), so this check runs
  // after those short-circuits.
  if (hasDotDot(normedPath)) {
    return { disposition: 'block', reason: `phase-lock: path contains '..' segment, blocked for safety` };
  }

  // Spec / plan — check against allowed globs
  const globs = allowedGlobsForPhase(currentPhase, buildSlug || '');
  if (globs === null) {
    // Unrestricted phases already handled above; this branch should not be reached
    return { disposition: 'allow', reason: `phase-lock: ${currentPhase} phase, unrestricted` };
  }

  // Use toRelative to get the relative path for matching
  // (targetPath may be absolute when received from Claude Code hook)
  const relPath = toRelative(targetPath);
  const relNormed = normalisePath(relPath);

  for (const glob of globs) {
    if (globMatch(glob, relNormed)) {
      return { disposition: 'allow', reason: `phase-lock: ${currentPhase} phase, path matches ${glob}` };
    }
  }

  return {
    disposition: 'block',
    reason: `phase-lock: ${currentPhase} phase — "${relNormed}" is outside the allowed-paths matrix. Allowed globs: ${globs.join(', ')}`,
  };
}

// ── Hook helpers ───────────────────────────────────────────────────────────

/**
 * Extract file paths from tool_input depending on tool type.
 *
 * Claude Code's MultiEdit payload schema is `{ file_path, edits: [{ old_string,
 * new_string }, ...] }` — the file path is top-level, not per-edit. We always
 * consume the top-level `file_path` first, then fall back to scanning `edits[]`
 * for `file_path` entries in case a future schema variant adds per-edit paths.
 * Edit/Write payloads carry only `file_path` at the top level.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @returns {string[]}
 */
export function extractFilePaths(toolName, toolInput) {
  const paths = new Set();
  if (toolInput.file_path) paths.add(String(toolInput.file_path));
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    for (const edit of edits) {
      if (edit && edit.file_path) paths.add(String(edit.file_path));
    }
  }
  return [...paths];
}

// STATUS:GENERATED markers written by scripts/status/generate-current-focus.mjs
// (inventory row 12). Each active-build entry inside the region emits exactly
// one `build_slug: <slug>` line, highest-priority build first.
const STATUS_GENERATED_BEGIN = '<!-- STATUS:GENERATED:BEGIN -->';
const STATUS_GENERATED_END = '<!-- STATUS:GENERATED:END -->';

/**
 * Extract the governing build_slug from tasks/current-focus.md content.
 * When STATUS:GENERATED markers are present, search ONLY inside the marker
 * region — the generator emits one `build_slug:` line per build,
 * highest-priority first, so the first match inside the region is the
 * deterministic top entry. When no markers exist (pre-migration repos),
 * search the whole file — same regex, same first-match semantics as the
 * original single-pointer behaviour (byte-identical fallback).
 * @param {string} content
 * @returns {string|null}
 */
export function extractBuildSlugFromContent(content) {
  const beginIdx = content.indexOf(STATUS_GENERATED_BEGIN);
  const endIdx = content.indexOf(STATUS_GENERATED_END);
  const searchIn =
    beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx
      ? content.slice(beginIdx + STATUS_GENERATED_BEGIN.length, endIdx)
      : content;
  // Look for lines like: build_slug: framework-learning-loops
  // (matches the YAML-style frontmatter and the prose body's `Active build slug:` form
  // only when the field name uses underscore/hyphen — the literal `build slug` with a
  // space is intentionally NOT matched to avoid false hits on prose like "the build slug is...")
  const match = searchIn.match(/build[_-]slug[:\s*`]+([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Read and return the trimmed build_slug from tasks/current-focus.md.
 * Returns null if the file is missing or the field is absent.
 * @param {string} projectDir
 * @returns {string|null}
 */
function readBuildSlug(projectDir) {
  try {
    const content = readFileSync(`${projectDir}/tasks/current-focus.md`, 'utf8');
    return extractBuildSlugFromContent(content);
  } catch {
    return null;
  }
}

/**
 * Read and return the trimmed, lowercased phase from tasks/builds/{slug}/.phase.
 * Returns null if missing, empty, or invalid.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {'spec'|'plan'|'build'|'review'|'finalise'|null}
 */
function readPhase(projectDir, slug) {
  try {
    const raw = readFileSync(`${projectDir}/tasks/builds/${slug}/.phase`, 'utf8').trim().toLowerCase();
    if (!raw) return null;
    if (!VALID_PHASES.has(raw)) {
      process.stderr.write(`phase-lock: invalid .phase content "${raw}", treating as no-op\n`);
      return null;
    }
    return /** @type {any} */ (raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // missing file — silent no-op
    return null;
  }
}

/**
 * Resolve the governing {slug, phase} for a single write target.
 * Build-dir writes (tasks/builds/<slug>/…) are governed by their OWN
 * build's phase, derived from the path. Writes outside any build
 * directory fall back to the current-focus.md build_slug (marker-scoped
 * when STATUS:GENERATED markers exist — see extractBuildSlugFromContent).
 * Returns { slug: null, phase: null } when no slug can be derived at all
 * (no path match AND no current-focus fallback) — the caller fails OPEN
 * for that single write, not for the whole hook invocation.
 * @param {string} projectDir
 * @param {string} targetPath
 * @returns {{ slug: string|null, phase: 'spec'|'plan'|'build'|'review'|'finalise'|null }}
 */
export function resolvePhaseLockContext(projectDir, targetPath) {
  const relPath = normalisePath(toRelative(targetPath));
  const slug = deriveSlugFromPath(relPath) || readBuildSlug(projectDir);
  if (!slug) return { slug: null, phase: null };
  return { slug, phase: readPhase(projectDir, slug) };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = raw.trim() ? JSON.parse(raw) : {};
      const toolName = payload.tool_name || '';

      if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
        process.exit(0);
      }

      const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const filePaths = extractFilePaths(toolName, payload.tool_input || {});

      if (filePaths.length === 0) {
        process.exit(0);
      }

      for (const fp of filePaths) {
        const { slug, phase } = resolvePhaseLockContext(projectDir, fp);
        if (!slug) continue; // no enforcement context derivable for this write — fail-open

        const result = decidePhaseLock({ toolName, targetPath: fp, currentPhase: phase, buildSlug: slug });
        if (result.disposition === 'block') {
          process.stderr.write(result.reason + '\n');
          process.exit(2);
        }
      }

      process.exit(0);
    } catch (err) {
      process.stderr.write(`phase-lock: internal error, allowing edit: ${err && err.message}\n`);
      process.exit(0);
    }
  });
}

// Guard: only run main() when executed directly (not when imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
