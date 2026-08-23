#!/usr/bin/env node
/**
 * SessionStart hook: code-graph-freshness-check
 *
 * OPT-IN as of v2.67.0 — no longer registered in the shipped settings.json.
 * Consumers that want session-start freshness checks re-add the SessionStart
 * entry locally. Rationale: measured zero cache consumption across ~90
 * sessions at two consumers (2026-08-07 audit); the cache remains available
 * on demand via scripts/build-code-graph.ts.
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REFERENCES_DIR = join(PROJECT_DIR, 'references');
const WATCHER_PID_PATH = join(REFERENCES_DIR, '.watcher.pid');
const BUILD_SCRIPT_PATH = join(PROJECT_DIR, 'scripts', 'build-code-graph.ts');

// Mutable runtime state (stamps, locks) MUST live under the gitignored
// .claude/session-state/ — never references/ (committed tree). A migration
// (v2.65.0) appends this path to the consumer .gitignore when absent.
const SESSION_STATE_DIR = join(PROJECT_DIR, '.claude', 'session-state');
const AUDIT_STAMP_PATH = join(SESSION_STATE_DIR, '.audit-context-packs.stamp');
// The lock is a DIRECTORY. mkdir is the one filesystem operation that is
// atomically exclusive on POSIX and Windows alike (it fails if the target
// exists), which makes it the correct dependency-free mutex — no read-then-act
// TOCTOU. Staleness is the dir's own mtime.
const REBUILD_LOCK_DIR = join(SESSION_STATE_DIR, '.code-graph-rebuild.lock.d');
// The lock dir carries owner metadata: the detached rebuild's pid, written once
// 'spawn' confirms. Reaping a stale lock KILLS that owner (and its process
// group) first — so a hung rebuild is terminated, not accumulated beside.
const REBUILD_OWNER_PATH = join(REBUILD_LOCK_DIR, 'owner.pid');
const REAPER_LOCK_DIR = join(SESSION_STATE_DIR, '.code-graph-reaper.lock.d');
const REBUILD_LOCK_STALE_MS = 10 * 60_000; // a crashed rebuild cannot wedge the cold path past this
const REAPER_STALE_MS = 60_000; // a reap is milliseconds; this long means the reaper itself crashed
const SPAWN_SETTLE_TIMEOUT_MS = 3_000; // wait this long for spawn/error before exiting anyway (never hang session start)

// Paths for audit-context-packs: prefer consumer-local, fall back to framework submodule.
const AUDIT_SCRIPT_LOCAL = join(PROJECT_DIR, 'scripts', 'audit-context-packs.ts');
const AUDIT_SCRIPT_FRAMEWORK = join(PROJECT_DIR, '.claude-framework', 'scripts', 'audit-context-packs.ts');

// Generous upper bound. Spec says cold build completes in <30s; warm cache is
// sub-second. 60s leaves headroom for the rare cold start on a slow machine
// without ever hanging a session indefinitely.
const BUILD_TIMEOUT_MS = 60_000;

/**
 * Resolve a command to an existing executable on Windows using PATH + PATHEXT,
 * or null if it cannot be found. The rebuild/audit spawns use `shell: true` on
 * win32 (npm installs `npx` as npx.cmd, which Node cannot spawn directly since
 * the CVE-2024-27980 hardening). Under shell:true a MISSING command still spawns
 * cmd.exe successfully, so Node fires 'spawn' (not 'error') and a failed launch
 * is mis-reported as a started rebuild (the lock is then never released). This
 * pre-resolution detects the missing launcher up front so the failure path runs.
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

/** Best-effort mkdir for the runtime state dir. Never throws. */
function ensureSessionStateDir() {
  try { mkdirSync(SESSION_STATE_DIR, { recursive: true }); } catch { /* fail-open */ }
}

/**
 * Newest mtime (ms) across the audit-context-packs inputs (architecture.md and
 * every docs/context-packs/*). 0 when none exist — an absent input never
 * triggers a run. Used to skip the ~sub-second audit spawn in steady state.
 */
