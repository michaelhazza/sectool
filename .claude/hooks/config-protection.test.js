#!/usr/bin/env node
/**
 * Test suite for config-protection.js — HITL config-file guard.
 *
 * Verifies: real-shaped Edit/Write/MultiEdit payloads against protected and
 * unprotected files (including the top-level file_path MultiEdit shape that
 * previously bypassed the guard), anchored eslintrc/prettierrc basename
 * matching, self-protection of .claude/settings.json and .claude/hooks/**,
 * the one-shot sentinel consume flow, sentinel path-binding (approval for
 * one package.json must not authorise a different package.json), and
 * fail-open on malformed stdin.
 *
 * Runs the hook end-to-end as a child process (the hook has no import guard
 * and its behaviour is exit-code + sentinel side-effects), with
 * CLAUDE_PROJECT_DIR pointed at a throwaway temp dir so sentinel reads and
 * writes never touch the real repo.
 *
 * Run: node .claude/hooks/config-protection.test.js
 * Exit 0 on all pass, 1 on any fail.
 *
 * Not picked up by vitest (config scopes to **\/__tests__/**\/*.test.ts).
 * This file is a sanity script — re-run after any change to config-protection.js.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'config-protection.js');

// Isolated fake project dir — the sentinel lives here, not in the real repo.
const PROJ = mkdtempSync(join(tmpdir(), 'config-protection-test-'));
mkdirSync(join(PROJ, '.claude'), { recursive: true });
const SENTINEL = join(PROJ, '.claude', 'config-edit-approved');

/**
 * Run the hook with the given stdin (object → JSON, string → raw) and
 * return the spawnSync result. CLAUDE_PROJECT_DIR points at the temp dir.
 */
function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJ },
  });
}

/** Build a real-shaped hook payload. */
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

