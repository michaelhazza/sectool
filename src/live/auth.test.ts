import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  establishSession,
  loginForTarget,
  type AuthResult,
  type HttpClient,
  type HttpResponse,
  type LoginResult,
} from './auth.js';
import type { AllowedTarget } from './gate.js';
import type { AuthForm } from '../schemas/targets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake AllowedTarget without calling assertAllowlisted.
 * Tests stay within the live module and do not touch gate.ts at runtime.
 */
function fakeTarget(hostname = 'staging.test.localhost'): AllowedTarget {
  return {
    __allowedTarget: true,
    url: `https://${hostname}`,
    hostname,
  } as unknown as AllowedTarget;
}

function baseAuth(overrides?: Partial<AuthForm>): AuthForm {
  return {
    kind: 'form',
    loginPath: '/api/auth/login',
    method: 'POST',
    userField: 'email',
    passField: 'password',
    bodyType: 'json',
    sessionCarrier: 'cookie',
    successCheck: { statusIn: [200] },
    testUsers: [
      { userEnv: 'AUDIT_TEST_USER_A', passEnv: 'AUDIT_TEST_PASS_A' },
      { userEnv: 'AUDIT_TEST_USER_B', passEnv: 'AUDIT_TEST_PASS_B' },
    ],
    ...overrides,
  };
}

// Innocuous non-secret fixture values used wherever credentials appear.
// Using non-detector-matching strings (no standard entropy patterns).
const FAKE_USER = 'testoperator-alpha';
const FAKE_PASS = 'fakepass-notasecret';
const FAKE_TOKEN = 'fakebearer-notasecret';
const FAKE_COOKIE = 'session=fakevalue-notasecret; Path=/; HttpOnly';

/**
 * Make a minimal HttpClient that does not actually issue network requests.
 * Returns a 200 with Set-Cookie for cookie-based tests.
 */
function makeFakeHttpClient(responses: {
  getResponse?: Partial<HttpResponse>;
  postResponse?: Partial<HttpResponse>;
}): HttpClient {
  return (req): Promise<HttpResponse> => {
    if (req.method === 'GET') {
      return Promise.resolve({
        status: 200,
        body: '<html></html>',
        headers: {},
        ...responses.getResponse,
      });
    }
    return Promise.resolve({
      status: 200,
      body: {},
      headers: {},
      ...responses.postResponse,
    });
  };
}

// ---------------------------------------------------------------------------
// Before each: inject fake env vars; restore after.
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env['AUDIT_TEST_USER_A'] = FAKE_USER;
  process.env['AUDIT_TEST_PASS_A'] = FAKE_PASS;
  process.env['AUDIT_TEST_USER_B'] = FAKE_USER + '-b';
  process.env['AUDIT_TEST_PASS_B'] = FAKE_PASS + '-b';
  return () => {
    delete process.env['AUDIT_TEST_USER_A'];
    delete process.env['AUDIT_TEST_PASS_A'];
    delete process.env['AUDIT_TEST_USER_B'];
    delete process.env['AUDIT_TEST_PASS_B'];
  };
});

// ---------------------------------------------------------------------------
// §10 Carrier-aware login success guardrail
// ---------------------------------------------------------------------------

