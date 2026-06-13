import type { RunReport } from '../schemas/report.js';
import type { Finding } from '../schemas/finding.js';
import { redact } from './redaction.js';
import { sortFindings } from './json.js';

// ---------------------------------------------------------------------------
// SARIF 2.1.0 type shapes (minimal, covering what we emit)
// ---------------------------------------------------------------------------

interface SarifArtifactLocation {
  uri: string;
}

interface SarifRegion {
  startLine: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

interface SarifLogicalLocation {
  fullyQualifiedName: string;
}

interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
  logicalLocation?: SarifLogicalLocation;
}

interface SarifMessage {
  text: string;
}

interface SarifSuppression {
  kind: 'external';
  justification: string;
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  rank?: number;
  message: SarifMessage;
  locations: SarifLocation[];
  fingerprints: { auditToolFingerprintV1: string };
  relatedLocations?: SarifLocation[];
  suppressions?: SarifSuppression[];
  workItemUris?: string[];
}

interface SarifReportingDescriptor {
  id: string;
  shortDescription: SarifMessage;
  helpUri?: string;
}

interface SarifDriver {
  name: string;
  version: string;
  rules: SarifReportingDescriptor[];
}

interface SarifTool {
  driver: SarifDriver;
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
}

interface SarifLog {
  version: '2.1.0';
  $schema: string;
  runs: SarifRun[];
}

// ---------------------------------------------------------------------------
// Severity → SARIF level/rank
// ---------------------------------------------------------------------------

const SEVERITY_LEVEL: Record<string, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

// ---------------------------------------------------------------------------
// Rule descriptor short descriptions (one-line intent from §7.1/§7.3)
// ---------------------------------------------------------------------------

const RULE_SHORT_DESCRIPTIONS: Record<string, string> = {
  'BS-RLS-001': 'Drizzle table with tenant column missing RLS policy in migrations',
  'BS-SQL-001': 'SQL template literal interpolating request-derived values (taint)',
  'BS-SQL-002': 'Query on tenant table bypassing scoped query helpers',
  'BS-AUTH-001': 'Express route mounted without auth/permission middleware',
  'BS-AUTH-002': 'Auth endpoint missing rate-limit middleware',
  'BS-JWT-001': 'JWT config: algorithm unpinned, no expiry, or secret literal',
  'BS-UPLOAD-001': 'multer route without file-size limit or type filter',
  'BS-XSS-001': 'User-supplied HTML rendered without sanitize-html',
  'BS-CORS-001': 'CORS wildcard or reflected-origin in production code',
  'BS-WS-001': 'socket.io handler registered without auth handshake middleware',
  'BS-VAL-001': 'Route handler reads body/query/params with no Zod parse',
  'semgrep': 'Semgrep pattern-based static analysis findings',
  'gitleaks': 'Secret/credential material detected in source',
  'osv': 'Known vulnerability in a dependency (OSV database)',
  'LIVE-TLS-001': 'TLS/certificate configuration weakness',
  'LIVE-HDR-001': 'Missing or misconfigured security response header',
  'LIVE-COOKIE-001': 'Cookie missing HttpOnly, Secure, or SameSite flag',
  'LIVE-EXPOSE-001': 'Exposed debug/admin/source-map endpoint',
  'LIVE-LEAK-001': 'Server/framework version leaked in response',
  'LIVE-IDOR-001': 'Insecure direct object reference (cross-user access)',
  'LIVE-SESSION-001': 'Session management weakness detected',
};

function ruleShortDescription(ruleId: string): string {
  return RULE_SHORT_DESCRIPTIONS[ruleId] ?? `Security finding: ${ruleId}`;
}

// ---------------------------------------------------------------------------
// Build a location entry from a finding
// ---------------------------------------------------------------------------

