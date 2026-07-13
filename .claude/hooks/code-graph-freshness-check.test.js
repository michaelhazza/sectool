#!/usr/bin/env node
/**
 * Test suite for code-graph-freshness-check.js — SessionStart cache guard.
 *
 * Verifies the hook's branch behaviour with the spawned generator stubbed
 * out: a fake `npx` shim is placed first on PATH (the hook resolves npx via
 * spawnSync), logging every invocation to a file instead of running tsx.
 *
 * Branches covered:
 *   - generator absent           → exits 0 silently, never spawns
 *   - generator present          → spawns the build, reports "refreshed"
 *   - watcher alive (live pid)   → skips the build entirely
 *   - watcher pid dead/garbage   → falls through to the build
 *   - build exits non-zero       → still exits 0 (fail-open), warns on stderr
 *
 * NOTE (scope): this file only TESTS the hook; the generator it spawns
 * (scripts/build-code-graph.ts) ships separately.
 *
 * Style mirrors config-protection.test.js: end-to-end child process runs.
 *
 * Run: node .claude/hooks/code-graph-freshness-check.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'code-graph-freshness-check.js');

// ── Fake npx shim ──────────────────────────────────────────────────────────
// The hook calls spawnSync('npx', ['tsx', <script>], ...). Putting a stub
// first on PATH intercepts that call; the stub appends its args to STUB_LOG
// and exits with STUB_EXIT (default 0).

const STUB_BIN = mkdtempSync(join(tmpdir(), 'cgfc-stub-bin-'));

// POSIX shim
writeFileSync(
  join(STUB_BIN, 'npx'),
  '#!/bin/sh\necho "$@" >> "$STUB_LOG"\nexit ${STUB_EXIT:-0}\n',
);
chmodSync(join(STUB_BIN, 'npx'), 0o755);

// Windows shim (spawnSync uses shell:true on win32, resolving npx.cmd)
writeFileSync(
  join(STUB_BIN, 'npx.cmd'),
  '@echo off\r\necho %* >> "%STUB_LOG%"\r\nif defined STUB_EXIT ( exit /b %STUB_EXIT% ) else ( exit /b 0 )\r\n',
);

let caseNo = 0;

/** Create a fresh fake project dir; returns { proj, log, run(extraEnv) }. */
function makeProject({ withGenerator = false, watcherPid = null } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'cgfc-proj-'));
  const log = join(proj, `stub-${++caseNo}.log`);
  if (withGenerator) {
    mkdirSync(join(proj, 'scripts'), { recursive: true });
    writeFileSync(join(proj, 'scripts', 'build-code-graph.ts'), '// stub generator\n');
  }
  if (watcherPid !== null) {
    mkdirSync(join(proj, 'references'), { recursive: true });
    writeFileSync(join(proj, 'references', '.watcher.pid'), String(watcherPid));
  }
  const run = (extraEnv = {}) =>
    spawnSync(process.execPath, [HOOK], {
      input: '',
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: proj,
        PATH: STUB_BIN + delimiter + process.env.PATH,
        Path: STUB_BIN + delimiter + (process.env.Path || process.env.PATH),
        STUB_LOG: log,
        ...extraEnv,
      },
    });
  return { proj, log, run };
}

function stubCalls(log) {
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8');
}

let pass = 0;
const fails = [];

function check(label, actual, expected, extra) {
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ label, expected, actual, reason: extra || '' });
  }
}

// ── 1. Generator absent → silent no-op, no spawn ───────────────────────────
{
  const { proj, log, run } = makeProject({ withGenerator: false });
  const r = run();
  check('generator absent: exit 0', r.status, 0, r.stderr);
  check('generator absent: no "refreshed" line', /refreshed/.test(r.stdout || ''), false, r.stdout);
  check('generator absent: npx never spawned', stubCalls(log).trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 2. Generator present, no watcher → spawns the build, reports refresh ───
{
  const { proj, log, run } = makeProject({ withGenerator: true });
  const r = run();
  check('generator present: exit 0', r.status, 0, r.stderr);
  check('generator present: stdout reports refresh', /refreshed/.test(r.stdout || ''), true, `stdout=${r.stdout} stderr=${r.stderr}`);
  check('generator present: npx tsx spawned with the build script', /build-code-graph\.ts/.test(stubCalls(log)), true, stubCalls(log));
  rmSync(proj, { recursive: true, force: true });
}

// ── 3. Watcher alive → fast path, build NOT spawned ────────────────────────
{
  // This test process's own pid is guaranteed alive.
  const { proj, log, run } = makeProject({ withGenerator: true, watcherPid: process.pid });
  const r = run();
  check('watcher alive: exit 0', r.status, 0, r.stderr);
  check('watcher alive: build NOT spawned', /build-code-graph\.ts/.test(stubCalls(log)), false, stubCalls(log));
  check('watcher alive: no "refreshed" line', /refreshed/.test(r.stdout || ''), false, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 4. Watcher pid dead or garbage → falls through to the build ────────────
{
  // A pid far beyond any plausible live process.
  const { proj, log, run } = makeProject({ withGenerator: true, watcherPid: 999999999 });
  const r = run();
  check('dead watcher pid: exit 0', r.status, 0, r.stderr);
  check('dead watcher pid: build spawned', /build-code-graph\.ts/.test(stubCalls(log)), true, stubCalls(log));
  rmSync(proj, { recursive: true, force: true });
}
{
  const { proj, log, run } = makeProject({ withGenerator: true, watcherPid: 'not-a-pid' });
  const r = run();
  check('garbage watcher pid: exit 0', r.status, 0, r.stderr);
  check('garbage watcher pid: build spawned', /build-code-graph\.ts/.test(stubCalls(log)), true, stubCalls(log));
  rmSync(proj, { recursive: true, force: true });
}

// ── 5. Build exits non-zero → hook still exits 0 (fail-open), warns ────────
{
  const { proj, run } = makeProject({ withGenerator: true });
  const r = run({ STUB_EXIT: '3' });
  check('build fails: hook still exits 0 (fail-open)', r.status, 0, r.stderr);
  check('build fails: stderr warns about the build', /build exited/.test(r.stderr || ''), true, r.stderr);
  check('build fails: no "refreshed" claim', /refreshed/.test(r.stdout || ''), false, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── Cleanup + report ───────────────────────────────────────────────────────

rmSync(STUB_BIN, { recursive: true, force: true });

const totalCases = pass + fails.length;
console.log(`Cases: ${totalCases}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `FAIL actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)} | ${f.label} | ${f.reason}`,
    );
  }
  process.exit(1);
}
process.exit(0);