function auditInputsFingerprint() {
  // A MEMBERSHIP fingerprint, not a max mtime. Max-mtime silently misses a
  // deletion: if the newest context-pack is removed, the remaining max drops
  // BELOW the stamp and the audit is wrongly skipped even though the pack set
  // (which the audit validates) just changed.
  //
  // Context packs are small, so they are CONTENT-HASHED — any edit changes the
  // fingerprint, including a same-size edit with a preserved mtime.
  // architecture.md is large (can be ~1MB) and is fingerprinted by size+mtime as
  // a deliberate session-start latency tradeoff: a same-size edit with an
  // explicitly-preserved mtime on architecture.md will be missed until either
  // changes. That is the documented limit of this check, not an oversight.
  const parts = [];
  const stampHash = (label, p) => {
    try { parts.push(`${label}:${createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 16)}`); } catch { /* ignore */ }
  };
  try {
    const arch = join(PROJECT_DIR, 'architecture.md');
    if (existsSync(arch)) {
      const st = statSync(arch);
      parts.push(`architecture.md:${st.size}:${st.mtimeMs}`);
    }
  } catch { /* ignore */ }
  try {
    const packDir = join(PROJECT_DIR, 'docs', 'context-packs');
    if (existsSync(packDir)) {
      for (const name of readdirSync(packDir).sort()) stampHash(name, join(packDir, name));
    }
  } catch { /* ignore */ }
  return parts.join('|');
}

/**
 * mtime-gated audit: skip the spawn when neither architecture.md nor any
 * context-pack changed since the last successful run (steady-state fast path).
 * Only a SUCCESSFUL audit stamps, so a failing state (broken anchors) keeps
 * re-surfacing every session until fixed. Stamp write is best-effort and lands
 * in the gitignored session-state dir, so it never dirties git status.
 */
function maybeRunAudit() {
  const cur = auditInputsFingerprint();
  let stamp = '';
  try { stamp = readFileSync(AUDIT_STAMP_PATH, 'utf8').trim(); } catch { /* no stamp yet */ }
  if (cur !== '' && cur === stamp) return { audit: 'skipped', reason: 'inputs_unchanged' };
  const res = runAuditContextPacks();
  if (res.audit === 'ok' && cur !== '') {
    ensureSessionStateDir();
    try { writeFileSync(AUDIT_STAMP_PATH, cur); } catch { /* fail-open */ }
  }
  return res;
}

/** mtime of a lock directory in ms, or 0 if absent/unreadable (→ treated as very old). */
function lockAgeMtime(dir) {
  try { return statSync(dir).mtimeMs; } catch { return 0; }
}

/**
 * Kill the previous rebuild owner AND its process tree. Detached POSIX children
 * are process-group leaders, so kill(-pid) takes the whole group; Windows uses
 * taskkill /T /F. SIGKILL is uncatchable — a hung rebuild cannot ignore it.
 */
function killOwnerTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* already dead */ }
}

/**
 * Claim the rebuild lock so two sessions starting together cannot both launch a
 * CPU-heavy detached rebuild. Returns 'claimed' | 'takeover' | 'busy'.
 *
 * The lock is a DIRECTORY: mkdir is atomically exclusive, so the fresh claim has
 * no read-then-act race — of N simultaneous contenders exactly one mkdir wins.
 *
 * Stale takeover is the hard part, and the earlier hand-rolled variants (rm+wx,
 * rename-quarantine) were all raceable because they act on the lock PATH, whose
 * contents can change between inspect and act, so one contender could reap
 * another's FRESH lock. This version instead ELECTS A SINGLE REAPER via a second
 * atomic mkdir: only the reaper may remove + re-create the main lock, so two
 * reapers reaping the same generation is impossible. Provable invariant: a
 * process replaces the main lock ONLY while holding the reaper lock, and the
 * reaper lock admits exactly one holder. Reaping first KILLS the recorded owner
 * (see killOwnerTree), so live rebuilds are bounded to AT MOST ONE — a hung
 * rebuild is terminated by the takeover, never accumulated beside. The sole
 * residual is a reaper that CRASHES mid-reap (leaving the reaper lock held);
 * that is recovered best-effort after REAPER_STALE_MS, and its worst case is one
 * redundant background rebuild — never a wedged path.
 */
