import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyTotp, generateSecret, otpauthUri, asciiQr } from './totp.js';

// Mirror of the TOTP algorithm used in totp.ts, for computing expected codes in tests.
// This lets round-trip and vector tests independently verify the implementation.
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

// RFC-6238 Appendix B test vectors (SHA-1, secret "12345678901234567890")
// Base32 of that ASCII secret: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// T=59s → counter=1 → expected code 287082
const T_59_MS = 59 * 1000;
const CODE_T59 = '287082';

// T=1111111109s → counter=37037036 → expected code 081804
const T_1111111109_MS = 1111111109 * 1000;
const CODE_T1111111109 = '081804';

describe('verifyTotp — RFC-6238 known vectors', () => {
  it('validates the T=59 vector (counter=1)', () => {
    expect(verifyTotp(RFC_SECRET, CODE_T59, { now: T_59_MS, window: 0 })).toBe(true);
  });

  it('validates the T=1111111109 vector (counter=37037036)', () => {
    expect(verifyTotp(RFC_SECRET, CODE_T1111111109, { now: T_1111111109_MS, window: 0 })).toBe(true);
  });
});

describe('verifyTotp — window behaviour', () => {
  it('rejects a code from two steps in the past (outside default window=1)', () => {
    // counter at T_59_MS is 1; counter at T_59_MS + 90000 is 4; code 287082 is counter=1 → delta=-3, outside ±1
    const futureNow = T_59_MS + 90_000;
    expect(verifyTotp(RFC_SECRET, CODE_T59, { now: futureNow, window: 1 })).toBe(false);
  });

  it('accepts a code from one step earlier (±1 skew)', () => {
    // now is 30s after the T=59 step: counter=2, but code for counter=1 is valid within window=1
    const oneStepLater = T_59_MS + 30_000;
    expect(verifyTotp(RFC_SECRET, CODE_T59, { now: oneStepLater, window: 1 })).toBe(true);
  });

  it('accepts a code from one step ahead (±1 skew)', () => {
    // now is 30s before the T=1111111109 step: code for counter=37037036 valid within window=1
    const oneStepEarlier = T_1111111109_MS - 30_000;
    expect(verifyTotp(RFC_SECRET, CODE_T1111111109, { now: oneStepEarlier, window: 1 })).toBe(true);
  });

  it('rejects a correct code when window=0 and now is one step later', () => {
    const oneStepLater = T_59_MS + 30_000;
    expect(verifyTotp(RFC_SECRET, CODE_T59, { now: oneStepLater, window: 0 })).toBe(false);
  });
});

describe('verifyTotp — input validation', () => {
  it('rejects a 5-digit code (wrong length)', () => {
    expect(verifyTotp(RFC_SECRET, '28708', { now: T_59_MS })).toBe(false);
  });

  it('rejects a 7-digit code (wrong length)', () => {
    expect(verifyTotp(RFC_SECRET, '2870820', { now: T_59_MS })).toBe(false);
  });

  it('rejects a non-numeric 6-char string', () => {
    expect(verifyTotp(RFC_SECRET, 'abcdef', { now: T_59_MS })).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(verifyTotp(RFC_SECRET, '', { now: T_59_MS })).toBe(false);
  });

  it('rejects a tampered last digit', () => {
    const tampered = CODE_T59.slice(0, 5) + ((Number(CODE_T59[5]) + 1) % 10).toString();
    expect(verifyTotp(RFC_SECRET, tampered, { now: T_59_MS, window: 0 })).toBe(false);
  });

  it('returns false (never throws) for malformed base32 secret', () => {
    expect(() => verifyTotp('!!!not-base32!!!', CODE_T59, { now: T_59_MS })).not.toThrow();
    expect(verifyTotp('!!!not-base32!!!', CODE_T59, { now: T_59_MS })).toBe(false);
  });

  it('returns false for an empty secret', () => {
    expect(verifyTotp('', CODE_T59, { now: T_59_MS })).toBe(false);
  });
});

describe('generateSecret + verifyTotp round-trip', () => {
  it('generates a secret that verifies a freshly computed code', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);

    // counter = 1 (T=59s)
    const expected = computeHotp(secret, 1);
    expect(verifyTotp(secret, expected, { now: T_59_MS, window: 0 })).toBe(true);
  });

  it('rejects a code from a different step when window=0', () => {
    const secret = generateSecret();
    const codeAtCounter1 = computeHotp(secret, 1);
    // counter at T=119s is 3 — code for counter=1 is outside window=0
    expect(verifyTotp(secret, codeAtCounter1, { now: 119_000, window: 0 })).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('produces a well-formed otpauth URI', () => {
    const uri = otpauthUri(RFC_SECRET, 'sectool:ops', 'sectool');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=sectool');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('asciiQr', () => {
  it('includes the input text', () => {
    const uri = 'otpauth://totp/sectool:ops?secret=ABC&issuer=sectool';
    const output = asciiQr(uri);
    expect(output).toContain(uri);
  });

  it('includes enrollment instructions', () => {
    const output = asciiQr('otpauth://totp/test');
    expect(output).toContain('authenticator');
  });
});
