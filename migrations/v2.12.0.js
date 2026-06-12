'use strict';

/**
 * v2.12.0 migration — adopt newly-framework-managed bug-fixer.md and
 * idempotently append .claude/session-state/ to the consumer .gitignore.
 *
 * In v2.12.0 the framework took ownership of:
 *   - .claude/agents/bug-fixer.md
 *
 * Many consuming repos already have a local copy of bug-fixer.md (it was
 * authored in-repo and lifted into the framework as part of v2.12.0). Left
 * unhandled, sync.js would treat it as "target exists + no state entry" and
 * write a .framework-new sibling, asking the operator to merge by hand.
 *
 * This migration pre-empts that noise: hash the consumer's local copy
 * against the framework copy; if they match, write an `adopted-via-migration`
 * entry into .framework-state.json so sync.js sees the file as clean. If
 * they differ, leave it alone and report a conflict — sync.js will then
 * write .framework-new for a real merge.
 *
 * Also: append `.claude/session-state/` to the consumer's .gitignore if it
 * is not already present. The new bug-fixer writes ephemeral session state
 * to that directory (review-mode propagation). Idempotent — appends only
 * if the exact line is not already in the file.
 *
 * Idempotent. Safe to re-run. Non-destructive on conflict.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped'|'conflict', notes: string[] }>}
 */
async function migrate(ctx) {
  const fs = require('fs');
  const fsp = require('fs/promises');
  const path = require('path');
  const crypto = require('crypto');

  const { consumerRoot, frameworkRoot, toVersion } = ctx;
  const notes = [];

  function normaliseContent(raw) {
    let s = raw.startsWith('﻿') ? raw.slice(1) : raw;
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
    s = s.replace(/\n+$/, '') + '\n';
    return s;
  }
  function hashContent(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }

  // Files the framework newly manages in this version. Each entry is a
  // single path (no globs — only one file in v2.12.0).
  const NEWLY_MANAGED = ['.claude/agents/bug-fixer.md'];

  // -----------------------------------------------------------------------
  // Step 0 — read consumer state. If absent, this is a pristine adoption.
  // -----------------------------------------------------------------------
  const statePath = path.join(consumerRoot, '.claude', '.framework-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    notes.push('No .framework-state.json — assuming pristine adoption. sync.js --adopt will catalogue files; migration is a no-op for newly-managed files.');
    state = null;
  }
  if (state && (!state.files || typeof state.files !== 'object')) state.files = {};

  // -----------------------------------------------------------------------
  // Step 1 — auto-adopt newly-managed files where local content matches
  // framework content.
  // -----------------------------------------------------------------------
  let autoAdoptedCount = 0;
  let needsAdoption = 0;
  let absentLocallyCount = 0;
  let conflictCount = 0;
  const conflicts = [];

  if (state) {
    for (const rel of NEWLY_MANAGED) {
      // Re-adopt when missing OR when present with an empty hash (the broken
      // shape left by direct file copies that bypassed sync.js — relevant to
      // the v2.12.0 PR-12 dev cycle in automation-v1).
      const existing = state.files[rel];
      const needsRebind = !existing || !existing.lastAppliedHash || existing.lastAppliedHash === '';
      if (!needsRebind) continue;
      needsAdoption++;

      const consumerPath = path.join(consumerRoot, rel);
      const frameworkPath = path.join(frameworkRoot, rel);
      if (!fs.existsSync(consumerPath)) {
        absentLocallyCount++;
        continue;
      }

      let consumerContent;
      let frameworkContent;
      try { consumerContent = fs.readFileSync(consumerPath, 'utf8'); } catch { absentLocallyCount++; continue; }
      try { frameworkContent = fs.readFileSync(frameworkPath, 'utf8'); } catch { continue; }

      const consumerHash = hashContent(normaliseContent(consumerContent));
      const frameworkHash = hashContent(normaliseContent(frameworkContent));

      if (consumerHash === frameworkHash) {
        state.files[rel] = {
          lastAppliedHash: consumerHash,
          lastAppliedFrameworkVersion: toVersion,
          lastAppliedFrameworkCommit: null,
          lastAppliedSourcePath: rel,
          customisedLocally: false,
        };
        autoAdoptedCount++;
      } else {
        conflictCount++;
        conflicts.push(rel);
      }
    }

    if (autoAdoptedCount > 0) {
      notes.push(`Auto-adopted ${autoAdoptedCount} file(s) whose local content matched framework v${toVersion} (cleared any empty-hash state).`);
    }
    if (absentLocallyCount > 0) {
      notes.push(`Skipped ${absentLocallyCount} file(s) not present locally — sync.js will write fresh.`);
    }
    if (conflictCount > 0) {
      notes.push(`Conflict: ${conflictCount} file(s) differ from framework v${toVersion}. sync.js will write .framework-new for manual merge:`);
      for (const c of conflicts) notes.push(`  - ${c}`);
    }
    if (autoAdoptedCount === 0 && conflictCount === 0 && absentLocallyCount === 0 && needsAdoption === 0) {
      notes.push('All newly-managed files already tracked correctly in state — nothing to adopt.');
    }
  }

  // -----------------------------------------------------------------------
  // Step 2 — idempotently append `.claude/session-state/` to consumer
  // .gitignore. The bug-fixer writes review-mode state there; committing it
  // would noise-pollute history with per-session ephemera.
  // -----------------------------------------------------------------------
  const gitignorePath = path.join(consumerRoot, '.gitignore');
  const gitignoreLine = '.claude/session-state/';
  let gitignoreContent = '';
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* file absent */ }
  const hasLine = gitignoreContent
    .split(/\r?\n/)
    .some((line) => line.trim() === gitignoreLine);
  if (!hasLine) {
    const sep = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    const addition = `${sep}${gitignoreLine}\n`;
    await fsp.writeFile(gitignorePath, gitignoreContent + addition, 'utf8');
    notes.push(`Appended ${gitignoreLine} to .gitignore (per-session ephemeral state, must not be committed).`);
  } else {
    notes.push(`.gitignore already excludes ${gitignoreLine} — left untouched.`);
  }

  // -----------------------------------------------------------------------
  // Step 3 — atomically persist updated state if we changed it.
  // -----------------------------------------------------------------------
  if (state && autoAdoptedCount > 0) {
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, statePath);
  }

  const status = conflictCount > 0 ? 'conflict' : 'applied';
  return { status, notes };
}

module.exports = { migrate };
