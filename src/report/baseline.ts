import type { Finding } from '../schemas/finding.js';
import type { Baseline, BaselineEntry } from '../schemas/baseline.js';

/**
 * Returns the location key for a finding, used to match against
 * a baseline entry's optional `locationKey` field.
 * Static findings: the location symbol.
 * Live findings: the normalizedUrlPath (extracted from the url).
 */
function findingLocationKey(finding: Finding): string | undefined {
  if (finding.surface === 'static') {
    return finding.location.symbol;
  }
  // Live finding: use the pathname of the url as the location key
  try {
    return new URL(finding.location.url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Returns true if the baseline entry's target matches the finding's target.
 * Repo targets: kind and name must match.
 * Staging targets: kind and host must match.
 */
function targetMatches(entry: BaselineEntry, finding: Finding): boolean {
  const ft = finding.target;
  const et = entry.target;
  if (et.kind !== ft.kind) return false;
  if (et.kind === 'repo' && ft.kind === 'repo') {
    return et.name === ft.name;
  }
  if (et.kind === 'staging' && ft.kind === 'staging') {
    return et.host === ft.host;
  }
  return false;
}

/**
 * Returns true when the baseline entry has expired relative to `now`.
 * Expiry is inclusive: the entry is active through the end of the expiry date.
 */
function isExpired(entry: BaselineEntry, now: Date): boolean {
  // Compare YYYY-MM-DD string against the date portion of `now` (UTC)
  const todayStr = now.toISOString().slice(0, 10);
  return entry.expiry < todayStr;
}

/**
 * Determine whether the baseline entry matches the finding.
 * ALL of these must hold (§6.4):
 *   1. full 64-hex fingerprint
 *   2. ruleId
 *   3. target (kind + name/host)
 *   4. locationKey — when present on the entry, must equal the finding's location key
 */
function entryMatches(entry: BaselineEntry, finding: Finding): boolean {
  if (entry.fingerprint !== finding.fingerprint) return false;
  if (entry.ruleId !== finding.ruleId) return false;
  if (!targetMatches(entry, finding)) return false;
  if (entry.locationKey !== undefined) {
    const fKey = findingLocationKey(finding);
    if (fKey === undefined || entry.locationKey !== fKey) return false;
  }
  return true;
}

/**
 * Apply baseline suppression to a list of findings.
 *
 * For each finding, search the baseline entries for one that matches
 * on ALL scope fields (full fingerprint, ruleId, target, locationKey when present).
 *
 * - Unexpired match: sets `suppressed:true` and copies the entry's
 *   justification/approvedBy/expiry into `suppression`.
 * - Expired match: finding re-alerts at full severity;
 *   `note` is set to `"baseline expired <expiry-date>"`.
 * - No match: finding is returned unchanged.
 *
 * Pure function — does not mutate inputs. Malformed baseline entries are
 * already rejected at config load (P1-2 `loadBaseline`).
 */
export function applyBaseline(
  findings: readonly Finding[],
  baseline: Baseline,
  now: Date,
): Finding[] {
  return findings.map((finding) => {
    // Search for the first matching entry — the match key is the full fingerprint
    const matchedEntry = baseline.entries.find((e) => entryMatches(e, finding));

    if (matchedEntry === undefined) {
      return finding;
    }

    if (isExpired(matchedEntry, now)) {
      return {
        ...finding,
        suppressed: false,
        suppression: null,
        note: `baseline expired ${matchedEntry.expiry}`,
      };
    }

    // Unexpired match: suppress the finding
    return {
      ...finding,
      suppressed: true,
      suppression: {
        justification: matchedEntry.justification,
        approvedBy: matchedEntry.approvedBy,
        expiry: matchedEntry.expiry,
      },
      note: null,
    };
  });
}
