#!/usr/bin/env node
/**
 * Test suite for bash-config-guard.js — Bash bypass guard for protected
 * config paths.
 *
 * Verifies: write-shaped commands (redirection, sed -i, tee, rm, mv, cp,
 * chmod, dd of=, truncate, in-place perl) targeting .claude/settings.json,
 * .claude/settings.local.json, or .claude/hooks/** are blocked (exit 2);
 * read-only usage (cat, grep, ls, sed without -i) and writes to ordinary
 * paths are allowed; quoting variants are still caught; the one-shot HITL
 * sentinel authorises exactly one command; malformed stdin fails open.
 *
 * Style mirrors config-protection.test.js: runs the hook end-to-end as a
 * child process with CLAUDE_PROJECT_DIR pointed at a throwaway temp dir.
 *
 * Run: node .claude/hooks/bash-config-guard.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'bash-config-guard.js');

const PROJ = mkdtempSync(join(tmpdir(), 'bash-config-guard-test-'));
mkdirSync(join(PROJ, '.claude'), { recursive: true });
const SENTINEL = join(PROJ, '.claude', 'config-edit-approved');

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJ },
  });
}

function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
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

// ── Cases: [label, command (or raw payload), expectedExit] ────────────────
const CASES = [
  // Blocked: write shapes on protected targets
  ["sed -i on settings.json → exit 2", bash("sed -i 's/a/b/' .claude/settings.json"), 2],
  ["append redirect to a hook → exit 2", bash("echo 'malicious' >> .claude/hooks/config-protection.js"), 2],
  ["truncating redirect to settings → exit 2", bash("echo '{}' > .claude/settings.json"), 2],
  ["rm a hook file → exit 2", bash("rm .claude/hooks/phase-lock.js"), 2],
  ["rm -rf the hooks dir → exit 2", bash("rm -rf .claude/hooks"), 2],
  ["tee into a hook → exit 2", bash("cat evil.js | tee .claude/hooks/bash-config-guard.js"), 2],
  ["tee -a into settings.local.json → exit 2", bash("echo x | tee -a .claude/settings.local.json"), 2],
  ["mv over settings.json → exit 2", bash("mv /tmp/replacement.json .claude/settings.json"), 2],
  ["cp over a hook → exit 2", bash("cp /tmp/evil.js .claude/hooks/phase-lock.js"), 2],
  ["chmod on a hook → exit 2", bash("chmod 000 .claude/hooks/config-protection.js"), 2],
  ["dd of=settings → exit 2", bash("dd if=/dev/null of=.claude/settings.json"), 2],
  ["truncate a hook → exit 2", bash("truncate -s 0 .claude/hooks/phase-lock.js"), 2],
  ["perl -i on settings → exit 2", bash("perl -pi -e 's/a/b/' .claude/settings.json"), 2],
  ["absolute-path target still caught → exit 2", bash(`echo x > ${PROJ.replace(/\\/g, '/')}/.claude/settings.json`), 2],
  ["$VAR-prefixed target still caught → exit 2", bash('echo x > "$CLAUDE_PROJECT_DIR"/.claude/settings.json'), 2],
  ["write buried in && chain → exit 2", bash("ls && echo x >> .claude/hooks/h.js"), 2],

  // Quoting variants
  ["double-quoted target → exit 2", bash('echo x > ".claude/settings.json"'), 2],
  ["single-quoted target → exit 2", bash("sed -i 's/a/b/' '.claude/settings.local.json'"), 2],
  ["quoted hook path with tee → exit 2", bash('date | tee ".claude/hooks/new-hook.js"'), 2],

  // Allowed: read-only usage of protected paths
  ["cat settings.json → exit 0", bash("cat .claude/settings.json"), 0],
  ["grep in hooks → exit 0", bash("grep -rn 'PROTECTED' .claude/hooks/config-protection.js"), 0],
  ["ls hooks dir → exit 0", bash("ls -la .claude/hooks"), 0],
  ["sed WITHOUT -i on settings → exit 0", bash("sed -n '1,10p' .claude/settings.json"), 0],
  ["cp settings OUT to backup → exit 0", bash("cp .claude/settings.json /tmp/backup.json"), 0],
  ["git diff settings → exit 0", bash("git diff .claude/settings.json"), 0],
  ["node running a hook test → exit 0", bash("node .claude/hooks/config-protection.test.js"), 0],

  // Allowed: writes to ordinary paths
  ["sed -i on ordinary file → exit 0", bash("sed -i 's/a/b/' src/app.ts"), 0],
  ["redirect to /tmp → exit 0", bash("echo hi > /tmp/scratch.txt"), 0],
  ["append to ordinary file → exit 0", bash("echo done >> tasks/todo.md"), 0],
  ["rm ordinary file → exit 0", bash("rm -f /tmp/old.log"), 0],
  ["settings.json elsewhere is not protected → exit 0", bash("echo x > config/settings.json"), 0],

  // Blocked: Bash write shapes on KNOWLEDGE.md (append-only lives in the Edit
  // tool path; the shell cannot prove append-only, so ALL write shapes block)
  ["sed -i on KNOWLEDGE.md → exit 2", bash("sed -i 's/a/b/' KNOWLEDGE.md"), 2],
  ["truncating redirect to KNOWLEDGE.md → exit 2", bash("cat draft.md > KNOWLEDGE.md"), 2],
  ["append redirect to KNOWLEDGE.md → exit 2 (appends go via Edit)", bash("echo 'entry' >> KNOWLEDGE.md"), 2],
  ["rm KNOWLEDGE.md → exit 2", bash("rm KNOWLEDGE.md"), 2],
  ["tee into KNOWLEDGE.md → exit 2", bash("echo x | tee KNOWLEDGE.md"), 2],
  ["cp over KNOWLEDGE.md → exit 2", bash("cp /tmp/new.md ./KNOWLEDGE.md"), 2],
  ["mv KNOWLEDGE.md away → exit 2", bash("mv KNOWLEDGE.md /tmp/gone.md"), 2],
  ["truncate KNOWLEDGE.md → exit 2", bash("truncate -s 0 KNOWLEDGE.md"), 2],
  ["perl -i on nested KNOWLEDGE.md → exit 2", bash("perl -pi -e 's/a/b/' docs/KNOWLEDGE.md"), 2],
  ["python -i style in-place on KNOWLEDGE.md → exit 2", bash("python -i edit.py KNOWLEDGE.md"), 2],

  // Allowed: read-only + lookalike paths
  ["cat KNOWLEDGE.md → exit 0 (read-only)", bash("cat KNOWLEDGE.md"), 0],
  ["grep in KNOWLEDGE.md → exit 0", bash("grep -n 'Correction' KNOWLEDGE.md"), 0],
  ["cp KNOWLEDGE.md to backup → exit 0 (source read, dest unprotected)", bash("cp KNOWLEDGE.md /tmp/backup.md"), 0],
  ["KNOWLEDGE-archive is not protected → exit 0", bash("echo x >> KNOWLEDGE-archive-2026-Q3.md"), 0],
  ["OLDKNOWLEDGE.md is not protected → exit 0", bash("rm OLDKNOWLEDGE.md"), 0],

  // Pass-through / fail-open
  ["non-Bash tool → exit 0", { tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' } }, 0],
  ["empty command → exit 0", bash(''), 0],
  ["malformed stdin → exit 0 (fail-open)", '{not json', 0],
  ["empty stdin → exit 0", '', 0],
];

for (const [label, input, expectedExit] of CASES) {
  const result = runHook(input);
  check(label, result.status, expectedExit, result.stderr && result.stderr.slice(0, 200));
}

// Block message mirrors config-protection's HITL voice
{
  const r = runHook(bash("echo x > .claude/settings.json"));
  check('block message names HITL approval', /HITL-APPROVAL-REQUIRED/.test(r.stderr || ''), true, r.stderr && r.stderr.slice(0, 200));
  check('block message names the sentinel command', /config-edit-approved/.test(r.stderr || ''), true);
}

// ── One-shot sentinel flow ─────────────────────────────────────────────────
{
  writeFileSync(SENTINEL, '.claude/settings.json\n');
  const first = runHook(bash("echo '{}' > .claude/settings.json"));
  check('sentinel: write to settings.json → exit 0 (approval consumed)', first.status, 0, first.stderr && first.stderr.slice(0, 200));
  check('sentinel consumed message on stderr', /one-shot approval consumed/.test(first.stderr || ''), true, first.stderr);
  check('sentinel deleted after consume (one-shot)', existsSync(SENTINEL), false);

  const second = runHook(bash("echo '{}' > .claude/settings.json"));
  check('retry without fresh sentinel → exit 2', second.status, 2);
}

// Sentinel path-binding: approval for settings.json must not authorise a hook
{
  writeFileSync(SENTINEL, '.claude/settings.json\n');
  const wrong = runHook(bash("rm .claude/hooks/phase-lock.js"));
  check('sentinel for settings.json does NOT authorise hook rm → exit 2', wrong.status, 2, wrong.stderr && wrong.stderr.slice(0, 200));
  check('mismatched sentinel NOT consumed', existsSync(SENTINEL), true);
  rmSync(SENTINEL, { force: true });
}

// ── Knowledge sentinel flow (separate sentinel file, knowledge kind) ───────
{
  const kr = runHook(bash("echo 'entry' >> KNOWLEDGE.md"));
  check('knowledge block message names the knowledge sentinel', /knowledge-edit-approved/.test(kr.stderr || ''), true, kr.stderr && kr.stderr.slice(0, 200));
  check('knowledge block message routes appends to the Edit tool', /Edit tool/.test(kr.stderr || ''), true);

  const KSENTINEL = join(PROJ, '.claude', 'knowledge-edit-approved');
  writeFileSync(KSENTINEL, 'KNOWLEDGE.md\n');
  const ok = runHook(bash("echo 'entry' >> KNOWLEDGE.md"));
  check('knowledge sentinel: approved Bash write → exit 0 (consumed)', ok.status, 0, ok.stderr && ok.stderr.slice(0, 200));
  check('knowledge sentinel deleted after consume', existsSync(KSENTINEL), false);

  // A config sentinel must NOT authorise a knowledge write
  writeFileSync(SENTINEL, 'KNOWLEDGE.md\n');
  const cross = runHook(bash("echo 'entry' >> KNOWLEDGE.md"));
  check('config sentinel does NOT authorise KNOWLEDGE.md write → exit 2', cross.status, 2, cross.stderr && cross.stderr.slice(0, 200));
  rmSync(SENTINEL, { force: true });
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
