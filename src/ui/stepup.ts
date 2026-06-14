import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyTotp } from './totp.js';
import type { ResolvedEnv } from './env.js';

// ---------------------------------------------------------------------------
// Cookie claim types
// ---------------------------------------------------------------------------

export interface StepUpClaims {
  principalHash: string;
  csrfNonce: string;
  scope: 'config-write';
  exp: number;
}

// ---------------------------------------------------------------------------
// HMAC cookie sign / verify
// ---------------------------------------------------------------------------

/** Encode a buffer or string as base64url (no padding). */
function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/** Canonical claim string: JSON with keys sorted deterministically. */
function canonicalClaims(claims: StepUpClaims): string {
  return JSON.stringify({
    csrfNonce: claims.csrfNonce,
    exp: claims.exp,
    principalHash: claims.principalHash,
    scope: claims.scope,
  });
}

/**
 * Sign claims into a cookie value: base64url(claims) + '.' + base64url(hmac).
 * The HMAC is SHA-256 over the canonical claim string using the provided secret.
 * MUST be called with AUDIT_STEPUP_SIGNING_SECRET — never AUDIT_TOTP_SECRET.
 */
export function signStepUpCookie(claims: StepUpClaims, secret: string): string {
  const canonical = canonicalClaims(claims);
  const claimsPart = toBase64Url(canonical);
  const sig = createHmac('sha256', secret).update(claimsPart).digest();
  const sigPart = toBase64Url(sig);
  return `${claimsPart}.${sigPart}`;
}

/**
 * Verify a cookie value and return the claims if valid, or null if invalid/expired/tampered.
 * Checks: signature valid, scope === 'config-write', now < exp.
 */
export function verifyStepUpCookie(value: string, secret: string, now: number): StepUpClaims | null {
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;

  const claimsPart = value.slice(0, dot);
  const sigPart = value.slice(dot + 1);

  // Verify HMAC
  const expectedSig = createHmac('sha256', secret).update(claimsPart).digest();
  const expectedSigPart = toBase64Url(expectedSig);

  // Constant-time comparison of the base64url sig strings
  let sigMatch = false;
  try {
    const a = Buffer.from(sigPart, 'utf8');
    const b = Buffer.from(expectedSigPart, 'utf8');
    sigMatch = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return null;
  }
  if (!sigMatch) return null;

  // Decode and parse claims
  let claims: unknown;
  try {
    const claimsJson = fromBase64Url(claimsPart).toString('utf8');
    claims = JSON.parse(claimsJson);
  } catch {
    return null;
  }

  if (
    typeof claims !== 'object' ||
    claims === null ||
    typeof (claims as Record<string, unknown>)['principalHash'] !== 'string' ||
    typeof (claims as Record<string, unknown>)['csrfNonce'] !== 'string' ||
    (claims as Record<string, unknown>)['scope'] !== 'config-write' ||
    typeof (claims as Record<string, unknown>)['exp'] !== 'number'
  ) {
    return null;
  }

  const c = claims as StepUpClaims;

  // TTL check
  if (now >= c.exp) return null;

  return c;
}

// ---------------------------------------------------------------------------
// Principal hash
// ---------------------------------------------------------------------------

/** SHA-256 of the Basic Auth principal (username:password decoded from the Authorization header). */
export function hashPrincipal(principal: string): string {
  return createHash('sha256').update(principal, 'utf8').digest('hex');
}

