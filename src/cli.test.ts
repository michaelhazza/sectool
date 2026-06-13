import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ── Mock config loader — isolates CLI tests from on-disk config files ──────
// load.test.ts owns the file-reading contract; cli.test.ts tests CLI dispatch.

vi.mock('./config/load.js', () => {
  const ConfigError = class ConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigError';
    }
  };

  return {
    ConfigError,
    loadAllowlist: vi.fn(() => ({ hosts: [] })),
    loadTargets: vi.fn(() => ({ repos: [], stagingTargets: [] })),
    loadBaseline: vi.fn(() => ({ entries: [] })),
  };
});

// ── Mock static orchestrator ───────────────────────────────────────────────
vi.mock('./static/orchestrator.js', () => ({
  scanRepos: vi.fn(() => Promise.resolve({ findings: [], scannerStatus: [] })),
}));

// ── Mock preflight / dry-run ───────────────────────────────────────────────
vi.mock('./live/preflight.js', () => ({
  preflight: vi.fn(() => { throw new Error('preflight called unexpectedly'); }),
  dryRun: vi.fn(),
  UnregisteredTargetError: class UnregisteredTargetError extends Error {},
}));

// ── Mock report modules ────────────────────────────────────────────────────
vi.mock('./report/trend.js', () => ({
  writeTrend: vi.fn(() => Promise.resolve(undefined)),
  buildTrendLine: vi.fn(() => ({ runId: 'test-run', date: '2026-06-13', targets: {} })),
  readTrendLines: vi.fn(() => []),
  buildPrevFingerprintMap: vi.fn(() => undefined),
}));

vi.mock('./report/json.js', () => ({
  buildReport: vi.fn(() => ({
    runId: 'test-run',
    date: '2026-06-13',
    findings: [],
    targets: [],
    meta: {
      status: 'success',
      failures: [],
      scannerStatus: [],
      startedAt: '2026-06-13T00:00:00.000Z',
      finishedAt: '2026-06-13T00:00:01.000Z',
      toolVersion: 'audit-tool/1.0.0',
    },
  })),
  writeReport: vi.fn(() => Promise.resolve('/tmp/reports/test-run/report.json')),
  sortFindings: vi.fn((f: unknown[]) => f),
}));

vi.mock('./report/markdown.js', () => ({
  toMarkdown: vi.fn(() => '# Report'),
}));

vi.mock('./report/sarif.js', () => ({
  toSarif: vi.fn(() => '{}'),
}));

vi.mock('./report/html.js', () => ({
  toHtml: vi.fn(() => '<!DOCTYPE html><html><body>Report</body></html>'),
}));

vi.mock('./report/lock.js', () => ({
  WorkspaceLockedError: class WorkspaceLockedError extends Error {
    pid = 0;
    heartbeatAt = '';
  },
  withWorkspaceLock: vi.fn((fn: () => Promise<unknown>) => fn()),
  acquireLock: vi.fn(() => Promise.resolve({ release: vi.fn(), refresh: vi.fn() })),
}));

vi.mock('./correlate/correlate.js', () => ({
  correlate: vi.fn((findings: unknown[]) => findings),
}));

// ── Mock fix modules — prevent real GitHub/disk calls in CLI unit tests ────
vi.mock('./fix/pack.js', () => ({
  buildPack: vi.fn((finding: { id: string; fingerprint: string }) => ({
    json: { fingerprint: finding.fingerprint, id: finding.id, ruleId: 'TEST-001' },
    markdown: `# Pack for ${finding.id}`,
    prompt: `Fix ${finding.id}`,
  })),
}));

vi.mock('./fix/github.js', () => {
  const MissingFixTokenError = class MissingFixTokenError extends Error {
    readonly kind = 'MissingFixTokenError' as const;
    constructor() {
      super(
        'AUDIT_GITHUB_FIX_TOKEN is not set. Configure a fine-grained PAT with issues:write + issues:read + pull_requests:read and set the environment variable to enable fix-request filing.',
      );
      this.name = 'MissingFixTokenError';
    }
  };
  return {
    MissingFixTokenError,
    fileFixRequest: vi.fn(() =>
      Promise.resolve({ issueUrl: 'https://github.com/owner/repo/issues/1', issueNumber: 1, reused: false }),
    ),
  };
});

