'use strict';

/**
 * v2.13.0 migration — two halves, one migrate() function.
 *
 * Half 1 (Chunk 1): idempotently append the per-build phase-marker glob
 * (the gitignoreLine constant below — the star-slash sequence cannot be
 * written in this block comment without terminating it, which is exactly
 * the SyntaxError this wording fixes)
 * to the consumer .gitignore so per-build phase marker files are not
 * committed to version control. Phase markers are ephemeral coordination
 * state; they must not appear in git history.
 *
 * Half 2 (Chunk 7): idempotently add `sibling_repos: []` to
 * .claude/project-registries.json for the cross-repo-scout agent (v2.13.0+).
 * If the file does not exist, skips (consumer not yet running registries).
 * If the key already exists, leaves untouched. Atomic via tmp-rename.
 *
 * Idempotent. Safe to re-run. Non-destructive.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped', notes: string[] }>}
 */
async function migrate(ctx) {
  const fs = require('fs');
  const fsp = require('fs/promises');
  const path = require('path');

  const { consumerRoot } = ctx;
  const notes = [];

  // -----------------------------------------------------------------------
  // Half 1 — idempotently append `tasks/builds/*/.phase` to consumer
  // .gitignore. Phase marker files are ephemeral coordination state (written
  // by coordinators, read by the phase-lock hook) and must not be committed.
  // -----------------------------------------------------------------------
  const gitignorePath = path.join(consumerRoot, '.gitignore');
  const gitignoreLine = 'tasks/builds/*/.phase';
  let gitignoreContent = '';
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* file absent */ }

  const hasLine = gitignoreContent
    .split(/\r?\n/)
    .some((line) => line.trim() === gitignoreLine);

  if (!hasLine) {
    const sep = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    const addition = `${sep}${gitignoreLine}\n`;
    await fsp.writeFile(gitignorePath, gitignoreContent + addition, 'utf8');
    notes.push(`Appended ${gitignoreLine} to .gitignore (phase marker files are ephemeral, must not be committed).`);
  } else {
    notes.push(`.gitignore already excludes ${gitignoreLine} — left untouched.`);
  }

  // -----------------------------------------------------------------------
  // Half 2 — idempotently add `sibling_repos: []` to
  // .claude/project-registries.json if the file exists and the key is absent.
  // -----------------------------------------------------------------------
  const registriesPath = path.join(consumerRoot, '.claude', 'project-registries.json');
  if (fs.existsSync(registriesPath)) {
    try {
      const raw = fs.readFileSync(registriesPath, 'utf8');
      const obj = JSON.parse(raw);
      if (!('sibling_repos' in obj)) {
        obj.sibling_repos = [];
        const tmp = `${registriesPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, registriesPath);
        notes.push('Added sibling_repos: [] to .claude/project-registries.json.');
      } else {
        notes.push('.claude/project-registries.json already has sibling_repos — left untouched.');
      }
    } catch (e) {
      notes.push(`WARN: failed to parse/modify .claude/project-registries.json: ${e.message}. Manual edit required.`);
    }
  } else {
    notes.push('.claude/project-registries.json absent — seed via project-registries.json.template adoption.');
  }

  const status = 'applied';
  return { status, notes };
}

module.exports = { migrate };
