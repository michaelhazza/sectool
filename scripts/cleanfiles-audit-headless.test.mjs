#!/usr/bin/env node
/**
 * Test for cleanfiles-audit-headless.mjs — the /cleanfiles audit scheduler wrapper.
 *
 * Verifies the orchestration the wrapper exists to supply, WITHOUT invoking the
 * real (nesting-guarded, costly) `claude` binary: a node stub stands in via
 * CLEANFILES_AUDIT_CMD.
 *
 *   1. cwd pinning        — the child runs with cwd = CLEANFILES_AUDIT_REPO.
 *   2. external dated log — output lands in CLEANFILES_AUDIT_LOGDIR/audit-*.log,
 *                           OUTSIDE the repo.
 *   3. exit-code prop     — the wrapper exits with the child's exit code.
 *   4. repository purity  — nothing is written inside the repo directory.
 *
 * Run: node scripts/cleanfiles-audit-headless.test.mjs
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'cleanfiles-audit-headless.mjs');

const root = mkdtempSync(join(tmpdir(), 'cleanfiles-wrapper-'));
const repoDir = join(root, 'repo');
mkdirSync(repoDir, { recursive: true });
const logDir = join(root, 'external-logs'); // deliberately NOT under repoDir
writeFileSync(join(repoDir, 'seed.txt'), 'unchanged');

// Stub "claude": prints its cwd + argv and exits with code 3. Invoked as
// `node <stub>` via the CLEANFILES_AUDIT_CMD override.
const stub = join(root, 'fake-claude.mjs');
writeFileSync(
  stub,
  [
    "process.stdout.write('FAKE_CLAUDE cwd=' + process.cwd() + ' argv=' + JSON.stringify(process.argv.slice(2)) + '\\n');",
    'process.exit(3);',
  ].join('\n'),
);

const repoBefore = readdirSync(repoDir).sort().join(',');

const result = spawnSync(process.execPath, [WRAPPER], {
  encoding: 'utf8',
  env: {
    ...process.env,
    CLEANFILES_AUDIT_REPO: repoDir,
    CLEANFILES_AUDIT_LOGDIR: logDir,
    CLEANFILES_AUDIT_CMD: JSON.stringify([process.execPath, stub]),
  },
});

const repoAfter = readdirSync(repoDir).sort().join(',');
const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
const logText = logs.length ? readFileSync(join(logDir, logs[0]), 'utf8') : '';

let pass = 0;
const fails = [];
function check(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

check('exit-code propagation: wrapper exits with child code 3', result.status === 3);
check('external dated log created (audit-YYYY-MM-DD.log) in the log dir', logs.length === 1);
check('log dir is OUTSIDE the repo (no audit log inside repo)', !existsSync(join(repoDir, logs[0] || 'audit-x.log')));
check('cwd pinning: child ran with cwd = repo dir', logText.includes(`FAKE_CLAUDE cwd=${repoDir}`));
check('repository purity: repo dir contents unchanged', repoBefore === repoAfter && repoBefore === 'seed.txt');
check('repository purity: seed file body unchanged', readFileSync(join(repoDir, 'seed.txt'), 'utf8') === 'unchanged');

// Scenario 2 (High): a NONEXISTENT executable emits both 'error' AND (after it)
// 'close'. The wrapper must settle exactly once, exit 127, and never crash with
// ERR_STREAM_WRITE_AFTER_END from a second log.end/write.
const logDir2 = join(root, 'external-logs-2');
const enoent = spawnSync(process.execPath, [WRAPPER], {
  encoding: 'utf8',
  env: {
    ...process.env,
    CLEANFILES_AUDIT_REPO: repoDir,
    CLEANFILES_AUDIT_LOGDIR: logDir2,
    CLEANFILES_AUDIT_CMD: JSON.stringify(['definitely-not-a-real-binary-xyzzy']),
  },
});
check('spawn-ENOENT: wrapper exits exactly 127', enoent.status === 127);
check('spawn-ENOENT: no write-after-end / unhandled crash', !/ERR_STREAM_WRITE_AFTER_END|Uncaught|unhandled/i.test(enoent.stderr || ''));
const logs2 = existsSync(logDir2) ? readdirSync(logDir2).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
check('spawn-ENOENT: dated log still written cleanly', logs2.length === 1);

// Scenario 3 (M1): a child that IGNORES termination must not hang the wrapper —
// the hard grace timer settles it as 124 within bounded wall time.
const stubHang = join(root, 'fake-hang.cjs'); // .cjs → CommonJS so require() is available
const hangPidFile = join(root, 'hang.pid');
writeFileSync(
  stubHang,
  [
    // Spawn a GRANDCHILD that also ignores SIGTERM (a headless Claude run spawns
    // subprocesses), record both pids, then ignore termination and stay alive —
    // the wrapper must FORCE-kill the whole tree after the grace window; killing
    // only the direct child would orphan the grandchild.
    "const { spawn } = require('child_process');",
    "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
    `require('fs').writeFileSync(${JSON.stringify(hangPidFile)}, process.pid + '\\n' + gc.pid);`,
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'),
);
const logDir3 = join(root, 'external-logs-3');
const hangStart = Date.now();
const hang = spawnSync(process.execPath, [WRAPPER], {
  encoding: 'utf8',
  timeout: 15000, // safety net so a real hang fails the test instead of blocking forever
  env: {
    ...process.env,
    CLEANFILES_AUDIT_REPO: repoDir,
    CLEANFILES_AUDIT_LOGDIR: logDir3,
    CLEANFILES_AUDIT_CMD: JSON.stringify([process.execPath, stubHang]),
    CLEANFILES_AUDIT_TIMEOUT_MS: '400',
    CLEANFILES_AUDIT_TIMEOUT_GRACE_MS: '600',
  },
});
const hangElapsed = Date.now() - hangStart;
check('hard-timeout: wrapper exits 124 on an ignore-SIGTERM child', hang.status === 124);
check('hard-timeout: wrapper wall time stays bounded (<10s)', hangElapsed < 10000);
// The child AND its grandchild must have been force-killed, not left as
// orphans. Give SIGKILL a moment, then prove both pids are gone (kill(pid, 0)
// throws ESRCH on a dead process).
function stillAlive(pid) {
  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); alive = true; } catch { return false; }
  }
  return alive;
}
let childAlive;
let grandchildAlive;
try {
  const pids = readFileSync(hangPidFile, 'utf8').trim().split('\n').map(Number);
  childAlive = stillAlive(pids[0]);
  grandchildAlive = pids[1] ? stillAlive(pids[1]) : false;
} catch { childAlive = false; grandchildAlive = false; }
check('hard-timeout: the ignore-SIGTERM child was force-killed (no orphan)', childAlive === false);
check('hard-timeout: the GRANDCHILD was force-killed too (tree kill)', grandchildAlive === false);

// Scenario 4 (win32 only): the primary deployment target installs `claude` as an
// npm .cmd shim, which the wrapper must invoke through the shell (Node refuses
// direct .cmd spawn since CVE-2024-27980). Prove a real .cmd runs and its exit
// code propagates. On POSIX this platform path cannot execute — recorded as a
// skip, not silently dropped.
if (process.platform === 'win32') {
  const stubCmd = join(root, 'fake-claude-shim.cmd');
  writeFileSync(stubCmd, '@echo off\r\necho CMD_SHIM_RAN arg=%1\r\nexit /b 5\r\n');
  const logDir4 = join(root, 'external-logs-4');
  const cmdRes = spawnSync(process.execPath, [WRAPPER], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CLEANFILES_AUDIT_REPO: repoDir,
      CLEANFILES_AUDIT_LOGDIR: logDir4,
      CLEANFILES_AUDIT_CMD: JSON.stringify([stubCmd, '/cleanfiles audit']),
    },
  });
  const logs4 = existsSync(logDir4) ? readdirSync(logDir4).filter((f) => /^audit-/.test(f)) : [];
  const logText4 = logs4.length ? readFileSync(join(logDir4, logs4[0]), 'utf8') : '';
  check('win32 .cmd shim: shim executed through the shell', logText4.includes('CMD_SHIM_RAN'));
  check('win32 .cmd shim: exit code propagates (5)', cmdRes.status === 5);
} else {
  check('win32 .cmd shim: skipped (POSIX host — cannot execute the win32 path)', true);
}

rmSync(root, { recursive: true, force: true });

console.log(`Cases: ${pass + fails.length}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL | ${f}`);
  console.log(`(wrapper exit was ${result.status}; log dir had: ${logs.join(', ') || 'none'})`);
  process.exit(1);
}
process.exit(0);
