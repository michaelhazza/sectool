/**
 * resolve-authoritative-checks.test.mjs — the eleven mandatory resolver
 * fixtures from plan §6 plus producer-key normalization cases.
 *
 * The resolver's `gh` seam is INJECTED (plan §6: pure core + thin gh seam), so
 * every case drives a recording/canned fake and never touches the network. The
 * fixtures assert the KEY invariant: the newest APPLICABLE terminal run for a
 * head SHA + workflow + trigger class decides, judged against each check's own
 * producer — never `PR + context name`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCheckRunsArgs,
  CONFIG_TRIGGER_TO_CLASS,
  flattenCheckRunPages,
  readFenceConfig,
  resolveAuthoritativeChecks,
  selectAuthoritativeRun,
  normaliseProducerKey,
  normaliseRun,
  producerClassOf,
  triggerClassOf,
  VERDICTS,
} from './resolve-authoritative-checks.mjs';

const T = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;
const run = (over) => ({
  databaseId: 1,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  createdAt: T(0),
  attempt: 1,
  ...over,
});

/**
 * Fake gh: returns canned data by request kind. `runListSeq` supplies a
 * per-call sequence for the target workflow (registration/re-check fence);
 * `otherRunList` answers a different workflow's run list.
 */
function makeGh(script) {
  let call = 0;
  return async (req) => {
    switch (req.kind) {
      case 'runList': {
        if (script.otherWorkflow && req.workflow === script.otherWorkflow) return script.otherRunList ?? [];
        if (script.runListSeq) {
          const r = script.runListSeq[Math.min(call, script.runListSeq.length - 1)];
          call += 1;
          return r;
        }
        call += 1;
        return script.runList ?? [];
      }
      case 'runJobs':
        return script.jobs?.[String(req.runId)] ?? { jobs: [] };
      case 'requiredChecks':
        return script.required ?? [];
      case 'checkRuns':
        return script.checkRuns ?? [];
      case 'commitStatus':
        return script.commitStatus ?? { statuses: [] };
      default:
        throw new Error(`fake gh: unknown kind ${req.kind}`);
    }
  };
}

const resolve = (script, over = {}) =>
  resolveAuthoritativeChecks({ workflow: 'ci.yml', triggerClass: 'push', gh: makeGh(script), ...over });

