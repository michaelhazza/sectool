#!/usr/bin/env node
/**
 * Test suite for review-artifact-nudge.js — external-review handoff contract.
 *
 * Verifies: requests that hand an artifact to an external reviewer (or ask
 * for a file link) trigger the contract injection; ordinary mentions of
 * "spec"/"plan"/"diff" with no handoff intent do NOT (the heuristic requires
 * artifact noun AND intent); payloads without a prompt pass through silently;
 * malformed stdin fails open; the hook never exits non-zero.
 *
 * The trigger matrix includes the verbatim operator phrasings from the
 * 2026-07-29 incident this hook exists to prevent — the ad-hoc "code only
 * diff file" request that produced an unlinked, promptless, outside-the-repo
 * handoff.
 *
 * Style mirrors correction-nudge.test.js: runs the hook end-to-end as a
 * child process.
 *
 * Run: node .claude/hooks/review-artifact-nudge.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'review-artifact-nudge.js');

function runHook(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: raw, encoding: 'utf8', timeout: 15000 });
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}

function fired(r) {
  return /<review-artifact-handoff>/.test(r.stdout || '');
}

// ── Must FIRE: artifact + handoff/link intent ───────────────────────────────
const TRIGGERS = [
  // Verbatim from the incident this hook prevents.
  'can you stop the CI so we can do final code reviews first. Give me code only diff file',
  'whenever I ask for a code-only diff or any file for external review, link me the file',
  'finish this off and when done create code only diff for review',
  // The other named surfaces.
  'give me the spec for review',
  'export the plan for an external review',
  'prepare the brief for ChatGPT',
  'send me the diff so I can paste it into GPT-5',
  'create a handoff for codex',
  'link me the plan',
  'generate the PR diff for an independent opinion',
  'send the diff to ChatGPT',
  'ChatGPT review of the spec please',
];

// ── Must NOT fire: artifact noun without handoff intent ─────────────────────
const NON_TRIGGERS = [
  'the spec says the gate must fail closed',
  'does the plan cover migrations?',
  'why is the diff so large between these two functions?',
  'the brief mentioned a runner',
  'update the spec to 45 rows',
  'what does pr-check.yml do?',
  // Real false positive observed 2026-07-29: 'spec' + a bare 'Codex' mention.
  'can we set it up so Codex uses its discretion on what frontend tests to build, rather than dictating it in the spec?',
  'does the spec say Codex owns the plan review?',
];

console.log('review-artifact-nudge.test.js');

console.log(' triggers:');
for (const prompt of TRIGGERS) {
  const r = runHook({ prompt });
  check(`fires: "${prompt.slice(0, 60)}"`, fired(r), true);
  check(`  exit 0`, r.status, 0);
}

console.log(' non-triggers:');
for (const prompt of NON_TRIGGERS) {
  const r = runHook({ prompt });
  check(`silent: "${prompt.slice(0, 60)}"`, fired(r), false);
  check(`  exit 0`, r.status, 0);
}

console.log(' contract content (fires once, must carry the three requirements):');
{
  const r = runHook({ prompt: 'give me a code-only diff for external review' });
  check('names the reference doc', /review-mode-resolution\.md/.test(r.stdout), true);
  check('req 1: inside the workspace', /INSIDE THE WORKSPACE/.test(r.stdout), true);
  check('req 1: gitignore not exile', /GITIGNORED, not exiled/.test(r.stdout), true);
  check('req 2: clickable link', /CLICKABLE workspace-relative/.test(r.stdout), true);
  check('req 3: reviewer prompt file', /READY-TO-PASTE REVIEWER PROMPT/.test(r.stdout), true);
  check('canonical path present', /tasks\/builds\/<slug>\/code-only\.diff/.test(r.stdout), true);
}

console.log(' degenerate payloads:');
{
  let r = runHook({});
  check('no prompt: silent', fired(r), false);
  check('no prompt: exit 0', r.status, 0);

  r = runHook({ prompt: '' });
  check('empty prompt: silent', fired(r), false);

  r = runHook({ tool_name: 'Bash', tool_input: { command: 'give me a diff for review' } });
  check('PreToolUse-shaped payload (no prompt key): silent', fired(r), false);

  r = runHook('this is not json {{{');
  check('malformed stdin: silent', fired(r), false);
  check('malformed stdin: exit 0 (fails open)', r.status, 0);
}

console.log(failures === 0 ? 'All review-artifact-nudge tests passed.' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
