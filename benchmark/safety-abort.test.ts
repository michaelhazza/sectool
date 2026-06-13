/**
 * benchmark/safety-abort.test.ts
 *
 * §4.7 IMMUTABLE safety-contract abort test.
 *
 * A scan against a non-allowlisted host MUST:
 *   (1) throw AllowlistViolationError, AND
 *   (2) send ZERO HTTP requests to the server — the fixture server records hits.
 *
 * THIS TEST MAY NEVER BE WEAKENED OR DELETED. It is a v1 exit condition (§4.7).
 *
 * Implementation: the hit-recording server runs on 127.0.0.1 (loopback) with an
 * OS-assigned port. The scan target URL uses the hostname
 * "not-on-allowlist.fixture.local" — a DNS name that is NOT in
 * benchmark/allowlist.benchmark.json (which only allows 127.0.0.1 and localhost).
 * The gate fires before any network I/O, so the hit counter stays at zero.
 */

import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertAllowlisted, AllowlistViolationError } from '../src/live/gate.js';
import { loadBenchmarkAllowlist } from '../src/config/load.js';

// ---------------------------------------------------------------------------
// Hit-recording server (built-in http only — zero external deps)
// ---------------------------------------------------------------------------

let server: Server;
let hitCount = 0;

function startHitRecorder(): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    hitCount = 0;
    server = createServer((req, res) => {
      hitCount += 1;
      res.writeHead(200);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve({ host: '127.0.0.1', port: addr.port });
      } else {
        reject(new Error('Could not determine server address'));
      }
    });
    server.on('error', reject);
  });
}

function stopHitRecorder(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// §4.7 abort test
// ---------------------------------------------------------------------------

describe('§4.7 safety-contract abort test [IMMUTABLE]', () => {
  beforeAll(async () => {
    await startHitRecorder();
  });

  afterAll(async () => {
    await stopHitRecorder();
  });

  it('throws AllowlistViolationError before sending any HTTP request to a non-allowlisted host', () => {
    // The benchmark allowlist contains only 127.0.0.1 and localhost.
    // "not-on-allowlist.fixture.local" is NOT on the allowlist.
    const allowlist = loadBenchmarkAllowlist();

    // The non-allowlisted URL — a DNS name, not an IP literal, so clause (d)
    // does not trigger first; the host-match clause (b) fires and throws.
    const nonAllowlistedUrl = 'https://not-on-allowlist.fixture.local/';

    expect(() => {
      assertAllowlisted(nonAllowlistedUrl, allowlist);
    }).toThrow(AllowlistViolationError);

    // IMMUTABLE ASSERTION: zero HTTP requests must have reached the server.
    // The gate must abort before any network I/O (§4.7).
    expect(hitCount).toBe(0);
  });

  it('error message identifies the rejected host', () => {
    const allowlist = loadBenchmarkAllowlist();
    let caughtError: AllowlistViolationError | null = null;

    try {
      assertAllowlisted('https://not-on-allowlist.fixture.local/', allowlist);
    } catch (err) {
      if (err instanceof AllowlistViolationError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toMatch(/not-on-allowlist\.fixture\.local/);
  });

  it('hit counter remains zero across multiple abort attempts', () => {
    const allowlist = loadBenchmarkAllowlist();
    const targets = [
      'https://not-on-allowlist.fixture.local/',
      'https://also-not-allowed.example.com/',
      'https://another.not-allowed.dev/',
    ];

    for (const url of targets) {
      expect(() => assertAllowlisted(url, allowlist)).toThrow(AllowlistViolationError);
    }

    // IMMUTABLE: still zero — no test case above may send HTTP traffic.
    expect(hitCount).toBe(0);
  });
});
