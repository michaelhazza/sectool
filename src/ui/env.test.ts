import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { resolveEnv } from './env.js';
import { startServer, CSRF_NONCE, type AuditServer, type FixHandler } from './server.js';

// ---------------------------------------------------------------------------
// resolveEnv — pure function tests (no network, no disk)
// ---------------------------------------------------------------------------

describe('resolveEnv — empty env → localhost defaults', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const emptyEnv = (_n: string): string | undefined => undefined;

  it('bindHost defaults to 127.0.0.1', () => {
    const result = resolveEnv(emptyEnv, 4173);
    expect(result.bindHost).toBe('127.0.0.1');
  });

  it('allowedOrigin defaults to http://127.0.0.1:<port>', () => {
    const result = resolveEnv(emptyEnv, 4173);
    expect(result.allowedOrigin).toBe('http://127.0.0.1:4173');
  });

  it('isProduction is false when no FLY_APP_NAME or REQUIRE_AUTH', () => {
    const result = resolveEnv(emptyEnv, 4173);
    expect(result.isProduction).toBe(false);
  });

  it('reportsDir and historyDir are under REPO_ROOT when DATA_DIR not set', () => {
    const result = resolveEnv(emptyEnv, 4173);
    expect(result.reportsDir).toMatch(/reports$/);
    expect(result.historyDir).toMatch(/history$/);
  });
});

describe('resolveEnv — DATA_DIR=/data → reports/history under /data', () => {
  const dataEnv = (name: string): string | undefined => {
    if (name === 'DATA_DIR') return '/data';
    return undefined;
  };

  it('reportsDir is /data/reports', () => {
    const result = resolveEnv(dataEnv, 4173);
    expect(result.reportsDir).toBe(resolve('/data', 'reports'));
  });

  it('historyDir is /data/history', () => {
    const result = resolveEnv(dataEnv, 4173);
    expect(result.historyDir).toBe(resolve('/data', 'history'));
  });

  it('dataDir is /data', () => {
    const result = resolveEnv(dataEnv, 4173);
    expect(result.dataDir).toBe('/data');
  });
});

describe('resolveEnv — FLY_APP_NAME set → isProduction=true', () => {
  it('isProduction is true when FLY_APP_NAME is set', () => {
    const env = (name: string): string | undefined => {
      if (name === 'FLY_APP_NAME') return 'my-app';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.isProduction).toBe(true);
  });

  it('isProduction is true when REQUIRE_AUTH=true', () => {
    const env = (name: string): string | undefined => {
      if (name === 'REQUIRE_AUTH') return 'true';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.isProduction).toBe(true);
  });

  it('isProduction is false when REQUIRE_AUTH=false', () => {
    const env = (name: string): string | undefined => {
      if (name === 'REQUIRE_AUTH') return 'false';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.isProduction).toBe(false);
  });
});

describe('resolveEnv — ALLOWED_ORIGIN / BIND_HOST overrides', () => {
  it('ALLOWED_ORIGIN env overrides the default', () => {
    const env = (name: string): string | undefined => {
      if (name === 'ALLOWED_ORIGIN') return 'https://sectool.fly.dev';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.allowedOrigin).toBe('https://sectool.fly.dev');
  });

  it('BIND_HOST env overrides the default', () => {
    const env = (name: string): string | undefined => {
      if (name === 'BIND_HOST') return '0.0.0.0';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.bindHost).toBe('0.0.0.0');
  });

  it('configDir stays image-relative (REPO_ROOT/config), not under DATA_DIR', () => {
    const env = (name: string): string | undefined => {
      if (name === 'DATA_DIR') return '/data';
      return undefined;
    };
    const result = resolveEnv(env, 4173);
    expect(result.configDir).not.toContain('/data');
    expect(result.configDir).toMatch(/config$/);
  });
});

// ---------------------------------------------------------------------------
// Origin guard test — /api/fix rejects when Origin ≠ resolved allowedOrigin
// ---------------------------------------------------------------------------

function post(
  port: number,
  path: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number }> {
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
        response.resume();
        res({ status: response.statusCode ?? 0 });
      },
    );
    req.on('error', rej);
    req.end(bodyBuf);
  });
}

describe('origin guard — /api/fix uses resolved allowedOrigin (§5.3)', () => {
  let srv: AuditServer;
  let fixHandlerCalled: boolean;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const fixSpy: FixHandler = (_fp: string) => {
    fixHandlerCalled = true;
    return Promise.resolve({ issueUrl: 'https://github.com/test/repo/issues/1' });
  };

  beforeAll(async () => {
    fixHandlerCalled = false;
    // Inject ALLOWED_ORIGIN so it differs from the http://127.0.0.1:<port> default
    srv = await startServer(0, {
      fixHandler: fixSpy,
      env: (name: string) => {
        if (name === 'ALLOWED_ORIGIN') return 'https://sectool.fly.dev';
        return undefined;
      },
    });
  });

  afterAll(async () => {
    await srv.stop();
  });

  const validBody = JSON.stringify({ fingerprint: 'a'.repeat(64) });

  it('rejects 403 when Origin is the loopback default (not the resolved allowedOrigin)', async () => {
    // The server was started with ALLOWED_ORIGIN=https://sectool.fly.dev
    // Sending Origin: http://127.0.0.1:<port> should now be rejected
    const { status } = await post(
      srv.port,
      '/api/fix',
      validBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': `http://127.0.0.1:${srv.port}`,
      },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('rejects 403 when Origin header is absent', async () => {
    const { status } = await post(
      srv.port,
      '/api/fix',
      validBody,
      { 'X-Audit-CSRF': CSRF_NONCE },
    );
    expect(status).toBe(403);
    expect(fixHandlerCalled).toBe(false);
  });

  it('accepts request when Origin matches the resolved allowedOrigin', async () => {
    const { status } = await post(
      srv.port,
      '/api/fix',
      validBody,
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': 'https://sectool.fly.dev',
      },
    );
    expect(status).toBe(200);
    expect(fixHandlerCalled).toBe(true);
  });
});
