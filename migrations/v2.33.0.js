'use strict';

/**
 * v2.33.0 migration — adopt the new adopt-only managed file
 * `.claude/context/skill-context.md` into consumers that already carry a
 * matching copy, so sync.js writes no spurious `.framework-new` sibling.
 *
 * This is the only new adopt-only file in v2.33.0. The other five new managed
 * files (`memory-digest.js`, `skill-overlay-convention.md`,
 * `eval-suite-format.md`, `eval-prompts.ts`, `eval-promptsPure.ts`) are
 * `mode: sync` — sync.js handles them with its normal new-file flow, and this
 * migration deliberately does not touch them.
 *
 * Behaviour (via adoptNewlyManagedFiles):
 *   - no .framework-state.json (pristine)      -> 'skipped' (sync.js --adopt catalogues)
 *   - overlay already tracked in state         -> 'skipped'
 *   - overlay absent locally                   -> 'skipped' (sync.js writes fresh)
 *   - overlay present, matches framework        -> adopt into state, 'applied'
 *   - overlay present, differs from framework  -> 'conflict' (sync.js writes .framework-new)
 *
 * Idempotent. Non-destructive. Safe to re-run.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped'|'conflict', notes: string[] }>}
 */

const { readConsumerState, persistStateAtomic, adoptNewlyManagedFiles } = require('./_helpers');

const ADOPT_PATHS = ['.claude/context/skill-context.md'];

async function migrate(ctx) {
  const { consumerRoot, frameworkRoot, toVersion } = ctx;
  const notes = [];

  const { state, statePath } = readConsumerState(consumerRoot);
  if (!state) {
    notes.push('No .framework-state.json — assuming pristine adoption. sync.js --adopt will catalogue files; migration is a no-op.');
    return { status: 'skipped', notes };
  }

  const result = adoptNewlyManagedFiles({
    consumerRoot,
    frameworkRoot,
    toVersion,
    state,
    paths: ADOPT_PATHS,
  });
  notes.push(...result.notes);
  if (result.stateChanged) persistStateAtomic(statePath, state);

  if (result.conflicts.length > 0) return { status: 'conflict', notes };
  if (result.adopted > 0) return { status: 'applied', notes };
  return { status: 'skipped', notes };
}

module.exports = { migrate };
