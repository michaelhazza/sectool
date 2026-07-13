#!/usr/bin/env node
/**
 * Test suite for framework-merge-reminder.js — SessionStart .framework-new
 * warning.
 *
 * Verifies: no output when the tree is clean; a single warning line naming
 * count and first few paths when *.framework-new files exist; skip of
 * .git/node_modules/.claude-framework; depth bound; "+N more" truncation;
 * fail-open (exit 0) on a nonexistent project dir.
 *
 * Style mirrors config-protection.test.js: end-to-end child process runs.
 *
 * Run: node .claude/hooks/framework-merge-reminder.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'framework-merge-reminder.js');

function runHook(projectDir) {
  return spawnSync(process.execPath, [HOOK], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

let pass = 0;
const fails = [];

function check(label, actual, expected, extra) {
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ label, expected, actual, reason: extra || '' });
  }
}

// ── 1. Clean tree → silent, exit 0 ─────────────────────────────────────────
{
  const proj = mkdtempSync(join(tmpdir(), 'fmr-clean-'));
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'guide.md'), '# fine\n');
  const r = runHook(proj);
  check('clean tree: exit 0', r.status, 0, r.stderr);
  check('clean tree: no output', (r.stdout || '').trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 2. Pending merges → one warning line with count + paths + /claudemerge ─
{
  const proj = mkdtempSync(join(tmpdir(), 'fmr-pending-'));
  mkdirSync(join(proj, 'docs', 'nested'), { recursive: true });
  writeFileSync(join(proj, 'CLAUDE.md.framework-new'), 'x');
  writeFileSync(join(proj, 'docs', 'nested', 'guide.md.framework-new'), 'x');
  const r = runHook(proj);
  check('pending: exit 0', r.status, 0, r.stderr);
  const out = (r.stdout || '').trim();
  check('pending: exactly one line', out.split('\n').length, 1, out);
  check('pending: counts 2 files', /\b2 unmerged/.test(out), true, out);
  check('pending: names root file', out.includes('CLAUDE.md.framework-new'), true, out);
  check('pending: names nested file', out.includes('docs/nested/guide.md.framework-new'), true, out);
  check('pending: points at /claudemerge', out.includes('/claudemerge'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 3. Skipped directories are not scanned ─────────────────────────────────
{
  const proj = mkdtempSync(join(tmpdir(), 'fmr-skip-'));
  for (const skip of ['.git', 'node_modules', '.claude-framework']) {
    mkdirSync(join(proj, skip), { recursive: true });
    writeFileSync(join(proj, skip, 'ignored.md.framework-new'), 'x');
  }
  const r = runHook(proj);
  check('skip dirs: exit 0', r.status, 0, r.stderr);
  check('skip dirs: no output', (r.stdout || '').trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 4. Depth bound: files beyond MAX_DEPTH (6) are not reported ────────────
{
  const proj = mkdtempSync(join(tmpdir(), 'fmr-depth-'));
  // depth 7 directories → file at depth beyond the bound
  const deep = join(proj, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'too-deep.md.framework-new'), 'x');
  // and one within bounds
  writeFileSync(join(proj, 'a', 'shallow.md.framework-new'), 'x');
  const r = runHook(proj);
  check('depth bound: exit 0', r.status, 0, r.stderr);
  const out = (r.stdout || '').trim();
  check('depth bound: shallow file found', out.includes('a/shallow.md.framework-new'), true, out);
  check('depth bound: deep file ignored', out.includes('too-deep'), false, out);
  check('depth bound: count is 1', /\b1 unmerged/.test(out), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 5. Truncation: more than 3 files → first 3 + "+N more" ─────────────────
{
  const proj = mkdtempSync(join(tmpdir(), 'fmr-many-'));
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(proj, `f${i}.md.framework-new`), 'x');
  }
  const r = runHook(proj);
  const out = (r.stdout || '').trim();
  check('truncation: counts 5', /\b5 unmerged/.test(out), true, out);
  check('truncation: shows +2 more', out.includes('+2 more'), true, out);
  check('truncation: still one line', out.split('\n').length, 1, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 6. Fail-open: nonexistent project dir → exit 0, silent stdout ──────────
{
  const r = runHook(join(tmpdir(), 'fmr-does-not-exist-xyz'));
  check('nonexistent dir: exit 0', r.status, 0, r.stderr);
  check('nonexistent dir: no stdout', (r.stdout || '').trim(), '');
}

// ── Report ─────────────────────────────────────────────────────────────────

const totalCases = pass + fails.length;
console.log(`Cases: ${totalCases}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `FAIL actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)} | ${f.label} | ${f.reason}`,
    );
  }
  process.exit(1);
}
process.exit(0);
