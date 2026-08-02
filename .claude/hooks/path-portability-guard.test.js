#!/usr/bin/env node
/**
 * Test suite for path-portability-guard.js — Windows-invalid filename guard.
 *
 * Verifies: colon-in-filename blocked (the 2026-08-01 incident shape),
 * hyphenated timestamp allowed, Windows drive-letter and UNC prefixes do
 * NOT false-positive, reserved device names blocked (bare and with
 * extension), trailing dot/space blocked, non-Write tools pass through,
 * and fail-open on malformed stdin.
 *
 * Style mirrors long-doc-guard.test.js: runs the hook end-to-end as a
 * child process and asserts on exit codes.
 *
 * Run: node .claude/hooks/path-portability-guard.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'path-portability-guard.js');

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8' });
}

function write(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } };
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

// ── Blocked: the incident shape — colon in an ISO timestamp ────────────────
check(
  'colon timestamp blocked (relative path)',
  runHook(write('tasks/review-logs/dual-review-log-slug-2026-08-01T21:14:58Z.md')).status,
  2,
);
check(
  'colon timestamp blocked (absolute POSIX path)',
  runHook(write('/home/runner/repo/tasks/review-logs/log-2026-08-01T21:14:58Z.md')).status,
  2,
);

// ── Allowed: correct hyphenated convention ─────────────────────────────────
check(
  'hyphen timestamp allowed',
  runHook(write('tasks/review-logs/dual-review-log-slug-2026-08-01T21-14-58Z.md')).status,
  0,
);

// ── Drive letters and UNC prefixes must not false-positive ─────────────────
check(
  'Windows drive-letter path allowed',
  runHook(write('C:\\Files\\Projects\\repo\\server\\lib\\helper.ts')).status,
  0,
);
check(
  'Windows drive letter with forward slashes allowed',
  runHook(write('c:/Files/Projects/repo/docs/readme.md')).status,
  0,
);
check(
  'UNC path allowed',
  runHook(write('\\\\server\\share\\repo\\docs\\readme.md')).status,
  0,
);
check(
  'long-path prefix with drive allowed',
  runHook(write('\\\\?\\C:\\repo\\docs\\readme.md')).status,
  0,
);

// ── Other violation classes ────────────────────────────────────────────────
check('reserved name bare blocked', runHook(write('server/nul')).status, 2);
check('reserved name with extension blocked', runHook(write('server/aux.ts')).status, 2);
check('com10 is not reserved — allowed', runHook(write('server/com10.ts')).status, 0);
check('trailing dot component blocked', runHook(write('docs./readme.md')).status, 2);
check('trailing space filename blocked', runHook(write('docs/readme.md ')).status, 2);
check('question mark blocked', runHook(write('docs/what?.md')).status, 2);

// ── Pass-through and fail-open ─────────────────────────────────────────────
check(
  'non-Write tool passes through',
  runHook({ tool_name: 'Edit', tool_input: { file_path: 'a:b/c.md' } }).status,
  0,
);
check('missing file_path passes through', runHook({ tool_name: 'Write', tool_input: {} }).status, 0);
check('malformed stdin fails open', runHook('{not json').status, 0);

// ── Blocked output names the fix ───────────────────────────────────────────
const blocked = runHook(write('tasks/log-2026-08-01T21:14:58Z.md'));
check(
  'blocked message mentions hyphen convention',
  /hyphens between time fields/.test(blocked.stderr),
  true,
  blocked.stderr,
);

if (fails.length > 0) {
  console.error(`path-portability-guard.test.js: ${fails.length} FAILED, ${pass} passed`);
  for (const f of fails) {
    console.error(`  FAIL: ${f.label} — expected ${f.expected}, got ${f.actual} ${f.reason}`);
  }
  process.exit(1);
}
console.log(`path-portability-guard.test.js: all ${pass} checks passed`);
