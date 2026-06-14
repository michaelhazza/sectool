import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { basicAuthGate, isAuthEnabled } from './auth.js';
import { resolveEnv, assertProductionConfig, StartupConfigError } from './env.js';
import { startServer, type AuditServer } from './server.js';
import type { EnvReader } from './env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(vars: Record<string, string>): EnvReader {
  return (name: string) => vars[name];
}

function get(
  port: number,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: extraHeaders ?? {} },
      (response) => {
        let data = '';
        response.on('data', (chunk: Buffer | string) => { data += chunk.toString(); });
        response.on('end', () => {
          res({ status: response.statusCode ?? 0, body: data, headers: response.headers });
        });
      },
    );
    req.on('error', rej);
    req.end();
  });
}

function authHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Unit tests: basicAuthGate (pure function)
// ---------------------------------------------------------------------------

describe('basicAuthGate — pure decision function', () => {
  const authEnv = resolveEnv(makeEnv({
    AUDIT_BASIC_AUTH_USER: 'admin',
    AUDIT_BASIC_AUTH_PASS: 's3cret',
  }), 4173);

  it('passes when auth is disabled (no secrets, no production)', () => {
    const devEnv = resolveEnv(makeEnv({}), 4173);
    expect(basicAuthGate(undefined, devEnv)).toBe('pass');
    expect(basicAuthGate('Basic garbage', devEnv)).toBe('pass');
  });

  it('rejects when header is absent and auth is enabled', () => {
    expect(basicAuthGate(undefined, authEnv)).toBe('reject');
  });

  it('rejects when header has wrong credentials', () => {
    expect(basicAuthGate(authHeader('admin', 'wrongpass'), authEnv)).toBe('reject');
    expect(basicAuthGate(authHeader('wronguser', 's3cret'), authEnv)).toBe('reject');
    expect(basicAuthGate('Basic garbage==', authEnv)).toBe('reject');
  });

  it('passes when credentials are correct', () => {
    expect(basicAuthGate(authHeader('admin', 's3cret'), authEnv)).toBe('pass');
  });

  it('rejects when production flag set but credentials missing (fail-closed)', () => {
    // isProduction=true (via REQUIRE_AUTH) but no user/pass set
    const prodNoSecretsEnv = resolveEnv(makeEnv({ REQUIRE_AUTH: 'true' }), 4173);
    expect(basicAuthGate(undefined, prodNoSecretsEnv)).toBe('reject');
    // Even a well-formed header is rejected when secrets are absent
    expect(basicAuthGate(authHeader('admin', 'anything'), prodNoSecretsEnv)).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: isAuthEnabled
// ---------------------------------------------------------------------------

describe('isAuthEnabled', () => {
  it('returns false in local dev with no secrets', () => {
    const env = resolveEnv(makeEnv({}), 4173);
    expect(isAuthEnabled(env)).toBe(false);
  });

  it('returns true when both secrets are set', () => {
    const env = resolveEnv(makeEnv({
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
    }), 4173);
    expect(isAuthEnabled(env)).toBe(true);
  });

  it('returns true in production even without secrets (fail-closed)', () => {
    const env = resolveEnv(makeEnv({ FLY_APP_NAME: 'sectool' }), 4173);
    expect(isAuthEnabled(env)).toBe(true);
  });

  it('returns true when REQUIRE_AUTH=true', () => {
    const env = resolveEnv(makeEnv({ REQUIRE_AUTH: 'true' }), 4173);
    expect(isAuthEnabled(env)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: assertProductionConfig (env-gated startup check)
// ---------------------------------------------------------------------------

describe('assertProductionConfig', () => {
  it('does not throw in local dev (isProduction=false)', () => {
    const env = makeEnv({});
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).not.toThrow();
  });

  it('throws StartupConfigError listing ALL missing vars when FLY_APP_NAME set', () => {
    const env = makeEnv({ FLY_APP_NAME: 'sectool' });
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).toThrow(StartupConfigError);
    try {
      assertProductionConfig(resolved, env);
    } catch (err) {
      expect(err).toBeInstanceOf(StartupConfigError);
      const msg = (err as StartupConfigError).message;
      expect(msg).toContain('AUDIT_BASIC_AUTH_USER');
      expect(msg).toContain('AUDIT_BASIC_AUTH_PASS');
      expect(msg).toContain('ALLOWED_ORIGIN');
      expect(msg).toContain('BIND_HOST');
    }
  });

  it('throws StartupConfigError when REQUIRE_AUTH=true and secrets missing', () => {
    const env = makeEnv({ REQUIRE_AUTH: 'true' });
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).toThrow(StartupConfigError);
  });

  it('throws when only ALLOWED_ORIGIN is missing in production', () => {
    const env = makeEnv({
      FLY_APP_NAME: 'sectool',
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
      BIND_HOST: '0.0.0.0',
      // ALLOWED_ORIGIN intentionally omitted
    });
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).toThrow(StartupConfigError);
    try {
      assertProductionConfig(resolved, env);
    } catch (err) {
      const msg = (err as StartupConfigError).message;
      expect(msg).toContain('ALLOWED_ORIGIN');
      expect(msg).not.toContain('BIND_HOST');
      expect(msg).not.toContain('AUDIT_BASIC_AUTH_USER');
    }
  });

  it('throws when only BIND_HOST is missing in production', () => {
    const env = makeEnv({
      FLY_APP_NAME: 'sectool',
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
      ALLOWED_ORIGIN: 'https://sectool.fly.dev',
      // BIND_HOST intentionally omitted
    });
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).toThrow(StartupConfigError);
    try {
      assertProductionConfig(resolved, env);
    } catch (err) {
      const msg = (err as StartupConfigError).message;
      expect(msg).toContain('BIND_HOST');
      expect(msg).not.toContain('ALLOWED_ORIGIN');
    }
  });

  it('does not throw when all production vars are set', () => {
    const env = makeEnv({
      FLY_APP_NAME: 'sectool',
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
      ALLOWED_ORIGIN: 'https://sectool.fly.dev',
      BIND_HOST: '0.0.0.0',
    });
    const resolved = resolveEnv(env, 4173);
    expect(() => assertProductionConfig(resolved, env)).not.toThrow();
  });

  it('has kind=StartupConfigError for programmatic detection', () => {
    const env = makeEnv({ FLY_APP_NAME: 'sectool' });
    const resolved = resolveEnv(env, 4173);
    try {
      assertProductionConfig(resolved, env);
    } catch (err) {
      expect((err as StartupConfigError).kind).toBe('StartupConfigError');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: startServer production fail-closed
// ---------------------------------------------------------------------------

describe('startServer — production fail-closed', () => {
  it('rejects with StartupConfigError when FLY_APP_NAME set and secrets missing', async () => {
    const env = makeEnv({ FLY_APP_NAME: 'sectool' });
    await expect(startServer(0, { env })).rejects.toBeInstanceOf(StartupConfigError);
  });

  it('rejects when REQUIRE_AUTH=true and secrets missing', async () => {
    const env = makeEnv({ REQUIRE_AUTH: 'true' });
    await expect(startServer(0, { env })).rejects.toBeInstanceOf(StartupConfigError);
  });

  it('rejects when production config missing ALLOWED_ORIGIN', async () => {
    const env = makeEnv({
      FLY_APP_NAME: 'sectool',
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
      BIND_HOST: '127.0.0.1',
      // ALLOWED_ORIGIN intentionally omitted
    });
    await expect(startServer(0, { env })).rejects.toBeInstanceOf(StartupConfigError);
  });

  it('rejects when production config missing BIND_HOST', async () => {
    const env = makeEnv({
      FLY_APP_NAME: 'sectool',
      AUDIT_BASIC_AUTH_USER: 'u',
      AUDIT_BASIC_AUTH_PASS: 'p',
      ALLOWED_ORIGIN: 'https://sectool.fly.dev',
      // BIND_HOST intentionally omitted
    });
    await expect(startServer(0, { env })).rejects.toBeInstanceOf(StartupConfigError);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: HTTP server auth gate
// ---------------------------------------------------------------------------

describe('HTTP auth gate — gate disabled in local dev', () => {
  let srv: AuditServer;

  beforeAll(async () => {
    // No secrets, no production flag → auth disabled
    srv = await startServer(0, { env: makeEnv({}) });
  });

  afterAll(async () => { await srv.stop(); });

  it('GET /api/csrf passes without credentials when auth disabled', async () => {
    const { status } = await get(srv.port, '/api/csrf');
    expect(status).toBe(200);
  });

  it('GET /api/reports passes without credentials when auth disabled', async () => {
    const { status } = await get(srv.port, '/api/reports');
    expect(status).toBe(200);
  });
});

describe('HTTP auth gate — gate enabled with secrets', () => {
  let srv: AuditServer;
  const USER = 'operator';
  const PASS = 'hunter2';

  beforeAll(async () => {
    srv = await startServer(0, {
      env: makeEnv({
        AUDIT_BASIC_AUTH_USER: USER,
        AUDIT_BASIC_AUTH_PASS: PASS,
      }),
    });
  });

  afterAll(async () => { await srv.stop(); });

  it('returns 401 with WWW-Authenticate when no credentials supplied', async () => {
    const { status, headers } = await get(srv.port, '/api/csrf');
    expect(status).toBe(401);
    expect(headers['www-authenticate']).toBe('Basic realm="sectool"');
  });

  it('returns 401 when wrong credentials supplied', async () => {
    const { status } = await get(srv.port, '/api/csrf', {
      Authorization: authHeader(USER, 'wrongpass'),
    });
    expect(status).toBe(401);
  });

  it('passes when correct credentials supplied', async () => {
    const { status } = await get(srv.port, '/api/csrf', {
      Authorization: authHeader(USER, PASS),
    });
    expect(status).toBe(200);
  });

  it('/healthz is reachable without credentials even when gate enabled', async () => {
    // /healthz is not yet implemented (C4) but the route is EXEMPT from the
    // auth gate — it should not return 401 regardless of what C4 returns.
    const { status } = await get(srv.port, '/healthz');
    // Auth gate exemption: must NOT be 401 (may be 404 until C4 adds the route)
    expect(status).not.toBe(401);
  });

  it('/api/upload is reachable without Basic Auth credentials (bearer-only route)', async () => {
    // /api/upload is not yet implemented (C6) but is exempt from Basic Auth.
    // Without the bearer token it will eventually return 401 from a different
    // check, but it must not be rejected by the Basic Auth gate (no WWW-Authenticate).
    const { status, headers } = await get(srv.port, '/api/upload');
    // Must not have the Basic Auth WWW-Authenticate response
    expect(headers['www-authenticate']).not.toBe('Basic realm="sectool"');
    // Status from the Basic Auth gate is exactly 401 with that header; any
    // other status means the gate was bypassed correctly (404 until C6 exists).
    expect(status).not.toBe(401);
  });
});
