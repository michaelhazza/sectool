import type { Finding } from '../schemas/finding.js';
import type { TargetRegistry } from '../schemas/targets.js';
import { normalizeUrlPath } from './fingerprint.js';
import { computeSeverity } from './severity.js';

/**
 * Normalize an Express-style route pattern to the {id} form used by
 * normalizeUrlPath (§9 path-param-aware comparison).
 * e.g. "/api/users/:id/posts/:postId" → "/api/users/{id}/posts/{id}"
 */
function normalizeRoutePattern(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '{id}' : segment))
    .join('/');
}

/**
 * Parse a static route-symbol like "GET /api/users/:id" into method + path.
 * Returns null when the symbol does not look like a route signature.
 */
function parseRouteSymbol(symbol: string): { method: string; path: string } | null {
  const match = /^([A-Z]+)\s+(\/\S*)$/.exec(symbol.trim());
  if (!match) return null;
  // match[1] and match[2] are guaranteed by the regex capture groups
  return { method: match[1] as string, path: match[2] as string };
}

/**
 * Return true when a static finding's symbol route sig matches the live
 * finding's normalizedUrlPath + method (§9 criterion 3, path-param-aware).
 */
function locationMatches(staticSymbol: string, liveUrl: string, liveMethod: string): boolean {
  const route = parseRouteSymbol(staticSymbol);
  if (!route) return false;

  // Normalize the static route pattern (`:param` → `{id}`)
  const normalizedStatic = normalizeRoutePattern(route.path);

  // Extract the path portion from the full live URL (live location stores the full URL)
  let livePath: string;
  try {
    livePath = new URL(liveUrl).pathname;
  } catch {
    livePath = liveUrl;
  }

  // Normalize the live URL path (numeric/UUID segments → `{id}`)
  const normalizedLive = normalizeUrlPath(livePath);

  return route.method.toUpperCase() === liveMethod.toUpperCase() && normalizedStatic === normalizedLive;
}

/**
 * Build a lookup from staging host → linked repo name from the registry.
 * Used to check §9 criterion 1 (stagingTargets[].repo ↔ repo name).
 */
function buildHostToRepo(registry: TargetRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of registry.stagingTargets) {
    try {
      const url = new URL(st.url);
      map.set(url.hostname, st.repo);
    } catch {
      // malformed url — skip (config-load validates earlier)
    }
  }
  return map;
}

/**
 * Correlate static findings with live findings per §9.
 *
 * Two findings correlate when ALL of:
 *   1. Targets are linked (stagingTargets[].repo ↔ repo name via registry).
 *   2. Same vulnClass.
 *   3. Location match: static symbol route sig ≈ live normalizedUrlPath + method.
 *
 * On a match:
 *   - The live finding's id is appended to the static finding's correlatedWith.
 *   - The static finding's id is appended to the live finding's correlatedWith.
 *   - The static finding's severity is recomputed with liveConfirmed: true.
 *
 * Deterministic dedupe: findings are sorted by full fingerprint before
 * processing so run order cannot change output (§9, §6.6).
 *
 * Pure function — returns a new array; input array and findings are not mutated.
 */
export function correlate(findings: Finding[], registry: TargetRegistry): Finding[] {
  const hostToRepo = buildHostToRepo(registry);

  // Sort by full fingerprint for deterministic processing (§9)
  const sorted = [...findings].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  const statics = sorted.filter((f): f is Finding & { surface: 'static' } => f.surface === 'static');
  const lives = sorted.filter((f): f is Finding & { surface: 'live' } => f.surface === 'live');

  // Build mutable maps keyed by fingerprint so we can update correlatedWith
  const byFingerprint = new Map<string, Finding>(sorted.map((f) => [f.fingerprint, f]));

  for (const sf of statics) {
    for (const lf of lives) {
      // §9 criterion 1: targets linked via registry
      const linkedRepo = hostToRepo.get(lf.target.host);
      if (linkedRepo !== sf.target.name) continue;

      // §9 criterion 2: same vulnClass
      if (sf.vulnClass !== lf.vulnClass) continue;

      // §9 criterion 3: location match (path-param-aware)
      if (!locationMatches(sf.location.symbol, lf.location.url, lf.location.method)) continue;

      // Already correlated — skip dedupe (fingerprint sort ensures first pairing wins)
      const existingStatic = byFingerprint.get(sf.fingerprint);
      const existingLive = byFingerprint.get(lf.fingerprint);
      if (!existingStatic || !existingLive) continue;
      if (existingStatic.correlatedWith.includes(lf.id)) continue;

      // Recompute severity for the static finding with liveConfirmed: true (§8.1)
      const { severity, confidence } = computeSeverity(
        {
          baseSeverity: existingStatic.baseSeverity,
          reachability: existingStatic.reachability,
          vulnClass: existingStatic.vulnClass,
          confidence: existingStatic.confidence,
        },
        { liveConfirmed: true },
      );

      // Update static finding: append live id to correlatedWith, recompute severity
      byFingerprint.set(sf.fingerprint, {
        ...existingStatic,
        correlatedWith: [...existingStatic.correlatedWith, lf.id],
        severity,
        confidence,
      });

      // Update live finding: append static id to correlatedWith
      byFingerprint.set(lf.fingerprint, {
        ...existingLive,
        correlatedWith: [...existingLive.correlatedWith, sf.id],
      });
    }
  }

  // Return in the same fingerprint-sorted order
  return sorted.map((f) => byFingerprint.get(f.fingerprint) ?? f);
}
