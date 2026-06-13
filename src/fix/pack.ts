/**
 * src/fix/pack.ts — Remediation pack renderer (§5.3 step 1)
 *
 * buildPack(finding) returns a machine-readable + Markdown remediation pack:
 * - plain-English problem statement
 * - affected location (file/symbol/route or URL/method)
 * - recommended fix pattern + code example (sourced from docs/rules/<id>.md)
 * - severity + rationale
 * - acceptance criteria (ruleId + full fingerprint that must no longer fire)
 * - ready-to-paste Claude Code prompt (manual fallback, §5.3)
 *
 * Pack body is redaction-passed via src/report/redaction.ts (§5.4).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from '../schemas/finding.js';
import { redact } from '../report/redaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const RULES_DIR = resolve(REPO_ROOT, 'docs', 'rules');

// ---------------------------------------------------------------------------
// Rule-doc path resolution (§11 wildcard-family convention)
// ---------------------------------------------------------------------------

// Safe charset for rule ids: letters, digits, dots, underscores, hyphens only.
// Rejects path separators and dot-dot sequences at the character level.
const SAFE_RULE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the doc path for a given ruleId + source.
 * Returns the absolute path if a doc exists, or null if no doc is found.
 *
 * Resolution order:
 * 1. Exact match: docs/rules/<ruleId>.md (covers all custom + LIVE-* ids)
 * 2. ZAP-P-* prefix → docs/rules/ZAP-P.md
 * 3. ZAP-A-* prefix → docs/rules/ZAP-A.md
 * 4. NUCLEI-* prefix → docs/rules/NUCLEI.md
 * 5. Wrapped-scanner family by source: docs/rules/<source>.md
 *
 * ruleId is scanner-emitted and therefore attacker-influenceable. We validate
 * it against a safe charset and assert the resolved path stays within RULES_DIR
 * before any file read is attempted (path-traversal guard).
 */
