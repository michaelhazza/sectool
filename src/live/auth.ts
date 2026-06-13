import type { AllowedTarget } from './gate.js';
import type { AuthForm } from '../schemas/targets.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A successfully established authenticated session. */
export interface Session {
  readonly kind: 'session';
  /** The user this session was established for (env-var name, not value). */
  readonly userEnv: string;
  /** For sessionCarrier:'bearer' — the bearer token (redacted at call sites). */
  readonly bearerToken?: string | undefined;
  /** For sessionCarrier:'cookie' — the raw Set-Cookie header value (redacted at call sites). */
  readonly cookieHeader?: string | undefined;
  /** The carrier that was used. */
  readonly carrier: 'cookie' | 'bearer';
}

/** A failed login or missing-creds outcome. */
export interface LoginFailure {
  readonly kind: 'failure';
  readonly reason: LoginFailureReason;
  /** Human-readable description for meta.failures / coverage-gap. */
  readonly message: string;
}

export type LoginFailureReason =
  | 'missing-creds'
  | 'login-error'
  | 'carrier-mismatch';

/** What establishSession returns. */
export type AuthResult = Session | LoginFailure;

/**
 * Marker returned by loginForTarget when activeScan is false and login fails.
 * Callers record the coverageGap and proceed unauthenticated.
 */
export interface UnauthenticatedWithGap {
  readonly kind: 'unauthenticated';
  readonly coverageGap: string;
}

/** The full result of loginForTarget. */
export type LoginResult = Session | LoginFailure | UnauthenticatedWithGap;

// ---------------------------------------------------------------------------
// Injectable HTTP client
// ---------------------------------------------------------------------------

export interface HttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | undefined;
}

