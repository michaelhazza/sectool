/**
 * generate-architecture-anchors.test.ts
 *
 * Pure-function tests for generateArchitectureAnchors plus CLI-level checks
 * for the exit-code and idempotency contract.
 * Run via: npx tsx scripts/__tests__/generate-architecture-anchors.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateArchitectureAnchors } from '../generate-architecture-anchors.js';
import { auditContextPacks } from '../audit-context-packs.js';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_PATH = join(dirname(__filename), '..', 'generate-architecture-anchors.ts');

test('anchors every level-2 heading with the GFM slug', () => {
  const md = '# Title\n\n## Route Conventions\n\nBody.\n\n## Service Layer\n\nBody.\n';
  const result = generateArchitectureAnchors(md);
  assert.equal(result.added, 2);
  assert.match(result.content, /<a id="route-conventions"><\/a>\n## Route Conventions/);
  assert.match(result.content, /<a id="service-layer"><\/a>\n## Service Layer/);
});

test('idempotent: second pass adds zero anchors', () => {
  const md = '## Route Conventions\n\nBody.\n\n## Service Layer\n';
  const first = generateArchitectureAnchors(md);
  const second = generateArchitectureAnchors(first.content);
  assert.equal(second.added, 0);
  assert.equal(second.alreadyAnchored, 2);
  assert.equal(second.content, first.content);
});

test('level-1 and level-3 headings are not anchored', () => {
  const md = '# Top\n\n### Deep\n\n## Real Section\n';
  const result = generateArchitectureAnchors(md);
  assert.equal(result.added, 1);
  assert.match(result.content, /<a id="real-section"><\/a>\n## Real Section/);
  assert.doesNotMatch(result.content, /<a id="top">/);
  assert.doesNotMatch(result.content, /<a id="deep">/);
});

test('headings inside code blocks are skipped', () => {
  const md = ['## Real', '', '```markdown', '## Fake In Fence', '```', ''].join('\n');
  const result = generateArchitectureAnchors(md);
  assert.equal(result.added, 1);
  assert.doesNotMatch(result.content, /<a id="fake-in-fence">/);
});

test('duplicate headings and existing-anchor collisions get numeric suffixes', () => {
  const md = '<a id="setup"></a>\n## Existing\n\n## Setup\n\n## Setup\n';
  const result = generateArchitectureAnchors(md);
  // "Existing" is already anchored (anchor line directly above); the two
  // "Setup" headings must avoid the pre-existing explicit id "setup".
  assert.equal(result.added, 2);
  assert.equal(result.alreadyAnchored, 1);
  assert.match(result.content, /<a id="setup-1"><\/a>\n## Setup/);
  assert.match(result.content, /<a id="setup-2"><\/a>\n## Setup/);
});

test('inline code and links in headings slug like the audit expects', () => {
  const md = '## The `taskService` [layer](docs/x.md)\n';
  const result = generateArchitectureAnchors(md);
  assert.equal(result.added, 1);
  assert.match(result.content, /<a id="the-taskservice-layer"><\/a>/);
});

test('generated anchors resolve in auditContextPacks (end-to-end coherence)', () => {
  const md = '## Route Conventions\n\nBody.\n';
  const anchored = generateArchitectureAnchors(md).content;
  const pack = '- `architecture.md`:\n  - `#route-conventions`\n';
  const result = auditContextPacks({
    packs: [{ path: 'implement.md', content: pack }],
    architectureMarkdown: anchored,
  });
  assert.equal(result.kind, 'ok');
});

test('CLI writes in place, reports counts, and is idempotent across runs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gen-anchors-cli-'));
  try {
    const archPath = join(tmp, 'architecture.md');
    writeFileSync(archPath, '## Section One\n\nBody.\n\n## Section Two\n');
    const opts = {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8' as const,
      shell: process.platform === 'win32',
      timeout: 30_000,
    };
    const first = spawnSync('npx', ['tsx', SCRIPT_PATH], opts);
    assert.equal(first.status, 0, `expected exit 0, got ${first.status}; stderr=${first.stderr}`);
    assert.match(first.stdout, /added 2 anchors \(0 level-2 headings already anchored\)/);
    assert.match(readFileSync(archPath, 'utf8'), /<a id="section-one"><\/a>\n## Section One/);

    const second = spawnSync('npx', ['tsx', SCRIPT_PATH], opts);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /added 0 anchors \(2 level-2 headings already anchored\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI --dry-run reports without writing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gen-anchors-dry-'));
  try {
    const archPath = join(tmp, 'architecture.md');
    const original = '## Section One\n';
    writeFileSync(archPath, original);
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--dry-run'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /added 1 anchors .*\[dry-run — nothing written\]/);
    assert.equal(readFileSync(archPath, 'utf8'), original);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI exits 1 when architecture.md is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gen-anchors-missing-'));
  try {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /architecture\.md not found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
