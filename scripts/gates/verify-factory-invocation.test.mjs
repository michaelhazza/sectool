/**
 * verify-factory-invocation.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-factory-invocation.mjs. Spawns
 * the real gate as a child process against isolated temp-dir copies of the
 * two committed fixtures (clean-source.ts, uninvoked-factory.ts).
 *
 * GATE_SOURCE_DIR and GATE_SCAN_DIR both point at the SAME temp dir per case
 * — each fixture is self-contained (defines AND either invokes or
 * bare-references its own factory). Isolation matters: both fixtures live
 * side by side in the committed fixtures/ dir, and the gate's derivation
 * step reads every .ts file in GATE_SOURCE_DIR, so pointing the gate at the
 * shared fixtures/ dir directly would always see uninvoked-factory.ts's
 * violation regardless of which case is under test — hence the per-case
 * copy into an isolated temp dir.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-factory-invocation.mjs');
const FIXTURES_DIR = path.join(HERE, 'fixtures', 'verify-factory-invocation');
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Copies one committed fixture into an isolated temp dir; returns the dir. */
function isolatedFixtureDir(name) {
  const dir = path.join(os.tmpdir(), `factory-invocation-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(dir, name));
  return dir;
}

function runGate(dir, env = {}) {
  const res = spawnSync(process.execPath, [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      // Tests point the gate at temp dirs, which the corpus-narrowing guard
      // would refuse under CI=true. Fixture mode is the sanctioned test
      // channel; cases that test the GUARD ITSELF override this to ''.
      GATE_FIXTURE_MODE: '1',
      GATE_SOURCE_DIR: dir,
      GATE_SCAN_DIR: dir,
      ...env,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('verify-factory-invocation gate', () => {
  it('clean fixture: factory correctly invoked — exit 0', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture: bare factory reference — exit 2 (warning-first default)', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('uninvoked-factory');
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture with VERIFY_FACTORY_INVOCATION_EXIT=1 — exit 1 (blocking)', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir, { VERIFY_FACTORY_INVOCATION_EXIT: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it('missing GATE_SOURCE_DIR — exit 1 (fail-closed misconfiguration)', () => {
    const missing = path.join(os.tmpdir(), `factory-invocation-missing-${crypto.randomUUID()}`);
    const r = runGate(missing);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });

  // Regression: adversarial review, 2026-07-28. The gate fail-closed on 0
  // DERIVED factories but not on 0 MATCHED registrations, so pointing
  // GATE_METHOD_SET at a method the repo never calls made every AST walk match
  // nothing and produced a clean green that inspected nothing. The env is set
  // by the workflow/callee, which is a branch-controlled file, so this was
  // reachable by a one-line diff.
  it('neutered GATE_METHOD_SET on a VIOLATING fixture — exit 1, not a false green', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir, { GATE_METHOD_SET: 'head' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/matched 0 registration call sites/);
      expect(r.stderr).toMatch(/inspected nothing/);
    } finally {
      rmrf(dir);
    }
  });

  // Regression: external review, 2026-07-29. The zero-match tripwires catch a
  // scan that finds NOTHING, but pointing the roots at one small CLEAN corpus
  // (the committed fixtures are ideal) produced a green that inspected none of
  // the production tree. The guard closes both routes.
  it('committed fixture tree as root WITHOUT fixture mode — exit 1, not a clean pass', () => {
    const r = runGate(FIXTURES_DIR, { GATE_FIXTURE_MODE: '' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/fixture tree/);
    expect(r.stderr).toMatch(/inspects none of the production corpus/);
  });

  it('CI=true + non-default root WITHOUT fixture mode — exit 1', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '', CI: 'true' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/narrowed corpus can be arbitrarily clean/);
    } finally {
      rmrf(dir);
    }
  });

  it('CI=true + non-default root WITH fixture mode — runs normally (the test channel)', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '1', CI: 'true' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  // Regression: external review round 2. The ROOT guard did not cover the
  // METHOD SET. With canonical roots and a narrowed set, one clean matching
  // registration satisfied the zero-match tripwire while violations under the
  // omitted methods were never examined — right files, wrong lens.
  it('narrowed GATE_METHOD_SET in CI without fixture mode — exit 1', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '', CI: 'true', GATE_METHOD_SET: 'options' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/narrowed to \{options\}/);
      expect(r.stderr).toMatch(/never examined/);
    } finally {
      rmrf(dir);
    }
  });

  it('the CANONICAL method set explicitly passed in CI is accepted (not a false refusal)', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const canonical = 'get,post,put,patch,delete,all,use,options,head';
      // Fixture mode is still needed for the non-default ROOT; the point here is
      // that the method-set check itself does not reject an equal set.
      const r = runGate(dir, { GATE_FIXTURE_MODE: '1', CI: 'true', GATE_METHOD_SET: canonical });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it('pass line reports the effective config so a neutered run is visible', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/registrations=[1-9]/);
      expect(r.stdout).toMatch(/method_set=\{/);
      expect(r.stdout).toMatch(/suppressed_files=0/);
      // The two knobs that most directly control WHAT was inspected. The
      // zero-registrations tripwire only catches a scan that matched nothing,
      // so a GATE_SCAN_DIR narrowed to one clean file still prints a confident
      // pass — naming the dirs is what makes that visible in a log diff.
      expect(r.stdout).toMatch(/source_dir=\S+/);
      expect(r.stdout).toMatch(/scan_dir=\S+/);
      expect(r.stdout).toMatch(/files=[1-9]/);
    } finally {
      rmrf(dir);
    }
  });
});
