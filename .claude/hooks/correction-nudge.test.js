#!/usr/bin/env node
/**
 * Test suite for correction-nudge.js — KNOWLEDGE.md correction reminder.
 *
 * Verifies: the correction-phrase matrix triggers the nudge (stdout contains
 * <correction-detected>), plausible-but-innocent phrasings do NOT trigger it
 * (the heuristic is intentionally conservative), payloads without a prompt
 * (e.g. a PreToolUse-shaped payload reaching the hook) pass through silently,
 * the hook never exits non-zero, and malformed stdin fails open.
 *
 * Style mirrors config-protection.test.js: runs the hook end-to-end as a
 * child process.
 *
 * Run: node .claude/hooks/correction-nudge.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'correction-nudge.js');

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8' });
}

function prompt(text) {
  return { hook_event_name: 'UserPromptSubmit', prompt: text };
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

/** Assert the hook exits 0 and whether the nudge was emitted. */
function checkNudge(label, input, expectNudge) {
  const r = runHook(input);
  check(`${label} — exit 0`, r.status, 0, r.stderr && r.stderr.slice(0, 200));
  check(
    `${label} — nudge ${expectNudge ? 'emitted' : 'NOT emitted'}`,
    /<correction-detected>/.test(r.stdout || ''),
    expectNudge,
    (r.stdout || '').slice(0, 120),
  );
}

// ── Correction-phrase matrix: should trigger ───────────────────────────────
const CORRECTIONS = [
  "that's wrong, the route lives in server/routes.ts",
  "thats incorrect — you edited the wrong file",     // apostrophe-less variant of "that's"
  "you should have run the tests first",
  "you shouldn't have deleted that migration",
  "you were wrong about the schema",
  "stop doing that, it breaks the build",
  "don't do that again",
  "that's not what I asked for",
  "I told you to use vitest, not node:test",
  "as I said before, the config is in .claude/",
  "no, that's wrong — use the other endpoint",
  "nope, use the helper instead",
  "why did you remove the null check?",
  "that's not how the sync engine works",
  "read the docs before changing this",
  "read the spec again",
  "you misunderstood the requirement",
  "undo that last change",
  "revert your edit to sync.js",
];

// ── Innocent phrasings: must NOT trigger (conservative heuristic) ──────────
const INNOCENT = [
  "please add a new feature to the parser",
  "let's write tests for the new hook",
  "I read the documentation yesterday and it looks fine", // 'documentation' ≠ 'docs' at a word boundary
  "the wrong-answer handler needs a retry loop",          // 'wrong' without correction phrasing
  "can you revert-engineer this? just kidding, reverse-engineer",
  "what did you change in the last commit?",
  "this looks great, thanks!",
  "add instructions for how to undo a migration in the README",
];

for (const text of CORRECTIONS) {
  checkNudge(`correction: "${text.slice(0, 40)}..."`, prompt(text), true);
}
for (const text of INNOCENT) {
  checkNudge(`innocent: "${text.slice(0, 40)}..."`, prompt(text), false);
}

// ── Pass-through shapes ────────────────────────────────────────────────────
// A non-UserPromptSubmit payload has no `prompt` field — the hook must stay
// silent and exit 0 (it keys off the prompt field, not the event name).
checkNudge(
  'PreToolUse-shaped payload (no prompt field)',
  { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } },
  false,
);
checkNudge('empty prompt', prompt(''), false);
checkNudge('non-string prompt (fail-open)', { prompt: 42 }, false);

// ── Fail-open on malformed stdin ───────────────────────────────────────────
{
  const r = runHook('{not json');
  check('malformed stdin — exit 0', r.status, 0);
  check('malformed stdin — no output', (r.stdout || '').length, 0);
}
{
  const r = runHook('');
  check('empty stdin — exit 0', r.status, 0);
  check('empty stdin — no output', (r.stdout || '').length, 0);
}

// Nudge content sanity: points at KNOWLEDGE.md and the append-only rule
{
  const r = runHook(prompt("that's wrong"));
  check('nudge cites KNOWLEDGE.md', /KNOWLEDGE\.md/.test(r.stdout || ''), true);
  check('nudge cites append-only rule', /only append/.test(r.stdout || ''), true);
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
