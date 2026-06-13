import { describe, it, expect, beforeEach } from 'vitest';
import { runCookiesProbe } from './cookies.js';
import type { CookieResponse, CookiesClient } from './cookies.js';
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

function fakeClient(response: CookieResponse): CookiesClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_target: AllowedTarget): Promise<CookieResponse> => Promise.resolve(response);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCookiesProbe', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings when all cookies have HttpOnly, Secure, SameSite=Strict', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: [
        'session=abc123; Path=/; HttpOnly; Secure; SameSite=Strict',
        'pref=dark; Path=/; HttpOnly; Secure; SameSite=Lax',
      ],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when there are no Set-Cookie headers', async () => {
    const target = makeTarget();
    const response: CookieResponse = { status: 200, setCookieHeaders: [] };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings).toHaveLength(0);
  });

  it('flags missing HttpOnly flag', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/; Secure; SameSite=Strict'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    const httponly = findings.find((f) => f.evidence.snippet?.includes('HttpOnly'));
    expect(httponly).toBeDefined();
    expect(httponly?.ruleId).toBe('LIVE-COOKIE-001');
    expect(httponly?.source).toBe('probe');
    expect(httponly?.surface).toBe('live');
    expect(httponly?.vulnClass).toBe('session-management');
  });

  it('flags missing Secure flag', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/; HttpOnly; SameSite=Strict'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings.some((f) => f.evidence.snippet?.includes('Secure flag'))).toBe(true);
  });

  it('flags missing SameSite flag', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/; HttpOnly; Secure'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings.some((f) => f.evidence.snippet?.includes('SameSite flag'))).toBe(true);
  });

  it('flags SameSite=None as weak', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/; HttpOnly; Secure; SameSite=None'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings.some((f) => f.evidence.snippet?.includes('SameSite=None'))).toBe(true);
  });

  it('accepts SameSite=Lax as valid', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    const samesiteFindings = findings.filter(
      (f) => f.evidence.snippet?.includes('SameSite'),
    );
    expect(samesiteFindings).toHaveLength(0);
  });

  it('produces one finding per flag issue per cookie', async () => {
    const target = makeTarget();
    // Cookie missing all three flags
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['session=abc123; Path=/'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    // Expect three findings: missing HttpOnly, Secure, SameSite
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });

  it('redacts Set-Cookie values in evidence raw', async () => {
    // The raw cookie line contains a session token value; it must be redacted.
    // We use an innocuous non-detector-matching session value to confirm redaction.
    const target = makeTarget();
    const secretValue = 'abc-session-xyz-fixture'; // not a real secret pattern
    const response: CookieResponse = {
      status: 200,
      // Cookie missing HttpOnly flag so a finding will be produced
      setCookieHeaders: [`session=${secretValue}; Path=/; Secure; SameSite=Strict`],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      // The raw evidence should NOT contain the raw cookie line with the value
      // because it is passed through redact({'set-cookie': rawLine})
      const rawStr = JSON.stringify(f.evidence.raw);
      // The 'set-cookie' key triggers header-aware redaction: value gets [redacted:...]
      expect(rawStr).toMatch(/\[redacted:[0-9a-f]{8}\]/);
    }
  });

  it('emits findings with correct live location shape including cookie name as parameter', async () => {
    const target = makeTarget();
    const response: CookieResponse = {
      status: 200,
      setCookieHeaders: ['authtoken=val; Path=/; Secure; SameSite=Strict'],
    };
    const findings = await runCookiesProbe(target, 10, fakeClient(response));
    // authtoken is missing HttpOnly
    const f = findings.find((f) => f.evidence.snippet?.includes('HttpOnly'));
    expect(f).toBeDefined();
    expect(f?.location).toMatchObject({ parameter: 'authtoken', method: 'GET' });
    expect(f?.target).toEqual({ kind: 'staging', host: 'staging.example.dev' });
    expect(f?.id).toMatch(/^f-[0-9a-f]{16}$/);
    expect(f?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f?.id).toBe(`f-${f!.fingerprint.slice(0, 16)}`);
  });
});
