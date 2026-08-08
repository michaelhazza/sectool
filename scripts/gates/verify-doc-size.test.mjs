/**
 * verify-doc-size.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-doc-size.mjs (control C1).
 * Each case builds a synthetic consumer root in an isolated temp dir and runs
 * the real gate as a child process with GATE_ROOT pointed at it, asserting the
 * exit code and the presence/absence of specific warning lines.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-doc-size.mjs');

function tmpRoot() {
  const dir = path.join(os.tmpdir(), `doc-size-${crypto.randomUUID()}`);
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

/** A current-focus.md with a generated region of the given size + a small operator block. */
function focusFile(operatorLines, generatedBytes) {
  const op = Array.from({ length: operatorLines }, (_, i) => `pointer line ${i}`).join('\n');
  const gen = 'x'.repeat(generatedBytes);
  return `${op}\n<!-- STATUS:GENERATED:BEGIN -->\n${gen}\n<!-- STATUS:GENERATED:END -->\n`;
}

describe('verify-doc-size gate', () => {
  it('clean root (all within budget) → exit 0', () => {
    const root = tmpRoot();
    write(root, 'tasks/current-focus.md', focusFile(10, 50000)); // big generated region, small operator block
    write(root, 'tasks/todo.md', 'todo\n'.repeat(50));
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('violations=0');
  });

  it('excludes the generated region — huge generated block, tiny operator block still passes', () => {
    const root = tmpRoot();
    write(root, 'tasks/current-focus.md', focusFile(5, 500_000)); // 500KB generated, ~5 operator lines
    const { code } = run(root);
    expect(code).toBe(0);
  });

  it('current-focus operator portion over 4KB → exit 2 action-needed', () => {
    const root = tmpRoot();
    // 200 operator lines of ~40 chars each ~= 8KB operator portion.
    const bigOp = Array.from({ length: 200 }, () => 'x'.repeat(40)).join('\n');
    write(root, 'tasks/current-focus.md', `${bigOp}\n<!-- STATUS:GENERATED:BEGIN -->\ng\n<!-- STATUS:GENERATED:END -->\n`);
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('[action-needed]');
    expect(out).toContain('tasks/current-focus.md');
  });

  it('todo.md over 200 lines → exit 2 action-needed', () => {
    const root = tmpRoot();
    write(root, 'tasks/todo.md', 'item\n'.repeat(250));
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toMatch(/\[action-needed\] tasks\/todo\.md/);
  });

  it('KNOWLEDGE.md over 200KB → exit 2 but grace-only (no action-needed)', () => {
    const root = tmpRoot();
    write(root, 'KNOWLEDGE.md', `# K\n${'y'.repeat(210 * 1024)}\n`);
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('[grace] KNOWLEDGE.md');
    expect(out).toContain('action_needed=0');
  });

  it('KNOWLEDGE.md over 150 live entries (### [ + ## ) → grace warning', () => {
    const root = tmpRoot();
    const entries = Array.from({ length: 160 }, (_, i) => `### [entry ${i}]\nbody\n`).join('\n');
    write(root, 'KNOWLEDGE.md', entries);
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toMatch(/\[grace\] KNOWLEDGE\.md: \d+ live entries/);
  });

  it('docs/ root new megadoc (unregistered, not grandfathered) → exit 2 action-needed', () => {
    const root = tmpRoot();
    write(root, 'docs/new-huge-spec.md', 'z'.repeat(120 * 1024));
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('[action-needed] docs/new-huge-spec.md');
  });

  it('docs/ root megadoc registered in doc-sync (backtick path) → info, not a warning', () => {
    const root = tmpRoot();
    write(root, 'docs/new-huge-spec.md', 'z'.repeat(120 * 1024));
    write(root, 'docs/doc-sync.md', '| `docs/new-huge-spec.md` | some trigger |\n');
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('registered in docs/doc-sync.md');
  });

  it('M2: an exact backtick path in doc-sync PROSE (not a registry table row) does NOT register → warns', () => {
    const root = tmpRoot();
    write(root, 'docs/legacy-huge.md', 'z'.repeat(120 * 1024));
    // The exact backticked path appears, but only in a prose sentence, not as a
    // `| `docs/legacy-huge.md` | … |` registry row.
    write(root, 'docs/doc-sync.md', 'Do not register `docs/legacy-huge.md`; it is being removed.\n');
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('[action-needed] docs/legacy-huge.md');
  });

  it('H4: a bare stem mentioned in doc-sync PROSE (no backtick path) does NOT count as registered → warns', () => {
    const root = tmpRoot();
    // A common-word stem: "plan". doc-sync mentions the word "plan" in prose but
    // never registers `docs/plan.md` as a path — must NOT false-green.
    write(root, 'docs/plan.md', 'p'.repeat(120 * 1024));
    write(root, 'docs/doc-sync.md', 'This registry describes when to update each plan and spec in the repo.\n');
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain('[action-needed] docs/plan.md');
  });

  it('docs/ root megadoc grandfathered in baseline → info, not a warning', () => {
    const root = tmpRoot();
    write(root, 'docs/legacy-huge-spec.md', 'z'.repeat(120 * 1024));
    write(root, '.claude/doc-size-baseline.json', JSON.stringify({ grandfatheredRootDocs: ['docs/legacy-huge-spec.md'] }));
    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('grandfathered');
  });

  it('missing GATE_ROOT → exit 1 (fail-closed misconfiguration)', () => {
    const res = spawnSync(process.execPath, [GATE], {
      cwd: HERE,
      encoding: 'utf8',
      env: { ...process.env, GATE_ROOT: path.join(os.tmpdir(), `nope-${crypto.randomUUID()}`) },
    });
    expect(res.status).toBe(1);
  });
});
