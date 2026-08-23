#!/usr/bin/env node
/**
 * PreToolUse hook: ci-push-guard (spec §5 B2)
 *
 * The `ready-to-merge` label is the merge lock: the expensive CI suites are
 * gated on it and re-run on EVERY push while it is present. The discipline is
 * "label off → push → label back on when green". This hook enforces the first
 * half: a `git push` on a branch whose PR currently carries `ready-to-merge` is
 * interrupted, and the block message names the EXECUTABLE remediation.
 *
 * ── Decisive predicate ────────────────────────────────────────────────────
 * The pushed branch's PR currently carries `ready-to-merge` (a live `gh` label
 * query). Label present → block. Label absent → ALLOW, even while light CI is
 * in flight. In-flight run info is advisory context in the message, NEVER the
 * predicate — the failure mode this avoids is "block on any run in flight",
 * which blocks normal development and gets the hook disabled.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 * Only `git push`. Supported refspecs: plain `git push`, `git push origin
 * <branch>`, and an explicit `<src>:<dst>` refspec. Anything more exotic
 * (multiple refspecs, --mirror, --all) → advisory allow: the guard refuses to
 * guess which branch is being pushed rather than block the wrong thing.
 * No-ops outside a GitHub-remote repo, or when no OPEN PR exists for the branch.
 *
 * ── Override ──────────────────────────────────────────────────────────────
 * The framework's one-shot HITL sentinel pattern ONLY (mirrors
 * bash-config-guard.js) — deliberately NOT an agent-settable env var, so the
 * agent cannot unblock itself.
 *
 * ── Fail-open ─────────────────────────────────────────────────────────────
 * `gh` absent / unauthenticated / query error / >3s timeout → allow with a
 * one-line warning. A bug or a slow network must never block a legitimate push.
 *
 * Exit codes (Claude Code hook contract): 0 allow · 2 interrupt (stderr is fed
 * back to Claude as feedback).
 *
 * Test seams: GH_BIN overrides `gh`; CI_PUSH_GUARD_CWD overrides the repo dir.
 * Tests: .claude/hooks/ci-push-guard.test.js — run: node .claude/hooks/ci-push-guard.test.js
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const READY_LABEL = 'ready-to-merge';
const GH = process.env.GH_BIN || 'gh';
const GH_TIMEOUT_MS = 3000;
const SENTINEL = 'ci-push-approved';
const CWD = process.env.CI_PUSH_GUARD_CWD || process.cwd();

// ── git push parsing ────────────────────────────────────────────────────────

/**
 * Return the `git push` argument list, or null when the command is not a push.
 * Only the FIRST simple command is considered: a compound command whose later
 * segment pushes is left to the next PreToolUse invocation rather than parsed
 * heuristically here.
 */
export function parseGitPush(command) {
  const first = String(command).split(/[;&|\n]/)[0].trim();
  const toks = first.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;      // env assignments
  while (i < toks.length && ['sudo', 'command', 'exec', 'nohup', 'env'].includes(toks[i])) i++;
  if (toks[i] !== 'git') return null;
  // Allow global git options before the subcommand: git -C <dir> push
  let j = i + 1;
  while (j < toks.length && toks[j].startsWith('-')) {
    j += toks[j] === '-C' || toks[j] === '-c' ? 2 : 1;                          // these take a value
  }
  if (toks[j] !== 'push') return null;
  return toks.slice(j + 1);
}

/**
 * Resolve the LOCAL branch a push acts on.
 * → { branch } for a supported shape, or { unsupported: true } when the guard
 *   cannot determine it unambiguously (advisory allow).
 */
export function resolvePushedBranch(pushArgs, currentBranch) {
  // Whole-repo pushes name no single branch — don't guess.
  if (pushArgs.some((a) => a === '--mirror' || a === '--all')) return { unsupported: true };
  const positional = pushArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) return { branch: currentBranch };               // git push
  const refspecs = positional.slice(1);                                        // drop the remote
  if (refspecs.length === 0) return { branch: currentBranch };                 // git push origin
  if (refspecs.length > 1) return { unsupported: true };                       // multi-refspec
  const spec = refspecs[0];
  if (spec.includes(':')) {
    const src = spec.split(':')[0].replace(/^\+/, '');                         // src:dst → local src
    return src ? { branch: src } : { unsupported: true };                      // :dst is a delete
  }
  return { branch: spec };                                                     // git push origin <branch>
}

// ── gh queries (bounded, fail-open) ─────────────────────────────────────────

function gh(args) {
  // A GH_BIN pointing at a Node script is the portable TEST seam: Windows cannot
  // spawn a .cmd/.bat shim without a shell (EINVAL since Node 18.20/20.12), and
  // using `shell: true` here would put branch names — parsed from the user's own
  // command — through a shell. Run the script with the current Node binary
  // instead, so the production path (a real `gh` executable) stays shell-free.
  if (/\.(mjs|cjs|js)$/.test(GH)) {
    return spawnSync(process.execPath, [GH, ...args], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, cwd: CWD });
  }
  return spawnSync(GH, args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, cwd: CWD });
}

