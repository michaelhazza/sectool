/**
 * generate-architecture-anchors.test.ts
 *
 * Pure-function tests for generateArchitectureAnchors plus CLI-level checks
 * for the exit-code and idempotency contract. Runner: Vitest (repo convention —
 * no node:test/node:assert).
 */

import { test, expect } from 'vitest';
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
  expect(result.added).toBe(2);
  expect(result.content).toMatch(/<a id="route-conventions"><\/a>\n## Route Conventions/);
  expect(result.content).toMatch(/<a id="service-layer"><\/a>\n## Service Layer/);
});

test('idempotent: second pass adds zero anchors', () => {
  const md = '## Route Conventions\n\nBody.\n\n## Service Layer\n';
  const first = generateArchitectureAnchors(md);
  const second = generateArchitectureAnchors(first.content);
  expect(second.added).toBe(0);
  expect(second.alreadyAnchored).toBe(2);
  expect(second.content).toBe(first.content);
});

test('level-1 and level-3 headings are not anchored', () => {
  const md = '# Top\n\n### Deep\n\n## Real Section\n';
  const result = generateArchitectureAnchors(md);
  expect(result.added).toBe(1);
  expect(result.content).toMatch(/<a id="real-section"><\/a>\n## Real Section/);
  expect(result.content).not.toMatch(/<a id="top">/);
  expect(result.content).not.toMatch(/<a id="deep">/);
});

test('headings inside code blocks are skipped', () => {
  const md = ['## Real', '', '```markdown', '## Fake In Fence', '```', ''].join('\n');
  const result = generateArchitectureAnchors(md);
  expect(result.added).toBe(1);
  expect(result.content).not.toMatch(/<a id="fake-in-fence">/);
});

test('duplicate headings and existing-anchor collisions get numeric suffixes', () => {
  const md = '<a id="setup"></a>\n## Existing\n\n## Setup\n\n## Setup\n';
  const result = generateArchitectureAnchors(md);
  // "Existing" is already anchored (anchor line directly above); the two
  // "Setup" headings must avoid the pre-existing explicit id "setup".
  expect(result.added).toBe(2);
  expect(result.alreadyAnchored).toBe(1);
  expect(result.content).toMatch(/<a id="setup-1"><\/a>\n## Setup/);
  expect(result.content).toMatch(/<a id="setup-2"><\/a>\n## Setup/);
});

test('inline code and links in headings slug like the audit expects', () => {
  const md = '## The `taskService` [layer](docs/x.md)\n';
  const result = generateArchitectureAnchors(md);
  expect(result.added).toBe(1);
  expect(result.content).toMatch(/<a id="the-taskservice-layer"><\/a>/);
});

test('generated anchors resolve in auditContextPacks (end-to-end coherence)', () => {
  const md = '## Route Conventions\n\nBody.\n';
  const anchored = generateArchitectureAnchors(md).content;
  const pack = '- `architecture.md`:\n  - `#route-conventions`\n';
  const result = auditContextPacks({
    packs: [{ path: 'implement.md', content: pack }],
    architectureMarkdown: anchored,
  });
  expect(result.kind).toBe('ok');
});

test('CLI writes in place, reports counts, and is idempotent across runs', { timeout: 120_000 }, () => {
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
    expect(first.status, `expected exit 0, got ${first.status}; stderr=${first.stderr}`).toBe(0);
    expect(first.stdout).toMatch(/added 2 anchors \(0 level-2 headings already anchored\)/);
    expect(readFileSync(archPath, 'utf8')).toMatch(/<a id="section-one"><\/a>\n## Section One/);

    const second = spawnSync('npx', ['tsx', SCRIPT_PATH], opts);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/added 0 anchors \(2 level-2 headings already anchored\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI --dry-run reports without writing', { timeout: 120_000 }, () => {
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
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/added 1 anchors .*\[dry-run — nothing written\]/);
    expect(readFileSync(archPath, 'utf8')).toBe(original);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI exits 1 when architecture.md is absent', { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gen-anchors-missing-'));
  try {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/architecture\.md not found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
