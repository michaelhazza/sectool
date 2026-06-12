#!/usr/bin/env node
/**
 * SessionStart hook: code-graph-freshness-check
 *
 * Keeps the code intelligence cache (Phase 0) fresh across Claude Code
 * sessions where the dev server is not running.
 *
 * The cache's primary lifecycle is:
 *   `npm run dev` → predev → tsx scripts/build-code-graph.ts → detached
 *   chokidar watcher persists across the dev session.
 *
 * If the user does Claude-Code-only work without `npm run dev`, the
 * watcher is never (re)started after the previous dev session ends.
 * The cache then silently drifts as files are edited and agents read
 * stale data — exactly the failure mode the Phase 0 plan calls out as
 * "the most concerning failure mode."
 *
 * Mechanism:
 *   1. If references/.watcher.pid points at a live process, the watcher
 *      is keeping the cache fresh on every save. Exit fast (no-op).
 *   2. Otherwise spawn `tsx scripts/build-code-graph.ts` synchronously.
 *      This:
 *        - SHA256-walks source against the existing cache, re-extracting
 *          only changed files (sub-second on warm cache, a few seconds
 *          cold per the Phase 0 spec)
 *        - rewrites shards atomically for any drift
 *        - prunes deleted files
 *        - spawns a fresh detached watcher (singleton lock-protected;
 *          coexists safely with any concurrent session start)
 *
 *   Subsequent session starts find a live watcher and take the fast
 *   path — there is no per-session cost in the steady state.
 *
 * Exit policy:
 *   - Always exit 0. The cache is an advisory hint layer; a hook bug
 *     or build failure must never block session start.
 *   - On successful refresh, write a one-line confirmation to stdout
 *     so the SessionStart context records that the cache was touched.
 *   - On failure, log to stderr and exit 0.
 *
 * Portability note (framework export):
 *   - If scripts/build-code-graph.ts is missing, exit 0 silently. This
 *     lets the hook ship inside .claude/ without hard-requiring the
 *     code-graph generator to also be imported into the target repo
 *     yet (e.g. mid-incremental-import).
 *
 * audit-context-packs check:
 *   - After the freshness check, run audit-context-packs (if present).
 *   - Runs fail-open: a non-zero exit logs a warning to stderr but
 *     does NOT block session start.
 *   - If the script is missing (pre-v2.13.0 consumer), silently skip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REFERENCES_DIR = join(PROJECT_DIR, 'references');
const WATCHER_PID_PATH = join(REFERENCES_DIR, '.watcher.pid');
const BUILD_SCRIPT_PATH = join(PROJECT_DIR, 'scripts', 'build-code-graph.ts');

// Paths for audit-context-packs: prefer consumer-local, fall back to framework submodule.
const AUDIT_SCRIPT_LOCAL = join(PROJECT_DIR, 'scripts', 'audit-context-packs.ts');
const AUDIT_SCRIPT_FRAMEWORK = join(PROJECT_DIR, '.claude-framework', 'scripts', 'audit-context-packs.ts');

// Generous upper bound. Spec says cold build completes in <30s; warm cache is
// sub-second. 60s leaves headroom for the rare cold start on a slow machine
// without ever hanging a session indefinitely.
const BUILD_TIMEOUT_MS = 60_000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    // ESRCH (and anything else) means dead or unreachable.
    return Boolean(err && err.code === 'EPERM');
  }
}

function watcherAlive() {
  if (!existsSync(WATCHER_PID_PATH)) return false;
  try {
    const raw = readFileSync(WATCHER_PID_PATH, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function refreshCache() {
  if (!existsSync(BUILD_SCRIPT_PATH)) {
    return { skipped: true, reason: 'build script missing' };
  }
  const result = spawnSync('npx', ['tsx', BUILD_SCRIPT_PATH], {
    cwd: PROJECT_DIR,
    timeout: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // npx is a `.cmd` shim on Windows; shell=true lets the OS resolve it.
    shell: process.platform === 'win32',
  });
  return { skipped: false, result };
}

/**
 * runSessionStartChecks() — orchestrates freshness + audit checks.
 *
 * Preserves all original branch behaviours, now as return-paths rather than
 * early exits. The single terminal exit lives in main() below.
 *
 * Branch dispositions (original → post-refactor):
 *   watcher-alive         : was early exit immediately → now returns early,
 *                           audit check still runs.
 *   build-script-missing  : was silent early exit → records
 *                           freshness:'skipped', continues to audit.
 *   spawn-failed          : was stderr + early exit → same stderr message,
 *                           records freshness:'failed', continues to audit.
 *   refresh-failed        : was stderr (2 lines) + early exit → same two
 *                           stderr messages, records freshness:'failed'.
 *   refresh-succeeded     : was stdout + early exit → same stdout line,
 *                           records freshness:'refreshed', continues.
 *   catch-handler         : outer try/catch in main() still terminates as
 *                           a fallback safety net (branch 6 unchanged).
 */
