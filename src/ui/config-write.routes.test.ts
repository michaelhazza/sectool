/**
 * Route-level tests for the config-write API routes.
 *
 * Tests the full gate order for mutating routes:
 *   Basic Auth → CSRF + Origin → step-up cookie → configWriteDeps.ok → body parse → service
 *
 * All git operations use a local temp bare repo (no network).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { startServer, CSRF_NONCE, type AuditServer } from './server.js';
import { signStepUpCookie, hashPrincipal } from './stepup.js';


// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const SIGNING_SECRET = 'test-signing-secret-routes';
const ALLOWED_ORIGIN = 'http://127.0.0.1';
const USER = 'admin';
const PASS = 'secret';

// ---------------------------------------------------------------------------
// Git environment setup
// ---------------------------------------------------------------------------

interface GitEnv {
  bare: string;
  clone: string;
  configDir: string;
  historyDir: string;
  base: string;
}

const BASE_TARGETS = {
  repos: [{ name: 'test-repo', gitUrl: 'https://github.com/example/test.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }],
  stagingTargets: [],
};
const BASE_ALLOWLIST = { hosts: [] };

function gitCmd(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    encoding: 'utf8',
  }).toString().trim();
}

function setupGitEnv(): GitEnv {
  const base = mkdtempSync(join(tmpdir(), 'config-routes-test-'));
  const bare = join(base, 'bare.git');
  const clone = join(base, 'clone');
  const historyDir = join(base, 'history');
  mkdirSync(historyDir, { recursive: true });

  execSync(`git init --bare -b main "${bare}"`, { env: { ...process.env }, encoding: 'utf8' });
  execSync(`git clone -c core.autocrlf=false "${bare}" "${clone}"`, { env: { ...process.env }, encoding: 'utf8' });
  gitCmd(['config', 'user.name', 'Test'], clone);
  gitCmd(['config', 'user.email', 'test@test.com'], clone);
  gitCmd(['config', 'core.autocrlf', 'false'], clone);
  gitCmd(['config', 'init.defaultBranch', 'main'], clone);

  const configDir = join(clone, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'targets.json'), JSON.stringify(BASE_TARGETS, null, 2) + '\n', 'utf8');
  writeFileSync(join(configDir, 'allowed-staging-hosts.json'), JSON.stringify(BASE_ALLOWLIST, null, 2) + '\n', 'utf8');
  gitCmd(['add', 'config/targets.json', 'config/allowed-staging-hosts.json'], clone);
  gitCmd(['commit', '-m', 'initial config'], clone);
  // Rename local branch to main (in case git init.defaultBranch is master on this system)
  try { gitCmd(['branch', '-m', 'main'], clone); } catch { /* already named main */ }
  gitCmd(['push', 'origin', 'HEAD:main'], clone);

  return { bare, clone, configDir, historyDir, base };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpPost(
  port: number, path: string, body: string, headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((res, rej) => {
    const buf = Buffer.from(body, 'utf8');
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.byteLength, ...headers },
    }, (response) => {
      let data = '';
      response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
      response.on('end', () => res({ status: response.statusCode ?? 0, headers: response.headers as Record<string, string | string[]>, body: data }));
    });
    req.on('error', rej);
    req.end(buf);
  });
}

function httpDelete(
  port: number, path: string, headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'DELETE', headers,
    }, (response) => {
      let data = '';
      response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
      response.on('end', () => res({ status: response.statusCode ?? 0, body: data }));
    });
    req.on('error', rej);
    req.end();
  });
}

function httpGet(
  port: number, path: string, headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'GET', headers,
    }, (response) => {
      let data = '';
      response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
      response.on('end', () => res({ status: response.statusCode ?? 0, body: data }));
    });
    req.on('error', rej);
    req.end();
  });
}

function basicAuth(user = USER, pass = PASS): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function makeStepUpCookie(csrfNonce: string, principal = `${USER}:${PASS}`): string {
  const claims = {
    principalHash: hashPrincipal(principal),
    csrfNonce,
    scope: 'config-write' as const,
    exp: Date.now() + 5 * 60 * 1000,
  };
  const value = signStepUpCookie(claims, SIGNING_SECRET);
  return `audit_stepup=${value}`;
}

// ---------------------------------------------------------------------------
// Server setup — one server per test suite (with config-write deps configured)
// ---------------------------------------------------------------------------

let srv: AuditServer;
let gitEnv: GitEnv;
let allowedOrigin: string;