function tryClaimRebuildLock() {
  ensureSessionStateDir();
  // Fresh exclusive claim — atomic, race-free.
  try { mkdirSync(REBUILD_LOCK_DIR); return 'claimed'; } catch { /* held */ }

  if (Date.now() - lockAgeMtime(REBUILD_LOCK_DIR) < REBUILD_LOCK_STALE_MS) return 'busy';

  // Stale — elect a SINGLE reaper. Only the reaper may replace the main lock.
  let reaper = false;
  try { mkdirSync(REAPER_LOCK_DIR); reaper = true; } catch { /* another reaper is active */ }
  if (!reaper) {
    // Recover a crashed reaper (best-effort; the atomic mkdir below still admits
    // only one winner even if several sessions race this recovery).
    if (Date.now() - lockAgeMtime(REAPER_LOCK_DIR) >= REAPER_STALE_MS) {
      try { rmSync(REAPER_LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      try { mkdirSync(REAPER_LOCK_DIR); reaper = true; } catch { /* lost the race */ }
    }
  }
  if (!reaper) return 'busy';

  let result = 'busy';
  try {
    // RE-CHECK under the reaper lock. Our staleness decision was made before we
    // acquired the reaper; another reaper may have already replaced the main lock
    // with a FRESH one in between (it then released the reaper, letting us acquire
    // it). Reaping now would destroy that fresh lock and double-run. Only reap if
    // the main lock is STILL stale at this point.
    if (Date.now() - lockAgeMtime(REBUILD_LOCK_DIR) >= REBUILD_LOCK_STALE_MS) {
      // KILL the previous owner before reaping. Without this, a HUNG rebuild
      // (spawned fine, never finishes, never touches the lock mtime) would be
      // orphaned by the takeover and a new rebuild launched beside it — and
      // again every STALE_MS, accumulating hung processes without bound. Killing
      // on reap bounds live rebuilds to AT MOST ONE: takeover implies the
      // predecessor is dead. (A hung rebuild with no later session lives until
      // the next session start — that is the enforcement point.)
      try {
        const ownerPid = Number.parseInt(readFileSync(REBUILD_OWNER_PATH, 'utf8').trim(), 10);
        killOwnerTree(ownerPid);
      } catch { /* no owner recorded (crashed before spawn) — nothing to kill */ }
      rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
      try { mkdirSync(REBUILD_LOCK_DIR); result = 'takeover'; }
      catch { result = 'busy'; } // a fresh claimer slipped in between rm and mkdir — do not double-run
    }
  } finally {
    try { rmSync(REAPER_LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return result;
}

/** Best-effort lock removal (called once a live watcher proves the rebuild finished). */
function clearRebuildLock() {
  try { rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true }); } catch { /* fail-open */ }
}

/**
 * Spawn the code-graph rebuild DETACHED and return immediately, so session start
 * is never blocked for the cold rebuild (previously up to BUILD_TIMEOUT_MS). The
 * detached child rebuilds the cache and re-establishes the watcher; the lock it
 * ran under is cleared by a later watcher-alive session or by stale-takeover.
 */
function spawnDetachedRebuild(onSpawn, onError, onUnknown) {
  if (!existsSync(BUILD_SCRIPT_PATH)) return { skipped: true, reason: 'build script missing' };
  if (process.platform === 'win32' && !resolveWindowsExecutable('npx')) {
    // Under shell:true a missing npx would spawn cmd.exe and fire 'spawn' (not
    // 'error'), mis-reporting a failed launch as a started rebuild and leaving
    // the lock held. Detect the missing launcher up front and route to onError,
    // which releases the lock and warns (POSIX gets this via the 'error' event).
    onError(Object.assign(new Error('npx not found on PATH'), { code: 'ENOENT' }));
    return { deferred: true };
  }
  let child;
  try {
    child = spawn('npx', ['tsx', BUILD_SCRIPT_PATH], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // Rare synchronous throw (e.g. bad options). Async failures come via 'error'.
    return { skipped: false, error: err };
  }
  // spawn() reports success via 'spawn' and failure (ENOENT on npx, etc.)
  // ASYNCHRONOUSLY via 'error'. The caller must NOT print "rebuilding in the
  // background" or exit until we know which happened, or a failed spawn is both
  // mis-reported as started AND its async error is dropped by an early
  // process.exit(). We defer to onSpawn/onError, unref()-ing only on success so
  // the parent stays attached long enough to observe the result. A bounded
  // timeout is a THIRD outcome — never reported as success: if `child.pid` is
  // set the OS did create the process (positive evidence → treat as spawned),
  // otherwise onUnknown fails open (warn + release the lock so a retry is
  // possible) rather than claiming a rebuild that may never have started.
  let settled = false;
  const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
  child.on('spawn', () => settle(() => { try { child.unref(); } catch { /* ignore */ } onSpawn(child.pid); }));
  child.on('error', (err) => settle(() => onError(err)));
  const timer = setTimeout(() => settle(() => {
    if (child.pid) { try { child.unref(); } catch { /* ignore */ } onSpawn(child.pid); }
    else onUnknown();
  }), SPAWN_SETTLE_TIMEOUT_MS);
  timer.unref();
  return { deferred: true };
}

function runSessionStartChecks() {
  // branch: watcher-alive — watcher is live; cache is current.
  if (watcherAlive()) {
    // A live watcher proves any prior detached rebuild finished — clear its lock.
    clearRebuildLock();
    // Cache is being kept live — no refresh needed, but the audit-context-packs
    // check MUST still run (mtime-gated): stale anchors can drift in the
    // watcher-alive steady state too (a heading rename invalidates context-pack
    // links regardless of whether the code-intelligence cache is fresh).
    maybeRunAudit();
    return { freshness: 'watcher_alive' };
  }

  // branch: watcher-dead — rebuild is needed. Do NOT block session start on it:
  // claim the lock and spawn the rebuild detached, exiting immediately.
  let freshnessResult;
  const claim = tryClaimRebuildLock();
  if (claim === 'busy') {
    process.stdout.write('Code intelligence cache rebuild already running in another session; session continues.\n');
    freshnessResult = { freshness: 'rebuild_in_progress' };
  } else {
    const spawned = spawnDetachedRebuild(
      (pid) => {
        // onSpawn: the rebuild actually started. Record its pid inside the lock
        // dir (kill-on-reap metadata), report it, run the audit, exit.
        try { writeFileSync(REBUILD_OWNER_PATH, String(pid)); } catch { /* best-effort */ }
        process.stdout.write('Code intelligence cache rebuilding in the background (watcher was down); session continues.\n');
        maybeRunAudit();
        process.exit(0);
      },
      (err) => {
        // onError: the spawn FAILED (e.g. ENOENT on npx). Correct the record with
        // a visible fail-open warning, release the lock so a later session can
        // retry, run the audit, exit.
        process.stderr.write(
          `code-graph: background rebuild failed to start (${err && err.code ? err.code : 'spawn error'}). ` +
          `Session continues; cache refresh skipped.\n`,
        );
        clearRebuildLock();
        maybeRunAudit();
        process.exit(0);
      },
      () => {
        // onUnknown: neither 'spawn' nor 'error' arrived within the settle window
        // AND no pid was assigned — spawn status is unconfirmed. Do NOT claim a
        // rebuild started; fail open, release the lock so a later session retries.
        process.stderr.write(
          'code-graph: background rebuild spawn status unconfirmed; releasing lock, session continues.\n',
        );
        clearRebuildLock();
        maybeRunAudit();
        process.exit(0);
      },
    );
    if (spawned.skipped) {
      // branch: build-script-missing — framework not (yet) fully imported; degrade silently.
      clearRebuildLock();
      maybeRunAudit();
      return { freshness: 'skipped', reason: 'build script missing' };
    }
    if (spawned.error) {
      // branch: spawn threw synchronously (rare).
      clearRebuildLock();
      process.stderr.write(
        `code-graph-freshness-check: detached rebuild spawn failed (${spawned.error.code || spawned.error.message}). ` +
        `Cache is advisory; session continues.\n`,
      );
      maybeRunAudit();
      return { freshness: 'failed', reason: 'spawn' };
    }
    // deferred: the onSpawn/onError handler owns the audit + exit.
    return { freshness: 'rebuild_spawned', deferExit: true };
  }

  maybeRunAudit();
  return freshnessResult;
}

function main() {
  try {
    const result = runSessionStartChecks();
    // The deferred rebuild path exits from its own spawn/error handler; every
    // other path exits here.
    if (!(result && result.deferExit)) process.exit(0);
  } catch (err) {
    process.stderr.write(
      `code-graph-freshness-check: unexpected error: ${err && err.message}\n`,
    );
    process.exit(0);
  }
}

main();