export interface HttpResponse {
  readonly status: number;
  /** Parsed as a plain object when Content-Type includes 'json'. */
  readonly body: unknown;
  /** Raw response headers (lower-cased names). */
  readonly headers: Record<string, string>;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an env-var name to its runtime value.
 * Returns undefined (not the name) when the variable is unset.
 * Never throws.
 */
function resolveEnv(name: string): string | undefined {
  // process.env may have noUncheckedIndexedAccess — explicit undefined check.
  const val: string | undefined = process.env[name];
  return val;
}

/**
 * Scan a login GET response for a CSRF token.
 * Looks for a <meta name="csrf-token"> or <input name="_csrf"> / <input name="csrf_token">
 * style token. Returns undefined when nothing is found.
 */
function extractCsrfToken(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  // <meta name="csrf-token" content="...">
  const metaMatch = /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i.exec(body);
  if (metaMatch?.[1]) return metaMatch[1];
  // <input ... name="_csrf" ... value="..."> or name="csrf_token"
  const inputMatch = /<input[^>]+name=["'](_csrf|csrf_token|_token|csrfmiddlewaretoken)["'][^>]+value=["']([^"']+)["']/i.exec(body);
  if (inputMatch?.[2]) return inputMatch[2];
  // reverse attribute order: value before name
  const inputMatch2 = /<input[^>]+value=["']([^"']+)["'][^>]+name=["'](_csrf|csrf_token|_token|csrfmiddlewaretoken)["']/i.exec(body);
  if (inputMatch2?.[1]) return inputMatch2[1];
  return undefined;
}

/**
 * Extract the Set-Cookie header value from a response.
 * Returns undefined when none is present.
 */
function extractCookieHeader(headers: Record<string, string>): string | undefined {
  return headers['set-cookie'];
}

/**
 * Extract a bearer token from the response body using the jsonHasKey field name.
 * The response body must be a plain object; the key's value must be a non-empty string.
 */
function extractBearerToken(body: unknown, jsonHasKey: string): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const obj = body as Record<string, unknown>;
  const val: unknown = obj[jsonHasKey];
  if (typeof val === 'string' && val.length > 0) return val;
  return undefined;
}

// ---------------------------------------------------------------------------
// Carrier-aware success evaluation (§6.2)
// ---------------------------------------------------------------------------

type EvalSuccess = { ok: true; carrier: 'bearer'; token: string } | { ok: true; carrier: 'cookie'; cookie: string };
type EvalResult = EvalSuccess | (LoginFailure & { ok: false });

/**
 * Evaluate whether a login response counts as a success for the configured
 * sessionCarrier (§6.2 carrier-aware successCheck).
 *
 * bearer: status ∈ statusIn AND extractable token at jsonHasKey.
 *         Set-Cookie alone does NOT satisfy success.
 * cookie: status ∈ statusIn AND usable Set-Cookie header.
 *         JSON token alone does NOT satisfy success.
 *
 * Returns the extracted credential on success, LoginFailure on failure.
 */
function evaluateLoginResponse(auth: AuthForm, response: HttpResponse): EvalResult {
  const { successCheck, sessionCarrier } = auth;

  if (!successCheck.statusIn.includes(response.status)) {
    return {
      ok: false,
      kind: 'failure',
      reason: 'login-error',
      message: `Login returned HTTP ${response.status}; expected one of ${successCheck.statusIn.join(', ')}`,
    };
  }

  if (sessionCarrier === 'bearer') {
    if (!successCheck.jsonHasKey) {
      // Schema ensures this is set for bearer, but guard defensively.
      return {
        ok: false,
        kind: 'failure',
        reason: 'carrier-mismatch',
        message: 'sessionCarrier is "bearer" but successCheck.jsonHasKey is missing',
      };
    }
    const token = extractBearerToken(response.body, successCheck.jsonHasKey);
    if (!token) {
      return {
        ok: false,
        kind: 'failure',
        reason: 'carrier-mismatch',
        message:
          `sessionCarrier is "bearer" but response body did not contain key "${successCheck.jsonHasKey}" ` +
          `with a string value — a Set-Cookie alone does not satisfy bearer success (§6.2)`,
      };
    }
    return { ok: true, carrier: 'bearer', token };
  }

  // sessionCarrier === 'cookie'
  const cookie = extractCookieHeader(response.headers);
  if (!cookie) {
    return {
      ok: false,
      kind: 'failure',
      reason: 'carrier-mismatch',
      message:
        'sessionCarrier is "cookie" but response did not issue a Set-Cookie header ' +
        '— a JSON token alone does not satisfy cookie success (§6.2)',
    };
  }
  return { ok: true, carrier: 'cookie', cookie };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Default real HTTP client using Node's fetch.
 * JSON response bodies are parsed; others are returned as strings.
 */
export async function defaultHttpClient(req: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });

  const rawHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    rawHeaders[name.toLowerCase()] = value;
  });

  const contentType = rawHeaders['content-type'] ?? '';
  let body: unknown;
  if (contentType.includes('json')) {
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
  } else {
    body = await response.text();
  }

  return { status: response.status, body, headers: rawHeaders };
}

/**
 * Attempt to establish an authenticated session for a single test user.
 *
 * Steps:
 * 1. GET loginPath — capture CSRF token if present.
 * 2. POST loginPath with credentials (from env-var names, read at runtime).
 * 3. Carrier-aware success check (§6.2).
 *
 * Credential values are NEVER returned in plain text in logs/persisted artifacts.
 * bearerToken / cookieHeader carry the raw session credential; callers must
 * apply redaction (src/report/redaction.ts) before persisting or logging.
 *
 * The HTTP client is injectable for testing.
 */
