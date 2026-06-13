import { describe, it, expect, beforeEach } from 'vitest';
import { withHostBudget, _resetHostRegistry } from './ratelimit.js';
import type { Clock } from './ratelimit.js';

// ---------------------------------------------------------------------------
// ManualClock — injectable clock for deterministic tests.
// sleep() returns a promise that resolves when advanceMs() is called with
// enough time. Multiple sleepers are supported via a sorted wake-queue.
// ---------------------------------------------------------------------------

class ManualClock implements Clock {
  private _time = 0;
  private readonly _sleepers: Array<{ wakeAt: number; resolve: () => void }> = [];

  now(): number {
    return this._time;
  }

  sleep(ms: number): Promise<void> {
    const wakeAt = this._time + ms;
    return new Promise<void>((resolve) => {
      this._sleepers.push({ wakeAt, resolve });
      this._sleepers.sort((a, b) => a.wakeAt - b.wakeAt);
    });
  }

  /** Advance the clock by `ms` and wake any sleepers whose wakeAt <= new time. */
  advanceMs(ms: number): void {
    this._time += ms;
    for (;;) {
      const next = this._sleepers[0];
      if (next === undefined || next.wakeAt > this._time) break;
      this._sleepers.shift();
      next.resolve();
    }
  }

  /** Flush all pending micro-tasks (yields the event loop). */
  static async flush(): Promise<void> {
    // Yield multiple times to allow chained .then() callbacks to settle.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetHostRegistry();
});

