/**
 * sync-status.test.mjs — the W1 wrapper contract.
 *
 * Every case injects FAKE deps ({runGenerator, runBoardSync}); the real
 * children never run. That lets the tests assert invocation ORDER and
 * short-circuiting deterministically. The validation-sensitive cases (a valid
 * record must pass, a schema-invalid one must be refused) run in BOTH
 * Ajv-available and forced-Ajv-unavailable modes, because the D2 defence must
 * not depend on which validator loaded.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpRoots = [];
async function makeRoot(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sync-status-'));
  tmpRoots.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return dir;
}

afterEach(async () => {
  while (tmpRoots.length) {
    await rm(tmpRoots.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

function validRecord(overrides = {}) {
  return JSON.stringify({
    contract_version: 'build-status.v2',
    slug: 'my-build',
    title: 'My build',
    classification: 'Standard',
    phase: 'finalise',
    status: 'MERGED',
    branch: 'feat/my-build',
    pr: 733,
    gates: {},
    gate_evidence: {},
    blockers: [],
    summary: 'Done.',
    updated_at: '2026-08-19T00:00:00Z',
    updated_by: 'finalisation-coordinator',
    ...overrides,
  });
}

/** An ordered call-log so tests can assert "generator FIRST, board second". */
function makeDeps(boardResult = { exitCode: 0, reasons: [], target: { slug: 'my-build', outcome: 'applied' }, records: {} }, genResult = { exitCode: 0 }) {
  const calls = [];
  return {
    calls,
    deps: {
      runGenerator: vi.fn(async () => { calls.push('generator'); return genResult; }),
      runBoardSync: vi.fn(async (opts) => { calls.push('board'); return { ...boardResult, _opts: opts }; }),
    },
  };
}

/** Loads a fresh sync-status module with Ajv either available or mocked away,
 *  so the same case can prove the floor and Ajv agree. */
async function loadSyncStatus({ ajv }) {
  vi.resetModules();
  if (ajv) vi.doUnmock('ajv');
  else vi.doMock('ajv', () => { throw new Error('Cannot find module ajv'); });
  return import('./sync-status.mjs');
}

beforeEach(() => vi.resetModules());

// ---------------------------------------------------------------------------
// (a) valid record → both children run, generator FIRST — in BOTH Ajv modes.
// ---------------------------------------------------------------------------
describe.each([{ ajv: true }, { ajv: false }])('(a) valid target (ajv=$ajv)', ({ ajv }) => {
  it('runs the generator then board-sync and reports target success', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['generator', 'board']);
    expect(deps.runBoardSync).toHaveBeenCalledWith(expect.objectContaining({ targetSlug: 'my-build' }));
  });
});

// ---------------------------------------------------------------------------
// (b) every INVALID_TARGET row → exit 2, ZERO child invocations.
// ---------------------------------------------------------------------------
describe('(b) INVALID_TARGET rows exit 2 and run no children', () => {
  it('missing', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot();
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('missing');
    expect(calls).toEqual([]);
  });

  it('unreadable (status.json is a directory)', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot();
    await mkdir(path.join(root, 'tasks/builds/my-build/status.json'), { recursive: true });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('unreadable');
    expect(calls).toEqual([]);
  });

  it('invalid_json', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': 'not json {' });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('invalid_json');
    expect(calls).toEqual([]);
  });

  // schema_invalid in BOTH modes — the D2 numeric run_id must be caught by the
  // floor as well as Ajv.
  it.each([{ ajv: true }, { ajv: false }])('schema_invalid — numeric run_id (ajv=$ajv)', async ({ ajv }) => {
    const { runSyncStatus } = await loadSyncStatus({ ajv });
    const bad = validRecord({ gate_evidence: { merge_gate: { sha: 'x', run_ids: [32310798762], url: null, completed_at: '2026-08-19T00:00:00Z' } } });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': bad });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('schema_invalid');
    expect(calls).toEqual([]);
  });

  it('slug_mismatch', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord({ slug: 'other-build' }) });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('slug_mismatch');
    expect(calls).toEqual([]);
  });

  it('status_mismatch under --expect-status', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord({ status: 'FINALISING' }) });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', expectStatus: 'MERGED', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('status_mismatch');
    expect(calls).toEqual([]);
  });

  it('non_terminal_archive (record in _archive with a non-terminal status)', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/_archive/my-build/status.json': validRecord({ status: 'FINALISING' }) });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('non_terminal_archive');
    expect(calls).toEqual([]);
  });

  describe('handover_incomplete under --require-handover', () => {
    const GOOD_HANDOVER = [
      '## Post-merge handover',
      '**Shipped:** PR #733 · my-build · squash 6d671ff · 2026-08-19',
      '',
      '**What was built**',
      '- Shipped the thing',
      '',
      '**To enable / configure**',
      '- None: live on deploy.',
      '',
      '**Urgent follow-on engineering**',
      '- None urgent: 2 routine item(s) in the backlog.',
      '',
      '### Follow-on triage',
      '- todo#12 | routine | tidy later',
      '- todo#13 | routine | docs polish',
      '',
    ].join('\n');

    it('missing handoff.md → handover_incomplete, no children', async () => {
      const { runSyncStatus } = await loadSyncStatus({ ajv: true });
      const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
      const { calls, deps } = makeDeps();
      const r = await runSyncStatus({ root, slug: 'my-build', requireHandover: true, deps });
      expect(r.exitCode).toBe(2);
      expect(r.reason).toBe('handover_incomplete');
      expect(calls).toEqual([]);
    });

    it('missing a subhead → handover_incomplete', async () => {
      const { runSyncStatus } = await loadSyncStatus({ ajv: true });
      const broken = GOOD_HANDOVER.replace('**Urgent follow-on engineering**', '**Something else**');
      const root = await makeRoot({
        'tasks/builds/my-build/status.json': validRecord(),
        'tasks/builds/my-build/handoff.md': broken,
      });
      const { deps } = makeDeps();
      const r = await runSyncStatus({ root, slug: 'my-build', requireHandover: true, deps });
      expect(r.exitCode).toBe(2);
      expect(r.reason).toBe('handover_incomplete');
    });

    it('empty section without the mandated literal → handover_incomplete', async () => {
      const { runSyncStatus } = await loadSyncStatus({ ajv: true });
      const broken = GOOD_HANDOVER.replace('- None: live on deploy.', '');
      const root = await makeRoot({
        'tasks/builds/my-build/status.json': validRecord(),
        'tasks/builds/my-build/handoff.md': broken,
      });
      const { deps } = makeDeps();
      const r = await runSyncStatus({ root, slug: 'my-build', requireHandover: true, deps });
      expect(r.exitCode).toBe(2);
      expect(r.reason).toBe('handover_incomplete');
    });

    it('complete handover → children run, exit 0', async () => {
      const { runSyncStatus } = await loadSyncStatus({ ajv: true });
      const root = await makeRoot({
        'tasks/builds/my-build/status.json': validRecord(),
        'tasks/builds/my-build/handoff.md': GOOD_HANDOVER,
      });
      const { calls, deps } = makeDeps();
      const r = await runSyncStatus({ root, slug: 'my-build', requireHandover: true, expectStatus: 'MERGED', deps });
      expect(r.exitCode).toBe(0);
      expect(calls).toEqual(['generator', 'board']);
    });
  });
});

