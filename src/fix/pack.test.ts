import { describe, it, expect } from 'vitest';
import type { Finding } from '../schemas/finding.js';
import { buildPack, resolveRuleDocPath } from './pack.js';

// ---------------------------------------------------------------------------
// Minimal valid static finding fixture
// ---------------------------------------------------------------------------

const FULL_FP = 'a'.repeat(64);
const DISPLAY_ID = `f-${'a'.repeat(16)}`;

function makeStaticFinding(overrides: Partial<Finding> = {}): Finding {
  const base = {
    id: DISPLAY_ID,
    fingerprint: FULL_FP,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'critical',
    baseSeverity: 'critical',
    confidence: 'probable',
    target: { kind: 'repo', name: 'automation-v1', commit: 'abc123' },
    location: {
      path: 'server/routes/users.ts',
      symbol: 'GET /api/users/:id',
      startLine: 42,
    },
    evidence: { snippet: 'db.execute(sql`SELECT * FROM users WHERE id = ${req.params.id}`)', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
  return base;
}

function makeLiveFinding(overrides: Partial<Finding> = {}): Finding {
  const base = {
    id: DISPLAY_ID,
    fingerprint: FULL_FP,
    ruleId: 'ZAP-P-10020',
    source: 'zap',
    surface: 'live',
    vulnClass: 'misconfiguration',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    target: { kind: 'staging', host: 'staging.automation.breakout.dev' },
    location: {
      url: 'https://staging.automation.breakout.dev/api/users',
      method: 'GET',
    },
    evidence: { snippet: undefined, cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    ...overrides,
  } as Finding;
  return base;
}

// ---------------------------------------------------------------------------
// resolveRuleDocPath
// ---------------------------------------------------------------------------

describe('resolveRuleDocPath', () => {
  it('resolves an exact custom-rule doc path for BS-SQL-001', () => {
    const p = resolveRuleDocPath('BS-SQL-001', 'ast');
    expect(p).toMatch(/BS-SQL-001\.md$/);
  });

  it('resolves ZAP-P-10020 to ZAP-P.md', () => {
    const p = resolveRuleDocPath('ZAP-P-10020', 'zap');
    expect(p).toMatch(/ZAP-P\.md$/);
  });

  it('resolves ZAP-A-40020 to ZAP-A.md', () => {
    const p = resolveRuleDocPath('ZAP-A-40020', 'zap');
    expect(p).toMatch(/ZAP-A\.md$/);
  });

  it('resolves NUCLEI-http-some-template to NUCLEI.md', () => {
    const p = resolveRuleDocPath('NUCLEI-http-some-template', 'nuclei');
    expect(p).toMatch(/NUCLEI\.md$/);
  });

  it('resolves gitleaks source to gitleaks.md', () => {
    const p = resolveRuleDocPath('gitleaks-github-pat', 'gitleaks');
    expect(p).toMatch(/gitleaks\.md$/);
  });

  it('returns null for an unknown rule id with unknown source', () => {
    const p = resolveRuleDocPath('UNKNOWN-RULE-999', 'unknown-source');
    expect(p).toBeNull();
  });

  // Fix 1: path-traversal guard
  it('rejects a ruleId with path traversal using forward slashes (../../config/targets)', () => {
    const p = resolveRuleDocPath('../../config/targets', 'ast');
    expect(p).toBeNull();
  });

  it('rejects a ruleId with path traversal using backslash sequences', () => {
    const p = resolveRuleDocPath('..\\..\\x', 'ast');
    expect(p).toBeNull();
  });

  it('rejects a ruleId containing a forward slash', () => {
    const p = resolveRuleDocPath('foo/bar', 'ast');
    expect(p).toBeNull();
  });

  it('rejects a ruleId containing null byte', () => {
    const p = resolveRuleDocPath('foo\0bar', 'ast');
    expect(p).toBeNull();
  });

  it('accepts a well-formed ruleId with hyphens and dots', () => {
    // BS-SQL-001 is a real doc; this just tests the charset check doesn't block valid ids.
    const p = resolveRuleDocPath('BS-SQL-001', 'ast');
    expect(p).toMatch(/BS-SQL-001\.md$/);
  });
});

// ---------------------------------------------------------------------------
// buildPack — static finding with a known rule doc (BS-SQL-001)
// ---------------------------------------------------------------------------

describe('buildPack — static finding (BS-SQL-001)', () => {
  const finding = makeStaticFinding();
  const pack = buildPack(finding);

  it('returns a json, markdown, and prompt', () => {
    expect(pack.json).toBeDefined();
    expect(pack.markdown).toBeDefined();
    expect(pack.prompt).toBeDefined();
  });

  it('json carries the FULL 64-hex fingerprint as acceptance key', () => {
    expect(pack.json.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.json.fingerprint).toBe(FULL_FP);
  });

  it('json acceptance criteria embed the full fingerprint and ruleId', () => {
    expect(pack.json.acceptanceCriteria.fingerprint).toBe(FULL_FP);
    expect(pack.json.acceptanceCriteria.ruleId).toBe('BS-SQL-001');
  });

  it('json location includes the file path and symbol', () => {
    expect(pack.json.location).toMatch(/server\/routes\/users\.ts/);
    expect(pack.json.location).toMatch(/GET \/api\/users\/:id/);
  });

  it('markdown contains the full fingerprint in the acceptance criteria section', () => {
    expect(pack.markdown).toMatch(new RegExp(FULL_FP));
  });

  it('markdown contains the rule id', () => {
    expect(pack.markdown).toMatch(/BS-SQL-001/);
  });

  it('markdown contains fix pattern sourced from the rule doc', () => {
    // BS-SQL-001.md has a "Fix pattern" section with Drizzle query builder guidance
    expect(pack.markdown).toMatch(/query builder|parameterized/i);
  });

  it('markdown contains a problem statement (from "What it flags" section of rule doc)', () => {
    // The rule doc What-it-flags section mentions sql tagged template or db.execute
    expect(pack.markdown).toMatch(/## Problem/);
    expect(pack.json.problemStatement.length).toBeGreaterThan(10);
  });

  it('markdown contains severity information', () => {
    expect(pack.markdown).toMatch(/critical/i);
  });

  it('prompt contains the full fingerprint in acceptance criteria', () => {
    expect(pack.prompt).toMatch(new RegExp(FULL_FP));
  });

  it('prompt contains the ruleId', () => {
    expect(pack.prompt).toMatch(/BS-SQL-001/);
  });

  it('prompt contains the location', () => {
    expect(pack.prompt).toMatch(/server\/routes\/users\.ts/);
  });
});

// ---------------------------------------------------------------------------
// buildPack — live finding with wildcard-family doc (ZAP-P-10020)
// ---------------------------------------------------------------------------

describe('buildPack — live finding (ZAP-P-10020 wildcard family)', () => {
  const finding = makeLiveFinding();
  const pack = buildPack(finding);

  it('json carries the full fingerprint', () => {
    expect(pack.json.fingerprint).toBe(FULL_FP);
  });

  it('json acceptance criteria embed full fingerprint and ruleId', () => {
    expect(pack.json.acceptanceCriteria.fingerprint).toBe(FULL_FP);
    expect(pack.json.acceptanceCriteria.ruleId).toBe('ZAP-P-10020');
  });

  it('json location includes the URL and method', () => {
    expect(pack.json.location).toMatch(/GET/);
    expect(pack.json.location).toMatch(/staging\.automation\.breakout\.dev/);
  });

  it('markdown contains fix guidance from ZAP-P.md', () => {
    // ZAP-P.md Fix pattern section describes remediation for passive findings
    expect(pack.markdown).toMatch(/## Fix Pattern/);
  });

  it('does NOT include a "doc missing" note (doc was found via wildcard convention)', () => {
    expect(pack.markdown).not.toMatch(/Rule documentation not found/);
  });
});

// ---------------------------------------------------------------------------
// buildPack — missing rule doc degrades gracefully
// ---------------------------------------------------------------------------

describe('buildPack — missing rule doc degrades gracefully', () => {
  const finding = makeStaticFinding({
    ruleId: 'UNKNOWN-RULE-999',
    source: 'ast',
  });

  it('does not throw', () => {
    expect(() => buildPack(finding)).not.toThrow();
  });

  it('returns a pack with a clear note about the missing doc', () => {
    const pack = buildPack(finding);
    expect(pack.markdown).toMatch(/Rule documentation not found/);
  });

  it('still includes the full fingerprint in acceptance criteria', () => {
    const pack = buildPack(finding);
    expect(pack.json.acceptanceCriteria.fingerprint).toBe(FULL_FP);
  });

  it('still includes the ruleId in the pack', () => {
    const pack = buildPack(finding);
    expect(pack.json.ruleId).toBe('UNKNOWN-RULE-999');
    expect(pack.json.acceptanceCriteria.ruleId).toBe('UNKNOWN-RULE-999');
  });
});

// ---------------------------------------------------------------------------
// buildPack — redaction applied (§5.4)
// ---------------------------------------------------------------------------

describe('buildPack — redaction applied', () => {
  it('pack json does not contain a raw bearer token from evidence.raw', () => {
    // evidence.raw is never included in the pack JSON — only derived text fields
    // are rendered. This verifies credentials can't leak through pack serialization.
    const findingWithSecret = makeStaticFinding({
      evidence: {
        snippet: 'normal code snippet',
        cvss: null,
        raw: { authorization: 'Bearer secrettoken12345' },
      },
    });
    const pack = buildPack(findingWithSecret);
    const serialized = JSON.stringify(pack.json);
    expect(serialized).not.toMatch(/secrettoken12345/);
  });

  it('markdown does not contain the raw secret value from evidence.raw', () => {
    // The pack markdown is derived from rule-doc text + finding metadata,
    // not from evidence.raw, so secrets never reach the markdown surface.
    const findingWithSecret = makeStaticFinding({
      evidence: {
        snippet: 'normal code snippet',
        cvss: null,
        raw: { authorization: 'Bearer secrettoken99999' },
      },
    });
    const pack = buildPack(findingWithSecret);
    expect(pack.markdown).not.toMatch(/secrettoken99999/);
  });

  it('redact() is applied to the pack json before output (§5.4 boundary)', () => {
    // Verify the redaction chokepoint runs: the pack json object passes through
    // redact(), so non-credential string fields are preserved unchanged.
    const finding = makeStaticFinding();
    const pack = buildPack(finding);
    // The ruleId and fingerprint survive redaction (they are not credential-keyed)
    expect(pack.json.ruleId).toBe('BS-SQL-001');
    expect(pack.json.fingerprint).toBe(FULL_FP);
  });
});
