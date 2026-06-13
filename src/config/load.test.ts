import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadAllowlist,
  loadBenchmarkAllowlist,
  loadTargets,
  loadBaseline,
  ConfigError,
} from './load.js';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(_moduleDir, '..', '..');

// ---------------------------------------------------------------------------
// Helpers: write / restore fixture files
// ---------------------------------------------------------------------------

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

const allowlistPath = join(repoRoot, 'config', 'allowed-staging-hosts.json');
const targetsPath = join(repoRoot, 'config', 'targets.json');
const baselinePath = join(repoRoot, 'config', 'baseline.json');
const benchmarkAllowlistPath = join(repoRoot, 'benchmark', 'allowlist.benchmark.json');

// Save originals to restore after each test
let originalAllowlist: string;
let originalTargets: string;
let originalBaseline: string;

import { readFileSync } from 'node:fs';

beforeEach(() => {
  originalAllowlist = readFileSync(allowlistPath, 'utf-8');
  originalTargets = readFileSync(targetsPath, 'utf-8');
  originalBaseline = readFileSync(baselinePath, 'utf-8');
});

afterEach(() => {
  writeFileSync(allowlistPath, originalAllowlist, 'utf-8');
  writeFileSync(targetsPath, originalTargets, 'utf-8');
  writeFileSync(baselinePath, originalBaseline, 'utf-8');
});

// ---------------------------------------------------------------------------
// loadAllowlist() — production loader
// ---------------------------------------------------------------------------

