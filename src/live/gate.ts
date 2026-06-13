import type { LoadedAllowlist } from '../config/load.js';

// ---------------------------------------------------------------------------
// AllowedTarget — branded type constructible ONLY by assertAllowlisted.
// No other module exports the brand constructor; scanner wrappers accept only
// this type, making an off-allowlist scan a compile-time error (§4.1).
// ---------------------------------------------------------------------------

type AllowedTargetBrand = { readonly __allowedTarget: true };

export type AllowedTarget = AllowedTargetBrand & {
  readonly url: string;
  readonly hostname: string;
};

function mintAllowedTarget(url: string, hostname: string): AllowedTarget {
  return { url, hostname } as unknown as AllowedTarget;
}

// ---------------------------------------------------------------------------
// AllowlistViolationError — thrown before any network I/O on any gate failure.
// ---------------------------------------------------------------------------

export class AllowlistViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistViolationError';
  }
}

// ---------------------------------------------------------------------------
// IP-literal detection helpers (§4.2 clause d).
// ---------------------------------------------------------------------------

// Detects dotted-decimal IPv4: e.g. 192.168.1.1, 127.0.0.1
const DOTTED_DECIMAL_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Detects Node-accepted numeric/octal/hex single-integer IPv4 forms.
// new URL('https://2130706433/') parses hostname as '2130706433'.
// new URL('https://0x7f000001/') parses hostname as '0x7f000001'.
// Octal (0177.0.0.1) is not parsed as an integer by new URL — it lands as
// dotted-decimal form and is caught by DOTTED_DECIMAL_IPV4 above.
const NUMERIC_OR_HEX_IPV4 = /^(0x[0-9a-fA-F]+|\d+)$/;

// Detects bracketed IPv6: [::1], [::ffff:127.0.0.1], etc.
// new URL normalises the brackets off for `hostname`, but preserves them in
// `host`. We detect both the bracketed form (from host) and the bare form
// that URL.hostname may expose for well-formed IPv6 addresses.
const BRACKETED_IPV6 = /^\[.*]$/;

// new URL('https://[::1]/').hostname === '[::1]' in Node 20.
// Covers any colon-containing hostname that is not already caught elsewhere.
function isIpLiteral(hostname: string): boolean {
  if (DOTTED_DECIMAL_IPV4.test(hostname)) return true;
  if (NUMERIC_OR_HEX_IPV4.test(hostname)) return true;
  if (BRACKETED_IPV6.test(hostname)) return true;
  // bare IPv6 without brackets — still contains colons (e.g. '::1')
  if (hostname.includes(':')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// assertAllowlisted — the single chokepoint (§4.1).
//
// Allow iff ALL of (§4.2):
//   (a) https scheme
//   (b) hostname exactly matches an enabled allowlist entry
//   (c) default https port (empty or "443")
//   (d) hostname is a DNS name, not an IP literal
//
// Empty allowlist → everything rejected (§4.2 final paragraph).
// Throws AllowlistViolationError before any network I/O.
// ---------------------------------------------------------------------------

export function assertAllowlisted(
  url: string,
  allowlist: LoadedAllowlist,
): AllowedTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AllowlistViolationError(`Invalid URL: ${url}`);
  }

  // (a) https scheme only
  if (parsed.protocol !== 'https:') {
    throw new AllowlistViolationError(
      `Non-https scheme rejected: ${parsed.protocol} — live scanning requires https (§4.2)`,
    );
  }

  const hostname = parsed.hostname;

  // (d) DNS name, not IP literal — checked before the allowlist lookup so a
  // numeric/octal/hex IP cannot slip through string comparison (§4.2 clause d).
  if (isIpLiteral(hostname)) {
    throw new AllowlistViolationError(
      `IP-literal hostname rejected: "${hostname}" — use a DNS name (§4.2)`,
    );
  }

  // (c) default https port — port is empty string or "443"
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new AllowlistViolationError(
      `Non-default port rejected: ${parsed.port} — only the default https port (443) is allowed in v1 (§4.2)`,
    );
  }

  // (b) exact enabled-entry hostname match
  const matched = allowlist.hosts.some((entry) => entry.host === hostname);
  if (!matched) {
    throw new AllowlistViolationError(
      `Host "${hostname}" is not on the allowlist — add it to config/allowed-staging-hosts.json via PR (§4.2)`,
    );
  }

  return mintAllowedTarget(url, hostname);
}
