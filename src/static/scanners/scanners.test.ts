import { describe, it, expect } from 'vitest';
import { runSemgrep } from './semgrep.js';
import { runGitleaks } from './gitleaks.js';
import { runOsv } from './osv.js';
import type { RepoTarget } from '../../schemas/targets.js';

// ---------------------------------------------------------------------------
// Shared fixture target
// ---------------------------------------------------------------------------

const FIXTURE_TARGET: RepoTarget = {
  name: 'test-repo',
  gitUrl: 'https://github.com/example/test-repo.git',
  localPath: null,
  stackTags: ['express'],
  publicRoutes: [],
  enabled: true,
};

// ---------------------------------------------------------------------------
// Captured fixture JSON — no live binary in unit tests
// ---------------------------------------------------------------------------

const SEMGREP_FIXTURE = JSON.stringify({
  results: [
    {
      check_id: 'javascript.express.security.express-sqli.express-sqli',
      path: 'src/routes/users.ts',
      start: { line: 42 },
      extra: {
        severity: 'ERROR',
        message: 'User data flows into SQL query without sanitization',
        lines: 'db.execute(sql`SELECT * FROM users WHERE id = ${req.params.id}`)',
        metadata: {
          category: 'injection',
          owasp: ['A01:2021 - Injection'],
        },
      },
    },
    {
      check_id: 'javascript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml',
      path: 'src/components/Content.tsx',
      start: { line: 17 },
      extra: {
        severity: 'WARNING',
        message: 'dangerouslySetInnerHTML is used',
        lines: 'dangerouslySetInnerHTML={{ __html: userContent }}',
        metadata: {
          category: 'xss',
        },
      },
    },
  ],
});

const GITLEAKS_FIXTURE = JSON.stringify([
  {
    RuleID: 'generic-api-key',
    Description: 'Generic API Key detected',
    File: 'config/settings.ts',
    StartLine: 10,
    Secret: 'EXAMPLE-fake-secret-value-001',
    Match: 'apiKey = "EXAMPLE-fake-secret-value-001"',
    Entropy: 4.8,
    Tags: ['generic-api-key'],
  },
  {
    RuleID: 'jwt-secret',
    Description: 'JWT secret literal detected',
    File: 'src/auth/token.ts',
    StartLine: 5,
    Secret: 'EXAMPLE-fake-secret-value-002',
    Match: 'const jwtSecret = "EXAMPLE-fake-secret-value-002"',
    Entropy: 3.9,
    Tags: ['jwt'],
  },
]);