describe('carrier-aware login success (§6.2 / §10 guardrail)', () => {
  it('bearer: Set-Cookie alone is a login FAILURE', async () => {
    const auth = baseAuth({
      sessionCarrier: 'bearer',
      successCheck: { statusIn: [200], jsonHasKey: 'token' },
    });
    // Response has Set-Cookie but no JSON token key.
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: { message: 'ok' },           // no "token" key
        headers: { 'set-cookie': FAKE_COOKIE },
      },
    });

    const result: AuthResult = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('carrier-mismatch');
      expect(result.message).toMatch(/bearer/i);
      expect(result.message).toMatch(/Set-Cookie/i);
    }
  });

  it('cookie: JSON token alone is a login FAILURE', async () => {
    const auth = baseAuth({
      sessionCarrier: 'cookie',
      successCheck: { statusIn: [200] },   // no jsonHasKey required for cookie
    });
    // Response has a JSON token but no Set-Cookie header.
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: { token: FAKE_TOKEN },        // JSON token present
        headers: {},                         // no Set-Cookie
      },
    });

    const result: AuthResult = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('carrier-mismatch');
      expect(result.message).toMatch(/cookie/i);
      expect(result.message).toMatch(/Set-Cookie/i);
    }
  });

  it('bearer: response with correct jsonHasKey token → success', async () => {
    const auth = baseAuth({
      sessionCarrier: 'bearer',
      successCheck: { statusIn: [200], jsonHasKey: 'token' },
    });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: { token: FAKE_TOKEN },
        headers: {},
      },
    });

    const result: AuthResult = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    expect(result.kind).toBe('session');
    if (result.kind === 'session') {
      expect(result.carrier).toBe('bearer');
      expect(result.bearerToken).toBe(FAKE_TOKEN);
    }
  });

  it('cookie: response with Set-Cookie → success', async () => {
    const auth = baseAuth({
      sessionCarrier: 'cookie',
      successCheck: { statusIn: [200] },
    });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: {},
        headers: { 'set-cookie': FAKE_COOKIE },
      },
    });

    const result: AuthResult = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    expect(result.kind).toBe('session');
    if (result.kind === 'session') {
      expect(result.carrier).toBe('cookie');
      expect(result.cookieHeader).toBe(FAKE_COOKIE);
    }
  });

  it('status not in statusIn → login FAILURE regardless of carrier', async () => {
    const auth = baseAuth({
      sessionCarrier: 'cookie',
      successCheck: { statusIn: [200] },
    });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 401,
        body: { error: 'Unauthorized' },
        headers: { 'set-cookie': FAKE_COOKIE },
      },
    });

    const result: AuthResult = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('login-error');
      expect(result.message).toMatch(/401/);
    }
  });
});

// ---------------------------------------------------------------------------
// §10 Active-scan cred failure guardrail
// ---------------------------------------------------------------------------

