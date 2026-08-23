#!/usr/bin/env node
// resolve-authoritative-checks.mjs — owns CI run-identity so no caller has to
// re-implement "which run actually decides this head SHA" in prose (framework
// status-sync hardening, plan §6 / W4).
//
// The defect this mechanises (D4): `cancel-in-progress` concurrency produces two
// runs for one head SHA seconds apart; the cancelled run publishes CANCELLED
// conclusions under the SAME required-context names, so a PR-level rollup reads
// BLOCKED and shows "fail" rows for an authoritative run that is entirely green.
// A resolution rule stated in prose and re-implemented per caller WILL drift;
// one tested script, called by every caller, cannot.
//
// KEY = HEAD_SHA + workflow + trigger class + RUN_ID + attempt + check.
// NEVER `PR + context name` — the PR rollup mixes identically-named contexts
// from every run of the head SHA and collapses their identity.
//
// ---------------------------------------------------------------------------
// Structure (mirrors board-sync.mjs): all decision logic lives in exported PURE
// functions with no I/O; a thin `gh` seam is INJECTED into the async
// orchestrator so tests drive it with a recording fake and never touch the
// network. The CLI binds the real `gh` seam (execFileSync) and is guarded so
// importing this module never shells out.
//
// Repo-agnostic by design (matches label.sh's own header contract): the
// workflow file and the expected trigger class are EXPLICIT parameters. This
// module never hardcodes `ci.yml` — the caller resolves it from consumer
// configuration and passes `--workflow`.
// ---------------------------------------------------------------------------
//
// stdlib-only at runtime (gh is an external binary, not an npm dependency).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── verdicts (printed as `OUTCOME: <verdict>`; exit code per VERDICT_EXIT) ─────
export const VERDICTS = Object.freeze({
  PASS: 'PASS', // authoritative run terminal-success AND every required check green vs its own producer
  FAILURE: 'FAILURE', // authoritative run failed, or a required check failed vs its own producer
  WAIT: 'WAIT', // newest applicable run is queued/in_progress, not yet registered, or a check still pending
  CANCELLED: 'CANCELLED', // newest applicable run cancelled with no strictly-newer replacement
  NO_RUN: 'NO_RUN', // no applicable run for this SHA+workflow+trigger-class (bounded no-run-expected)
});

// Exit codes: 0 = safe for a label add (no live/failed/cancelled run gating it);
// non-zero = the caller's label-add fence must NOT add the label yet.
export const VERDICT_EXIT = Object.freeze({
  PASS: 0,
  NO_RUN: 0,
  WAIT: 20,
  CANCELLED: 22,
  FAILURE: 21,
});

// GitHub `event` → trigger class. Supersession only applies within one class
// (plan §6 step 3): a push run, a labeled `pull_request` run, a
// `workflow_dispatch` run and re-run attempts can all share a head SHA.
//
// `any` is a deliberate WILDCARD class, not an event: it means "do not filter by
// event at all". It exists for the declared `trigger: none` case — "this push
// fires no automatic run" is NOT "no run of this workflow can be live on this
// SHA" (a re-run or a workflow_dispatch can be). Filtering those out and
// answering NO_RUN would let a label add race them, which is the very thing the
// fence prevents. See CONFIG_TRIGGER_TO_CLASS.
export function triggerClassOf(event) {
  switch (event) {
    case 'push':
      return 'push';
    case 'pull_request':
    case 'pull_request_target':
      return 'labeled';
    case 'workflow_dispatch':
      return 'workflow_dispatch';
    default:
      return event ?? 'unknown';
  }
}

/**
 * ONE owner of the declared-trigger → resolver-behaviour mapping (external
 * review round 5). Rounds 3-5 all produced the same defect class: each caller
 * reconstructed event identity slightly differently (a hardcoded `push`, a raw
 * event name, a `none` silently narrowed to `push`). Centralising it here means
 * a caller declares WHAT ITS REPO DOES and never re-derives what that implies.
 *
 *   push | pull_request -> that event's class, and a run IS expected (the fence
 *                          waits for registration and fails closed on timeout)
 *   none               -> the WILDCARD class (any live/failed run of this
 *                          workflow still blocks) and NO run is expected, so an
 *                          empty list is a real NO_RUN rather than a wait
 */
export const CONFIG_TRIGGER_TO_CLASS = Object.freeze({
  push: { triggerClass: 'push', expectRun: true },
  pull_request: { triggerClass: 'labeled', expectRun: true },
  none: { triggerClass: 'any', expectRun: false },
});