/** Extract the raw Basic Auth credential string from an Authorization header value, or null. */
function extractBasicCredential(authHeader: string | string[] | undefined): string | null {
  if (typeof authHeader !== 'string') return null;
  if (!authHeader.startsWith('Basic ')) return null;
  const encoded = authHeader.slice('Basic '.length);
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Parse the audit_stepup cookie value from a Cookie header string. */
function parseStepUpCookie(cookieHeader: string | string[] | undefined): string | null {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('audit_stepup=')) {
      return trimmed.slice('audit_stepup='.length);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// requireStepUp guard
// ---------------------------------------------------------------------------

export interface RequireStepUpOpts {
  signingSecret: string;
  csrfNonce: string;
  principalHash: string;
  now?: number;
}

/**
 * Verify that the request carries a valid step-up cookie.
 * Returns 'ok' if all of these hold:
 *   - cookie present, signature valid, scope === 'config-write', not expired
 *   - cookie csrfNonce === csrfNonce param (request's X-Audit-CSRF)
 *   - cookie principalHash === principalHash param (current principal)
 * Otherwise returns 'forbidden'.
 */
export function requireStepUp(
  req: IncomingMessage,
  opts: RequireStepUpOpts,
): 'ok' | 'forbidden' {
  const { signingSecret, csrfNonce, principalHash, now = Date.now() } = opts;

  const cookieValue = parseStepUpCookie(req.headers['cookie']);
  if (cookieValue === null) return 'forbidden';

  const claims = verifyStepUpCookie(cookieValue, signingSecret, now);
  if (claims === null) return 'forbidden';

  if (claims.csrfNonce !== csrfNonce) return 'forbidden';
  if (claims.principalHash !== principalHash) return 'forbidden';

  return 'ok';
}

// ---------------------------------------------------------------------------
// handleStepUpExchange — POST /api/config/step-up
// ---------------------------------------------------------------------------

const STEP_UP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Brute-force throttle for the TOTP exchange (adversarial 5-A).
// In-memory, process-global (single shared credential, single process). After
// MAX_FAILURES consecutive bad codes, lock the exchange for a backoff window
// that grows with repeated lockouts. A correct code resets the counter.
// ---------------------------------------------------------------------------

const STEP_UP_MAX_FAILURES = 5;
const STEP_UP_BASE_LOCK_MS = 60_000; // 1 min, doubled per additional lockout (capped)
const STEP_UP_MAX_LOCK_MS = 15 * 60 * 1000;

interface StepUpThrottleState { failures: number; lockUntil: number; lockouts: number; }
const stepUpThrottle: StepUpThrottleState = { failures: 0, lockUntil: 0, lockouts: 0 };

export function isStepUpLockedOut(nowMs: number): boolean {
  return nowMs < stepUpThrottle.lockUntil;
}
export function stepUpLockRemainingMs(nowMs: number): number {
  return Math.max(0, stepUpThrottle.lockUntil - nowMs);
}
export function recordStepUpFailure(nowMs: number): void {
  stepUpThrottle.failures += 1;
  if (stepUpThrottle.failures >= STEP_UP_MAX_FAILURES) {
    const lockMs = Math.min(STEP_UP_BASE_LOCK_MS * 2 ** stepUpThrottle.lockouts, STEP_UP_MAX_LOCK_MS);
    stepUpThrottle.lockUntil = nowMs + lockMs;
    stepUpThrottle.lockouts += 1;
    stepUpThrottle.failures = 0;
  }
}
export function resetStepUpThrottle(): void {
  stepUpThrottle.failures = 0;
  stepUpThrottle.lockUntil = 0;
  stepUpThrottle.lockouts = 0;
}

/**
 * Exchange handler for POST /api/config/step-up.
 *
 * Gate order:
 *   1. Secrets present — fail-closed if AUDIT_STEPUP_SIGNING_SECRET or AUDIT_TOTP_SECRET missing.
 *   2. CSRF nonce + Origin match (reuse pattern from handleFixPost).
 *   3. Read body { code }.
 *   4. Verify TOTP against AUDIT_TOTP_SECRET.
 *   5. Issue step-up cookie.
 */
export async function handleStepUpExchange(
  req: IncomingMessage,
  res: ServerResponse,
  resolvedEnv: ResolvedEnv,
  helpers: {
    csrfNonce: string;
    readBody: (req: IncomingMessage) => Promise<string>;
    jsonResponse: (res: ServerResponse, status: number, body: unknown) => void;
  },
): Promise<void> {
  const { stepupSigningSecret, totpSecret, allowedOrigin } = resolvedEnv;

  // Step 1: fail-closed — secrets must be configured
  if (!stepupSigningSecret || !totpSecret) {
    helpers.jsonResponse(res, 403, { error: 'config editing not configured' });
    return;
  }

  // Step 2: CSRF + Origin (same pattern as handleFixPost)
  const csrfHeader = req.headers['x-audit-csrf'];
  const originHeader = req.headers['origin'];

  if (typeof csrfHeader !== 'string' || csrfHeader !== helpers.csrfNonce) {
    helpers.jsonResponse(res, 403, { error: 'Forbidden: missing or invalid X-Audit-CSRF nonce' });
    return;
  }
  if (typeof originHeader !== 'string' || originHeader !== allowedOrigin) {
    helpers.jsonResponse(res, 403, { error: 'Forbidden: Origin not allowed' });
    return;
  }

  // Step 3: Read body
  let rawBody: string;
  try {
    rawBody = await helpers.readBody(req);
  } catch (bodyErr) {
    const isTooLarge = typeof bodyErr === 'object' && bodyErr !== null && (bodyErr as { tooLarge?: boolean }).tooLarge === true;
    if (isTooLarge) {
      helpers.jsonResponse(res, 413, { error: 'Request body too large' });
    } else {
      helpers.jsonResponse(res, 400, { error: 'Bad request: could not read body' });
    }
    return;
  }

  let code: string;
  try {
    const parsed = JSON.parse(rawBody) as { code?: unknown };
    if (typeof parsed.code !== 'string' || parsed.code.length === 0) {
      helpers.jsonResponse(res, 400, { error: 'Bad request: code required' });
      return;
    }
    code = parsed.code;
  } catch {
    helpers.jsonResponse(res, 400, { error: 'Bad request: invalid JSON' });
    return;
  }

  // Step 3.5: brute-force throttle (adversarial 5-A). The 6-digit TOTP space is
  // online-guessable by a holder of the (possibly leaked) dashboard password if
  // unthrottled. Lock the exchange after too many failures in the window.
  const nowMs = Date.now();
  if (isStepUpLockedOut(nowMs)) {
    res.setHeader('Retry-After', String(Math.ceil(stepUpLockRemainingMs(nowMs) / 1000)));
    helpers.jsonResponse(res, 429, { error: 'Too many attempts — try again later.' });
    return;
  }

  // Step 4: Verify TOTP against AUDIT_TOTP_SECRET (never the signing secret)
  if (!verifyTotp(totpSecret, code)) {
    recordStepUpFailure(nowMs);
    helpers.jsonResponse(res, 403, { error: 'invalid code' });
    return;
  }
  resetStepUpThrottle();

  // Step 5: Extract principal from Basic Auth and derive principal hash
  const credential = extractBasicCredential(req.headers['authorization']);
  const principalHash = hashPrincipal(credential ?? '');

  const now = Date.now();
  const claims: StepUpClaims = {
    principalHash,
    csrfNonce: helpers.csrfNonce,
    scope: 'config-write',
    exp: now + STEP_UP_TTL_MS,
  };

  const cookieValue = signStepUpCookie(claims, stepupSigningSecret);
  const cookieStr = `audit_stepup=${cookieValue}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300`;

  res.setHeader('Set-Cookie', cookieStr);
  helpers.jsonResponse(res, 200, { ok: true });
}
