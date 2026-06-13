/**
 * P3-3 — Structural validation of the four custom Semgrep YAML rules.
 *
 * Validates each rule file as raw text (regex assertions) so no untyped
 * YAML parser dependency is needed. Checks that every file declares the
 * expected BS-* rule id, a message, a severity, and the required metadata
 * fields for integration with the semgrep wrapper (§7.1/§7.2).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'semgrep');

function readRule(filename: string): string {
  return readFileSync(join(RULES_DIR, filename), 'utf-8');
}

// ---------------------------------------------------------------------------
// BS-AUTH-002
// ---------------------------------------------------------------------------

describe('BS-AUTH-002.yaml', () => {
  const content = readRule('BS-AUTH-002.yaml');

  it('declares the BS-AUTH-002 rule id', () => {
    expect(content).toMatch(/id:\s+BS-AUTH-002/);
  });

  it('has a message', () => {
    expect(content).toMatch(/message:/);
  });

  it('has WARNING severity', () => {
    expect(content).toMatch(/severity:\s+WARNING/);
  });

  it('has bs-rule-id metadata matching BS-AUTH-002', () => {
    expect(content).toMatch(/bs-rule-id:\s+BS-AUTH-002/);
  });

  it('has bs-vuln-class metadata', () => {
    expect(content).toMatch(/bs-vuln-class:\s+auth-access-control/);
  });

  it('targets javascript and typescript', () => {
    expect(content).toMatch(/languages:/);
    expect(content).toMatch(/javascript/);
    expect(content).toMatch(/typescript/);
  });
});

// ---------------------------------------------------------------------------
// BS-JWT-001
// ---------------------------------------------------------------------------

describe('BS-JWT-001.yaml', () => {
  const content = readRule('BS-JWT-001.yaml');

  it('covers algorithm pinning (BS-JWT-001-algorithm)', () => {
    expect(content).toMatch(/id:\s+BS-JWT-001-algorithm/);
  });

  it('covers expiry check (BS-JWT-001-expiry)', () => {
    expect(content).toMatch(/id:\s+BS-JWT-001-expiry/);
  });

  it('covers literal secret check (BS-JWT-001-literal-secret)', () => {
    expect(content).toMatch(/id:\s+BS-JWT-001-literal-secret/);
  });

  it('has bs-rule-id metadata matching BS-JWT-001 in all sub-rules', () => {
    const matches = content.match(/bs-rule-id:\s+BS-JWT-001/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('has ERROR severity', () => {
    expect(content).toMatch(/severity:\s+ERROR/);
  });

  it('targets javascript and typescript', () => {
    expect(content).toMatch(/languages:/);
    expect(content).toMatch(/javascript/);
    expect(content).toMatch(/typescript/);
  });
});

// ---------------------------------------------------------------------------
// BS-UPLOAD-001
// ---------------------------------------------------------------------------

describe('BS-UPLOAD-001.yaml', () => {
  const content = readRule('BS-UPLOAD-001.yaml');

  it('covers size-limit check (BS-UPLOAD-001-no-size-limit)', () => {
    expect(content).toMatch(/id:\s+BS-UPLOAD-001-no-size-limit/);
  });

  it('covers type-filter check (BS-UPLOAD-001-no-type-filter)', () => {
    expect(content).toMatch(/id:\s+BS-UPLOAD-001-no-type-filter/);
  });

  it('has bs-rule-id metadata matching BS-UPLOAD-001 in all sub-rules', () => {
    const matches = content.match(/bs-rule-id:\s+BS-UPLOAD-001/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('has WARNING severity', () => {
    expect(content).toMatch(/severity:\s+WARNING/);
  });

  it('targets javascript and typescript', () => {
    expect(content).toMatch(/languages:/);
    expect(content).toMatch(/javascript/);
    expect(content).toMatch(/typescript/);
  });
});

// ---------------------------------------------------------------------------
// BS-CORS-001
// ---------------------------------------------------------------------------

describe('BS-CORS-001.yaml', () => {
  const content = readRule('BS-CORS-001.yaml');

  it('covers wildcard origin (BS-CORS-001-wildcard)', () => {
    expect(content).toMatch(/id:\s+BS-CORS-001-wildcard/);
  });

  it('covers reflected origin (BS-CORS-001-reflected-origin)', () => {
    expect(content).toMatch(/id:\s+BS-CORS-001-reflected-origin/);
  });

  it('has bs-rule-id metadata matching BS-CORS-001 in all sub-rules', () => {
    const matches = content.match(/bs-rule-id:\s+BS-CORS-001/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('has ERROR severity', () => {
    expect(content).toMatch(/severity:\s+ERROR/);
  });

  it('targets javascript and typescript', () => {
    expect(content).toMatch(/languages:/);
    expect(content).toMatch(/javascript/);
    expect(content).toMatch(/typescript/);
  });
});

// ---------------------------------------------------------------------------
// Cross-rule: every rule file has required structural fields
// ---------------------------------------------------------------------------

describe('all semgrep rules — shared structural requirements', () => {
  const ruleFiles = [
    'BS-AUTH-002.yaml',
    'BS-JWT-001.yaml',
    'BS-UPLOAD-001.yaml',
    'BS-CORS-001.yaml',
  ];

  for (const filename of ruleFiles) {
    it(`${filename} starts with "rules:" (valid Semgrep YAML root)`, () => {
      const content = readRule(filename);
      expect(content.trimStart()).toMatch(/^rules:/);
    });

    it(`${filename} has at least one message field`, () => {
      const content = readRule(filename);
      expect(content).toMatch(/message:/);
    });

    it(`${filename} has metadata block with bs-base-severity`, () => {
      const content = readRule(filename);
      expect(content).toMatch(/bs-base-severity:/);
    });
  }
});