/** The declared fence config, or an error string naming the missing key.
 *  Reading it lives HERE so `label.sh`, the coordinator playbook and any future
 *  caller cannot drift apart on which keys mean what. */
export function readFenceConfig(registry) {
  const files = registry?.ci_workflow_files ?? {};
  const workflow = (typeof files.ci_workflow === 'string' && files.ci_workflow.trim())
    ? files.ci_workflow.trim()
    : (typeof registry?.ci_workflow === 'string' && registry.ci_workflow.trim() ? registry.ci_workflow.trim() : null);
  const rawTrigger = (typeof files.ci_workflow_trigger === 'string' && files.ci_workflow_trigger.trim())
    ? files.ci_workflow_trigger.trim()
    : (typeof registry?.ci_workflow_trigger === 'string' ? registry.ci_workflow_trigger.trim() : null);

  if (!workflow) {
    return { error: 'ci_workflow not configured — set ci_workflow_files.ci_workflow (e.g. "ci.yml")' };
  }
  if (!rawTrigger || !Object.prototype.hasOwnProperty.call(CONFIG_TRIGGER_TO_CLASS, rawTrigger)) {
    return {
      error: 'ci_workflow_trigger not configured — set ci_workflow_files.ci_workflow_trigger to '
        + '"push" | "pull_request" | "none" (which event a push to a feature branch fires for this '
        + 'workflow, or "none" if it fires no run at all)',
    };
  }
  return { workflow, trigger: rawTrigger, ...CONFIG_TRIGGER_TO_CLASS[rawTrigger] };
}

// ── producer-key normalization (the closed key set the tests assert against) ──
// A run/job, an external check-run, and a legacy status each normalise to ONE
// stable producer key. This is what makes "judge each check against its own
// producer" mechanical instead of name-matching across runs.
export function normaliseProducerKey(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('normaliseProducerKey: entry must be an object');
  }
  switch (entry.kind) {
    case 'actions': {
      // actions:<workflow-file-or-id>:<run-id>:<attempt>:<job/check>
      const { workflow, runId, attempt, job } = entry;
      return `actions:${workflow}:${runId}:${attempt ?? 1}:${job}`;
    }
    case 'check_run': {
      // app:<app-id>:<check-run-id>:<name>
      const { appId, checkRunId, name } = entry;
      return `app:${appId}:${checkRunId}:${name}`;
    }
    case 'status': {
      // status:<context>
      return `status:${entry.context}`;
    }
    default:
      throw new TypeError(`normaliseProducerKey: unknown kind '${entry.kind}'`);
  }
}

// Normalise a raw `gh run list` row to the fields the resolver reasons over.
export function normaliseRun(row) {
  return {
    runId: String(row.databaseId ?? row.runId ?? ''),
    headSha: row.headSha ?? null,
    event: row.event ?? null,
    triggerClass: triggerClassOf(row.event),
    status: row.status ?? null, // queued | in_progress | completed | ...
    conclusion: row.conclusion ?? null, // success | failure | cancelled | ...
    createdAt: row.createdAt ?? null,
    attempt: Number(row.attempt ?? 1),
  };
}

// Recency order: createdAt ascending, then attempt (a re-run attempt is newer).
function recencyKey(run) {
  return [run.createdAt ?? '', run.attempt];
}
function newer(a, b) {
  const [ca, aa] = recencyKey(a);
  const [cb, ab] = recencyKey(b);
  if (ca !== cb) return ca > cb;
  return aa > ab;
}

const TERMINAL = new Set(['completed']);

/**
 * Select the authoritative run for one workflow + trigger class (PURE).
 *
 * Rules (plan §6):
 *  - Filter to the expected trigger class; a different-event run for the same
 *    SHA never supersedes (step 3).
 *  - The NEWEST applicable run decides. A cancelled run is "superseded" only
 *    when a strictly-newer applicable run exists — which, for the newest run,
 *    it never does, so a newest-cancelled with no replacement stays CANCELLED
 *    (step 2). An older cancelled run is simply not the newest.
 *  - Newest applicable run queued/in_progress → WAIT: nothing is evaluated and
 *    an older green run is never promoted past a live newer one (step 4).
 */
