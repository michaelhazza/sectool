/**
 * verify-growth-gate.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-growth-gate.mjs (control C5).
 * Builds a throwaway git repo per case: a tagged base release, then a second
 * release that adds behavioural files, and asserts the gate fails when the new
 * file is undeclared in the CHANGELOG and passes once declared.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-growth-gate.mjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function runGate(dir) {
  const res = spawnSync(process.execPath, [GATE], {
    cwd: HERE,
    encoding: 'utf8',
    env: { ...process.env, GATE_ROOT: dir },
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

/** Fresh git repo with a tagged v1.0.0 base commit. Returns the dir. */
function baseRepo() {
  const dir = path.join(os.tmpdir(), `growth-gate-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  write(dir, '.claude/FRAMEWORK_VERSION', '1.0.0\n');
  write(dir, '.claude/CHANGELOG.md', '# Changelog\n\n## Format\n\ntext\n\n## 1.0.0 — 2026-01-01\n\nbase\n');
  write(dir, '.claude/agents/existing.md', '---\nname: existing\n---\nx\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'v1.0.0');
  git(dir, 'tag', 'v1.0.0');
  return dir;
}

/** Add a v1.1.0 release commit with the given new files + CHANGELOG body. */
function releaseCommit(dir, files, changelogBody) {
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  write(dir, '.claude/FRAMEWORK_VERSION', '1.1.0\n');
  const cl = fs.readFileSync(path.join(dir, '.claude/CHANGELOG.md'), 'utf8');
  const injected = cl.replace('## 1.0.0 —', `## 1.1.0 — 2026-02-02\n\n${changelogBody}\n\n## 1.0.0 —`);
  write(dir, '.claude/CHANGELOG.md', injected);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'v1.1.0');
}

describe('verify-growth-gate', () => {
  it('no new behavioural files → exit 0', () => {
    const dir = baseRepo();
    releaseCommit(dir, { 'references/some-note.md': 'x' }, 'just a reference doc');
    const { code, out } = runGate(dir);
    expect(code).toBe(0);
    expect(out).toContain('new_behavioural=0');
  });

  it('new skill without a growth-gate declaration → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(dir, { '.claude/skills/new-skill/SKILL.md': '---\nname: new-skill\n---\nbody' }, 'added a skill but forgot to declare it');
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toContain('new-skill');
    expect(out).toContain('[growth-gate]');
  });

  it('new skill WITH a full declaration → exit 0', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/skills/new-skill/SKILL.md': '---\nname: new-skill\n---\nbody' },
      '> growth-gate: .claude/skills/new-skill/SKILL.md — replaces: none: no existing skill covers X; footprint: not-always-loaded',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(0);
    expect(out).toContain('all declared');
  });

  it('new hook with a declaration missing footprint → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/hooks/new-hook.js': 'module.exports = {}' },
      '> growth-gate: new-hook — replaces: none: brand new',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toContain('footprint:');
  });

  it('new agent declared by name (not full path) → exit 0', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/agents/new-agent.md': '---\nname: new-agent\n---\nx' },
      '> growth-gate: new-agent — replaces: old-thing; footprint: 1200 bytes',
    );
    const { code } = runGate(dir);
    expect(code).toBe(0);
  });

  it('test hook file (*.test.js) is not treated as a new behavioural addition → exit 0', () => {
    const dir = baseRepo();
    releaseCommit(dir, { '.claude/hooks/new-hook.test.js': 'x' }, 'just a test file');
    const { code, out } = runGate(dir);
    expect(code).toBe(0);
    expect(out).toContain('new_behavioural=0');
  });

  it('unresolvable base ref (with a previous version) → exit 1 FAIL-CLOSED', () => {
    const dir = baseRepo();
    releaseCommit(dir, { '.claude/skills/new-skill/SKILL.md': 'x' }, 'no declaration');
    const res = spawnSync(process.execPath, [GATE], {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, GATE_ROOT: dir, GATE_BASE_REF: 'v9.9.9-does-not-exist' },
    });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/FAIL-CLOSED|unresolvable/);
  });

  it('unresolvable base ref + GATE_GROWTH_ADVISORY=1 → exit 0 (advisory opt-in)', () => {
    const dir = baseRepo();
    releaseCommit(dir, { '.claude/skills/new-skill/SKILL.md': 'x' }, 'no declaration');
    const res = spawnSync(process.execPath, [GATE], {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, GATE_ROOT: dir, GATE_BASE_REF: 'v9.9.9-nope', GATE_GROWTH_ADVISORY: '1' },
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('advisory');
  });

  it('declaration with EMPTY replaces/footprint values → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/skills/new-skill/SKILL.md': 'x' },
      '> growth-gate: .claude/skills/new-skill/SKILL.md — replaces: ; footprint:',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/replaces:|footprint:/);
  });

  it('a target that only SUBSTRING-contains the path (foo.md vs foo.md.backup) does NOT cover it → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/agents/foo.md': '---\nname: foo\n---\nx' },
      // target names a DIFFERENT file whose name contains the real path as a prefix
      '> growth-gate: .claude/agents/foo.md.backup — replaces: none: new; footprint: 1200 bytes',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toContain('foo.md');
  });

  it('empty replaces value but VALID footprint (the `;` delimiter is not a value) → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/skills/new-skill/SKILL.md': 'x' },
      '> growth-gate: .claude/skills/new-skill/SKILL.md — replaces: ; footprint: 1200 bytes',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toContain('replaces:');
  });

  it('an addition mentioned ONLY inside another declaration\'s replaces: is NOT covered → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      {
        '.claude/agents/new-agent.md': '---\nname: new-agent\n---\nx',
        '.claude/commands/new-command.md': '---\nname: new-command\n---\ny',
      },
      // new-command has NO declaration of its own; its name appears only in
      // new-agent's replaces: rationale — that must NOT count as declaring it.
      '> growth-gate: .claude/agents/new-agent.md — replaces: new-command; footprint: 1200 bytes',
    );
    const { code, out } = runGate(dir);
    expect(code).toBe(1);
    expect(out).toContain('new-command');
  });

  it('footprint with a non-conforming value (no bytes/not-always-loaded) → exit 1', () => {
    const dir = baseRepo();
    releaseCommit(
      dir,
      { '.claude/skills/new-skill/SKILL.md': 'x' },
      '> growth-gate: .claude/skills/new-skill/SKILL.md — replaces: none: new; footprint: smallish',
    );
    const { code } = runGate(dir);
    expect(code).toBe(1);
  });
});
