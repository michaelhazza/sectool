#!/usr/bin/env node
/**
 * cleanfiles-audit-headless.mjs — thin scheduler wrapper for `/cleanfiles audit`.
 *
 * See `.claude/commands/cleanfiles.md` § "Wire the clock". The native headless
 * invocation is `claude -p "/cleanfiles audit"`. Windows Task Scheduler's
 * "Start a program" action cannot express, in the task definition alone:
 *   (1) stdout/stderr redirection to a DATED file,
 *   (2) a per-run timeout on the child process,
 *   (3) reliable exit-code propagation through a shell one-liner.
 * This wrapper supplies exactly that orchestration around the native invocation.
 *
 * REPOSITORY PURITY: the wrapper writes ONLY to the external log directory
 * (default `%LOCALAPPDATA%\ClaudeCodeFramework\cleanfiles-audit\`), never inside
 * the audited repository. `/cleanfiles audit` is itself read-only (cleanfiles.md
 * § "Audit-mode purity"), so a scheduled run leaves the repo tree and HEAD
 * unchanged.
 *
 * Configuration (all optional, via environment):
 *   CLEANFILES_AUDIT_REPO        repo root to audit (cwd pin); default process.cwd()
 *   CLEANFILES_AUDIT_LOGDIR      external log directory; default under LOCALAPPDATA
 *   CLEANFILES_AUDIT_TIMEOUT_MS  per-run timeout in ms; default 900000 (15 min)
 *   CLEANFILES_AUDIT_CMD         JSON array overriding the whole command (testing)
 *   CLAUDE_BIN                   claude executable name/path; default "claude"
 *
 * Exit codes: the child's exit code is propagated verbatim; 124 on timeout-kill;
 * 127 on spawn failure.
 *
 * Invocation (documented in the "Wire the clock" section):
 *   node scripts/cleanfiles-audit-headless.mjs
 * (invocability via `node`, not a POSIX executable bit — the target is Windows.)
 *
 * Tests: scripts/cleanfiles-audit-headless.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';

const REPO = process.env.CLEANFILES_AUDIT_REPO || process.cwd();
const LOCALAPPDATA =
  process.env.LOCALAPPDATA ||
  join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Local');
const LOG_DIR =
  process.env.CLEANFILES_AUDIT_LOGDIR ||
  join(LOCALAPPDATA, 'ClaudeCodeFramework', 'cleanfiles-audit');
const TIMEOUT_MS = Number(process.env.CLEANFILES_AUDIT_TIMEOUT_MS || 15 * 60 * 1000);
// After the timeout kill, wait at most this long for 'close'; then settle as 124
// regardless, so an ignored signal / non-exiting child cannot leave the wrapper
// alive forever (the wrapper's whole reason for existing is a bounded per-run).
const TIMEOUT_GRACE_MS = Number(process.env.CLEANFILES_AUDIT_TIMEOUT_GRACE_MS || 5 * 1000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// The command the wrapper runs. Overridable as a JSON array for testing so the
// orchestration can be verified without invoking the real (and nesting-guarded)
// `claude` binary. `bypassPermissions` lets the read-only audit run unattended
// without a permission prompt; audit-mode purity keeps it write-free regardless.
const COMMAND = process.env.CLEANFILES_AUDIT_CMD
  ? JSON.parse(process.env.CLEANFILES_AUDIT_CMD)
  : [
      CLAUDE_BIN,
      '-p',
      '/cleanfiles audit',
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      '--no-session-persistence',
    ];

/** YYYY-MM-DD for the dated log filename. */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a command to an existing executable on Windows using PATH + PATHEXT,
 * or null if it cannot be found. Under `shell: true`, cmd.exe spawns SUCCESSFULLY
 * for a missing command and then reports "not recognized" with a locale-specific
 * message and an ambiguous exit code (1) — so Node never emits an 'error'/ENOENT
 * event and the wrapper cannot tell "command not found" from a real exit 1. This
 * pre-resolution restores the documented ENOENT -> 127 contract deterministically
 * and locale-independently, without giving up the shell (needed for .cmd shims).
 */
function resolveWindowsExecutable(cmd) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const hasKnownExt = /\.[^.\\/]+$/.test(cmd);
  const withExts = (base) => (hasKnownExt ? [base] : [base, ...exts.map((e) => base + e)]);
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    return withExts(cmd).find((c) => existsSync(c)) || null;
  }
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const hit = withExts(join(dir, cmd)).find((c) => existsSync(c));
    if (hit) return hit;
  }
  return null;
}

