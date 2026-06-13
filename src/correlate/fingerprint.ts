import { createHash } from 'node:crypto';

// UUID v4 pattern: 8-4-4-4-12 hex groups
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize a file path to posix, repo-relative form.
 * Strips a leading repo root prefix if present and converts backslashes.
 * e.g. "src\\db\\schema.ts" → "src/db/schema.ts"
 */
export function normalizePath(p: string): string {
  // Convert Windows separators to posix
  let out = p.replace(/\\/g, '/');
  // Strip leading slash or ./ prefix so result is always relative
  out = out.replace(/^\.\//, '');
  out = out.replace(/^\//, '');
  return out;
}

/**
 * Normalize a symbol to a stable identifier:
 * - Route signature: "GET /api/users/:id" → kept as-is (already stable)
 * - Enclosing function/class name: kept as-is
 * - pgTable name for schema-level rules (BS-RLS-001, BS-SQL-002): the literal
 *   table name extracted from pgTable('<name>', …) — caller passes just the
 *   name string; we lowercase and trim it for stability.
 */
export function normalizeSymbol(sym: string): string {
  return sym.trim().toLowerCase();
}

/**
 * Normalize a code snippet for stable fingerprinting:
 * collapses all whitespace (spaces, tabs, newlines) into a single space
 * and trims leading/trailing whitespace.
 * Line numbers are excluded by design — this operates on the text only.
 */
export function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a URL path for stable fingerprinting.
 * Replaces numeric and UUID path segments with "{id}" so volatile record ids
 * don't fork fingerprints.
 * e.g. "/api/users/42/posts" → "/api/users/{id}/posts"
 *      "/api/items/3f9a1c2b-8d4e-0a17-beef-deadbeef0000/detail" → "/api/items/{id}/detail"
 */
export function normalizeUrlPath(urlPath: string): string {
  return urlPath
    .split('/')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return '{id}';
      if (UUID_RE.test(segment)) return '{id}';
      return segment;
    })
    .join('/');
}

export interface StaticFingerprintInput {
  readonly kind: 'static';
  readonly ruleId: string;
  readonly targetName: string;
  readonly path: string;
  readonly symbol: string;
  readonly snippet: string;
}

export interface LiveFingerprintInput {
  readonly kind: 'live';
  readonly checkId: string;
  readonly host: string;
  readonly urlPath: string;
  readonly parameter: string;
  readonly evidenceClass: string;
}

export type FingerprintInput = StaticFingerprintInput | LiveFingerprintInput;

function buildPreimage(input: FingerprintInput): string {
  if (input.kind === 'static') {
    return [
      input.ruleId,
      input.targetName,
      normalizePath(input.path),
      normalizeSymbol(input.symbol),
      normalizeSnippet(input.snippet),
    ].join('|');
  }
  return [
    input.checkId,
    input.host,
    normalizeUrlPath(input.urlPath),
    input.parameter,
    input.evidenceClass,
  ].join('|');
}

/**
 * Compute the stable 64-hex sha256 fingerprint for a finding.
 * Line numbers and request ordering are excluded by design (§6.6).
 */
export function fingerprint(input: FingerprintInput): string {
  const preimage = buildPreimage(input);
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Derive the display id from a full 64-hex fingerprint.
 * Returns "f-" + first 16 hex characters.
 */
export function displayId(fp: string): string {
  return `f-${fp.slice(0, 16)}`;
}
