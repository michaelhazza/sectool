/**
 * rule-docs.test.ts — P6-3 docs-completeness check
 *
 * Asserts that every canonical check id in CANONICAL_CHECK_IDS has exactly
 * one corresponding docs/rules/<id>.md file.
 *
 * Filename convention for wildcard families:
 *   ZAP-P-*  → docs/rules/ZAP-P.md
 *   ZAP-A-*  → docs/rules/ZAP-A.md
 *   NUCLEI-* → docs/rules/NUCLEI.md
 *
 * All other ids map directly: <id> → docs/rules/<id>.md
 *
 * This test imports CANONICAL_CHECK_IDS from benchmark/run.ts — the same
 * source of truth used by the P6-1 corpus cross-check — so docs coverage
 * and corpus coverage are always reconciled against the same id set.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CANONICAL_CHECK_IDS } from './run.js';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(_moduleDir, '..');
const DOCS_RULES_DIR = join(REPO_ROOT, 'docs', 'rules');

/**
 * Derive the expected docs/rules/ filename for a canonical check id.
 *
 * Wildcard families end with '-*'; strip that suffix to get the base filename.
 * All other ids map directly to '<id>.md'.
 */
function docFilenameForId(id: string): string {
  const base = id.endsWith('-*') ? id.slice(0, -2) : id;
  return `${base}.md`;
}

describe('rule docs completeness (P6-3)', () => {
  it('every canonical check id has exactly one docs/rules/<id>.md', () => {
    const missing: string[] = [];

    for (const id of CANONICAL_CHECK_IDS) {
      const filename = docFilenameForId(id);
      const fullPath = join(DOCS_RULES_DIR, filename);
      if (!existsSync(fullPath)) {
        missing.push(`${id} → expected docs/rules/${filename}`);
      }
    }

    if (missing.length > 0) {
      // Surface all missing docs in one failure message for easier triage
      expect.fail(
        `Missing rule docs for ${String(missing.length)} canonical id(s):\n` +
          missing.map((m) => `  ${m}`).join('\n'),
      );
    }
  });

  it('docs filename convention: wildcard families strip -* suffix', () => {
    expect(docFilenameForId('ZAP-P-*')).toBe('ZAP-P.md');
    expect(docFilenameForId('ZAP-A-*')).toBe('ZAP-A.md');
    expect(docFilenameForId('NUCLEI-*')).toBe('NUCLEI.md');
  });

  it('docs filename convention: non-wildcard ids map directly', () => {
    expect(docFilenameForId('BS-SQL-001')).toBe('BS-SQL-001.md');
    expect(docFilenameForId('LIVE-TLS-001')).toBe('LIVE-TLS-001.md');
    expect(docFilenameForId('semgrep')).toBe('semgrep.md');
    expect(docFilenameForId('gitleaks')).toBe('gitleaks.md');
    expect(docFilenameForId('osv')).toBe('osv.md');
  });
});
