/**
 * resolve-codex-bin.test.mjs
 *
 * Vitest coverage for scripts/codex/resolve-codex-bin.sh.
 *
 * The defect this guards: the Codex invocation contract required "newer of PATH
 * vs the npm global shim" resolution, but every calling agent implemented
 * `command -v codex` — PATH-first, no version comparison. On a machine with two
 * installs that selected the older binary, which hard-errors against the
 * provisioned model. The rule lived in prose while six agent files contradicted
 * it. These tests pin the behaviour so the rule is enforced by execution.
 *
 * Each case builds fake `codex` binaries in a temp dir with controlled
 * `--version` output and runs the real script against them, so the version
 * comparison is exercised rather than assumed. Skips cleanly where bash is
 * unavailable.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'resolve-codex-bin.sh');

/**
 * Absolute path to a bash executable.
 *
 * It must be ABSOLUTE, not the bare name `bash`: the cases below hand the child
 * a POSIX-form PATH, and Node resolves the executable using the CHILD's PATH,
 * so a bare name plus a POSIX PATH fails with ENOENT on Windows before the
 * script ever runs. Resolved via cygpath where available.
 */
const BASH = (() => {
  const probe = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const posix = (probe.stdout || '').trim();
  if (!posix) return null;
  const win = spawnSync('bash', ['-c', `cygpath -w "${posix}" 2>/dev/null || printf '%s' "${posix}"`], {
    encoding: 'utf8',
  });
  const resolved = (win.stdout || '').trim() || posix;
  const verify = spawnSync(resolved, ['-c', 'exit 0'], { encoding: 'utf8' });
  return !verify.error && verify.status === 0 ? resolved : null;
})();

/** C:\Users\x -> /c/Users/x ; already-POSIX paths pass through. */
function toPosixPath(p) {
  const slashed = String(p).split('\\').join('/');
  return slashed.replace(/^([A-Za-z]):\//, (_m, d) => `/${d.toLowerCase()}/`);
}

/**
 * The directory holding bash's own utilities (grep, head), discovered from the
 * live shell rather than assumed, so the minimal PATH the tests build still
 * lets the script run.
 */
const TOOLCHAIN_DIR = (() => {
  if (!BASH) return null;
  const res = spawnSync(BASH, ['-c', 'command -v grep'], { encoding: 'utf8' });
  const grepPath = (res.stdout || '').trim();
  return grepPath ? path.posix.dirname(toPosixPath(grepPath)) : '/usr/bin';
})();

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `resolve-codex-${crypto.randomUUID()}-`));
  tempDirs.push(dir);
  return dir;
}

