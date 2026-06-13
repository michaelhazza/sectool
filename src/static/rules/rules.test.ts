/**
 * P3-1 colocated tests for BS-SQL-001, BS-SQL-002, BS-RLS-001.
 *
 * Each rule is tested against:
 *   - benchmark/corpus/static/<RULE-ID>/vulnerable/ → must produce ≥ 1 finding (recall)
 *   - benchmark/corpus/static/<RULE-ID>/clean/      → must produce 0 findings (precision)
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run as runSql001 } from './BS-SQL-001.js';
import { run as runSql002 } from './BS-SQL-002.js';
import { run as runRls001 } from './BS-RLS-001.js';

const _dir = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(_dir, '..', '..', '..', 'benchmark', 'corpus', 'static');

// ---------------------------------------------------------------------------
// BS-SQL-001
// ---------------------------------------------------------------------------

describe('BS-SQL-001 — SQL injection via request-derived interpolation', () => {
  const vulnDir = join(CORPUS, 'BS-SQL-001', 'vulnerable');
  const cleanDir = join(CORPUS, 'BS-SQL-001', 'clean');

  it('flags vulnerable fixture (recall)', () => {
    const findings = runSql001(vulnDir, 'test-repo');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.ruleId === 'BS-SQL-001')).toBe(true);
    expect(findings.every((f) => f.vulnClass === 'injection')).toBe(true);
    expect(findings.every((f) => f.surface === 'static')).toBe(true);
    expect(findings.every((f) => f.source === 'ast')).toBe(true);
  });

  it('produces zero findings on clean fixture (precision)', () => {
    const findings = runSql001(cleanDir, 'test-repo');
    expect(findings).toHaveLength(0);
  });

  it('findings have valid fingerprint format', () => {
    const findings = runSql001(vulnDir, 'test-repo');
    for (const f of findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.id).toMatch(new RegExp(`^f-${f.fingerprint.slice(0, 16)}$`));
    }
  });
});

// ---------------------------------------------------------------------------
// BS-SQL-002
// ---------------------------------------------------------------------------

describe('BS-SQL-002 — tenant table queries bypassing scoped helper', () => {
  const vulnDir = join(CORPUS, 'BS-SQL-002', 'vulnerable');
  const cleanDir = join(CORPUS, 'BS-SQL-002', 'clean');

  it('flags vulnerable fixture (recall)', () => {
    const findings = runSql002(vulnDir, 'test-repo');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.ruleId === 'BS-SQL-002')).toBe(true);
    expect(findings.every((f) => f.vulnClass === 'tenant-isolation')).toBe(true);
    expect(findings.every((f) => f.surface === 'static')).toBe(true);
  });

  it('produces zero findings on clean fixture (precision)', () => {
    const findings = runSql002(cleanDir, 'test-repo');
    expect(findings).toHaveLength(0);
  });

  it('findings have valid fingerprint format', () => {
    const findings = runSql002(vulnDir, 'test-repo');
    for (const f of findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// BS-RLS-001
// ---------------------------------------------------------------------------

describe('BS-RLS-001 — tenant table without RLS policy in migrations', () => {
  const vulnDir = join(CORPUS, 'BS-RLS-001', 'vulnerable');
  const cleanDir = join(CORPUS, 'BS-RLS-001', 'clean');

  it('flags vulnerable fixture (recall)', () => {
    const findings = runRls001(vulnDir, 'test-repo');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.ruleId === 'BS-RLS-001')).toBe(true);
    expect(findings.every((f) => f.vulnClass === 'tenant-isolation')).toBe(true);
    expect(findings.every((f) => f.surface === 'static')).toBe(true);
  });

  it('produces zero findings on clean fixture (precision)', () => {
    const findings = runRls001(cleanDir, 'test-repo');
    expect(findings).toHaveLength(0);
  });

  it('symbol is the normalized pgTable name (§6.6 schema-rule fingerprint)', () => {
    const findings = runRls001(vulnDir, 'test-repo');
    // Both subscriptions and users tables should appear; symbol is lowercased table name
    const symbols = findings
      .filter((f) => f.surface === 'static')
      .map((f) => (f as { location: { symbol: string } }).location.symbol);
    expect(symbols).toContain('subscriptions');
    expect(symbols).toContain('users');
  });

  it('findings have valid fingerprint format', () => {
    const findings = runRls001(vulnDir, 'test-repo');
    for (const f of findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
    }
  });
});
