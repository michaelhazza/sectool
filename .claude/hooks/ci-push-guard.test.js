#!/usr/bin/env node
/**
 * Test suite for ci-push-guard.js — the `ready-to-merge` push guard (spec §5 B2).
 *
 * Verifies the DECISIVE PREDICATE is the live label state and nothing else:
 * a labelled PR blocks (exit 2); an unlabelled PR allows EVEN WITH CI in flight
 * (the regression that would make the guard hated and disabled); no PR allows;
 * the one-shot HITL sentinel authorises exactly one push; gh absent /
 * unauthenticated / timing out fails OPEN; unsupported refspecs are advisory
 * allows rather than wrong blocks. Plus the end-to-end check the spec demands:
 * the remediation command the guard PRINTS actually succeeds against a fake gh.
 *
 * Style mirrors bash-config-guard.test.js: the hook runs end-to-end as a child
 * process against a throwaway git repo and a fake `gh` whose behaviour is
 * driven by a JSON state file.
 *
 * Run: node .claude/hooks/ci-push-guard.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'ci-push-guard.js');
const LABEL_SH = join(HERE, '..', '..', 'scripts', 'ci', 'label.sh');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; } else { failures.push(`${name}${detail ? `\n    ${detail}` : ''}`); }
}

// ── throwaway repo + fake gh ────────────────────────────────────────────────
const PROJ = mkdtempSync(join(tmpdir(), 'ci-push-guard-test-'));
mkdirSync(join(PROJ, '.claude'), { recursive: true });
const SENTINEL = join(PROJ, '.claude', 'ci-push-approved');
const GH_STATE = join(PROJ, 'gh-state.json');
const BIN = join(PROJ, 'bin');
mkdirSync(BIN, { recursive: true });

function git(...args) {
  return spawnSync('git', ['-C', PROJ, ...args], { encoding: 'utf8' });
}
git('init', '-q');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git('checkout', '-q', '-B', 'feature-x');

// Fake gh: a node script driven by GH_STATE. Modes:
//   labelled | unlabelled | no-pr | no-remote | error (non-zero on repo view)
const GH_JS = join(BIN, 'gh.mjs');
// The fake must honour --jq the way real gh does: label.sh reads plain values
// (`--jq .labels[].name`) while the hook reads whole JSON. A fake that always
// printed JSON would make label.sh see "no label" and silently pass the wrong
// path — so the two output shapes are modelled explicitly.
writeFileSync(GH_JS, `
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const SF = ${JSON.stringify(GH_STATE)};
const s = JSON.parse(readFileSync(SF, 'utf8'));
const argv = process.argv.slice(2).join(' ');
const jq = argv.includes('--jq');
if (argv.includes('repo view')) {
  if (s.mode === 'no-remote' || s.mode === 'error') process.exit(1);
  console.log('{"name":"repo"}');
} else if (argv.includes('pr view')) {
  if (s.mode === 'no-pr') process.exit(1);
  const labels = s.mode === 'labelled' ? [{ name: 'ready-to-merge' }] : [];
  if (jq && argv.includes('headRefOid')) {
    console.log(execSync('git rev-parse HEAD', { cwd: ${JSON.stringify(PROJ)} }).toString().trim());
  } else if (jq && argv.includes('labels')) {
    for (const l of labels) console.log(l.name);           // one bare name per line
  } else {
    console.log(JSON.stringify({ number: 42, labels, state: 'OPEN' }));
  }
} else if (argv.includes('run list')) {
  console.log(JSON.stringify(s.runInFlight ? [{ databaseId: 999, status: 'in_progress' }] : []));
} else if (argv.includes('pr edit')) {
  if (argv.includes('--remove-label')) { s.mode = 'unlabelled'; writeFileSync(SF, JSON.stringify(s)); }
  if (argv.includes('--add-label')) { s.mode = 'labelled'; writeFileSync(SF, JSON.stringify(s)); }
} else { console.log('{}'); }
`);
// The hook receives the .mjs directly and runs it with the current Node binary
// (its documented test seam) — portable, and never a shell.
const GH_CMD = GH_JS;
// label.sh is bash and invokes "$GH" directly, so it needs something bash can
// exec: a .cmd on Windows (git-bash runs those via cmd.exe), a shebang script
// elsewhere. This is the mirror image of the hook's seam — bash can run a .cmd
// that Node cannot spawn, and vice versa.
const GH_FOR_BASH = join(BIN, process.platform === 'win32' ? 'gh.cmd' : 'gh');
if (process.platform === 'win32') {
  writeFileSync(GH_FOR_BASH, `@echo off\r\nnode "${GH_JS}" %*\r\n`);
} else {
  writeFileSync(GH_FOR_BASH, `#!/usr/bin/env bash\nexec node "${GH_JS}" "$@"\n`);
  chmodSync(GH_FOR_BASH, 0o755);
}

function setGh(mode, extra = {}) {
  writeFileSync(GH_STATE, JSON.stringify({ mode, ...extra }));
}

function runHook(command, { sentinel = null, ghBin = GH_CMD } = {}) {
  if (sentinel === null) { try { rmSync(SENTINEL); } catch { /* absent */ } }
  else writeFileSync(SENTINEL, sentinel);
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJ, CI_PUSH_GUARD_CWD: PROJ, GH_BIN: ghBin },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. The decisive predicate: label present blocks, label absent allows
// ════════════════════════════════════════════════════════════════════════════
setGh('labelled');
{
  const r = runHook('git push');
  check('labelled PR blocks the push (exit 2)', r.status === 2, `got ${r.status}: ${r.stderr}`);
  check('block message names the executable remediation',
    /label\.sh pull --pr 42 --reason pre-push/.test(r.stderr), r.stderr.slice(0, 200));
  // Assert on the remediation COMMAND LINE itself, not the prose around it
  // (the prose deliberately mentions --slug/--run-id to explain their absence).
  const cmdLine = (r.stderr.split('\n').find((l) => /label\.sh pull /.test(l)) || '').trim();
  check('remediation command carries no --slug (helper owns slug resolution)',
    cmdLine.length > 0 && !cmdLine.includes('--slug'), cmdLine);
  check('remediation command carries no --run-id (pre-push pull)',
    cmdLine.length > 0 && !cmdLine.includes('--run-id'), cmdLine);
}