function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `audit-${isoDate(new Date())}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const started = new Date().toISOString();
  log.write(`\n===== cleanfiles-audit-headless @ ${started} (repo: ${REPO}) =====\n`);
  log.write(`[wrapper] command: ${JSON.stringify(COMMAND)}\n`);

  let child;
  if (process.platform === 'win32') {
    // ENOENT parity: under shell:true a missing command still spawns cmd.exe
    // cleanly (no 'error' event), so resolve the executable ourselves first and
    // settle as 127 on a miss — matching the POSIX spawn-failure contract.
    if (!resolveWindowsExecutable(COMMAND[0])) {
      log.write(`\n[wrapper] spawn error: command not found: ${COMMAND[0]} -> wrapper exit 127\n`);
      log.end(() => process.exit(127));
      return;
    }
    // The scheduled deployment target. An npm-installed `claude` is a .cmd shim,
    // which Node refuses to spawn directly since the CVE-2024-27980 hardening —
    // go through the shell with explicit per-arg quoting (spawn's own shell:true
    // arg joining does not quote embedded spaces like `/cleanfiles audit`).
    const cmdline = COMMAND.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    child = spawn(cmdline, {
      cwd: REPO, // (1) cwd pinning
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    });
  } else {
    // POSIX: detached → the child leads its OWN process group, so the timeout
    // path can kill the whole tree with kill(-pid) — a headless Claude run
    // spawns subprocesses, and killing only the direct child would orphan them.
    child = spawn(COMMAND[0], COMMAND.slice(1), {
      cwd: REPO, // (1) cwd pinning
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  }

  /** Signal the child's whole tree (POSIX process group / Windows taskkill /T). */
  function killTree(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        // ALWAYS target the tree via taskkill /T. child.kill() would
        // TerminateProcess only cmd.exe (the shell:true root) and orphan the real
        // worker + its grandchildren; the later force pass would then find no tree
        // under child.pid to kill, leaving orphans holding the repo cwd. /T keeps
        // the tree rooted at cmd.exe; /F (force) is added only on the hard kill.
        const args = signal === 'SIGKILL'
          ? ['/PID', String(child.pid), '/T', '/F']
          : ['/PID', String(child.pid), '/T'];
        spawnSync('taskkill', args, { windowsHide: true });
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    } catch { /* already dead */ }
  }

  // On a spawn failure the child has no stdio streams — guard the pipes.
  if (child.stdout) child.stdout.pipe(log, { end: false });
  if (child.stderr) child.stderr.pipe(log, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    safeWrite(`\n[wrapper] TIMEOUT after ${TIMEOUT_MS}ms — killing child\n`); // (2) per-run timeout
    killTree('SIGTERM'); // graceful, whole group on POSIX
    // Hard bound: if the tree ignores the signal or never emits 'close', FORCE
    // terminate it (so we never leave an orphan for an unattended scheduler) and
    // settle as 124. SIGKILL to the POSIX process GROUP is uncatchable and takes
    // grandchildren too; Windows taskkill /T /F terminates the tree.
    const grace = setTimeout(() => {
      killTree('SIGKILL');
      safeWrite(`\n[wrapper] child did not exit within ${TIMEOUT_GRACE_MS}ms of kill — force-killed (tree); wrapper exit 124\n`);
      finish(124);
    }, TIMEOUT_GRACE_MS);
    grace.unref();
  }, TIMEOUT_MS);

  // SINGLE settlement path. Node emits BOTH 'error' and (afterwards) 'close' on
  // a failed spawn; ending/exiting from each races and writes-after-end. A
  // `settled` flag makes exactly one of them win. A log 'error' listener keeps a
  // stream failure from crashing the wrapper (fail-open: still exit).
  let settled = false;
  let pendingErrorCode = null;
  function safeWrite(s) { try { log.write(s); } catch { /* stream ended/errored */ } }
  function finish(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { log.end(() => process.exit(code)); } catch { process.exit(code); }
  }
  log.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); process.exit(pendingErrorCode ?? 1); } });

  child.on('error', (err) => {
    pendingErrorCode = 127;
    safeWrite(`\n[wrapper] spawn error: ${err.message}\n`);
    // Do NOT end/exit here — 'close' fires after 'error' on a failed spawn and
    // owns the single settlement. Fallback in case 'close' never arrives.
    setImmediate(() => finish(127));
  });

  child.on('close', (code, signal) => {
    // (3) exit-code propagation: spawn-error 127 wins; else verbatim child code;
    // 124 on timeout-kill.
    const exitCode = pendingErrorCode != null ? pendingErrorCode : (timedOut ? 124 : code == null ? (signal ? 1 : 0) : code);
    safeWrite(`\n[wrapper] child exited code=${code} signal=${signal} -> wrapper exit ${exitCode}\n`);
    finish(exitCode);
  });
}

main();
