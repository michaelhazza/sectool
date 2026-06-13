/**
 * benchmark/fix-workflow-doc.test.ts
 *
 * Asserts that docs/fix-workflow.md contains all required headings mandated by
 * the P8-6 acceptance contract (external review LOW-2 / plan §P8-6).
 *
 * Each assertion uses toMatch(/regex/) so the check is grep-equivalent and
 * survives minor wording changes inside a heading while still catching a
 * missing heading entirely.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOC_PATH = resolve(__dirname, '..', 'docs', 'fix-workflow.md');

const content = readFileSync(DOC_PATH, 'utf-8');

describe('docs/fix-workflow.md heading contract (P8-6 / LOW-2)', () => {
  it('has a heading for the required audit-fix label', () => {
    expect(content).toMatch(/^##\s+.*(audit-fix.*[Ll]abel|[Ll]abel.*audit-fix)/im);
  });

  it('has a heading for Claude Code action setup', () => {
    expect(content).toMatch(/^##\s+.*Claude Code Action/im);
  });

  it('has a heading covering AUDIT_GITHUB_FIX_TOKEN and issues:write scope', () => {
    expect(content).toMatch(/^##\s+.*AUDIT_GITHUB_FIX_TOKEN/im);
  });

  it('documents issues:write as the required scope and never contents:write', () => {
    expect(content).toMatch(/issues:write/);
    expect(content).toMatch(/contents:write/);
    // "never contents:write" — the word "Never" (or "never") must appear near
    // "contents:write" to express the prohibition
    expect(content).toMatch(/[Nn]ever.*contents:write|contents:write.*[Nn]ever/);
  });

  it('has a heading for the issue marker format (fingerprint marker)', () => {
    expect(content).toMatch(/^##\s+.*[Mm]arker/im);
  });

  it('documents the exact fingerprint marker format', () => {
    // <!-- audit-fix:<fingerprint>:initial --> must appear literally
    expect(content).toMatch(/<!--\s*audit-fix:<fingerprint>:initial\s*-->/);
  });

  it('has a heading for the expected PR-reference format', () => {
    expect(content).toMatch(/^##\s+.*PR.{0,20}[Ff]ormat|^##\s+.*[Ff]ormat.{0,20}PR/im);
  });

  it('has a heading covering the 6 remediation states', () => {
    expect(content).toMatch(/^##\s+.*6 Remediation States|^##\s+.*Remediation States/im);
  });

  it('documents all 6 fix-request state names', () => {
    const states = [
      'requested',
      'in-progress',
      'awaiting-review',
      'merged-awaiting-verification',
      'verified-fixed',
      'reopened',
    ];
    for (const state of states) {
      expect(content, `missing state: ${state}`).toMatch(state);
    }
  });

  it('has a heading for the manual fallback paste-prompt flow', () => {
    expect(content).toMatch(/^##\s+.*[Mm]anual [Ff]allback|^##\s+.*[Pp]aste.{0,20}[Pp]rompt/im);
  });
});
