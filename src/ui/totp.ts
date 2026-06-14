import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 4648 base32 alphabet (uppercase, no padding)
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer | null {
  const s = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

function hotp(key: Buffer, counter: number): string {
  // Counter as 8-byte big-endian (RFC 4226 §5.1)
  const buf = Buffer.alloc(8);
  // JavaScript numbers lose precision above 2^53; TOTP counters are well within range
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', key).update(buf).digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = hmac[19]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      (hmac[offset + 1]! << 16) |
      (hmac[offset + 2]! << 8) |
      hmac[offset + 3]!) %
    1_000_000;

  return code.toString().padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP code against a base32-encoded shared secret.
 * Returns false (never throws) for malformed secrets or wrong-length codes.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { window?: number; now?: number } = {},
): boolean {
  // Reject non-6-digit or non-numeric input early
  if (!/^\d{6}$/.test(code)) return false;

  const key = base32Decode(secret);
  if (key === null) return false;

  const now = opts.now ?? Date.now();
  const window = opts.window ?? 1;
  const counter = Math.floor(now / 1000 / 30);

  const codeBytes = Buffer.from(code.padStart(6, '0'));

  for (let delta = -window; delta <= window; delta++) {
    const expected = hotp(key, counter + delta);
    const expectedBytes = Buffer.from(expected.padStart(6, '0'));
    // timingSafeEqual requires equal-length buffers; both are 6 bytes
    if (timingSafeEqual(codeBytes, expectedBytes)) return true;
  }

  return false;
}

/**
 * Generate a random 20-byte (160-bit) base32-encoded secret.
 */
export function generateSecret(): string {
  const bytes = randomBytes(20);
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += B32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

/**
 * Build a standard otpauth:// URI for use with authenticator apps.
 */
export function otpauthUri(secret: string, label: string, issuer: string): string {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Return a human-readable enrollment block for the terminal.
 * A full QR renderer requires Reed-Solomon and mask logic (~400 lines).
 * Instead, the URI is printed prominently so the operator can paste it into
 * any authenticator app that accepts manual entry or URI import.
 */
export function asciiQr(text: string): string {
  const border = '─'.repeat(Math.min(text.length + 4, 72));
  return [
    border,
    `  ${text}`,
    border,
    '',
    'Paste the URI above into your authenticator app (or use its',
    '"Enter key manually" / "Scan QR from clipboard" option), or',
    'generate a QR code from it at a trusted offline tool.',
  ].join('\n');
}