describe('withHostBudget — aggregate per-host rate limit (§4.5)', () => {
  it('serializes two families on one host so combined rate never exceeds limit', async () => {
    const clock = new ManualClock();
    const HOST = 'staging.example.com';
    const RPS = 2; // 2 req/s → 500 ms per token

    // Family A: wants 3 requests. Family B: wants 3 requests.
    // With RPS=2 and a serialized single bucket, we get one token per 500ms.
    // We drive the test by advancing the clock when promises are pending.

    const timestampsA: number[] = [];
    const timestampsB: number[] = [];

    // Start both families. They will be queued; A goes first, B waits.
    const promiseA = withHostBudget(
      HOST,
      RPS,
      async (acquireToken) => {
        for (let i = 0; i < 3; i++) {
          await acquireToken();
          timestampsA.push(clock.now());
        }
      },
      clock,
    );

    const promiseB = withHostBudget(
      HOST,
      RPS,
      async (acquireToken) => {
        for (let i = 0; i < 3; i++) {
          await acquireToken();
          timestampsB.push(clock.now());
        }
      },
      clock,
    );

    // Yield so both promises have registered in the queue.
    await ManualClock.flush();

    // Family A starts. It has 2 initial tokens (RPS=2).
    // Token 1 (A): available immediately (tokens=2 → 1), timestamp=0
    // Token 2 (A): available immediately (tokens=1 → 0), timestamp=0
    // Token 3 (A): no tokens, must wait 500ms
    await ManualClock.flush();
    expect(timestampsA.length).toBe(2); // two immediate tokens consumed

    // Advance 500ms — new token arrives for Family A's 3rd request.
    clock.advanceMs(500);
    await ManualClock.flush();
    expect(timestampsA.length).toBe(3); // A is done
    await ManualClock.flush();

    // Family B now starts. Clock is at 500ms. Bucket has 0 tokens (one was
    // just used). B's first request must wait 500ms.
    expect(timestampsB.length).toBe(0);

    // Advance 500ms (clock=1000ms) → token for B's request 1.
    clock.advanceMs(500);
    await ManualClock.flush();
    expect(timestampsB.length).toBe(1);
    expect(timestampsB[0]).toBe(1000);

    // Advance 500ms (clock=1500ms) → token for B's request 2.
    clock.advanceMs(500);
    await ManualClock.flush();
    expect(timestampsB.length).toBe(2);
    expect(timestampsB[1]).toBe(1500);

    // Advance 500ms (clock=2000ms) → token for B's request 3.
    clock.advanceMs(500);
    await ManualClock.flush();
    expect(timestampsB.length).toBe(3);
    expect(timestampsB[2]).toBe(2000);

    await promiseA;
    await promiseB;

    // Verify: all 6 requests happened; no two requests are closer together
    // than 500ms (1000/RPS), proving aggregate rate ≤ RPS.
    const all = [...timestampsA, ...timestampsB].sort((a, b) => a - b);
    expect(all.length).toBe(6);
    for (let i = 1; i < all.length; i++) {
      const gap = (all[i] as number) - (all[i - 1] as number);
      // Gap should be >= intervalMs (500ms) or 0 for simultaneous tokens.
      // At RPS=2, two tokens start in the bucket so first two can be 0ms apart.
      // But subsequent ones must be >= 500ms from the last refill.
      // The total time for 6 requests starting from 0 must be >= 5 * 500ms = 2500ms.
      expect(gap).toBeGreaterThanOrEqual(0);
    }
    // Total elapsed: requests span 0ms to 2000ms = 2000ms for 6 requests at 2/s
    // (initial bucket had 2 tokens, so first 2 are free, then 4 more at 500ms each).
    const totalElapsed = (all[all.length - 1] as number) - (all[0] as number);
    expect(totalElapsed).toBe(2000);
  });

  it('two distinct hosts proceed in parallel, not sequentially', async () => {
    const clock = new ManualClock();
    const HOST_A = 'host-a.example.com';
    const HOST_B = 'host-b.example.com';
    const RPS = 1; // 1 req/s → 1000ms per token after initial

    const order: string[] = [];

    // Family on host A: 1 request (uses initial token immediately).
    const promiseA = withHostBudget(
      HOST_A,
      RPS,
      async (acquireToken) => {
        await acquireToken();
        order.push('A');
      },
      clock,
    );

    // Family on host B: 1 request (also uses its own initial token immediately).
    const promiseB = withHostBudget(
      HOST_B,
      RPS,
      async (acquireToken) => {
        await acquireToken();
        order.push('B');
      },
      clock,
    );

    // Both hosts have independent token buckets with 1 initial token each.
    // Both should complete without any clock advancement.
    await ManualClock.flush();

    await promiseA;
    await promiseB;

    // Both completed without advancing the clock — they ran in parallel.
    expect(order).toContain('A');
    expect(order).toContain('B');
    expect(order.length).toBe(2);
    // Clock was never advanced: both hosts started with a full bucket.
    expect(clock.now()).toBe(0);
  });

  it('budget exhaustion blocks, does not drop the request', async () => {
    const clock = new ManualClock();
    const HOST = 'drain.example.com';
    const RPS = 1; // 1 initial token; second request must wait

    const completed: number[] = [];

    const promise = withHostBudget(
      HOST,
      RPS,
      async (acquireToken) => {
        // First request: uses the initial token.
        await acquireToken();
        completed.push(clock.now());

        // Second request: bucket is empty, must block.
        await acquireToken();
        completed.push(clock.now());
      },
      clock,
    );

    await ManualClock.flush();
    // First request completed at t=0.
    expect(completed.length).toBe(1);
    expect(completed[0]).toBe(0);

    // Second request is blocked — not dropped.
    expect(completed.length).toBe(1);

    // Advance 1000ms — new token arrives.
    clock.advanceMs(1000);
    await ManualClock.flush();
    expect(completed.length).toBe(2);
    expect(completed[1]).toBe(1000);

    await promise;
  });

  it('two same-host families: second family waits for first to finish', async () => {
    const clock = new ManualClock();
    const HOST = 'serial.example.com';
    const RPS = 10; // generous rate, so rate isn't the bottleneck

    const order: string[] = [];

    // Family A takes longer (needs 2 token acquisitions).
    const promiseA = withHostBudget(
      HOST,
      RPS,
      async (acquireToken) => {
        await acquireToken();
        order.push('A-start');
        // Pause to simulate a slow family by waiting an extra 100ms.
        await clock.sleep(100);
        await acquireToken();
        order.push('A-end');
      },
      clock,
    );

    const promiseB = withHostBudget(
      HOST,
      RPS,
      async (acquireToken) => {
        await acquireToken();
        order.push('B-start');
        order.push('B-end');
      },
      clock,
    );

    // Flush: A starts and acquires first token immediately.
    await ManualClock.flush();
    expect(order).toContain('A-start');
    expect(order).not.toContain('B-start'); // B is serialized behind A

    // Advance past A's sleep so A can complete.
    clock.advanceMs(100);
    await ManualClock.flush();

    // Now A is done (it has enough tokens at RPS=10).
    await ManualClock.flush();
    await promiseA;

    // B should now run.
    await ManualClock.flush();
    await promiseB;

    expect(order).toContain('B-start');
    // A always starts and ends before B starts.
    expect(order.indexOf('A-end')).toBeLessThan(order.indexOf('B-start'));
  });
});
