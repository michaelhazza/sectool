'use strict';
// Smoke test for the v2.10.0 LOCAL-OVERRIDE mechanism in sync.js.
// Standalone Node assertion script — no test framework, no CI gates.
// Run with: node scripts/__tests__/local-override-smoke.js

const assert = require('assert');
const path = require('path');
const sync = require(path.join('..', '..', 'sync.js'));

const { parseOverrideBlocks, extractOverrideContents, injectOverrides } = sync;

function pass(name) { process.stdout.write(`  ok  ${name}\n`); }

// 1. Parse: well-formed single block
{
  const c = `before\n<!-- LOCAL-OVERRIDE:start name="x" -->\nhello\n<!-- LOCAL-OVERRIDE:end name="x" -->\nafter\n`;
  const { blocks, errors } = parseOverrideBlocks(c);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(blocks.size, 1);
  assert.ok(blocks.has('x'));
  pass('parse well-formed single block');
}

// 2. Parse: well-formed multiple blocks
{
  const c = `<!-- LOCAL-OVERRIDE:start name="a" -->A<!-- LOCAL-OVERRIDE:end name="a" -->\nmid\n<!-- LOCAL-OVERRIDE:start name="b" -->B<!-- LOCAL-OVERRIDE:end name="b" -->\n`;
  const { blocks, errors } = parseOverrideBlocks(c);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(Array.from(blocks.keys()).sort(), ['a', 'b']);
  pass('parse multiple blocks');
}

// 3. Parse: nested → error
{
  const c = `<!-- LOCAL-OVERRIDE:start name="outer" --><!-- LOCAL-OVERRIDE:start name="inner" --><!-- LOCAL-OVERRIDE:end name="inner" --><!-- LOCAL-OVERRIDE:end name="outer" -->`;
  const { errors } = parseOverrideBlocks(c);
  assert.ok(errors.length > 0);
  assert.ok(errors.some(e => e.includes('nested')));
  pass('reject nested blocks');
}

// 4. Parse: duplicate name → error
{
  const c = `<!-- LOCAL-OVERRIDE:start name="x" --><!-- LOCAL-OVERRIDE:end name="x" --><!-- LOCAL-OVERRIDE:start name="x" --><!-- LOCAL-OVERRIDE:end name="x" -->`;
  const { errors } = parseOverrideBlocks(c);
  assert.ok(errors.some(e => e.includes('duplicate')));
  pass('reject duplicate names');
}

// 5. Parse: unclosed → error
{
  const c = `<!-- LOCAL-OVERRIDE:start name="x" -->content without end marker`;
  const { errors } = parseOverrideBlocks(c);
  assert.ok(errors.some(e => e.includes('never closed')));
  pass('reject unclosed block');
}

// 6. Parse: end without start → error
{
  const c = `<!-- LOCAL-OVERRIDE:end name="x" -->`;
  const { errors } = parseOverrideBlocks(c);
  assert.ok(errors.some(e => e.includes('no matching start')));
  pass('reject end without start');
}

// 7. Parse: invalid name → error
{
  const c = `<!-- LOCAL-OVERRIDE:start name="Bad Name" --><!-- LOCAL-OVERRIDE:end name="Bad Name" -->`;
  const { errors } = parseOverrideBlocks(c);
  assert.ok(errors.some(e => e.includes('invalid')));
  pass('reject invalid name');
}

// 8. Extract: returns content between markers exactly
{
  const c = `pre\n<!-- LOCAL-OVERRIDE:start name="x" -->\nLine 1\nLine 2\n<!-- LOCAL-OVERRIDE:end name="x" -->\npost\n`;
  const out = extractOverrideContents(c);
  assert.ok(out);
  assert.strictEqual(out.get('x'), '\nLine 1\nLine 2\n');
  pass('extract content between markers');
}

// 9. Inject: consumer override replaces framework default
{
  const fw = `pre\n<!-- LOCAL-OVERRIDE:start name="x" -->\nFW default\n<!-- LOCAL-OVERRIDE:end name="x" -->\npost\n`;
  const consumer = new Map([['x', '\nConsumer content\n']]);
  const { result, frameworkBlockNames, orphanedConsumerNames, errors } = injectOverrides(fw, consumer);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(result, `pre\n<!-- LOCAL-OVERRIDE:start name="x" -->\nConsumer content\n<!-- LOCAL-OVERRIDE:end name="x" -->\npost\n`);
  assert.deepStrictEqual(frameworkBlockNames, ['x']);
  assert.deepStrictEqual(orphanedConsumerNames, []);
  pass('inject single override');
}

// 10. Inject: missing consumer override leaves framework default
{
  const fw = `<!-- LOCAL-OVERRIDE:start name="x" -->DEF<!-- LOCAL-OVERRIDE:end name="x" -->`;
  const consumer = new Map();
  const { result } = injectOverrides(fw, consumer);
  assert.strictEqual(result, fw);
  pass('inject empty consumer → framework defaults retained');
}

// 11. Inject: orphan consumer override is dropped + reported
{
  const fw = `<!-- LOCAL-OVERRIDE:start name="x" -->FW<!-- LOCAL-OVERRIDE:end name="x" -->`;
  const consumer = new Map([['x', 'X'], ['orphan', 'O']]);
  const { result, orphanedConsumerNames } = injectOverrides(fw, consumer);
  assert.strictEqual(result, `<!-- LOCAL-OVERRIDE:start name="x" -->X<!-- LOCAL-OVERRIDE:end name="x" -->`);
  assert.deepStrictEqual(orphanedConsumerNames, ['orphan']);
  pass('orphan consumer override dropped + surfaced');
}

// 12. Inject: multiple overrides applied in reverse order safely
{
  const fw = `<!-- LOCAL-OVERRIDE:start name="a" -->A<!-- LOCAL-OVERRIDE:end name="a" -->|<!-- LOCAL-OVERRIDE:start name="b" -->B<!-- LOCAL-OVERRIDE:end name="b" -->`;
  const consumer = new Map([['a', 'AA'], ['b', 'BB']]);
  const { result } = injectOverrides(fw, consumer);
  assert.strictEqual(result, `<!-- LOCAL-OVERRIDE:start name="a" -->AA<!-- LOCAL-OVERRIDE:end name="a" -->|<!-- LOCAL-OVERRIDE:start name="b" -->BB<!-- LOCAL-OVERRIDE:end name="b" -->`);
  pass('multiple overrides applied correctly');
}

// 13. Idempotency: inject twice with same overrides → same result
{
  const fw = `<!-- LOCAL-OVERRIDE:start name="x" -->FW<!-- LOCAL-OVERRIDE:end name="x" -->`;
  const consumer = new Map([['x', 'X']]);
  const r1 = injectOverrides(fw, consumer).result;
  const r2 = injectOverrides(r1, consumer).result;
  assert.strictEqual(r1, r2);
  pass('inject is idempotent');
}

// 14. Round-trip: extract from injected → matches original consumer overrides
{
  const fw = `before<!-- LOCAL-OVERRIDE:start name="x" -->FW<!-- LOCAL-OVERRIDE:end name="x" -->after`;
  const consumer = new Map([['x', 'C']]);
  const injected = injectOverrides(fw, consumer).result;
  const extracted = extractOverrideContents(injected);
  assert.ok(extracted);
  assert.strictEqual(extracted.get('x'), 'C');
  pass('round-trip preserves override content');
}

process.stdout.write('\nAll LOCAL-OVERRIDE smoke tests passed.\n');