export function selectAuthoritativeRun(runs, { triggerClass } = {}) {
  // Accept EITHER a GitHub event name (`pull_request`) or an internal class
  // (`labeled`) — triggerClassOf is idempotent over the class names, so one
  // normalisation makes both work. Without this the boundary leaked: a consumer
  // declaring the real event `pull_request` was compared against runs already
  // normalised to `labeled`, so every genuine run was filtered out, the fence
  // saw NO_RUN, and (with --expect-run) blocked forever. Callers should not have
  // to know this module's internal vocabulary to ask it a question.
  const wanted = triggerClassOf(triggerClass);
  const applicable = runs
    .map((r) => (r.triggerClass ? r : normaliseRun(r)))
    // `any` deliberately skips event filtering — see triggerClassOf. Under a
    // declared `trigger: none`, a workflow_dispatch or re-run on this SHA must
    // still block the add; narrowing to one event class would filter it out and
    // report a false NO_RUN.
    .filter((r) => wanted === 'any' || r.triggerClass === wanted);
  if (applicable.length === 0) return { status: VERDICTS.NO_RUN, run: null, superseded: [] };

  let newest = applicable[0];
  for (const r of applicable) if (newer(r, newest)) newest = r;

  // Cancelled runs strictly older than `newest` are superseded (informational).
  const superseded = applicable.filter(
    (r) => r !== newest && r.conclusion === 'cancelled' && newer(newest, r),
  );

  if (!TERMINAL.has(newest.status)) return { status: VERDICTS.WAIT, run: newest, superseded };
  if (newest.conclusion === 'cancelled') return { status: VERDICTS.CANCELLED, run: newest, superseded };
  if (newest.conclusion === 'success') return { status: 'RESOLVED', run: newest, superseded };
  return { status: VERDICTS.FAILURE, run: newest, superseded };
}

// A conclusion string counts as green iff it is success/neutral/skipped.
const GREEN_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
export function isGreenConclusion(conclusion) {
  return GREEN_CONCLUSIONS.has(conclusion);
}

// Classify a required-check row to its producer (PURE). The required set is the
// enumeration source only (plan §6 step 5) — its `workflow` display field tells
// us WHERE to look; conclusions come from that producer, never from the rollup.
export function producerClassOf(requiredCheck, targetWorkflow) {
  const wf = requiredCheck.workflow ?? '';
  if (wf && wf === targetWorkflow) return 'target';
  if (wf) return 'other-workflow';
  return 'external';
}

const KEY_OF = (runs, triggerClass) => {
  const sel = selectAuthoritativeRun(runs, { triggerClass });
  return sel.run ? `${sel.run.runId}:${sel.run.attempt}:${sel.run.status}:${sel.run.conclusion}` : 'none';
};

/**
 * Judge one required check against its OWN producer (async — uses the injected
 * gh seam to reach jobs / check-runs / legacy statuses). Returns a normalised
 * result carrying the closed producer key.
 */
