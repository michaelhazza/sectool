import { describe, it, expect } from 'vitest';
import { TargetRegistrySchema } from './targets.js';
import { AllowlistSchema } from './allowlist.js';
import { BaselineSchema } from './baseline.js';
import { FindingSchema, VulnClassSchema, ScannerFamilySchema } from './finding.js';
import { FixStatusSchema, FixesFileSchema } from './fix.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_FINGERPRINT = 'a'.repeat(64);
const VALID_FINDING_ID = `f-${'a'.repeat(16)}`;

function validStaticFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_FINDING_ID,
    fingerprint: VALID_FINGERPRINT,
    ruleId: 'BS-SQL-001',
    source: 'ast',
    surface: 'static',
    vulnClass: 'injection',
    severity: 'high',
    baseSeverity: 'high',
    confidence: 'probable',
    evidence: { snippet: 'select *', cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-01-01T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    target: { kind: 'repo', name: 'my-repo' },
    location: { path: 'src/db.ts', symbol: 'getUser', startLine: 42 },
    ...overrides,
  };
}

function validLiveFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_FINDING_ID,
    fingerprint: VALID_FINGERPRINT,
    ruleId: 'LIVE-TLS-001',
    source: 'probe',
    surface: 'live',
    vulnClass: 'tls',
    severity: 'medium',
    baseSeverity: 'medium',
    confidence: 'confirmed',
    evidence: { cvss: null, raw: {} },
    reachability: 'unknown',
    correlatedWith: [],
    externalRefs: [],
    firstSeen: '2026-01-01T00:00:00.000Z',
    suppressed: false,
    suppression: null,
    note: null,
    target: { kind: 'staging', host: 'staging.example.com' },
    location: { url: 'https://staging.example.com/login', method: 'GET' },
    ...overrides,
  };
}

function validStagingTarget(overrides: Record<string, unknown> = {}) {
  return {
    name: 'my-staging',
    url: 'https://staging.example.com',
    repo: 'my-repo',
    activeScan: false,
    enabled: true,
    ...overrides,
  };
}

function validRegistry(stagingOverrides: Record<string, unknown> = {}) {
  return {
    repos: [],
    stagingTargets: [validStagingTarget(stagingOverrides)],
  };
}

const VALID_BASELINE_FINGERPRINT = 'b'.repeat(64);
const VALID_BASELINE_FINDING_ID = `f-${'b'.repeat(16)}`;

// ---------------------------------------------------------------------------
// rateLimitRps — clamped 1–25
// ---------------------------------------------------------------------------