describe('resolve-authoritative-checks — eleven mandatory fixtures', () => {
  it('1. cancelled-older + successful-newer → newer run is authoritative (PASS)', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, conclusion: 'cancelled', createdAt: T(0) }),
        run({ databaseId: 2, conclusion: 'success', createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('2');
    expect(r.superseded).toContain('1');
  });

  it('2. successful-older + failed-newer → newer failure is authoritative (FAILURE)', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, conclusion: 'success', createdAt: T(0) }),
        run({ databaseId: 2, conclusion: 'failure', createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.FAILURE);
    expect(r.authoritativeRunId).toBe('2');
  });

  it('3. successful-older + manually-cancelled-newer, no replacement → stays CANCELLED (never promote the older success)', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, conclusion: 'success', createdAt: T(0) }),
        run({ databaseId: 2, conclusion: 'cancelled', createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.CANCELLED);
    expect(r.authoritativeRunId).toBe('2');
  });

  it('4. newer queued run → WAIT (older green never promoted past a live newer run)', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, conclusion: 'success', createdAt: T(0) }),
        run({ databaseId: 2, status: 'queued', conclusion: null, createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.authoritativeRunId).toBe('2');
  });

  it('5. newer in_progress run → WAIT', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, conclusion: 'success', createdAt: T(0) }),
        run({ databaseId: 2, status: 'in_progress', conclusion: null, createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.authoritativeRunId).toBe('2');
  });

  it('6. same SHA, different event → a non-matching trigger class never supersedes', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 1, event: 'push', conclusion: 'success', createdAt: T(0) }),
        run({ databaseId: 2, event: 'workflow_dispatch', conclusion: 'failure', createdAt: T(6) }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('1');
  });

  it('7. same SHA re-run attempt → higher attempt is newer even at equal createdAt', async () => {
    const r = await resolve({
      runList: [
        run({ databaseId: 70, conclusion: 'failure', createdAt: T(0), attempt: 1 }),
        run({ databaseId: 71, conclusion: 'success', createdAt: T(0), attempt: 2 }),
      ],
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('71');
    // pure selector proves attempt is the tiebreaker
    const sel = selectAuthoritativeRun(
      [
        normaliseRun({ databaseId: 70, event: 'push', status: 'completed', conclusion: 'failure', createdAt: T(0), attempt: 1 }),
        normaliseRun({ databaseId: 71, event: 'push', status: 'completed', conclusion: 'success', createdAt: T(0), attempt: 2 }),
      ],
      { triggerClass: 'push' },
    );
    expect(sel.run.attempt).toBe(2);
  });

  it('8. external required check → judged against its own app/check-run identity (not the run)', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 80, conclusion: 'success' })],
      required: [{ name: 'CodeQL', workflow: '', event: '', state: '', bucket: '' }],
      checkRuns: [
        {
          id: 9001,
          name: 'CodeQL',
          app: { id: 57789, slug: 'github-code-scanning' },
          status: 'completed',
          conclusion: 'failure',
          started_at: T(3),
        },
      ],
    });
    // run is green but the external producer is red → FAILURE decided by the external check
    expect(r.verdict).toBe(VERDICTS.FAILURE);
    expect(r.failing).toContain('CodeQL');
    const codeql = r.checks.find((c) => c.name === 'CodeQL');
    expect(codeql.producer).toBe('external');
    expect(codeql.producerKey).toBe('app:57789:9001:CodeQL');
  });

  it('9. other-workflow required check → judged against that workflow’s authoritative run', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 90, conclusion: 'success' })],
      required: [{ name: 'merge-gate', workflow: 'merge-gate.yml', event: 'push' }],
      otherWorkflow: 'merge-gate.yml',
      otherRunList: [
        run({ databaseId: 95, event: 'push', status: 'completed', conclusion: 'failure', createdAt: T(0) }),
      ],
    });
    // target run green, but merge-gate.yml's own authoritative run is red → FAILURE
    expect(r.verdict).toBe(VERDICTS.FAILURE);
    expect(r.failing).toContain('merge-gate');
    const mg = r.checks.find((c) => c.name === 'merge-gate');
    expect(mg.producer).toBe('other-workflow');
    expect(mg.producerKey).toBe('actions:merge-gate.yml:95:1:merge-gate');
  });

  it('10. run registers only on the second query → fence re-reads and resolves (not NO_RUN)', async () => {
    const registered = [run({ databaseId: 100, conclusion: 'success', createdAt: T(0) })];
    const r = await resolve({ runListSeq: [[], registered, registered] });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('100');
    expect(r.reads).toBeGreaterThanOrEqual(2);
  });

  it('11. newer run appears between the first and second read → re-check catches it (PASS→WAIT)', async () => {
    const first = [run({ databaseId: 110, conclusion: 'success', createdAt: T(0) })];
    const second = [
      run({ databaseId: 110, conclusion: 'success', createdAt: T(0) }),
      run({ databaseId: 111, status: 'in_progress', conclusion: null, createdAt: T(6) }),
    ];
    const r = await resolve({ runListSeq: [first, second, second] });
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.authoritativeRunId).toBe('111');
  });
});

