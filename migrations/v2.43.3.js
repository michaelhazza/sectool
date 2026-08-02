'use strict';

/**
 * v2.43.3 — scripts/check-secrets.js renamed to scripts/check-secrets.cjs.
 *
 * The scanner is CommonJS; the `.js` extension made ESM consumers
 * (`"type": "module"` in package.json) parse it as ESM, so both the CLI
 * (`node scripts/check-secrets.js`) and the vitest import in
 * scripts/__tests__/check-secrets.test.ts crashed with
 * "ReferenceError: require is not defined". The `.cjs` extension pins CJS
 * in every consumer regardless of package type. sync.js deploys the new
 * scripts/check-secrets.cjs; this migration removes the orphaned old copy
 * and its state entry.
 *
 * Behaviour:
 *   - Consumer file absent            → skipped (fresh consumers never had it)
 *   - Consumer file matches canonical → applied (file deleted, state entry dropped)
 *     ("canonical" = frameworkRoot scripts/check-secrets.cjs — identical
 *      content, renamed — OR the state entry's lastAppliedHash)
 *   - Consumer file diverges          → conflict (report, do not delete)
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped'|'conflict', notes: string[] }>}
 */

const fs = require('fs');
const path = require('path');
const { normaliseContent, hashContent, readConsumerState, persistStateAtomic } = require('./_helpers');

const OLD_REL = 'scripts/check-secrets.js';
const NEW_REL = 'scripts/check-secrets.cjs';

async function migrate(ctx) {
  const { consumerRoot, frameworkRoot } = ctx;
  const notes = [];

  const oldAbs = path.join(consumerRoot, ...OLD_REL.split('/'));
  const { state, statePath } = readConsumerState(consumerRoot);

  const dropStateEntry = () => {
    if (state && state.files && state.files[OLD_REL]) {
      delete state.files[OLD_REL];
      persistStateAtomic(statePath, state);
      notes.push(`state entry for ${OLD_REL} removed`);
      return true;
    }
    return false;
  };

  if (!fs.existsSync(oldAbs)) {
    const dropped = dropStateEntry();
    notes.push(`${OLD_REL} not present — nothing to remove (replacement ${NEW_REL} deploys via sync.js)`);
    return { status: dropped ? 'applied' : 'skipped', notes };
  }

  const consumerHash = hashContent(normaliseContent(fs.readFileSync(oldAbs, 'utf8')));

  const candidateHashes = new Set();
  const canonicalAbs = path.join(frameworkRoot, ...NEW_REL.split('/'));
  if (fs.existsSync(canonicalAbs)) {
    candidateHashes.add(hashContent(normaliseContent(fs.readFileSync(canonicalAbs, 'utf8'))));
  }
  const stateEntry = state && state.files ? state.files[OLD_REL] : null;
  if (stateEntry && stateEntry.lastAppliedHash) {
    candidateHashes.add(stateEntry.lastAppliedHash);
  }

  if (!candidateHashes.has(consumerHash)) {
    notes.push(
      `${OLD_REL} diverges from the framework-deployed content — not deleting. ` +
      `The scanner now lives at ${NEW_REL}; port any local edits there, delete ${OLD_REL}, then re-run /claudeupdate.`,
    );
    return { status: 'conflict', notes };
  }

  fs.unlinkSync(oldAbs);
  notes.push(`${OLD_REL} deleted (unmodified copy; renamed upstream to ${NEW_REL})`);
  dropStateEntry();
  return { status: 'applied', notes };
}

module.exports = { migrate };
