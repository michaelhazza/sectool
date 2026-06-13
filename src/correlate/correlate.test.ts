import { describe, expect, it } from 'vitest';
import { correlate } from './correlate.js';
import type { Finding } from '../schemas/finding.js';
import type { TargetRegistry } from '../schemas/targets.js';

// ---------------------------------------------------------------------------
// Helpers — minimal valid Finding factories
// ---------------------------------------------------------------------------

function makeStaticFinding(overrides: Partial<Finding> = {}): Finding {
  const fp = 'a'.repeat(64);
  return {
    id: `f-${'a'.repeat(16)}`,
    fingerprint: fp,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    evidence: { snippet: 'db.execute(sql`...`)', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    target: { kind: 'repo', name: 'automation-v1' },
    location: { path: 'src/db/queries.ts', symbol: 'GET /api/users/:id' },
    ...overrides,
  } as Finding;
}

function makeLiveFinding(overrides: Partial<Finding> = {}): Finding {
  const fp = 'b'.repeat(64);
  return {
    id: `f-${'b'.repeat(16)}`,
    fingerprint: fp,
    ruleId: 'LIVE-SQL-001',
    source: 'zap',
    surface: 'live',
    vulnClass: 'injection',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'probable',
    evidence: { snippet: undefined, cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-06-13T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    target: { kind: 'staging', host: 'staging.automation.breakout.dev' },
    location: {
      url: 'https://staging.automation.breakout.dev/api/users/42',
      method: 'GET',
    },
    ...overrides,
  } as Finding;
}

// Registry that links staging host → repo "automation-v1"
const baseRegistry: TargetRegistry = {
  repos: [
    {
      name: 'automation-v1',
      gitUrl: 'https://github.com/org/automation-v1.git',
      localPath: null,
      stackTags: ['express'],
      publicRoutes: [],
      enabled: true,
    },
  ],
  stagingTargets: [
    {
      name: 'automation-v1-staging',
      url: 'https://staging.automation.breakout.dev',
      repo: 'automation-v1',
      activeScan: false,
      enabled: true,
      rateLimitRps: 10,
    },
  ],
};

// ---------------------------------------------------------------------------
// §9 — correlating pair: all three criteria satisfied
// ---------------------------------------------------------------------------

describe('correlate — matching static+live pair (§9)', () => {
  it('populates correlatedWith on both sides', () => {
    const sf = makeStaticFinding();
    const lf = makeLiveFinding();
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    const resultLive = result.find((f) => f.surface === 'live');

    expect(resultStatic?.correlatedWith).toContain(lf.id);
    expect(resultLive?.correlatedWith).toContain(sf.id);
  });

  it('raises severity on the static finding by one level', () => {
    // baseSeverity medium → live-confirmed → high
    const sf = makeStaticFinding({ baseSeverity: 'medium', severity: 'medium' });
    const lf = makeLiveFinding();
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.severity).toBe('high');
  });

  it('sets confidence to confirmed on the static finding', () => {
    const sf = makeStaticFinding({ confidence: 'probable' });
    const lf = makeLiveFinding();
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.confidence).toBe('confirmed');
  });

  it('does not change live finding severity (severity recompute is for static only)', () => {
    const sf = makeStaticFinding();
    const lf = makeLiveFinding({ baseSeverity: 'medium', severity: 'medium' });
    const result = correlate([sf, lf], baseRegistry);

    const resultLive = result.find((f) => f.surface === 'live');
    expect(resultLive?.severity).toBe('medium');
  });

  it('path with numeric segment in live URL matches :param in static symbol', () => {
    // Live URL has /42; static symbol has :id — both normalize to {id}
    const sf = makeStaticFinding({ location: { path: 'src/routes.ts', symbol: 'GET /api/users/:id' } });
    const lf = makeLiveFinding({ location: { url: 'https://staging.automation.breakout.dev/api/users/42', method: 'GET' } });
    const result = correlate([sf, lf], baseRegistry);
    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.correlatedWith).toContain(lf.id);
  });
});

// ---------------------------------------------------------------------------
// §9 — non-correlating pairs (each criterion violated separately)
// ---------------------------------------------------------------------------

describe('correlate — non-correlating pair: different vulnClass (§9 criterion 2)', () => {
  it('does not correlate when vulnClass differs', () => {
    const sf = makeStaticFinding({ vulnClass: 'injection' });
    const lf = makeLiveFinding({ vulnClass: 'xss' });
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    const resultLive = result.find((f) => f.surface === 'live');
    expect(resultStatic?.correlatedWith).toHaveLength(0);
    expect(resultLive?.correlatedWith).toHaveLength(0);
  });
});