beforeAll(async () => {
  gitEnv = setupGitEnv();

  srv = await startServer(0, {
    env: (name: string): string | undefined => {
      if (name === 'AUDIT_TOTP_SECRET') return TOTP_SECRET;
      if (name === 'AUDIT_STEPUP_SIGNING_SECRET') return SIGNING_SECRET;
      if (name === 'AUDIT_GIT_WRITE_TOKEN') return 'test-token';
      if (name === 'AUDIT_GIT_AUTHOR') return 'Test <test@test.com>';
      if (name === 'CONFIG_BRANCH') return 'main';
      if (name === 'AUDIT_GIT_REMOTE_URL') return gitEnv.bare;
      if (name === 'CONFIG_REPO_DIR') return gitEnv.clone;
      if (name === 'DATA_DIR') return gitEnv.base;
      if (name === 'AUDIT_BASIC_AUTH_USER') return USER;
      if (name === 'AUDIT_BASIC_AUTH_PASS') return PASS;
      if (name === 'ALLOWED_ORIGIN') return ALLOWED_ORIGIN;
      return undefined;
    },
  });

  allowedOrigin = srv.allowedOrigin;
});

afterAll(async () => {
  await srv.stop();
  try { rmSync(gitEnv.base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Helper: build standard valid headers for write routes
// ---------------------------------------------------------------------------

function validWriteHeaders(csrfNonce = CSRF_NONCE): Record<string, string> {
  return {
    'X-Audit-CSRF': csrfNonce,
    'Origin': allowedOrigin,
    'Authorization': basicAuth(),
    'Cookie': makeStepUpCookie(csrfNonce),
  };
}

// ---------------------------------------------------------------------------
// Gate tests: no Basic Auth → 401
// ---------------------------------------------------------------------------

describe('gate: no Basic Auth → 401', () => {
  it('POST /api/config/repos → 401 when no auth', async () => {
    const { status } = await httpPost(srv.port, '/api/config/repos', JSON.stringify({}), {
      'X-Audit-CSRF': CSRF_NONCE,
      'Origin': allowedOrigin,
      'Cookie': makeStepUpCookie(CSRF_NONCE),
    });
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Gate tests: missing/invalid step-up cookie → 403, nothing committed
// ---------------------------------------------------------------------------

describe('gate: no/invalid step-up cookie → 403, nothing committed (safety-critical)', () => {
  it('POST /api/config/repos — no cookie → 403', async () => {
    const headBefore = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();

    const { status } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({ name: 'should-not-commit', gitUrl: 'https://github.com/x/y.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }),
      { 'X-Audit-CSRF': CSRF_NONCE, 'Origin': allowedOrigin, 'Authorization': basicAuth() },
    );
    expect(status).toBe(403);

    const headAfter = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('POST /api/config/repos — invalid (tampered) cookie → 403', async () => {
    const headBefore = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();

    const { status } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({ name: 'should-not-commit', gitUrl: 'https://github.com/x/y.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }),
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': allowedOrigin,
        'Authorization': basicAuth(),
        'Cookie': 'audit_stepup=invalid.tampered',
      },
    );
    expect(status).toBe(403);

    const headAfter = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('step-up cookie bound to different CSRF nonce → 403', async () => {
    const wrongNonce = 'a'.repeat(64);
    const claims = {
      principalHash: hashPrincipal(`${USER}:${PASS}`),
      csrfNonce: wrongNonce,  // wrong nonce
      scope: 'config-write' as const,
      exp: Date.now() + 5 * 60 * 1000,
    };
    const badCookie = `audit_stepup=${signStepUpCookie(claims, SIGNING_SECRET)}`;

    const { status } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({ name: 'x', gitUrl: 'https://github.com/x/y.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }),
      { 'X-Audit-CSRF': CSRF_NONCE, 'Origin': allowedOrigin, 'Authorization': basicAuth(), 'Cookie': badCookie },
    );
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Gate tests: CSRF/Origin → 403
// ---------------------------------------------------------------------------

describe('gate: CSRF/Origin → 403', () => {
  it('missing X-Audit-CSRF → 403', async () => {
    const { status } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({}),
      { 'Origin': allowedOrigin, 'Authorization': basicAuth(), 'Cookie': makeStepUpCookie(CSRF_NONCE) },
    );
    expect(status).toBe(403);
  });

  it('wrong Origin → 403', async () => {
    const { status } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({}),
      { 'X-Audit-CSRF': CSRF_NONCE, 'Origin': 'https://evil.example.com', 'Authorization': basicAuth(), 'Cookie': makeStepUpCookie(CSRF_NONCE) },
    );
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Schema rejection → 422
// ---------------------------------------------------------------------------

describe('schema rejection → 422', () => {
  it('invalid repo (bad gitUrl) → 422', async () => {
    const headBefore = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();

    const { status, body } = await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({ name: 'bad', gitUrl: 'not-a-url', localPath: null, stackTags: [], publicRoutes: [], enabled: true }),
      validWriteHeaders(),
    );
    expect(status).toBe(422);
    const json = JSON.parse(body) as { error: string; issues?: unknown[] };
    expect(Array.isArray(json.issues)).toBe(true);

    const headAfter = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// GET /api/config/history — no step-up required
// ---------------------------------------------------------------------------

describe('GET /api/config/history — no step-up required', () => {
  it('returns 200 with Basic Auth only', async () => {
    const { status, body } = await httpGet(
      srv.port, '/api/config/history',
      { 'Authorization': basicAuth() },
    );
    expect(status).toBe(200);
    const json = JSON.parse(body) as { entries: unknown[] };
    expect(Array.isArray(json.entries)).toBe(true);
  });

  it('history reads back after a write', async () => {
    // Do a write first
    await httpPost(
      srv.port, '/api/config/repos',
      JSON.stringify({ name: 'history-test', gitUrl: 'https://github.com/x/h.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }),
      validWriteHeaders(),
    );

    const { status, body } = await httpGet(
      srv.port, '/api/config/history',
      { 'Authorization': basicAuth() },
    );
    expect(status).toBe(200);
    const json = JSON.parse(body) as { entries: Array<{ message: string }> };
    expect(json.entries.some((e) => e.message.includes('history-test'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addStagingTarget with addHost → ONE commit touching both files (safety-critical)
// ---------------------------------------------------------------------------

describe('POST /api/config/staging-targets with addHost → ONE commit both files', () => {
  it('addHost=true → single commit with both targets.json and allowed-staging-hosts.json', async () => {
    const payload = {
      name: 'staging-route-test',
      url: 'https://route-test.example.com',
      repo: 'test-repo',
      activeScan: false,
      enabled: true,
      addHost: true,
    };

    const { status, body } = await httpPost(
      srv.port, '/api/config/staging-targets',
      JSON.stringify(payload),
      validWriteHeaders(),
    );
    expect(status).toBe(200);
    const result = JSON.parse(body) as { sha: string; state: { targets: { stagingTargets: unknown[] }; allowlist: { hosts: unknown[] } } };
    expect(result.sha).toBeTruthy();
    expect(result.state.targets.stagingTargets).toHaveLength(1);
    expect(result.state.allowlist.hosts).toHaveLength(1);

    // Verify ONE commit touched BOTH files
    const commitFiles = execSync(
      `git diff-tree --no-commit-id -r --name-only ${result.sha}`,
      { cwd: gitEnv.clone, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort();
    expect(commitFiles).toContain('config/targets.json');
    expect(commitFiles).toContain('config/allowed-staging-hosts.json');
    expect(commitFiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/config/allowlist/:host — in-use host → 409
// ---------------------------------------------------------------------------

describe('DELETE /api/config/allowlist/:host — in-use → 409', () => {
  it('removing a host in use by an enabled staging target → 409, no commit', async () => {
    // Add host
    await httpPost(
      srv.port, '/api/config/allowlist',
      JSON.stringify({ host: 'inuse.example.com', owner: 'admin', addedAt: new Date().toISOString() }),
      validWriteHeaders(),
    );
    // Add staging target using the host
    await httpPost(
      srv.port, '/api/config/staging-targets',
      JSON.stringify({ name: 'inuse-target', url: 'https://inuse.example.com', repo: 'test-repo', activeScan: false, enabled: true }),
      validWriteHeaders(),
    );

    const headBefore = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();

    const { status } = await httpDelete(
      srv.port, '/api/config/allowlist/inuse.example.com',
      validWriteHeaders(),
    );
    expect(status).toBe(409);

    const headAfter = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();
    expect(headAfter).toBe(headBefore);
  });
});

// ---------------------------------------------------------------------------
// POST /api/config/revert/:commit — non-config commit → 400
// ---------------------------------------------------------------------------

describe('POST /api/config/revert/:commit', () => {
  it('revert of a non-config(dashboard) commit → 400', async () => {
    // Create a non-config commit
    writeFileSync(join(gitEnv.clone, 'README.md'), 'test\n', 'utf8');
    gitCmd(['add', 'README.md'], gitEnv.clone);
    gitCmd(['commit', '-m', 'non-config commit'], gitEnv.clone);
    gitCmd(['push', 'origin', 'HEAD:main'], gitEnv.clone);

    const nonConfigSha = execSync('git rev-parse HEAD', { cwd: gitEnv.clone, encoding: 'utf8' }).trim();

    const { status } = await httpPost(
      srv.port, `/api/config/revert/${nonConfigSha}`,
      '',
      validWriteHeaders(),
    );
    expect(status).toBe(400);
  });
});