// ---------------------------------------------------------------------------
// Registration fence — the post-push race (external review finding 1). Two
// back-to-back empty reads must NOT be read as "no run expected" under a fence,
// or the label add races a run that is still registering (reopening D4). The
// bounded TIME wait lives in label.sh; the resolver's job is only to classify
// an empty-while-expecting-a-run snapshot as WAIT (registration pending), never
// NO_RUN (exit 0).
// ---------------------------------------------------------------------------
describe('resolve-authoritative-checks — registration fence (expectRun)', () => {
  it('empty then empty WITHOUT expectRun stays NO_RUN (diagnostic mode unchanged)', async () => {
    const r = await resolve({ runListSeq: [[], []] });
    expect(r.verdict).toBe(VERDICTS.NO_RUN);
  });

  it('empty then empty WITH expectRun → WAIT registrationPending, NEVER NO_RUN (the race fix)', async () => {
    const r = await resolve({ runListSeq: [[], []] }, { expectRun: true });
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.registrationPending).toBe(true);
    expect(r.authoritativeRunId).toBeNull();
  });

  it('[] -> [] -> registered WITH expectRun: the single call returns WAIT (caller re-polls), never NO_RUN', async () => {
    // The resolver sees []->[] (stable-empty), so it returns WAIT registrationPending;
    // it must NOT skip ahead and it must NOT return NO_RUN. The bounded retry in
    // label.sh is what eventually observes the registered run.
    const registered = [run({ databaseId: 200, conclusion: 'success', createdAt: T(0) })];
    const r = await resolve({ runListSeq: [[], [], registered] }, { expectRun: true });
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.registrationPending).toBe(true);
    expect(r.verdict).not.toBe(VERDICTS.NO_RUN);
  });

  it('[] -> registered WITH expectRun resolves the registered run (fence catches an early registration)', async () => {
    const registered = [run({ databaseId: 201, conclusion: 'success', createdAt: T(0) })];
    const r = await resolve({ runListSeq: [[], registered, registered] }, { expectRun: true });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('201');
    expect(r.registrationPending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// External producer binding (external review finding 2). A required context
// name alone does not bind the required producer; when two DIFFERENT apps emit
// the same required context, the newest must NOT be allowed to decide. Fail
// SAFE to WAIT (pending), never a PASS from the wrong app.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// REST pagination boundary (external review round 3). `gh api --paginate` emits
// one JSON object PER PAGE for an object-returning endpoint, so the old
// JSON.parse(--paginate) threw on page 2+ — and check-runs pages at 30 by
// default, so any SHA with >30 checks broke external producer resolution. The
// seam now uses --slurp and flattens; this pins the flattening, which the
// injected-gh fixtures never exercise.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Declared-event → internal-class boundary (external review round 4). Consumers
// declare a REAL GitHub event (`ci_workflow_trigger: "pull_request"`), while
// this module normalises runs into internal classes (`labeled`). Comparing the
// two vocabularies directly filtered out every genuine run: NO_RUN → (with
// --expect-run) WAIT forever → the fence blocked the label add permanently for
// the configuration this very repo ships. The resolver must accept the event
// name it is given.
// ---------------------------------------------------------------------------
describe('trigger vocabulary — declared GitHub events resolve', () => {
  it('a real pull_request run resolves when the caller declares trigger "pull_request"', async () => {
    const r = await resolve(
      {
        runList: [run({ databaseId: 500, event: 'pull_request', conclusion: 'success' })],
        required: [],
      },
      { triggerClass: 'pull_request' },
    );
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('500');
  });

  it('the same run still resolves under the internal class name "labeled" (idempotent)', async () => {
    const r = await resolve(
      { runList: [run({ databaseId: 501, event: 'pull_request', conclusion: 'success' })], required: [] },
      { triggerClass: 'labeled' },
    );
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.authoritativeRunId).toBe('501');
  });

  it('under --expect-run a declared pull_request trigger does NOT report a phantom registration-pending', async () => {
    // The blocking symptom: a live pull_request run present, yet the fence saw
    // an empty applicable set and waited forever.
    const r = await resolve(
      { runList: [run({ databaseId: 502, event: 'pull_request', conclusion: 'success' })], required: [] },
      { triggerClass: 'pull_request', expectRun: true },
    );
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.registrationPending).toBeUndefined();
  });

  it('trigger isolation still holds: a push run does not satisfy a declared pull_request trigger', async () => {
    const r = await resolve(
      { runList: [run({ databaseId: 503, event: 'push', conclusion: 'success' })], required: [] },
      { triggerClass: 'pull_request' },
    );
    expect(r.verdict).toBe(VERDICTS.NO_RUN);
  });
});

// ---------------------------------------------------------------------------
// trigger: none (external review round 5). "This push fires no automatic run"
// is NOT "no run of this workflow can be live on this SHA". Narrowing `none` to
// the push class filtered out workflow_dispatch and re-run runs and reported a
// false NO_RUN, so the label add could race/cancel them — the very thing the
// fence exists to prevent. `none` maps to the WILDCARD class instead.
// ---------------------------------------------------------------------------
describe('readFenceConfig — the single config owner', () => {
  it('resolves workflow + trigger + derived behaviour from the nested keys', () => {
    const cfg = readFenceConfig({ ci_workflow_files: { ci_workflow: 'ci.yml', ci_workflow_trigger: 'pull_request' } });
    expect(cfg.error).toBeUndefined();
    expect(cfg).toMatchObject({ workflow: 'ci.yml', trigger: 'pull_request', triggerClass: 'labeled', expectRun: true });
  });

  it('fails closed (never defaults) when the workflow is missing', () => {
    expect(readFenceConfig({ ci_workflow_files: { ci_workflow_trigger: 'push' } }).error).toMatch(/ci_workflow not configured/);
    expect(readFenceConfig(null).error).toBeTruthy();
  });

  it('fails closed when the trigger is missing or out of the closed set', () => {
    expect(readFenceConfig({ ci_workflow_files: { ci_workflow: 'ci.yml' } }).error).toMatch(/ci_workflow_trigger not configured/);
    expect(readFenceConfig({ ci_workflow_files: { ci_workflow: 'ci.yml', ci_workflow_trigger: 'sometimes' } }).error).toBeTruthy();
  });
});

describe('CONFIG_TRIGGER_TO_CLASS — declared trigger drives class + expectRun', () => {
  it('maps each declared trigger exactly once, in one place', () => {
    expect(CONFIG_TRIGGER_TO_CLASS.push).toEqual({ triggerClass: 'push', expectRun: true });
    expect(CONFIG_TRIGGER_TO_CLASS.pull_request).toEqual({ triggerClass: 'labeled', expectRun: true });
    expect(CONFIG_TRIGGER_TO_CLASS.none).toEqual({ triggerClass: 'any', expectRun: false });
  });

  it('trigger none + NO runs → safe NO_RUN', async () => {
    const r = await resolve({ runList: [], required: [] }, { triggerClass: 'any', expectRun: false });
    expect(r.verdict).toBe(VERDICTS.NO_RUN);
  });

  it('trigger none + a LIVE workflow_dispatch run → WAIT (blocks the add)', async () => {
    const r = await resolve(
      { runList: [run({ databaseId: 900, event: 'workflow_dispatch', status: 'in_progress', conclusion: null })], required: [] },
      { triggerClass: 'any', expectRun: false },
    );
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.authoritativeRunId).toBe('900');
  });

  it('trigger none + a FAILED workflow_dispatch run → FAILURE (blocks the add)', async () => {
    const r = await resolve(
      { runList: [run({ databaseId: 901, event: 'workflow_dispatch', conclusion: 'failure' })], required: [] },
      { triggerClass: 'any', expectRun: false },
    );
    expect(r.verdict).toBe(VERDICTS.FAILURE);
    expect(r.authoritativeRunId).toBe('901');
  });

  it('trigger none + a live re-run of the push workflow also blocks (no event is filtered away)', async () => {
    const r = await resolve(
      { runList: [run({ databaseId: 902, event: 'push', status: 'in_progress', conclusion: null, attempt: 2 })], required: [] },
      { triggerClass: 'any', expectRun: false },
    );
    expect(r.verdict).toBe(VERDICTS.WAIT);
  });
});

