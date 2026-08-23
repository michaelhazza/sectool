/**
 * label.test.mjs — Vitest coverage for scripts/ci/label.sh (spec §5 B1).
 *
 * Every case builds a throwaway git repo + a fake `gh` binary (controlled label
 * state, head SHA, edit success) in a temp dir and runs the REAL script against
 * them via GH_BIN, so the state machine is exercised rather than assumed. Skips
 * cleanly where bash is unavailable.
 *
 * Coverage: all typed outcomes (PULLED / ALREADY_ABSENT / RESTORED /
 * ALREADY_PRESENT / SLUG_UNRESOLVED / NO_PARITY_EVIDENCE / SHA_MISMATCH /
 * NO_OPEN_PR), pre-push pull + restore, class-match on restore, crash recovery
 * (intent with no audited → RECOVERED_AUDIT), stale-lock reclaim, restored-then-
 * repulled same SHA, HITL override, and the terminal-state proof (full success
 * path ends with label present + heads equal + journal parity present).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'label.sh');

const BASH = (() => {
  const probe = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  return 'bash';
})();

let dir;

function git(...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

// Fake gh whose label state lives in a file the test mutates.
function writeFakeGh({ labelPresent = true, prExists = true } = {}) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const stateFile = path.join(dir, 'gh-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ labelPresent, prExists }));
  const gh = path.join(bin, 'gh');
  // A tiny node-backed shim so behaviour is portable (no bash-in-bash quoting).
  fs.writeFileSync(gh, `#!/usr/bin/env bash\nexec node "${path.join(bin, 'gh.mjs').replace(/\\/g, '/')}" "$@"\n`);
  const traceFile = path.join(dir, 'trace.log');
  fs.writeFileSync(path.join(bin, 'gh.mjs'), `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const SF = ${JSON.stringify(stateFile)};
const TRACE = ${JSON.stringify(traceFile)};
const s = JSON.parse(readFileSync(SF, 'utf8'));
const argv = process.argv.slice(2).join(' ');
function head() { return execSync('git rev-parse HEAD', { cwd: ${JSON.stringify(dir)} }).toString().trim(); }
if (argv.includes('pr view') && argv.includes('--json number')) { if (!s.prExists) process.exit(1); console.log('{"number":42}'); }
else if (argv.includes('pr view') && argv.includes('labels')) { console.log(s.labelPresent ? 'ready-to-merge' : ''); }
else if (argv.includes('pr view') && argv.includes('headRefOid')) { console.log(head()); }
else if (argv.includes('pr edit') && argv.includes('remove-label')) { s.labelPresent = false; writeFileSync(SF, JSON.stringify(s)); }
else if (argv.includes('pr edit') && argv.includes('add-label')) { s.labelPresent = true; writeFileSync(SF, JSON.stringify(s)); appendFileSync(TRACE, 'add-label\\n'); }
else { console.log('{}'); }
`);
  fs.chmodSync(gh, 0o755);
  return { gh, stateFile, traceFile };
}

// A recording fake resolver (RESOLVER_BIN): appends 'resolver' to the shared
// trace (once per invocation) so tests can assert the fence ran BEFORE the label
// add and count how many times the bounded fence polled. `exitCode`/`stdout`
// give a fixed response; `sequence` gives a per-call response ([{exitCode,
// stdout}, ...], clamped) so a test can drive WAIT→WAIT→PASS through the loop.
// Resolver exit codes mirror the real ones: 0=PASS, 20=WAIT, 21=FAILURE,
// 22=CANCELLED.
function writeFakeResolver({ exitCode = 0, stdout = 'OUTCOME: NO_RUN', sequence = null } = {}) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const resolver = path.join(bin, 'resolver.mjs');
  const traceFile = path.join(dir, 'trace.log');
  const counterFile = path.join(dir, 'resolver-calls.txt');
  const argvFile = path.join(dir, 'resolver-argv.txt');
  const registryFile = path.join(dir, '.claude', 'project-registries.json');
  // Config resolution now lives in the RESOLVER (--print-config / --configured),
  // so the fake models it faithfully — otherwise the fail-closed cases would be
  // testing the fake instead of the contract. Mapping mirrors
  // CONFIG_TRIGGER_TO_CLASS.
  const configPrelude = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
const MAP = { push: ['push', true], pull_request: ['labeled', true], none: ['any', false] };
if (argv.includes('--print-config') || argv.includes('--configured')) {
  let reg = null;
  try { reg = JSON.parse(readFileSync(${JSON.stringify(registryFile)}, 'utf8')); } catch {}
  const f = (reg && reg.ci_workflow_files) || {};
  const wf = typeof f.ci_workflow === 'string' && f.ci_workflow.trim() ? f.ci_workflow.trim() : null;
  const tg = typeof f.ci_workflow_trigger === 'string' ? f.ci_workflow_trigger.trim() : null;
  if (!wf) { console.error('ERROR: ci_workflow not configured'); process.exit(2); }
  if (!tg || !MAP[tg]) { console.error('ERROR: ci_workflow_trigger not configured'); process.exit(2); }
  console.log('config workflow=' + wf + ' trigger=' + tg + ' class=' + MAP[tg][0] + ' expect_run=' + MAP[tg][1]);
  if (argv.includes('--print-config')) process.exit(0);
}
appendFileSync(${JSON.stringify(traceFile)}, 'resolver\\n');
appendFileSync(${JSON.stringify(argvFile)}, argv.join(' ') + '\\n');
`;
  const body = sequence
    ? `${configPrelude}
const seq = ${JSON.stringify(sequence)};
let i = 0;
try { if (existsSync(${JSON.stringify(counterFile)})) i = parseInt(readFileSync(${JSON.stringify(counterFile)}, 'utf8'), 10) || 0; } catch {}
const step = seq[Math.min(i, seq.length - 1)];
writeFileSync(${JSON.stringify(counterFile)}, String(i + 1));
console.log(step.stdout ?? 'OUTCOME: WAIT');
process.exit(step.exitCode ?? 0);
`
    : `${configPrelude}
console.log(${JSON.stringify(stdout)});
process.exit(${exitCode});
`;
  fs.writeFileSync(resolver, body);
  return resolver;
}

/** The argv the fence actually handed the resolver, one line per invocation. */
function readResolverArgv() {
  const f = path.join(dir, 'resolver-argv.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
}

// A registry with the canonical ci_workflow_files keys set, so the fence
// resolves BOTH a workflow identity and the trigger a push is expected to fire
// (the same keys a real consumer sets during adoption). `trigger: null` omits
// the trigger key, to exercise the fail-closed path.
function writeCiWorkflowConfig(value = 'ci.yml', trigger = 'push') {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const files = { ci_workflow: value };
  if (trigger !== null) files.ci_workflow_trigger = trigger;
  fs.writeFileSync(
    path.join(claudeDir, 'project-registries.json'),
    JSON.stringify({ ci_workflow_files: files }),
  );
}

function readTrace() {
  const tf = path.join(dir, 'trace.log');
  return fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function run(args, env = {}) {
  return spawnSync(BASH, [SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env,
      GH_BIN: path.join(dir, 'fakebin', 'gh'),
      // Default to the recording fake resolver; harmless when a case does not
      // write one (the add-path fence is only reached when ci_workflow is set).
      RESOLVER_BIN: path.join(dir, 'fakebin', 'resolver.mjs'),
      ...env,
    },
  });
}

const d = BASH ? describe : describe.skip;

d('label.sh state machine', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('pull on a labelled PR removes the label and journals PULLED', () => {
    writeFakeGh({ labelPresent: true });
    const r = run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    expect(r.stdout).toMatch(/OUTCOME: PULLED/);
    const journal = fs.readFileSync(path.join(dir, '.git', 'ci-label', 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"type":"intent"/);
    expect(journal).toMatch(/"type":"mutated"/);
    expect(journal).toMatch(/"type":"audited"/);
  });

  it('pull on an unlabelled PR is ALREADY_ABSENT', () => {
    writeFakeGh({ labelPresent: false });
    const r = run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    expect(r.stdout).toMatch(/OUTCOME: ALREADY_ABSENT/);
  });

  it('pull with no resolvable slug is SLUG_UNRESOLVED (label still mutated)', () => {
    writeFakeGh({ labelPresent: true });
    const r = run(['pull', '--pr', '42', '--reason', 'pre-push']);
    expect(r.stdout).toMatch(/OUTCOME: SLUG_UNRESOLVED/);
    const journal = fs.readFileSync(path.join(dir, '.git', 'ci-label', 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"slug":null/);
  });

  it('pull on a non-existent PR is NO_OPEN_PR', () => {
    writeFakeGh({ prExists: false });
    const r = run(['pull', '--pr', '42', '--reason', 'pre-push']);
    expect(r.stdout).toMatch(/OUTCOME: NO_OPEN_PR/);
  });

  it('failed-check pull requires --run-id/--check/--class', () => {
    writeFakeGh({ labelPresent: true });
    const r = run(['pull', '--pr', '42', '--reason', 'failed-check']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/required with --reason failed-check/);
  });

  it('failed-check pull rejects an out-of-enum class (caller owns CLASS_UNRESOLVED)', () => {
    writeFakeGh({ labelPresent: true });
    const r = run(['pull', '--pr', '42', '--reason', 'failed-check', '--run-id', '9', '--check', 'integration tests', '--class', 'mystery']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--class must be integration\|static/);
  });

  it('restore without parity evidence fails closed (NO_PARITY_EVIDENCE)', () => {
    writeFakeGh({ labelPresent: true });
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']); // label now off
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: NO_PARITY_EVIDENCE/);
  });

  it('terminal state: pull → parity(green) → restore ends labelled + heads equal + journal parity', () => {
    writeFakeGh({ labelPresent: true });
    // restore's label ADD now runs the same fail-closed fence as apply, so the
    // happy path must satisfy it.
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml');
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    // producer records pre-push parity for the current head
    const p = run(['parity', '--pr', '42', '--class', 'pre-push', '--status', 'green', '--cmd', 'local-green']);
    expect(p.stdout).toMatch(/OUTCOME: PARITY_RECORDED/);
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: RESTORED/);
    // label present again (read the fake gh's state file — spawning the bash-
    // shebang shim directly from Node is not portable on Windows)
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(true);
    const journal = fs.readFileSync(path.join(dir, '.git', 'ci-label', 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"type":"parity"/);
    expect(journal).toMatch(/"type":"restored"/);
  });

  it('restore with a SHA mismatch fails closed (SHA_MISMATCH)', () => {
    writeFakeGh({ labelPresent: true });
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    run(['parity', '--pr', '42', '--class', 'pre-push', '--status', 'green']);
    // advance HEAD so local != parity sha
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'move');
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: SHA_MISMATCH/);
  });

  it('restore with the HITL override bypasses the SHA gate (but NOT the fence)', () => {
    writeFakeGh({ labelPresent: true });
    // HITL vouches for CODE parity; it does not vouch that no run is being
    // raced, so the fence still runs on this path.
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml');
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'move');
    const r = run(['restore', '--pr', '42'], { LABEL_HITL_OVERRIDE: 'operator-approved-2026' });
    expect(r.stdout).toMatch(/OUTCOME: RESTORED/);
    expect(r.stdout).toMatch(/HITL override/);
  });

  it('restore when the label is already present is ALREADY_PRESENT', () => {
    writeFakeGh({ labelPresent: true });
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: ALREADY_PRESENT/);
  });

  it('a crashed pull (intent with no audited) is reconciled → RECOVERED_AUDIT', () => {
    writeFakeGh({ labelPresent: false });
    const ciDir = path.join(dir, '.git', 'ci-label');
    fs.mkdirSync(ciDir, { recursive: true });
    // simulate a crash: an intent record with no matching audited
    fs.writeFileSync(path.join(ciDir, 'journal.jsonl'),
      '{"v":1,"seq":1,"type":"intent","op":"pull","pr":42,"reason":"pre-push","headSha":"deadbeef","at":"2026-01-01T00:00:00Z"}\n');
    const r = run(['reconcile', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: RECOVERED_AUDIT|OUTCOME: RECONCILED/);
    const journal = fs.readFileSync(path.join(ciDir, 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"type":"audited".*"recovered":true|"recovered":true/);
  });

  it('a stale lock (dead pid) is reclaimed, not deadlocked', () => {
    writeFakeGh({ labelPresent: true });
    const ciDir = path.join(dir, '.git', 'ci-label');
    fs.mkdirSync(ciDir, { recursive: true });
    fs.writeFileSync(path.join(ciDir, 'lock'), '{"pid":999999,"at":"2026-01-01T00:00:00Z"}');
    const r = run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    expect(r.stdout).toMatch(/OUTCOME: PULLED/);
  });

  // ── add-path (W4): the resolver fence runs immediately before the label add ──
  it('apply calls the resolver BEFORE adding the label, then journals APPLIED', () => {
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml');
    const r = run(['apply', '--pr', '42', '--slug', 'demo']);
    expect(r.stdout).toMatch(/OUTCOME: APPLIED/);
    // ordering: resolver ran, and the label add ran after it
    expect(readTrace()).toEqual(['resolver', 'add-label']);
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(true);
    const journal = fs.readFileSync(path.join(dir, '.git', 'ci-label', 'journal.jsonl'), 'utf8');
    expect(journal).toMatch(/"type":"intent","op":"apply"/);
    expect(journal).toMatch(/"type":"mutated","op":"apply"/);
    expect(journal).toMatch(/"type":"audited","op":"apply"/);
  });

  it('apply fails CLOSED when ci_workflow is unset — no resolver call, no label add', () => {
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0 });
    // deliberately NO writeCiWorkflowConfig()
    const r = run(['apply', '--pr', '42', '--slug', 'demo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ci_workflow not configured/);
    // neither the fence nor the add ran
    expect(readTrace()).toEqual([]);
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(false);
  });

  // The fence env keeps these tests instant (1 attempt, no sleep).
  const FAST_FENCE = { CI_LABEL_FENCE_ATTEMPTS: '1', CI_LABEL_FENCE_SLEEP: '0' };

  it('apply does NOT add the label when a run is live at the fence deadline (RESOLVER_BLOCKED, non-zero exit)', () => {
    writeFakeGh({ labelPresent: false });
    // WAIT with a run in progress (no registration=pending) → at the deadline
    // this is NOT safe: adding the label races the live run.
    writeFakeResolver({ exitCode: 20, stdout: 'OUTCOME: WAIT run=999' });
    writeCiWorkflowConfig('ci.yml');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: RESOLVER_BLOCKED/);
    // fail-loud: a non-progress apply must exit non-zero (Step 10.3 pause).
    expect(r.status).not.toBe(0);
    expect(readTrace()).toEqual(['resolver']); // resolver ran, add did not
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(false);
  });

  it('apply FAILS CLOSED when the registration window expires with a run still expected', () => {
    // The round-2 version returned "safe" here, inferring "no run will ever
    // register" from elapsed time — the slow-registration tail of the very race
    // the fence exists to close. A timeout proves nothing: it must BLOCK.
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 20, stdout: 'OUTCOME: WAIT registration=pending' });
    writeCiWorkflowConfig('ci.yml', 'push'); // a push run IS expected
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: RESOLVER_BLOCKED/);
    expect(r.stdout).toMatch(/fence deadline reached/);
    expect(r.status).not.toBe(0);
    expect(readTrace()).toEqual(['resolver']); // no add
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(false);
  });

  it('the fence DELEGATES config to the resolver (--configured) and reconstructs nothing', () => {
    // Rounds 3-5 all produced the same defect class: a caller re-deriving event
    // identity. label.sh must now hand the resolver `--configured` and NOTHING
    // about the workflow or trigger — the resolver reads and maps them.
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml', 'pull_request');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: APPLIED/);
    const argv = readResolverArgv();
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain('--configured');
    expect(argv[0]).not.toContain('--trigger-class');
    expect(argv[0]).not.toContain('--workflow');
    expect(argv[0]).not.toContain('--expect-run');
    // and the resolver reported the DECLARED trigger it resolved
    expect(r.stdout).toMatch(/config workflow=ci\.yml trigger=pull_request class=labeled expect_run=true/);
  });

  it('a declared trigger=none is resolved by the resolver as the wildcard class, no run expected', () => {
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0, stdout: 'OUTCOME: NO_RUN' });
    writeCiWorkflowConfig('ci.yml', 'none');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/config workflow=ci\.yml trigger=none class=any expect_run=false/);
    expect(readResolverArgv()[0]).not.toContain('--expect-run');
  });

  it('apply applies immediately when the consumer DECLARES no run is triggered by a push (trigger=none)', () => {
    // The legitimate "nothing to race" case is proven by DECLARED config, not by
    // waiting: trigger=none drops --expect-run, so an empty run list is NO_RUN.
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0, stdout: 'OUTCOME: NO_RUN' });
    writeCiWorkflowConfig('ci.yml', 'none');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: APPLIED/);
    expect(r.status).toBe(0);
    expect(readTrace()).toEqual(['resolver', 'add-label']);
  });

  it('apply fails CLOSED when ci_workflow_trigger is unset — no resolver call, no label add', () => {
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml', null); // workflow set, trigger MISSING
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ci_workflow_trigger not configured/);
    expect(readTrace()).toEqual([]);
  });

  it('ALREADY_PRESENT is head-aware: a label sitting over a fenced-dirty head BLOCKS, not "success"', () => {
    // ci-push-guard is fail-open, so an external push can leave the label on a
    // NEW SHA. Reporting idempotent success without looking at that SHA's runs
    // is the same blind spot in a different place.
    writeFakeGh({ labelPresent: true });
    writeFakeResolver({ exitCode: 21, stdout: 'OUTCOME: FAILURE run=999' });
    writeCiWorkflowConfig('ci.yml', 'push');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: RESOLVER_BLOCKED/);
    expect(r.stdout).not.toMatch(/OUTCOME: ALREADY_PRESENT/);
    expect(r.status).not.toBe(0);
  });

  it('ALREADY_PRESENT still succeeds when the current head fences clean', () => {
    writeFakeGh({ labelPresent: true });
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml', 'push');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: ALREADY_PRESENT/);
    expect(r.stdout).toMatch(/fenced clean/);
    expect(r.status).toBe(0);
  });

  it('the fence WAITS through registration and then applies once the run registers ([] pending → PASS)', () => {
    // The exact `[] -> [] -> registered` race: the fence must poll, not conclude
    // NO_RUN on an early empty read. First poll is registration=pending, second
    // is PASS — the label is added only after the run is observed.
    writeFakeGh({ labelPresent: false });
    writeFakeResolver({
      sequence: [
        { exitCode: 20, stdout: 'OUTCOME: WAIT registration=pending' },
        { exitCode: 0, stdout: 'OUTCOME: PASS run=100' },
      ],
    });
    writeCiWorkflowConfig('ci.yml');
    const r = run(['apply', '--pr', '42', '--slug', 'demo'], { CI_LABEL_FENCE_ATTEMPTS: '5', CI_LABEL_FENCE_SLEEP: '0' });
    expect(r.stdout).toMatch(/OUTCOME: APPLIED/);
    expect(r.status).toBe(0);
    // resolver polled twice (pending, then PASS), THEN the label add ran.
    expect(readTrace()).toEqual(['resolver', 'resolver', 'add-label']);
  });

  it('restore invokes the resolver fence before its label add when ci_workflow is configured', () => {
    writeFakeGh({ labelPresent: true });
    writeFakeResolver({ exitCode: 0 });
    writeCiWorkflowConfig('ci.yml');
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    run(['parity', '--pr', '42', '--class', 'pre-push', '--status', 'green', '--cmd', 'local-green']);
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: RESTORED/);
    // resolver ran before the add on the restore path too
    expect(readTrace()).toEqual(['resolver', 'add-label']);
  });

  it('restore FAILS CLOSED without fence config — parity+SHA is not a substitute', () => {
    // restore previously skipped the resolver entirely when ci_workflow was
    // absent ("best-effort on config"), leaving one label-ADD path outside the
    // mechanism. parity/SHA answers "is this the expected code?", never "is a
    // run about to be raced?".
    writeFakeGh({ labelPresent: true });
    writeFakeResolver({ exitCode: 0 });
    // deliberately NO writeCiWorkflowConfig()
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    run(['parity', '--pr', '42', '--class', 'pre-push', '--status', 'green', '--cmd', 'local-green']);
    const r = run(['restore', '--pr', '42']);
    expect(r.stdout).toMatch(/OUTCOME: RESOLVER_BLOCKED/);
    // The remediation is a diagnostic, so it rides stderr; stdout carries the
    // OUTCOME contract only.
    expect(r.stderr).toMatch(/ci_workflow not configured/);
    expect(r.status).not.toBe(0);
    // parity + SHA all agreed, and the label STILL did not go back on.
    const ghState = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    expect(ghState.labelPresent).toBe(false);
  });

  it('restore exits NON-ZERO when the fence declines (fail-loud, like apply)', () => {
    writeFakeGh({ labelPresent: true });
    writeFakeResolver({ exitCode: 21, stdout: 'OUTCOME: FAILURE run=777' });
    writeCiWorkflowConfig('ci.yml', 'push');
    run(['pull', '--pr', '42', '--reason', 'pre-push', '--slug', 'demo']);
    run(['parity', '--pr', '42', '--class', 'pre-push', '--status', 'green', '--cmd', 'local-green']);
    const r = run(['restore', '--pr', '42'], FAST_FENCE);
    expect(r.stdout).toMatch(/OUTCOME: RESOLVER_BLOCKED/);
    expect(r.status).not.toBe(0);
  });
});