describe('loadAllowlist()', () => {
  it('returns a LoadedAllowlist with an empty hosts array for the shipped empty config', () => {
    writeJson(allowlistPath, { hosts: [] });
    const al = loadAllowlist();
    expect(al.hosts).toHaveLength(0);
  });

  it('returns hosts when allowlist has valid DNS-name entries', () => {
    writeJson(allowlistPath, {
      hosts: [{ host: 'staging.example.breakout.dev', owner: 'alice', addedAt: '2026-01-01' }],
    });
    const al = loadAllowlist();
    expect(al.hosts).toHaveLength(1);
    expect(al.hosts[0]?.host).toBe('staging.example.breakout.dev');
  });

  it('throws ConfigError for malformed allowlist JSON', () => {
    writeFileSync(allowlistPath, 'not json', 'utf-8');
    expect(() => loadAllowlist()).toThrow(ConfigError);
  });

  it('throws ConfigError when allowlist has an IP-literal host', () => {
    writeJson(allowlistPath, {
      hosts: [{ host: '192.168.1.1', owner: 'alice', addedAt: '2026-01-01' }],
    });
    expect(() => loadAllowlist()).toThrow(ConfigError);
  });

  it('production loader accepts no override parameter (function has no parameters)', () => {
    // Type-level: loadAllowlist takes zero arguments — tested at call site.
    // Runtime: calling with no args must not throw (with valid config).
    writeJson(allowlistPath, { hosts: [] });
    expect(() => loadAllowlist()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadBenchmarkAllowlist() — loopback-restricted
// ---------------------------------------------------------------------------

describe('loadBenchmarkAllowlist()', () => {
  beforeEach(() => {
    mkdirSync(join(repoRoot, 'benchmark'), { recursive: true });
  });

  it('accepts 127.0.0.1', () => {
    writeJson(benchmarkAllowlistPath, {
      hosts: [{ host: '127.0.0.1', owner: 'test', addedAt: '2026-01-01' }],
    });
    const al = loadBenchmarkAllowlist();
    expect(al.hosts[0]?.host).toBe('127.0.0.1');
  });

  it('accepts localhost', () => {
    writeJson(benchmarkAllowlistPath, {
      hosts: [{ host: 'localhost', owner: 'test', addedAt: '2026-01-01' }],
    });
    const al = loadBenchmarkAllowlist();
    expect(al.hosts[0]?.host).toBe('localhost');
  });

  it('accepts *.localhost subdomains', () => {
    writeJson(benchmarkAllowlistPath, {
      hosts: [{ host: 'fixture.localhost', owner: 'test', addedAt: '2026-01-01' }],
    });
    const al = loadBenchmarkAllowlist();
    expect(al.hosts[0]?.host).toBe('fixture.localhost');
  });

  it('refuses a non-loopback host', () => {
    writeJson(benchmarkAllowlistPath, {
      hosts: [{ host: 'staging.example.breakout.dev', owner: 'test', addedAt: '2026-01-01' }],
    });
    expect(() => loadBenchmarkAllowlist()).toThrow(ConfigError);
    expect(() => loadBenchmarkAllowlist()).toThrow(/loopback/);
  });

  it('refuses a public IP literal', () => {
    writeJson(benchmarkAllowlistPath, {
      hosts: [{ host: '10.0.0.1', owner: 'test', addedAt: '2026-01-01' }],
    });
    // 10.0.0.1 passes the AllowlistSchema DNS check (it's dotted-decimal → rejected)
    // so this actually fails at the schema level; confirm it throws ConfigError either way
    expect(() => loadBenchmarkAllowlist()).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// loadTargets() — enabled-target cross-check
// ---------------------------------------------------------------------------

describe('loadTargets()', () => {
  it('loads targets when all enabled staging targets are on the allowlist', () => {
    writeJson(allowlistPath, {
      hosts: [{ host: 'staging.automation.breakout.dev', owner: 'alice', addedAt: '2026-01-01' }],
    });
    writeJson(targetsPath, {
      repos: [
        {
          name: 'automation-v1',
          gitUrl: 'https://github.com/michaelhazza/automation-v1.git',
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
          rateLimitRps: 10,
          enabled: true,
        },
      ],
    });
    const al = loadAllowlist();
    const registry = loadTargets(al);
    expect(registry.stagingTargets).toHaveLength(1);
  });

  it('throws ConfigError when an enabled staging target host is NOT on the allowlist', () => {
    writeJson(allowlistPath, { hosts: [] });
    writeJson(targetsPath, {
      repos: [],
      stagingTargets: [
        {
          name: 'rogue-staging',
          url: 'https://notallowed.example.com',
          repo: 'some-repo',
          activeScan: false,
          rateLimitRps: 10,
          enabled: true,
        },
      ],
    });
    const al = loadAllowlist();
    expect(() => loadTargets(al)).toThrow(ConfigError);
    expect(() => loadTargets(al)).toThrow(/not on the allowlist/);
  });

  it('allows a disabled staging target to be off-allowlist', () => {
    writeJson(allowlistPath, { hosts: [] });
    writeJson(targetsPath, {
      repos: [
        {
          name: 'automation-v1',
          gitUrl: 'https://github.com/michaelhazza/automation-v1.git',
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
          auth: {
            kind: 'form',
            loginPath: '/api/auth/login',
            method: 'POST',
            userField: 'email',
            passField: 'password',
            bodyType: 'json',
            sessionCarrier: 'cookie',
            successCheck: { statusIn: [200, 204] },
            testUsers: [
              { userEnv: 'AUDIT_STAGING_AUTOMATION_USER_A', passEnv: 'AUDIT_STAGING_AUTOMATION_PASS_A' },
            ],
          },
          rateLimitRps: 10,
          enabled: false,
        },
      ],
    });
    const al = loadAllowlist();
    // Must NOT throw — disabled target off-allowlist is valid by design
    const registry = loadTargets(al);
    expect(registry.stagingTargets[0]?.enabled).toBe(false);
  });

  it('throws ConfigError for malformed targets JSON', () => {
    writeFileSync(targetsPath, 'not json', 'utf-8');
    const al = loadAllowlist();
    expect(() => loadTargets(al)).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// loadBaseline()
// ---------------------------------------------------------------------------

describe('loadBaseline()', () => {
  it('loads an empty baseline without error', () => {
    writeJson(baselinePath, { entries: [] });
    const baseline = loadBaseline();
    expect(baseline.entries).toHaveLength(0);
  });

  it('loads a valid entry', () => {
    const fp = 'a'.repeat(64);
    writeJson(baselinePath, {
      entries: [
        {
          fingerprint: fp,
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'automation-v1' },
          justification: 'test only',
          expiry: '2030-01-01',
          approvedBy: 'alice',
        },
      ],
    });
    const baseline = loadBaseline();
    expect(baseline.entries).toHaveLength(1);
    expect(baseline.entries[0]?.fingerprint).toBe(fp);
  });

  it('throws ConfigError for malformed baseline JSON', () => {
    writeFileSync(baselinePath, 'not json', 'utf-8');
    expect(() => loadBaseline()).toThrow(ConfigError);
  });

  it('throws ConfigError when findingId does not match fingerprint', () => {
    const fp = 'b'.repeat(64);
    writeJson(baselinePath, {
      entries: [
        {
          fingerprint: fp,
          findingId: 'f-0000000000000000', // wrong
          ruleId: 'BS-SQL-001',
          target: { kind: 'repo', name: 'automation-v1' },
          justification: 'test',
          expiry: '2030-01-01',
          approvedBy: 'alice',
        },
      ],
    });
    expect(() => loadBaseline()).toThrow(ConfigError);
  });
});
