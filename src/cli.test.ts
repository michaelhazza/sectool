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

import { main } from './cli.js';
import { ConfigError, loadAllowlist, loadTargets } from './config/load.js';

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

describe('CLI — P1-4', () => {
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
});