const OSV_FIXTURE = JSON.stringify({
  results: [
    {
      packages: [
        {
          package: {
            name: 'lodash',
            version: '4.17.15',
            ecosystem: 'npm',
          },
          vulnerabilities: [
            {
              id: 'GHSA-35jh-r3h4-6jhm',
              aliases: [{ id: 'CVE-2021-23337' }],
              summary: 'Command Injection in lodash',
              severity: [{ type: 'CVSS_V3', score: '7.2' }],
              database_specific: { severity: 'HIGH' },
            },
          ],
          groups: [
            {
              ids: ['GHSA-35jh-r3h4-6jhm'],
              aliases: ['CVE-2021-23337'],
              max_severity: 'HIGH',
            },
          ],
        },
        {
          package: {
            name: 'express',
            version: '4.17.1',
            ecosystem: 'npm',
          },
          vulnerabilities: [
            {
              id: 'GHSA-rv95-896h-c2vc',
              aliases: [{ id: 'CVE-2022-24999' }],
              summary: 'qs before 6.10.3 allows prototype poisoning',
              severity: [{ type: 'CVSS_V3', score: '9.8' }],
              database_specific: { severity: 'CRITICAL' },
            },
          ],
          groups: [
            {
              ids: ['GHSA-rv95-896h-c2vc'],
              aliases: ['CVE-2022-24999'],
              max_severity: 'CRITICAL',
            },
          ],
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Semgrep tests
// ---------------------------------------------------------------------------

describe('runSemgrep', () => {
  it('returns findings with source=semgrep and surface=static', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.source).toBe('semgrep');
      expect(f.surface).toBe('static');
    }
  });

  it('maps injection check_id to vulnClass=injection', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    const injectionFinding = findings.find((f) =>
      f.ruleId.includes('sqli'),
    );
    expect(injectionFinding).toBeDefined();
    expect(injectionFinding!.vulnClass).toBe('injection');
  });

  it('maps xss check_id to vulnClass=xss', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    const xssFinding = findings.find((f) =>
      f.ruleId.includes('dangerouslysetinnerhtml'),
    );
    expect(xssFinding).toBeDefined();
    expect(xssFinding!.vulnClass).toBe('xss');
  });

  it('maps ERROR severity to critical', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    const injectionFinding = findings.find((f) => f.ruleId.includes('sqli'));
    expect(injectionFinding!.baseSeverity).toBe('critical');
  });

  it('maps WARNING severity to high', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    const xssFinding = findings.find((f) => f.ruleId.includes('dangerouslysetinnerhtml'));
    expect(xssFinding!.baseSeverity).toBe('high');
  });

  it('sets correct target name and kind', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.target.kind).toBe('repo');
      if (f.target.kind === 'repo') {
        expect(f.target.name).toBe('test-repo');
      }
    }
  });

  it('severity and baseSeverity are equal (raw stage, not report stage)', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.severity).toBe(f.baseSeverity);
    }
  });

  it('raw-stage derived fields are at empty defaults', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.correlatedWith).toEqual([]);
      expect(f.externalRefs).toEqual([]);
      expect(f.suppressed).toBe(false);
      expect(f.suppression).toBeNull();
      expect(f.note).toBeNull();
    }
  });

  it('id equals "f-" + fingerprint.slice(0,16)', async () => {
    const exec = () => Promise.resolve({ stdout: SEMGREP_FIXTURE, stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns empty array for empty results', async () => {
    const exec = () => Promise.resolve({ stdout: JSON.stringify({ results: [] }), stderr: '' });
    const findings = await runSemgrep(FIXTURE_TARGET, '/fake/dir', exec);
    expect(findings).toHaveLength(0);
  });

  it('throws on unparseable JSON output', async () => {
    const exec = () => Promise.resolve({ stdout: 'not-json', stderr: '' });
    await expect(runSemgrep(FIXTURE_TARGET, '/fake/dir', exec)).rejects.toThrow(
      /failed to parse JSON output/,
    );
  });
});

// ---------------------------------------------------------------------------
// Gitleaks tests
// ---------------------------------------------------------------------------

describe('runGitleaks', () => {
  it('returns findings with source=gitleaks and surface=static', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.source).toBe('gitleaks');
      expect(f.surface).toBe('static');
    }
  });

  it('maps all gitleaks findings to vulnClass=secrets', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.vulnClass).toBe('secrets');
    }
  });

  it('redacts the secret value — evidence.snippet matches [redacted:<8hex>] pattern', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      if (f.evidence.snippet !== undefined) {
        expect(f.evidence.snippet).toMatch(/^\[redacted:[0-9a-f]{8}\]$/);
      }
    }
  });

  it('raw secret value is NOT present in evidence.snippet', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    const rawSecrets = ['EXAMPLE-fake-secret-value-001', 'EXAMPLE-fake-secret-value-002'];

    for (const f of findings) {
      const evidenceStr = JSON.stringify(f.evidence);
      for (const secret of rawSecrets) {
        expect(evidenceStr).not.toContain(secret);
      }
    }
  });

  it('raw secret value is NOT present in evidence.raw', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    const rawSecrets = ['EXAMPLE-fake-secret-value-001', 'EXAMPLE-fake-secret-value-002'];

    for (const f of findings) {
      const rawStr = JSON.stringify(f.evidence.raw);
      for (const secret of rawSecrets) {
        expect(rawStr).not.toContain(secret);
      }
    }
  });

  it('same secret produces same redacted placeholder (correlation-stable)', async () => {
    const duplicateFixture = JSON.stringify([
      {
        RuleID: 'generic-api-key',
        Description: 'Generic API Key',
        File: 'config/a.ts',
        StartLine: 1,
        Secret: 'same-secret-value',
        Match: 'apiKey = "same-secret-value"',
      },
      {
        RuleID: 'generic-api-key',
        Description: 'Generic API Key',
        File: 'config/b.ts',
        StartLine: 2,
        Secret: 'same-secret-value',
        Match: 'apiKey = "same-secret-value"',
      },
    ]);

    const exec = () => Promise.resolve({ stdout: duplicateFixture, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    expect(findings).toHaveLength(2);
    const snippets = findings.map((f) => f.evidence.snippet);
    expect(snippets[0]).toBe(snippets[1]);
    expect(snippets[0]).toMatch(/^\[redacted:[0-9a-f]{8}\]$/);
  });

  it('sets correct target name and kind', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.target.kind).toBe('repo');
      if (f.target.kind === 'repo') {
        expect(f.target.name).toBe('test-repo');
      }
    }
  });

  it('raw-stage derived fields are at empty defaults', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.correlatedWith).toEqual([]);
      expect(f.externalRefs).toEqual([]);
      expect(f.suppressed).toBe(false);
      expect(f.suppression).toBeNull();
      expect(f.note).toBeNull();
    }
  });

  it('id equals "f-" + fingerprint.slice(0,16)', async () => {
    const exec = () => Promise.resolve({ stdout: GITLEAKS_FIXTURE, exitCode: 1 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns empty array for empty output', async () => {
    const exec = () => Promise.resolve({ stdout: '', exitCode: 0 });
    const findings = await runGitleaks(FIXTURE_TARGET, '/fake/dir', exec);
    expect(findings).toHaveLength(0);
  });

  it('throws on unparseable JSON output', async () => {
    const exec = () => Promise.resolve({ stdout: 'not-json', exitCode: 1 });
    await expect(runGitleaks(FIXTURE_TARGET, '/fake/dir', exec)).rejects.toThrow(
      /failed to parse JSON output/,
    );
  });
});

