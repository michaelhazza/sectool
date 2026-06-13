import type { AllowedTarget } from '../gate.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// Exposed endpoint probe — LIVE-EXPOSE-001 (§7.3 passive family)
//
// Probes a curated list of well-known debug/admin/source-map paths and flags
// any that return a non-404 response (200/201/301/302/307/308 are all flagged).
//
// Injectable `ExposureClient` so unit tests never hit the network.
// Each probe path is fetched via the host budget (§4.5).
// Response bodies are redacted via the redaction chokepoint (§5.4).
// ---------------------------------------------------------------------------

/** HTTP probe result for a single path. */
export interface PathProbeResult {
  path: string;
  status: number;
  /** Content-Type of the response, if present */
  contentType?: string;
  /** First 512 bytes of the response body — may carry credential material */
  bodyPreview?: string;
}

export type ExposureClient = (
  target: AllowedTarget,
  path: string,
) => Promise<PathProbeResult>;

// Curated list of paths that should NOT be publicly accessible.
// Covers: debug endpoints, admin interfaces, source maps, common framework
// diagnostic routes, and well-known credential/config leaks.
export const EXPOSURE_PROBE_PATHS = [
  // Source maps
  '/main.js.map',
  '/bundle.js.map',
  '/app.js.map',
  '/static/js/main.chunk.js.map',
  // Debug / diagnostics
  '/.env',
  '/.env.local',
  '/.env.production',
  '/debug',
  '/debug/vars',
  '/api/debug',
  '/api/health/debug',
  // Admin interfaces
  '/admin',
  '/admin/login',
  '/wp-admin',
  '/wp-admin/admin.php',
  // Framework internals / config leaks
  '/actuator',
  '/actuator/env',
  '/actuator/health',
  '/phpinfo.php',
  '/server-status',
  // Git exposure
  '/.git/config',
  '/.git/HEAD',
] as const;

// Status codes considered "exposed" (anything that isn't 404/410/501)
function isExposed(status: number): boolean {
  if (status === 404 || status === 410 || status === 501) return false;
  return true;
}

function buildFinding(
  target: AllowedTarget,
  result: PathProbeResult,
): Finding {
  const normalizedPath = normalizeUrlPath(result.path);
  const fp = fingerprint({
    kind: 'live',
    checkId: 'LIVE-EXPOSE-001',
    host: target.hostname,
    urlPath: normalizedPath,
    parameter: '',
    evidenceClass: `exposed-path:${result.status}`,
  });
  const id = displayId(fp);
  const now = new Date().toISOString();

  const fullUrl = `${target.url.replace(/\/$/, '')}${result.path}`;
  const snippet = `Path ${result.path} returned HTTP ${result.status}${result.contentType ? ` (${result.contentType})` : ''}.`;

  // Redact body preview — it may carry credential material (§5.4)
  const rawEvidence: Record<string, unknown> = {
    path: result.path,
    status: result.status,
  };
  if (result.contentType !== undefined) rawEvidence['content-type'] = result.contentType;
  if (result.bodyPreview !== undefined) rawEvidence['body-preview'] = result.bodyPreview;

  return {
    id,
    fingerprint: fp,
    ruleId: 'LIVE-EXPOSE-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'info-disclosure',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'confirmed',
    target: { kind: 'staging', host: target.hostname },
    location: { url: fullUrl, method: 'GET' },
    evidence: {
      snippet,
      cvss: null,
      raw: redact(rawEvidence) as Record<string, unknown>,
    },
    reachability: 'unauthenticated',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: now,
    suppressed: false,
    suppression: null,
    note: null,
  };
}

/**
 * Run the exposed-endpoint probe against the given AllowedTarget.
 *
 * Probes each path in EXPOSURE_PROBE_PATHS; returns a Finding for every path
 * that returns a non-404/410/501 response.
 * Response body previews are redacted in the emitted findings (§5.4).
 */
export async function runExposureProbe(
  target: AllowedTarget,
  rps: number,
  client: ExposureClient,
  paths: readonly string[] = EXPOSURE_PROBE_PATHS,
): Promise<Finding[]> {
  const results: PathProbeResult[] = [];

  await withHostBudget(target.hostname, rps, async (acquireToken) => {
    for (const path of paths) {
      await acquireToken();
      const result = await client(target, path);
      results.push(result);
    }
  });

  return results
    .filter((r) => isExposed(r.status))
    .map((r) => buildFinding(target, r));
}