export async function judgeRequiredCheck(requiredCheck, { targetWorkflow, authRun, triggerClass, gh }) {
  const cls = producerClassOf(requiredCheck, targetWorkflow);
  const name = requiredCheck.name;

  if (cls === 'target') {
    const { jobs = [] } = (await gh({ kind: 'runJobs', runId: authRun.runId })) ?? {};
    const job = jobs.find((j) => j.name === name);
    return {
      name,
      producer: 'target',
      producerKey: normaliseProducerKey({
        kind: 'actions',
        workflow: targetWorkflow,
        runId: authRun.runId,
        attempt: authRun.attempt,
        job: name,
      }),
      status: job?.status ?? null,
      conclusion: job?.conclusion ?? null,
    };
  }

  if (cls === 'other-workflow') {
    const otherRuns = ((await gh({ kind: 'runList', workflow: requiredCheck.workflow })) ?? []).map(normaliseRun);
    // A SECOND workflow has its OWN trigger (external review round 5): a
    // pull_request-triggered target plus a push-triggered required workflow
    // would otherwise be searched for pull_request runs and reported
    // pending/no-run forever. Prefer the required check's own event; fall back
    // to the wildcard rather than to the target's trigger, so an unknown
    // secondary event can never be silently filtered to nothing.
    const otherClass = requiredCheck.event ? triggerClassOf(requiredCheck.event) : 'any';
    const sel = selectAuthoritativeRun(otherRuns, { triggerClass: otherClass });
    if (sel.status === VERDICTS.NO_RUN || sel.status === VERDICTS.WAIT) {
      return { name, producer: 'other-workflow', producerKey: null, status: 'pending', conclusion: null };
    }
    if (sel.status === VERDICTS.CANCELLED || sel.status === VERDICTS.FAILURE) {
      return {
        name,
        producer: 'other-workflow',
        producerKey: normaliseProducerKey({
          kind: 'actions',
          workflow: requiredCheck.workflow,
          runId: sel.run.runId,
          attempt: sel.run.attempt,
          job: name,
        }),
        status: 'completed',
        conclusion: sel.status === VERDICTS.CANCELLED ? 'cancelled' : 'failure',
      };
    }
    const { jobs = [] } = (await gh({ kind: 'runJobs', runId: sel.run.runId })) ?? {};
    const job = jobs.find((j) => j.name === name);
    return {
      name,
      producer: 'other-workflow',
      producerKey: normaliseProducerKey({
        kind: 'actions',
        workflow: requiredCheck.workflow,
        runId: sel.run.runId,
        attempt: sel.run.attempt,
        job: name,
      }),
      status: job?.status ?? sel.run.status,
      conclusion: job?.conclusion ?? sel.run.conclusion,
    };
  }

  // external: real check-run/app identity first, then legacy status.
  const checkRuns = (await gh({ kind: 'checkRuns' })) ?? [];
  const matches = checkRuns.filter((c) => c.name === name);
  if (matches.length) {
    // Producer binding (D4 thesis: NEVER collapse identity to a context name).
    // `gh pr checks --required` exposes only the context NAME, not the required
    // app id, so when two DIFFERENT apps emit the same required context we
    // cannot bind the required producer from the name alone. Picking the newest
    // same-named check would let an arbitrary app decide the verdict — the exact
    // identity-collapse this resolver exists to prevent. Fail SAFE: an ambiguous
    // producer is unresolved (pending → WAIT), never a PASS from the wrong app.
    const appIds = new Set(matches.map((c) => c.app?.id ?? 'unknown'));
    if (appIds.size > 1) {
      return { name, producer: 'external', producerKey: null, status: 'pending', conclusion: null, ambiguousProducer: true };
    }
    // Single producer (one app / one match) → newest by started_at wins (falls
    // back to id for determinism); same-producer newest is a legitimate re-run.
    let best = matches[0];
    for (const c of matches) {
      const ck = c.started_at ?? '';
      const bk = best.started_at ?? '';
      if (ck > bk || (ck === bk && String(c.id) > String(best.id))) best = c;
    }
    return {
      name,
      producer: 'external',
      producerKey: normaliseProducerKey({
        kind: 'check_run',
        appId: best.app?.id ?? 'unknown',
        checkRunId: best.id,
        name,
      }),
      status: best.status ?? 'completed',
      conclusion: best.conclusion ?? null,
    };
  }
  const { statuses = [] } = (await gh({ kind: 'commitStatus' })) ?? {};
  const st = statuses.find((s) => s.context === name);
  if (st) {
    return {
      name,
      producer: 'external',
      producerKey: normaliseProducerKey({ kind: 'status', context: name }),
      status: 'completed',
      conclusion: st.state === 'success' ? 'success' : st.state === 'pending' ? null : 'failure',
    };
  }
  return { name, producer: 'external', producerKey: null, status: 'pending', conclusion: null };
}

/**
 * The exact `gh api` argv for a commit's check-runs (PURE, exported so the
 * ARGUMENT boundary is tested — the second bug at this seam was an invented
 * flag, `--per-page`, which `gh api` does not have: it failed with
 * "unknown flag" before pagination even started. Page size is a QUERY
 * PARAMETER on the endpoint; only `--paginate` and `--slurp` are real flags.
 */
export function buildCheckRunsArgs(slug, headSha, { perPage = 100 } = {}) {
  return [
    'api',
    `repos/${slug}/commits/${headSha}/check-runs?per_page=${perPage}`,
    '--paginate',
    '--slurp',
  ];
}

/**
 * Flatten what `gh api --paginate --slurp .../check-runs` returns into ONE
 * check-run array (PURE, exported so the REST serialization boundary is tested
 * without shelling out — the injected-fake tests otherwise skip it entirely).
 *
 * --slurp yields `[{total_count, check_runs:[…]}, …]` (one entry per page).
 * A single un-slurped object and a bare array are both accepted so a caller
 * that drops --slurp, or an endpoint that returns a bare array, still works.
 */
export function flattenCheckRunPages(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    // Either an array of PAGES (objects carrying check_runs) or already an
    // array of check runs.
    return payload.flatMap((entry) => {
      if (entry && Array.isArray(entry.check_runs)) return entry.check_runs;
      return entry ? [entry] : [];
    });
  }
  if (Array.isArray(payload.check_runs)) return payload.check_runs;
  return [];
}

