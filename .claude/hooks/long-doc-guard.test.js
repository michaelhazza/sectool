#!/usr/bin/env node
/**
 * Test suite for long-doc-guard.js — chunked-workflow guard for long docs.
 *
 * Verifies: the 10,000-char threshold boundary (exactly at → allow, one
 * over → block), doc-extension detection (.md/.rst/.txt and extensionless
 * README/CHANGELOG basenames), non-doc pass-through (.ts/.js of any size),
 * non-Write tools pass through, and fail-open on malformed stdin.
 *
 * Style mirrors config-protection.test.js: runs the hook end-to-end as a
 * child process and asserts on exit codes.
 *
 * Run: node .claude/hooks/long-doc-guard.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'long-doc-guard.js');
const THRESHOLD = 10000;

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8' });
}

function write(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
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

const SMALL = 'x'.repeat(100);
const AT_THRESHOLD = 'x'.repeat(THRESHOLD);
const OVER_THRESHOLD = 'x'.repeat(THRESHOLD + 1);
const BIG = 'x'.repeat(THRESHOLD * 3);

const CASES = [
  // Threshold boundary
  ["Write .md exactly at threshold → exit 0 (<= is allowed)", write('docs/guide.md', AT_THRESHOLD), 0],
  ["Write .md one char over threshold → exit 2", write('docs/guide.md', OVER_THRESHOLD), 2],
  ["Write small .md → exit 0", write('docs/guide.md', SMALL), 0],

  // Doc-extension detection
  ["Write big .mdx → exit 2", write('docs/page.mdx', BIG), 2],
  ["Write big .markdown → exit 2", write('notes.markdown', BIG), 2],
  ["Write big .rst → exit 2", write('docs/index.rst', BIG), 2],
  ["Write big .adoc → exit 2", write('manual.adoc', BIG), 2],
  ["Write big .txt → exit 2", write('notes.txt', BIG), 2],
  ["Write big .MD (case-insensitive ext) → exit 2", write('README.MD', BIG), 2],

  // Extensionless doc basenames
  ["Write big extensionless README → exit 2", write('README', BIG), 2],
  ["Write big extensionless CHANGELOG → exit 2", write('sub/dir/CHANGELOG', BIG), 2],
  ["Write big extensionless LICENSE → exit 2", write('LICENSE', BIG), 2],

  // Non-doc pass-through regardless of size
  ["Write big .ts → exit 0 (not a doc)", write('src/generated.ts', BIG), 0],
  ["Write big .js → exit 0 (not a doc)", write('dist/bundle.js', BIG), 0],
  ["Write big .json → exit 0 (not a doc)", write('data/fixtures.json', BIG), 0],
  ["Write big extensionless non-doc name → exit 0", write('Makefile2', BIG), 0],

  // Non-Write tools pass through
  ["Edit tool → exit 0 (only Write is guarded)", { tool_name: 'Edit', tool_input: { file_path: 'docs/guide.md', old_string: 'a', new_string: BIG } }, 0],
  ["Bash tool → exit 0", { tool_name: 'Bash', tool_input: { command: 'echo hi' } }, 0],

  // Fail-open on malformed input
  ["malformed stdin → exit 0 (fail-open)", '{not json', 0],
  ["empty stdin → exit 0", '', 0],
  ["payload missing tool_input → exit 0", { tool_name: 'Write' }, 0],
  ["payload with non-string content → exit 0 (fail-open)", { tool_name: 'Write', tool_input: { file_path: 'docs/a.md', content: null } }, 0],
];

for (const [label, input, expectedExit] of CASES) {
  const result = runHook(input);
  check(label, result.status, expectedExit, result.stderr && result.stderr.slice(0, 200));
}

// Block message quality: names the file, the size, and the chunked workflow
{
  const r = runHook(write('docs/big-spec.md', BIG));
  check('block message names the basename', /big-spec\.md/.test(r.stderr || ''), true, r.stderr && r.stderr.slice(0, 200));
  check('block message cites the threshold', new RegExp(String(THRESHOLD)).test(r.stderr || ''), true);
  check('block message demands TodoWrite chunking', /TodoWrite/.test(r.stderr || ''), true);
}

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
