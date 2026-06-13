import type { RunReport } from '../schemas/report.js';
import type { Finding } from '../schemas/finding.js';
import { redact } from './redaction.js';
import { sortFindings } from './json.js';

// ---------------------------------------------------------------------------
// Severity plain-English labels (§5.2 vocabulary)
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Fix now (Critical)',
  high: 'Fix soon (High)',
  medium: 'Plan it (Medium)',
  low: 'Low risk (Low)',
};

function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? severity;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeMarkdown(text: string): string {
  // Escape characters that have special meaning in Markdown tables/inline code
  return text.replace(/[`\\|]/g, '\\$&');
}

function locationStr(finding: Finding): string {
  if (finding.surface === 'static') {
    const line =
      finding.location.startLine !== undefined
        ? `:${finding.location.startLine}`
        : '';
    return `${finding.location.path}${line} — \`${finding.location.symbol}\``;
  }
  const param = finding.location.parameter
    ? ` (param: \`${finding.location.parameter}\`)`
    : '';
  return `${finding.location.method} ${finding.location.url}${param}`;
}

function targetStr(finding: Finding): string {
  if (finding.target.kind === 'repo') {
    const commit = finding.target.commit
      ? ` @ ${finding.target.commit.slice(0, 8)}`
      : '';
    return `${finding.target.name}${commit}`;
  }
  return finding.target.host;
}

function surfaceLabel(finding: Finding): string {
  return finding.surface === 'static' ? 'In the code' : 'On the live test site';
}

function suppressionNote(finding: Finding): string {
  if (finding.suppressed && finding.suppression !== null) {
    return `\n  > **Acknowledged risk** — ${finding.suppression.justification} (approved by ${finding.suppression.approvedBy}, expires ${finding.suppression.expiry})`;
  }
  if (finding.note !== null) {
    return `\n  > **Note:** ${finding.note}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSummaryTable(findings: readonly Finding[]): string {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let suppressed = 0;

  for (const f of findings) {
    const sev = f.severity;
    if (sev in counts) {
      (counts[sev] as number)++;
    }
    if (f.suppressed) suppressed++;
  }

  const lines: string[] = [
    '| Severity | Count |',
    '|---|---|',
    `| Fix now (Critical) | ${counts['critical'] ?? 0} |`,
    `| Fix soon (High) | ${counts['high'] ?? 0} |`,
    `| Plan it (Medium) | ${counts['medium'] ?? 0} |`,
    `| Low risk (Low) | ${counts['low'] ?? 0} |`,
    `| **Total** | **${findings.length}** |`,
    `| Acknowledged risks (suppressed) | ${suppressed} |`,
  ];
  return lines.join('\n');
}

function renderFinding(finding: Finding, index: number): string {
  const lines: string[] = [];

  // Heading: severity label + rule id + display id
  lines.push(
    `### ${index}. ${severityLabel(finding.severity)} — ${finding.ruleId} (\`${finding.id}\`)`,
  );
  lines.push('');
  lines.push(`- **Surface:** ${surfaceLabel(finding)}`);
  lines.push(`- **Target:** ${escapeMarkdown(targetStr(finding))}`);
  lines.push(`- **Location:** ${locationStr(finding)}`);
  lines.push(`- **Vulnerability class:** ${finding.vulnClass}`);
  lines.push(
    `- **Confidence:** ${finding.confidence}${finding.reachability !== 'unknown' ? ` / Reachability: ${finding.reachability}` : ''}`,
  );

  if (finding.suppressed) {
    lines.push(`- **Status:** Acknowledged risk (suppressed)`);
  }

  if (finding.correlatedWith.length > 0) {
    lines.push(`- **Correlated with:** ${finding.correlatedWith.join(', ')}`);
  }

  if (finding.externalRefs.length > 0) {
    lines.push(`- **Fix request:** ${finding.externalRefs.map((u) => `[issue](${u})`).join(', ')}`);
  }

  if (finding.docs !== undefined) {
    lines.push(`- **Rule docs:** \`${finding.docs}\``);
  }

  lines.push(`- **First seen:** ${finding.firstSeen}`);
  lines.push(`- **Fingerprint:** \`${finding.fingerprint}\``);

  // Evidence snippet
  if (finding.evidence.snippet !== undefined && finding.evidence.snippet !== '') {
    lines.push('');
    lines.push('**Evidence:**');
    lines.push('');
    lines.push('```');
    lines.push(finding.evidence.snippet);
    lines.push('```');
  }

  // Suppression / note annotation
  const suppNote = suppressionNote(finding);
  if (suppNote !== '') {
    lines.push('');
    lines.push(suppNote.trimStart());
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a human-readable Markdown report from a RunReport.
 *
 * Structure (§8.1 order / §5.1):
 * 1. Header with run metadata
 * 2. Summary table (severity counts)
 * 3. Findings in §8.1 report order (severity desc → confidence → vulnClass → target → ruleId → fingerprint)
 * 4. Run metadata (scanner status, failures)
 *
 * Redaction applied via P2-1 chokepoint before rendering.
 */
export function toMarkdown(report: RunReport): string {
  // Apply redaction to the report before projecting into text (§5.4)
  const redacted = redact(report) as RunReport;

  const sortedFindings = sortFindings(redacted.findings);

  const sections: string[] = [];

  // 1. Header
  sections.push(`# Audit Report — ${redacted.runId}`);
  sections.push('');
  sections.push(`**Date:** ${redacted.date}  `);
  sections.push(`**Status:** ${redacted.meta.status}  `);
  sections.push(`**Tool version:** ${redacted.meta.toolVersion}  `);
  sections.push(`**Started:** ${redacted.meta.startedAt}  `);
  sections.push(`**Finished:** ${redacted.meta.finishedAt}  `);
  sections.push('');

  // Targets scanned
  if (redacted.targets.length > 0) {
    sections.push('## Targets');
    sections.push('');
    for (const t of redacted.targets) {
      const commit = t.commit !== undefined ? ` @ \`${t.commit.slice(0, 8)}\`` : '';
      sections.push(`- **${t.kind}** \`${t.name}\`${commit}`);
      for (const gap of t.coverageGaps) {
        sections.push(`  - Coverage gap: ${gap}`);
      }
    }
    sections.push('');
  }

  // Failures (partial/failed runs)
  if (redacted.meta.failures.length > 0) {
    sections.push('## Failures');
    sections.push('');
    for (const f of redacted.meta.failures) {
      sections.push(`- **${f.target}** (${f.family}): ${f.reason}`);
    }
    sections.push('');
  }

  // 2. Summary table
  sections.push('## Summary');
  sections.push('');
  sections.push(renderSummaryTable(sortedFindings));
  sections.push('');

  // 3. Findings in §8.1 order
  sections.push('## Findings');
  sections.push('');

  if (sortedFindings.length === 0) {
    sections.push('No findings.');
    sections.push('');
  } else {
    sortedFindings.forEach((finding, idx) => {
      sections.push(renderFinding(finding, idx + 1));
      sections.push('');
    });
  }

  // 4. Scanner status
  if (redacted.meta.scannerStatus.length > 0) {
    sections.push('## Scanner status');
    sections.push('');
    sections.push('| Target | Family | State |');
    sections.push('|---|---|---|');
    for (const s of redacted.meta.scannerStatus) {
      sections.push(`| ${s.target} | ${s.family} | ${s.state} |`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
