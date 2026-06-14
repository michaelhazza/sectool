import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
let originalBenchmarkAllowlist: string | null;

// The SHIPPED (checked-in) config files, captured before this suite overwrites
// them with BASE_*. Restored in afterAll so the suite never leaves the real
// config/*.json dirty in the working tree (a `git add -A` landmine — these are
// version-controlled registry/allowlist files, not test fixtures).
let shippedAllowlist: string | null = null;
let shippedTargets: string | null = null;
let shippedBaseline: string | null = null;

import { readFileSync } from 'node:fs';

// Shipped base state: valid JSON for all three config files. Written once in
// beforeAll so that the beforeEach save/afterEach restore cycle never starts
// from a corrupted (empty or invalid) file left by a prior interrupted run.
const BASE_ALLOWLIST = JSON.stringify({ hosts: [] });
const BASE_TARGETS = JSON.stringify({
  repos: [
    {
      name: 'automation-v1',
      gitUrl: 'https://github.com/breakoutsolutions/automation-v1.git',
      localPath: null,
      stackTags: ['express'],
      publicRoutes: [],
      enabled: true,
    },
  ],
  stagingTargets: [],
});
const BASE_BASELINE = JSON.stringify({ entries: [] });

beforeAll(() => {
  // Capture the shipped (checked-in) files BEFORE overwriting, so afterAll can
  // restore them and leave the working tree clean. Tolerate absence/corruption
  // (a prior interrupted run) by leaving the shipped snapshot null.
  try { shippedAllowlist = readFileSync(allowlistPath, 'utf-8'); } catch { shippedAllowlist = null; }
  try { shippedTargets = readFileSync(targetsPath, 'utf-8'); } catch { shippedTargets = null; }
  try { shippedBaseline = readFileSync(baselinePath, 'utf-8'); } catch { shippedBaseline = null; }

  writeFileSync(allowlistPath, BASE_ALLOWLIST, 'utf-8');
  writeFileSync(targetsPath, BASE_TARGETS, 'utf-8');
  writeFileSync(baselinePath, BASE_BASELINE, 'utf-8');
});

afterAll(() => {
  // Restore the shipped files so the suite leaves config/*.json pristine.
  if (shippedAllowlist !== null) writeFileSync(allowlistPath, shippedAllowlist, 'utf-8');
  if (shippedTargets !== null) writeFileSync(targetsPath, shippedTargets, 'utf-8');
  if (shippedBaseline !== null) writeFileSync(baselinePath, shippedBaseline, 'utf-8');
});

beforeEach(() => {
  originalAllowlist = readFileSync(allowlistPath, 'utf-8');
  originalTargets = readFileSync(targetsPath, 'utf-8');
  originalBaseline = readFileSync(baselinePath, 'utf-8');
  try {
    originalBenchmarkAllowlist = readFileSync(benchmarkAllowlistPath, 'utf-8');
  } catch {
    originalBenchmarkAllowlist = null;
  }
});

afterEach(() => {
  writeFileSync(allowlistPath, originalAllowlist, 'utf-8');
  writeFileSync(targetsPath, originalTargets, 'utf-8');
  writeFileSync(baselinePath, originalBaseline, 'utf-8');
  if (originalBenchmarkAllowlist !== null) {
    writeFileSync(benchmarkAllowlistPath, originalBenchmarkAllowlist, 'utf-8');
  }
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

// ---------------------------------------------------------------------------
// opts.configDir — reads from a given directory (C0 / ImplInv-9)
// These tests use their own isolated temp dir; the shared beforeEach/afterEach
// fixture cycle above does NOT touch these paths, so they never conflict.
// ---------------------------------------------------------------------------

describe('loadAllowlist({ configDir }) reads from an explicit directory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sectool-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads allowed-staging-hosts.json from opts.configDir', () => {
    writeFileSync(
      join(tmpDir, 'allowed-staging-hosts.json'),
      JSON.stringify({ hosts: [{ host: 'tmp.example.breakout.dev', owner: 'test', addedAt: '2026-01-01' }] }),
      'utf-8',
    );
    const al = loadAllowlist({ configDir: tmpDir });
    expect(al.hosts).toHaveLength(1);
    expect(al.hosts[0]?.host).toBe('tmp.example.breakout.dev');
  });

  it('default (no opts) still reads the shipped config path — not the temp dir', () => {
    // The shared beforeAll installs BASE_ALLOWLIST (empty hosts) at allowlistPath.
    // The temp dir has no file. Default call reads allowlistPath, not tmpDir.
    const al = loadAllowlist();
    // BASE_ALLOWLIST has 0 hosts; if it mistakenly read tmpDir it would throw (no file).
    expect(al.hosts).toHaveLength(0);
  });

  it('throws ConfigError when opts.configDir file is absent', () => {
    // tmpDir exists but the file does not
    expect(() => loadAllowlist({ configDir: tmpDir })).toThrow(ConfigError);
  });
});