/** Writes an executable fake `codex` that reports the given version string. */
function fakeCodex(dir, versionOutput) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'codex');
  fs.writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "${versionOutput}"\n`, { mode: 0o755 });
  return p;
}

/**
 * Runs the resolver with a controlled environment. `pathDir` becomes the ONLY
 * directory on PATH besides the bash toolchain, so `command -v codex` resolves
 * deterministically.
 */
function runResolver({ pathDir = null, fallback = null, npmPrefix = null } = {}) {
  // PATH must be built for the BASH child, not for Node's host platform:
  // the separator is ':' (not Windows' ';', which path.delimiter would give)
  // and entries must be POSIX-form, so C:\x becomes /c/x. Getting either wrong
  // makes bash unable to find its own grep/head and the spawn fails outright.
  const pathParts = [pathDir, TOOLCHAIN_DIR].filter(Boolean).map(toPosixPath);
  const env = { PATH: pathParts.join(':') };
  if (fallback) env.CODEX_FALLBACK_PATH = fallback;

  // The script asks `npm prefix -g` for the shim location. Shadow npm with a
  // stub so the test never depends on the host's real npm installation.
  if (npmPrefix) {
    const stubDir = makeTempDir();
    fs.writeFileSync(
      path.join(stubDir, 'npm'),
      `#!/usr/bin/env bash\nif [ "$1" = "prefix" ]; then printf '%s\\n' "${npmPrefix}"; fi\n`,
      { mode: 0o755 }
    );
    env.PATH = [toPosixPath(stubDir), env.PATH].join(':');
  }

  const res = spawnSync(BASH, [SCRIPT], { encoding: 'utf8', env, timeout: 60000 });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout || '').trim(),
    stderr: res.stderr || '',
  };
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe.skipIf(!BASH)('resolve-codex-bin.sh', () => {
  it('prefers the NEWER npm shim over an older PATH binary — the shipped defect', () => {
    const pathDir = makeTempDir();
    const shimDir = makeTempDir();
    fakeCodex(pathDir, 'codex-cli 0.138.0');
    const shim = fakeCodex(shimDir, 'codex-cli 0.144.3');

    const r = runResolver({ pathDir, npmPrefix: shimDir });

    expect(r.status, r.stderr).toBe(0);
    expect(toPosixPath(r.stdout)).toBe(toPosixPath(shim));
    // The discard must be announced, not silent.
    expect(r.stderr).toMatch(/NEWER than the PATH-resolved binary/);
  });

  it('keeps the PATH binary when it is the newer one', () => {
    const pathDir = makeTempDir();
    const shimDir = makeTempDir();
    const pathBin = fakeCodex(pathDir, 'codex-cli 0.150.0');
    fakeCodex(shimDir, 'codex-cli 0.144.3');

    const r = runResolver({ pathDir, npmPrefix: shimDir });

    expect(r.status, r.stderr).toBe(0);
    expect(toPosixPath(r.stdout)).toBe(toPosixPath(pathBin));
  });

  it('compares versions numerically, not lexically (0.9.0 < 0.10.0)', () => {
    const pathDir = makeTempDir();
    const shimDir = makeTempDir();
    fakeCodex(pathDir, 'codex-cli 0.9.0');
    const shim = fakeCodex(shimDir, 'codex-cli 0.10.0');

    const r = runResolver({ pathDir, npmPrefix: shimDir });

    expect(r.status, r.stderr).toBe(0);
    // A string compare would pick 0.9.0 here.
    expect(toPosixPath(r.stdout)).toBe(toPosixPath(shim));
  });

  it('considers CODEX_FALLBACK_PATH and picks it when newest', () => {
    const pathDir = makeTempDir();
    const fbDir = makeTempDir();
    fakeCodex(pathDir, 'codex-cli 0.138.0');
    const fb = fakeCodex(fbDir, 'codex-cli 0.200.1');

    const r = runResolver({ pathDir, fallback: fb });

    expect(r.status, r.stderr).toBe(0);
    expect(toPosixPath(r.stdout)).toBe(toPosixPath(fb));
  });

  it('fails closed with EMPTY stdout when no binary exists', () => {
    const r = runResolver({ pathDir: makeTempDir() });

    expect(r.status).toBe(1);
    // Must not emit a bare 'codex' for a caller to invoke blindly.
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/no Codex binary found/i);
  });

  it('fails closed when a candidate exists but reports no parseable version', () => {
    const pathDir = makeTempDir();
    fakeCodex(pathDir, 'not a version at all');

    const r = runResolver({ pathDir });

    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/none reported a runnable version/i);
  });

  it('succeeds silently about precedence when only one binary is present', () => {
    const pathDir = makeTempDir();
    const only = fakeCodex(pathDir, 'codex-cli 0.144.3');

    const r = runResolver({ pathDir });

    expect(r.status, r.stderr).toBe(0);
    expect(toPosixPath(r.stdout)).toBe(toPosixPath(only));
    expect(r.stderr).not.toMatch(/NEWER than/);
  });
});

describe('agent wiring invariant', () => {
  const AGENTS = [
    'spec-reviewer.md',
    'dual-reviewer.md',
    'plan-reviewer.md',
    'brief-reviewer.md',
    'verify-phase.md',
    'feature-coordinator.md',
  ];
  const AGENT_DIR = path.resolve(HERE, '..', '..', '.claude', 'agents');

  it('no agent re-derives the binary with a PATH-first lookup', () => {
    const offenders = [];
    for (const name of AGENTS) {
      const src = fs.readFileSync(path.join(AGENT_DIR, name), 'utf8');
      // The assignment form is what matters; the phrase also appears inside the
      // explanatory warning comment, which is fine.
      if (/CODEX_BIN=\$\(command -v codex/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('every Codex-using agent calls the shared resolver', () => {
    const missing = AGENTS.filter((name) => {
      const src = fs.readFileSync(path.join(AGENT_DIR, name), 'utf8');
      return !src.includes('scripts/codex/resolve-codex-bin.sh');
    });
    expect(missing).toEqual([]);
  });
});
