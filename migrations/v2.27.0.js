'use strict';

/**
 * v2.27.0 migration — adopt the two files that became framework-managed in
 * v2.27.0, and seed the hooks package.json where absent.
 *
 * In v2.27.0 the framework took ownership of:
 *   - .claude/hooks/package.json        (declares "type": "module" for the hooks)
 *   - references/project-extensions-convention.md
 *
 * Consuming repos may already have local copies (package.json was previously a
 * doNotTouch path; the convention doc shipped informally). Left unhandled,
 * sync.js would treat each one as "target exists + no state entry" and write a
 * .framework-new sibling, asking the operator to merge by hand.
 *
 * This migration pre-empts that noise: for each newly-managed file, hash the
 * consumer's local copy against the framework copy; if they match, write an
 * adopted entry into .framework-state.json so sync.js sees the file as clean.
 * If they differ, leave it alone and report a conflict — sync.js will then
 * write .framework-new for a real merge.
 *
 * Also: seed .claude/hooks/package.json with {"type":"module"} if absent
 * (copied from the framework canonical when readable), so the ESM hook scripts
 * run under node without warnings before the first post-migration sync.
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
    s = s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
    s = s.replace(/\n+$/, '') + '\n';
    return s;
  }
  function hashContent(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }

  // Files that became framework-managed in v2.27.0. Literal paths only —
  // no glob expansion needed.
  const NEWLY_MANAGED = [
    '.claude/hooks/package.json',
    'references/project-extensions-convention.md',
  ];

  const HOOKS_PACKAGE_JSON = '.claude/hooks/package.json';
  const FALLBACK_HOOKS_PACKAGE_CONTENT = '{"type":"module"}\n';

  // Step 0: Read consumer state. If absent, this is a pristine adoption —
  // sync.js --adopt will catalogue everything; the migration has nothing to do.
  const statePath = path.join(consumerRoot, '.claude', '.framework-state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    notes.push('No .framework-state.json — assuming pristine adoption. sync.js --adopt will catalogue files; migration is a no-op.');
    return { status: 'skipped', notes };
  }
  if (!state.files || typeof state.files !== 'object') state.files = {};

  let stateChanged = false;

  // Step 1: Seed .claude/hooks/package.json if absent. Runs before the adoption
  // loop so the freshly-seeded file is auto-adopted in the same pass.
  const hooksPackagePath = path.join(consumerRoot, HOOKS_PACKAGE_JSON);
  if (!fs.existsSync(hooksPackagePath)) {
    let seedContent = FALLBACK_HOOKS_PACKAGE_CONTENT;
    try {
      seedContent = fs.readFileSync(path.join(frameworkRoot, HOOKS_PACKAGE_JSON), 'utf8');
    } catch {
      notes.push(`WARN: framework canonical ${HOOKS_PACKAGE_JSON} unreadable — seeding literal {"type":"module"}.`);
    }
    await fsp.mkdir(path.dirname(hooksPackagePath), { recursive: true });
    await fsp.writeFile(hooksPackagePath, seedContent, 'utf8');
    notes.push(`Seeded ${HOOKS_PACKAGE_JSON} ({"type":"module"}) — hook scripts are ES modules.`);
  }

  // Step 2: Auto-adopt newly-managed files where local content matches framework.
  let autoAdoptedCount = 0;
  let alreadyInStateCount = 0;
  let conflictCount = 0;
  let absentLocallyCount = 0;
  const conflicts = [];

  for (const rel of NEWLY_MANAGED) {
    if (state.files[rel]) { alreadyInStateCount++; continue; }
    const consumerPath = path.join(consumerRoot, rel);
    const frameworkPath = path.join(frameworkRoot, rel);
    if (!fs.existsSync(consumerPath)) { absentLocallyCount++; continue; }

    let consumerContent, frameworkContent;
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
      stateChanged = true;
    } else {
      conflictCount++;
      conflicts.push(rel);
    }
  }

  if (autoAdoptedCount > 0) {
    notes.push(`Auto-adopted ${autoAdoptedCount} pre-existing file(s) whose content matched framework v${toVersion}.`);
  }
  if (alreadyInStateCount > 0) {
    notes.push(`Skipped ${alreadyInStateCount} file(s) already tracked in state.`);
  }
  if (absentLocallyCount > 0) {
    notes.push(`Skipped ${absentLocallyCount} file(s) not present locally — sync.js will write fresh.`);
  }
  if (conflictCount > 0) {
    notes.push(`Conflict: ${conflictCount} file(s) differ from framework v${toVersion}. sync.js will write .framework-new for manual merge:`);
    for (const c of conflicts) notes.push(`  - ${c}`);
  }

  // Step 3: Atomically persist updated state if we changed it.
  if (stateChanged) {
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, statePath);
  }

  const status = conflictCount > 0 ? 'conflict' : 'applied';
  return { status, notes };
}

module.exports = { migrate };
