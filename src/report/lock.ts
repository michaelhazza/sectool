import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const LOCK_PATH = resolve(REPO_ROOT, 'reports', '.lock');

const HEARTBEAT_INTERVAL_MS = 60_000;
// Break a lock whose holder cannot be verified alive only after 5× heartbeat intervals
const STALE_THRESHOLD_MS = 5 * HEARTBEAT_INTERVAL_MS;

export class WorkspaceLockedError extends Error {
  readonly pid: number;
  readonly heartbeatAt: string;

  constructor(pid: number, heartbeatAt: string) {
    super(`Workspace is locked by pid ${pid} (heartbeat: ${heartbeatAt})`);
    this.name = 'WorkspaceLockedError';
    this.pid = pid;
    this.heartbeatAt = heartbeatAt;
  }
}

interface LockRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface Clock {
  now(): number;
}

const realClock: Clock = { now: () => Date.now() };

function readLockRecord(path: string): LockRecord | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['pid'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['startedAt'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['heartbeatAt'] === 'string'
    ) {
      return parsed as LockRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify pid liveness.
 * - 'dead'  : ESRCH — proven dead, safe to break immediately.
 * - 'alive' : signal succeeded or EPERM — a real process exists.
 * - 'unknown': any other error — can't determine (different host, etc.).
 */
function pidLiveness(pid: number): 'dead' | 'alive' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Returns true when the lock record's heartbeat is older than STALE_THRESHOLD_MS.
 * Used ONLY when pid liveness is 'unknown' (e.g. recorded on another host).
 */
function isHeartbeatStale(record: LockRecord, clock: Clock): boolean {
  const hb = new Date(record.heartbeatAt).getTime();
  if (isNaN(hb)) return true; // unparseable heartbeat counts as stale
  return clock.now() - hb > STALE_THRESHOLD_MS;
}

/**
 * Determine whether a held lock may be broken, per §14 rules:
 * 1. Holder pid is provably dead (ESRCH) → break immediately.
 * 2. Pid liveness is unknown AND heartbeat is stale → break.
 * A live pid (alive or EPERM) is NEVER broken regardless of elapsed run time.
 */
function canBreakLock(record: LockRecord, clock: Clock): boolean {
  const liveness = pidLiveness(record.pid);
  if (liveness === 'dead') return true;
  if (liveness === 'alive') return false;
  // unknown: only break when heartbeat is also stale
  return isHeartbeatStale(record, clock);
}

/**
 * Attempt to acquire the workspace lock at LOCK_PATH.
 *
 * Returns a LockHandle whose `refresh()` must be called ≥ every 60s for long
 * operations, and whose `release()` must be called when the operation completes.
 *
 * Throws WorkspaceLockedError immediately (no blocking wait) if the lock is
 * held by a provably-live holder (§14).
 *
 * The `clock` and `lockPath` parameters exist for deterministic testing only.
 */
export async function acquireLock(opts?: {
  clock?: Clock;
  lockPath?: string;
}): Promise<LockHandle> {
  const clock = opts?.clock ?? realClock;
  const lockPath = opts?.lockPath ?? LOCK_PATH;

  await mkdir(dirname(lockPath), { recursive: true });

  const now = new Date(clock.now()).toISOString();
  const record: LockRecord = {
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
  };

  let acquired = false;
  let existingRecord: LockRecord | null = null;

  // Try create-exclusive write
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    writeFileSync(lockPath, JSON.stringify(record), 'utf8');
    acquired = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lock file exists — check if the holder is dead or stale
    existingRecord = readLockRecord(lockPath);
  }

  if (!acquired) {
    if (existingRecord !== null && canBreakLock(existingRecord, clock)) {
      // Holder is provably gone — break the lock
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have already removed it — continue
      }
      // Retry once after breaking
      try {
        const fd = openSync(lockPath, 'wx');
        closeSync(fd);
        writeFileSync(lockPath, JSON.stringify(record), 'utf8');
        acquired = true;
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code !== 'EEXIST') throw retryErr;
        // Someone else grabbed it between our unlink and our retry
        acquired = false;
      }
    }

    if (!acquired) {
      const holder = existingRecord ?? { pid: 0, startedAt: '', heartbeatAt: '' };
      throw new WorkspaceLockedError(holder.pid, holder.heartbeatAt);
    }
  }

  return new LockHandle(lockPath, record, clock);
}

export class LockHandle {
  private _released = false;
  private _heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly lockPath: string,
    private record: LockRecord,
    private readonly clock: Clock,
  ) {
    // Start automatic heartbeat refresh every HEARTBEAT_INTERVAL_MS
    this._heartbeatTimer = setInterval(() => {
      if (!this._released) this.refresh();
    }, HEARTBEAT_INTERVAL_MS);
    // Allow Node to exit while the interval is pending
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  /**
   * Refresh the heartbeatAt timestamp in the lock file.
   * Write is atomic: write to a tmp file then rename over the lock file.
   */
  refresh(): void {
    if (this._released) return;
    this.record = { ...this.record, heartbeatAt: new Date(this.clock.now()).toISOString() };
    const tmp = `${this.lockPath}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(this.record), 'utf8');
      renameSync(tmp, this.lockPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Release the lock by removing the lock file.
   */
  release(): void {
    if (this._released) return;
    this._released = true;
    if (this._heartbeatTimer !== undefined) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = undefined;
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already removed — fine
    }
  }
}

/**
 * Run `fn` while holding the workspace lock. Releases the lock in a finally
 * block. Throws WorkspaceLockedError if the lock is held by a live process.
 */
export async function withWorkspaceLock<T>(
  fn: () => Promise<T>,
  opts?: { clock?: Clock; lockPath?: string },
): Promise<T> {
  const handle = await acquireLock(opts);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
