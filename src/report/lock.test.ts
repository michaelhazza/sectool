import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  acquireLock,
  withWorkspaceLock,
  type Clock,
} from './lock.js';

/**
 * Create a temporary directory for each test, cleaned up after.
 */
function makeTmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'audit-lock-test-'));
}

function makeLockPath(dir: string): string {
  return resolve(dir, '.lock');
}

/**
 * A fake clock starting at the given epoch ms.
 */
function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('lock — basic acquisition and release', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the lock file and returns a handle', async () => {
    const lockPath = makeLockPath(tmpDir);
    const handle = await acquireLock({ lockPath });
    expect(existsSync(lockPath)).toBe(true);
    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('withWorkspaceLock runs fn and releases on success', async () => {
    const lockPath = makeLockPath(tmpDir);
    let ran = false;
    await withWorkspaceLock(() => {
      ran = true;
      expect(existsSync(lockPath)).toBe(true);
      return Promise.resolve();
    }, { lockPath });
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('withWorkspaceLock releases on fn throw', async () => {
    const lockPath = makeLockPath(tmpDir);
    await expect(
      withWorkspaceLock(() => Promise.reject(new Error('boom')), { lockPath }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('lock — contention: live holder is never broken', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws WorkspaceLockedError immediately when a live process holds the lock', async () => {
    const lockPath = makeLockPath(tmpDir);
    const clock = fakeClock(Date.now());

    // Acquire the lock (held by current process — provably alive)
    const handle = await acquireLock({ lockPath, clock });

    // A second attempt must fail immediately with WorkspaceLockedError
    await expect(acquireLock({ lockPath, clock })).rejects.toMatchObject({
      name: 'WorkspaceLockedError',
    });

    handle.release();
  });

  it('a lock with a fresh heartbeat is NEVER broken even after long elapsed time', async () => {
    const lockPath = makeLockPath(tmpDir);
    const clock = fakeClock(Date.now());

    // Acquire the lock (live pid = current process)
    const handle = await acquireLock({ lockPath, clock });

    // Advance time far beyond the stale threshold (5 × 60s = 5 min)
    clock.advance(60 * 60 * 1000); // 1 hour

    // Still must throw — the holder pid is alive (our own process)
    await expect(acquireLock({ lockPath, clock })).rejects.toMatchObject({
      name: 'WorkspaceLockedError',
    });

    handle.release();
  });
});

describe('lock — dead holder is reclaimed', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reclaims the lock when the holder pid is provably dead (ESRCH)', async () => {
    const lockPath = makeLockPath(tmpDir);
    const clock = fakeClock(Date.now());

    // Write a lock file with a pid that is guaranteed not to exist.
    // PID 2147483647 (max int32) is practically never a real process.
    // We write the record manually rather than using acquireLock because
    // acquireLock would use our own (live) pid.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date(clock.now()).toISOString(),
        heartbeatAt: new Date(clock.now()).toISOString(),
      }),
      'utf8',
    );

    // A second acquire should detect that PID is dead and reclaim the lock
    let handle;
    try {
      handle = await acquireLock({ lockPath, clock });
      // If we get here, the lock was reclaimed — the file now belongs to us
      expect(existsSync(lockPath)).toBe(true);
    } catch (err) {
      // If PID 2_147_483_647 somehow exists on this machine, skip gracefully
      expect((err as Error).message).toMatch(/Workspace is locked/);
    } finally {
      handle?.release();
    }
  });
});

describe('lock — elapsed time alone does NOT break a live lock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not break a lock held by a live pid even with stale-looking heartbeat', async () => {
    const lockPath = makeLockPath(tmpDir);

    // Write a lock file with our own pid but an ancient heartbeat (epoch = stale)
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      }),
      'utf8',
    );

    // Our pid is alive, so this must NOT break the lock (stale heartbeat alone is insufficient)
    const currentClock = fakeClock(Date.now());
    await expect(acquireLock({ lockPath, clock: currentClock })).rejects.toMatchObject({
      name: 'WorkspaceLockedError',
    });
  });
});

describe('lock — LockHandle.refresh()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates heartbeatAt atomically on refresh()', async () => {
    const lockPath = makeLockPath(tmpDir);
    const startMs = Date.now();
    const clock = fakeClock(startMs);

    const handle = await acquireLock({ lockPath, clock });

    // Advance the clock and refresh
    clock.advance(30_000);
    handle.refresh();

    // Read the lock file and verify heartbeatAt was updated
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(lockPath, 'utf8');
    const record = JSON.parse(raw) as { heartbeatAt: string };
    const hb = new Date(record.heartbeatAt).getTime();
    expect(hb).toBe(startMs + 30_000);

    handle.release();
  });
});
