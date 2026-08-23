/**
 * review-preflight.test.ts
 *
 * Spec §6 C3 requires BOTH halves, because probe tests alone would leave the
 * contract that actually bites — "what does the coordinator DO with FAIL" —
 * unverified:
 *   1. fake-transport tests: drive scripts/review-preflight.sh with fake Codex
 *      and OpenAI probes and assert the emitted status block;
 *   2. caller-parser tests: status → action mapping, and the malformed /
 *      non-zero-exit handling that must never be softer than a failed probe.
 *
 * Vitest style — the framework's dominant convention AND the only shape that is
 * safe downstream: consuming repos reject `node:test`/`node:assert` in any
 * `*.test.ts` via their own test-quality gates and collect `**\/__tests__\/**`
 * with Vitest, so a node:test file here would break their CI on adoption.
 *
 * Run via: npx vitest run scripts/__tests__/review-preflight.test.ts
 */

import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_PREFIX,
  buildRequiredTiers,
  parseStatusBlock,
  resolvePreflight,
} from '../review-preflightPure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'review-preflight.sh');
const posix = (p: string) => p.replace(/\\/g, '/');

const hasBash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).status === 0;
const bashTest = test.skipIf(!hasBash);

// ── fake transports ─────────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'review-preflight-'));
mkdirSync(TMP, { recursive: true });

/** Fake `codex`: mode = ok | unauthenticated | exec-fails. */
function fakeCodex(mode: string): string {
  const p = join(TMP, `codex-${mode}`);
  writeFileSync(
    p,
    `#!/usr/bin/env bash
case "$1" in
  login) [ "${mode}" = "unauthenticated" ] && exit 1; exit 0;;
  exec)
    # The invocation contract makes -s read-only mandatory; assert the probe honours it.
    case "$*" in *"-s read-only"*) : ;; *) echo "probe omitted -s read-only" >&2; exit 90;; esac
    [ "${mode}" = "exec-fails" ] && exit 1
    echo ok; exit 0;;
  *) exit 0;;
esac
`,
  );
  try { chmodSync(p, 0o755); } catch { /* windows */ }
  return p;
}

/** Fake OpenAI probe: exits 0, or non-zero printing a chosen error signature. */
function fakeOpenAI(name: string, exitCode: number, output = ''): string {
  const p = join(TMP, `openai-${name}`);
  writeFileSync(p, `#!/usr/bin/env bash\n${output ? `echo "${output}"` : ''}\nexit ${exitCode}\n`);
  try { chmodSync(p, 0o755); } catch { /* windows */ }
  return p;
}

function runPreflight(required: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [posix(SCRIPT), '--require', required], {
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '', ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Fake-transport tests
// ════════════════════════════════════════════════════════════════════════════

bashTest('codex PASS + openai SKIPPED when only codex is required', () => {
  const r = runPreflight('codex', { REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('ok')) });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/REVIEW TIER PREFLIGHT: codex=PASS openai-api=SKIPPED/);
});

bashTest('unauthenticated codex is FAIL (binary exists, transport unusable) with remediation', () => {
  const r = runPreflight('codex', { REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('unauthenticated')) });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/codex=FAIL/);
  expect(r.stderr).toMatch(/not authenticated/i);
});

bashTest('failing sandboxed exec is FAIL', () => {
  const r = runPreflight('codex', { REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('exec-fails')) });
  expect(r.stdout).toMatch(/codex=FAIL/);
  expect(r.stderr).toMatch(/sandboxed exec probe failed/i);
});

bashTest('absent codex binary is UNAVAILABLE, not FAIL', () => {
  const r = runPreflight('codex', {
    REVIEW_PREFLIGHT_CODEX_RESOLVER: posix(join(TMP, 'no-such-resolver.sh')),
  });
  expect(r.stdout).toMatch(/codex=UNAVAILABLE/);
});

bashTest('the codex exec probe uses the mandatory read-only sandbox', () => {
  // The fake exits 90 if -s read-only is missing, which would surface as FAIL.
  const r = runPreflight('codex', { REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('ok')) });
  expect(r.stdout).toMatch(/codex=PASS/);
  expect(r.stderr).not.toMatch(/omitted -s read-only/);
});

bashTest('missing OPENAI_API_KEY on a required tier is UNAVAILABLE with remediation', () => {
  const r = runPreflight('openai-api', { OPENAI_API_KEY: '' });
  expect(r.stdout).toMatch(/openai-api=UNAVAILABLE/);
  expect(r.stderr).toMatch(/OPENAI_API_KEY is not set/);
});

bashTest('a capped organisation is reported, never silently ignored (S5)', () => {
  const r = runPreflight('openai-api', {
    OPENAI_API_KEY: 'sk-test',
    REVIEW_PREFLIGHT_OPENAI_CMD: posix(fakeOpenAI('capped', 2, 'organization_spend_limit_exceeded')),
  });
  expect(r.stdout).toMatch(/openai-api=FAIL/);
  expect(r.stderr).toMatch(/spend limit exceeded/i);
  expect(r.stderr).toMatch(/manual ChatGPT-web path is unaffected/i);
});

bashTest('a rejected key is reported as FAIL with a rotate hint', () => {
  const r = runPreflight('openai-api', {
    OPENAI_API_KEY: 'sk-bad',
    REVIEW_PREFLIGHT_OPENAI_CMD: posix(fakeOpenAI('badkey', 2, 'invalid_api_key')),
  });
  expect(r.stdout).toMatch(/openai-api=FAIL/);
  expect(r.stderr).toMatch(/Rotate OPENAI_API_KEY/);
});

