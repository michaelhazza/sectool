/**
 * audit-context-packs.test.ts
 *
 * Pure-function tests for auditContextPacks (Contract 4) plus a few CLI-level
 * regressions for the script's exit-code contract.
 * Run via: npx tsx scripts/__tests__/audit-context-packs.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditContextPacks, extractExplicitAnchors } from '../audit-context-packs.js';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_PATH = join(dirname(__filename), '..', 'audit-context-packs.ts');

// ---------------------------------------------------------------------------
// Test 1: Empty packs → ok
// ---------------------------------------------------------------------------
test('empty packs returns ok', () => {
  const result = auditContextPacks({ packs: [], architectureMarkdown: '' });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 2: Markdown-link reference to a present heading anchor → ok
// ---------------------------------------------------------------------------
test('markdown link to present heading anchor returns ok', () => {
  const arch = '# Overview\n\nSome content.\n\n## Key Concepts\n\nMore content.\n';
  const pack = '[see section](architecture.md#key-concepts)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 3: Markdown link to missing anchor → fail with correct miss
// ---------------------------------------------------------------------------
test('markdown link to missing anchor returns fail', () => {
  const arch = '# Overview\n';
  const pack = '[see section](architecture.md#nonexistent-section)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'nonexistent-section');
  assert.equal(result.missing[0].pack, 'review.md');
  assert.equal(result.missing[0].line, 1);
});

// ---------------------------------------------------------------------------
// Test 4: Duplicate headings get GFM suffix -1, -2
// ---------------------------------------------------------------------------
test('duplicate heading slugs get numeric suffixes', () => {
  const arch = '# Setup\n\nContent A.\n\n## Setup\n\nContent B.\n\n### Setup\n\nContent C.\n';
  // First "Setup" → #setup, second → #setup-1, third → #setup-2
  const pack = [
    '[first](architecture.md#setup)',
    '[second](architecture.md#setup-1)',
    '[third](architecture.md#setup-2)',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'minimal.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 5: Anchors inside GFM fenced blocks are NOT treated as references
// ---------------------------------------------------------------------------
test('anchors inside fenced code blocks are ignored', () => {
  const arch = '# Real Section\n';
  // The markdown link inside the fence should NOT be extracted as a ref.
  const pack = [
    'Some intro text.',
    '```markdown',
    '[example](architecture.md#fake-anchor)',
    '```',
    'End of file.',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'implement.md', content: pack }],
    architectureMarkdown: arch,
  });
  // fake-anchor is NOT in architecture.md, but it's inside a fence → no miss.
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 6: Bare-fragment form under source-block heading
// ---------------------------------------------------------------------------
test('bare fragment under architecture.md source-block heading is extracted', () => {
  const arch = '# Services Layer\n\nContent.\n';
  const pack = [
    '- `architecture.md`:',
    '  - `#services-layer` — core service conventions',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'debug.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 7: Bare fragment with broken anchor → fail
// ---------------------------------------------------------------------------
test('bare fragment with missing anchor returns fail', () => {
  const arch = '# Services Layer\n\nContent.\n';
  const pack = [
    '- `architecture.md`:',
    '  - `#totally-missing` — does not exist',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'debug.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing[0].anchor, 'totally-missing');
});

// ---------------------------------------------------------------------------
// Test 8: Explicit <a id="..."></a> anchor is found
// ---------------------------------------------------------------------------
test('<a id> anchor is resolved', () => {
  const arch = '<a id="custom-anchor"></a>\n# Some Heading\n';
  const pack = '[link](architecture.md#custom-anchor)\n';
  const result = auditContextPacks({
    packs: [{ path: 'handover.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 9: Empty architectureMarkdown with pack containing refs → fail
// ---------------------------------------------------------------------------
test('empty architecture.md with pack anchor refs returns fail', () => {
  const pack = '[see section](architecture.md#any-section)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: '',
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'any-section');
});

// ---------------------------------------------------------------------------
// Test 10: Fragment-only link form [text](#anchor) also works
// ---------------------------------------------------------------------------
test('fragment-only markdown link [text](#anchor) is extracted', () => {
  const arch = '# Authentication\n\nContent.\n';
  const pack = '[see authentication](#authentication)\n';
  const result = auditContextPacks({
    packs: [{ path: 'minimal.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

// ---------------------------------------------------------------------------
// Test 11: Multiple packs — one clean, one with miss
// ---------------------------------------------------------------------------
test('multiple packs — one miss surfaces with correct pack name', () => {
  const arch = '# Setup\n\nContent.\n';
  const clean = '[setup](architecture.md#setup)\n';
  const broken = '[missing](architecture.md#no-such-section)\n';
  const result = auditContextPacks({
    packs: [
      { path: 'implement.md', content: clean },
      { path: 'review.md', content: broken },
    ],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].pack, 'review.md');
  assert.equal(result.missing[0].anchor, 'no-such-section');
});

// ---------------------------------------------------------------------------
// Test 12 (PR-FLL-003 regression): Heading-shape line inside fenced code block
// in architecture.md is NOT registered as a declared anchor.
// ---------------------------------------------------------------------------
test('headings inside fenced code blocks in architecture.md are not declared anchors', () => {
  const arch = [
    '# Real Heading',
    '',
    'Example markup:',
    '',
    '```markdown',
    '## Fake Heading Inside Fence',
    '```',
    '',
    '# Real Heading Two',
    '',
  ].join('\n');
  const pack = '[see fake](architecture.md#fake-heading-inside-fence)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail', 'fenced-block headings must not register as declared anchors');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing[0].anchor, 'fake-heading-inside-fence');
});

// ---------------------------------------------------------------------------
// Test 13 (PR-FLL-004 regression): GFM duplicate-suffix never collides with
// a naturally-suffixed sibling heading.
// `# Setup`, `# Setup`, `# Setup 1` → setup, setup-1, setup-1-1
// ---------------------------------------------------------------------------
test('duplicate-heading suffix skips collisions with naturally-suffixed siblings', () => {
  const arch = '# Setup\n\n# Setup\n\n# Setup 1\n';
  // setup-1-1 is what GitHub's renderer produces for the third heading.
  const pack = '[ref](architecture.md#setup-1-1)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'ok', 'setup-1-1 must be a registered anchor');
});

// ---------------------------------------------------------------------------
// Test 14 (OAI-PR-003 regression): GitHub heading-anchor slugs preserve
// underscores. The earlier slugger stripped them, so headings like
// `# State machine (usability_state)` produced `state-machine-usabilitystate`
// instead of the rendered `state-machine-usability_state`. Valid links in
// context packs would have been reported as broken.
// ---------------------------------------------------------------------------
test('GFM slug preserves underscores in heading text', () => {
  const arch = '# API_V2 Reference\n\n## State machine (usability_state)\n';
  const pack = [
    '[api](architecture.md#api_v2-reference)',
    '[state](architecture.md#state-machine-usability_state)',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'ok', 'underscored anchors must be recognised');
});

// ---------------------------------------------------------------------------
// Test 15 (R2 OAI-PR-002 regression): bare backtick fragments under a
// source-block heading must allow underscores. The extractor previously used
// `[a-z0-9-]` and silently skipped underscored anchors — so a broken
// underscored anchor in a pack's source-block list would never be flagged.
// ---------------------------------------------------------------------------
test('bare backtick fragment under source-block heading allows underscores', () => {
  const arch = '# Real Section\n';
  // Pack carries a source-block heading then a bare backtick fragment with an
  // underscore. The fragment names an anchor that is NOT declared, so the
  // audit must catch it as missing — proving extraction happened.
  const pack = [
    '- `architecture.md`:',
    '  - `#state-machine-usability_state`',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'minimal.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail', 'underscored bare fragment must be extracted and validated');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'state-machine-usability_state');
});

// ---------------------------------------------------------------------------
// Test 17 (R3 OAI-PR-002 regression): GFM fences may be indented by up to
// 3 spaces. An indented example fence containing a markdown link must NOT
// have that link extracted as a real pack ref.
// ---------------------------------------------------------------------------
test('indented fence (2 spaces) hides example pack link from extractor', () => {
  const arch = '# Real Section\n';
  const pack = [
    'Intro text.',
    '  ```markdown',
    '  [example](architecture.md#fake-anchor)',
    '  ```',
    'End.',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'ok', 'indented fenced-block link must not be treated as a real ref');
});

// ---------------------------------------------------------------------------
// Test 18 (R3 OAI-PR-002 regression): an indented fence containing a heading
// example in architecture.md must NOT register that heading as a declared
// anchor. If it did, a context pack link to that fake anchor would falsely
// pass.
// ---------------------------------------------------------------------------
test('indented fence (2 spaces) in architecture.md hides example heading from declared anchors', () => {
  const arch = [
    '# Real Heading',
    '',
    '  ```markdown',
    '  # Fake Heading Inside Indented Fence',
    '  ```',
    '',
  ].join('\n');
  const pack = '[fake](architecture.md#fake-heading-inside-indented-fence)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail', 'fake heading inside indented fence must not register as a declared anchor');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing[0].anchor, 'fake-heading-inside-indented-fence');
});

// ---------------------------------------------------------------------------
// Test 19 (PR #14 feedback regression): an example link rendered inside a
// 4-space-indented Markdown code block must NOT be treated as a real anchor
// ref. Pack files routinely include example markdown showing what an
// architecture.md link looks like — those examples are documentation, not
// references the audit should validate. The mask must cover indented code
// blocks in addition to fenced blocks.
// ---------------------------------------------------------------------------
test('link inside 4-space-indented code block is NOT extracted as a real ref', () => {
  const arch = '# Real Section\n';
  const pack = [
    'Intro paragraph.',
    '',                              // blank line required to start indented block
    '    Example markdown:',
    '    [example](architecture.md#fake-anchor)',
    '',
    'End paragraph.',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  // The indented lines are an indented code block per CommonMark §4.4.
  // Links inside are example markup, not references.
  assert.equal(result.kind, 'ok', 'links inside indented code blocks must not be extracted as refs');
});

// ---------------------------------------------------------------------------
// Test 20 (PR #14 feedback regression): a non-blank prose line that happens
// to be indented 4+ spaces is NOT a code block if it's a continuation of an
// in-progress paragraph (indented code blocks "cannot interrupt a paragraph"
// per CommonMark §4.4).
// ---------------------------------------------------------------------------
test('4-space-indented line that continues a paragraph is NOT masked', () => {
  const arch = '# Real Section\n';
  // No blank line between the intro and the indented continuation, so the
  // indented line is paragraph text, not a code block.
  const pack = [
    'Intro paragraph that wraps and continues on the next line',
    '    [example](architecture.md#fake-anchor)',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  // The indented line is paragraph continuation; the link IS extracted; the
  // anchor doesn't exist; audit fails.
  assert.equal(result.kind, 'fail', 'paragraph-continuation indent must not mask the line');
});

// ---------------------------------------------------------------------------
// Test 21 (PR #456 feedback regression): explicit <a id="..."></a> tags
// inside fenced code blocks must NOT register as declared anchors. The
// previous implementation ran the <a id> regex over the full markdown
// string before applying the fence mask, allowing example markup in
// architecture.md to ghost-register fake anchors.
// ---------------------------------------------------------------------------
test('explicit <a id> inside a fenced block is NOT a declared anchor', () => {
  const arch = [
    '# Real Heading',
    '',
    'Example anchor syntax:',
    '',
    '```html',
    '<a id="fake-id-inside-fence"></a>',
    '```',
    '',
    '# Real Heading Two',
  ].join('\n');
  const pack = '[fake](architecture.md#fake-id-inside-fence)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail', '<a id> inside fenced block must not register as a declared anchor');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing[0].anchor, 'fake-id-inside-fence');
});

// ---------------------------------------------------------------------------
// Test 22 (PR #456 feedback regression): explicit <a id> inside a 4-space
// indented code block also must NOT register as a declared anchor.
// ---------------------------------------------------------------------------
test('explicit <a id> inside indented code block is NOT a declared anchor', () => {
  const arch = [
    '# Real Heading',
    '',                              // blank line required to start indented block
    '    <a id="fake-id-in-indented-block"></a>',
    '',
    '# Real Heading Two',
  ].join('\n');
  const pack = '[fake](architecture.md#fake-id-in-indented-block)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail', '<a id> inside indented code block must not register');
});

// ---------------------------------------------------------------------------
// Test 16 (R2 OAI-PR-001 regression): CLI must exit 0 when there are no
// context packs to validate, even if architecture.md is also missing. The
// pure helper's contract is "empty packs → ok"; the CLI used to require
// architecture.md first and would falsely block finalisation on repos that
// have not yet adopted context packs.
// ---------------------------------------------------------------------------
test('CLI exits 0 when no context packs exist (architecture.md also absent)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-cli-noempty-'));
  try {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.match(result.stdout, /^OK\s*$/, 'expected stdout "OK"');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unmapped-placeholder detection (v2.35.0): {{ARCHITECTURE_ANCHOR:<purpose>}}
// tokens left in a pack mean adoption Phase 3b was never run. They must be
// surfaced (previously the audit was blind to them and passed vacuously) but
// remain advisory by default.
// ---------------------------------------------------------------------------
test('unmapped placeholder token is reported with pack, purpose, and line', () => {
  const arch = '# Overview\n';
  const pack = [
    '# Review pack',
    '',
    '- `architecture.md`:',
    '  - `{{ARCHITECTURE_ANCHOR:route-conventions}}`',
    '',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'ok', 'unmapped tokens alone must not fail the audit');
  assert.ok(result.unmapped, 'unmapped array must be present');
  assert.equal(result.unmapped!.length, 1);
  assert.deepEqual(result.unmapped![0], { pack: 'review.md', purpose: 'route-conventions', line: 4 });
});

test('pack with no unmapped tokens returns bare ok shape (back-compat)', () => {
  const arch = '# Overview\n\n## Key Concepts\n';
  const pack = '[see section](architecture.md#key-concepts)\n';
  const result = auditContextPacks({
    packs: [{ path: 'review.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' }, 'unmapped field must be absent when empty');
});

test('placeholder token inside a fenced code block is example markup, not unmapped', () => {
  const arch = '# Overview\n';
  const pack = [
    '# Docs',
    '',
    '```markdown',
    '  - `{{ARCHITECTURE_ANCHOR:route-conventions}}`',
    '```',
    '',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'README.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' });
});

test('token-syntax documentation with <purpose> is not an unmapped token', () => {
  const arch = '# Overview\n';
  const pack =
    'Anchor placeholders: `{{ARCHITECTURE_ANCHOR:<purpose>}}` tokens below are placeholders.\n';
  const result = auditContextPacks({
    packs: [{ path: 'README.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.deepEqual(result, { kind: 'ok' }, '<purpose> syntax docs must not register');
});

test('broken mapped anchor and unmapped token surface together as fail + unmapped', () => {
  const arch = '# Overview\n';
  const pack = [
    '- `architecture.md`:',
    '  - `#no-such-anchor`',
    '  - `{{ARCHITECTURE_ANCHOR:service-layer}}`',
    '',
  ].join('\n');
  const result = auditContextPacks({
    packs: [{ path: 'implement.md', content: pack }],
    architectureMarkdown: arch,
  });
  assert.equal(result.kind, 'fail');
  if (result.kind !== 'fail') return;
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].anchor, 'no-such-anchor');
  assert.equal(result.unmapped?.length, 1);
  assert.equal(result.unmapped![0].purpose, 'service-layer');
});

// ---------------------------------------------------------------------------
// extractExplicitAnchors — the --list-anchors mapping helper
// ---------------------------------------------------------------------------
test('extractExplicitAnchors returns explicit anchors, skipping code blocks and heading slugs', () => {
  const arch = [
    '<a id="route-conventions"></a>',
    '## Route Conventions',
    '',
    '```html',
    '<a id="fake-in-fence"></a>',
    '```',
    '',
    '<a id="service-layer"></a>',
    '## Service Layer',
  ].join('\n');
  assert.deepEqual(extractExplicitAnchors(arch), ['route-conventions', 'service-layer']);
});

// ---------------------------------------------------------------------------
// CLI: unmapped tokens are advisory by default, blocking under --strict-unmapped
// ---------------------------------------------------------------------------
function writeUnmappedFixture(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-cli-unmapped-'));
  mkdirSync(join(tmp, 'docs', 'context-packs'), { recursive: true });
  writeFileSync(join(tmp, 'architecture.md'), '<a id="real-anchor"></a>\n## Real Section\n');
  writeFileSync(
    join(tmp, 'docs', 'context-packs', 'review.md'),
    '- `architecture.md`:\n  - `{{ARCHITECTURE_ANCHOR:route-conventions}}`\n'
  );
  return tmp;
}

test('CLI exits 0 with UNMAPPED + NOTE output for unmapped tokens by default', () => {
  const tmp = writeUnmappedFixture();
  try {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.match(result.stdout, /UNMAPPED review\.md:2 \{\{ARCHITECTURE_ANCHOR:route-conventions\}\}/);
    assert.match(result.stdout, /NOTE: 1 unmapped anchor placeholder/);
    assert.match(result.stdout, /OK — no broken anchor references/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI exits 1 for unmapped tokens under --strict-unmapped', () => {
  const tmp = writeUnmappedFixture();
  try {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--strict-unmapped'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout=${result.stdout}`);
    assert.match(result.stdout, /UNMAPPED review\.md:2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI --list-anchors prints explicit anchors one per line', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-cli-listanchors-'));
  try {
    writeFileSync(
      join(tmp, 'architecture.md'),
      '<a id="route-conventions"></a>\n## Route Conventions\n\n<a id="service-layer"></a>\n## Service Layer\n'
    );
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--list-anchors'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stdout, 'route-conventions\nservice-layer\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