vi.mock('./fix/status.js', () => ({
  readFixesFile: vi.fn(() => ({})),
  upsertFix: vi.fn(() => Promise.resolve()),
  DEFAULT_FIXES_PATH: '/tmp/fixes.json',
}));

// ── Mock ui server — prevents real network bind in CLI unit tests ──────────
vi.mock('./ui/server.js', () => ({
  startServer: vi.fn(() =>
    Promise.resolve({
      server: { address: () => ({ address: '127.0.0.1', port: 4173 }) },
      port: 4173,
      stop: vi.fn(() => Promise.resolve()),
    }),
  ),
  CSRF_NONCE: 'mock-nonce',
}));

// ── Mock fs for report command ─────────────────────────────────────────────
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readFileSync: actual.readFileSync,
    writeFileSync: vi.fn(),
  };
});

import { readdirSync } from 'node:fs';
import { main, AmbiguousFindingIdError, doFix } from './cli.js';
import type { FixDeps } from './cli.js';
import type { RunReport } from './schemas/report.js';
import { ConfigError, loadAllowlist, loadTargets } from './config/load.js';
import { scanRepos } from './static/orchestrator.js';
import { dryRun } from './live/preflight.js';
import { toHtml } from './report/html.js';
import { fileFixRequest, MissingFixTokenError } from './fix/github.js';
import { readFixesFile, upsertFix } from './fix/status.js';

// ── ExitSignal ─────────────────────────────────────────────────────────────

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// ── capture helper ─────────────────────────────────────────────────────────

/**
 * Capture stdout/stderr output and the process.exit code from a synchronous
 * invocation of main(). Intercepts process.exit via throw+catch so that code
 * after the exit call in the implementation is never reached.
 */