// ---------------------------------------------------------------------------
// Cross-workflow trigger identity (external review round 5). A required check
// produced by a DIFFERENT workflow has its own trigger; inheriting the target's
// made a push-triggered secondary invisible to a pull_request-triggered target.
// ---------------------------------------------------------------------------
describe('other-workflow required checks use their OWN event', () => {
  it('a push-triggered secondary resolves under a pull_request-triggered target', async () => {
    const r = await resolve(
      {
        runList: [run({ databaseId: 950, event: 'pull_request', conclusion: 'success' })],
        required: [{ name: 'merge-gate', workflow: 'merge-gate.yml', event: 'push' }],
        otherWorkflow: 'merge-gate.yml',
        otherRunList: [run({ databaseId: 960, event: 'push', conclusion: 'failure' })],
      },
      { triggerClass: 'pull_request' },
    );
    // Inheriting the target's trigger would have found no pull_request run of
    // merge-gate.yml and reported it pending (WAIT) forever; its own event
    // resolves the real, failing run.
    expect(r.verdict).toBe(VERDICTS.FAILURE);
    expect(r.failing).toContain('merge-gate');
  });

  it('a secondary with no declared event falls back to the wildcard, never to the target trigger', async () => {
    const r = await resolve(
      {
        runList: [run({ databaseId: 951, event: 'pull_request', conclusion: 'success' })],
        required: [{ name: 'nightly', workflow: 'nightly.yml' }], // no event field
        otherWorkflow: 'nightly.yml',
        otherRunList: [run({ databaseId: 961, event: 'schedule', conclusion: 'success' })],
      },
      { triggerClass: 'pull_request' },
    );
    expect(r.verdict).toBe(VERDICTS.PASS);
  });
});