bashTest('both tiers required and healthy → both PASS, exit 0', () => {
  const r = runPreflight('codex,openai-api', {
    REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('ok')),
    OPENAI_API_KEY: 'sk-test',
    REVIEW_PREFLIGHT_OPENAI_CMD: posix(fakeOpenAI('ok', 0)),
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/codex=PASS openai-api=PASS/);
});

bashTest('exit code stays 0 even when probes fail (results are data, not a verdict)', () => {
  const r = runPreflight('codex,openai-api', {
    REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('unauthenticated')),
    OPENAI_API_KEY: '',
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/codex=FAIL openai-api=UNAVAILABLE/);
});

bashTest('the block never emits the reserved REVIEW_GAP token', () => {
  const r = runPreflight('codex,openai-api', {
    REVIEW_PREFLIGHT_CODEX_BIN: posix(fakeCodex('unauthenticated')),
  });
  expect(r.stdout).not.toMatch(/REVIEW_GAP/);
  expect(r.stderr).not.toMatch(/REVIEW_GAP/);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Caller-parser tests
// ════════════════════════════════════════════════════════════════════════════

test('parseStatusBlock reads a well-formed block', () => {
  const p = parseStatusBlock(`noise\n${BLOCK_PREFIX} codex=PASS openai-api=SKIPPED\n`);
  expect(p.malformed).toBe(false);
  expect(p.statuses).toEqual({ codex: 'PASS', 'openai-api': 'SKIPPED' });
});

test('parseStatusBlock rejects malformed and unknown-status blocks', () => {
  expect(parseStatusBlock('').malformed).toBe(true);
  expect(parseStatusBlock('no block here').malformed).toBe(true);
  expect(parseStatusBlock(`${BLOCK_PREFIX}`).malformed).toBe(true);
  expect(parseStatusBlock(`${BLOCK_PREFIX} codex`).malformed).toBe(true);
  // an unrecognised status must not be coerced
  expect(parseStatusBlock(`${BLOCK_PREFIX} codex=WOBBLE`).malformed).toBe(true);
});

test('non-zero exit ≡ unparseable block: UNAVAILABLE for every required tier', () => {
  const crashed = resolvePreflight({ exitCode: 1, stdout: '', required: ['codex'], phase: 'jit' });
  const partial = resolvePreflight({ exitCode: 0, stdout: 'REVIEW TIER PREFL', required: ['codex'], phase: 'jit' });
  const garbled = resolvePreflight({ exitCode: 1, stdout: `${BLOCK_PREFIX} codex=PASS`, required: ['codex'], phase: 'jit' });
  for (const r of [crashed, partial, garbled]) {
    expect(r.degraded).toBe(true);
    expect(r.statuses.codex).toBe('UNAVAILABLE');
    expect(r.actions.find((a) => a.capability === 'codex')?.action).toBe('retry-then-fallback');
  }
});

test('Step 0 forecast on a required red tier warns and continues (never silent)', () => {
  const r = resolvePreflight({
    exitCode: 0, stdout: `${BLOCK_PREFIX} codex=FAIL openai-api=SKIPPED`,
    required: ['codex'], phase: 'step0',
  });
  expect(r.actions.find((a) => a.capability === 'codex')?.action).toBe('warn-and-continue');
});

test('just-in-time on a required red tier retries then falls back', () => {
  const r = resolvePreflight({
    exitCode: 0, stdout: `${BLOCK_PREFIX} codex=UNAVAILABLE openai-api=PASS`,
    required: ['codex', 'openai-api'], phase: 'jit',
  });
  expect(r.actions.find((a) => a.capability === 'codex')?.action).toBe('retry-then-fallback');
  expect(r.actions.find((a) => a.capability === 'openai-api')?.action).toBe('proceed');
});

test('SKIPPED is fine when not required, a contract violation when required', () => {
  const ok = resolvePreflight({
    exitCode: 0, stdout: `${BLOCK_PREFIX} codex=PASS openai-api=SKIPPED`,
    required: ['codex'], phase: 'jit',
  });
  expect(ok.actions.find((a) => a.capability === 'openai-api')?.action).toBe('proceed');

  const bad = resolvePreflight({
    exitCode: 0, stdout: `${BLOCK_PREFIX} codex=PASS openai-api=SKIPPED`,
    required: ['codex', 'openai-api'], phase: 'jit',
  });
  expect(bad.actions.find((a) => a.capability === 'openai-api')?.action).toBe('contract-violation');
});

test('a red but NOT-required tier never forces an action', () => {
  const r = resolvePreflight({
    exitCode: 0, stdout: `${BLOCK_PREFIX} codex=PASS openai-api=FAIL`,
    required: ['codex'], phase: 'jit',
  });
  expect(r.actions.find((a) => a.capability === 'openai-api')?.action).toBe('proceed');
});

test('buildRequiredTiers is mode-aware: manual never requires openai-api', () => {
  expect(buildRequiredTiers({ taskClass: 'Standard', reviewMode: 'manual' })).toEqual(['codex']);
  expect(buildRequiredTiers({ taskClass: 'Standard', reviewMode: 'automated' })).toEqual(['codex', 'openai-api']);
  expect(buildRequiredTiers({ taskClass: 'Significant', reviewMode: 'parallel' })).toEqual(['codex', 'openai-api']);
  // Trivial needs no Codex reviewer...
  expect(buildRequiredTiers({ taskClass: 'Trivial', reviewMode: 'manual' })).toEqual([]);
  // ...but finalisation always does (verify-phase), regardless of class.
  expect(buildRequiredTiers({ taskClass: 'Trivial', reviewMode: 'manual', alwaysRequireCodex: true }))
    .toEqual(['codex']);
});
