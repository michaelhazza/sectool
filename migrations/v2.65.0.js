'use strict';

/**
 * v2.65.0 migration — ensure consumers gitignore the runtime state dir.
 *
 * The code-graph-freshness-check hook now writes its audit-mtime stamp and its
 * rebuild in-flight lock under `.claude/session-state/` (mutable runtime state,
 * never the committed tree). A consumer whose .gitignore does not already
 * exclude that path would see the hook dirty `git status` on every session
 * start. This migration appends the ignore line when absent — idempotent, and
 * a no-op for consumers that already carry it (this repo's .gitignore:19).
 */

const { ensureGitignoreLine } = require('./_helpers');

const GITIGNORE_LINE = '.claude/session-state/';

async function migrate(ctx) {
  const notes = [];
  const { appended } = await ensureGitignoreLine(ctx.consumerRoot, GITIGNORE_LINE);
  if (appended) {
    notes.push(`Appended ${GITIGNORE_LINE} to .gitignore — freshness-check runtime state (audit stamp + rebuild lock) stays untracked.`);
    return { status: 'applied', notes };
  }
  notes.push(`.gitignore already excludes ${GITIGNORE_LINE} — left untouched.`);
  return { status: 'skipped', notes };
}

module.exports = { migrate };