// ---------------------------------------------------------------------------
// gh api ARGUMENT boundary (external review round 4). The first bug here was
// serialization (--paginate emits one object per page); the second was an
// INVENTED FLAG (`--per-page`), which gh api does not accept — it exits with
// "unknown flag" before paginating. Neither is reachable from the injected-gh
// fixtures, so the argv itself is pinned.
// ---------------------------------------------------------------------------
describe('buildCheckRunsArgs — the gh api argument boundary', () => {
  it('passes page size as a QUERY PARAMETER, never as a --per-page flag', () => {
    const args = buildCheckRunsArgs('acme/widgets', 'deadbeef');
    expect(args).not.toContain('--per-page');
    expect(args.some((a) => a.includes('per_page=100'))).toBe(true);
  });

  it('uses only real gh api flags (--paginate + --slurp) on the right endpoint', () => {
    const args = buildCheckRunsArgs('acme/widgets', 'deadbeef');
    expect(args[0]).toBe('api');
    expect(args[1]).toBe('repos/acme/widgets/commits/deadbeef/check-runs?per_page=100');
    expect(args).toContain('--paginate');
    expect(args).toContain('--slurp');
    // Every flag-looking token must be one of the two gh api flags we rely on.
    const flags = args.filter((a) => a.startsWith('--'));
    expect(flags.sort()).toEqual(['--paginate', '--slurp']);
  });
});

describe('flattenCheckRunPages — the --paginate --slurp boundary', () => {
  it('flattens TWO slurped pages into one check-run list', () => {
    const pages = [
      { total_count: 45, check_runs: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] },
      { total_count: 45, check_runs: [{ id: 3, name: 'c' }] },
    ];
    expect(flattenCheckRunPages(pages).map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('accepts a single un-slurped page object', () => {
    expect(flattenCheckRunPages({ total_count: 1, check_runs: [{ id: 7 }] }).map((c) => c.id)).toEqual([7]);
  });

  it('accepts a bare array of check runs and empty/absent payloads', () => {
    expect(flattenCheckRunPages([{ id: 9, name: 'x' }]).map((c) => c.id)).toEqual([9]);
    expect(flattenCheckRunPages([])).toEqual([]);
    expect(flattenCheckRunPages(null)).toEqual([]);
    expect(flattenCheckRunPages({ total_count: 0, check_runs: [] })).toEqual([]);
  });
});

describe('resolve-authoritative-checks — external producer ambiguity', () => {
  it('two apps emit the same required check name → ambiguous producer → WAIT, not a wrong-app PASS', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 300, conclusion: 'success' })],
      required: [{ name: 'security', workflow: '', event: '', state: '', bucket: '' }],
      checkRuns: [
        { id: 1, name: 'security', app: { id: 111, slug: 'app-a' }, status: 'completed', conclusion: 'failure', started_at: T(1) },
        { id: 2, name: 'security', app: { id: 222, slug: 'app-b' }, status: 'completed', conclusion: 'success', started_at: T(5) },
      ],
    });
    // Newest is app-b (success); a name-only resolver would return PASS. The
    // producer is ambiguous, so the verdict is WAIT (pending), never PASS.
    expect(r.verdict).toBe(VERDICTS.WAIT);
    expect(r.pending).toContain('security');
    const check = r.checks.find((c) => c.name === 'security');
    expect(check.ambiguousProducer).toBe(true);
    expect(check.producerKey).toBeNull();
  });

  it('same app emits the check twice (a re-run) → newest wins (single producer, not ambiguous)', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 301, conclusion: 'success' })],
      required: [{ name: 'CodeQL', workflow: '', event: '', state: '', bucket: '' }],
      checkRuns: [
        { id: 1, name: 'CodeQL', app: { id: 57789, slug: 'github-code-scanning' }, status: 'completed', conclusion: 'failure', started_at: T(1) },
        { id: 2, name: 'CodeQL', app: { id: 57789, slug: 'github-code-scanning' }, status: 'completed', conclusion: 'success', started_at: T(5) },
      ],
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    const check = r.checks.find((c) => c.name === 'CodeQL');
    expect(check.producerKey).toBe('app:57789:2:CodeQL');
  });
});