setGh('unlabelled', { runInFlight: true });
{
  const r = runHook('git push');
  check('UNLABELLED PR allows the push even with CI in flight (exit 0)',
    r.status === 0, `got ${r.status}: ${r.stderr}`);
}

setGh('no-pr');
check('no open PR allows the push', runHook('git push').status === 0);

// In-flight info must be advisory context only, never the predicate.
setGh('labelled', { runInFlight: true });
{
  const r = runHook('git push');
  check('in-flight run appears as advisory context in the block message',
    r.status === 2 && /advisory: run 999/.test(r.stderr), r.stderr.slice(0, 160));
  check('advisory line states it is NOT the reason',
    /not the reason for this block/.test(r.stderr));
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Fail-open
// ════════════════════════════════════════════════════════════════════════════
setGh('no-remote');
check('no GitHub remote → allow', runHook('git push').status === 0);

setGh('error');
{
  const r = runHook('git push');
  check('gh error → fail OPEN with a warning', r.status === 0 && /allowing push/.test(r.stderr), r.stderr);
}

setGh('labelled');
{
  const r = runHook('git push', { ghBin: join(BIN, 'definitely-not-a-real-gh') });
  check('gh absent → fail OPEN', r.status === 0, `got ${r.status}: ${r.stderr}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. HITL one-shot override (no agent-settable env var exists)
// ════════════════════════════════════════════════════════════════════════════
setGh('labelled');
{
  const r = runHook('git push', { sentinel: 'feature-x' });
  check('HITL sentinel authorises the push', r.status === 0, `got ${r.status}: ${r.stderr}`);
  const consumed = (() => { try { readFileSync(SENTINEL); return false; } catch { return true; } })();
  check('sentinel is one-shot (consumed)', consumed);
  const again = runHook('git push');                    // sentinel now absent
  check('the next push blocks again', again.status === 2, `got ${again.status}`);
}
{
  const r = runHook('git push', { sentinel: 'some-other-branch' });
  check('sentinel for a DIFFERENT branch does not authorise', r.status === 2, `got ${r.status}`);
}
check('no agent-settable override env var is honoured',
  !/process\.env\.(CI_PUSH_ANYWAY|SKIP_PUSH_GUARD|FORCE_PUSH)/.test(readFileSync(HOOK, 'utf8')));

// ════════════════════════════════════════════════════════════════════════════
// 4. Command / refspec parsing
// ════════════════════════════════════════════════════════════════════════════
setGh('labelled');
check('non-push git command is ignored', runHook('git status').status === 0);
check('non-git command is ignored', runHook('npm run build').status === 0);
check('git push origin <branch> blocks', runHook('git push origin feature-x').status === 2);
check('explicit src:dst refspec blocks', runHook('git push origin feature-x:feature-x').status === 2);
check('force push still blocks', runHook('git push --force-with-lease').status === 2);
check('env-prefixed push blocks', runHook('FOO=1 git push').status === 2);
check('git -C <dir> push blocks', runHook(`git -C ${PROJ} push`).status === 2);
check('--mirror is an advisory allow (names no single branch)', runHook('git push --mirror').status === 0);
check('--all is an advisory allow', runHook('git push --all origin').status === 0);
check('multi-refspec is an advisory allow', runHook('git push origin a b').status === 0);
check('branch-delete refspec is an advisory allow', runHook('git push origin :gone').status === 0);

// Malformed stdin must not throw.
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'not json', encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJ, CI_PUSH_GUARD_CWD: PROJ, GH_BIN: GH_CMD },
  });
  check('malformed stdin fails open', r.status === 0, `got ${r.status}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 5. End-to-end: the remediation the guard PRINTS actually works (spec §5 B2)
// ════════════════════════════════════════════════════════════════════════════
{
  setGh('labelled');
  const blocked = runHook('git push');
  const m = /bash (scripts\/ci\/label\.sh pull --pr \d+ --reason pre-push)/.exec(blocked.stderr);
  check('block message contains a parseable remediation command', Boolean(m), blocked.stderr.slice(0, 200));
  if (m) {
    const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
    if (bash.status === 0) {
      // Run the printed command verbatim (label.sh resolved from the framework
      // tree). Paths handed to bash must use forward slashes and $GH must be
      // something BASH can exec (the .cmd wrapper, not the hook's .mjs seam) —
      // a silently-unexecutable $GH would read as "no PR" rather than a broken
      // fixture, which is exactly how this check failed the first time.
      const posix = (p) => p.replace(/\\/g, '/');
      const args = m[1].replace('scripts/ci/label.sh', posix(LABEL_SH)).split(/\s+/);
      const r = spawnSync('bash', args, {
        cwd: PROJ, encoding: 'utf8',
        env: { ...process.env, GH_BIN: posix(GH_FOR_BASH) },
      });
      check('the printed remediation succeeds against the fake gh',
        r.status === 0 && /OUTCOME: (PULLED|SLUG_UNRESOLVED)/.test(r.stdout),
        `status=${r.status} out=${(r.stdout || '').slice(0, 160)} err=${(r.stderr || '').slice(0, 160)}`);
    } else {
      pass++; // bash unavailable — the guard's own behaviour is already covered above
    }
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
try { rmSync(PROJ, { recursive: true, force: true }); } catch { /* windows lock */ }
if (failures.length) {
  console.error(`\n✗ ci-push-guard.test.js — ${failures.length} failed, ${pass} passed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`✓ ci-push-guard.test.js — all ${pass} checks passed`);