export async function establishSession(
  target: AllowedTarget,
  auth: AuthForm,
  userEnv: string,
  passEnv: string,
  httpClient: HttpClient = defaultHttpClient,
): Promise<AuthResult> {
  // Resolve credentials from environment — never log the values.
  const username = resolveEnv(userEnv);
  const password = resolveEnv(passEnv);

  if (!username || !password) {
    return {
      kind: 'failure',
      reason: 'missing-creds',
      message:
        `Missing credentials: env vars ${userEnv} / ` +
        `${passEnv} are not set (target: ${target.hostname})`,
    };
  }

  const baseUrl = target.url.replace(/\/$/, '');
  const loginUrl = `${baseUrl}${auth.loginPath}`;

  // Step 1: GET loginPath to capture a CSRF token (best-effort).
  let csrfToken: string | undefined;
  try {
    const getResponse = await httpClient({
      url: loginUrl,
      method: 'GET',
      headers: { 'User-Agent': 'BreakoutSolutions-audit-tool/1 (+security@breakoutsolutions.com)' },
    });
    csrfToken = extractCsrfToken(getResponse.body);
  } catch {
    // CSRF pre-fetch failure is non-fatal; proceed without token.
  }

  // Step 2: Build and POST the login request.
  const credentialFields: Record<string, string> = {
    [auth.userField]: username,
    [auth.passField]: password,
  };
  if (csrfToken) {
    credentialFields['_csrf'] = csrfToken;
  }

  let loginBody: string;
  let contentType: string;

  if (auth.bodyType === 'json') {
    loginBody = JSON.stringify(credentialFields);
    contentType = 'application/json';
  } else {
    loginBody = new URLSearchParams(credentialFields).toString();
    contentType = 'application/x-www-form-urlencoded';
  }

  let loginResponse: HttpResponse;
  try {
    loginResponse = await httpClient({
      url: loginUrl,
      method: auth.method,
      headers: {
        'Content-Type': contentType,
        'User-Agent': 'BreakoutSolutions-audit-tool/1 (+security@breakoutsolutions.com)',
      },
      body: loginBody,
    });
  } catch (err) {
    return {
      kind: 'failure',
      reason: 'login-error',
      message: `Login request to ${loginUrl} failed: ${String(err)}`,
    };
  }

  // Step 3: Carrier-aware success evaluation.
  const evalResult = evaluateLoginResponse(auth, loginResponse);
  if (!evalResult.ok) {
    return { kind: evalResult.kind, reason: evalResult.reason, message: evalResult.message };
  }

  if (evalResult.carrier === 'bearer') {
    return {
      kind: 'session',
      userEnv,
      bearerToken: evalResult.token,
      carrier: 'bearer',
    };
  }

  return {
    kind: 'session',
    userEnv,
    cookieHeader: evalResult.cookie,
    carrier: 'cookie',
  };
}

/**
 * Establish a session for a target, applying the §6.2 failure policy.
 *
 * activeScan:true  + missing creds or login failure → LoginFailure
 *   (caller marks meta.failures; run is partial/failed — never silent downgrade)
 * activeScan:false + missing creds or login failure → UnauthenticatedWithGap
 *   (caller records coverageGap; scan continues unauthenticated)
 *
 * When auth is not configured: UnauthenticatedWithGap with a gap message.
 *
 * Selects the first testUser from authConfig.testUsers.
 */
export async function loginForTarget(
  target: AllowedTarget,
  auth: AuthForm | undefined,
  activeScan: boolean,
  httpClient: HttpClient = defaultHttpClient,
): Promise<LoginResult> {
  if (!auth) {
    const gap = `No auth configured for ${target.hostname} — scan will run unauthenticated`;
    if (activeScan) {
      return {
        kind: 'failure',
        reason: 'missing-creds',
        message: gap,
      };
    }
    return { kind: 'unauthenticated', coverageGap: gap };
  }

  const firstUser = auth.testUsers[0];
  if (!firstUser) {
    const msg = `No testUsers configured for ${target.hostname}`;
    if (activeScan) {
      return { kind: 'failure', reason: 'missing-creds', message: msg };
    }
    return { kind: 'unauthenticated', coverageGap: msg };
  }

  const result = await establishSession(
    target,
    auth,
    firstUser.userEnv,
    firstUser.passEnv,
    httpClient,
  );

  if (result.kind === 'failure') {
    if (activeScan) {
      return result;
    }
    return {
      kind: 'unauthenticated',
      coverageGap: `Auth failed for ${target.hostname}: ${result.message} — scan will run unauthenticated`,
    };
  }

  return result;
}