// ---------------------------------------------------------------------------
// (c) generator hard error → exit 1, board-sync NOT invoked.
// ---------------------------------------------------------------------------
describe('(c) generator hard error', () => {
  it('exits 1 and never calls board-sync', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const { calls, deps } = makeDeps(undefined, { exitCode: 1 });
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(1);
    expect(calls).toEqual(['generator']);
    expect(deps.runBoardSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (d) board unreachable → exit 3 + the mapped remediation line.
// ---------------------------------------------------------------------------
describe('(d) board unreachable', () => {
  it('exit 3 with the missing_project_scope remediation', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps({ exitCode: 3, reasons: ['missing_project_scope'], target: { slug: 'my-build', outcome: 'absent' }, records: {} });
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(3);
    const output = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('gh auth refresh -s project');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (e) resolves from _archive when the record is terminal.
// ---------------------------------------------------------------------------
describe('(e) archive resolution', () => {
  it('a terminal archived record resolves and syncs', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/_archive/my-build/status.json': validRecord({ status: 'MERGED' }) });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', expectStatus: 'MERGED', deps });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['generator', 'board']);
  });
});

// ---------------------------------------------------------------------------
// (f) duplicate-location → active wins, warning printed, children still run.
// ---------------------------------------------------------------------------
describe('(f) duplicate location', () => {
  it('active copy wins and children run', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({
      'tasks/builds/my-build/status.json': validRecord(),
      'tasks/builds/_archive/my-build/status.json': validRecord(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['generator', 'board']);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('duplicate-location');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (g) multiple board reasons → each mapped independently.
// ---------------------------------------------------------------------------
describe('(g) multiple reasons', () => {
  it('maps every reason', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = makeDeps({ exitCode: 3, reasons: ['no_config', 'missing_project_scope'], target: { slug: 'my-build', outcome: 'absent' }, records: {} });
    await runSyncStatus({ root, slug: 'my-build', deps });
    const output = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('add `projects_board`');
    expect(output).toContain('gh auth refresh -s project');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (h) target-truth: success/failure keyed on the TARGET, not the global code.
// ---------------------------------------------------------------------------
describe('(h) target truth vs global exit', () => {
  it('target refused while global exit 0 → NOT reported as success', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const { deps } = makeDeps({ exitCode: 0, reasons: [], target: { slug: 'my-build', outcome: 'refused' }, records: {} });
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(3);
    expect(r.targetOutcome).toBe('refused');
  });

  it('target applied while an UNRELATED record raised global exit 3 → target success (exit 0)', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const { deps } = makeDeps({ exitCode: 3, reasons: ['gh_failure'], target: { slug: 'my-build', outcome: 'applied' }, records: { 'old-build': { outcome: 'gh_failure' } } });
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(0);
    expect(r.targetOutcome).toBe('applied');
  });

  it('target partial → not success', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot({ 'tasks/builds/my-build/status.json': validRecord() });
    const { deps } = makeDeps({ exitCode: 0, reasons: [], target: { slug: 'my-build', outcome: 'partial' }, records: {} });
    const r = await runSyncStatus({ root, slug: 'my-build', deps });
    expect(r.exitCode).toBe(3);
    expect(r.targetOutcome).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// (i) mode flags.
// ---------------------------------------------------------------------------
describe('(i) mode resolution', () => {
  it('no mode flag → usage error exit 2, no children', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root: '/x', deps });
    expect(r.exitCode).toBe(2);
    expect(r.stage).toBe('usage');
    expect(calls).toEqual([]);
  });

  it('--slug and --all together → usage error exit 2', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root: '/x', slug: 'my-build', all: true, deps });
    expect(r.exitCode).toBe(2);
    expect(r.stage).toBe('usage');
    expect(calls).toEqual([]);
  });

  it('--all runs the sweep with no targetSlug', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const root = await makeRoot();
    const { calls, deps } = makeDeps({ exitCode: 0, reasons: [], target: null, records: {} });
    const r = await runSyncStatus({ root, all: true, deps });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual(['generator', 'board']);
    expect(deps.runBoardSync).toHaveBeenCalledWith(expect.objectContaining({ targetSlug: null }));
  });
});

// ---------------------------------------------------------------------------
// (j) slug containment — a traversal value is rejected before any path read.
// ---------------------------------------------------------------------------
describe('(j) slug containment', () => {
  it('../../x is rejected before any child runs', async () => {
    const { runSyncStatus } = await loadSyncStatus({ ajv: true });
    const { calls, deps } = makeDeps();
    const r = await runSyncStatus({ root: '/x', slug: '../../x', deps });
    expect(r.exitCode).toBe(2);
    expect(r.reason).toBe('invalid_slug');
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePostMergeHandover — the pure W6 validator, exercised directly.
// ---------------------------------------------------------------------------
describe('validatePostMergeHandover', () => {
  const COMPLETE = [
    '## Post-merge handover',
    '**Shipped:** PR #733 · my-build · squash 6d671ff · 2026-08-19',
    '',
    '**What was built**',
    '- A thing',
    '',
    '**To enable / configure**',
    '- Turn on the flag in Settings',
    '',
    '**Urgent follow-on engineering**',
    '- None urgent: 3 routine item(s) in the backlog.',
    '',
    '### Follow-on triage',
    '- todo#1 | urgent-now | would block launch',
    '- todo#2 | routine | cosmetic',
  ].join('\n');

  it('accepts a complete handover', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    expect(validatePostMergeHandover(COMPLETE)).toBeNull();
  });

  it('accepts the empty-state literals in the optional sections', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    const withLiterals = COMPLETE
      .replace('- Turn on the flag in Settings', '- None: live on deploy.');
    expect(validatePostMergeHandover(withLiterals)).toBeNull();
  });

  it('accepts a clean build using the triage-ledger empty-state literal', async () => {
    // A build that added nothing has an empty ledger — it must still validate
    // via the empty-state literal, or a valid clean build could never produce a
    // complete handover and its MERGED sync would hard-fail (exit 2).
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    const clean = [
      '## Post-merge handover',
      '**Shipped:** PR #733 · my-build · squash 6d671ff · 2026-08-19',
      '',
      '**What was built**',
      '- A small fix',
      '',
      '**To enable / configure**',
      '- None: live on deploy.',
      '',
      '**Urgent follow-on engineering**',
      '- None urgent: 0 routine item(s) in the backlog.',
      '',
      '### Follow-on triage',
      '- None: no follow-on items.',
    ].join('\n');
    expect(validatePostMergeHandover(clean)).toBeNull();
  });

  it('rejects an empty triage ledger with no empty-state literal', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    const broken = COMPLETE.replace(/### Follow-on triage[\s\S]*$/, '### Follow-on triage\n');
    expect(validatePostMergeHandover(broken)).toBeTruthy();
  });

  it('rejects an empty string', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    expect(validatePostMergeHandover('')).toBeTruthy();
  });

  it('rejects a handover with no **Shipped:** provenance line', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    const noShipped = COMPLETE.replace(/^\*\*Shipped:\*\*.*$/m, '');
    const err = validatePostMergeHandover(noShipped);
    expect(err).toBeTruthy();
    expect(err).toContain('Shipped');
  });

  it('rejects a malformed Shipped line (non-SHA squash token)', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    const bad = COMPLETE.replace('squash 6d671ff', 'squash notasha');
    expect(validatePostMergeHandover(bad)).toBeTruthy();
  });

  it('rejects a Shipped slug that does not match the target build', async () => {
    const { validatePostMergeHandover } = await loadSyncStatus({ ajv: true });
    // Structure is valid, but the provenance names a different build.
    expect(validatePostMergeHandover(COMPLETE, { slug: 'a-different-build' })).toBeTruthy();
    // …and passes when the slug matches.
    expect(validatePostMergeHandover(COMPLETE, { slug: 'my-build' })).toBeNull();
  });
});