describe('correlate — non-correlating pair: unlinked target (§9 criterion 1)', () => {
  it('does not correlate when staging target is not linked to the repo', () => {
    // Different registry — staging repo links to "other-repo", not "automation-v1"
    const unlinkedRegistry: TargetRegistry = {
      ...baseRegistry,
      stagingTargets: [
        {
          name: 'other-staging',
          url: 'https://staging.automation.breakout.dev',
          repo: 'other-repo',
          activeScan: false,
          enabled: true,
          rateLimitRps: 10,
        },
      ],
    };
    const sf = makeStaticFinding();
    const lf = makeLiveFinding();
    const result = correlate([sf, lf], unlinkedRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.correlatedWith).toHaveLength(0);
  });
});

describe('correlate — non-correlating pair: location mismatch (§9 criterion 3)', () => {
  it('does not correlate when method differs', () => {
    const sf = makeStaticFinding({ location: { path: 'src/routes.ts', symbol: 'POST /api/users/:id' } });
    const lf = makeLiveFinding({ location: { url: 'https://staging.automation.breakout.dev/api/users/42', method: 'GET' } });
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.correlatedWith).toHaveLength(0);
  });

  it('does not correlate when path differs', () => {
    const sf = makeStaticFinding({ location: { path: 'src/routes.ts', symbol: 'GET /api/posts/:id' } });
    const lf = makeLiveFinding({ location: { url: 'https://staging.automation.breakout.dev/api/users/42', method: 'GET' } });
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.correlatedWith).toHaveLength(0);
  });

  it('does not correlate when static symbol is not a route signature', () => {
    // Schema-level rule — symbol is a table name, not a route
    const sf = makeStaticFinding({
      ruleId: 'BS-RLS-001',
      vulnClass: 'tenant-isolation',
      location: { path: 'src/db/schema.ts', symbol: 'users' },
    });
    const lf = makeLiveFinding({ vulnClass: 'tenant-isolation' });
    const result = correlate([sf, lf], baseRegistry);

    const resultStatic = result.find((f) => f.surface === 'static');
    expect(resultStatic?.correlatedWith).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dedupe — deterministic output under shuffled input (§9)
// ---------------------------------------------------------------------------

describe('correlate — deterministic output regardless of input order (§9)', () => {
  it('produces the same correlatedWith ids whether input is [static, live] or [live, static]', () => {
    const sf = makeStaticFinding();
    const lf = makeLiveFinding();

    const result1 = correlate([sf, lf], baseRegistry);
    const result2 = correlate([lf, sf], baseRegistry);

    const static1 = result1.find((f) => f.surface === 'static');
    const static2 = result2.find((f) => f.surface === 'static');

    expect(static1?.correlatedWith).toEqual(static2?.correlatedWith);
  });

  it('a finding is not duplicated in correlatedWith when correlate is called twice', () => {
    // Calling correlate twice on already-correlated findings should not double-append
    const sf = makeStaticFinding();
    const lf = makeLiveFinding();
    const once = correlate([sf, lf], baseRegistry);
    const twice = correlate(once, baseRegistry);

    const staticTwice = twice.find((f) => f.surface === 'static');
    expect(staticTwice?.correlatedWith.filter((id) => id === lf.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple findings — only matching pairs correlate
// ---------------------------------------------------------------------------

describe('correlate — only matching pairs correlate when multiple findings present', () => {
  it('a non-matching static finding is untouched when a matching one is present', () => {
    // sf1 matches lf; sf2 does not (different path)
    const sf1 = makeStaticFinding();
    const sf2 = makeStaticFinding({
      fingerprint: 'c'.repeat(64),
      id: `f-${'c'.repeat(16)}`,
      location: { path: 'src/routes.ts', symbol: 'POST /api/orders' },
    });
    const lf = makeLiveFinding();

    const result = correlate([sf1, sf2, lf], baseRegistry);

    const r1 = result.find((f) => f.fingerprint === sf1.fingerprint);
    const r2 = result.find((f) => f.fingerprint === sf2.fingerprint);
    expect(r1?.correlatedWith).toContain(lf.id);
    expect(r2?.correlatedWith).toHaveLength(0);
  });
});
