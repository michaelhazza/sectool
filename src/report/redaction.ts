import { createHash } from 'node:crypto';

// Fixed salt prevents pre-image attacks on the redaction placeholder without
// requiring a per-run secret. The placeholder is correlation-stable (same
// secret → same 8hex across artifacts) but does not reveal the raw value.
const REDACTION_SALT = 'audit-tool-redact-v1';

// Credential-bearing HTTP header names (case-insensitive match applied at call site)
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'set-cookie',
  'cookie',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
]);

// Pattern: Bearer / Basic / token scheme at the start of a header value
const BEARER_RE = /^(Bearer|Basic|Token)\s+\S+/i;

// Pattern: Authorization header full value (any scheme + credential)
const AUTH_VALUE_RE = /^[A-Za-z0-9+/._-]+\s+\S+/;

// Pattern: key=value pairs in Set-Cookie / Cookie header values
// Matches the value portion of cookie key=value pairs
const COOKIE_VALUE_RE = /^([^=]+)=([^;,\s]+)/;

/**
 * Derive a stable 8-hex placeholder digest for a known credential string.
 * The salt prevents the raw value from being recoverable via pre-image.
 * The same input always produces the same 8 hex chars (correlation-stable).
 */
function saltedDigest(value: string): string {
  return createHash('sha256')
    .update(REDACTION_SALT, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

function makePlaceholder(value: string): string {
  return `[redacted:${saltedDigest(value)}]`;
}

/**
 * Redact a string that is known to be a raw credential value
 * (e.g. the secret portion extracted from a gitleaks finding, a raw bearer
 * token, or a cookie value). The full string is treated as the secret.
 *
 * Returns the stable `[redacted:<8hex>]` placeholder.
 * Never throws — fail-safe (§5.4).
 */
export function redactString(value: string): string {
  if (!value) return value;
  return makePlaceholder(value);
}

/**
 * Redact a single HTTP header value given its name and raw value.
 * - Authorization / Proxy-Authorization: replace the credential part after the scheme
 * - Set-Cookie / Cookie: replace each value portion of key=value pairs
 * - Unknown credential header name: replace the full value
 *
 * Returns the string with credential material replaced by `[redacted:<8hex>]`.
 * Never throws.
 */
function redactHeaderValue(headerName: string, headerValue: string): string {
  if (!headerValue) return headerValue;
  const nameLower = headerName.toLowerCase();

  if (nameLower === 'authorization' || nameLower === 'proxy-authorization') {
    // "Bearer <token>" | "Basic <credentials>" | "Token <token>" | "<scheme> <credential>"
    if (BEARER_RE.test(headerValue)) {
      const spaceIdx = headerValue.indexOf(' ');
      if (spaceIdx !== -1) {
        const scheme = headerValue.slice(0, spaceIdx);
        const credential = headerValue.slice(spaceIdx + 1);
        return `${scheme} ${makePlaceholder(credential)}`;
      }
    }
    if (AUTH_VALUE_RE.test(headerValue)) {
      const spaceIdx = headerValue.indexOf(' ');
      if (spaceIdx !== -1) {
        const scheme = headerValue.slice(0, spaceIdx);
        const credential = headerValue.slice(spaceIdx + 1);
        return `${scheme} ${makePlaceholder(credential)}`;
      }
    }
    // No recognizable scheme — redact the entire value
    return makePlaceholder(headerValue);
  }

  if (nameLower === 'set-cookie' || nameLower === 'cookie') {
    // Redact the value portion of each key=value token.
    // Set-Cookie: name=value; Path=/; HttpOnly
    // Cookie: name1=val1; name2=val2
    return headerValue.replace(COOKIE_VALUE_RE, (_match, cookieName: string, cookieVal: string) => {
      return `${cookieName}=${makePlaceholder(cookieVal)}`;
    });
  }

  // Fallback for any other credential header
  return makePlaceholder(headerValue);
}

/**
 * Test if an object key looks like a credential-bearing HTTP header or a
 * gitleaks / scanner "secret" field name.
 */
function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_HEADER_NAMES.has(lower)) return true;
  // Gitleaks Finding fields that carry the raw secret
  if (lower === 'secret' || lower === 'match' || lower === 'rawvalue') return true;
  // Env-derived staging credential keys (registry testUsers env values resolved at scan time)
  if (lower === 'password' || lower === 'pass' || lower === 'passwd') return true;
  if (lower === 'token' || lower === 'accesstoken' || lower === 'refreshtoken') return true;
  if (lower === 'apikey' || lower === 'api_key') return true;
  return false;
}

/**
 * Determine whether a header-name key should use the header-value-aware
 * redaction path (preserving scheme, cookie name etc.) rather than a full
 * redactString call.
 */
function isHttpHeaderKey(key: string): boolean {
  return CREDENTIAL_HEADER_NAMES.has(key.toLowerCase());
}

/**
 * Recursively redact credential material from a plain JS value (string,
 * object, array, or primitive). Objects are walked depth-first; keys
 * recognised as credential-bearing have their string values replaced.
 * Non-credential string values and non-string primitives are passed through.
 *
 * Rules (fail-safe — when unsure, redact):
 * - A string value of a key in `isCredentialKey` → redacted (header-aware or full)
 * - A top-level string passed directly → treated as a raw credential value (redactString)
 * - Arrays and objects → recursed; key names drive the credential decision
 * - null / number / boolean → unchanged
 *
 * Never throws.
 */
export function redact(value: unknown, parentKey?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (parentKey !== undefined && isCredentialKey(parentKey)) {
      if (isHttpHeaderKey(parentKey)) {
        return redactHeaderValue(parentKey, value);
      }
      return makePlaceholder(value);
    }
    // String at the root call (no parentKey) — treat as raw credential
    if (parentKey === undefined) {
      return makePlaceholder(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redact(item, parentKey));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }

  return value;
}
