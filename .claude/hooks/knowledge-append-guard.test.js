#!/usr/bin/env node
/**
 * Test suite for knowledge-append-guard.js — KNOWLEDGE.md append-only guard.
 *
 * Verifies: pure appends are allowed (empty-ish old_string, tail-anchored
 * Edit, Write extending existing content, Write to a new file); edits whose
 * old_string is not a pure tail append are blocked (body edits included); MultiEdit
 * inherits the same rules; non-KNOWLEDGE.md files pass through; the one-shot
 * HITL sentinel authorises exactly one blocked edit; malformed stdin fails
 * open.
 *
 * Style mirrors config-protection.test.js: end-to-end child process runs
 * with CLAUDE_PROJECT_DIR pointed at a throwaway temp dir containing a real
 * KNOWLEDGE.md fixture.
 *
 * Run: node .claude/hooks/knowledge-append-guard.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'knowledge-append-guard.js');

const PROJ = mkdtempSync(join(tmpdir(), 'knowledge-guard-test-'));
mkdirSync(join(PROJ, '.claude'), { recursive: true });
const SENTINEL = join(PROJ, '.claude', 'knowledge-edit-approved');
const KNOWLEDGE = join(PROJ, 'KNOWLEDGE.md');

const EXISTING = [
  '# KNOWLEDGE.md',
  '',
  '### [2026-01-10] Correction — always source .env before key checks',
  'Details about env sourcing.',
  '',
  '### [2026-03-02] Pattern — hooks fail open',
  'A hook bug must never block a legitimate edit.',
  '',
].join('\n');

writeFileSync(KNOWLEDGE, EXISTING);

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJ },
  });
}

function payload(toolName, toolInput) {
  return { tool_name: toolName, tool_input: toolInput };
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

const TAIL = 'A hook bug must never block a legitimate edit.';
const NEW_ENTRY = '\n### [2026-07-07] New pattern — appended entry\nBody.\n';

const CASES = [
  // ── Allowed: pure appends ────────────────────────────────────────────────
  [
    'Edit with empty old_string → exit 0 (append)',
    payload('Edit', { file_path: KNOWLEDGE, old_string: '', new_string: NEW_ENTRY }),
    0,
  ],
  [
    'Edit with whitespace-only old_string → exit 0 (append)',
    payload('Edit', { file_path: KNOWLEDGE, old_string: '\n\n', new_string: NEW_ENTRY }),
    0,
  ],
  [
    'Edit anchored on the file tail, new_string extends it → exit 0 (append)',
    payload('Edit', { file_path: KNOWLEDGE, old_string: TAIL, new_string: TAIL + NEW_ENTRY }),
    0,
  ],
  [
    'Edit anchored on tail INCLUDING the last heading, pure extension → exit 0',
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '### [2026-03-02] Pattern — hooks fail open\nA hook bug must never block a legitimate edit.',
      new_string: '### [2026-03-02] Pattern — hooks fail open\nA hook bug must never block a legitimate edit.' + NEW_ENTRY,
    }),
    0,
  ],
  [
    'Write whose content starts with existing content → exit 0 (append)',
    payload('Write', { file_path: KNOWLEDGE, content: EXISTING + NEW_ENTRY }),
    0,
  ],
  [
    'Write to a KNOWLEDGE.md that does not exist yet → exit 0',
    payload('Write', { file_path: join(PROJ, 'sub', 'KNOWLEDGE.md'), content: '# fresh\n' }),
    0,
  ],

  // ── Blocked: body rewrites are still rewrites (append-only means append-only)
  [
    'Edit rewriting a body line (typo fix) without spanning a heading → exit 2',
    payload('Edit', { file_path: KNOWLEDGE, old_string: 'Details about env sourcing.', new_string: 'Details about .env sourcing.' }),
    2,
  ],
  [
    'Edit deleting a body line inside an existing entry → exit 2',
    payload('Edit', { file_path: KNOWLEDGE, old_string: 'Details about env sourcing.\n', new_string: '' }),
    2,
  ],

  // ── Blocked: rewriting/deleting history ──────────────────────────────────
  [
    'Edit rewriting a dated entry heading mid-file → exit 2',
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '### [2026-01-10] Correction — always source .env before key checks',
      new_string: '### [2026-01-10] Correction — reworded title',
    }),
    2,
  ],
  [
    'Edit deleting an entire dated entry → exit 2',
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '### [2026-01-10] Correction — always source .env before key checks\nDetails about env sourcing.\n',
      new_string: '',
    }),
    2,
  ],
  [
    'Edit spanning a heading, new_string does NOT start with old_string → exit 2',
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '### [2026-03-02] Pattern — hooks fail open\nA hook bug must never block a legitimate edit.',
      new_string: 'Completely different text',
    }),
    2,
  ],
  [
    'Write that drops existing history → exit 2',
    payload('Write', { file_path: KNOWLEDGE, content: '# KNOWLEDGE.md\n\nStarting over.\n' }),
    2,
  ],
  [
    'MultiEdit where one edit rewrites a heading → exit 2',
    payload('MultiEdit', {
      file_path: KNOWLEDGE,
      edits: [
        { old_string: 'Details about env sourcing.', new_string: 'Fine change.' },
        { old_string: '### [2026-03-02] Pattern — hooks fail open', new_string: '### removed' },
      ],
    }),
    2,
  ],

  // ── Pass-through ─────────────────────────────────────────────────────────
  [
    'Edit to a non-KNOWLEDGE file with a heading-shaped old_string → exit 0',
    payload('Edit', { file_path: join(PROJ, 'docs', 'notes.md'), old_string: '### [2026-01-01] x', new_string: 'y' }),
    0,
  ],
  [
    'Bash tool → exit 0 (not guarded here)',
    payload('Bash', { command: 'rm KNOWLEDGE.md' }),
    0,
  ],

  // ── Fail-open ────────────────────────────────────────────────────────────
  ['malformed stdin → exit 0 (fail-open)', '{not json', 0],
  ['empty stdin → exit 0', '', 0],
  [
    'payload missing tool_input → exit 0',
    { tool_name: 'Edit' },
    0,
  ],
];

for (const [label, input, expectedExit] of CASES) {
  const result = runHook(input);
  check(label, result.status, expectedExit, result.stderr && result.stderr.slice(0, 200));
}

// Block message mirrors the HITL convention
{
  const r = runHook(
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '### [2026-01-10] Correction — always source .env before key checks',
      new_string: 'gone',
    }),
  );
  check('block message names HITL approval', /HITL-APPROVAL-REQUIRED/.test(r.stderr || ''), true, r.stderr && r.stderr.slice(0, 200));
  check('block message cites append-only rule', /append-only/.test(r.stderr || ''), true);
  check('block message names the sentinel file', /knowledge-edit-approved/.test(r.stderr || ''), true);
}

// ── One-shot sentinel flow ─────────────────────────────────────────────────
{
  const blockedEdit = payload('Edit', {
    file_path: KNOWLEDGE,
    old_string: '### [2026-01-10] Correction — always source .env before key checks',
    new_string: '### [2026-01-10] Correction — redacted',
  });

  writeFileSync(SENTINEL, 'KNOWLEDGE.md\n');
  const first = runHook(blockedEdit);
  check('sentinel: blocked edit → exit 0 (approval consumed)', first.status, 0, first.stderr && first.stderr.slice(0, 200));
  check('sentinel consumed message on stderr', /one-shot approval consumed/.test(first.stderr || ''), true, first.stderr);
  check('sentinel deleted after consume (one-shot)', existsSync(SENTINEL), false);

  const second = runHook(blockedEdit);
  check('retry without fresh sentinel → exit 2', second.status, 2);

  // Path binding: a sentinel naming a different file must not authorise
  writeFileSync(SENTINEL, 'docs/KNOWLEDGE.md\n');
  const wrong = runHook(blockedEdit);
  check('mismatched sentinel → exit 2', wrong.status, 2);
  check('mismatched sentinel NOT consumed', existsSync(SENTINEL), true);
  rmSync(SENTINEL, { force: true });
}

// ── Dedup advisory (F8): non-blocking, fires on a likely duplicate ──────────
{
  // Appended entry title shares ≥2 significant tokens with the line-3 entry
  // ("Correction — always source .env before key checks").
  const dup = runHook(
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '',
      new_string: '\n### [2026-07-08] Correction — source .env before checking keys\nBody about sourcing.\n',
    }),
  );
  check('dedup: duplicate append still exits 0 (advisory never blocks)', dup.status, 0, dup.stderr);
  check('dedup: advisory warning fired', /advisory/.test(dup.stderr || ''), true, dup.stderr);
  check('dedup: advisory cites the existing entry file:line', /KNOWLEDGE\.md:3/.test(dup.stderr || ''), true, dup.stderr);
  check('dedup: advisory names the existing title', /Correction — always source \.env/.test(dup.stderr || ''), true, dup.stderr);
}

// Non-duplicate append → no advisory, exit 0.
{
  const fresh = runHook(
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '',
      new_string: '\n### [2026-07-09] Observability — structured log levels\nBody.\n',
    }),
  );
  check('dedup: non-duplicate append exits 0', fresh.status, 0, fresh.stderr);
  check('dedup: non-duplicate append fires no advisory', /advisory/.test(fresh.stderr || ''), false, fresh.stderr);
}

// Advisory fail-open: an append with no parseable entry heading → allowed, silent.
{
  const noHeading = runHook(
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: '',
      new_string: '\nJust a trailing note with no heading line at all.\n',
    }),
  );
  check('dedup: no-heading append exits 0 (fail-open advisory)', noHeading.status, 0, noHeading.stderr);
  check('dedup: no-heading append fires no advisory', /advisory/.test(noHeading.stderr || ''), false, noHeading.stderr);
}

// A blocked rewrite is not an append → no dedup advisory, block path unchanged.
{
  const blockedRewrite = runHook(
    payload('Edit', {
      file_path: KNOWLEDGE,
      old_string: 'Details about env sourcing.',
      new_string: 'Details about .env sourcing.',
    }),
  );
  check('dedup: blocked rewrite still exits 2 (block path unchanged)', blockedRewrite.status, 2, blockedRewrite.stderr);
  check(
    'dedup: blocked rewrite emits HITL, not a dedup advisory',
    /HITL-APPROVAL-REQUIRED/.test(blockedRewrite.stderr || '') && !/knowledge-append-guard: advisory/.test(blockedRewrite.stderr || ''),
    true,
    blockedRewrite.stderr,
  );
}

// ── Cleanup + report ───────────────────────────────────────────────────────

rmSync(PROJ, { recursive: true, force: true });

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
