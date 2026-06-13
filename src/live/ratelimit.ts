// ---------------------------------------------------------------------------
// ratelimit.ts — aggregate per-host rate limiter + live engine serializer (§4.5)
//
// The live engine SERIALIZES request-generating families against any single
// host: withHostBudget() ensures no two scanner families (ZAP, Nuclei, probes)
// hit the same host concurrently. The per-host rate is enforced via a token
// bucket shared across all families on that host. Distinct hosts proceed in
// parallel.
//
// Budget exhaustion blocks (waits for the next token interval), never drops.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Clock — injectable for deterministic testing.
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// TokenBucket — a token-bucket rate limiter. Each acquire() resolves when a
// token is available, blocking if the bucket is empty.
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly intervalMs: number;
  private readonly maxTokens: number;
  private readonly clock: Clock;

  constructor(rps: number, clock: Clock = realClock) {
    this.intervalMs = 1000 / rps;
    this.maxTokens = rps;
    this.tokens = rps;
    this.lastRefill = clock.now();
    this.clock = clock;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const elapsed = now - this.lastRefill;
      const newTokens = Math.floor(elapsed / this.intervalMs);

      if (newTokens > 0) {
        this.tokens = Math.min(this.tokens + newTokens, this.maxTokens);
        this.lastRefill += newTokens * this.intervalMs;
      }

      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }

      // Block until the next token is due.
      const msUntilNext = this.intervalMs - (this.clock.now() - this.lastRefill);
      await this.clock.sleep(Math.max(1, msUntilNext));
    }
  }
}

// ---------------------------------------------------------------------------
// Per-host state: a serialization queue (mutex) + a shared token bucket.
// ---------------------------------------------------------------------------

interface HostState {
  // Promise chain that serializes scanner families for this host.
  tail: Promise<void>;
  bucket: TokenBucket;
}

// AcquireToken — scanner families call this before each outgoing request.
export type AcquireToken = () => Promise<void>;

// Per-host registry. Created on first use; shared for the process lifetime.
const hostRegistry = new Map<string, HostState>();

// ---------------------------------------------------------------------------
// withHostBudget — the primary public API (§4.5).
//
// Acquires the per-host serialization slot, then calls fn(acquireToken).
// Only one fn runs at a time for a given host. fn receives acquireToken;
// each outgoing request must await acquireToken() first. The rate is aggregate
// because families share the same bucket and only one family runs per host.
//
// Distinct hosts get independent HostState and proceed concurrently.
// Budget exhaustion blocks (token-bucket sleep), never silently drops.
// ---------------------------------------------------------------------------

export function withHostBudget<T>(
  host: string,
  rps: number,
  fn: (acquireToken: AcquireToken) => Promise<T>,
  clock?: Clock,
): Promise<T> {
  let state = hostRegistry.get(host);
  if (state === undefined) {
    const bucket = new TokenBucket(rps, clock ?? realClock);
    state = { tail: Promise.resolve(), bucket };
    hostRegistry.set(host, state);
  }

  const localState = state;
  const acquireToken: AcquireToken = () => localState.bucket.acquire();

  // Each call chains onto the host's tail so families are serialized.
  // We capture the promise for fn's result and propagate its value/error.
  let settleFn!: (p: Promise<T>) => void;
  const resultCapture = new Promise<Promise<T>>((res) => {
    settleFn = res;
  });

  localState.tail = localState.tail.then(async () => {
    const p = fn(acquireToken);
    settleFn(p);
    // Await fn so the queue tail waits for this family to finish.
    try {
      await p;
    } catch {
      // Error is propagated through resultCapture; queue must still advance.
    }
  });

  // Return a promise that adopts the value/error of fn's result.
  return resultCapture.then((p) => p);
}

// ---------------------------------------------------------------------------
// _resetHostRegistry — clears all per-host state between tests.
// ---------------------------------------------------------------------------

export function _resetHostRegistry(): void {
  hostRegistry.clear();
}