// ---------------------------------------------------------------------------
// OSV tests
// ---------------------------------------------------------------------------

describe('runOsv', () => {
  it('returns findings with source=osv and surface=static', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.source).toBe('osv');
      expect(f.surface).toBe('static');
    }
  });

  it('maps all osv findings to vulnClass=dependency-cve', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.vulnClass).toBe('dependency-cve');
    }
  });

  it('uses max_severity from group for severity mapping (HIGH → high)', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    const lodashFinding = findings.find((f) => f.ruleId === 'GHSA-35jh-r3h4-6jhm');
    expect(lodashFinding).toBeDefined();
    expect(lodashFinding!.baseSeverity).toBe('high');
  });

  it('uses max_severity=CRITICAL from group (CRITICAL → critical)', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    const expressFinding = findings.find((f) => f.ruleId === 'GHSA-rv95-896h-c2vc');
    expect(expressFinding).toBeDefined();
    expect(expressFinding!.baseSeverity).toBe('critical');
  });

  it('sets correct target name and kind', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.target.kind).toBe('repo');
      if (f.target.kind === 'repo') {
        expect(f.target.name).toBe('test-repo');
      }
    }
  });

  it('ruleId matches the OSV vulnerability id', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('GHSA-35jh-r3h4-6jhm');
    expect(ids).toContain('GHSA-rv95-896h-c2vc');
  });

  it('raw-stage derived fields are at empty defaults', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.correlatedWith).toEqual([]);
      expect(f.externalRefs).toEqual([]);
      expect(f.suppressed).toBe(false);
      expect(f.suppression).toBeNull();
      expect(f.note).toBeNull();
    }
  });

  it('id equals "f-" + fingerprint.slice(0,16)', async () => {
    const exec = () => Promise.resolve({ stdout: OSV_FIXTURE });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);

    for (const f of findings) {
      expect(f.id).toMatch(/^f-[0-9a-f]{16}$/);
      expect(f.id).toBe(`f-${f.fingerprint.slice(0, 16)}`);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns empty array for empty output', async () => {
    const exec = () => Promise.resolve({ stdout: '' });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);
    expect(findings).toHaveLength(0);
  });

  it('returns empty array for results with no packages', async () => {
    const exec = () => Promise.resolve({ stdout: JSON.stringify({ results: [] }) });
    const findings = await runOsv(FIXTURE_TARGET, '/fake/dir', exec);
    expect(findings).toHaveLength(0);
  });

  it('throws on unparseable JSON output', async () => {
    const exec = () => Promise.resolve({ stdout: 'not-json' });
    await expect(runOsv(FIXTURE_TARGET, '/fake/dir', exec)).rejects.toThrow(
      /failed to parse JSON output/,
    );
  });
});