// ── Exit-code cases: [label, payload (object or raw string), expectedExit] ─
// Real Claude Code payload shapes: Edit/Write carry top-level file_path;
// MultiEdit carries top-level file_path plus edits[] of old/new strings.
const CASES = [
  // 1. Edit to tsconfig.json → block
  [
    "Edit tsconfig.json → exit 2",
    payload('Edit', { file_path: `${PROJ}/tsconfig.json`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 2. Edit to tsconfig variant → block
  [
    "Edit tsconfig.server.json → exit 2",
    payload('Edit', { file_path: `${PROJ}/tsconfig.server.json`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 3. Write to package.json → block
  [
    "Write package.json → exit 2",
    payload('Write', { file_path: `${PROJ}/package.json`, content: '{}' }),
    2,
  ],

  // 4. (Regression) Real-shaped MultiEdit — top-level file_path, edits[] with
  // only old/new strings. A prior extractor scanned edits[].file_path only and
  // returned [] for this shape, silently bypassing the guard.
  [
    "MultiEdit tsconfig.json (top-level file_path shape) → exit 2",
    payload('MultiEdit', {
      file_path: `${PROJ}/tsconfig.json`,
      edits: [
        { old_string: 'strict: true', new_string: 'strict: false' },
        { old_string: 'noEmit', new_string: 'noEmitX' },
      ],
    }),
    2,
  ],

  // 5. Same MultiEdit shape against a non-protected file → allow
  [
    "MultiEdit server/foo.ts (top-level file_path shape) → exit 0",
    payload('MultiEdit', {
      file_path: `${PROJ}/server/foo.ts`,
      edits: [{ old_string: 'a', new_string: 'b' }],
    }),
    0,
  ],

  // 6. Legacy per-edit file_path variant still caught by the edits[] fallback
  [
    "MultiEdit with per-edit file_path package.json → exit 2",
    payload('MultiEdit', {
      edits: [{ file_path: `${PROJ}/package.json`, old_string: 'a', new_string: 'b' }],
    }),
    2,
  ],

  // 7. Edit to ordinary source file → allow
  [
    "Edit server/app.ts → exit 0",
    payload('Edit', { file_path: `${PROJ}/server/app.ts`, old_string: 'a', new_string: 'b' }),
    0,
  ],

  // 8. Anchored basename regex: prose file named after eslintrc → allow
  // (the old open-ended /^\.?eslintrc.*$/ swept this up)
  [
    "Edit docs/eslintrc.md → exit 0 (anchored regex ignores prose files)",
    payload('Edit', { file_path: `${PROJ}/docs/eslintrc.md`, old_string: 'a', new_string: 'b' }),
    0,
  ],

  // 9. Real eslintrc config → block
  [
    "Edit .eslintrc.json → exit 2",
    payload('Edit', { file_path: `${PROJ}/.eslintrc.json`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 10. Extensionless prettierrc → block
  [
    "Edit .prettierrc → exit 2",
    payload('Edit', { file_path: `${PROJ}/.prettierrc`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 11. Anchored basename regex: prettierrc-lookalike prose → allow
  [
    "Edit notes/prettierrc-old.txt → exit 0 (anchored regex)",
    payload('Edit', { file_path: `${PROJ}/notes/prettierrc-old.txt`, old_string: 'a', new_string: 'b' }),
    0,
  ],

  // 12. worker/.eslintrc.json stays protected via the basename rule even after
  // the origin-specific worker/ PROTECTED_PATHS entry was removed.
  [
    "Edit worker/.eslintrc.json → exit 2 (basename rule, no origin path entry)",
    payload('Edit', { file_path: `${PROJ}/worker/.eslintrc.json`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 13. Self-protection: hook configuration → block
  [
    "Edit .claude/settings.json → exit 2 (self-protection)",
    payload('Edit', { file_path: `${PROJ}/.claude/settings.json`, old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 14. Self-protection: the hooks themselves → block
  [
    "Write .claude/hooks/config-protection.js → exit 2 (self-protection)",
    payload('Write', { file_path: `${PROJ}/.claude/hooks/config-protection.js`, content: '// gutted' }),
    2,
  ],

  // 15. Self-protection works for already-relative payload paths too
  [
    "Edit .claude/hooks/phase-lock.js (relative path) → exit 2 (self-protection)",
    payload('Edit', { file_path: '.claude/hooks/phase-lock.js', old_string: 'a', new_string: 'b' }),
    2,
  ],

  // 16. Path-based protection is anchored: settings.local.json is NOT swept up
  [
    "Edit .claude/settings.local.json → exit 0 (only settings.json is protected)",
    payload('Edit', { file_path: `${PROJ}/.claude/settings.local.json`, old_string: 'a', new_string: 'b' }),
    0,
  ],

  // 17. Non-registered tool → allow (fail-open for unknown tools)
  [
    "Bash payload → exit 0 (tool not in enforcement set)",
    payload('Bash', { command: 'rm tsconfig.json' }),
    0,
  ],

  // 18. Fail-open: malformed stdin must never block
  [
    "malformed stdin → exit 0 (fail-open)",
    '{not json',
    0,
  ],

  // 19. Fail-open: empty stdin → allow
  [
    "empty stdin → exit 0",
    '',
    0,
  ],
];

for (const [label, input, expectedExit] of CASES) {
  const result = runHook(input);
  check(label, result.status, expectedExit, result.stderr && result.stderr.slice(0, 200));
}

// ── Sentinel consume flow ──────────────────────────────────────────────────
// A sentinel containing the target's repo-relative path authorises exactly
// one edit, then is deleted; the immediate retry must block again.
{
  writeFileSync(SENTINEL, 'package.json\n');
  const first = runHook(payload('Edit', { file_path: `${PROJ}/package.json`, old_string: 'a', new_string: 'b' }));
  check('sentinel "package.json": Edit package.json → exit 0 (approval consumed)', first.status, 0, first.stderr && first.stderr.slice(0, 200));
  check('sentinel consumed message on stderr', /one-shot approval consumed/.test(first.stderr || ''), true, first.stderr);
  check('sentinel deleted after consume (one-shot)', existsSync(SENTINEL), false);

  const second = runHook(payload('Edit', { file_path: `${PROJ}/package.json`, old_string: 'a', new_string: 'b' }));
  check('retry without fresh sentinel → exit 2', second.status, 2);
  check('block message names HITL approval', /HITL-APPROVAL-REQUIRED/.test(second.stderr || ''), true, second.stderr && second.stderr.slice(0, 200));
}

// ── Sentinel path-binding ──────────────────────────────────────────────────
// Approval for the root package.json must NOT authorise worker/package.json —
// the sentinel binds to the repo-relative path, not the basename.
{
  writeFileSync(SENTINEL, 'package.json\n');
  const wrongTarget = runHook(payload('Edit', { file_path: `${PROJ}/worker/package.json`, old_string: 'a', new_string: 'b' }));
  check('sentinel "package.json": Edit worker/package.json → exit 2 (path-bound)', wrongTarget.status, 2, wrongTarget.stderr && wrongTarget.stderr.slice(0, 200));
  check('mismatched sentinel NOT consumed', existsSync(SENTINEL), true);

  writeFileSync(SENTINEL, 'worker/package.json\n');
  const rightTarget = runHook(payload('Edit', { file_path: `${PROJ}/worker/package.json`, old_string: 'a', new_string: 'b' }));
  check('sentinel "worker/package.json": Edit worker/package.json → exit 0', rightTarget.status, 0, rightTarget.stderr && rightTarget.stderr.slice(0, 200));
  check('matching sentinel consumed', existsSync(SENTINEL), false);
}

// ── toRelativePath repo-root heuristic (fail-open regression) ──────────────
// Absolute paths NOT under CLAUDE_PROJECT_DIR/cwd and without a known marker
// used to return null from toRelativePath, silently skipping pathMatch — an
// edit to <other-repo>/.claude/settings.json bypassed the guard. The hook now
// walks up from the target looking for a directory containing .claude/.
{
  // Run the hook with CLAUDE_PROJECT_DIR unset and cwd inside a subfolder of
  // the fake project, targeting the fake project's .claude/settings.json.
  const SUB = join(PROJ, 'sub');
  mkdirSync(SUB, { recursive: true });
  const envNoProjectDir = { ...process.env };
  delete envNoProjectDir.CLAUDE_PROJECT_DIR;

  function runHookBare(input, cwd) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd,
      env: envNoProjectDir,
    });
  }

  // 1. CLAUDE_PROJECT_DIR unset + cwd in a subfolder → still blocked via the
  //    walk-up repo-root heuristic (was exit 0 before the fix).
  const r1 = runHookBare(
    payload('Edit', { file_path: `${PROJ}/.claude/settings.json`, old_string: 'a', new_string: 'b' }),
    SUB,
  );
  check('no CLAUDE_PROJECT_DIR, cwd=subfolder: Edit .claude/settings.json → exit 2', r1.status, 2, r1.stderr && r1.stderr.slice(0, 200));

  // 2. Same environment, hook script target → blocked.
  const r2 = runHookBare(
    payload('Write', { file_path: `${PROJ}/.claude/hooks/config-protection.js`, content: '// gutted' }),
    SUB,
  );
  check('no CLAUDE_PROJECT_DIR, cwd=subfolder: Write .claude/hooks/* → exit 2', r2.status, 2, r2.stderr && r2.stderr.slice(0, 200));

  // 3. Same environment, ordinary file in the same repo → still allowed
  //    (heuristic must not over-block).
  const r3 = runHookBare(
    payload('Edit', { file_path: `${PROJ}/sub/app.ts`, old_string: 'a', new_string: 'b' }),
    SUB,
  );
  check('no CLAUDE_PROJECT_DIR, cwd=subfolder: Edit ordinary file → exit 0', r3.status, 0, r3.stderr && r3.stderr.slice(0, 200));
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