/**
 * → { state: 'labelled' | 'unlabelled' | 'no-pr' | 'unknown', pr?, runInfo? }
 * 'unknown' is the fail-open state: the caller allows the push.
 */
export function queryPrState(branch, deps = { gh }) {
  const remote = deps.gh(['repo', 'view', '--json', 'name']);
  if (remote.error || remote.status !== 0) return { state: 'unknown' };        // no GitHub remote / no auth
  const view = deps.gh(['pr', 'view', branch, '--json', 'number,labels,state']);
  if (view.error) return { state: 'unknown' };                                 // timeout / spawn failure
  if (view.status !== 0) return { state: 'no-pr' };                            // gh exits non-zero when absent
  let data;
  try { data = JSON.parse(view.stdout); } catch { return { state: 'unknown' }; }
  if (!data || data.state !== 'OPEN') return { state: 'no-pr' };
  const labels = (data.labels || []).map((l) => l.name);
  return { state: labels.includes(READY_LABEL) ? 'labelled' : 'unlabelled', pr: data.number };
}

/** Advisory only — never part of the block decision. */
function inFlightRunNote(branch) {
  const r = gh(['run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,status']);
  if (r.error || r.status !== 0) return '';
  try {
    const runs = JSON.parse(r.stdout);
    const live = (runs || []).find((x) => x.status !== 'completed');
    return live ? `  (advisory: run ${live.databaseId} is ${live.status} — not the reason for this block)\n` : '';
  } catch { return ''; }
}

// ── HITL one-shot sentinel (mirrors bash-config-guard.js) ───────────────────

function sentinelPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude', SENTINEL);
}
function readSentinel() { try { return readFileSync(sentinelPath(), 'utf8').trim(); } catch { return null; } }
function consumeSentinel() { try { unlinkSync(sentinelPath()); } catch { /* already gone */ } }

// ── block message ───────────────────────────────────────────────────────────

export function buildBlockMessage({ pr, branch, sentinel, advisory = '' }) {
  const remediation = `bash scripts/ci/label.sh pull --pr ${pr} --reason pre-push`;
  return [
    `MERGE-LABEL-GUARD: PR #${pr} (branch "${branch}") currently carries the "${READY_LABEL}" label.`,
    ``,
    advisory,
    `Pushing now re-fires the full label-gated CI suite on the new head while the`,
    `label is present — the wasted full run the label-pull discipline exists to`,
    `prevent. Pull the label FIRST, push, then restore it once the branch is green.`,
    ``,
    `ACTION REQUIRED BY CLAUDE — do this NOW:`,
    `  1. Pull the label (removes it and journals the transition):`,
    ``,
    `       ${remediation}`,
    ``,
    `  2. Re-run this exact push.`,
    `  3. Produce parity evidence for the new head, then restore the label:`,
    ``,
    `       bash scripts/ci/label.sh parity --pr ${pr} --class <integration|static|pre-push> --status green --cmd "<command that proved it>"`,
    `       bash scripts/ci/label.sh restore --pr ${pr}`,
    ``,
    `The pull needs NO --run-id and NO --slug: it is a pre-push pull, and slug`,
    `resolution belongs to label.sh's shared resolver, not to this generic hook.`,
    ``,
    `HITL override (only with explicit user approval to push WITHOUT pulling):`,
    `write the branch to the one-shot sentinel and retry:`,
    ``,
    `       echo '${branch}' > '${sentinel}'`,
  ].filter((l) => l !== '').join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(raw) {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    if (payload.tool_name !== 'Bash') return 0;
    const command = (payload.tool_input && payload.tool_input.command) || '';
    if (typeof command !== 'string' || !command) return 0;

    const pushArgs = parseGitPush(command);
    if (pushArgs === null) return 0;                                           // not a git push

    const cur = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: GH_TIMEOUT_MS, cwd: CWD,
    });
    const currentBranch = (cur.status === 0 && cur.stdout.trim()) || null;
    const resolved = resolvePushedBranch(pushArgs, currentBranch);
    if (resolved.unsupported || !resolved.branch) return 0;                    // advisory allow

    const { state, pr } = queryPrState(resolved.branch);
    if (state === 'unknown') {
      process.stderr.write('ci-push-guard: could not resolve label state (gh unavailable, unauthenticated, or slow) — allowing push.\n');
      return 0;                                                                // fail-open
    }
    if (state !== 'labelled') return 0;                                        // no-pr / unlabelled → allow

    const approved = readSentinel();
    if (approved && (approved === resolved.branch || approved === String(pr))) {
      consumeSentinel();
      process.stderr.write(`ci-push-guard: one-shot push approval consumed for ${resolved.branch}\n`);
      return 0;
    }

    process.stderr.write(buildBlockMessage({
      pr, branch: resolved.branch, sentinel: sentinelPath(), advisory: inFlightRunNote(resolved.branch),
    }) + '\n');
    return 2;
  } catch (err) {
    process.stderr.write(`ci-push-guard: internal error, allowing push: ${err && err.message}\n`);
    return 0;                                                                  // fail-open
  }
}

// Direct-execution guard so the test can import the pure helpers above.
if (process.argv[1] && process.argv[1].endsWith('ci-push-guard.js')) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => process.exit(main(raw)));
}