// Aggregate per-check results into a final verdict (PURE).
export function aggregateChecks(authRun, checks) {
  const pending = checks.filter((c) => c.conclusion == null || (c.status && c.status !== 'completed'));
  const failing = checks.filter((c) => c.conclusion != null && !isGreenConclusion(c.conclusion));
  if (pending.length) {
    return { verdict: VERDICTS.WAIT, authoritativeRunId: authRun.runId, checks, pending: pending.map((c) => c.name) };
  }
  if (failing.length) {
    return {
      verdict: VERDICTS.FAILURE,
      authoritativeRunId: authRun.runId,
      checks,
      failing: failing.map((c) => c.name),
    };
  }
  return { verdict: VERDICTS.PASS, authoritativeRunId: authRun.runId, checks };
}

/**
 * Resolve the authoritative verdict for one head SHA + workflow + trigger class.
 * `gh` is injected: an async fn taking { kind, ... } and returning parsed data.
 *
 * Registration/re-check fence (plan §6 step 6 + label-add fence): read the run
 * list until the newest applicable run is stable across two consecutive reads
 * or the read budget is exhausted. This closes BOTH "the pushed run has not
 * registered yet" (empty first read) and "a newer run appeared between
 * selection and action".
 */
export async function resolveAuthoritativeChecks({ workflow, triggerClass, gh, maxReads = 3, expectRun = false }) {
  if (!workflow) throw new Error('resolveAuthoritativeChecks: --workflow is required (never defaulted)');
  if (!triggerClass) throw new Error('resolveAuthoritativeChecks: triggerClass is required');

  let runs = [];
  let lastKey = null;
  let reads = 0;
  for (let i = 0; i < Math.max(2, maxReads); i++) {
    runs = ((await gh({ kind: 'runList', workflow })) ?? []).map(normaliseRun);
    reads += 1;
    const key = KEY_OF(runs, triggerClass);
    if (i > 0 && key === lastKey) break; // stable
    lastKey = key;
  }

  const sel = selectAuthoritativeRun(runs, { triggerClass });
  const base = { workflow, triggerClass, reads, superseded: (sel.superseded ?? []).map((r) => r.runId) };

  // Registration fence (post-push apply/restore): immediately after a push the
  // triggered run may not have registered yet, so an empty list means "not
  // registered YET", NOT "no run expected". Returning NO_RUN here (exit 0) would
  // let the label add while the run is registering — the exact two-runs-one-SHA
  // race W4 exists to close (the `[] -> [] -> registered` case). So under
  // expectRun an empty result is WAIT with registrationPending, and it STAYS
  // WAIT: the caller's fence polls (bounded, with backoff) and FAILS CLOSED when
  // the window expires, because elapsed time cannot prove a run is not coming.
  // "Nothing to race" is declared by the consumer instead (ci_workflow_trigger:
  // "none"), which simply calls this resolver WITHOUT expectRun. Diagnostic
  // callers (reading a red signal) also pass expectRun=false and keep NO_RUN.
  if (sel.status === VERDICTS.NO_RUN && expectRun) {
    return { ...base, verdict: VERDICTS.WAIT, authoritativeRunId: null, registrationPending: true };
  }
  if (sel.status === VERDICTS.NO_RUN) return { ...base, verdict: VERDICTS.NO_RUN, authoritativeRunId: null };
  if (sel.status === VERDICTS.WAIT) return { ...base, verdict: VERDICTS.WAIT, authoritativeRunId: sel.run.runId };
  if (sel.status === VERDICTS.CANCELLED) {
    return { ...base, verdict: VERDICTS.CANCELLED, authoritativeRunId: sel.run.runId };
  }
  if (sel.status === VERDICTS.FAILURE) {
    return { ...base, verdict: VERDICTS.FAILURE, authoritativeRunId: sel.run.runId };
  }

  // RESOLVED: authoritative run is terminal-success. Judge each required check
  // against its own producer.
  const required = (await gh({ kind: 'requiredChecks' })) ?? [];
  const checks = [];
  for (const req of required) {
    checks.push(await judgeRequiredCheck(req, { targetWorkflow: workflow, authRun: sel.run, triggerClass, gh }));
  }
  return { ...base, ...aggregateChecks(sel.run, checks) };
}

// ── real gh seam (only reached from the CLI; never in unit tests) ─────────────
function ghRaw(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}
function ghJson(args) {
  const out = ghRaw(args).trim();
  return out ? JSON.parse(out) : null;
}

