#!/usr/bin/env node
/**
 * Test suite for memory-digest.js — SessionStart working-memory digest.
 *
 * Verifies: all three blocks present; silent on a bare project; KNOWLEDGE.md
 * tail-only + newest-N selection (oldest entries dropped); lessons head-of-
 * section (real entries in, trailing format-template decoy out); current-focus
 * leading HTML-comment strip; global 150-line cap under oversized inputs;
 * fail-open (exit 0, silent) on a nonexistent project dir; empty `## Lessons`
 * section emits nothing.
 *
 * Style mirrors framework-merge-reminder.test.js: end-to-end child process runs.
 *
 * Run: node .claude/hooks/memory-digest.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'memory-digest.js');

function runHook(projectDir) {
  return spawnSync(process.execPath, [HOOK], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function makeProj(prefix) {
  const proj = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(proj, 'tasks'), { recursive: true });
  return proj;
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

// ── 1. All three blocks present → each header + content emitted, exit 0 ──────
{
  const proj = makeProj('md-all-');
  writeFileSync(
    join(proj, 'tasks', 'current-focus.md'),
    '<!-- mission-control\nmachine block\n-->\n\nStatus: BUILDING\nFOCUS_MARKER line\n',
  );
  writeFileSync(
    join(proj, 'tasks', 'lessons.md'),
    '# Lessons Log\n## Lessons\n\n### 2026-07-01 - Newest\nLESSON_MARKER body\n',
  );
  writeFileSync(join(proj, 'KNOWLEDGE.md'), '## 2026-07-05\nKNOW_MARKER body\n');
  const r = runHook(proj);
  const out = r.stdout || '';
  check('all: exit 0', r.status, 0, r.stderr);
  check('all: focus header', out.includes('Current focus'), true, out);
  check('all: focus content', out.includes('FOCUS_MARKER'), true, out);
  check('all: lessons header', out.includes('Recent lessons'), true, out);
  check('all: lessons content', out.includes('LESSON_MARKER'), true, out);
  check('all: knowledge header', out.includes('Recent knowledge'), true, out);
  check('all: knowledge content', out.includes('KNOW_MARKER'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 2. Bare project (no memory files) → silent, exit 0 ──────────────────────
{
  const proj = makeProj('md-bare-');
  const r = runHook(proj);
  check('bare: exit 0', r.status, 0, r.stderr);
  check('bare: no output', (r.stdout || '').trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 3. KNOWLEDGE tail-only: newest 6 entries kept, oldest dropped ───────────
{
  const proj = makeProj('md-know-');
  let k = '';
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, '0');
    k += `## 2026-01-${n}\nENTRY_${n} body line\n\n`;
  }
  writeFileSync(join(proj, 'KNOWLEDGE.md'), k);
  const r = runHook(proj);
  const out = r.stdout || '';
  check('know: exit 0', r.status, 0, r.stderr);
  check('know: newest entry present', out.includes('ENTRY_10'), true, out);
  check('know: 6th-from-newest present', out.includes('ENTRY_05'), true, out);
  check('know: oldest entry dropped', out.includes('ENTRY_01'), false, out);
  check('know: 7th-from-newest dropped', out.includes('ENTRY_04'), false, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 4. Lessons head-not-template: real entries in, format decoy out ─────────
{
  const proj = makeProj('md-less-');
  writeFileSync(
    join(proj, 'tasks', 'lessons.md'),
    [
      '# Lessons Log',
      '## Lessons',
      '',
      '### 2026-07-01 - Real newest lesson',
      'REAL_NEWEST body',
      '',
      '### 2026-06-01 - Older real lesson',
      'REAL_OLDER body',
      '',
      '### [Date] - <title>',
      'TEMPLATE_DECOY must never appear',
      '',
    ].join('\n'),
  );
  const r = runHook(proj);
  const out = r.stdout || '';
  check('less: newest real lesson in', out.includes('REAL_NEWEST'), true, out);
  check('less: older real lesson in', out.includes('REAL_OLDER'), true, out);
  check('less: format template out', out.includes('TEMPLATE_DECOY'), false, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 5. Current-focus: leading HTML comment stripped, prose kept ─────────────
{
  const proj = makeProj('md-focus-');
  writeFileSync(
    join(proj, 'tasks', 'current-focus.md'),
    '<!-- mission-control\nMACHINE_BLOCK do not show\nmore machine junk\n-->\n\nStatus: REVIEWING\nPROSE_KEEP visible\n',
  );
  const r = runHook(proj);
  const out = r.stdout || '';
  check('focus: prose kept', out.includes('PROSE_KEEP'), true, out);
  check('focus: status kept', out.includes('Status: REVIEWING'), true, out);
  check('focus: comment stripped', out.includes('MACHINE_BLOCK'), false, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 6. Global cap: oversized inputs → output never exceeds 150 lines ─────────
{
  const proj = makeProj('md-cap-');
  let focus = '';
  for (let i = 1; i <= 120; i++) focus += `focus line ${i}\n`;
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), focus);
  let less = '# Lessons Log\n## Lessons\n\n';
  for (let i = 1; i <= 12; i++) less += `### 2026-05-${String(i).padStart(2, '0')} - L${i}\nlesson ${i} body line one\nlesson ${i} body line two\n\n`;
  writeFileSync(join(proj, 'tasks', 'lessons.md'), less);
  let know = '';
  for (let i = 1; i <= 12; i++) know += `## 2026-06-${String(i).padStart(2, '0')}\nknow ${i} body line one\nknow ${i} body line two\n\n`;
  writeFileSync(join(proj, 'KNOWLEDGE.md'), know);
  const r = runHook(proj);
  const lineCount = (r.stdout || '').replace(/\n$/, '').split('\n').length;
  check('cap: exit 0', r.status, 0, r.stderr);
  check('cap: <= 150 lines', lineCount <= 150, true, `got ${lineCount} lines`);
  rmSync(proj, { recursive: true, force: true });
}

// ── 7. Fail-open: nonexistent project dir → exit 0, silent ──────────────────
{
  const r = runHook(join(tmpdir(), 'md-does-not-exist-xyz'));
  check('nonexistent: exit 0', r.status, 0, r.stderr);
  check('nonexistent: no stdout', (r.stdout || '').trim(), '');
}

// ── 8. Empty `## Lessons` section → no lessons block emitted ────────────────
{
  const proj = makeProj('md-empty-less-');
  writeFileSync(join(proj, 'tasks', 'lessons.md'), '# Lessons Log\n## Lessons\n\n\n');
  const r = runHook(proj);
  check('empty-less: exit 0', r.status, 0, r.stderr);
  check('empty-less: no output', (r.stdout || '').trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 9. Index present + match found → matched block resurfaces an older entry ─
// The matched entry is OLDER than the newest-6, so it is absent from the
// recency block and only appears via the index → current-focus match.
{
  const proj = makeProj('md-idx-match-');
  mkdirSync(join(proj, 'references'), { recursive: true });
  // Line 1 = the old, matchable entry; then 6 newer entries push it out of newest-6.
  let k = '### 2026-01-02 Widget calibration drift\nWIDGET_DRIFT body about calibration offsets\n\n';
  for (let i = 1; i <= 6; i++) k += `### 2026-06-0${i} Recent entry ${i}\nrecent body ${i}\n\n`;
  writeFileSync(join(proj, 'KNOWLEDGE.md'), k);
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'Status: BUILDING\nSlug: widget-calibration-fix\n');
  writeFileSync(
    join(proj, 'references', 'knowledge-index.md'),
    '# knowledge index v1\n# file:line | date | title | keywords\nKNOWLEDGE.md:1 | 2026-01-02 | Widget calibration drift | widget, calibration, drift\n',
  );
  const r = runHook(proj);
  const out = r.stdout || '';
  check('idx-match: exit 0', r.status, 0, r.stderr);
  check('idx-match: matched header present', out.includes('index-matched to current focus'), true, out);
  check('idx-match: resurfaced entry body present', out.includes('WIDGET_DRIFT'), true, out);
  check('idx-match: file:line label present', out.includes('[KNOWLEDGE.md:1]'), true, out);
  check('idx-match: recency block still present', out.includes('Recent entry 6'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 10. Index present + no keyword match → no matched block ──────────────────
{
  const proj = makeProj('md-idx-nomatch-');
  mkdirSync(join(proj, 'references'), { recursive: true });
  let k = '### 2026-01-02 Widget calibration drift\nWIDGET_DRIFT body about calibration offsets\n\n';
  for (let i = 1; i <= 6; i++) k += `### 2026-06-0${i} Recent entry ${i}\nrecent body ${i}\n\n`;
  writeFileSync(join(proj, 'KNOWLEDGE.md'), k);
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'Status: BUILDING\nSlug: unrelated-config-cleanup\n');
  writeFileSync(
    join(proj, 'references', 'knowledge-index.md'),
    'KNOWLEDGE.md:1 | 2026-01-02 | Widget calibration drift | widget, calibration, drift\n',
  );
  const r = runHook(proj);
  const out = r.stdout || '';
  check('idx-nomatch: exit 0', r.status, 0, r.stderr);
  check('idx-nomatch: no matched block', out.includes('index-matched to current focus'), false, out);
  check('idx-nomatch: old entry not resurfaced', out.includes('WIDGET_DRIFT'), false, out);
  check('idx-nomatch: recency block still present', out.includes('Recent entry 6'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 11. Index absent → behaviour identical to today (recency-only) ───────────
{
  const proj = makeProj('md-idx-absent-');
  writeFileSync(join(proj, 'KNOWLEDGE.md'), '### 2026-07-05 Recent\nRECENT_MARKER body\n');
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'Slug: widget-calibration-fix\n');
  const r = runHook(proj);
  const out = r.stdout || '';
  check('idx-absent: exit 0', r.status, 0, r.stderr);
  check('idx-absent: no matched block', out.includes('index-matched to current focus'), false, out);
  check('idx-absent: recency content present', out.includes('RECENT_MARKER'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 12. Malformed index → fail-open (no matched block, digest as today) ──────
{
  const proj = makeProj('md-idx-malformed-');
  mkdirSync(join(proj, 'references'), { recursive: true });
  writeFileSync(join(proj, 'KNOWLEDGE.md'), '### 2026-07-05 Recent\nRECENT_MARKER body\n');
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), 'Slug: widget-calibration-fix\n');
  writeFileSync(
    join(proj, 'references', 'knowledge-index.md'),
    'this is not a valid index row\nnotaloc | 2026-01-01 | title | widget\njust,some,commas\n',
  );
  const r = runHook(proj);
  const out = r.stdout || '';
  check('idx-malformed: exit 0', r.status, 0, r.stderr);
  check('idx-malformed: no matched block', out.includes('index-matched to current focus'), false, out);
  check('idx-malformed: recency content still present', out.includes('RECENT_MARKER'), true, out);
  rmSync(proj, { recursive: true, force: true });
}

// ── 13. Global cap respected with an index producing matches → <= 150 lines ──
{
  const proj = makeProj('md-idx-cap-');
  mkdirSync(join(proj, 'references'), { recursive: true });
  let focus = 'domainmarker calibration\n';
  for (let i = 1; i <= 120; i++) focus += `focus line ${i}\n`;
  writeFileSync(join(proj, 'tasks', 'current-focus.md'), focus);
  let less = '# Lessons Log\n## Lessons\n\n';
  for (let i = 1; i <= 12; i++) less += `### 2026-05-${String(i).padStart(2, '0')} - L${i}\nlesson ${i} body line one\nlesson ${i} body line two\n\n`;
  writeFileSync(join(proj, 'tasks', 'lessons.md'), less);
  // Line 1 = old matchable entry; 12 newer entries drop it from newest-6.
  let know = '### 2026-01-01 Old matched entry\nMATCHED_OLD body line\n\n';
  for (let i = 1; i <= 12; i++) know += `### 2026-06-${String(i).padStart(2, '0')}\nknow ${i} body line one\nknow ${i} body line two\n\n`;
  writeFileSync(join(proj, 'KNOWLEDGE.md'), know);
  writeFileSync(
    join(proj, 'references', 'knowledge-index.md'),
    'KNOWLEDGE.md:1 | 2026-01-01 | Old matched entry | calibration, domainmarker\n',
  );
  const r = runHook(proj);
  const lineCount = (r.stdout || '').replace(/\n$/, '').split('\n').length;
  check('idx-cap: exit 0', r.status, 0, r.stderr);
  check('idx-cap: <= 150 lines', lineCount <= 150, true, `got ${lineCount} lines`);
  rmSync(proj, { recursive: true, force: true });
}

// ── Report ───────────────────────────────────────────────────────────────────

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
