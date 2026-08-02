/**
 * adopt-ci-templates.test.mjs
 *
 * Vitest self-test for scripts/adopt-ci-templates.mjs (dev-pipeline-v2
 * Chunk 13). Pure-function tests exercise the render/validate logic
 * directly; fixture tests use isolated temp dirs (never the real repo) for
 * path-existence and file-write behaviour; a small set of CLI-integration
 * tests spawn the real script as a child process to confirm the exit-code
 * and message contract end to end.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  requiredKeysFor,
  validateValues,
  stripHeaderComment,
  stripConditionals,
  substitutePlaceholders,
  renderTemplate,
  findLeftoverPlaceholders,
  adoptTarget,
  TEMPLATE_FILES,
} from './adopt-ci-templates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, 'adopt-ci-templates.mjs');
const REAL_TEMPLATES_DIR = path.resolve(HERE, '..', 'templates', 'github-workflows');

const tempDirs = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `adopt-ci-templates-${crypto.randomUUID()}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeCallee(root, relPath) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'on:\n  workflow_call:\n    inputs:\n      tested_sha:\n        required: true\n        type: string\n', 'utf8');
}

function writeConfig(root, ciTemplates) {
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-registries.json'), JSON.stringify({ ci_templates: ciTemplates }, null, 2), 'utf8');
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', timeout: 60000 });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// stripHeaderComment
// ---------------------------------------------------------------------------
describe('stripHeaderComment', () => {
  it('removes the leading comment/blank-line block up to the first real content line', () => {
    const text = ['# header line one', '#', '#   {{RUNNER_LABELS}} documented here', '', 'name: ci-light', '', 'jobs:', '  light:', '    x: 1'].join('\n');
    const out = stripHeaderComment(text);
    expect(out.startsWith('name: ci-light')).toBe(true);
    expect(out).not.toContain('{{RUNNER_LABELS}}');
  });

  it('leaves body content (including later inline comments) untouched', () => {
    const text = ['# header', '', 'name: x', '', '# CSR-007: inline comment, retained', 'jobs:', '  a:', '    b: 1'].join('\n');
    const out = stripHeaderComment(text);
    expect(out).toContain('# CSR-007: inline comment, retained');
  });

  it('is a no-op when the file has no leading comment block', () => {
    const text = 'name: x\njobs: {}\n';
    expect(stripHeaderComment(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// substitutePlaceholders — the `${{ }}` vs `{{ }}` correctness property
// ---------------------------------------------------------------------------
describe('substitutePlaceholders', () => {
  it('substitutes a bare {{TOKEN}} while leaving ${{ expression }} byte-identical', () => {
    const text = 'runs-on: {{RUNNER_LABELS}}\nsha: ${{ github.event.pull_request.head.sha || github.sha }}\n';
    const rendered = substitutePlaceholders(text, { runner_labels: ['self-hosted', 'linux'] });
    expect(rendered).toBe('runs-on: [self-hosted, linux]\nsha: ${{ github.event.pull_request.head.sha || github.sha }}\n');
  });

  it('substitutes a path-kind placeholder as a plain string', () => {
    const text = 'uses: ./{{LIGHT_SUITE_WORKFLOW_PATH}}\n';
    const rendered = substitutePlaceholders(text, { light_suite_workflow_path: '.github/workflows/ci-light-suite.yml' });
    expect(rendered).toBe('uses: ./.github/workflows/ci-light-suite.yml\n');
  });

  it('leaves an unknown token untouched (leftover-check catches it downstream)', () => {
    const text = 'x: {{SOME_UNKNOWN_KEY}}\n';
    const rendered = substitutePlaceholders(text, { runner_labels: ['a'] });
    expect(rendered).toBe(text);
  });

  it('never matches inside a ${{ }} expression even when its inner text is uppercase-shaped', () => {
    const text = 'x: ${{ SOME.EXPRESSION }}\n';
    const rendered = substitutePlaceholders(text, { expression: 'nope' });
    expect(rendered).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// stripConditionals — both states, plus defensive throws
// ---------------------------------------------------------------------------
describe('stripConditionals', () => {
  const wrap = (block) => ['on:', '  pull_request:', '    types: [labeled]', ...block, '', '# next section'].join('\n');

  it('true: keeps content verbatim, strips only the two marker lines', () => {
    const text = wrap(['{{#if PUSH_MAIN_FULL_SUITE}}', '  push:', '    branches: [main]', '{{/if}}']);
    const out = stripConditionals(text, { push_main_full_suite: true });
    expect(out).toContain('  push:\n    branches: [main]');
    expect(out).not.toContain('{{#if');
    expect(out).not.toContain('{{/if}}');
  });

  it('false: strips markers AND content, leaving no orphaned blank line', () => {
    const text = wrap(['{{#if PUSH_MAIN_FULL_SUITE}}', '  push:', '    branches: [main]', '{{/if}}']);
    const out = stripConditionals(text, { push_main_full_suite: false });
    expect(out).not.toContain('push:');
    expect(out).not.toContain('{{');
    expect(out).toBe(['on:', '  pull_request:', '    types: [labeled]', '', '# next section'].join('\n'));
  });

  it('passes text with no conditional markers through unchanged', () => {
    const text = 'name: ci-light\njobs:\n  light:\n    uses: ./x\n';
    expect(stripConditionals(text, {})).toBe(text);
  });

  it('throws on an unterminated block', () => {
    const text = wrap(['{{#if PUSH_MAIN_FULL_SUITE}}', '  push:']);
    expect(() => stripConditionals(text, { push_main_full_suite: true })).toThrow(/unterminated/i);
  });

  it('throws when the conditional key is absent from values', () => {
    const text = wrap(['{{#if PUSH_MAIN_FULL_SUITE}}', '  push:', '{{/if}}']);
    expect(() => stripConditionals(text, {})).toThrow(/not present/i);
  });

  it('throws when the conditional key is not an explicit boolean', () => {
    const text = wrap(['{{#if PUSH_MAIN_FULL_SUITE}}', '  push:', '{{/if}}']);
    expect(() => stripConditionals(text, { push_main_full_suite: 'true' })).toThrow(/explicit boolean/i);
  });
});

// ---------------------------------------------------------------------------
// findLeftoverPlaceholders
// ---------------------------------------------------------------------------
describe('findLeftoverPlaceholders', () => {
  it('detects a surviving bare placeholder', () => {
    expect(findLeftoverPlaceholders('x: {{STILL_HERE}}\n')).toHaveLength(1);
  });

  it('does not flag ${{ }} GitHub Actions expressions', () => {
    expect(findLeftoverPlaceholders('sha: ${{ github.sha }}\n')).toHaveLength(0);
  });

  it('returns empty for fully-substituted text', () => {
    expect(findLeftoverPlaceholders('runs-on: [self-hosted, linux]\n')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderTemplate — combined pipeline on small synthetic fixtures
// ---------------------------------------------------------------------------
describe('renderTemplate', () => {
  it('strips header, resolves conditional, substitutes placeholder, preserves ${{ }}', () => {
    const text = [
      '# header',
      '#   {{RUNNER_LABELS}} documented here',
      '',
      'name: x',
      'on:',
      '{{#if PUSH_MAIN_FULL_SUITE}}',
      '  push:',
      '    branches: [main]',
      '{{/if}}',
      'jobs:',
      '  a:',
      '    runs-on: {{RUNNER_LABELS}}',
      '    sha: ${{ github.sha }}',
    ].join('\n');
    const out = renderTemplate(text, { runner_labels: ['self-hosted', 'linux'], push_main_full_suite: true });
    expect(findLeftoverPlaceholders(out)).toHaveLength(0);
    expect(out).toContain('runs-on: [self-hosted, linux]');
    expect(out).toContain('${{ github.sha }}');
    expect(out).toContain('branches: [main]');
  });
});

// ---------------------------------------------------------------------------
// requiredKeysFor
// ---------------------------------------------------------------------------
describe('requiredKeysFor', () => {
  it('ci-light requires only light_suite_workflow_path (WEB3-001: not runner_labels)', () => {
    const reqs = requiredKeysFor('ci-light').map((r) => r.key);
    expect(reqs).toEqual(['light_suite_workflow_path']);
  });

  it('merge-gate requires all four keys', () => {
    const reqs = requiredKeysFor('merge-gate').map((r) => r.key).sort();
    expect(reqs).toEqual(['light_suite_workflow_path', 'push_main_full_suite', 'runner_labels', 'suite_workflow_path']);
  });

  it('throws on an unknown target', () => {
    expect(() => requiredKeysFor('nope')).toThrow(/unknown target/i);
  });
});

// ---------------------------------------------------------------------------
// validateValues — fail-closed presence/emptiness/existence checks
// ---------------------------------------------------------------------------
describe('validateValues', () => {
  it('push_main_full_suite: false is a VALID value (presence, not truthiness)', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    const result = validateValues(
      'merge-gate',
      {
        runner_labels: ['self-hosted', 'linux'],
        suite_workflow_path: '.github/workflows/suite.yml',
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
        push_main_full_suite: false,
      },
      root
    );
    expect(result.valid).toBe(true);
  });

  it('push_main_full_suite entirely omitted is a hard failure', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    const result = validateValues(
      'merge-gate',
      {
        runner_labels: ['self-hosted', 'linux'],
        suite_workflow_path: '.github/workflows/suite.yml',
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
      },
      root
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('push_main_full_suite'))).toBe(true);
  });

  it('missing, empty, and whitespace-only required values are ALL named in one refusal', () => {
    const root = makeTempRoot();
    const result = validateValues(
      'merge-gate',
      {
        suite_workflow_path: '',
        light_suite_workflow_path: '   ',
        // runner_labels and push_main_full_suite entirely absent
      },
      root
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(4);
    const keys = result.errors.map((e) => e.split(':')[0]).sort();
    expect(keys).toEqual(['light_suite_workflow_path', 'push_main_full_suite', 'runner_labels', 'suite_workflow_path']);
  });

  it('a required path value whose target file does not exist is refused', () => {
    const root = makeTempRoot();
    const result = validateValues('ci-light', { light_suite_workflow_path: '.github/workflows/does-not-exist.yml' }, root);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not exist on disk/);
  });

  it('an empty runner_labels array, or one containing a blank entry, is refused', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    const base = {
      suite_workflow_path: '.github/workflows/suite.yml',
      light_suite_workflow_path: '.github/workflows/light-suite.yml',
      push_main_full_suite: true,
    };
    expect(validateValues('merge-gate', { ...base, runner_labels: [] }, root).valid).toBe(false);
    expect(validateValues('merge-gate', { ...base, runner_labels: ['self-hosted', '  '] }, root).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adoptTarget — WEB3-001 per-target scoping regression (the defect the whole
// matrix exists to prevent)
// ---------------------------------------------------------------------------
describe('adoptTarget — per-target scoping (WEB3-001)', () => {
  it('ci-light renders successfully with suite_workflow_path ABSENT from config entirely', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');
    const result = adoptTarget({
      target: 'ci-light',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: { light_suite_workflow_path: '.github/workflows/light-suite.yml' },
    });
    expect(result.errors).toEqual([]);
    expect(result.written).toBe(true);
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  it('ci-light renders successfully even when suite_workflow_path IS present but its target file does not exist', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows-2');
    const result = adoptTarget({
      target: 'ci-light',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: {
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
        suite_workflow_path: '.github/workflows/heavy-suite-not-created-yet.yml', // does not exist
        runner_labels: [], // deliberately invalid; ci-light must not care
      },
    });
    expect(result.written).toBe(true);
  });

  it('merge-gate REFUSES when the heavy callee (suite_workflow_path) does not exist on disk', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');
    const result = adoptTarget({
      target: 'merge-gate',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: {
        runner_labels: ['self-hosted', 'linux'],
        suite_workflow_path: '.github/workflows/heavy-suite-not-created-yet.yml',
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
        push_main_full_suite: true,
      },
    });
    expect(result.written).toBe(false);
    expect(result.errors.some((e) => e.startsWith('suite_workflow_path'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'merge-gate.yml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adoptTarget — overwrite guard, leftover-marker refusal
// ---------------------------------------------------------------------------
describe('adoptTarget — overwrite guard and leftover-marker refusal', () => {
  function fullMergeGateValues(root) {
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    return {
      runner_labels: ['self-hosted', 'linux'],
      suite_workflow_path: '.github/workflows/suite.yml',
      light_suite_workflow_path: '.github/workflows/light-suite.yml',
      push_main_full_suite: false,
    };
  }

  it('refuses to overwrite an existing rendered file without --overwrite, and succeeds with it', () => {
    const root = makeTempRoot();
    const values = fullMergeGateValues(root);
    const outputDir = path.join(root, '.github', 'workflows');

    const first = adoptTarget({ target: 'merge-gate', repoRoot: root, templatesDir: REAL_TEMPLATES_DIR, outputDir, values });
    expect(first.written).toBe(true);
    const originalContent = fs.readFileSync(first.outputPath, 'utf8');

    const second = adoptTarget({ target: 'merge-gate', repoRoot: root, templatesDir: REAL_TEMPLATES_DIR, outputDir, values });
    expect(second.written).toBe(false);
    expect(second.errors[0]).toMatch(/refusing to overwrite/);
    expect(fs.readFileSync(first.outputPath, 'utf8')).toBe(originalContent); // untouched

    const third = adoptTarget({ target: 'merge-gate', repoRoot: root, templatesDir: REAL_TEMPLATES_DIR, outputDir, values, overwrite: true });
    expect(third.written).toBe(true);
  });

  it('refuses to write when a placeholder the requirements matrix does not know about survives rendering', () => {
    const root = makeTempRoot();
    const fixtureTemplatesDir = path.join(root, 'fixture-templates');
    fs.mkdirSync(fixtureTemplatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureTemplatesDir, 'ci-light.yml'),
      ['name: ci-light', 'jobs:', '  light:', '    uses: ./{{LIGHT_SUITE_WORKFLOW_PATH}}', '    extra: {{UNEXPECTED_TOKEN}}'].join('\n'),
      'utf8'
    );
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');

    const result = adoptTarget({
      target: 'ci-light',
      repoRoot: root,
      templatesDir: fixtureTemplatesDir,
      outputDir,
      values: { light_suite_workflow_path: '.github/workflows/light-suite.yml' },
    });
    expect(result.written).toBe(false);
    expect(result.errors[0]).toMatch(/unresolved template marker/);
    expect(fs.existsSync(path.join(outputDir, 'ci-light.yml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-template render — both templates, dummy-but-valid values
// ---------------------------------------------------------------------------
describe('adoptTarget — real templates from templates/github-workflows/', () => {
  it('renders ci-light.yml with no {{ and no orphaned markers', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');
    const result = adoptTarget({
      target: 'ci-light',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: { light_suite_workflow_path: '.github/workflows/light-suite.yml' },
    });
    expect(result.written).toBe(true);
    const rendered = fs.readFileSync(result.outputPath, 'utf8');
    expect(findLeftoverPlaceholders(rendered)).toHaveLength(0);
    expect(rendered).not.toContain('{{#if');
    expect(rendered).not.toContain('{{/if}}');
    expect(rendered).toContain('uses: ./.github/workflows/light-suite.yml');
  });

  it('renders merge-gate.yml (push_main_full_suite: true) with no {{ and the push block present', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');
    const result = adoptTarget({
      target: 'merge-gate',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: {
        runner_labels: ['self-hosted', 'linux'],
        suite_workflow_path: '.github/workflows/suite.yml',
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
        push_main_full_suite: true,
      },
    });
    expect(result.written).toBe(true);
    const rendered = fs.readFileSync(result.outputPath, 'utf8');
    expect(findLeftoverPlaceholders(rendered)).toHaveLength(0);
    expect(rendered).toContain('branches: [main]');
    expect(rendered).toContain('runs-on: [self-hosted, linux]');
    expect(rendered).toContain('uses: ./.github/workflows/suite.yml');
    expect(rendered).toContain('${{ github.event.pull_request.head.sha || github.sha }}');
  });

  it('renders merge-gate.yml (push_main_full_suite: false) with no {{ and the push block absent', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    const outputDir = path.join(root, '.github', 'workflows');
    const result = adoptTarget({
      target: 'merge-gate',
      repoRoot: root,
      templatesDir: REAL_TEMPLATES_DIR,
      outputDir,
      values: {
        runner_labels: ['self-hosted', 'linux'],
        suite_workflow_path: '.github/workflows/suite.yml',
        light_suite_workflow_path: '.github/workflows/light-suite.yml',
        push_main_full_suite: false,
      },
    });
    expect(result.written).toBe(true);
    const rendered = fs.readFileSync(result.outputPath, 'utf8');
    expect(findLeftoverPlaceholders(rendered)).toHaveLength(0);
    expect(rendered).not.toContain('branches: [main]');
    expect(rendered).toContain('types: [labeled]');
  });
});

// ---------------------------------------------------------------------------
// CLI integration — exit codes and message contract, spawned as a real process
// ---------------------------------------------------------------------------
describe('CLI (main)', () => {
  it('exits non-zero and reports every missing key when config is incomplete', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    writeConfig(root, {
      suite_workflow_path: '.github/workflows/suite.yml',
      light_suite_workflow_path: '.github/workflows/light-suite.yml',
      // runner_labels and push_main_full_suite both omitted
    });
    const res = runCli(['--repo', root, '--templates-dir', REAL_TEMPLATES_DIR, '--target', 'merge-gate']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('runner_labels');
    expect(res.stderr).toContain('push_main_full_suite');
    expect(fs.existsSync(path.join(root, '.github', 'workflows', 'merge-gate.yml'))).toBe(false);
  });

  it('exits non-zero when the config file is entirely absent', () => {
    const root = makeTempRoot();
    const res = runCli(['--repo', root, '--templates-dir', REAL_TEMPLATES_DIR, '--target', 'ci-light']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('config not found');
  });

  it('exits 0 and writes both rendered files for --target all with a complete config', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    writeConfig(root, {
      runner_labels: ['self-hosted', 'linux'],
      suite_workflow_path: '.github/workflows/suite.yml',
      light_suite_workflow_path: '.github/workflows/light-suite.yml',
      push_main_full_suite: false,
    });
    const res = runCli(['--repo', root, '--templates-dir', REAL_TEMPLATES_DIR, '--target', 'all']);
    expect(res.status).toBe(0);
    for (const file of Object.values(TEMPLATE_FILES)) {
      expect(fs.existsSync(path.join(root, '.github', 'workflows', file))).toBe(true);
    }
  });

  // Added 2026-07-28 (dual-reviewer). A job-level `permissions:` block REPLACES
  // the workflow-level one rather than merging with it — every scope omitted
  // from it becomes `none`. resolve-label declares its own block for
  // `pull-requests: read`, which therefore withdrew the workflow-level
  // `contents: read` from the ONE job in merge-gate that runs
  // actions/checkout, breaking every gated run on a private repo. Nothing in
  // this suite noticed, because it only asserted that the files were written.
  it('the rendered merge-gate keeps contents: read on the job that checks out', () => {
    const root = makeTempRoot();
    writeCallee(root, '.github/workflows/suite.yml');
    writeCallee(root, '.github/workflows/light-suite.yml');
    writeConfig(root, {
      runner_labels: ['self-hosted', 'linux'],
      suite_workflow_path: '.github/workflows/suite.yml',
      light_suite_workflow_path: '.github/workflows/light-suite.yml',
      push_main_full_suite: false,
    });
    const res = runCli(['--repo', root, '--templates-dir', REAL_TEMPLATES_DIR, '--target', 'merge-gate']);
    expect(res.status).toBe(0);

    const rendered = fs.readFileSync(path.join(root, '.github', 'workflows', 'merge-gate.yml'), 'utf8');
    const resolveLabelAt = rendered.indexOf('  resolve-label:');
    expect(resolveLabelAt, 'resolve-label job must exist').toBeGreaterThan(-1);
    // The job's own block runs from its declaration to the next job at the
    // same indent level.
    const nextJobAt = rendered.indexOf('\n  suite:', resolveLabelAt);
    expect(nextJobAt).toBeGreaterThan(resolveLabelAt);
    const jobBlock = rendered.slice(resolveLabelAt, nextJobAt);

    expect(jobBlock).toMatch(/^\s+permissions:$/m);
    expect(jobBlock).toMatch(/^\s+contents: read$/m);
    expect(jobBlock).toMatch(/^\s+pull-requests: read$/m);
    expect(jobBlock).toContain('actions/checkout@v4');
  });
});