function buildLocation(finding: Finding): SarifLocation {
  if (finding.surface === 'static') {
    const loc: SarifLocation = {
      physicalLocation: {
        artifactLocation: { uri: finding.location.path },
        ...(finding.location.startLine !== undefined
          ? { region: { startLine: finding.location.startLine } }
          : {}),
      },
      logicalLocation: {
        fullyQualifiedName: finding.location.symbol,
      },
    };
    return loc;
  }

  // Live finding: logicalLocation only (no source file)
  return {
    logicalLocation: {
      fullyQualifiedName: `${finding.location.method} ${finding.location.url}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Build a plain-English message for a finding
// ---------------------------------------------------------------------------

function buildMessage(finding: Finding): string {
  const base = ruleShortDescription(finding.ruleId);
  if (finding.surface === 'static') {
    return `${base} in ${finding.location.path} (${finding.location.symbol})`;
  }
  return `${base} at ${finding.location.url}`;
}

// ---------------------------------------------------------------------------
// Collect distinct rule ids from findings
// ---------------------------------------------------------------------------

function collectRuleIds(findings: readonly Finding[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const f of findings) {
    if (!seen.has(f.ruleId)) {
      seen.add(f.ruleId);
      result.push(f.ruleId);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a SARIF 2.1.0 document from a RunReport (§6.10).
 *
 * Properties:
 * - tool.driver.rules: one reportingDescriptor per distinct ruleId in findings
 * - results: one per finding, sorted by §8.1 order (deterministic bytes)
 * - result.fingerprints.auditToolFingerprintV1: full 64-hex sha256 (not truncated id)
 * - result.suppressions: present for suppressed findings, reads justification
 *   from the report-stage suppression field (NOT from mutable config)
 * - redaction applied via P2-1 chokepoint
 */
export function toSarif(report: RunReport): string {
  // Re-sort to guarantee deterministic byte order (report is already sorted,
  // but we re-apply to be explicit about the contract)
  const sortedFindings = sortFindings(report.findings);

  const ruleIds = collectRuleIds(sortedFindings);

  const rules: SarifReportingDescriptor[] = ruleIds.map((ruleId) => {
    const descriptor: SarifReportingDescriptor = {
      id: ruleId,
      shortDescription: { text: ruleShortDescription(ruleId) },
    };
    // helpUri points to the docs page when one exists for this rule id
    const docsPath = `docs/rules/${ruleId}.md`;
    descriptor.helpUri = docsPath;
    return descriptor;
  });

  const results: SarifResult[] = sortedFindings.map((finding) => {
    const level = SEVERITY_LEVEL[finding.severity] ?? 'warning';
    const rank = SEVERITY_RANK[finding.severity];

    const result: SarifResult = {
      ruleId: finding.ruleId,
      level,
      message: { text: buildMessage(finding) },
      locations: [buildLocation(finding)],
      fingerprints: { auditToolFingerprintV1: finding.fingerprint },
    };

    if (rank !== undefined) {
      result.rank = rank;
    }

    // Suppression: read from report-stage suppression field (§6.10 / §6.1)
    if (finding.suppressed && finding.suppression !== null) {
      result.suppressions = [
        {
          kind: 'external',
          justification: finding.suppression.justification,
        },
      ];
    }

    // Correlated live evidence → relatedLocations
    if (finding.correlatedWith.length > 0) {
      const correlatedFindings = finding.correlatedWith
        .map((corrId) =>
          report.findings.find((f) => f.id === corrId || f.fingerprint === corrId),
        )
        .filter((f): f is Finding => f !== undefined);

      if (correlatedFindings.length > 0) {
        result.relatedLocations = correlatedFindings.map(buildLocation);
      }
    }

    // externalRefs → workItemUris
    if (finding.externalRefs.length > 0) {
      result.workItemUris = [...finding.externalRefs];
    }

    return result;
  });

  const toolVersion = report.meta.toolVersion.replace(/^audit-tool\//, '');

  const sarifLog: SarifLog = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'audit-tool',
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };

  // Apply redaction chokepoint (§5.4) before serializing
  const redacted = redact(sarifLog);
  return JSON.stringify(redacted, null, 2);
}
