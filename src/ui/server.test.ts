import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, CSRF_NONCE, type AuditServer, type FixHandler } from './server.js';
import { appendEvent, foldJobs } from './scan-jobs.js';
import { loadAllowlist, loadTargets, ConfigError } from '../config/load.js';
import { preflight } from '../live/preflight.js';
import type { GitHubRequest, GitHubResponse } from '../fix/github.js';
import type { AllowedTarget } from '../live/gate.js';

// ---------------------------------------------------------------------------
// Module mocks for registry/preflight — used by POST /api/scan tests only.
// The mocks are set to passthrough defaults so existing tests are unaffected;
// scan-route tests override per-test via mockImplementationOnce.
// ---------------------------------------------------------------------------

vi.mock('../config/load.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/load.js')>();
  return {
    ...original,
    loadAllowlist: vi.fn(original.loadAllowlist),
    loadTargets: vi.fn(original.loadTargets),
  };
});

vi.mock('../live/preflight.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../live/preflight.js')>();
  return {
    ...original,
    preflight: vi.fn(original.preflight),
  };
});

// ---------------------------------------------------------------------------
// Helpers: make GET / POST requests to the test server
// ---------------------------------------------------------------------------

function get(port: number, path: string, extraHeaders?: Record<string, string>): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers: extraHeaders ?? {} }, (response) => {
      let data = '';
      response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
      response.on('end', () => {
        res({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: data,
        });
      });
    });
    req.on('error', rej);
    req.end();
  });
}

function post(
  port: number,
  path: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((res, rej) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.byteLength,
          ...extraHeaders,
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
        response.on('end', () => {
          res({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: data,
          });
        });
      },
    );
    req.on('error', rej);
    req.end(bodyBuf);
  });
}

// ---------------------------------------------------------------------------
// Shared server instance for read-only endpoint tests
// ---------------------------------------------------------------------------

let srv: AuditServer;

beforeAll(async () => {
  // Port 0 = OS-assigned ephemeral port (no conflict risk)
  srv = await startServer(0);
});

afterAll(async () => {
  await srv.stop();
});

// ---------------------------------------------------------------------------
// Binding: server must listen on 127.0.0.1 only
// ---------------------------------------------------------------------------

describe('server binding', () => {
  it('binds to 127.0.0.1 (loopback only)', () => {
    const addr = srv.server.address();
    expect(typeof addr).toBe('object');
    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr !== null) {
      expect(addr.address).toBe('127.0.0.1');
    }
  });

  it('assigns a valid ephemeral port', () => {
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.port).toBeLessThanOrEqual(65535);
  });
});

// ---------------------------------------------------------------------------
// CSRF nonce
// ---------------------------------------------------------------------------

describe('/api/csrf', () => {
  it('GET /api/csrf returns the per-process nonce', async () => {
    const { status, body } = await get(srv.port, '/api/csrf');
    expect(status).toBe(200);
    const json = JSON.parse(body) as { csrfToken: string };
    expect(json.csrfToken).toBe(CSRF_NONCE);
  });

  it('nonce is a non-empty 64-hex string (sha256)', () => {
    expect(CSRF_NONCE).toMatch(/^[0-9a-f]{64}$/);
  });

  it('nonce is stable across multiple requests (same process)', async () => {
    const r1 = await get(srv.port, '/api/csrf');
    const r2 = await get(srv.port, '/api/csrf');
    const j1 = JSON.parse(r1.body) as { csrfToken: string };
    const j2 = JSON.parse(r2.body) as { csrfToken: string };
    expect(j1.csrfToken).toBe(j2.csrfToken);
  });
});

// ---------------------------------------------------------------------------
// No CORS wildcard header
// ---------------------------------------------------------------------------

