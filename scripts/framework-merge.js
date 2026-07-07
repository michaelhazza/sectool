#!/usr/bin/env node
'use strict';

/**
 * framework-merge.js — three-way merge helper for `.framework-new` conflicts.
 *
 * When sync.js detects that a managed file was customised locally, it writes the
 * new framework content to a `<path>.framework-new` sibling and leaves the merge
 * to the operator. This helper automates the mechanical part of that merge:
 *
 *   LOCAL    = the consumer's current file (with local customisations)
 *   BASE     = the framework version the consumer last applied, reconstructed via
 *              `git -C <consumerRoot>/.claude-framework show <lastAppliedFrameworkCommit>:<path>`
 *   INCOMING = the `.framework-new` content (new framework version)
 *
 * `git merge-file -p local base incoming` produces the three-way merge. On a clean
 * merge the result is written to the target (atomic tmp + rename) and the
 * `.framework-new` sibling is deleted. On conflict markers, NOTHING is touched —
 * the file is reported as `manual` and the operator resolves it by hand.
 *
 * After merging, re-run `node .claude-framework/sync.js` (or `/claudeupdate`) so the
 * maintenance pass rebaselines the merged content hash into `.framework-state.json`.
 *
 * Invocation:
 *   node .claude-framework/scripts/framework-merge.js [consumerRoot] [--dry-run]
 *   node .claude-framework/scripts/framework-merge.js --help
 *
 * consumerRoot defaults to process.cwd(). The framework checkout is expected at
 * `<consumerRoot>/.claude-framework` (the standard submodule mount).
 *
 * Exit codes:
 *   0 — every conflict merged cleanly (or none found)
 *   1 — one or more files need manual resolution
 *   2 — hard error (bad arguments, missing framework mount, unreadable manifest)
 *
 * Dependency-free Node (like sync.js). Never destroys the local file: the target
 * is only replaced after a conflict-free merge, via tmp-file + rename.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Helpers (self-contained copies — this script must run standalone from the
// submodule without resolving sync.js relative to a consumer checkout)
// ---------------------------------------------------------------------------

/**
 * Strip BOM, normalise line endings, strip trailing whitespace per line,
 * collapse trailing blank lines to exactly one newline. Mirrors sync.js —
 * sync writes normalised content, so the reconstructed BASE must be
 * normalised the same way or every line would spuriously differ.
 * @param {string} raw
 * @returns {string}
 */
function normaliseContent(raw) {
  let s = raw.startsWith('﻿') ? raw.slice(1) : raw;
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
  s = s.replace(/\n+$/, '') + '\n';
  return s;
}

/**
 * Match a forward-slash relative path against a manifest glob pattern.
 * Supports `*` (within a path segment) and one `{a,b,c}` alternation —
 * the same subset expandGlob in sync.js supports. `**` is rejected.
 * @param {string} pattern
 * @param {string} relativePath
 * @returns {boolean}
 */
function matchesManifestGlob(pattern, relativePath) {
  if (pattern.includes('**')) return false;
  const braceMatch = pattern.match(/\{([^}]+)\}/);
  /** @type {string[]} */
  let patterns;
  if (braceMatch) {
    const prefix = pattern.slice(0, braceMatch.index);
    const suffix = pattern.slice(braceMatch.index + braceMatch[0].length);
    patterns = braceMatch[1].split(',').map(alt => prefix + alt + suffix);
  } else {
    patterns = [pattern];
  }
  for (const pat of patterns) {
    const regex = new RegExp(
      '^' + pat.split('*').map(part => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*') + '$'
    );
    if (regex.test(relativePath)) return true;
  }
  return false;
}

/**
 * Find the first manifest managedFiles entry whose glob matches `relativePath`.
 * Manifest order wins, matching sync.js's first-entry-wins deduplication.
 * @param {{managedFiles: Array<{path: string, substituteAt: string, mode: string}>}} manifest
 * @param {string} relativePath
 * @returns {{path: string, substituteAt: string, mode: string}|null}
 */
function findManifestEntry(manifest, relativePath) {
  for (const entry of manifest.managedFiles) {
    if (matchesManifestGlob(entry.path, relativePath)) return entry;
  }
  return null;
}

/**
 * Recursively collect `*.framework-new` paths under `root`, excluding .git,
 * the framework submodule mount, and node_modules.
 * @param {string} root
 * @returns {string[]} forward-slash relative paths, sorted
 */
function findFrameworkNewFiles(root) {
  /** @type {string[]} */
  const results = [];
  const skip = new Set(['.git', '.claude-framework', 'node_modules']);
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.framework-new')) {
        results.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return results.sort();
}

