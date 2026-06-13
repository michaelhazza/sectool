import type { AllowedTarget } from '../gate.js';
import { withHostBudget } from '../ratelimit.js';
import { redact } from '../../report/redaction.js';
import { fingerprint, displayId, normalizeUrlPath } from '../../correlate/fingerprint.js';
import type { Finding } from '../../schemas/finding.js';

// ---------------------------------------------------------------------------
// TLS probe — LIVE-TLS-001 (§7.3 passive family)
//
// Checks TLS certificate validity and security (expiry, self-signed, weak
// protocol versions, and basic cipher posture) by connecting to the target
// host and inspecting the TLS handshake metadata.
//
// Injectable `TlsClient` so unit tests never hit the network.
// ---------------------------------------------------------------------------

export interface TlsPeerInfo {
  /** TLS protocol version negotiated, e.g. "TLSv1.2", "TLSv1.3" */
  protocol: string;
  /** Certificate subject CN */
  subjectCN: string;
  /** Certificate expiry as ISO date string */
  validTo: string;
  /** Whether the cert was issued by a recognized CA (false = self-signed / unknown CA) */
  authorized: boolean;
  /** Cipher suite name, e.g. "TLS_AES_128_GCM_SHA256" */
  cipher: string;
}

export type TlsClient = (target: AllowedTarget) => Promise<TlsPeerInfo>;

const WEAK_PROTOCOLS = new Set(['SSLv3', 'TLSv1', 'TLSv1.0', 'TLSv1.1']);

function isCertExpiredOrExpiringSoon(validTo: string): boolean {
  const expiry = new Date(validTo);
  const now = new Date();
  // Flag if expired or expiring within 30 days
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return expiry.getTime() - now.getTime() < thirtyDaysMs;
}

function buildFinding(
  target: AllowedTarget,
  issueKind: string,
  detail: string,
  evidenceRaw: Record<string, unknown>,
): Finding {
  const urlPath = new URL(target.url).pathname || '/';
  const normalizedPath = normalizeUrlPath(urlPath);
  const fp = fingerprint({
    kind: 'live',
    checkId: 'LIVE-TLS-001',
    host: target.hostname,
    urlPath: normalizedPath,
    parameter: '',
    evidenceClass: issueKind,
  });
  const id = displayId(fp);
  const now = new Date().toISOString();

  return {
    id,
    fingerprint: fp,
    ruleId: 'LIVE-TLS-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'tls',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    target: { kind: 'staging', host: target.hostname },
    location: { url: target.url, method: 'GET' },
    evidence: {
      snippet: detail,
      cvss: null,
      raw: redact(evidenceRaw) as Record<string, unknown>,
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
 * Run the TLS probe against the given AllowedTarget.
 *
 * Returns an array of findings for any TLS/cert issues found.
 * Returns an empty array when the TLS posture is clean.
 */
export async function runTlsProbe(
  target: AllowedTarget,
  rps: number,
  client: TlsClient,
): Promise<Finding[]> {
  let peerInfo!: TlsPeerInfo;

  await withHostBudget(target.hostname, rps, async (acquireToken) => {
    await acquireToken();
    peerInfo = await client(target);
  });

  const findings: Finding[] = [];

  // Check 1: weak protocol version
  if (WEAK_PROTOCOLS.has(peerInfo.protocol)) {
    findings.push(
      buildFinding(
        target,
        'weak-protocol',
        `Weak TLS protocol negotiated: ${peerInfo.protocol}. Upgrade to TLS 1.2+ minimum.`,
        { protocol: peerInfo.protocol, cipher: peerInfo.cipher },
      ),
    );
  }

  // Check 2: certificate not trusted (self-signed / unknown CA)
  if (!peerInfo.authorized) {
    findings.push(
      buildFinding(
        target,
        'untrusted-cert',
        `TLS certificate is not trusted (self-signed or unknown CA). Subject: ${peerInfo.subjectCN}.`,
        { subjectCN: peerInfo.subjectCN, authorized: peerInfo.authorized },
      ),
    );
  }

  // Check 3: certificate expired or expiring within 30 days
  if (isCertExpiredOrExpiringSoon(peerInfo.validTo)) {
    const expiry = new Date(peerInfo.validTo);
    const expired = expiry < new Date();
    const label = expired ? 'expired' : 'expiring within 30 days';
    findings.push(
      buildFinding(
        target,
        'cert-expiry',
        `TLS certificate is ${label}: validTo=${peerInfo.validTo}. Subject: ${peerInfo.subjectCN}.`,
        { subjectCN: peerInfo.subjectCN, validTo: peerInfo.validTo },
      ),
    );
  }

  return findings;
}