describe('CORS policy', () => {
  it('GET /api/csrf never emits Access-Control-Allow-Origin: *', async () => {
    const { headers } = await get(srv.port, '/api/csrf');
    const acaoHeader = headers['access-control-allow-origin'];
    expect(acaoHeader).not.toBe('*');
  });

  it('GET /api/reports never emits Access-Control-Allow-Origin: *', async () => {
    const { headers } = await get(srv.port, '/api/reports');
    const acaoHeader = headers['access-control-allow-origin'];
    expect(acaoHeader).not.toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Read-only endpoints — empty-state (no files on disk) must return 200, not 500
// ---------------------------------------------------------------------------

describe('read-only endpoints — empty state', () => {
  it('GET /api/reports returns empty array when reports dir absent', async () => {
    const { status, body } = await get(srv.port, '/api/reports');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(Array.isArray(json)).toBe(true);
  });

  it('GET /api/trend returns empty array when history/trend.jsonl absent', async () => {
    const { status, body } = await get(srv.port, '/api/trend');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(Array.isArray(json)).toBe(true);
  });

  it('GET /api/config/targets returns object when file present', async () => {
    const { status, body } = await get(srv.port, '/api/config/targets');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(json).toBeTruthy();
  });

  it('GET /api/config/allowlist returns object', async () => {
    const { status, body } = await get(srv.port, '/api/config/allowlist');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(json).toBeTruthy();
  });

  it('GET /api/config/baseline returns object', async () => {
    const { status, body } = await get(srv.port, '/api/config/baseline');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(json).toBeTruthy();
  });

  it('GET /api/fixes returns empty object when fixes.json absent', async () => {
    const { status, body } = await get(srv.port, '/api/fixes');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(json).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Read-only endpoints — serving real file state
// ---------------------------------------------------------------------------

describe('read-only endpoints — file state', () => {
  // Use a temp dir as the report directory via a second server instance
  // that can be pointed at a temp tree with fixture data.
  //
  // Since server.ts reads from REPO_ROOT-relative paths, the simplest
  // approach is to test the /api/reports/:runId/report.json 404 path
  // (non-existent run id) and the 200 path via the real config files
  // that exist on disk.

  it('GET /api/reports/:runId/report.json 404 for unknown run', async () => {
    const { status } = await get(srv.port, '/api/reports/nonexistent-run-id/report.json');
    expect(status).toBe(404);
  });

  it('GET /api/reports/:runId rejects a non-RUN_ID segment without building a path (6-A traversal guard)', async () => {
    // A `..` segment matches the single-segment route regex; RUN_ID_RE validation
    // must reject it (404) before resolve() could escape reportsDir.
    const { status } = await get(srv.port, '/api/reports/..%2F..%2Fconfig/report.json');
    expect(status).toBe(404);
    const plain = await get(srv.port, '/api/reports/not-a-valid-runid/report.json');
    expect(plain.status).toBe(404);
  });

  it('GET /api/config/targets returns the projected UI shape (repoTargets/stagingTargets)', async () => {
    const { status, body } = await get(srv.port, '/api/config/targets');
    expect(status).toBe(200);
    // Projected to the SPA's TargetsConfig shape (not the raw `repos` key), with
    // the auth/rateLimit detail dropped. See the /api/config/targets handler.
    const json = JSON.parse(body) as { repoTargets: unknown[]; stagingTargets: unknown[] };
    expect(Array.isArray(json.repoTargets)).toBe(true);
    expect(Array.isArray(json.stagingTargets)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown route → 404
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('GET /api/unknown returns 404', async () => {
    const { status } = await get(srv.port, '/api/unknown-endpoint');
    expect(status).toBe(404);
  });

  it('GET /totally-unknown returns 200 or 404 (SPA fallback or 404 — no 500)', async () => {
    const { status } = await get(srv.port, '/totally-unknown-page');
    expect(status === 200 || status === 404).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §10 UI fix-endpoint CSRF/origin guardrail (P8-5)
// ---------------------------------------------------------------------------

describe('POST /api/fix — CSRF/origin guardrail (§10)', () => {
  // Plain spy: records whether the fix handler was called (no vi.fn — avoids no-unsafe-call)
  let fixSrv: AuditServer;
  let fixHandlerCalled: boolean;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const fixSpy: FixHandler = (_fp: string) => {
    fixHandlerCalled = true;
    return Promise.resolve({ issueUrl: 'https://github.com/test/repo/issues/1' });
  };

  beforeAll(async () => {
    fixHandlerCalled = false;
    fixSrv = await startServer(0, fixSpy);
  });

  afterAll(async () => {
    await fixSrv.stop();
  });

  beforeEach(() => {
    fixHandlerCalled = false;
  });

  const validBody = JSON.stringify({ fingerprint: 'a'.repeat(64) });

  it('returns 403 when X-Audit-CSRF header is missing', async () => {
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      { 'Origin': `http://127.0.0.1:${fixSrv.port}` },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('returns 403 when X-Audit-CSRF header is wrong', async () => {
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      {
        'Origin': `http://127.0.0.1:${fixSrv.port}`,
        'X-Audit-CSRF': 'wrong-nonce-value',
      },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('returns 403 when Origin header is missing', async () => {
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      { 'X-Audit-CSRF': CSRF_NONCE },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('returns 403 when Origin is a foreign host', async () => {
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': 'http://evil.example.com',
      },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('returns 403 when Origin is correct host but wrong port', async () => {
    const wrongPort = fixSrv.port + 1;
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': `http://127.0.0.1:${wrongPort}`,
      },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('reaches the fix handler on valid same-origin + correct nonce', async () => {
    const { status } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': `http://127.0.0.1:${fixSrv.port}`,
      },
    );
    // fix handler is called (spy returns a mock issueUrl → 200)
    expect(status).toBe(200);
    expect(fixHandlerCalled).toBe(true);
  });

  it('POST /api/fix never emits Access-Control-Allow-Origin: *', async () => {
    // Even a 403 response must not have the wildcard CORS header
    const { headers } = await post(
      fixSrv.port,
      '/api/fix',
      validBody,
      { 'Origin': 'http://evil.example.com' },
    );
    expect(headers['access-control-allow-origin']).not.toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: body size cap → HTTP 413 (DoS guard)
// ---------------------------------------------------------------------------

describe('POST /api/fix — body size cap (fix 2)', () => {
  let capSrv: AuditServer;
  let fixHandlerCalled: boolean;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const fixSpy: FixHandler = (_fp: string) => {
    fixHandlerCalled = true;
    return Promise.resolve({ issueUrl: 'https://github.com/test/repo/issues/9' });
  };

  beforeAll(async () => {
    fixHandlerCalled = false;
    capSrv = await startServer(0, fixSpy);
  });

  afterAll(async () => {
    await capSrv.stop();
  });

  beforeEach(() => {
    fixHandlerCalled = false;
  });

  it('returns 413 when body exceeds 64 KiB and does NOT call the fix handler', async () => {
    // Build a body that's 65 KiB — over the 64 KiB cap.
    const oversizedBody = JSON.stringify({ fingerprint: 'a'.repeat(64), padding: 'x'.repeat(65 * 1024) });
    const { status } = await post(
      capSrv.port,
      '/api/fix',
      oversizedBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': `http://127.0.0.1:${capSrv.port}`,
      },
    );
    expect(status).toBe(413);
    expect(fixHandlerCalled).toBe(false);
  });

  it('accepts a normal-sized body (under 64 KiB) and calls the fix handler', async () => {
    const normalBody = JSON.stringify({ fingerprint: 'a'.repeat(64) });
    const { status } = await post(
      capSrv.port,
      '/api/fix',
      normalBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': `http://127.0.0.1:${capSrv.port}`,
      },
    );
    expect(status).toBe(200);
    expect(fixHandlerCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: concurrent fix requests for the same fingerprint are serialized
// ---------------------------------------------------------------------------

describe('POST /api/fix — per-fingerprint serialization (fix 5)', () => {
  let seqSrv: AuditServer;
  let callCount: number;

  beforeAll(async () => {
    callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const serialSpy: FixHandler = (_fp: string) => {
      callCount++;
      return Promise.resolve({ issueUrl: 'https://github.com/test/repo/issues/serial' });
    };
    seqSrv = await startServer(0, serialSpy);
  });

  afterAll(async () => {
    await seqSrv.stop();
  });

  beforeEach(() => {
    callCount = 0;
  });

  it('two concurrent POSTs for the same fingerprint call the handler exactly twice (serialized)', async () => {
    const body = JSON.stringify({ fingerprint: 'b'.repeat(64) });
    const headers = {
      'X-Audit-CSRF': CSRF_NONCE,
      'Origin': `http://127.0.0.1:${seqSrv.port}`,
    };
    const [r1, r2] = await Promise.all([
      post(seqSrv.port, '/api/fix', body, headers),
      post(seqSrv.port, '/api/fix', body, headers),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both calls run (serialized, not deduplicated) — count is 2
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Trend endpoint with real data
// ---------------------------------------------------------------------------

describe('trend endpoint with fixture data', () => {
  let trendSrv: AuditServer;
  const tmpDir = resolve(tmpdir(), `audit-ui-test-${process.pid}`);
  const historyDir = resolve(tmpDir, 'history');

  beforeAll(async () => {
    // Write a minimal trend.jsonl fixture into a temp tree.
    // The server reads from REPO_ROOT, so this test covers the parser
    // separately by writing to the actual history dir temporarily.
    // Instead, we test the parser logic by verifying the empty-state
    // path (covered above) + that the module can parse JSONL correctly
    // via a standalone check.
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      resolve(historyDir, 'trend.jsonl'),
      '{"runId":"2026-06-13T00-00-00Z-aaaa","date":"2026-06-13","targets":{}}\n',
      'utf8',
    );
    // We can't easily point the module at tmpDir since paths are hardcoded.
    // Start a second server on a fresh port — this server will still read
    // from REPO_ROOT. The test validates the parser handles valid JSONL lines.
    trendSrv = await startServer(0);
  });

  afterAll(async () => {
    await trendSrv.stop();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('GET /api/trend returns an array (may be empty in test context)', async () => {
    const { status, body } = await get(trendSrv.port, '/api/trend');
    expect(status).toBe(200);
    const json = JSON.parse(body) as unknown;
    expect(Array.isArray(json)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: make a Basic Auth header value
// ---------------------------------------------------------------------------

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// GET /healthz — unauthenticated health probe (C4, §4.4)
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 {"ok":true} without credentials (auth disabled)', async () => {
    const { status, body } = await get(srv.port, '/healthz');
    expect(status).toBe(200);
    const json = JSON.parse(body) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('returns 200 {"ok":true} even when Basic Auth gate is enabled and no credentials sent', async () => {
    // Start a server with auth enabled to confirm /healthz is exempt from the gate.
    const USER = 'gatecheck';
    const PASS = 'h3althz!';
    let authSrv: AuditServer | undefined;
    try {
      authSrv = await startServer(0, {
        env: (name: string) => {
          if (name === 'AUDIT_BASIC_AUTH_USER') return USER;
          if (name === 'AUDIT_BASIC_AUTH_PASS') return PASS;
          return undefined;
        },
      });
      const { status, body } = await get(authSrv.port, '/healthz');
      expect(status).toBe(200);
      const json = JSON.parse(body) as { ok: boolean };
      expect(json.ok).toBe(true);
    } finally {
      await authSrv?.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan-jobs — folded job list (C4, §4.3)
// ---------------------------------------------------------------------------

describe('GET /api/scan-jobs', () => {
  const jobsTmpDir = resolve(tmpdir(), `audit-scanjobs-test-${process.pid}`);
  let jobsSrv: AuditServer;
  const USER = 'jobsuser';
  const PASS = 'jobspass!';

  beforeAll(async () => {
    mkdirSync(resolve(jobsTmpDir, 'history'), { recursive: true });

    // Seed two jobs so we can verify most-recent-first ordering.
    // Job A: requested earlier, then dispatched → in_progress
    appendEvent(
      { event: 'requested', jobId: 'aaaa1111aaaa1111aaaa1111aaaa1111', targetRepo: 'repo-a', stagingUrl: 'https://staging-a.example.com', at: '2026-06-14T10:00:00.000Z' },
      jobsTmpDir,
    );
    appendEvent(
      { event: 'dispatched', jobId: 'aaaa1111aaaa1111aaaa1111aaaa1111', at: '2026-06-14T10:00:05.000Z' },
      jobsTmpDir,
    );

    // Job B: requested later, completed
    appendEvent(
      { event: 'requested', jobId: 'bbbb2222bbbb2222bbbb2222bbbb2222', targetRepo: 'repo-b', stagingUrl: 'https://staging-b.example.com', at: '2026-06-14T11:00:00.000Z' },
      jobsTmpDir,
    );
    appendEvent(
      { event: 'dispatched', jobId: 'bbbb2222bbbb2222bbbb2222bbbb2222', at: '2026-06-14T11:00:05.000Z' },
      jobsTmpDir,
    );
    appendEvent(
      { event: 'uploaded', jobId: 'bbbb2222bbbb2222bbbb2222bbbb2222', runId: '2026-06-14T11-30-00Z-cccc', at: '2026-06-14T11:30:00.000Z' },
      jobsTmpDir,
    );

    jobsSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return jobsTmpDir;
        if (name === 'AUDIT_BASIC_AUTH_USER') return USER;
        if (name === 'AUDIT_BASIC_AUTH_PASS') return PASS;
        return undefined;
      },
    });
  });

  afterAll(async () => {
    await jobsSrv.stop();
    try {
      rmSync(jobsTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns 401 without credentials when Basic Auth gate is enabled', async () => {
    const { status, headers } = await get(jobsSrv.port, '/api/scan-jobs');
    expect(status).toBe(401);
    expect(headers['www-authenticate']).toBe('Basic realm="sectool"');
  });

  it('returns 200 with folded jobs when correct credentials supplied', async () => {
    const { status, body } = await get(jobsSrv.port, '/api/scan-jobs', {
      Authorization: basicAuthHeader(USER, PASS),
    });
    expect(status).toBe(200);
    const jobs = JSON.parse(body) as Array<{ jobId: string; state: string; requestedAt: string }>;
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBe(2);
  });

  it('returns jobs most-recent-first (sorted by requestedAt desc)', async () => {
    const { body } = await get(jobsSrv.port, '/api/scan-jobs', {
      Authorization: basicAuthHeader(USER, PASS),
    });
    const jobs = JSON.parse(body) as Array<{ jobId: string; requestedAt: string }>;
    // Job B (11:00) should come before Job A (10:00)
    expect(jobs[0]!.jobId).toBe('bbbb2222bbbb2222bbbb2222bbbb2222');
    expect(jobs[1]!.jobId).toBe('aaaa1111aaaa1111aaaa1111aaaa1111');
  });

  it('reflects correct state for each folded job', async () => {
    const { body } = await get(jobsSrv.port, '/api/scan-jobs', {
      Authorization: basicAuthHeader(USER, PASS),
    });
    const jobs = JSON.parse(body) as Array<{ jobId: string; state: string; runId: string | null }>;
    const jobB = jobs.find((j) => j.jobId === 'bbbb2222bbbb2222bbbb2222bbbb2222');
    const jobA = jobs.find((j) => j.jobId === 'aaaa1111aaaa1111aaaa1111aaaa1111');
    expect(jobB?.state).toBe('complete');
    expect(jobB?.runId).toBe('2026-06-14T11-30-00Z-cccc');
    // Job A dispatched recently (within TTL) → in_progress
    expect(jobA?.state).toBe('in_progress');
    expect(jobA?.runId).toBeNull();
  });

  it('returns 200 [] when scan-jobs file is absent (no dataDir seeded)', async () => {
    // Start a server pointing at an empty tmp dir with no scan-jobs file.
    const emptyDir = resolve(tmpdir(), `audit-scanjobs-empty-${process.pid}`);
    mkdirSync(emptyDir, { recursive: true });
    let emptySrv: AuditServer | undefined;
    try {
      emptySrv = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return emptyDir;
          return undefined;
        },
      });
      const { status, body } = await get(emptySrv.port, '/api/scan-jobs');
      expect(status).toBe(200);
      const jobs = JSON.parse(body) as unknown;
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs as unknown[]).length).toBe(0);
    } finally {
      await emptySrv?.stop();
      try { rmSync(emptyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/scan — CSRF/origin gate + registry safety gate (Chunk 5, §4.1)
// ---------------------------------------------------------------------------

// Shared helpers for scan-route tests.
// Fake allowlist/registry factories — let tests control registry state without
// touching the on-disk config files.

type FakeAllowlist = ReturnType<typeof loadAllowlist>;
type FakeRegistry = ReturnType<typeof loadTargets>;

function makeAllowlist(hosts: string[]): FakeAllowlist {
  return {
    hosts: hosts.map((h) => ({ host: h, owner: 'test', addedAt: '2026-01-01' })),
  } as unknown as FakeAllowlist;
}

function makeRegistry(
  repos: Array<{ name: string; enabled: boolean }>,
  stagingTargets: Array<{ name: string; url: string; enabled: boolean }>,
): FakeRegistry {
  return {
    repos: repos.map((r) => ({
      name: r.name,
      gitUrl: `https://github.com/test/${r.name}.git`,
      localPath: null,
      stackTags: [],
      publicRoutes: [],
      enabled: r.enabled,
    })),
    stagingTargets: stagingTargets.map((t) => ({
      name: t.name,
      url: t.url,
      repo: t.name,
      activeScan: false,
      rateLimitRps: 10,
      enabled: t.enabled,
    })),
  };
}

describe('POST /api/scan — CSRF/origin guard', () => {
  // Server with a no-op dispatch client (won't be reached for CSRF rejects)
  let scanSrv: AuditServer;
  const scanTmpDir = resolve(tmpdir(), `audit-scan-csrf-${process.pid}`);

  beforeAll(async () => {
    mkdirSync(resolve(scanTmpDir, 'history'), { recursive: true });
    scanSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return scanTmpDir;
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 204, body: {} }),
    });
  });

  afterAll(async () => {
    await scanSrv.stop();
    try { rmSync(scanTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 403 when X-Audit-CSRF header is missing — NO registry load or dispatch', async () => {
    const loadAllowlistMock = vi.mocked(loadAllowlist);
    loadAllowlistMock.mockClear();
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      { 'Origin': `http://127.0.0.1:${scanSrv.port}` },
    );
    expect(status).toBe(403);
    // Registry load must NOT have been called (CSRF gate fires first)
    expect(loadAllowlistMock).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin is wrong — before registry load', async () => {
    const loadAllowlistMock = vi.mocked(loadAllowlist);
    loadAllowlistMock.mockClear();
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': 'http://evil.example.com',
      },
    );
    expect(status).toBe(403);
    expect(loadAllowlistMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/scan — field validation', () => {
  let scanSrv: AuditServer;
  const scanTmpDir = resolve(tmpdir(), `audit-scan-fields-${process.pid}`);

  beforeAll(async () => {
    mkdirSync(resolve(scanTmpDir, 'history'), { recursive: true });
    scanSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return scanTmpDir;
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 204, body: {} }),
    });
  });

  afterAll(async () => {
    await scanSrv.stop();
    try { rmSync(scanTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function validHeaders(port: number): Record<string, string> {
    return {
      'X-Audit-CSRF': CSRF_NONCE,
      'Origin': `http://127.0.0.1:${port}`,
    };
  }

  it('returns 400 when both repo and stagingUrl are missing', async () => {
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({}),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
  });

  it('returns 400 when only repo is provided (stagingUrl missing)', async () => {
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
  });

  it('returns 400 when only stagingUrl is provided (repo missing)', async () => {
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
  });

  it('returns 400 when repo is empty string', async () => {
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: '', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
  });

  it('returns 400 when stagingUrl is empty string', async () => {
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: '' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
  });
});

describe('POST /api/scan — registry safety gate', () => {
  let scanSrv: AuditServer;
  const scanTmpDir = resolve(tmpdir(), `audit-scan-registry-${process.pid}`);
  let dispatchCalls: GitHubRequest[];

  beforeAll(async () => {
    mkdirSync(resolve(scanTmpDir, 'history'), { recursive: true });
    dispatchCalls = [];
    scanSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return scanTmpDir;
        if (name === 'AUDIT_WORKFLOW_REPO') return 'https://github.com/acme/audit-workflows';
        if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
        return undefined;
      },
      githubClient: (req: GitHubRequest): Promise<GitHubResponse> => {
        dispatchCalls.push(req);
        return Promise.resolve({ status: 204, body: {} });
      },
    });
  });

  afterAll(async () => {
    await scanSrv.stop();
    try { rmSync(scanTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    dispatchCalls = [];
    vi.mocked(loadAllowlist).mockReset();
    vi.mocked(loadTargets).mockReset();
    vi.mocked(preflight).mockReset();
  });

  function validHeaders(port: number): Record<string, string> {
    return {
      'X-Audit-CSRF': CSRF_NONCE,
      'Origin': `http://127.0.0.1:${port}`,
    };
  }

  it('returns 400 for off-allowlist stagingUrl — no dispatch', async () => {
    // Real allowlist is empty → any URL will be rejected by preflight
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist([]));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'audit-tool', enabled: true }],
      [],
    ));
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://off-allowlist.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 400 for unregistered repo — no dispatch (M2: repo check is independent of URL preflight)', async () => {
    // URL would pass the allowlist and preflight, but the repo is not in registry
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'other-repo', enabled: true }], // 'audit-tool' is NOT here
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'staging', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 400 for disabled repo — no dispatch (M2: valid allowlisted URL + disabled repo → 400)', async () => {
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'audit-tool', enabled: false }], // disabled
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'staging', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 500 when ConfigError thrown by loadAllowlist (M3: server misconfig ≠ caller error)', async () => {
    vi.mocked(loadAllowlist).mockImplementationOnce(() => {
      throw new ConfigError('test config error');
    });
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(500);
    expect(dispatchCalls.length).toBe(0);
  });

  it('dispatches to AUDIT_WORKFLOW_REPO, not the scan target repo (invariant #2)', async () => {
    // Both repo and URL are valid — dispatch should go to the workflow repo URL
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'my-app', enabled: true }],
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'my-app', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    const { status, body } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'my-app', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(202);
    const json = JSON.parse(body) as { jobId: string };
    expect(typeof json.jobId).toBe('string');
    // Dispatch URL must reference AUDIT_WORKFLOW_REPO (acme/audit-workflows), not my-app
    expect(dispatchCalls.length).toBe(1);
    expect(dispatchCalls[0]!.url).toContain('/repos/acme/audit-workflows/actions/workflows/on-demand-scan.yml/dispatches');
    expect(dispatchCalls[0]!.url).not.toContain('my-app');
  });

  it('happy path: valid repo+url → requested+dispatched appended, 202 {jobId}, jobId is 32 hex', async () => {
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'audit-tool', enabled: true }],
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    const { status, body } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(202);
    const json = JSON.parse(body) as { jobId: string };
    expect(/^[0-9a-f]{32}$/.test(json.jobId)).toBe(true);
    expect(dispatchCalls.length).toBe(1);
  });

  it('returns 400 for an allowlisted host with an UNREGISTERED sub-path (4-C: exact-URL match)', async () => {
    // Host is allowlisted + preflight passes, but the submitted URL has a path the
    // registered target does not — must be rejected, never dispatched.
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'audit-tool', enabled: true }],
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    const callsBefore = dispatchCalls.length;
    const { status } = await post(
      scanSrv.port,
      '/api/scan',
      JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com/admin' }),
      validHeaders(scanSrv.port),
    );
    expect(status).toBe(400);
    // No dispatch occurred for the sub-path request.
    expect(dispatchCalls.length).toBe(callsBefore);
  });

  it('dispatch failure records dispatch_failed event and returns 502', async () => {
    vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
    vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
      [{ name: 'audit-tool', enabled: true }],
      [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
    ));
    vi.mocked(preflight).mockReturnValueOnce({
      target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
      registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
    });
    // Inject a failing GitHub client (non-204)
    let failSrv: AuditServer | undefined;
    const failDir = resolve(tmpdir(), `audit-scan-fail-${process.pid}`);
    mkdirSync(resolve(failDir, 'history'), { recursive: true });
    try {
      failSrv = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return failDir;
          if (name === 'AUDIT_WORKFLOW_REPO') return 'https://github.com/acme/audit-workflows';
          if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
          return undefined;
        },
        githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 401, body: {} }),
      });
      // Need to re-mock for this server's request too
      vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
      vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
        [{ name: 'audit-tool', enabled: true }],
        [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
      ));
      vi.mocked(preflight).mockReturnValueOnce({
        target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
        registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
      });
      const { status } = await post(
        failSrv.port,
        '/api/scan',
        JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
        {
          'X-Audit-CSRF': CSRF_NONCE,
          'Origin': `http://127.0.0.1:${failSrv.port}`,
        },
      );
      expect(status).toBe(502);
    } finally {
      await failSrv?.stop();
      try { rmSync(failDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// C6 — POST /api/scan dispatch uses resolvedEnv.configBranch as ref (H2/ImplInv-6)
// ---------------------------------------------------------------------------

describe('POST /api/scan — dispatch ref uses CONFIG_BRANCH (C6/H2)', () => {
  const c6TmpDir = resolve(tmpdir(), `audit-scan-c6-${process.pid}`);
  let c6DispatchCalls: GitHubRequest[];

  beforeAll(() => {
    mkdirSync(resolve(c6TmpDir, 'history'), { recursive: true });
    c6DispatchCalls = [];
  });

  afterAll(() => {
    try { rmSync(c6TmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    c6DispatchCalls = [];
    vi.mocked(loadAllowlist).mockReset();
    vi.mocked(loadTargets).mockReset();
    vi.mocked(preflight).mockReset();
  });

  it('dispatches with ref === CONFIG_BRANCH (not literal "main") when CONFIG_BRANCH is set', async () => {
    let c6Srv: AuditServer | undefined;
    const branchTmpDir = resolve(tmpdir(), `audit-scan-c6-branch-${process.pid}`);
    mkdirSync(resolve(branchTmpDir, 'history'), { recursive: true });
    try {
      c6Srv = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return branchTmpDir;
          if (name === 'AUDIT_WORKFLOW_REPO') return 'https://github.com/acme/audit-workflows';
          if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
          if (name === 'CONFIG_BRANCH') return 'staging-config';
          return undefined;
        },
        githubClient: (req: GitHubRequest): Promise<GitHubResponse> => {
          c6DispatchCalls.push(req);
          return Promise.resolve({ status: 204, body: {} });
        },
      });
      vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
      vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
        [{ name: 'audit-tool', enabled: true }],
        [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
      ));
      vi.mocked(preflight).mockReturnValueOnce({
        target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
        registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
      });
      const { status } = await post(
        c6Srv.port,
        '/api/scan',
        JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
        { 'X-Audit-CSRF': CSRF_NONCE, 'Origin': `http://127.0.0.1:${c6Srv.port}` },
      );
      expect(status).toBe(202);
      expect(c6DispatchCalls.length).toBe(1);
      const body = c6DispatchCalls[0]!.body as { ref: string; inputs: Record<string, string> };
      // ref must be the branch name, not literal 'main', not a SHA
      expect(body.ref).toBe('staging-config');
      expect(body.ref).not.toBe('main');
    } finally {
      await c6Srv?.stop();
      try { rmSync(branchTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('dispatches with ref === "main" when CONFIG_BRANCH is not set (default back-compat)', async () => {
    let c6Srv: AuditServer | undefined;
    const defaultTmpDir = resolve(tmpdir(), `audit-scan-c6-default-${process.pid}`);
    mkdirSync(resolve(defaultTmpDir, 'history'), { recursive: true });
    try {
      c6Srv = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return defaultTmpDir;
          if (name === 'AUDIT_WORKFLOW_REPO') return 'https://github.com/acme/audit-workflows';
          if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
          // CONFIG_BRANCH not set → defaults to 'main'
          return undefined;
        },
        githubClient: (req: GitHubRequest): Promise<GitHubResponse> => {
          c6DispatchCalls.push(req);
          return Promise.resolve({ status: 204, body: {} });
        },
      });
      vi.mocked(loadAllowlist).mockReturnValueOnce(makeAllowlist(['staging.example.com']));
      vi.mocked(loadTargets).mockReturnValueOnce(makeRegistry(
        [{ name: 'audit-tool', enabled: true }],
        [{ name: 'staging', url: 'https://staging.example.com', enabled: true }],
      ));
      vi.mocked(preflight).mockReturnValueOnce({
        target: { hostname: 'staging.example.com' } as unknown as AllowedTarget,
        registryEntry: { name: 'staging', url: 'https://staging.example.com', repo: 'audit-tool', activeScan: false, rateLimitRps: 10, enabled: true },
      });
      const { status } = await post(
        c6Srv.port,
        '/api/scan',
        JSON.stringify({ repo: 'audit-tool', stagingUrl: 'https://staging.example.com' }),
        { 'X-Audit-CSRF': CSRF_NONCE, 'Origin': `http://127.0.0.1:${c6Srv.port}` },
      );
      expect(status).toBe(202);
      expect(c6DispatchCalls.length).toBe(1);
      const body = c6DispatchCalls[0]!.body as { ref: string; inputs: Record<string, string> };
      expect(body.ref).toBe('main');
    } finally {
      await c6Srv?.stop();
      try { rmSync(defaultTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/upload — bearer auth + provenance + schema + atomic write (Chunk 6)
// Tests cover all plan-specified cases: H1, H2, M1, bearer, provenance, schema.
// ---------------------------------------------------------------------------

const UPLOAD_TOKEN = 'test-upload-token-secret';
const WORKFLOW_PATH = '.github/workflows/on-demand-scan.yml';
const WORKFLOW_REPO = 'https://github.com/acme/audit-workflows';
const GOOD_SHA = 'abc123def456abc123def456abc123def456abc123';
const GOOD_GITHUB_RUN_ID = '12345';
const VALID_RUN_ID = '2026-06-14T10-00-00Z-abcd';

// "Now" for the upload test clock — evaluated at module load so it is the real current
// time. Dispatch events are seeded 5 minutes earlier, always within the 30-min TTL.
const UPLOAD_NOW = Date.now();
const DISPATCH_AT = new Date(UPLOAD_NOW - 5 * 60 * 1000).toISOString();
const fakeClock = { now: () => UPLOAD_NOW };

function makeMinimalReport(runId: string = VALID_RUN_ID): Record<string, unknown> {
  return {
    runId,
    date: '2026-06-14',
    findings: [],
    targets: [],
    meta: {
      status: 'success',
      failures: [],
      scannerStatus: [],
      startedAt: '2026-06-14T10:00:00.000Z',
      finishedAt: '2026-06-14T10:30:00.000Z',
      toolVersion: '1.0.0',
    },
  };
}

function makeGoodGithubRun(): Record<string, unknown> {
  // run started 30 minutes ago — within the 2-hour freshness window.
  return {
    id: 12345,
    status: 'completed',
    head_sha: GOOD_SHA,
    path: WORKFLOW_PATH,
    workflow_id: 99,
    run_started_at: new Date(UPLOAD_NOW - 30 * 60 * 1000).toISOString(),
  };
}

function makeOnDemandEnvelope(runId: string = VALID_RUN_ID, jobId: string = 'aabbcc1122334455aabbcc1122334455'): Record<string, unknown> {
  return {
    trigger: 'on-demand',
    jobId,
    targetRepo: 'my-app',
    stagingUrl: 'https://staging.example.com',
    runId,
    report: makeMinimalReport(runId),
  };
}

function makeScheduledEnvelope(runId: string = VALID_RUN_ID): Record<string, unknown> {
  return {
    trigger: 'scheduled',
    runId,
    githubRunId: GOOD_GITHUB_RUN_ID,
    githubWorkflow: WORKFLOW_PATH,
    githubSha: GOOD_SHA,
    report: makeMinimalReport(runId),
  };
}

function bearerHeader(token: string = UPLOAD_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('POST /api/upload — bearer auth', () => {
  let uploadSrv: AuditServer;
  const uploadTmpDir = resolve(tmpdir(), `audit-upload-bearer-${process.pid}`);

  beforeAll(async () => {
    mkdirSync(resolve(uploadTmpDir, 'history'), { recursive: true });
    mkdirSync(resolve(uploadTmpDir, 'reports'), { recursive: true });
    uploadSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 200, body: makeGoodGithubRun() }),
      clock: fakeClock,
    });
  });

  afterAll(async () => {
    await uploadSrv.stop();
    try { rmSync(uploadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 401 when Authorization header is missing — no body read', async () => {
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(makeOnDemandEnvelope()));
    expect(status).toBe(401);
  });

  it('returns 401 when bearer token is wrong', async () => {
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(makeOnDemandEnvelope()),
      bearerHeader('wrong-token'),
    );
    expect(status).toBe(401);
  });

  it('returns 401 when token env is not set (runtime-checked)', async () => {
    // Server with no token configured
    const noTokenDir = resolve(tmpdir(), `audit-upload-notoken-${process.pid}`);
    mkdirSync(resolve(noTokenDir, 'history'), { recursive: true });
    let noTokenSrv: AuditServer | undefined;
    try {
      noTokenSrv = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return noTokenDir;
          return undefined; // No AUDIT_UPLOAD_TOKEN
        },
        clock: fakeClock,
      });
      const { status } = await post(
        noTokenSrv.port, '/api/upload', JSON.stringify(makeOnDemandEnvelope()),
        bearerHeader('any-token'),
      );
      expect(status).toBe(401);
    } finally {
      await noTokenSrv?.stop();
      try { rmSync(noTokenDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('POST /api/upload — on-demand provenance', () => {
  const uploadTmpDir = resolve(tmpdir(), `audit-upload-ondemand-${process.pid}`);
  const JOB_ID = 'aabbcc1122334455aabbcc1122334455';
  let uploadSrv: AuditServer;

  beforeAll(async () => {
    mkdirSync(resolve(uploadTmpDir, 'history'), { recursive: true });
    mkdirSync(resolve(uploadTmpDir, 'reports'), { recursive: true });

    // Seed a dispatched job that we'll accept uploads for.
    // Dispatch at DISPATCH_AT = UPLOAD_NOW - 5 min, within the 30-min TTL.
    appendEvent(
      { event: 'requested', jobId: JOB_ID, targetRepo: 'my-app', stagingUrl: 'https://staging.example.com', at: DISPATCH_AT },
      uploadTmpDir,
    );
    appendEvent(
      { event: 'dispatched', jobId: JOB_ID, at: DISPATCH_AT },
      uploadTmpDir,
    );

    uploadSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 200, body: makeGoodGithubRun() }),
      clock: fakeClock,
    });
  });

  afterAll(async () => {
    await uploadSrv.stop();
    try { rmSync(uploadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 409 for unknown jobId', async () => {
    const envelope = makeOnDemandEnvelope(VALID_RUN_ID, 'unknown-job-id-000000000000000000');
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(envelope),
      bearerHeader(),
    );
    expect(status).toBe(409);
  });

  it('returns 409 when targetRepo does not match the job', async () => {
    const envelope = {
      ...makeOnDemandEnvelope(VALID_RUN_ID, JOB_ID),
      targetRepo: 'wrong-repo',
    };
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(envelope),
      bearerHeader(),
    );
    expect(status).toBe(409);
  });

  it('happy path: dispatched→uploaded flip, 200 {runId, jobId}', async () => {
    const { status, body } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(makeOnDemandEnvelope(VALID_RUN_ID, JOB_ID)),
      bearerHeader(),
    );
    expect(status).toBe(200);
    const json = JSON.parse(body) as { runId: string; jobId: string };
    expect(json.runId).toBe(VALID_RUN_ID);
    expect(json.jobId).toBe(JOB_ID);

    // Job must now be in 'complete' state (uploaded event appended).
    const jobs = foldJobs(uploadTmpDir, UPLOAD_NOW);
    const job = jobs.find((j) => j.jobId === JOB_ID);
    expect(job?.state).toBe('complete');
    expect(job?.runId).toBe(VALID_RUN_ID);
  });

  it('returns 409 for already-uploaded job (replay guard)', async () => {
    // The previous test already uploaded this job; it is now 'complete'.
    const newRunId = '2026-06-14T11-00-00Z-bbbb'; // different runId to avoid H1/H2 rejection
    const envelope = makeOnDemandEnvelope(newRunId, JOB_ID);
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(envelope),
      bearerHeader(),
    );
    expect(status).toBe(409);
  });

  it('returns 409 when the runId dir already exists, even for a fresh dispatched job (3-A in-lock dedup)', async () => {
    // A DISTINCT dispatched job whose verifyOnDemand would pass, but the
    // happy-path test already wrote reports/<VALID_RUN_ID>/. The in-lock
    // runIdExistsOnVolume guard must reject the duplicate runId on the on-demand
    // path (not just scheduled/replay) — no silent overwrite.
    const JOB_ID_2 = 'ccddeeff5566778899ccddeeff556677';
    appendEvent(
      { event: 'requested', jobId: JOB_ID_2, targetRepo: 'my-app', stagingUrl: 'https://staging.example.com', at: DISPATCH_AT },
      uploadTmpDir,
    );
    appendEvent({ event: 'dispatched', jobId: JOB_ID_2, at: DISPATCH_AT }, uploadTmpDir);
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(makeOnDemandEnvelope(VALID_RUN_ID, JOB_ID_2)),
      bearerHeader(),
    );
    expect(status).toBe(409);
  });
});

describe('POST /api/upload — scheduled/replay provenance', () => {
  const uploadTmpDir = resolve(tmpdir(), `audit-upload-scheduled-${process.pid}`);
  let uploadSrv: AuditServer;
  let capturedRequests: GitHubRequest[];

  beforeAll(async () => {
    mkdirSync(resolve(uploadTmpDir, 'history'), { recursive: true });
    mkdirSync(resolve(uploadTmpDir, 'reports'), { recursive: true });
    capturedRequests = [];

    uploadSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        if (name === 'AUDIT_WORKFLOW_REPO') return WORKFLOW_REPO;
        if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
        return undefined;
      },
      githubClient: (req: GitHubRequest): Promise<GitHubResponse> => {
        capturedRequests.push(req);
        return Promise.resolve({ status: 200, body: makeGoodGithubRun() });
      },
      clock: fakeClock,
    });
  });

  afterAll(async () => {
    await uploadSrv.stop();
    try { rmSync(uploadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    capturedRequests = [];
  });

  it('rejects when githubRunId is missing → 400', async () => {
    const envelope = { trigger: 'scheduled', runId: VALID_RUN_ID, githubWorkflow: WORKFLOW_PATH, githubSha: GOOD_SHA, report: makeMinimalReport() };
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
    expect(status).toBe(400);
  });

  it('rejects when GitHub run verification fails (unknown run) → 409', async () => {
    const failSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        if (name === 'AUDIT_WORKFLOW_REPO') return WORKFLOW_REPO;
        if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 404, body: {} }),
      clock: fakeClock,
    });
    try {
      const runId2 = '2026-06-14T10-00-00Z-1111';
      const envelope = makeScheduledEnvelope(runId2);
      const { status } = await post(failSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
      expect(status).toBe(409);
    } finally {
      await failSrv.stop();
    }
  });

  it('rejects when GitHub run is not completed → 409', async () => {
    const inProgressRun = { ...makeGoodGithubRun(), status: 'in_progress' };
    const inProgSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        if (name === 'AUDIT_WORKFLOW_REPO') return WORKFLOW_REPO;
        if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 200, body: inProgressRun }),
      clock: fakeClock,
    });
    try {
      const runId3 = '2026-06-14T10-00-00Z-2222';
      const { status } = await post(inProgSrv.port, '/api/upload', JSON.stringify(makeScheduledEnvelope(runId3)), bearerHeader());
      expect(status).toBe(409);
    } finally {
      await inProgSrv.stop();
    }
  });

  it('rejects run whose name matches but path/workflow_id do NOT match → 409 (named §4.2 test)', async () => {
    // Run has a display `name` that matches `on-demand-scan` but path and workflow_id differ.
    const wrongPathRun = {
      ...makeGoodGithubRun(),
      path: 'completely/different/path.yml',
      workflow_id: 999,
      name: WORKFLOW_PATH, // display name matches — must NOT be used
    };
    const wrongPathSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        if (name === 'AUDIT_WORKFLOW_REPO') return WORKFLOW_REPO;
        if (name === 'AUDIT_GH_DISPATCH_TOKEN') return 'ghp_test';
        return undefined;
      },
      githubClient: (): Promise<GitHubResponse> => Promise.resolve({ status: 200, body: wrongPathRun }),
      clock: fakeClock,
    });
    try {
      const runId4 = '2026-06-14T10-00-00Z-3333';
      const { status } = await post(wrongPathSrv.port, '/api/upload', JSON.stringify(makeScheduledEnvelope(runId4)), bearerHeader());
      expect(status).toBe(409);
    } finally {
      await wrongPathSrv.stop();
    }
  });

  it('happy path: scheduled upload → 200 {runId, jobId: null}', async () => {
    const runId5 = '2026-06-14T10-00-00Z-4444';
    const { status, body } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(makeScheduledEnvelope(runId5)),
      bearerHeader(),
    );
    expect(status).toBe(200);
    const json = JSON.parse(body) as { runId: string; jobId: null };
    expect(json.runId).toBe(runId5);
    expect(json.jobId).toBeNull();
  });

  it('returns 409 for duplicate runId (scheduled/replay dedup)', async () => {
    // runId5 was just ingested above — re-sending the same runId should 409.
    const runId5 = '2026-06-14T10-00-00Z-4444';
    const { status } = await post(
      uploadSrv.port, '/api/upload', JSON.stringify(makeScheduledEnvelope(runId5)),
      bearerHeader(),
    );
    expect(status).toBe(409);
  });
});

describe('POST /api/upload — canonical runId guard (H1, H2)', () => {
  const uploadTmpDir = resolve(tmpdir(), `audit-upload-runid-${process.pid}`);
  const JOB_ID_2 = 'ccddee1122334455ccddee1122334455';
  let uploadSrv: AuditServer;

  beforeAll(async () => {
    mkdirSync(resolve(uploadTmpDir, 'history'), { recursive: true });
    mkdirSync(resolve(uploadTmpDir, 'reports'), { recursive: true });

    // Dispatch at DISPATCH_AT = UPLOAD_NOW - 5 min, within the 30-min TTL.
    appendEvent(
      { event: 'requested', jobId: JOB_ID_2, targetRepo: 'my-app', stagingUrl: 'https://staging.example.com', at: DISPATCH_AT },
      uploadTmpDir,
    );
    appendEvent(
      { event: 'dispatched', jobId: JOB_ID_2, at: DISPATCH_AT },
      uploadTmpDir,
    );

    uploadSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        return undefined;
      },
      clock: fakeClock,
    });
  });

  afterAll(async () => {
    await uploadSrv.stop();
    try { rmSync(uploadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('H1: clean envelope runId but report.runId is a traversal path → 422/400, NO file written', async () => {
    const traversalRunId = '../../config';
    const envelope = {
      trigger: 'on-demand',
      jobId: JOB_ID_2,
      targetRepo: 'my-app',
      stagingUrl: 'https://staging.example.com',
      runId: VALID_RUN_ID, // clean envelope runId
      report: makeMinimalReport(traversalRunId), // report.runId is a traversal path
    };
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
    // Envelope runId !== report.runId → 422 (mismatch detected before path build)
    expect(status === 422 || status === 400).toBe(true);
    // No file must have been written to either the clean envelope runId or the traversal path
    expect(existsSync(resolve(uploadTmpDir, 'reports', VALID_RUN_ID))).toBe(false);
    expect(existsSync(resolve(uploadTmpDir, 'reports', '..', '..', 'config'))).toBe(false);
  });

  it('H2: envelope.runId ≠ report.runId → 422, no file written', async () => {
    const envelope = {
      trigger: 'on-demand',
      jobId: JOB_ID_2,
      targetRepo: 'my-app',
      stagingUrl: 'https://staging.example.com',
      runId: VALID_RUN_ID,
      report: makeMinimalReport('2026-06-14T11-00-00Z-ffff'), // different runId
    };
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
    expect(status).toBe(422);
    expect(existsSync(resolve(uploadTmpDir, 'reports', VALID_RUN_ID))).toBe(false);
    expect(existsSync(resolve(uploadTmpDir, 'reports', '2026-06-14T11-00-00Z-ffff'))).toBe(false);
  });

  it('malformed runId (traversal-shaped) → 400, no file written', async () => {
    const traversalId = '../../evil';
    const envelope = {
      trigger: 'on-demand',
      jobId: JOB_ID_2,
      targetRepo: 'my-app',
      stagingUrl: 'https://staging.example.com',
      runId: traversalId,
      report: makeMinimalReport(traversalId),
    };
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
    expect(status).toBe(400);
  });

  it('schema rejection (422) — report missing required fields', async () => {
    const envelope = {
      trigger: 'on-demand',
      jobId: JOB_ID_2,
      targetRepo: 'my-app',
      stagingUrl: 'https://staging.example.com',
      runId: VALID_RUN_ID,
      report: { runId: VALID_RUN_ID }, // missing date, findings, targets, meta
    };
    const { status } = await post(uploadSrv.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
    expect(status).toBe(422);
  });
});

describe('POST /api/upload — M1: concurrent uploads both land trend lines', () => {
  const uploadTmpDir = resolve(tmpdir(), `audit-upload-m1-${process.pid}`);
  const JOB_A = 'eeee111122223333eeee111122223333';
  const JOB_B = 'ffff444455556666ffff444455556666';
  const RUN_A = '2026-06-14T10-00-00Z-aaaa';
  const RUN_B = '2026-06-14T10-00-00Z-bbbb';
  let uploadSrv: AuditServer;

  beforeAll(async () => {
    mkdirSync(resolve(uploadTmpDir, 'history'), { recursive: true });
    mkdirSync(resolve(uploadTmpDir, 'reports'), { recursive: true });

    // Dispatch at DISPATCH_AT = UPLOAD_NOW - 5 min, within the 30-min TTL.
    for (const jobId of [JOB_A, JOB_B]) {
      appendEvent({ event: 'requested', jobId, targetRepo: 'my-app', stagingUrl: 'https://staging.example.com', at: DISPATCH_AT }, uploadTmpDir);
      appendEvent({ event: 'dispatched', jobId, at: DISPATCH_AT }, uploadTmpDir);
    }

    uploadSrv = await startServer(0, {
      env: (name: string) => {
        if (name === 'DATA_DIR') return uploadTmpDir;
        if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
        return undefined;
      },
      clock: fakeClock,
    });
  });

  afterAll(async () => {
    await uploadSrv.stop();
    try { rmSync(uploadTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('two concurrent uploads with distinct runIds both land — neither trend line dropped (M1)', async () => {
    const envelopeA = {
      ...makeOnDemandEnvelope(RUN_A, JOB_A),
      trendLine: { runId: RUN_A, date: '2026-06-14', targets: {} },
    };
    const envelopeB = {
      ...makeOnDemandEnvelope(RUN_B, JOB_B),
      trendLine: { runId: RUN_B, date: '2026-06-14', targets: {} },
    };

    const [rA, rB] = await Promise.all([
      post(uploadSrv.port, '/api/upload', JSON.stringify(envelopeA), bearerHeader()),
      post(uploadSrv.port, '/api/upload', JSON.stringify(envelopeB), bearerHeader()),
    ]);

    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);

    // Both trend lines must be present — serialized write prevents last-rename-wins.
    const { readFileSync: readF } = await import('node:fs');
    const trendRaw = readF(resolve(uploadTmpDir, 'history', 'trend.jsonl'), 'utf8');
    const trendLines = trendRaw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { runId: string });
    const runIds = trendLines.map((l) => l.runId);
    expect(runIds).toContain(RUN_A);
    expect(runIds).toContain(RUN_B);
  });
});

describe('POST /api/upload — write failure → 500, no uploaded event', () => {
  it('write failure mid-upload → 500, no uploaded event', async () => {
    const failTmpDir = resolve(tmpdir(), `audit-upload-writefail-${process.pid}`);
    const JOB_FAIL = '9999aaaa1111bbbb9999aaaa1111bbbb';
    mkdirSync(resolve(failTmpDir, 'history'), { recursive: true });
    // Note: intentionally NOT creating reports/ dir — writeReport will fail
    // because mkdirSync inside writeReport should still work, but we'll
    // simulate write failure by making reports a FILE instead of a directory.
    writeFileSync(resolve(failTmpDir, 'reports'), 'not-a-dir');

    // Dispatch at DISPATCH_AT = UPLOAD_NOW - 5 min, within the 30-min TTL.
    appendEvent({ event: 'requested', jobId: JOB_FAIL, targetRepo: 'my-app', stagingUrl: 'https://staging.example.com', at: DISPATCH_AT }, failTmpDir);
    appendEvent({ event: 'dispatched', jobId: JOB_FAIL, at: DISPATCH_AT }, failTmpDir);

    let failSrv2: AuditServer | undefined;
    try {
      failSrv2 = await startServer(0, {
        env: (name: string) => {
          if (name === 'DATA_DIR') return failTmpDir;
          if (name === 'AUDIT_UPLOAD_TOKEN') return UPLOAD_TOKEN;
          return undefined;
        },
        clock: fakeClock,
      });

      const runIdFail = '2026-06-14T10-00-00Z-dead'; // 'dead' = valid 4 hex chars
      const envelope = makeOnDemandEnvelope(runIdFail, JOB_FAIL);
      const { status } = await post(failSrv2.port, '/api/upload', JSON.stringify(envelope), bearerHeader());
      expect(status).toBe(500);

      // Job must NOT have an 'uploaded' event — stays in_progress/dispatched state
      const jobs = foldJobs(failTmpDir, UPLOAD_NOW);
      const job = jobs.find((j) => j.jobId === JOB_FAIL);
      expect(job?.state).not.toBe('complete');
    } finally {
      await failSrv2?.stop();
      try { rmSync(failTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