/**
 * Reconstruct the BASE: framework content for `relativePath` at `commit`,
 * read from the submodule's git object store. Consumer relative path and
 * framework relative path are the same string — sync.js deploys managed
 * files at identical relative paths on both sides.
 * @param {string} frameworkRoot
 * @param {string} commit
 * @param {string} relativePath
 * @returns {{ok: true, content: string}|{ok: false, reason: string}}
 */
function reconstructBase(frameworkRoot, commit, relativePath) {
  const result = spawnSync(
    'git',
    ['-C', frameworkRoot, 'show', `${commit}:${relativePath}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.error) return { ok: false, reason: `git show failed: ${result.error.message}` };
  if (result.status !== 0) {
    return { ok: false, reason: `base unavailable at framework commit ${String(commit).slice(0, 8)} (commit or path not in submodule history)` };
  }
  return { ok: true, content: String(result.stdout) };
}

/**
 * Atomic write: tmp file in the target's directory, then rename over the target.
 * On any failure the tmp file is removed and the original target is untouched.
 * @param {string} targetPath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.merge-tmp`;
  try {
    await fsp.writeFile(tmpPath, content, 'utf8');
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-file merge
// ---------------------------------------------------------------------------

/**
 * @typedef {{ file: string, result: 'merged'|'manual'|'skipped', note: string }} MergeReport
 */

/**
 * Attempt the three-way merge for one conflict file.
 * @param {object} ctx
 * @param {string} ctx.consumerRoot
 * @param {string} ctx.frameworkRoot
 * @param {any} ctx.manifest
 * @param {any} ctx.state
 * @param {boolean} ctx.dryRun
 * @param {string} newFileRel  e.g. ".claude/commands/claudeupdate.md.framework-new"
 * @returns {Promise<MergeReport>}
 */
async function mergeOne(ctx, newFileRel) {
  const targetRel = newFileRel.slice(0, -'.framework-new'.length);
  const targetPath = path.join(ctx.consumerRoot, targetRel);
  const newFilePath = path.join(ctx.consumerRoot, newFileRel);

  // Manifest lookup: identifies substituted files and confirms the path is managed.
  const entry = findManifestEntry(ctx.manifest, targetRel);
  if (!entry) {
    return { file: targetRel, result: 'manual', note: 'not matched by any manifest managedFiles glob' };
  }

  // Substituted files: the framework source contains {{PLACEHOLDER}} tokens that
  // sync.js replaced at adoption. The git-show BASE would carry the raw placeholders
  // (and the substitution map may have changed since last apply), so every
  // substituted line would look locally edited. Base reconstruction is unreliable —
  // skip and let the operator merge by hand.
  if (entry.substituteAt !== 'never') {
    return { file: targetRel, result: 'skipped', note: `substituted file (substituteAt: ${entry.substituteAt}) — base reconstruction unreliable, merge manually` };
  }

  // State lookup: need the framework commit the consumer last applied.
  const stateEntry = ctx.state && ctx.state.files ? ctx.state.files[targetRel] : null;
  if (!stateEntry) {
    return { file: targetRel, result: 'manual', note: 'no entry in .framework-state.json — no base to merge from' };
  }
  if (!stateEntry.lastAppliedFrameworkCommit) {
    return { file: targetRel, result: 'manual', note: 'state entry has no lastAppliedFrameworkCommit — no base to merge from' };
  }

  // LOCAL must exist; a missing target means the operator deleted it — their call.
  let localRaw;
  try {
    localRaw = await fsp.readFile(targetPath, 'utf8');
  } catch {
    return { file: targetRel, result: 'manual', note: 'local file missing — review the .framework-new directly' };
  }

  // INCOMING = the .framework-new content sync.js wrote (already substitution-free
  // for substituteAt: never entries, already normalised).
  let incomingRaw;
  try {
    incomingRaw = await fsp.readFile(newFilePath, 'utf8');
  } catch (err) {
    return { file: targetRel, result: 'manual', note: `cannot read .framework-new: ${err.message}` };
  }

  // BASE from the submodule's history.
  const base = reconstructBase(ctx.frameworkRoot, stateEntry.lastAppliedFrameworkCommit, targetRel);
  if (!base.ok) {
    return { file: targetRel, result: 'manual', note: base.reason };
  }

  const localNorm = normaliseContent(localRaw);
  const baseNorm = normaliseContent(base.content);
  const incomingNorm = normaliseContent(incomingRaw);

  // Three-way merge via git merge-file on temp copies. -p prints the result to
  // stdout and leaves the temp files untouched; exit status is the number of
  // conflicts (0 = clean), negative on error.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'framework-merge-'));
  try {
    const localTmp = path.join(tmpDir, 'local');
    const baseTmp = path.join(tmpDir, 'base');
    const incomingTmp = path.join(tmpDir, 'incoming');
    await fsp.writeFile(localTmp, localNorm, 'utf8');
    await fsp.writeFile(baseTmp, baseNorm, 'utf8');
    await fsp.writeFile(incomingTmp, incomingNorm, 'utf8');

    const merge = spawnSync(
      'git',
      ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'framework', localTmp, baseTmp, incomingTmp],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (merge.error) {
      return { file: targetRel, result: 'manual', note: `git merge-file failed: ${merge.error.message}` };
    }
    if (merge.status === null || merge.status < 0) {
      return { file: targetRel, result: 'manual', note: `git merge-file errored (status ${merge.status})` };
    }
    if (merge.status > 0) {
      return { file: targetRel, result: 'manual', note: `${merge.status} conflict hunk(s) — local and framework edited the same lines` };
    }

    // Clean merge.
    if (ctx.dryRun) {
      return { file: targetRel, result: 'merged', note: 'clean merge (dry-run: nothing written)' };
    }
    await writeAtomic(targetPath, normaliseContent(String(merge.stdout)));
    try {
      await fsp.unlink(newFilePath);
    } catch (err) {
      // Target is already merged; a surviving sibling only means sync.js will
      // report "merge in flight" until it's removed. Surface, don't fail.
      return { file: targetRel, result: 'merged', note: `merged, but could not delete ${newFileRel}: ${err.message} — delete it manually` };
    }
    return { file: targetRel, result: 'merged', note: 'clean merge — local + framework changes combined' };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: node framework-merge.js [consumerRoot] [--dry-run]\n\n' +
      'Three-way merges every <path>.framework-new conflict in the consumer repo.\n' +
      'Clean merges are applied and the .framework-new sibling deleted; conflicts\n' +
      'are left untouched and reported for manual resolution.\n'
    );
    process.exit(0);
  }
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));
  if (positional.length > 1) {
    process.stderr.write('ERROR: at most one positional argument (consumerRoot) is accepted\n');
    process.exit(2);
  }
  const consumerRoot = path.resolve(positional[0] || process.cwd());

  const frameworkRoot = path.join(consumerRoot, '.claude-framework');
  if (!fs.existsSync(path.join(frameworkRoot, 'manifest.json'))) {
    process.stderr.write(
      `ERROR: ${frameworkRoot} does not contain manifest.json — is ${consumerRoot} a consumer repo with the framework submodule mounted?\n`
    );
    process.exit(2);
  }

  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(frameworkRoot, 'manifest.json'), 'utf8'));
  } catch (err) {
    process.stderr.write(`ERROR: cannot parse manifest.json: ${err.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(manifest.managedFiles)) {
    process.stderr.write('ERROR: manifest.json has no managedFiles array\n');
    process.exit(2);
  }

  /** @type {any} */
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(consumerRoot, '.claude', '.framework-state.json'), 'utf8'));
  } catch {
    process.stderr.write('WARN: .claude/.framework-state.json missing or unreadable — every conflict falls back to manual\n');
  }

  const conflicts = findFrameworkNewFiles(consumerRoot);
  if (conflicts.length === 0) {
    process.stdout.write('No .framework-new files found — nothing to merge.\n');
    process.exit(0);
  }

  const ctx = { consumerRoot, frameworkRoot, manifest, state, dryRun };
  /** @type {MergeReport[]} */
  const reports = [];
  for (const rel of conflicts) {
    const report = await mergeOne(ctx, rel);
    process.stdout.write(`MERGE file=${report.file} result=${report.result} note=${report.note}\n`);
    reports.push(report);
  }

  const merged = reports.filter(r => r.result === 'merged').length;
  const manual = reports.filter(r => r.result === 'manual').length;
  const skipped = reports.filter(r => r.result === 'skipped').length;

  const width = Math.max(4, ...reports.map(r => r.file.length));
  process.stdout.write('\n' + 'File'.padEnd(width) + '  Result   Note\n');
  for (const r of reports) {
    process.stdout.write(r.file.padEnd(width) + `  ${r.result.padEnd(7)}  ${r.note}\n`);
  }
  process.stdout.write(
    `\nSUMMARY: ${merged} merged, ${manual} manual, ${skipped} skipped (substituted)${dryRun ? ' [dry-run]' : ''}\n`
  );
  if (merged > 0 && !dryRun) {
    process.stdout.write('Re-run `node .claude-framework/sync.js` (or /claudeupdate) to rebaseline merged files into .framework-state.json.\n');
  }
  if (manual + skipped > 0) {
    process.stdout.write('Manual/skipped files are untouched — merge them by hand, delete the .framework-new sibling, then re-run sync.\n');
  }
  process.exit(manual + skipped > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.stack || err.message}\n`);
  process.exit(2);
});