describe('activeScan cred failure policy (§6.2 / §10 guardrail)', () => {
  it('activeScan:true + missing env vars → LoginFailure (not unauthenticated)', async () => {
    // Remove the env vars so creds are missing.
    delete process.env['AUDIT_TEST_USER_A'];
    delete process.env['AUDIT_TEST_PASS_A'];

    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const httpClient = vi.fn<HttpClient>().mockResolvedValue({
      status: 200,
      body: {},
      headers: { 'set-cookie': FAKE_COOKIE },
    });

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, true, httpClient);

    expect(result.kind).toBe('failure');
    // HTTP client must not have been called (creds missing → fail before network).
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('activeScan:true + login response failure → LoginFailure (never silent downgrade)', async () => {
    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 401,
        body: { error: 'bad creds' },
        headers: {},
      },
    });

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, true, httpClient);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('login-error');
    }
  });

  it('activeScan:false + missing env vars → UnauthenticatedWithGap (not failure)', async () => {
    delete process.env['AUDIT_TEST_USER_A'];
    delete process.env['AUDIT_TEST_PASS_A'];

    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const httpClient = vi.fn<HttpClient>().mockResolvedValue({
      status: 200,
      body: {},
      headers: { 'set-cookie': FAKE_COOKIE },
    });

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, false, httpClient);

    expect(result.kind).toBe('unauthenticated');
    if (result.kind === 'unauthenticated') {
      expect(result.coverageGap).toMatch(/unauthenticated|cred|missing/i);
    }
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('activeScan:false + login failure → UnauthenticatedWithGap (not failure)', async () => {
    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const httpClient = makeFakeHttpClient({
      postResponse: { status: 401, body: {}, headers: {} },
    });

    const result: LoginResult = await loginForTarget(fakeTarget(), auth, false, httpClient);

    expect(result.kind).toBe('unauthenticated');
    if (result.kind === 'unauthenticated') {
      expect(result.coverageGap).toMatch(/unauthenticated|failed/i);
    }
  });

  it('activeScan:true + no auth config → LoginFailure', async () => {
    const httpClient = vi.fn<HttpClient>();
    const result: LoginResult = await loginForTarget(fakeTarget(), undefined, true, httpClient);

    expect(result.kind).toBe('failure');
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('activeScan:false + no auth config → UnauthenticatedWithGap', async () => {
    const httpClient = vi.fn<HttpClient>();
    const result: LoginResult = await loginForTarget(fakeTarget(), undefined, false, httpClient);

    expect(result.kind).toBe('unauthenticated');
    expect(httpClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §10 Credential redaction — values must not appear in returned output
// ---------------------------------------------------------------------------

describe('credential redaction (§5.4 / §10 guardrail)', () => {
  it('failure message must not contain the raw credential values', async () => {
    // Carrier mismatch: bearer session but only Set-Cookie in response.
    const auth = baseAuth({
      sessionCarrier: 'bearer',
      successCheck: { statusIn: [200], jsonHasKey: 'accessToken' },
    });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: { message: 'ok' },
        headers: { 'set-cookie': FAKE_COOKIE },
      },
    });

    const result = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    // Serialise the entire result to check for raw credential leakage.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(FAKE_USER);
    expect(serialized).not.toMatch(FAKE_PASS);
  });

  it('missing-creds failure message must not echo the env-var value', async () => {
    delete process.env['AUDIT_TEST_USER_A'];

    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const result = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      // httpClient should not be called; passing a real stub for type safety.
      makeFakeHttpClient({}),
    );

    const serialized = JSON.stringify(result);
    // The env NAME is ok (it is not a secret); the VALUE must not appear.
    expect(serialized).not.toMatch(FAKE_USER);
    expect(serialized).not.toMatch(FAKE_PASS);
  });

  it('request body built with credentials is not echoed back in the result', async () => {
    const auth = baseAuth({
      sessionCarrier: 'cookie',
      successCheck: { statusIn: [200] },
    });
    const httpClient = makeFakeHttpClient({
      postResponse: {
        status: 200,
        body: {},
        headers: { 'set-cookie': FAKE_COOKIE },
      },
    });

    const result = await establishSession(
      fakeTarget(),
      auth,
      'AUDIT_TEST_USER_A',
      'AUDIT_TEST_PASS_A',
      httpClient,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(FAKE_USER);
    expect(serialized).not.toMatch(FAKE_PASS);
  });
});

// ---------------------------------------------------------------------------
// CSRF token capture
// ---------------------------------------------------------------------------

describe('CSRF token capture', () => {
  it('captures CSRF token from meta tag and includes it in POST body (json)', async () => {
    const capturedRequests: Array<{ url: string; method: string; body?: string | undefined }> = [];
    const httpClient: HttpClient = (req): Promise<HttpResponse> => {
      capturedRequests.push({ url: req.url, method: req.method, body: req.body });
      if (req.method === 'GET') {
        return Promise.resolve({
          status: 200,
          body: '<html><meta name="csrf-token" content="csrf-abc123"></html>',
          headers: {},
        });
      }
      return Promise.resolve({
        status: 200,
        body: {},
        headers: { 'set-cookie': FAKE_COOKIE },
      });
    };

    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const result = await establishSession(fakeTarget(), auth, 'AUDIT_TEST_USER_A', 'AUDIT_TEST_PASS_A', httpClient);

    expect(result.kind).toBe('session');
    const postReq = capturedRequests.find((r) => r.method === 'POST');
    expect(postReq?.body).toMatch(/_csrf/);
    expect(postReq?.body).toMatch(/csrf-abc123/);
  });

  it('proceeds without CSRF token when GET loginPath fails', async () => {
    const httpClient: HttpClient = (req): Promise<HttpResponse> => {
      if (req.method === 'GET') {
        return Promise.reject(new Error('network error'));
      }
      return Promise.resolve({
        status: 200,
        body: {},
        headers: { 'set-cookie': FAKE_COOKIE },
      });
    };

    const auth = baseAuth({ sessionCarrier: 'cookie', successCheck: { statusIn: [200] } });
    const result = await establishSession(fakeTarget(), auth, 'AUDIT_TEST_USER_A', 'AUDIT_TEST_PASS_A', httpClient);

    // GET failure is non-fatal; login should still succeed.
    expect(result.kind).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// form-urlencoded body type
// ---------------------------------------------------------------------------

describe('bodyType form-urlencoded', () => {
  it('sends credentials in form-encoded format', async () => {
    const capturedBodies: string[] = [];
    const httpClient: HttpClient = (req): Promise<HttpResponse> => {
      if (req.method === 'POST' && req.body !== undefined) {
        capturedBodies.push(req.body);
      }
      return Promise.resolve({
        status: 200,
        body: {},
        headers: { 'set-cookie': FAKE_COOKIE },
      });
    };

    const auth = baseAuth({
      bodyType: 'form-urlencoded',
      sessionCarrier: 'cookie',
      successCheck: { statusIn: [200] },
    });
    const result = await establishSession(fakeTarget(), auth, 'AUDIT_TEST_USER_A', 'AUDIT_TEST_PASS_A', httpClient);

    expect(result.kind).toBe('session');
    const body = capturedBodies[0] ?? '';
    // Should contain the field names (not the raw credential values in plain text in the test assertion,
    // but verifying format: email=...&password=...)
    expect(body).toMatch(/email=/);
    expect(body).toMatch(/password=/);
  });
});
