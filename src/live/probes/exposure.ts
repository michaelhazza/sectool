import * as https from 'node:https';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
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

/**
 * Build a guaranteed-nonexistent calibration path. A correctly-behaving host
 * returns 404 for this; a host with a catch-all / soft-404 (e.g. a single-page
 * app that serves index.html for every unmatched route) returns 200 + the app
 * shell — the same response it gives every probe path, producing one false
 * positive per curated path. The random component makes a real collision
 * impossible.
 */
function makeControlPath(): string {
  return `/__audit_probe_${randomBytes(12).toString('hex')}__should-not-exist`;
}

/**
 * True when `r` is indistinguishable from the catch-all control response, i.e.
 * the host returned the same status, content-type, and body for a path that
 * cannot exist. Such a probe is not a real exposure — it is the catch-all.
 *
 * Body comparison is exact on the (capped) preview: a genuine leak returns the
 * sensitive file's contents, which differ from the catch-all shell, so this
 * never suppresses a true positive. It does not attempt to defeat soft-404s
 * that echo the requested path into the body (status + content-type must still
 * match to be suppressed).
 */
function isCatchAllResponse(r: PathProbeResult, control: PathProbeResult): boolean {
  return (
    r.status === control.status &&
    (r.contentType ?? '') === (control.contentType ?? '') &&
    (r.bodyPreview ?? '') === (control.bodyPreview ?? '')
  );
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
 * Real HTTP/HTTPS client for the exposure probe.
 * Makes a GET request to the target URL + path and returns the status + body preview.
 * Does not follow redirects — only direct responses are inspected.
 */
export const defaultExposureClient: ExposureClient = (
  target: AllowedTarget,
  path: string,
): Promise<PathProbeResult> => {
  return new Promise((resolve, reject) => {
    const fullUrl = `${target.url.replace(/\/$/, '')}${path}`;
    const isHttps = fullUrl.startsWith('https://');
    const client = isHttps ? https : http;
    const req = client.request(
      fullUrl,
      { method: 'GET', headers: { 'User-Agent': 'audit-tool/1.0.0' }, rejectUnauthorized: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = res.headers['content-type'];
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          // Only collect up to 512 bytes for the body preview
          if (chunks.reduce((acc, c) => acc + c.length, 0) < 512) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const bodyPreviewStr = Buffer.concat(chunks).slice(0, 512).toString('utf8');
          const result: PathProbeResult = {
            path,
            status,
            ...(typeof contentType === 'string' ? { contentType } : {}),
            ...(bodyPreviewStr.length > 0 ? { bodyPreview: bodyPreviewStr } : {}),
          };
          resolve(result);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Exposure probe request to ${fullUrl} timed out`));
    });
    req.end();
  });
};

/**
 * Run the exposed-endpoint probe against the given AllowedTarget.
 *
 * Probes each path in EXPOSURE_PROBE_PATHS; returns a Finding for every path
 * that returns a non-404/410/501 response.
 *
 * Calibration: a control probe to a guaranteed-nonexistent path runs first. If
 * the host returns an "exposed" status for it, the host has a catch-all
 * (soft-404 / SPA fallback), so any probe whose response is indistinguishable
 * from the control is suppressed — otherwise every curated path produces a
 * false positive against single-page-app hosts.
 *
 * Response body previews are redacted in the emitted findings (§5.4).
 */
export async function runExposureProbe(
  target: AllowedTarget,
  rps: number,
  client: ExposureClient,
  paths: readonly string[] = EXPOSURE_PROBE_PATHS,
): Promise<Finding[]> {
  const results: PathProbeResult[] = [];
  let control: PathProbeResult | undefined;

  await withHostBudget(target.hostname, rps, async (acquireToken) => {
    // Calibrate against catch-all hosts before probing the curated list.
    await acquireToken();
    control = await client(target, makeControlPath());

    for (const path of paths) {
      await acquireToken();
      const result = await client(target, path);
      results.push(result);
    }
  });

  // Only treat the control as a catch-all signature when it is itself "exposed":
  // a 404 control means the host distinguishes missing paths, so probe normally.
  const catchAll = control !== undefined && isExposed(control.status) ? control : undefined;

  return results
    .filter((r) => isExposed(r.status))
    .filter((r) => catchAll === undefined || !isCatchAllResponse(r, catchAll))
    .map((r) => buildFinding(target, r));
}
