import { describe, it, expect } from 'vitest';
import { signStepUpCookie, verifyStepUpCookie, requireStepUp, hashPrincipal,
  isStepUpLockedOut, recordStepUpFailure, resetStepUpThrottle, type StepUpClaims } from './stepup.js';
import type { IncomingMessage } from 'node:http';

describe('step-up brute-force throttle (5-A)', () => {
  it('locks out after 5 consecutive failures and resets on success', () => {
    resetStepUpThrottle();
    const t0 = 1_000_000;
    expect(isStepUpLockedOut(t0)).toBe(false);
    for (let i = 0; i < 5; i++) recordStepUpFailure(t0);
    // After 5 failures the exchange is locked for the backoff window.
    expect(isStepUpLockedOut(t0)).toBe(true);
    expect(isStepUpLockedOut(t0 + 60_000)).toBe(false); // 1-min base window elapsed
    resetStepUpThrottle();
    expect(isStepUpLockedOut(t0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-signing-secret-xyz';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // a valid base32 secret (NOT the signing secret)

const BASE_CLAIMS: StepUpClaims = {
  principalHash: hashPrincipal('admin:password'),
  csrfNonce: 'abc123csrf',
  scope: 'config-write',
  exp: Date.now() + 5 * 60 * 1000,
};

function makeMockReq(overrides: {
  cookie?: string;
  csrfHeader?: string;
  origin?: string;
  authorization?: string;
} = {}): IncomingMessage {
  return {
    headers: {
      ...(overrides.cookie !== undefined ? { cookie: overrides.cookie } : {}),
      ...(overrides.csrfHeader !== undefined ? { 'x-audit-csrf': overrides.csrfHeader } : {}),
      ...(overrides.origin !== undefined ? { origin: overrides.origin } : {}),
      ...(overrides.authorization !== undefined ? { authorization: overrides.authorization } : {}),
    },
  } as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// signStepUpCookie / verifyStepUpCookie — pure cookie round-trip
// ---------------------------------------------------------------------------

describe('signStepUpCookie + verifyStepUpCookie', () => {
  it('round-trips valid claims', () => {
    const now = Date.now();
    const claims: StepUpClaims = { ...BASE_CLAIMS, exp: now + 300_000 };
    const value = signStepUpCookie(claims, SIGNING_SECRET);
    const result = verifyStepUpCookie(value, SIGNING_SECRET, now);
    expect(result).not.toBeNull();
    expect(result?.scope).toBe('config-write');
    expect(result?.csrfNonce).toBe(claims.csrfNonce);
    expect(result?.principalHash).toBe(claims.principalHash);
  });

  it('cookie is signed with AUDIT_STEPUP_SIGNING_SECRET — not the TOTP secret', () => {
    const now = Date.now();
    const claims: StepUpClaims = { ...BASE_CLAIMS, exp: now + 300_000 };
    // Signed with the signing secret
    const value = signStepUpCookie(claims, SIGNING_SECRET);
    // Verifying with the TOTP secret (wrong key) must return null
    const badResult = verifyStepUpCookie(value, TOTP_SECRET, now);
    expect(badResult).toBeNull();
    // Verifying with the correct signing secret must succeed
    const goodResult = verifyStepUpCookie(value, SIGNING_SECRET, now);
    expect(goodResult).not.toBeNull();
  });

  it('returns null for a tampered signature', () => {
    const now = Date.now();
    const claims: StepUpClaims = { ...BASE_CLAIMS, exp: now + 300_000 };
    const value = signStepUpCookie(claims, SIGNING_SECRET);
    const tampered = value.slice(0, -4) + 'XXXX';
    expect(verifyStepUpCookie(tampered, SIGNING_SECRET, now)).toBeNull();
  });

  it('returns null for an expired cookie (now >= exp)', () => {
    const exp = Date.now() - 1; // already expired
    const claims: StepUpClaims = { ...BASE_CLAIMS, exp };
    const value = signStepUpCookie(claims, SIGNING_SECRET);
    expect(verifyStepUpCookie(value, SIGNING_SECRET, Date.now())).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(verifyStepUpCookie('not.a.valid.cookie', SIGNING_SECRET, Date.now())).toBeNull();
    expect(verifyStepUpCookie('', SIGNING_SECRET, Date.now())).toBeNull();
    expect(verifyStepUpCookie('nodot', SIGNING_SECRET, Date.now())).toBeNull();
  });

  it('returns null when wrong secret used to verify', () => {
    const now = Date.now();
    const claims: StepUpClaims = { ...BASE_CLAIMS, exp: now + 300_000 };
    const value = signStepUpCookie(claims, SIGNING_SECRET);
    expect(verifyStepUpCookie(value, 'wrong-secret', now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireStepUp
// ---------------------------------------------------------------------------

describe('requireStepUp', () => {
  const csrfNonce = 'my-csrf-nonce';
  const principal = 'admin:secret';
  const principalHash = hashPrincipal(principal);

  function makeValidCookie(overrides: Partial<StepUpClaims> = {}): string {
    const now = Date.now();
    const claims: StepUpClaims = {
      principalHash,
      csrfNonce,
      scope: 'config-write',
      exp: now + 300_000,
      ...overrides,
    };
    return signStepUpCookie(claims, SIGNING_SECRET);
  }

  it('returns ok for a valid unexpired cookie with matching CSRF and principal', () => {
    const cookie = makeValidCookie();
    const req = makeMockReq({ cookie: `audit_stepup=${cookie}` });
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash,
    });
    expect(result).toBe('ok');
  });

  it('returns forbidden when cookie is absent', () => {
    const req = makeMockReq({});
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash,
    });
    expect(result).toBe('forbidden');
  });

  it('returns forbidden when cookie is bound to a different CSRF nonce', () => {
    const cookie = makeValidCookie({ csrfNonce: 'different-nonce' });
    const req = makeMockReq({ cookie: `audit_stepup=${cookie}` });
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce, // expects 'my-csrf-nonce'
      principalHash,
    });
    expect(result).toBe('forbidden');
  });

  it('returns forbidden when cookie is bound to a different principal', () => {
    const otherHash = hashPrincipal('other:user');
    const cookie = makeValidCookie({ principalHash: otherHash });
    const req = makeMockReq({ cookie: `audit_stepup=${cookie}` });
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash, // expects current principal hash
    });
    expect(result).toBe('forbidden');
  });

  it('returns forbidden when cookie is expired', () => {
    const exp = Date.now() - 1000; // past
    const cookie = makeValidCookie({ exp });
    const req = makeMockReq({ cookie: `audit_stepup=${cookie}` });
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash,
      now: Date.now(),
    });
    expect(result).toBe('forbidden');
  });

  it('returns forbidden when cookie is signed with the TOTP secret instead of the signing secret', () => {
    const now = Date.now();
    const claims: StepUpClaims = {
      principalHash,
      csrfNonce,
      scope: 'config-write',
      exp: now + 300_000,
    };
    // Signed with the TOTP secret (wrong key)
    const cookie = signStepUpCookie(claims, TOTP_SECRET);
    const req = makeMockReq({ cookie: `audit_stepup=${cookie}` });
    // Verified with the signing secret — must reject
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash,
      now,
    });
    expect(result).toBe('forbidden');
  });

  it('parses the correct cookie when multiple cookies present', () => {
    const cookie = makeValidCookie();
    const req = makeMockReq({ cookie: `session=abc; audit_stepup=${cookie}; other=xyz` });
    const result = requireStepUp(req, {
      signingSecret: SIGNING_SECRET,
      csrfNonce,
      principalHash,
    });
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// hashPrincipal — deterministic, stable
// ---------------------------------------------------------------------------

describe('hashPrincipal', () => {
  it('returns a 64-char hex string', () => {
    expect(hashPrincipal('admin:secret')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashPrincipal('admin:secret')).toBe(hashPrincipal('admin:secret'));
  });

  it('differs for different principals', () => {
    expect(hashPrincipal('admin:secret')).not.toBe(hashPrincipal('admin:other'));
  });
});
