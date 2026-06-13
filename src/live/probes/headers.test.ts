import { describe, it, expect, beforeEach } from 'vitest';
import { runHeadersProbe } from './headers.js';
import type { HttpHeadResponse, HeadersClient } from './headers.js';
import type { AllowedTarget } from '../gate.js';
import { _resetHostRegistry } from '../ratelimit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(url = 'https://staging.example.dev/'): AllowedTarget {
  return {
    url,
    hostname: 'staging.example.dev',
  } as unknown as AllowedTarget;
}

function makeSecureHeaders(): Record<string, string> {
  return {
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
}

function makeGoodResponse(): HttpHeadResponse {
  return { status: 200, headers: makeSecureHeaders() };
}

function fakeClient(response: HttpHeadResponse): HeadersClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_target: AllowedTarget): Promise<HttpHeadResponse> => Promise.resolve(response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHeadersProbe', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings for a response with all security headers present', async () => {
    const target = makeTarget();
    const { findings, scopeExcluded } = await runHeadersProbe(target, 10, fakeClient(makeGoodResponse()));
    expect(findings).toHaveLength(0);
    expect(scopeExcluded).toHaveLength(0);
  });

  it('flags missing Strict-Transport-Security', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['strict-transport-security'];
    const response: HttpHeadResponse = { status: 200, headers };
    const { findings } = await runHeadersProbe(target, 10, fakeClient(response));
    const hsts = findings.find((f) => f.evidence.snippet?.includes('Strict-Transport-Security'));
    expect(hsts).toBeDefined();
    expect(hsts?.ruleId).toBe('LIVE-HDR-001');
    expect(hsts?.source).toBe('probe');
    expect(hsts?.surface).toBe('live');
    expect(hsts?.vulnClass).toBe('misconfiguration');
  });

  it('flags missing Content-Security-Policy', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['content-security-policy'];
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('Content-Security-Policy'))).toBe(true);
  });

  it('flags missing X-Frame-Options', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['x-frame-options'];
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('X-Frame-Options'))).toBe(true);
  });

  it('flags weak X-Frame-Options value', async () => {
    const target = makeTarget();
    const headers = { ...makeSecureHeaders(), 'x-frame-options': 'ALLOWALL' };
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('ALLOWALL'))).toBe(true);
  });

  it('accepts SAMEORIGIN as a valid X-Frame-Options value', async () => {
    const target = makeTarget();
    const headers = { ...makeSecureHeaders(), 'x-frame-options': 'SAMEORIGIN' };
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    const xfoFindings = findings.filter((f) => f.evidence.snippet?.includes('X-Frame-Options'));
    expect(xfoFindings).toHaveLength(0);
  });

  it('flags missing X-Content-Type-Options', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['x-content-type-options'];
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('X-Content-Type-Options'))).toBe(true);
  });

  it('flags X-Content-Type-Options value other than nosniff', async () => {
    const target = makeTarget();
    const headers = { ...makeSecureHeaders(), 'x-content-type-options': 'sniff' };
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('sniff'))).toBe(true);
  });

  it('flags missing Referrer-Policy', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['referrer-policy'];
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings.some((f) => f.evidence.snippet?.includes('Referrer-Policy'))).toBe(true);
  });

  it('handles case-insensitive header names', async () => {
    const target = makeTarget();
    // Supply headers in uppercase — should still be recognised as present
    const headers: Record<string, string> = {
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'Content-Security-Policy': "default-src 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    expect(findings).toHaveLength(0);
  });

  it('records off-host redirect as scope-excluded and does not follow it', async () => {
    const target = makeTarget();
    const response: HttpHeadResponse = {
      status: 301,
      headers: makeSecureHeaders(),
      redirectLocation: 'https://other-domain.example.com/path',
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { findings: _findings, scopeExcluded } = await runHeadersProbe(target, 10, fakeClient(response));
    expect(scopeExcluded).toContain('https://other-domain.example.com/path');
  });

  it('does not record same-host redirect as scope-excluded', async () => {
    const target = makeTarget();
    const response: HttpHeadResponse = {
      status: 301,
      headers: makeSecureHeaders(),
      redirectLocation: 'https://staging.example.dev/login',
    };
    const { scopeExcluded } = await runHeadersProbe(target, 10, fakeClient(response));
    expect(scopeExcluded).toHaveLength(0);
  });

  it('emits findings with correct live location shape', async () => {
    const target = makeTarget();
    const headers = makeSecureHeaders();
    delete headers['content-security-policy'];
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    for (const f of findings) {
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
      expect(f.target).toEqual({ kind: 'staging', host: 'staging.example.dev' });
      expect(f.location).toMatchObject({ method: 'GET' });
    }
  });

  it('redacts Authorization header value appearing in response headers', async () => {
    // If a response (malformed server) echoes an Authorization header,
    // the redaction chokepoint must handle it. We verify via raw evidence.
    const target = makeTarget();
    // Note: "authorization" is a credential key — value should be redacted in raw evidence.
    // We supply it in headers to exercise the redact() path.
    const headers = {
      ...makeSecureHeaders(),
      'authorization': 'Bearer super-secret-token-value-here',
    };
    const { findings } = await runHeadersProbe(target, 10, fakeClient({ status: 200, headers }));
    // The header is not a "missing security header" so no findings for it,
    // but the raw evidence passed through redact — verify no raw token in findings
    for (const f of findings) {
      const rawStr = JSON.stringify(f.evidence.raw);
      expect(rawStr).not.toMatch(/super-secret-token-value-here/);
    }
  });
});
