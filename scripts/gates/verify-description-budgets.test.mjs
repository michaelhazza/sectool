/**
 * verify-description-budgets.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-description-budgets.mjs (BLOCKING
 * frontmatter description budget). Each case builds a synthetic repo root in an
 * isolated temp dir and runs the real gate as a child process with GATE_ROOT
 * pointed at it, asserting the exit code and specific [FAIL] lines.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-description-budgets.mjs');

function tmpRoot() {
  const dir = path.join(os.tmpdir(), `desc-budget-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function run(root) {
  const res = spawnSync(process.execPath, [GATE], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, GATE_ROOT: root },
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// Single-line frontmatter builders (double-quoted, matching the shipped style).
const agent = (desc) => `---\nname: a\ndescription: "${desc}"\ntools: Read\nmodel: opus\n---\n\nbody\n`;
const skill = (desc) => `---\nname: s\ndescription: "${desc}"\n---\n\n# Skill\n`;
const command = (desc) => `---\ndescription: "${desc}"\n---\n\n# /cmd\n`;

describe('verify-description-budgets gate', () => {
  it('exits 0 when every description is within budget', () => {
    const root = tmpRoot();
    write(root, '.claude/agents/ok.md', agent('x'.repeat(100)));
    write(root, '.claude/skills/ok/SKILL.md', skill('y'.repeat(100)));
    write(root, '.claude/commands/ok.md', command('z'.repeat(50)));
    const r = run(root);
    expect(r.out).toContain('[GATE] verify-description-budgets: violations=0');
    expect(r.code).toBe(0);
  });

  it('fails an over-budget single-line agent description (400B)', () => {
    const root = tmpRoot();
    write(root, '.claude/agents/over.md', agent('x'.repeat(420)));
    write(root, '.claude/agents/under.md', agent('x'.repeat(100)));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/agents/over.md: description 420B > 400B');
    expect(r.out).not.toContain('.claude/agents/under.md');
    expect(r.out).toContain('violations=1');
  });

  it('fails an over-budget single-line skill description (450B)', () => {
    const root = tmpRoot();
    write(root, '.claude/skills/over/SKILL.md', skill('y'.repeat(500)));
    write(root, '.claude/skills/under/SKILL.md', skill('y'.repeat(100)));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/skills/over/SKILL.md: description 500B > 450B');
    expect(r.out).not.toContain('.claude/skills/under/SKILL.md');
  });

  it('fails an over-budget single-line command description (180B)', () => {
    const root = tmpRoot();
    write(root, '.claude/commands/over.md', command('z'.repeat(200)));
    write(root, '.claude/commands/under.md', command('z'.repeat(50)));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/commands/over.md: description 200B > 180B');
    expect(r.out).not.toContain('.claude/commands/under.md');
  });

  it('fails an OVER-budget folded (>) block scalar description', () => {
    const root = tmpRoot();
    // Folded value = five 100-char lines joined by single spaces ≈ 504B > 400B.
    const folded =
      '---\nname: a\ndescription: >\n' +
      Array.from({ length: 5 }, () => `  ${'x'.repeat(100)}`).join('\n') +
      '\ntools: Read\n---\n\nbody\n';
    write(root, '.claude/agents/folded-over.md', folded);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/agents/folded-over.md: description');
    expect(r.out).toContain('> 400B');
  });

  it('passes an UNDER-budget multiline description and measures the scalar only (stops at the next key)', () => {
    const root = tmpRoot();
    // Short folded description (~40B) followed by a tools: value long enough
    // (>400B) that, IF the parser bled past the description boundary, the file
    // would trip the 400B agent budget. It must PASS — proving the measured
    // bytes come from the description scalar alone.
    const multiline =
      '---\nname: a\ndescription: >\n' +
      '  short desc line one\n' +
      '  short desc line two\n' +
      `tools: ${'T'.repeat(600)}\n` +
      '---\n\nbody\n';
    write(root, '.claude/agents/multiline-under.md', multiline);
    const r = run(root);
    expect(r.out).toContain('[GATE] verify-description-budgets: violations=0');
    expect(r.code).toBe(0);
  });

  it('silently skips files with no frontmatter or no description', () => {
    const root = tmpRoot();
    write(root, '.claude/agents/no-frontmatter.md', '# just a body, no frontmatter\n');
    write(root, '.claude/agents/no-desc.md', '---\nname: a\ntools: Read\n---\nbody\n');
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('violations=0');
  });

  it('measures a literal (|) block scalar and passes when under budget', () => {
    const root = tmpRoot();
    const literal =
      '---\nname: a\ndescription: |\n' +
      '  line one of the literal block\n' +
      '  line two of the literal block\n' +
      'tools: Read\n---\n\nbody\n';
    write(root, '.claude/agents/literal.md', literal);
    const r = run(root);
    expect(r.out).toContain('[GATE] verify-description-budgets: violations=0');
    expect(r.code).toBe(0);
  });

  it('fails an OVER-budget literal (|) block scalar', () => {
    const root = tmpRoot();
    const literal =
      '---\nname: a\ndescription: |\n' +
      Array.from({ length: 5 }, () => `  ${'x'.repeat(100)}`).join('\n') +
      '\ntools: Read\n---\n\nbody\n';
    write(root, '.claude/agents/literal-over.md', literal);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/agents/literal-over.md: description');
    expect(r.out).toContain('> 400B');
  });

  it('unwraps a single-quoted inline description before measuring', () => {
    const root = tmpRoot();
    // 420 chars inside single quotes trips the 400B agent budget ONLY if the
    // quotes are stripped and the inner bytes measured — proves unwrapping.
    write(root, '.claude/agents/sq.md', `---\nname: a\ndescription: '${'x'.repeat(420)}'\ntools: Read\n---\n\nbody\n`);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] .claude/agents/sq.md: description 420B > 400B');
  });

  it('unescapes an escaped double-quote inside a double-quoted description', () => {
    const root = tmpRoot();
    // File value: description: "he said \"hi\""  →  unescaped: he said "hi" (12B).
    write(root, '.claude/agents/dq.md', '---\nname: a\ndescription: "he said \\"hi\\""\ntools: Read\n---\n\nbody\n');
    const r = run(root);
    expect(r.out).toContain('violations=0');
    expect(r.code).toBe(0);
  });

  it('recognises a block scalar with an explicit indent indicator (>2) and stops at the next key', () => {
    const root = tmpRoot();
    // With '>2' treated as a block scalar, the short folded body is measured
    // (under budget) and the long following tools: value is NOT counted.
    const folded =
      '---\nname: a\ndescription: >2\n' +
      '  short folded body line\n' +
      `tools: ${'T'.repeat(600)}\n` +
      '---\n\nbody\n';
    write(root, '.claude/agents/indent-indicator.md', folded);
    const r = run(root);
    expect(r.out).toContain('violations=0');
    expect(r.code).toBe(0);
  });
});