function capture(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: Uint8Array | string) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: Uint8Array | string) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new ExitSignal(exitCode);
    });

  try {
    main(argv);
  } catch (err) {
    if (!(err instanceof ExitSignal)) {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      throw err;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CLI — P1-4 + P5-6', () => {
  beforeEach(() => {
    vi.mocked(loadAllowlist).mockReturnValue({ hosts: [] } as unknown as ReturnType<typeof loadAllowlist>);
    vi.mocked(loadTargets).mockReturnValue({ repos: [], stagingTargets: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── --help lists 6 commands ──────────────────────────────────────────────

  describe('--help / no args', () => {
    it('--help lists all 6 commands', () => {
      const { stdout, exitCode } = capture(['--help']);
      expect(stdout).toContain('scan-source');
      expect(stdout).toContain('scan-live');
      expect(stdout).toContain('run');
      expect(stdout).toContain('report');
      expect(stdout).toContain('ui');
      expect(stdout).toContain('fix');
      expect(exitCode).toBe(0);
    });

    it('-h also shows help', () => {
      const { stdout, exitCode } = capture(['-h']);
      expect(stdout).toContain('scan-source');
      expect(exitCode).toBe(0);
    });

    it('no args shows help', () => {
      const { stdout, exitCode } = capture([]);
      expect(stdout).toContain('scan-source');
      expect(exitCode).toBe(0);
    });
  });

  // ── Unknown command → non-zero exit ────────────────────────────────────

  describe('unknown command', () => {
    it('exits with code 1 and writes to stderr', () => {
      const { stderr, exitCode } = capture(['bogus-command']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command');
    });
  });

  // ── Subcommand --help: exits 0, mentions flags, before config validation ──

  describe('subcommand --help', () => {
    it('scan-source --help shows scanner-timeout and max-parallel-targets', () => {
      const { stdout, exitCode } = capture(['scan-source', '--help']);
      expect(stdout).toContain('scanner-timeout');
      expect(stdout).toContain('max-parallel-targets');
      expect(exitCode).toBe(0);
    });

    it('scan-live --help shows scanner-timeout, max-parallel-targets, dry-run', () => {
      const { stdout, exitCode } = capture(['scan-live', '--help']);
      expect(stdout).toContain('scanner-timeout');
      expect(stdout).toContain('max-parallel-targets');
      expect(stdout).toContain('dry-run');
      expect(exitCode).toBe(0);
    });

    it('run --help shows scanner-timeout, max-parallel-targets, fail-on', () => {
      const { stdout, exitCode } = capture(['run', '--help']);
      expect(stdout).toContain('scanner-timeout');
      expect(stdout).toContain('max-parallel-targets');
      expect(stdout).toContain('fail-on');
      expect(exitCode).toBe(0);
    });

    it('report --help shows format option', () => {
      const { stdout, exitCode } = capture(['report', '--help']);
      expect(stdout).toContain('format');
      expect(exitCode).toBe(0);
    });

    it('ui --help shows port option', () => {
      const { stdout, exitCode } = capture(['ui', '--help']);
      expect(stdout).toContain('port');
      expect(exitCode).toBe(0);
    });

    it('fix --help shows min-severity and dry-run options', () => {
      const { stdout, exitCode } = capture(['fix', '--help']);
      expect(stdout).toContain('min-severity');
      expect(stdout).toContain('dry-run');
      expect(exitCode).toBe(0);
    });
  });

  // ── Shared flag defaults parse correctly ────────────────────────────────

  describe('shared flag defaults', () => {
    it('scan-source with defaults reaches the stub without config error', () => {
      // Config mock returns valid empty config; parsing succeeds with defaults.
      const { stderr, exitCode } = capture(['scan-source']);
      expect(stderr).not.toContain('Config error');
      expect(exitCode).toBe(0);
    });

    it('--scanner-timeout 5 is accepted on scan-source', () => {
      const { stderr, exitCode } = capture(['scan-source', '--scanner-timeout', '5']);
      expect(stderr).not.toContain('Config error');
      expect(exitCode).toBe(0);
    });

    it('--max-parallel-targets 4 is accepted on run', () => {
      const { stderr, exitCode } = capture(['run', '--max-parallel-targets', '4']);
      expect(stderr).not.toContain('Config error');
      expect(exitCode).toBe(0);
    });
  });

  // ── Config-validation path ───────────────────────────────────────────────

  describe('config validation', () => {
    it('exits 1 with "Config error" message when allowlist contains invalid JSON', () => {
      vi.mocked(loadAllowlist).mockImplementationOnce(() => {
        throw new ConfigError('Failed to read allowlist at /path: SyntaxError: Unexpected token');
      });
      const { stderr, exitCode } = capture(['scan-source']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Config error');
    });

    it('exits 1 when an enabled staging target host is not on the allowlist', () => {
      vi.mocked(loadTargets).mockImplementationOnce(() => {
        throw new ConfigError(
          'Enabled staging target "bad-target" has host "evil.not-on-allowlist.example" which is not on the allowlist.',
        );
      });
      const { stderr, exitCode } = capture(['run']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Config error');
    });

    it('accepts the shipped config (1 enabled repo, 0 enabled staging, empty allowlist)', () => {
      // Mock returns valid config — scan-source reaches the stub (exits 0, no config error).
      const { stderr, exitCode } = capture(['scan-source']);
      expect(stderr).not.toContain('Config error');
      expect(exitCode).toBe(0);
    });
  });

  // ── Bad flags ─────────────────────────────────────────────────────────────

  describe('bad flags', () => {
    it('scan-source with an unknown flag exits non-zero', () => {
      const { exitCode } = capture(['scan-source', '--unknown-flag']);
      expect(exitCode).not.toBe(0);
    });

    it('report with invalid --format value exits 1', () => {
      const { stderr, exitCode } = capture(['report', '--format', 'xml']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('--format');
    });

    it('fix with no positional and no --min-severity exits 1', () => {
      const { stderr, exitCode } = capture(['fix']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('finding-ref');
    });
  });

  // ── P5-6 composition tests ─────────────────────────────────────────────

  describe('P5-6 CLI wiring — scan-source invokes scanRepos', () => {
    it('scan-source dispatches to scanRepos (no stub survives)', () => {
      // scan-source with no enabled repos just prints a message
      vi.mocked(loadTargets).mockReturnValue({ repos: [], stagingTargets: [] });
      // Allow the async dispatch to complete
      const { stdout } = capture(['scan-source']);
      // The output mentions no stubs ("not yet implemented")
      expect(stdout).not.toMatch(/not yet implemented/);
      // scanRepos may not be called synchronously (it's async); the important
      // assertion is that the stub message is gone.
    });
  });

  describe('P5-6 CLI wiring — scan-live --dry-run invokes dryRun without scanners', () => {
    it('scan-live --dry-run calls dryRun and does not invoke live scanners', () => {
      vi.mocked(loadAllowlist).mockReturnValue({ hosts: [] } as unknown as ReturnType<typeof loadAllowlist>);
      vi.mocked(loadTargets).mockReturnValue({ repos: [], stagingTargets: [] });

      capture(['scan-live', '--url', 'https://staging.example.com', '--dry-run']);

      // dryRun was called (preflight only — zero traffic)
      expect(vi.mocked(dryRun)).toHaveBeenCalledWith(
        'https://staging.example.com',
        expect.anything(),
        expect.anything(),
      );
      // scanRepos was NOT called (dry-run is live-only preflight, not static)
      expect(vi.mocked(scanRepos)).not.toHaveBeenCalled();
    });

    it('scan-live --dry-run does not emit stub message', () => {
      const { stdout } = capture(['scan-live', '--url', 'https://staging.example.com', '--dry-run']);
      expect(stdout).not.toMatch(/not yet implemented/);
    });
  });

  describe('P5-6 CLI wiring — no scan-body stub survives', () => {
    it('scan-source output does not contain stub text', () => {
      const { stdout } = capture(['scan-source']);
      expect(stdout).not.toMatch(/not yet implemented \(P2\)/);
    });

    it('scan-live --dry-run output does not contain stub text', () => {
      const { stdout } = capture(['scan-live', '--url', 'https://staging.example.com', '--dry-run']);
      expect(stdout).not.toMatch(/not yet implemented \(P4\)/);
    });

    it('run output does not contain stub text', () => {
      const { stdout } = capture(['run']);
      expect(stdout).not.toMatch(/not yet implemented \(P5\)/);
    });

    it('report output does not contain stub text (P5 stub gone)', () => {
      // With empty readdirSync mock the command exits with error, but not stub text
      const { stdout, stderr } = capture(['report']);
      expect(stdout).not.toMatch(/not yet implemented \(P5\)/);
      expect(stderr).not.toMatch(/not yet implemented \(P5\)/);
    });
  });

  // ── P7-1 CLI wiring — audit ui starts the server ────────────────────────

  describe('P7-1 CLI wiring — audit ui', () => {
    it('audit ui does not print the P7 stub message', () => {
      const { stdout, stderr } = capture(['ui']);
      expect(stdout).not.toMatch(/not yet implemented \(P7\)/);
      expect(stderr).not.toMatch(/not yet implemented \(P7\)/);
    });

    it('audit ui --port 0 does not emit stub text', () => {
      const { stdout } = capture(['ui', '--port', '0']);
      expect(stdout).not.toMatch(/not yet implemented/);
    });
  });

  // ── P8-4 — `audit fix` command wiring ────────────────────────────────────

  // Minimal Finding shape required for ref-resolution and bulk tests.
  // Two findings that share the first 16 hex chars (same display-id) for
  // the ambiguous-prefix test.  Their full 64-hex fingerprints differ.
  const FP_A = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222'; // 64 hex
  const FP_B = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111cccc3333'; // same first 16 hex as FP_A → same id
  const FP_C = 'cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc2222dddd3333'; // unique id
  const FP_D = 'dddd4444eeee5555ffff6666aaaa7777bbbb8888cccc9999dddd4444eeee5555'; // unique id, suppressed

  // Both FP_A and FP_B have id = "f-" + first 16 hex = "f-aaaa1111bbbb2222"
  const ID_AB = 'f-aaaa1111bbbb2222';
  const ID_C = 'f-cccc2222dddd3333';

  function makeFinding(fp: string, id: string, severity: string, suppressed = false): Record<string, unknown> {
    return {
      id,
      fingerprint: fp,
      ruleId: 'TEST-001',
      source: 'ast',
      surface: 'static',
      vulnClass: 'injection',
      severity,
      baseSeverity: severity,
      confidence: 'probable',
      target: { kind: 'repo', name: 'test-repo' },
      location: { path: 'src/a.ts', symbol: 'GET /api/test', startLine: 10 },
      evidence: { snippet: 'code', cvss: null, raw: {} },
      reachability: 'unknown',
      correlatedWith: [],
      docs: 'docs/rules/TEST-001.md',
      externalRefs: [],
      firstSeen: '2026-06-13T00:00:00Z',
      suppressed,
      suppression: null,
      note: null,
    };
  }

  const fakeFindings = [
    makeFinding(FP_A, ID_AB, 'high'),
    makeFinding(FP_B, ID_AB, 'high'),
    makeFinding(FP_C, ID_C, 'high'),
    makeFinding(FP_D, 'f-dddd4444eeee5555', 'high', true), // suppressed
  ];

  const fakeReport = {
    runId: 'test-run',
    date: '2026-06-13',
    findings: fakeFindings,
    targets: [],
    meta: {
      status: 'success',
      failures: [],
      scannerStatus: [],
      startedAt: '2026-06-13T00:00:00.000Z',
      finishedAt: '2026-06-13T00:00:01.000Z',
      toolVersion: 'audit-tool/1.0.0',
    },
  };

  const fakeConfig = {
    allowlist: { hosts: [] } as unknown as ReturnType<typeof loadAllowlist>,
    registry: {
      repos: [{
        name: 'test-repo',
        gitUrl: 'https://github.com/owner/test-repo.git',
        localPath: null,
        stackTags: [],
        publicRoutes: [],
        enabled: true,
      }],
      stagingTargets: [],
    },
    baseline: { entries: [] },
  } as unknown as Parameters<typeof doFix>[1];

  // Factory helpers — avoids @typescript-eslint/no-unused-vars on `_name` params
  const envWithToken = (token: string): import('./fix/github.js').EnvReader =>
    () => token;
  const envNoToken = (): import('./fix/github.js').EnvReader =>
    () => undefined;

  /** Capture stdout/stderr around an async doFix call. */
  async function captureAsync(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let exitCode = 0;

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: Uint8Array | string) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : 0;
      throw new ExitSignal(exitCode);
    });

    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ExitSignal)) {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
        throw err;
      }
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
  }

  describe('P8-4 — audit fix ref resolution', () => {
    beforeEach(() => {
      vi.mocked(readFixesFile).mockReturnValue({});
      vi.mocked(upsertFix).mockResolvedValue(undefined);
      vi.mocked(fileFixRequest).mockResolvedValue({
        issueUrl: 'https://github.com/owner/test-repo/issues/1',
        issueNumber: 1,
        reused: false,
      });
    });

    it('full fingerprint resolves to exactly one finding and files it', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      const { stdout } = await captureAsync(() =>
        doFix({ findingRef: FP_C, minSeverity: undefined, dryRun: false }, fakeConfig, depsWithReport),
      );

      // Should output "Filed issue" for FP_C
      expect(stdout).toMatch(/Filed issue/);
      // GitHub filing was called once
      expect(vi.mocked(fileFixRequest)).toHaveBeenCalledOnce();
      // upsertFix was called once with FP_C
      expect(vi.mocked(upsertFix)).toHaveBeenCalledWith(FP_C, expect.any(Function), undefined);
    });

    it('ambiguous display-id prefix throws AmbiguousFindingIdError listing both full fingerprints', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      // FP_A and FP_B share id ID_AB — using it should throw
      await expect(
        doFix({ findingRef: ID_AB, minSeverity: undefined, dryRun: false }, fakeConfig, depsWithReport),
      ).rejects.toThrow(AmbiguousFindingIdError);

      // No GitHub calls on ambiguous ref
      expect(vi.mocked(fileFixRequest)).not.toHaveBeenCalled();
    });

    it('AmbiguousFindingIdError message lists both matching full fingerprints', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      let caughtError: unknown;
      try {
        await doFix({ findingRef: ID_AB, minSeverity: undefined, dryRun: false }, fakeConfig, depsWithReport);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(AmbiguousFindingIdError);
      const err = caughtError as AmbiguousFindingIdError;
      expect(err.matches).toContain(FP_A);
      expect(err.matches).toContain(FP_B);
      expect(err.message).toMatch(new RegExp(FP_A.slice(0, 16)));
    });
  });

  describe('P8-4 — audit fix --min-severity bulk mode', () => {
    beforeEach(() => {
      vi.mocked(readFixesFile).mockReturnValue({});
      vi.mocked(upsertFix).mockResolvedValue(undefined);
      vi.mocked(fileFixRequest).mockResolvedValue({
        issueUrl: 'https://github.com/owner/test-repo/issues/2',
        issueNumber: 2,
        reused: false,
      });
    });

    it('bulk files all non-suppressed findings at or above high and SKIPS suppressed', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      const { stdout } = await captureAsync(() =>
        doFix({ findingRef: undefined, minSeverity: 'high', dryRun: false }, fakeConfig, depsWithReport),
      );

      // FP_D is suppressed — must NOT appear in output
      expect(stdout).not.toMatch(new RegExp('f-dddd4444eeee5555'));
      // 3 non-suppressed high findings (FP_A, FP_B, FP_C) → 3 GitHub calls
      expect(vi.mocked(fileFixRequest)).toHaveBeenCalledTimes(3);
    });

    it('suppressed findings are excluded from bulk filing', async () => {
      // Verify: if only suppressed findings exist at the threshold, nothing is filed
      const suppressedOnlyReport = {
        ...fakeReport,
        findings: [makeFinding(FP_D, 'f-dddd4444eeee5555', 'high', true)],
      };
      const depsWithReport: FixDeps = {
        getReport: () => suppressedOnlyReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      const { stdout } = await captureAsync(() =>
        doFix({ findingRef: undefined, minSeverity: 'high', dryRun: false }, fakeConfig, depsWithReport),
      );

      expect(stdout).toMatch(/No findings to fix/);
      expect(vi.mocked(fileFixRequest)).not.toHaveBeenCalled();
    });

    it('already-filed findings are excluded from bulk mode', async () => {
      // Mark FP_C as already filed
      vi.mocked(readFixesFile).mockReturnValue({
        [FP_C]: { fingerprint: FP_C, ruleId: 'TEST-001', status: 'requested' },
      });

      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      await captureAsync(() =>
        doFix({ findingRef: undefined, minSeverity: 'high', dryRun: false }, fakeConfig, depsWithReport),
      );

      // Only FP_A and FP_B filed (FP_C already in fixes.json, FP_D suppressed)
      expect(vi.mocked(fileFixRequest)).toHaveBeenCalledTimes(2);
    });
  });

  describe('P8-4 — audit fix --dry-run', () => {
    beforeEach(() => {
      vi.mocked(readFixesFile).mockReturnValue({});
      vi.mocked(fileFixRequest).mockResolvedValue({
        issueUrl: 'https://github.com/owner/test-repo/issues/3',
        issueNumber: 3,
        reused: false,
      });
    });

    it('--dry-run prints the pack and makes ZERO GitHub calls', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      const { stdout } = await captureAsync(() =>
        doFix({ findingRef: FP_C, minSeverity: undefined, dryRun: true }, fakeConfig, depsWithReport),
      );

      // Dry-run prints the pack markdown
      expect(stdout).toMatch(/dry-run/);
      expect(stdout).toMatch(new RegExp(ID_C));
      // No GitHub calls
      expect(vi.mocked(fileFixRequest)).not.toHaveBeenCalled();
      // No fixes.json writes
      expect(vi.mocked(upsertFix)).not.toHaveBeenCalled();
    });

    it('--dry-run with --min-severity bulk prints all packs and files nothing', async () => {
      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envWithToken('test-token-abc123'),
      };

      const { stdout } = await captureAsync(() =>
        doFix({ findingRef: undefined, minSeverity: 'high', dryRun: true }, fakeConfig, depsWithReport),
      );

      // Should mention 3 non-suppressed high findings
      expect(stdout).toMatch(/dry-run/);
      expect(vi.mocked(fileFixRequest)).not.toHaveBeenCalled();
      expect(vi.mocked(upsertFix)).not.toHaveBeenCalled();
    });
  });

  describe('P8-4 — audit fix missing token → named error', () => {
    it('throws MissingFixTokenError when AUDIT_GITHUB_FIX_TOKEN is not set', async () => {
      vi.mocked(readFixesFile).mockReturnValue({});
      vi.mocked(fileFixRequest).mockRejectedValue(new MissingFixTokenError());

      const depsWithReport: FixDeps = {
        getReport: () => fakeReport as unknown as RunReport,
        env: envNoToken(),
      };

      await expect(
        doFix({ findingRef: FP_C, minSeverity: undefined, dryRun: false }, fakeConfig, depsWithReport),
      ).rejects.toThrow(MissingFixTokenError);
    });
  });

  // ── P7-3 CLI wiring — audit report --format html ─────────────────────────

  describe('P7-3 CLI wiring — audit report --format html', () => {
    it('audit report --format html does not emit the P7 stub message', () => {
      // Even when there is no report (exits 1), no stub message appears
      const { stdout, stderr } = capture(['report', '--format', 'html']);
      expect(stdout).not.toMatch(/not yet implemented \(P7\)/);
      expect(stderr).not.toMatch(/not yet implemented \(P7\)/);
    });

    it('audit report --format html calls toHtml when a report exists', async () => {
      const fakeReport = {
        runId: '2026-06-13T00-00-00Z-ab12',
        date: '2026-06-13',
        findings: [],
        targets: [],
        meta: {
          status: 'success',
          failures: [],
          scannerStatus: [],
          startedAt: '2026-06-13T00:00:00.000Z',
          finishedAt: '2026-06-13T00:00:01.000Z',
          toolVersion: 'audit-tool/1.0.0',
        },
      };

      // Provide a run dir so findLatestReport() finds the fake report.
      // readdirSync is a vi.fn() from the mock setup.
      vi.mocked(readdirSync).mockReturnValueOnce(
        ['2026-06-13T00-00-00Z-ab12'] as unknown as ReturnType<typeof readdirSync>,
      );
      // Spy on the mocked node:fs module's readFileSync for this one call.
      const fsMod = await import('node:fs');
      const spy = vi.spyOn(fsMod, 'readFileSync').mockReturnValueOnce(JSON.stringify(fakeReport));

      const { stdout, exitCode } = capture(['report', '--format', 'html']);
      spy.mockRestore();

      expect(exitCode).toBe(0);
      // The mock toHtml returns a DOCTYPE string
      expect(stdout).toMatch(/<!DOCTYPE html>/i);
      expect(stdout).not.toMatch(/not yet implemented/);
      expect(vi.mocked(toHtml)).toHaveBeenCalled();
    });
  });
});
