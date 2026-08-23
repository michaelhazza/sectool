'use strict';

/**
 * v2.72.0 migration — two halves (v2.13.0 precedent):
 *
 * 1. Idempotently add the doc-retrieval tooling's runtime artifacts to the
 *    consumer's .gitignore.
 *
 *    architecture-search.ts writes arch:search request telemetry
 *    (references/.arch-search-log.jsonl) plus a durable gap marker
 *    (references/.arch-search-telemetry-incomplete) that feeds the doc-read
 *    audit; doc-read-audit.ts writes date-stamped report files
 *    (references/.doc-read-audit-*.md). None of these are shared state: they
 *    are per-clone runtime output and must never be committed.
 *
 * 2. Clean up consumer-side orphans of the v2.72.0 script renames
 *    (v2.43.3 precedent): scripts/run-migrations.js → scripts/run-migrations.cjs,
 *    scripts/framework-merge.js → scripts/framework-merge.cjs, and the shipped
 *    local-override smoke tests scripts/__tests__/local-override-{smoke,e2e}.js
 *    → .cjs. All four are CommonJS; the `.js` extension made ESM consumers
 *    (`"type": "module"` in package.json) parse them as ESM and crash with
 *    "require is not defined". The `.cjs` extension pins CJS in every consumer
 *    regardless of package type. sync.js deploys the new `.cjs` copies; this
 *    migration removes the orphaned old copies and their state entries.
 *
 * Behaviour (per renamed pair):
 *   - Consumer file absent            → nothing to remove (stale state entry
 *                                       still dropped if present)
 *   - Consumer file matches canonical → file deleted, state entry dropped
 *     ("canonical" = frameworkRoot's new `.cjs` content — identical, renamed —
 *      OR the state entry's lastAppliedHash, i.e. a framework-owned stale copy)
 *   - Consumer file diverges          → conflict (report, do not delete)
 *
 * Combined status: any pair in conflict → 'conflict'; else 'applied' when
 * anything changed (.gitignore lines appended, files deleted, or state
 * entries dropped); else 'skipped'. Idempotent: on a conflict-driven re-run,
 * already-removed pairs hit the absent branch and stay silent.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped'|'conflict', notes: string[] }>}
 */

const fs = require('fs');
const path = require('path');
const {
  ensureGitignoreLine,
  normaliseContent,
  hashContent,
  readConsumerState,
  persistStateAtomic,
} = require('./_helpers');

const IGNORE_LINES = [
  'references/.arch-search-log.jsonl',
  'references/.arch-search-telemetry-incomplete',
  'references/.doc-read-audit-*.md',
];

const RENAMED_PAIRS = [
  { oldRel: 'scripts/run-migrations.js', newRel: 'scripts/run-migrations.cjs' },
  { oldRel: 'scripts/framework-merge.js', newRel: 'scripts/framework-merge.cjs' },
  { oldRel: 'scripts/__tests__/local-override-smoke.js', newRel: 'scripts/__tests__/local-override-smoke.cjs' },
  { oldRel: 'scripts/__tests__/local-override-e2e.js', newRel: 'scripts/__tests__/local-override-e2e.cjs' },
];

/**
 * Mirror of the v2.43.3 cleanup for one renamed pair. Mutates + persists
 * consumer state when it drops an entry.
 *
 * @returns {{ changed: boolean, conflict: boolean }}
 */
function cleanupRenamedPair({ consumerRoot, frameworkRoot, pair, state, statePath, notes }) {
  const { oldRel, newRel } = pair;
  const oldAbs = path.join(consumerRoot, ...oldRel.split('/'));

  const dropStateEntry = () => {
    if (state && state.files && state.files[oldRel]) {
      delete state.files[oldRel];
      persistStateAtomic(statePath, state);
      notes.push(`state entry for ${oldRel} removed`);
      return true;
    }
    return false;
  };

  if (!fs.existsSync(oldAbs)) {
    const dropped = dropStateEntry();
    if (dropped) {
      notes.push(`${oldRel} not present — stale state entry dropped (replacement ${newRel} deploys via sync.js)`);
    }
    return { changed: dropped, conflict: false };
  }

  const consumerHash = hashContent(normaliseContent(fs.readFileSync(oldAbs, 'utf8')));

  const candidateHashes = new Set();
  const canonicalAbs = path.join(frameworkRoot, ...newRel.split('/'));
  if (fs.existsSync(canonicalAbs)) {
    candidateHashes.add(hashContent(normaliseContent(fs.readFileSync(canonicalAbs, 'utf8'))));
  }
  const stateEntry = state && state.files ? state.files[oldRel] : null;
  if (stateEntry && stateEntry.lastAppliedHash) {
    candidateHashes.add(stateEntry.lastAppliedHash);
  }

  if (!candidateHashes.has(consumerHash)) {
    notes.push(
      `${oldRel} diverges from the framework-deployed content — not deleting. ` +
      `The script now lives at ${newRel}; port any local edits there, delete ${oldRel}, then re-run /claudeupdate.`,
    );
    return { changed: false, conflict: true };
  }

  fs.unlinkSync(oldAbs);
  notes.push(`${oldRel} deleted (unmodified copy; renamed upstream to ${newRel})`);
  dropStateEntry();
  return { changed: true, conflict: false };
}

async function migrate(ctx) {
  const { consumerRoot, frameworkRoot } = ctx;
  const notes = [];
  let anythingChanged = false;
  let anyConflict = false;

  // Half 1: .gitignore lines for doc-retrieval runtime artifacts.
  const appendedLines = [];
  for (const line of IGNORE_LINES) {
    const { appended } = await ensureGitignoreLine(consumerRoot, line);
    if (appended) appendedLines.push(line);
  }
  if (appendedLines.length === 0) {
    notes.push('doc-retrieval ignore lines already present in .gitignore — left untouched.');
  } else {
    anythingChanged = true;
    notes.push(
      `Appended ${appendedLines.length} doc-retrieval ignore line(s) to .gitignore (arch:search telemetry + doc-read-audit reports; per-clone runtime artefacts): ${appendedLines.join(', ')}.`
    );
  }

  // Half 2: engine-script rename cleanup (v2.43.3 precedent), both pairs.
  const { state, statePath } = readConsumerState(consumerRoot);
  for (const pair of RENAMED_PAIRS) {
    const { changed, conflict } = cleanupRenamedPair({ consumerRoot, frameworkRoot, pair, state, statePath, notes });
    if (changed) anythingChanged = true;
    if (conflict) anyConflict = true;
  }

  if (anyConflict) return { status: 'conflict', notes };
  return { status: anythingChanged ? 'applied' : 'skipped', notes };
}

module.exports = { migrate };
