// Shared helpers for rendering findings whose real runtime shape varies between
// static (repo) and live (staging) scans.
//
// The server emits two target shapes:
//   static → { kind: 'repo',    name: string, commit?: string }
//   live   → { kind: 'staging', host: string }
// and two surface markers. Live findings have NO `target.name` and static
// findings have NO `target.host`, so any code that reads one unconditionally
// renders `undefined` (or throws when chained). These helpers normalise both.

import type { Finding, FindingTarget, RunFailure, Surface } from './types.js';

/**
 * Render report.meta.failures (an array of { target, family, reason } objects)
 * as a readable comma-separated string. Naively `.join(', ')`-ing the array
 * produces "[object Object]"; this formats each entry as
 * "<family> on <target>" (falling back to whatever fields are present).
 */
export function formatFailures(failures: RunFailure[] | undefined | null): string {
  if (!failures || failures.length === 0) return '';
  return failures
    .map((f) => {
      const label = f.family ?? f.reason ?? f.target ?? 'unknown check';
      return f.target && f.family ? `${label} on ${f.target}` : label;
    })
    .join(', ');
}

/**
 * Human-readable label for a finding's target, robust to both shapes.
 * Static findings expose `name`; live findings expose `host`. Falls back to an
 * em-dash so the UI never renders the literal string "undefined".
 */
export function targetLabel(target: FindingTarget | undefined | null): string {
  if (!target) return '—';
  return target.name ?? target.host ?? '—';
}

/**
 * Normalise the finding's surface to the UI's two-value Surface vocabulary.
 *
 * The `target.kind` field is the registry kind ('repo' | 'staging'), NOT the
 * surface. A top-level `surface` field ('static' | 'live') is the authoritative
 * source when present; otherwise we map repo→static and staging→live (and treat
 * the legacy 'static'/'live' kind values as already-normalised).
 */
export function findingSurface(finding: Pick<Finding, 'surface' | 'target'>): Surface {
  if (finding.surface === 'static' || finding.surface === 'live') {
    return finding.surface;
  }
  const kind = finding.target?.kind;
  if (kind === 'repo' || kind === 'static') return 'static';
  // 'staging', 'live', or anything unexpected → live (the network-facing surface).
  return 'live';
}
