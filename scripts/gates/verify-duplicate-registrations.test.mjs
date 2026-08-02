/**
 * verify-duplicate-registrations.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-duplicate-registrations.mjs.
 * Spawns the real gate as a child process against isolated temp-dir copies
 * of the two committed fixtures (clean-registrations.ts,
 * double-registration.ts).
 *
 * GATE_SCAN_DIR points at a per-case isolated temp dir containing ONLY that
 * fixture — both fixtures live side by side in the committed fixtures/ dir,
 * and the gate scans every .ts file under GATE_SCAN_DIR, so pointing the
 * gate at the shared fixtures/ dir directly would always see
 * double-registration.ts's violation regardless of which case is under test
 * — hence the per-case copy into an isolated temp dir.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-duplicate-registrations.mjs');
const FIXTURES_DIR = path.join(HERE, 'fixtures', 'verify-duplicate-registrations');
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Copies one committed fixture into an isolated temp dir; returns the dir. */
function isolatedFixtureDir(name) {
  const dir = path.join(os.tmpdir(), `duplicate-registrations-${crypto.randomUUID()}`);
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
      GATE_SCAN_DIR: dir,
      ...env,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('verify-duplicate-registrations gate', () => {
  it('clean fixture: distinct keys — exit 0', () => {
    const dir = isolatedFixtureDir('clean-registrations.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture: same-key double registration — exit 2 (warning-first default)', () => {
    const dir = isolatedFixtureDir('double-registration.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('duplicate-registration');
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture with VERIFY_DUPLICATE_REGISTRATIONS_EXIT=1 — exit 1 (blocking)', () => {
    const dir = isolatedFixtureDir('double-registration.ts');
    try {
      const r = runGate(dir, { VERIFY_DUPLICATE_REGISTRATIONS_EXIT: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it('missing GATE_SCAN_DIR — exit 1 (fail-closed misconfiguration)', () => {
    const missing = path.join(os.tmpdir(), `duplicate-registrations-missing-${crypto.randomUUID()}`);
    const r = runGate(missing);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });

  // Added 2026-07-28 (dual-reviewer). This suite had no pass-line assertion at
  // all, so the `[GATE]` line could be narrowed to nothing without any test
  // noticing. The zero-registrations tripwire above only catches a scan that
  // matched NOTHING; a GATE_SCAN_DIR or GATE_METHOD_SET narrowed to one clean
  // file still prints a confident pass, and a line that names no inputs looks
  // identical whether the gate inspected the whole repo or one file.
  it('pass line reports the effective config so a neutered run is visible', () => {
    const dir = isolatedFixtureDir('clean-registrations.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\[GATE\] duplicate-registrations: violations=0/);
      expect(r.stdout).toMatch(/registrations=[1-9]/);
      expect(r.stdout).toMatch(/method_set=\{/);
      expect(r.stdout).toMatch(/scan_dir=\S+/);
      expect(r.stdout).toMatch(/files=[1-9]/);
    } finally {
      rmrf(dir);
    }
  });

  // Regression: external review, 2026-07-29 — the reviewer's exact scenario:
  // GATE_SCAN_DIR at the committed clean fixture exits 0 while inspecting none
  // of server/routes. Both narrowing routes must now refuse.
  it('committed fixture tree as scan root WITHOUT fixture mode — exit 1', () => {
    const r = runGate(FIXTURES_DIR, { GATE_FIXTURE_MODE: '' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/fixture tree/);
  });

  it('CI=true + non-default scan root WITHOUT fixture mode — exit 1', () => {
    const dir = isolatedFixtureDir('clean-registrations.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '', CI: 'true' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/narrowed corpus can be arbitrarily clean/);
    } finally {
      rmrf(dir);
    }
  });

  // Regression: external review round 2 — the method-set narrowing bypass,
  // sibling to the root bypass above.
  it('narrowed GATE_METHOD_SET in CI without fixture mode — exit 1', () => {
    const dir = isolatedFixtureDir('double-registration.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '', CI: 'true', GATE_METHOD_SET: 'options' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/narrowed to \{options\}/);
    } finally {
      rmrf(dir);
    }
  });

  it('CI=true + non-default scan root WITH fixture mode — runs normally', () => {
    const dir = isolatedFixtureDir('clean-registrations.ts');
    try {
      const r = runGate(dir, { GATE_FIXTURE_MODE: '1', CI: 'true' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });
});