describe('loadTargets(allowlist, { configDir }) reads from an explicit directory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sectool-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    // Write allowlist file needed by loadAllowlist
    writeFileSync(
      join(tmpDir, 'allowed-staging-hosts.json'),
      JSON.stringify({ hosts: [{ host: 'tmp.automation.breakout.dev', owner: 'test', addedAt: '2026-01-01' }] }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads targets.json from opts.configDir', () => {
    writeFileSync(
      join(tmpDir, 'targets.json'),
      JSON.stringify({
        repos: [{ name: 'tmp-repo', gitUrl: 'https://github.com/test/tmp-repo.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }],
        stagingTargets: [],
      }),
      'utf-8',
    );
    const al = loadAllowlist({ configDir: tmpDir });
    const registry = loadTargets(al, { configDir: tmpDir });
    expect(registry.repos).toHaveLength(1);
    expect(registry.repos[0]?.name).toBe('tmp-repo');
  });

  it('default (no opts) still reads the shipped targets path — not the temp dir', () => {
    // The shared beforeAll installs BASE_TARGETS at targetsPath.
    // The temp dir has targets.json with a different repo name.
    writeFileSync(
      join(tmpDir, 'targets.json'),
      JSON.stringify({
        repos: [{ name: 'should-not-appear', gitUrl: 'https://github.com/test/x.git', localPath: null, stackTags: [], publicRoutes: [], enabled: true }],
        stagingTargets: [],
      }),
      'utf-8',
    );
    const al = loadAllowlist();
    const registry = loadTargets(al);
    // BASE_TARGETS has name 'automation-v1'
    expect(registry.repos[0]?.name).toBe('automation-v1');
  });
});

describe('loadBaseline({ configDir }) reads from an explicit directory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sectool-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads baseline.json from opts.configDir', () => {
    writeFileSync(
      join(tmpDir, 'baseline.json'),
      JSON.stringify({ entries: [] }),
      'utf-8',
    );
    const baseline = loadBaseline({ configDir: tmpDir });
    expect(baseline.entries).toHaveLength(0);
  });

  it('default (no opts) still reads the shipped baseline path — not the temp dir', () => {
    // The shared beforeAll installs BASE_BASELINE (empty entries) at baselinePath.
    const baseline = loadBaseline();
    expect(baseline.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Consistency assertion — ImplInv-9, §13
// Write a config to a temp configDir, then loadTargets(loadAllowlist({configDir}),
// {configDir}) returns exactly that content, NOT the content at REPO_ROOT/config.
// ---------------------------------------------------------------------------

describe('configDir consistency (ImplInv-9): loadTargets reads what loadAllowlist sees', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sectool-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exactly the targets.json written to the temp configDir, not REPO_ROOT/config', () => {
    const targetHost = 'consistency.breakout.dev';
    writeFileSync(
      join(tmpDir, 'allowed-staging-hosts.json'),
      JSON.stringify({ hosts: [{ host: targetHost, owner: 'test', addedAt: '2026-01-01' }] }),
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'targets.json'),
      JSON.stringify({
        repos: [],
        stagingTargets: [
          {
            name: 'consistency-staging',
            url: `https://${targetHost}`,
            repo: 'consistency-repo',
            activeScan: false,
            rateLimitRps: 10,
            enabled: true,
          },
        ],
      }),
      'utf-8',
    );

    const opts = { configDir: tmpDir };
    const al = loadAllowlist(opts);
    const registry = loadTargets(al, opts);

    // Assert the result matches what was written to tmpDir, not REPO_ROOT/config
    expect(registry.stagingTargets).toHaveLength(1);
    expect(registry.stagingTargets[0]?.name).toBe('consistency-staging');
    expect(registry.stagingTargets[0]?.url).toBe(`https://${targetHost}`);
    // The real REPO_ROOT/config/targets.json (BASE_TARGETS) has repos but no stagingTargets
    // with name 'consistency-staging', confirming this read from tmpDir not REPO_ROOT/config.
  });
});