export function resolveRuleDocPath(ruleId: string, source: string): string | null {
  // Reject any ruleId that contains path separators or is not safe-charset.
  if (!SAFE_RULE_ID_RE.test(ruleId)) return null;

  const exactPath = resolve(RULES_DIR, `${ruleId}.md`);
  // Assert the resolved path stays within RULES_DIR (belt-and-suspenders after charset check).
  if (!exactPath.startsWith(RULES_DIR + sep)) return null;
  if (existsSync(exactPath)) return exactPath;

  if (ruleId.startsWith('ZAP-P-')) {
    const p = resolve(RULES_DIR, 'ZAP-P.md');
    if (existsSync(p)) return p;
  }
  if (ruleId.startsWith('ZAP-A-')) {
    const p = resolve(RULES_DIR, 'ZAP-A.md');
    if (existsSync(p)) return p;
  }
  if (ruleId.startsWith('NUCLEI-')) {
    const p = resolve(RULES_DIR, 'NUCLEI.md');
    if (existsSync(p)) return p;
  }

  // Wrapped-scanner families: source is 'semgrep' | 'gitleaks' | 'osv'
  const sourcePath = resolve(RULES_DIR, `${source}.md`);
  if (existsSync(sourcePath)) return sourcePath;

  return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RemediationPackJson {
  /** Full 64-hex fingerprint — canonical key (§6.6). */
  fingerprint: string;
  /** Display id: "f-" + fingerprint.slice(0,16). */
  id: string;
  ruleId: string;
  /** Plain-English description of the security problem. */
  problemStatement: string;
  /** Affected location: file+symbol (static) or url+method (live). */
  location: string;
  /** Severity value from the finding. */
  severity: string;
  /** Rationale: modifiers applied to arrive at this severity. */
  severityRationale: string;
  /** Fix guidance text sourced from the rule doc (or a fallback note). */
  fixGuidance: string;
  /** Acceptance criteria: ruleId + full fingerprint that must no longer fire. */
  acceptanceCriteria: {
    ruleId: string;
    fingerprint: string;
    description: string;
  };
  /** ISO timestamp when the pack was generated. */
  generatedAt: string;
}

export interface RemediationPack {
  /** Machine-readable pack object. */
  json: RemediationPackJson;
  /** Markdown rendering of the pack. */
  markdown: string;
  /** Ready-to-paste Claude Code prompt (manual fallback, §5.3). */
  prompt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLocation(finding: Finding): string {
  if (finding.surface === 'static') {
    const { path, symbol, startLine } = finding.location;
    const lineInfo = startLine !== undefined ? `:${startLine}` : '';
    return `${path}${lineInfo} — ${symbol}`;
  }
  const { url, method, parameter } = finding.location;
  const paramInfo = parameter !== undefined ? ` (parameter: ${parameter})` : '';
  return `${method} ${url}${paramInfo}`;
}

/**
 * Build a plain-English problem statement from the finding.
 * Falls back to a rule-id + vulnClass description when no rule doc is available.
 */
function problemStatement(finding: Finding, ruleDocContent: string | null): string {
  if (ruleDocContent !== null) {
    // Extract the "What it flags" section from the rule doc for a concise statement.
    const flagsMatch = /## What it flags\s+([\s\S]*?)(?=\n##|\s*$)/.exec(ruleDocContent);
    if (flagsMatch?.[1]) {
      return flagsMatch[1].trim();
    }
    // Fall back to the first non-empty paragraph after the title.
    const lines = ruleDocContent.split('\n');
    const contentLines: string[] = [];
    let pastTitle = false;
    for (const line of lines) {
      if (!pastTitle) {
        if (line.startsWith('#')) pastTitle = true;
        continue;
      }
      if (line.startsWith('#')) break;
      if (line.trim()) contentLines.push(line.trim());
      else if (contentLines.length > 0) break;
    }
    if (contentLines.length > 0) return contentLines.join(' ');
  }
  return `Security finding: ${finding.ruleId} (${finding.vulnClass}) detected at ${formatLocation(finding)}.`;
}

/**
 * Extract the fix guidance + code example from the rule doc.
 * Returns the "Fix pattern" section, or a fallback note if absent or no doc.
 */
function extractFixGuidance(ruleDocContent: string | null, ruleId: string): string {
  if (ruleDocContent !== null) {
    const fixMatch = /## Fix pattern\s+([\s\S]*?)(?=\n##|\s*$)/.exec(ruleDocContent);
    if (fixMatch?.[1]) return fixMatch[1].trim();
  }
  return `No fix guidance available for rule ${ruleId}. See docs/rules/${ruleId}.md or the ZAP/Nuclei alert description.`;
}

function severityRationale(finding: Finding): string {
  const parts: string[] = [`Base severity: ${finding.baseSeverity}`];
  if (finding.severity !== finding.baseSeverity) {
    parts.push(`Computed severity: ${finding.severity} (modified by reachability="${finding.reachability}", confidence="${finding.confidence}")`);
  }
  if (finding.reachability === 'unauthenticated') {
    parts.push('Reachability bump applied: endpoint is unauthenticated (+1 step).');
  }
  if (finding.reachability === 'admin') {
    parts.push('Reachability demotion applied: endpoint is admin-only (−1 step).');
  }
  if (finding.confidence === 'confirmed') {
    parts.push('Live-confirmed: static finding correlated with a live finding (+1 step, confidence=confirmed).');
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a remediation pack for a finding.
 *
 * Resolves the rule doc from docs/rules/<id>.md (incl. wildcard-family
 * convention), extracts fix guidance, and applies redaction (§5.4).
 * Degrades gracefully when the rule doc is missing — never throws.
 */
export function buildPack(finding: Finding): RemediationPack {
  const docPath = resolveRuleDocPath(finding.ruleId, finding.source);
  const ruleDocContent = docPath !== null ? readFileSync(docPath, 'utf-8') : null;

  const location = formatLocation(finding);
  const problem = problemStatement(finding, ruleDocContent);
  const fixGuidance = extractFixGuidance(ruleDocContent, finding.ruleId);
  const sevRationale = severityRationale(finding);
  const generatedAt = new Date().toISOString();

  const missingDocNote =
    docPath === null
      ? `\n\n> **Note:** Rule documentation not found for \`${finding.ruleId}\`. Fix guidance above is a fallback. Check \`docs/rules/\` for available docs.`
      : '';

  const acceptance = {
    ruleId: finding.ruleId,
    fingerprint: finding.fingerprint,
    description: `The finding with ruleId \`${finding.ruleId}\` and fingerprint \`${finding.fingerprint}\` must no longer fire on re-scan.`,
  };

  const packJson: RemediationPackJson = {
    fingerprint: finding.fingerprint,
    id: finding.id,
    ruleId: finding.ruleId,
    problemStatement: problem,
    location,
    severity: finding.severity,
    severityRationale: sevRationale,
    fixGuidance,
    acceptanceCriteria: acceptance,
    generatedAt,
  };

  // Apply redaction before any output (§5.4 — no secret republished into an issue)
  const redactedJson = redact(packJson) as RemediationPackJson;

  const markdown = buildMarkdown(redactedJson, missingDocNote);
  const prompt = buildPrompt(redactedJson);

  return { json: redactedJson, markdown, prompt };
}

function buildMarkdown(pack: RemediationPackJson, missingDocNote: string): string {
  return `# Remediation Pack — ${pack.ruleId}

**Finding ID:** \`${pack.id}\`
**Severity:** ${pack.severity}
**Generated:** ${pack.generatedAt}

## Problem

${pack.problemStatement}

## Affected Location

\`${pack.location}\`

## Severity Rationale

${pack.severityRationale}

## Fix Pattern

${pack.fixGuidance}${missingDocNote}

## Acceptance Criteria

This finding is resolved when the following no longer fires on re-scan:

- **Rule ID:** \`${pack.acceptanceCriteria.ruleId}\`
- **Fingerprint:** \`${pack.acceptanceCriteria.fingerprint}\`

${pack.acceptanceCriteria.description}
`;
}

function buildPrompt(pack: RemediationPackJson): string {
  return `You are fixing a security finding in this repository.

## Finding

- **Rule:** \`${pack.ruleId}\`
- **Severity:** ${pack.severity}
- **Location:** \`${pack.location}\`

## Problem

${pack.problemStatement}

## Fix

${pack.fixGuidance}

## Acceptance Criteria

After your fix, run \`audit run\` and verify that the finding with:
- ruleId: \`${pack.acceptanceCriteria.ruleId}\`
- fingerprint: \`${pack.acceptanceCriteria.fingerprint}\`

no longer appears in the output. The fix is complete only when this fingerprint is absent from a full, successful scan.
`;
}
