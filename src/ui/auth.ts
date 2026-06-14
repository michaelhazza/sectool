/**
 * src/ui/auth.ts — Basic Auth middleware (env-gated, production fail-closed).
 *
 * Pure decision functions. HTTP response writing (401 + WWW-Authenticate)
 * stays in the route adapter (server.ts).
 */

import { timingSafeEqual } from 'node:crypto';
import type { ResolvedEnv } from './env.js';

/**
 * True when Basic Auth is active:
 * - explicitly configured (both USER and PASS set), OR
 * - running in production (fail-closed: auth is required even if secrets
 *   are missing — assertProductionConfig will have already thrown at startup).
 */
export function isAuthEnabled(resolvedEnv: ResolvedEnv): boolean {
  const { authUser, authPass, isProduction } = resolvedEnv;
  return (authUser !== undefined && authPass !== undefined) || isProduction;
}

/**
 * Decide whether an HTTP request should be allowed past the Basic Auth gate.
 *
 * @param parsedHeader - The value of the Authorization header, or undefined
 *   if the header is absent.
 * @param resolvedEnv - Resolved environment (contains authUser/authPass).
 * @returns 'pass' if the request is authenticated or auth is disabled;
 *          'reject' otherwise.
 *
 * Uses crypto.timingSafeEqual to prevent timing-based credential enumeration.
 * Buffers are padded to equal length so the comparison is always constant-time
 * even when lengths differ.
 */
export function basicAuthGate(
  parsedHeader: string | undefined,
  resolvedEnv: ResolvedEnv,
): 'pass' | 'reject' {
  if (!isAuthEnabled(resolvedEnv)) {
    return 'pass';
  }

  const { authUser, authPass } = resolvedEnv;
  if (authUser === undefined || authPass === undefined) {
    // Production with missing secrets — assertProductionConfig would have
    // thrown at startup, but be safe: reject all requests.
    return 'reject';
  }

  if (parsedHeader === undefined) {
    return 'reject';
  }

  // Expected header value: "Basic <base64(user:pass)>"
  const expected = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`;

  // Pad both buffers to the same length before timingSafeEqual.
  const aBytes = Buffer.from(parsedHeader, 'utf8');
  const bBytes = Buffer.from(expected, 'utf8');
  const maxLen = Math.max(aBytes.byteLength, bBytes.byteLength);
  const a = Buffer.alloc(maxLen);
  const b = Buffer.alloc(maxLen);
  aBytes.copy(a);
  bBytes.copy(b);

  const match = timingSafeEqual(a, b);
  return match ? 'pass' : 'reject';
}