describe('resolve-authoritative-checks — happy path + legacy status producer', () => {
  it('all-green target-workflow required checks → PASS with actions producer keys', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 200, conclusion: 'success' })],
      required: [
        { name: 'unit', workflow: 'ci.yml', event: 'push' },
        { name: 'lint', workflow: 'ci.yml', event: 'push' },
      ],
      jobs: {
        200: {
          jobs: [
            { name: 'unit', status: 'completed', conclusion: 'success' },
            { name: 'lint', status: 'completed', conclusion: 'success' },
          ],
        },
      },
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.checks.map((c) => c.producerKey)).toEqual([
      'actions:ci.yml:200:1:unit',
      'actions:ci.yml:200:1:lint',
    ]);
  });

  it('legacy commit status producer → status:<context> key', async () => {
    const r = await resolve({
      runList: [run({ databaseId: 210, conclusion: 'success' })],
      required: [{ name: 'ci/legacy', workflow: '', event: '' }],
      checkRuns: [],
      commitStatus: { statuses: [{ context: 'ci/legacy', state: 'success' }] },
    });
    expect(r.verdict).toBe(VERDICTS.PASS);
    const legacy = r.checks.find((c) => c.name === 'ci/legacy');
    expect(legacy.producerKey).toBe('status:ci/legacy');
  });

  it('no applicable run at all after the fence → NO_RUN', async () => {
    const r = await resolve({ runListSeq: [[], [], []] });
    expect(r.verdict).toBe(VERDICTS.NO_RUN);
    expect(r.authoritativeRunId).toBeNull();
  });
});

describe('producer-key normalization', () => {
  it('actions key: actions:<workflow>:<run>:<attempt>:<job>', () => {
    expect(
      normaliseProducerKey({ kind: 'actions', workflow: 'ci.yml', runId: '123', attempt: 2, job: 'unit-tests-gates' }),
    ).toBe('actions:ci.yml:123:2:unit-tests-gates');
  });

  it('actions key defaults a missing attempt to 1', () => {
    expect(normaliseProducerKey({ kind: 'actions', workflow: 'ci.yml', runId: '123', job: 'unit' })).toBe(
      'actions:ci.yml:123:1:unit',
    );
  });

  it('external check-run key: app:<app-id>:<check-run-id>:<name>', () => {
    expect(normaliseProducerKey({ kind: 'check_run', appId: 57789, checkRunId: 9001, name: 'CodeQL' })).toBe(
      'app:57789:9001:CodeQL',
    );
  });

  it('legacy status key: status:<context>', () => {
    expect(normaliseProducerKey({ kind: 'status', context: 'continuous-integration/jenkins' })).toBe(
      'status:continuous-integration/jenkins',
    );
  });

  it('unknown kind throws (no silent mis-keying)', () => {
    expect(() => normaliseProducerKey({ kind: 'mystery' })).toThrow(/unknown kind/);
    expect(() => normaliseProducerKey(null)).toThrow(/must be an object/);
  });
});

describe('pure helpers', () => {
  it('triggerClassOf maps events to classes', () => {
    expect(triggerClassOf('push')).toBe('push');
    expect(triggerClassOf('pull_request')).toBe('labeled');
    expect(triggerClassOf('workflow_dispatch')).toBe('workflow_dispatch');
    expect(triggerClassOf('schedule')).toBe('schedule');
  });

  it('producerClassOf: target vs other-workflow vs external', () => {
    expect(producerClassOf({ name: 'unit', workflow: 'ci.yml' }, 'ci.yml')).toBe('target');
    expect(producerClassOf({ name: 'mg', workflow: 'merge-gate.yml' }, 'ci.yml')).toBe('other-workflow');
    expect(producerClassOf({ name: 'CodeQL', workflow: '' }, 'ci.yml')).toBe('external');
  });

  it('selectAuthoritativeRun: an older cancelled run superseded by a newer success is informational only', () => {
    const sel = selectAuthoritativeRun(
      [
        normaliseRun({ databaseId: 1, event: 'push', status: 'completed', conclusion: 'cancelled', createdAt: T(0) }),
        normaliseRun({ databaseId: 2, event: 'push', status: 'completed', conclusion: 'success', createdAt: T(6) }),
      ],
      { triggerClass: 'push' },
    );
    expect(sel.status).toBe('RESOLVED');
    expect(sel.run.runId).toBe('2');
    expect(sel.superseded.map((r) => r.runId)).toEqual(['1']);
  });
});
