'use strict';

/**
 * v2.30.0 migration — idempotently append `*.framework-new` to the consumer's
 * .gitignore.
 *
 * `.framework-new` files are per-clone, per-sync-run working artefacts:
 * sync.js's "here is what the new canonical looks like, decide if you want to
 * absorb it" advisory for one developer's sync run. If they get tracked in
 * git, one developer's mid-sync state propagates to every clone and creates a
 * misleading appearance of a shared pending-decisions backlog.
 *
 * SYNC.md Phase 5 previously instructed operators to add the rule manually,
 * once per repo. This migration automates that step. sync.js itself
 * deliberately never edits a consuming repo's root .gitignore, which is why
 * the append lives here as one-time imperative work rather than in the
 * declarative sync.
 *
 * Behaviour:
 *   - .gitignore absent            -> create it with the rule; status 'applied'
 *   - rule missing                 -> append (preserving existing content,
 *                                     adding a separating newline if the file
 *                                     lacks a trailing one); status 'applied'
 *   - rule already present         -> leave untouched; status 'skipped'
 *
 * Idempotent. Safe to re-run. Non-destructive.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped', notes: string[] }>}
 */

const { ensureGitignoreLine } = require('./_helpers');

const GITIGNORE_LINE = '*.framework-new';

async function migrate(ctx) {
  const notes = [];

  const { appended } = await ensureGitignoreLine(ctx.consumerRoot, GITIGNORE_LINE);

  if (appended) {
    notes.push(`Appended ${GITIGNORE_LINE} to .gitignore (framework sync working artefacts are per-clone and must not be committed).`);
    return { status: 'applied', notes };
  }

  notes.push(`.gitignore already excludes ${GITIGNORE_LINE} — left untouched.`);
  return { status: 'skipped', notes };
}

module.exports = { migrate };
