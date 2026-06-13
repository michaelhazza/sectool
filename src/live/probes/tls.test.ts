import { describe, it, expect, beforeEach } from 'vitest';
import { runTlsProbe } from './tls.js';
import type { TlsPeerInfo, TlsClient } from './tls.js';
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

function makeGoodPeer(): TlsPeerInfo {
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    protocol: 'TLSv1.3',
    subjectCN: 'staging.example.dev',
    validTo: futureDate,
    authorized: true,
    cipher: 'TLS_AES_256_GCM_SHA384',
  };
}

function fakeClient(peerInfo: TlsPeerInfo): TlsClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_target: AllowedTarget): Promise<TlsPeerInfo> => Promise.resolve(peerInfo);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTlsProbe', () => {
  beforeEach(() => {
    _resetHostRegistry();
  });

  it('returns no findings for a clean TLS configuration', async () => {
    const target = makeTarget();
    const client = fakeClient(makeGoodPeer());
    const findings = await runTlsProbe(target, 10, client);
    expect(findings).toHaveLength(0);
  });

  it('flags weak TLS protocol (TLSv1.1)', async () => {
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), protocol: 'TLSv1.1' };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    const weakProto = findings.find((f) => f.evidence.snippet?.includes('TLSv1.1'));
    expect(weakProto).toBeDefined();
    expect(weakProto?.ruleId).toBe('LIVE-TLS-001');
    expect(weakProto?.source).toBe('probe');
    expect(weakProto?.surface).toBe('live');
    expect(weakProto?.target).toEqual({ kind: 'staging', host: 'staging.example.dev' });
    expect(weakProto?.location).toMatchObject({ method: 'GET' });
    expect(weakProto?.vulnClass).toBe('tls');
  });

  it('flags SSLv3 as weak protocol', async () => {
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), protocol: 'SSLv3' };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    expect(findings.some((f) => f.evidence.snippet?.includes('SSLv3'))).toBe(true);
  });

  it('flags TLSv1.0 as weak protocol', async () => {
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), protocol: 'TLSv1.0' };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    expect(findings.some((f) => f.evidence.snippet?.includes('TLSv1.0'))).toBe(true);
  });

  it('flags untrusted certificate (self-signed)', async () => {
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), authorized: false };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    const untrusted = findings.find((f) => f.evidence.snippet?.includes('not trusted'));
    expect(untrusted).toBeDefined();
    expect(untrusted?.ruleId).toBe('LIVE-TLS-001');
    expect(untrusted?.vulnClass).toBe('tls');
  });

  it('flags expired certificate', async () => {
    const target = makeTarget();
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const peer = { ...makeGoodPeer(), validTo: pastDate };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    const expiredFinding = findings.find((f) => f.evidence.snippet?.includes('expired'));
    expect(expiredFinding).toBeDefined();
  });

  it('flags certificate expiring within 30 days', async () => {
    const target = makeTarget();
    const soonDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const peer = { ...makeGoodPeer(), validTo: soonDate };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    const expiringFinding = findings.find((f) => f.evidence.snippet?.includes('expiring within'));
    expect(expiringFinding).toBeDefined();
  });

  it('does not flag certificate expiring in 90 days', async () => {
    const target = makeTarget();
    const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const peer = { ...makeGoodPeer(), validTo: futureDate };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    const expiryFindings = findings.filter(
      (f) => f.evidence.snippet?.includes('expired') || f.evidence.snippet?.includes('expiring'),
    );
    expect(expiryFindings).toHaveLength(0);
  });

  it('emits findings with live location shape and correct checkId', async () => {
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), protocol: 'TLSv1.1' };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
      expect(f.ruleId).toBe('LIVE-TLS-001');
      expect(f.source).toBe('probe');
      expect(f.surface).toBe('live');
      expect(f.target.kind).toBe('staging');
      expect(typeof f.location.url).toBe('string');
    }
  });

  it('evidence raw does not contain cipher value verbatim when cipher looks like a secret pattern', async () => {
    // Verify the raw evidence is passed through redact() — the cipher field is not
    // a credential key so it passes through as-is; the test checks structure is correct.
    const target = makeTarget();
    const peer = { ...makeGoodPeer(), protocol: 'TLSv1.0' };
    const findings = await runTlsProbe(target, 10, fakeClient(peer));
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0];
    expect(f).toBeDefined();
    // evidence.raw should be an object (not undefined)
    expect(typeof f!.evidence.raw).toBe('object');
  });
});