/**
 * Run the audit-context-packs check. Fail-open: surfaces failures as stderr
 * warnings, never blocks session start. Returns the disposition so callers can
 * log it.
 *
 * Extracted so it can be called from BOTH branches of runSessionStartChecks
 * (watcher-alive and watcher-dead) — the docstring on runSessionStartChecks
 * promises the audit runs in both paths.
 */
function runAuditContextPacks() {
  // Prefer consumer-local script; fall back to framework submodule copy.
  const auditScriptPath = existsSync(AUDIT_SCRIPT_LOCAL)
    ? AUDIT_SCRIPT_LOCAL
    : existsSync(AUDIT_SCRIPT_FRAMEWORK)
      ? AUDIT_SCRIPT_FRAMEWORK
      : null;

  if (auditScriptPath === null) {
    // Script missing (pre-v2.13.0 consumer) — silent skip.
    return { audit: 'skipped', reason: 'script_missing' };
  }

  const auditResult = spawnSync('npx', ['tsx', auditScriptPath], {
    cwd: PROJECT_DIR,
    timeout: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (auditResult.error) {
    // Spawn itself failed (timeout, ENOENT on npx, etc.). Surface fail-open.
    process.stderr.write(
      `audit-context-packs: spawn failed (${auditResult.error.code || auditResult.error.message}). ` +
      `Session continues.\n`,
    );
    return { audit: 'failed', reason: 'spawn' };
  }

  if (auditResult.status !== 0) {
    // The audit detected broken anchors OR the script itself errored. Surface
    // BOTH stdout (broken-anchor lines) AND stderr (script errors such as
    // "architecture.md not found"). Earlier this only surfaced stdout, so
    // stderr-only failures were swallowed.
    const stdout = auditResult.stdout ? String(auditResult.stdout) : '';
    const stderr = auditResult.stderr ? String(auditResult.stderr) : '';
    if (stdout || stderr) {
      process.stderr.write(
        `audit-context-packs: broken anchors detected (fix before finalisation):\n${stdout}${stderr}`,
      );
    } else {
      // Non-zero exit with no output — surface the bare status so the failure is visible.
      process.stderr.write(
        `audit-context-packs: exited ${auditResult.status} with no output. Session continues.\n`,
      );
    }
    return { audit: 'failed', reason: 'status_nonzero' };
  }

  return { audit: 'ok' };
}

function runSessionStartChecks() {
  // branch: watcher-alive — watcher is live; cache is current.
  if (watcherAlive()) {
    // Cache is being kept live — no refresh needed, but the audit-context-packs
    // check MUST still run: stale anchors can drift in the watcher-alive steady
    // state too (a heading rename invalidates context-pack links regardless of
    // whether the code-intelligence cache is fresh).
    runAuditContextPacks();
    return { freshness: 'watcher_alive' };
  }

  const refresh = refreshCache();
  let freshnessResult;

  if (refresh.skipped) {
    // branch: build-script-missing — framework not (yet) fully imported; degrade silently.
    freshnessResult = { freshness: 'skipped', reason: 'build script missing' };
  } else {
    const { result } = refresh;
    if (result.error) {
      // branch: spawn-failed — spawnSync itself failed (e.g. timeout, ENOENT on npx).
      process.stderr.write(
        `code-graph-freshness-check: spawn failed (${result.error.code || result.error.message}). ` +
        `Cache is advisory; session continues.\n`,
      );
      freshnessResult = { freshness: 'failed', reason: 'spawn' };
    } else if (result.status !== 0) {
      // branch: refresh-failed — build exited non-zero.
      process.stderr.write(
        `code-graph-freshness-check: build exited ${result.status}. ` +
        `Cache may be stale; session continues.\n`,
      );
      if (result.stderr) {
        process.stderr.write(`build stderr (last 400 chars): ${String(result.stderr).slice(-400)}\n`);
      }
      freshnessResult = { freshness: 'failed', reason: 'build_status_nonzero' };
    } else {
      // branch: refresh-succeeded — cache refreshed successfully.
      // Surface a one-line note into the SessionStart context so the agent
      // knows the cache was just refreshed (and that any prior staleness has
      // been resolved for this session).
      process.stdout.write('Code intelligence cache refreshed at session start (watcher restarted).\n');
      freshnessResult = { freshness: 'refreshed' };
    }
  }

  runAuditContextPacks();
  return freshnessResult;
}

function main() {
  try {
    runSessionStartChecks();
    // branch: catch-handler — outer safety net; single terminal exit below.
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `code-graph-freshness-check: unexpected error: ${err && err.message}\n`,
    );
    process.exit(0);
  }
}

main();
