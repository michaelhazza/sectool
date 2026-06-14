/**
 * Route-level tests for POST /api/config/step-up.
 *
 * Uses startServer with injected env to control secrets without process.env mutation.
 * The TOTP code is computed from the injected secret using the same HMAC-SHA1 RFC-6238
 * algorithm to avoid test coupling to totp.ts internals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer, CSRF_NONCE, type AuditServer } from './server.js';
import { verifyStepUpCookie } from './stepup.js';

// ---------------------------------------------------------------------------
// Minimal HOTP/TOTP computation (mirrors totp.ts algorithm, no import dependency)
// ---------------------------------------------------------------------------

function computeHotp(keyBase32: string, counter: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = keyBase32.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of s) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  const key = Buffer.from(output);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[19]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      (hmac[offset + 1]! << 16) |
      (hmac[offset + 2]! << 8) |
      hmac[offset + 3]!) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

function currentTotpCode(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  return computeHotp(secret, counter);
}

// ---------------------------------------------------------------------------
// Test secrets
// ---------------------------------------------------------------------------

// A valid base32 TOTP secret
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const SIGNING_SECRET = 'test-stepup-signing-secret-unique';
const ALLOWED_ORIGIN = 'http://127.0.0.1';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function post(
  port: number,
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
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
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

// Basic Auth header value for a given principal
function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Server with config-editing secrets configured
// ---------------------------------------------------------------------------

describe('POST /api/config/step-up — configured (both secrets present)', () => {
  let srv: AuditServer;
  let allowedOrigin: string;

  beforeAll(async () => {
    srv = await startServer(0, {
      env: (name: string): string | undefined => {
        if (name === 'AUDIT_TOTP_SECRET') return TOTP_SECRET;
        if (name === 'AUDIT_STEPUP_SIGNING_SECRET') return SIGNING_SECRET;
        // Provide required production-like config so Auth is enabled
        if (name === 'AUDIT_BASIC_AUTH_USER') return 'admin';
        if (name === 'AUDIT_BASIC_AUTH_PASS') return 'secret';
        if (name === 'ALLOWED_ORIGIN') return ALLOWED_ORIGIN;
        return undefined;
      },
    });
    allowedOrigin = srv.allowedOrigin;
  });

  afterAll(async () => {
    await srv.stop();
  });

  function validHeaders(): Record<string, string> {
    return {
      'X-Audit-CSRF': CSRF_NONCE,
      'Origin': allowedOrigin,
      'Authorization': basicAuthHeader('admin', 'secret'),
    };
  }

  it('valid TOTP code → 200 + Set-Cookie with all four attributes', async () => {
    const code = currentTotpCode(TOTP_SECRET);
    const { status, headers } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code }),
      validHeaders(),
    );
    expect(status).toBe(200);
    const cookie = headers['set-cookie'];
    expect(cookie).toBeDefined();
    const cookieStr = Array.isArray(cookie) ? cookie[0] : cookie;
    expect(typeof cookieStr).toBe('string');
    expect(cookieStr).toContain('audit_stepup=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Secure');
    expect(cookieStr).toContain('SameSite=Strict');
    expect(cookieStr).toContain('Path=/');
    expect(cookieStr).toContain('Max-Age=300');
  });

  it('valid TOTP code → cookie is signed with SIGNING_SECRET, not TOTP_SECRET', async () => {
    const code = currentTotpCode(TOTP_SECRET);
    const { status, headers } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code }),
      validHeaders(),
    );
    expect(status).toBe(200);
    const cookie = headers['set-cookie'];
    const cookieStr = (Array.isArray(cookie) ? cookie[0] : cookie) ?? '';
    const match = /audit_stepup=([^;]+)/.exec(cookieStr);
    expect(match).not.toBeNull();
    const cookieValue = match![1]!;

    // Must verify with SIGNING_SECRET
    const claims = verifyStepUpCookie(cookieValue, SIGNING_SECRET, Date.now());
    expect(claims).not.toBeNull();
    expect(claims?.scope).toBe('config-write');

    // Must NOT verify with TOTP_SECRET
    const badClaims = verifyStepUpCookie(cookieValue, TOTP_SECRET, Date.now());
    expect(badClaims).toBeNull();
  });

  it('wrong TOTP code → 403, no Set-Cookie', async () => {
    const { status, headers } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code: '000000' }),
      validHeaders(),
    );
    expect(status).toBe(403);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('missing CSRF header → 403, no Set-Cookie', async () => {
    const code = currentTotpCode(TOTP_SECRET);
    const { status, headers } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code }),
      {
        'Origin': allowedOrigin,
        'Authorization': basicAuthHeader('admin', 'secret'),
      },
    );
    expect(status).toBe(403);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('wrong Origin → 403, no Set-Cookie', async () => {
    const code = currentTotpCode(TOTP_SECRET);
    const { status, headers } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code }),
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': 'https://evil.example.com',
        'Authorization': basicAuthHeader('admin', 'secret'),
      },
    );
    expect(status).toBe(403);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('missing Basic Auth → 401', async () => {
    const code = currentTotpCode(TOTP_SECRET);
    const { status } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code }),
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': allowedOrigin,
        // No Authorization header
      },
    );
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Server with config-editing secrets NOT configured (fail-closed)
// ---------------------------------------------------------------------------

describe('POST /api/config/step-up — not configured (missing secrets)', () => {
  let srv: AuditServer;
  let allowedOrigin: string;

  beforeAll(async () => {
    srv = await startServer(0, {
      env: (name: string): string | undefined => {
        // No AUDIT_TOTP_SECRET, no AUDIT_STEPUP_SIGNING_SECRET
        if (name === 'AUDIT_BASIC_AUTH_USER') return 'admin';
        if (name === 'AUDIT_BASIC_AUTH_PASS') return 'secret';
        if (name === 'ALLOWED_ORIGIN') return ALLOWED_ORIGIN;
        return undefined;
      },
    });
    allowedOrigin = srv.allowedOrigin;
  });

  afterAll(async () => {
    await srv.stop();
  });

  it('returns 403 "config editing not configured" — no cookie set', async () => {
    const { status, headers, body } = await post(
      srv.port,
      '/api/config/step-up',
      JSON.stringify({ code: '123456' }),
      {
        'X-Audit-CSRF': CSRF_NONCE,
        'Origin': allowedOrigin,
        'Authorization': basicAuthHeader('admin', 'secret'),
      },
    );
    expect(status).toBe(403);
    expect(headers['set-cookie']).toBeUndefined();
    const json = JSON.parse(body) as { error: string };
    expect(json.error).toContain('not configured');
  });
});