describe('StagingTarget rateLimitRps', () => {
  it('accepts the default (10) when omitted', () => {
    const result = TargetRegistrySchema.safeParse(validRegistry());
    expect(result.success).toBe(true);
  });

  it('accepts the minimum (1)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({ rateLimitRps: 1 }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts the maximum (25)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({ rateLimitRps: 25 }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects 0 (below minimum)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({ rateLimitRps: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects 26 (above maximum)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({ rateLimitRps: 26 }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testUsers arity
// ---------------------------------------------------------------------------

const twoUsers = [
  { userEnv: 'USER_A', passEnv: 'PASS_A' },
  { userEnv: 'USER_B', passEnv: 'PASS_B' },
];

const oneUser = [{ userEnv: 'USER_A', passEnv: 'PASS_A' }];

function authConfig(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'form',
    loginPath: '/login',
    method: 'POST',
    userField: 'email',
    passField: 'password',
    bodyType: 'json',
    sessionCarrier: 'bearer',
    successCheck: { statusIn: [200], jsonHasKey: 'token' },
    testUsers: twoUsers,
    ...overrides,
  };
}

describe('testUsers arity — activeScan:true requires exactly 2', () => {
  it('accepts exactly 2 testUsers when activeScan is true', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: true,
        auth: authConfig({ testUsers: twoUsers }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects 1 testUser when activeScan is true', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: true,
        auth: authConfig({ testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects 3 testUsers when activeScan is true', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: true,
        auth: authConfig({
          testUsers: [...twoUsers, { userEnv: 'USER_C', passEnv: 'PASS_C' }],
        }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects activeScan:true with no auth', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({ activeScan: true, auth: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('testUsers arity — auth present, activeScan:false requires ≥1', () => {
  it('accepts 1 testUser when activeScan is false and auth is present', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts 2 testUsers when activeScan is false and auth is present', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ testUsers: twoUsers }),
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// carrier-aware successCheck
// ---------------------------------------------------------------------------

describe('carrier-aware successCheck', () => {
  it('bearer carrier: requires jsonHasKey — rejects when absent', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({
          sessionCarrier: 'bearer',
          successCheck: { statusIn: [200] },
          testUsers: oneUser,
        }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('bearer carrier: accepts when jsonHasKey is present', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({
          sessionCarrier: 'bearer',
          successCheck: { statusIn: [200], jsonHasKey: 'token' },
          testUsers: oneUser,
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('cookie carrier: does not require jsonHasKey', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({
          sessionCarrier: 'cookie',
          successCheck: { statusIn: [200] },
          testUsers: oneUser,
        }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('cookie carrier: accepts jsonHasKey when provided (optional)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({
          sessionCarrier: 'cookie',
          successCheck: { statusIn: [200], jsonHasKey: 'user' },
          testUsers: oneUser,
        }),
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allowlist host — rejects wildcard, CIDR, port, IP-literal
// ---------------------------------------------------------------------------

function allowlistWith(host: string) {
  return {
    hosts: [{ host, owner: 'team', addedAt: '2026-01-01' }],
  };
}

describe('Allowlist host validation', () => {
  it('accepts a valid DNS name', () => {
    const result = AllowlistSchema.safeParse(
      allowlistWith('staging.example.com'),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a wildcard host (*.example.com)', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('*.example.com'));
    expect(result.success).toBe(false);
  });

  it('rejects a CIDR block (192.168.0.0/24)', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('192.168.0.0/24'));
    expect(result.success).toBe(false);
  });

  it('rejects a host:port entry (staging.example.com:443)', () => {
    const result = AllowlistSchema.safeParse(
      allowlistWith('staging.example.com:443'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects dotted-decimal IPv4 (127.0.0.1)', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('127.0.0.1'));
    expect(result.success).toBe(false);
  });

  it('rejects hex IPv4 literal (0x7f000001)', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('0x7f000001'));
    expect(result.success).toBe(false);
  });

  it('rejects numeric IPv4 literal (2130706433)', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('2130706433'));
    expect(result.success).toBe(false);
  });

  it('rejects bracketed IPv6 ([::1])', () => {
    const result = AllowlistSchema.safeParse(allowlistWith('[::1]'));
    expect(result.success).toBe(false);
  });

  it('rejects bracketed IPv6 with mapped IPv4 ([::ffff:127.0.0.1])', () => {
    const result = AllowlistSchema.safeParse(
      allowlistWith('[::ffff:127.0.0.1]'),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitUrl scheme restriction — https only (audit H1)
// ---------------------------------------------------------------------------

function registryWithRepo(gitUrl: string) {
  return {
    repos: [
      {
        name: 'r',
        gitUrl,
        localPath: null,
        stackTags: [],
        publicRoutes: [],
        enabled: true,
      },
    ],
    stagingTargets: [],
  };
}

describe('RepoSchema name charset restriction (audit L2)', () => {
  function registryWithRepoName(name: string) {
    return {
      repos: [
        { name, gitUrl: 'https://github.com/org/repo.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true },
      ],
      stagingTargets: [],
    };
  }

  it('accepts a normal repo name', () => {
    expect(TargetRegistrySchema.safeParse(registryWithRepoName('automation-v1')).success).toBe(true);
  });

  it('accepts dots and underscores', () => {
    expect(TargetRegistrySchema.safeParse(registryWithRepoName('my.repo_v2')).success).toBe(true);
  });

  it('rejects a name containing a path separator', () => {
    expect(TargetRegistrySchema.safeParse(registryWithRepoName('a/b')).success).toBe(false);
  });

  it('rejects a name containing ".." traversal + separator', () => {
    expect(TargetRegistrySchema.safeParse(registryWithRepoName('../evil')).success).toBe(false);
  });

  it('rejects a name with whitespace', () => {
    expect(TargetRegistrySchema.safeParse(registryWithRepoName('bad name')).success).toBe(false);
  });
});

describe('RepoSchema gitUrl scheme restriction', () => {
  it('accepts an https git URL', () => {
    const result = TargetRegistrySchema.safeParse(
      registryWithRepo('https://github.com/org/repo.git'),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an ext:: transport (command execution on clone host)', () => {
    const result = TargetRegistrySchema.safeParse(
      registryWithRepo('ext::sh -c "id"'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a file:// transport (local filesystem read)', () => {
    const result = TargetRegistrySchema.safeParse(
      registryWithRepo('file:///etc/passwd'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an ssh:// transport', () => {
    const result = TargetRegistrySchema.safeParse(
      registryWithRepo('ssh://git@github.com/org/repo.git'),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a plain http:// git URL', () => {
    const result = TargetRegistrySchema.safeParse(
      registryWithRepo('http://github.com/org/repo.git'),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loginPath must be root-relative (credential host-swap hardening — audit M2)
// ---------------------------------------------------------------------------

describe('AuthForm loginPath root-relative constraint', () => {
  it('accepts a normal root-relative path', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ loginPath: '/login', testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a host-swapping path (.evil.com/login)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ loginPath: '.evil.com/login', testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a protocol-relative path (//evil.com/login)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ loginPath: '//evil.com/login', testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a backslash path (\\evil.com/login)', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ loginPath: '\\evil.com/login', testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an absolute URL as loginPath', () => {
    const result = TargetRegistrySchema.safeParse(
      validRegistry({
        activeScan: false,
        auth: authConfig({ loginPath: 'https://evil.com/login', testUsers: oneUser }),
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline — rejects truncated-findingId-only, rejects mismatched findingId
// ---------------------------------------------------------------------------

function validBaselineEntry(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: VALID_BASELINE_FINGERPRINT,
    ruleId: 'BS-SQL-001',
    target: { kind: 'repo', name: 'my-repo' },
    justification: 'Known safe path',
    expiry: '2027-01-01',
    approvedBy: 'alice',
    ...overrides,
  };
}

describe('Baseline schema', () => {
  it('accepts a valid entry without findingId', () => {
    const result = BaselineSchema.safeParse({
      entries: [validBaselineEntry()],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid entry with a matching findingId', () => {
    const result = BaselineSchema.safeParse({
      entries: [
        validBaselineEntry({ findingId: VALID_BASELINE_FINDING_ID }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a mismatched findingId (wrong prefix)', () => {
    const result = BaselineSchema.safeParse({
      entries: [
        validBaselineEntry({ findingId: `f-${'c'.repeat(16)}` }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a findingId with wrong format (too short)', () => {
    const result = BaselineSchema.safeParse({
      entries: [
        validBaselineEntry({ findingId: 'f-short' }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an entry whose fingerprint is not 64 hex chars', () => {
    const result = BaselineSchema.safeParse({
      entries: [
        validBaselineEntry({ fingerprint: 'a'.repeat(16) }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty entries array that has a truncated-id-only entry (no fingerprint)', () => {
    // Truncated findingId-only means findingId present but fingerprint missing/invalid
    const result = BaselineSchema.safeParse({
      entries: [
        {
          findingId: VALID_BASELINE_FINDING_ID,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'my-repo' },
          justification: 'test',
          expiry: '2027-01-01',
          approvedBy: 'alice',
          // fingerprint absent — should fail because fingerprint is required
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vulnClass closed enum
// ---------------------------------------------------------------------------

describe('VulnClass closed enum', () => {
  const validClasses = [
    'injection',
    'auth-access-control',
    'tenant-isolation',
    'secrets',
    'dependency-cve',
    'misconfiguration',
    'xss',
    'csrf',
    'open-redirect',
    'info-disclosure',
    'tls',
    'session-management',
  ] as const;

  for (const cls of validClasses) {
    it(`accepts "${cls}"`, () => {
      expect(VulnClassSchema.safeParse(cls).success).toBe(true);
    });
  }

  it('rejects an unknown vulnClass', () => {
    expect(VulnClassSchema.safeParse('rce').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(VulnClassSchema.safeParse('').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scannerFamily closed enum
// ---------------------------------------------------------------------------

describe('ScannerFamily closed enum', () => {
  const validFamilies = ['ast', 'semgrep', 'gitleaks', 'osv', 'zap', 'nuclei', 'probe'] as const;

  for (const family of validFamilies) {
    it(`accepts "${family}"`, () => {
      expect(ScannerFamilySchema.safeParse(family).success).toBe(true);
    });
  }

  it('rejects an unknown scanner family', () => {
    expect(ScannerFamilySchema.safeParse('burp').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fix.ts status enum — exactly 6 tokens
// ---------------------------------------------------------------------------

describe('FixStatus enum', () => {
  const expectedStatuses = [
    'requested',
    'in-progress',
    'awaiting-review',
    'merged-awaiting-verification',
    'verified-fixed',
    'reopened',
  ] as const;

  it('has exactly 6 status tokens', () => {
    expect(FixStatusSchema.options).toHaveLength(6);
  });

  for (const status of expectedStatuses) {
    it(`accepts "${status}"`, () => {
      expect(FixStatusSchema.safeParse(status).success).toBe(true);
    });
  }

  it('rejects an unknown status token', () => {
    expect(FixStatusSchema.safeParse('closed').success).toBe(false);
  });

  it('rejects "wont-fix"', () => {
    expect(FixStatusSchema.safeParse('wont-fix').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding discriminated union on surface (static/live) with full fingerprint
// ---------------------------------------------------------------------------

describe('Finding schema — discriminated union + fingerprint', () => {
  it('accepts a valid static finding', () => {
    const result = FindingSchema.safeParse(validStaticFinding());
    expect(result.success).toBe(true);
  });

  it('accepts a valid live finding', () => {
    const result = FindingSchema.safeParse(validLiveFinding());
    expect(result.success).toBe(true);
  });

  it('requires fingerprint to be exactly 64 hex chars', () => {
    const result = FindingSchema.safeParse(
      validStaticFinding({ fingerprint: 'a'.repeat(63) }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects fingerprint with non-hex chars', () => {
    const result = FindingSchema.safeParse(
      validStaticFinding({ fingerprint: 'g'.repeat(64) }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects id that does not match "f-" + fingerprint.slice(0, 16)', () => {
    const result = FindingSchema.safeParse(
      validStaticFinding({ id: `f-${'b'.repeat(16)}` }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts id that exactly matches "f-" + fingerprint.slice(0, 16)', () => {
    const fp = 'a'.repeat(64);
    const result = FindingSchema.safeParse(
      validStaticFinding({ fingerprint: fp, id: `f-${'a'.repeat(16)}` }),
    );
    expect(result.success).toBe(true);
  });

  it('static finding requires repo target + file location', () => {
    const result = FindingSchema.safeParse(
      validStaticFinding({
        target: { kind: 'repo', name: 'my-repo' },
        location: { path: 'src/db.ts', symbol: 'getUser' },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('live finding requires staging target + url location', () => {
    const result = FindingSchema.safeParse(validLiveFinding());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.target.kind).toBe('staging');
      expect(result.data.surface).toBe('live');
    }
  });

  it('rejects a finding with unknown surface', () => {
    const result = FindingSchema.safeParse(
      validStaticFinding({ surface: 'dynamic' }),
    );
    expect(result.success).toBe(false);
  });

  it('FixesFile keyed by full 64-hex fingerprint', () => {
    const fp = 'c'.repeat(64);
    const result = FixesFileSchema.safeParse({
      [fp]: {
        fingerprint: fp,
        ruleId: 'BS-SQL-001',
        status: 'requested',
      },
    });
    expect(result.success).toBe(true);
  });

  it('FixesFile rejects key that is not 64-hex', () => {
    const result = FixesFileSchema.safeParse({
      'short-key': {
        fingerprint: 'c'.repeat(64),
        ruleId: 'BS-SQL-001',
        status: 'requested',
      },
    });
    expect(result.success).toBe(false);
  });
});
