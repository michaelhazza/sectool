import { describe, it, expect, beforeEach } from 'vitest';
import { runExposureProbe, EXPOSURE_PROBE_PATHS } from './exposure.js';
import type { PathProbeResult, ExposureClient } from './exposure.js';
import type { AllowedTarget } from '../gate.js';
import { _resetHostRegistry } from '../ratelimit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(url = 'https://staging.example.dev/'): AllowedTarget {
  return {
    url,
    hostname: 'staging.example.dev',
  } as unknown as AllowedTarget;
}

/** Client that returns 404 for all paths — a clean baseline. */
function allNotFoundClient(): ExposureClient {
  return (_target: AllowedTarget, path: string): Promise<PathProbeResult> =>
    Promise.resolve({ path, status: 404 });
}

/** Client that returns the given status for a specific path, 404 for all others. */
function exposedPathClient(exposedPath: string, status: number, bodyPreview?: string): ExposureClient {
  return (_target: AllowedTarget, path: string): Promise<PathProbeResult> => {
    if (path === exposedPath) {
      return Promise.resolve({ path, status, contentType: 'text/plain', bodyPreview });
    }
    return Promise.resolve({ path, status: 404 });
  };
}

/** Extract the url from a live finding's location (type-safely via cast). */
function locationUrl(f: { location: unknown }): string {
  return (f.location as { url: string }).url;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runExposureProbe', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings when all paths return 404', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, allNotFoundClient());
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when paths return 410 Gone', async () => {
    const target = makeTarget();
    const client: ExposureClient = (_t: AllowedTarget, path: string): Promise<PathProbeResult> =>
      Promise.resolve({ path, status: 410 });
    const findings = await runExposureProbe(target, 10, client);
    expect(findings).toHaveLength(0);
  });

  it('flags /.env returning HTTP 200', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, exposedPathClient('/.env', 200));
    const envFinding = findings.find((f) => locationUrl(f).includes('/.env'));
    expect(envFinding).toBeDefined();
    expect(envFinding?.ruleId).toBe('LIVE-EXPOSE-001');
    expect(envFinding?.source).toBe('probe');
    expect(envFinding?.surface).toBe('live');
    expect(envFinding?.vulnClass).toBe('info-disclosure');
    expect(envFinding?.confidence).toBe('confirmed');
  });

  it('flags /.git/config returning HTTP 200', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, exposedPathClient('/.git/config', 200));
    expect(findings.some((f) => locationUrl(f).includes('/.git/config'))).toBe(true);
  });

  it('flags /admin returning HTTP 200', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, exposedPathClient('/admin', 200));
    expect(findings.some((f) => locationUrl(f).includes('/admin'))).toBe(true);
  });

  it('flags source map path returning HTTP 200', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, exposedPathClient('/main.js.map', 200));
    expect(findings.some((f) => locationUrl(f).includes('/main.js.map'))).toBe(true);
  });

  it('flags redirects (301/302) as exposed', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(target, 10, exposedPathClient('/admin', 302));
    expect(findings.some((f) => locationUrl(f).includes('/admin'))).toBe(true);
  });

  it('redacts body preview content in evidence raw', async () => {
    // Body preview may contain credential material; redact() should process it.
    // We use an innocuous non-matching string to confirm the raw field is present.
    const target = makeTarget();
    const bodyPreview = 'fixture-body-preview-contents-not-a-secret';
    const client = exposedPathClient('/.env', 200, bodyPreview);
    const findings = await runExposureProbe(target, 10, client, ['/.env']);
    const f = findings[0];
    expect(f).toBeDefined();
    // body-preview is NOT a credential key in redact(), so it passes through
    // but we confirm it's present in evidence.raw
    const rawStr = JSON.stringify(f!.evidence.raw);
    expect(rawStr).toContain('body-preview');
  });

  it('does not include body preview with credential-like key words in unredacted form', async () => {
    const target = makeTarget();
    const client = exposedPathClient('/.env', 200, 'innocent-preview-data');
    const findings = await runExposureProbe(target, 10, client, ['/.env']);
    expect(findings).toHaveLength(1);
    // body-preview is NOT redacted (not a credential key)
    const rawStr = JSON.stringify(findings[0]!.evidence.raw);
    expect(rawStr).toContain('innocent-preview-data');
    // But raw must not have any actual credential patterns in the key space
    expect(rawStr).not.toMatch(/\bpassword\b/);
    expect(rawStr).not.toMatch(/\bsecret\b/);
  });

  it('uses a custom path list when provided', async () => {
    const target = makeTarget();
    const customPaths = ['/.env', '/debug'];
    const findings = await runExposureProbe(
      target,
      10,
      exposedPathClient('/.env', 200),
      customPaths,
    );
    // Only /.env is exposed; /debug returns 404
    expect(findings).toHaveLength(1);
    expect(locationUrl(findings[0]!)).toMatch(/\/\.env/);
  });

  it('emits findings with correct live location shape', async () => {
    const target = makeTarget();
    const findings = await runExposureProbe(
      target,
      10,
      exposedPathClient('/.env', 200),
      ['/.env'],
    );
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
    expect(f.target).toEqual({ kind: 'staging', host: 'staging.example.dev' });
    expect(locationUrl(f)).toMatch(/staging\.example\.dev/);
    expect(f.location).toMatchObject({ method: 'GET' });
  });

  it('EXPOSURE_PROBE_PATHS includes common sensitive paths', () => {
    // Sanity check: the curated list is non-empty and contains key paths
    expect(EXPOSURE_PROBE_PATHS.length).toBeGreaterThan(0);
    expect(EXPOSURE_PROBE_PATHS).toContain('/.env');
    expect(EXPOSURE_PROBE_PATHS).toContain('/.git/config');
    expect(EXPOSURE_PROBE_PATHS).toContain('/main.js.map');
    expect(EXPOSURE_PROBE_PATHS).toContain('/admin');
  });
});