function makeRealGh({ pr, headSha, repo }) {
  const repoArgs = repo ? ['--repo', repo] : [];
  return async (req) => {
    switch (req.kind) {
      case 'runList':
        return ghJson([
          'run',
          'list',
          '--workflow',
          req.workflow,
          '--commit',
          headSha,
          '--limit',
          '100',
          '--json',
          'databaseId,headSha,event,status,conclusion,createdAt,attempt',
          ...repoArgs,
        ]);
      case 'runJobs':
        return ghJson(['run', 'view', String(req.runId), '--json', 'jobs', ...repoArgs]);
      case 'requiredChecks':
        return ghJson([
          'pr',
          'checks',
          String(pr),
          '--required',
          '--json',
          'name,state,bucket,event,workflow',
          ...repoArgs,
        ]);
      case 'checkRuns': {
        const slug = repo ?? deriveRepo();
        // --slurp is REQUIRED with --paginate here (external review round 3).
        // `gh api --paginate` on an OBJECT-returning endpoint emits one JSON
        // object PER PAGE, concatenated — `JSON.parse` throws on page 2+. The
        // check-runs endpoint pages at 30 by default, so any SHA with >30 check
        // runs broke the very path that resolves external producer identity.
        // --slurp wraps the pages in one array (gh >= 2.53; pinned CLI is
        // 2.87.3). Page size rides as a query parameter — see buildCheckRunsArgs.
        return flattenCheckRunPages(ghJson(buildCheckRunsArgs(slug, headSha)));
      }
      case 'commitStatus': {
        const slug = repo ?? deriveRepo();
        return ghJson(['api', `repos/${slug}/commits/${headSha}/status`]);
      }
      default:
        throw new Error(`makeRealGh: unknown request kind '${req.kind}'`);
    }
  };
}

function deriveRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    /* fall through */
  }
  return null;
}

function extractFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Reads the consumer registry from disk for --configured/--print-config. */
function loadRegistry(root) {
  const file = path.join(root, '.claude', 'project-registries.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const pr = extractFlag(argv, '--pr');
  const headSha = extractFlag(argv, '--commit');
  const repo = extractFlag(argv, '--repo') ?? deriveRepo();
  const root = path.resolve(extractFlag(argv, '--root') ?? process.cwd());
  const configured = argv.includes('--configured') || argv.includes('--print-config');

  let workflow = extractFlag(argv, '--workflow');
  let triggerClass = extractFlag(argv, '--trigger-class') ?? 'push';
  let expectRun = argv.includes('--expect-run');

  // --configured: workflow AND trigger come from the consumer registry, so no
  // caller re-derives event identity (external review round 5 — the recurring
  // defect class was exactly that reconstruction). --print-config validates and
  // reports without contacting GitHub, so a caller can fail closed up front.
  if (configured) {
    const cfg = readFenceConfig(loadRegistry(root));
    if (cfg.error) {
      console.error(`[resolve-authoritative-checks] ERROR: ${cfg.error}`);
      process.exitCode = 2;
      return;
    }
    workflow = cfg.workflow;
    triggerClass = cfg.triggerClass;
    expectRun = cfg.expectRun;
    console.log(`config workflow=${cfg.workflow} trigger=${cfg.trigger} class=${cfg.triggerClass} expect_run=${cfg.expectRun}`);
    if (argv.includes('--print-config')) return; // validate-only mode
  }

  if (!workflow) {
    console.error('[resolve-authoritative-checks] ERROR: --workflow <file> is required (never defaulted), or pass --configured');
    process.exitCode = 2;
    return;
  }
  if (!headSha) {
    console.error('[resolve-authoritative-checks] ERROR: --commit <sha> is required');
    process.exitCode = 2;
    return;
  }

  const gh = makeRealGh({ pr, headSha, repo });
  const result = await resolveAuthoritativeChecks({ workflow, triggerClass, gh, expectRun });
  const detail = [
    result.authoritativeRunId ? `run=${result.authoritativeRunId}` : null,
    result.registrationPending ? 'registration=pending' : null,
    result.failing ? `failing=${result.failing.join(',')}` : null,
    result.pending ? `pending=${result.pending.join(',')}` : null,
    result.superseded?.length ? `superseded=${result.superseded.join(',')}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`OUTCOME: ${result.verdict}${detail ? ` ${detail}` : ''}`);
  process.exitCode = VERDICT_EXIT[result.verdict] ?? 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[resolve-authoritative-checks] unexpected error: ${err.message}`);
    process.exitCode = 1;
  });
}
