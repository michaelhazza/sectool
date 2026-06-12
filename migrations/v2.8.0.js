'use strict';

/**
 * v2.8.0 migration — adopt newly-framework-managed files and seed the
 * project-registries config.
 *
 * In v2.8.0 the framework took ownership of:
 *   - scripts/chatgpt-review.ts
 *   - scripts/chatgpt-review-api.ts
 *   - scripts/chatgpt-reviewPure.ts
 *   - scripts/__tests__/chatgpt-reviewPure.test.ts
 *   - scripts/review-coordinator/*.ts
 *   - schemas/*.json
 *   - schemas/CHANGELOG.md
 *
 * Most consuming repos already have local copies of these (they were authored
 * in-repo and lifted into the framework as part of v2.8.0). Left unhandled,
 * sync.js would treat each one as "target exists + no state entry" and write
 * a .framework-new sibling per file, asking the operator to merge by hand.
 *
 * This migration pre-empts that noise: for each newly-managed file, hash the
 * consumer's local copy against the framework copy; if they match, write an
 * `adopted-via-migration` entry into .framework-state.json so sync.js sees the
 * file as clean. If they differ, leave it alone and report a conflict — sync.js
 * will then write .framework-new for a real merge.
 *
 * Also: copy .claude/project-registries.json.template → .claude/project-registries.json
 * on first adoption, so the chatgpt-review coordinator can read the per-repo
 * registry config introduced in v2.8.0.
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

  // Subset of v2.8.0 managedFiles that consuming repos commonly own locally
  // BEFORE the framework took ownership. Globs follow sync.js's single-`*`
  // convention (no `**`, no `..`).
  const NEWLY_MANAGED_GLOBS = [
    'scripts/chatgpt-review.ts',
    'scripts/chatgpt-review-api.ts',
    'scripts/chatgpt-reviewPure.ts',
    'scripts/__tests__/chatgpt-reviewPure.test.ts',
    'scripts/review-coordinator/*.ts',
    'schemas/*.json',
    'schemas/CHANGELOG.md',
  ];

  function expandGlob(pattern, rootDir) {
    if (pattern.includes('**')) throw new Error('** not supported');
    if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
      throw new Error(`refusing path: ${pattern}`);
    }
    const segments = pattern.split('/');
    const lastSeg = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const dirPath = dirSegments.length > 0 ? path.join(rootDir, ...dirSegments) : rootDir;
    if (!lastSeg.includes('*')) {
      return fs.existsSync(path.join(rootDir, pattern)) ? [pattern] : [];
    }
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { return []; }
    const starParts = lastSeg.split('*');
    const prefix = starParts[0];
    const suffix = starParts[starParts.length - 1];
    return entries
      .filter(e => e.startsWith(prefix) && e.endsWith(suffix) && e.length >= prefix.length + suffix.length)
      .map(e => [...dirSegments, e].join('/'))
      .sort();
  }

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

  // Step 1: Auto-adopt newly-managed files where local content matches framework.
  const expanded = [];
  for (const g of NEWLY_MANAGED_GLOBS) {
    for (const p of expandGlob(g, frameworkRoot)) expanded.push(p);
  }

  let autoAdoptedCount = 0;
  let alreadyInStateCount = 0;
  let conflictCount = 0;
  let absentLocallyCount = 0;
  const conflicts = [];

  for (const rel of expanded) {
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

  // Step 2: Seed .claude/project-registries.json from template if absent.
  const templatePath = path.join(frameworkRoot, '.claude', 'project-registries.json.template');
  const registriesPath = path.join(consumerRoot, '.claude', 'project-registries.json');
  if (fs.existsSync(templatePath)) {
    if (fs.existsSync(registriesPath)) {
      notes.push('.claude/project-registries.json already exists — left untouched.');
    } else {
      const tmpl = fs.readFileSync(templatePath, 'utf8');
      await fsp.mkdir(path.dirname(registriesPath), { recursive: true });
      await fsp.writeFile(registriesPath, tmpl, 'utf8');
      notes.push('Seeded .claude/project-registries.json from template (fill in null placeholders to enable per-repo PROJECT_CONTEXT injection for chatgpt-review).');
    }
  } else {
    notes.push('WARN: framework is missing .claude/project-registries.json.template — skipping registry seed.');
  }

  // Step 3: Atomically persist updated state if we changed it.
  if (autoAdoptedCount > 0) {
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, statePath);
  }

  const status = conflictCount > 0 ? 'conflict' : 'applied';
  return { status, notes };
}

module.exports = { migrate };
