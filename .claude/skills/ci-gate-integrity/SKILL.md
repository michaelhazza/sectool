---
name: ci-gate-integrity
description: Use when authoring or modifying CI gates, GitHub Actions workflows, grep/regex invariant checks, verification scripts, gate baselines, diff-based checks, or required-check configuration — and when consolidating workflows or migrating a check to a new engine. Every rule here is a documented way a green gate lied.
---

# CI gate integrity

Gates that cannot fail are the norm, not the exception: a gate is only as real as its ability to fail. Every pattern below is a documented way a passing gate concealed a live violation.

## Prove the gate can fail

Before trusting a new gate green, seed a violation and watch it go red. Additionally:

- Subprocess-delegating gates must convert subprocess errors to non-zero exits — printing to stderr while exiting 0 is a permanently green gate.
- Piped gate commands mask exit codes: `cmd 2>&1 | tail -30` exits with tail's status, so a red typecheck reads green and the pipeline advances. Capture to a file and check `$?` on the unpiped command, or `set -o pipefail` — for gates the exit code IS the result; a green from a piped gate is not evidence.
- Bash: `VAR="$(grep -c PAT FILE || echo 0)"` concatenates grep's own `0` with the fallback into `"0\n0"`, breaking integer tests. Use `|| true` + `${VAR:-0}`.
- Shell mechanics that kill gates silently: `local` outside a function aborts under `set -euo pipefail`; heredocs consume stdin; exit-code labels are not numeric severities. And `require()`/`node --eval` cannot load TS/ESM gate code — use `tsx`.
- Gate exit-code semantics depend on WHICH runner invokes the gate: shard-run gates may get baseline env vars and warn-level exit codes, while direct workflow steps fail on any non-zero with no baseline. Local reproduction must replicate the invoking runner's exact contract or bare runs report failures CI never sees (and vice versa).
- SQL-side gates: `jsonb_typeof` of an absent key is SQL NULL, not an error — a check on an optional key silently passes.
- Acceptance checks are positive assertions, never absence-of-error: "no failure log line" is indistinguishable from "the code never ran". Grep verification sections for "no error / should not appear" — each is a red flag.
- Parser failure in a scoring harness is a distinct outcome (`parse_error`), never a neutral passable score. Judge/rubric threshold-scale agreement for the harness itself: see the llm-integration skill.
- A gate script with no workflow step invoking it has zero enforcement value — wire it into CI in the same commit that authors it. Registering it in the runner manifest counts as wiring; authoring alone does not.

## Grep/regex gate pitfalls

- Multiline call sites: `[^)]*` stops at the first `)` and can't span newlines — collapse each file to one line before matching. A gate bypassable by adding a newline is not a gate. Grep gates also miss template-literal construction of the flagged pattern — prefer AST/symbol resolution over regex heuristics when the invariant is structural.
- `find -maxdepth` silently misses deeper subdirectories — verify the traversal depth against the actual tree before trusting a zero-findings run.
- Handle every formatting variant the language permits at the parse site: quoted AND unquoted object keys; both FK reference forms the ORM emits (schema-qualified and inline); anchored filenames with extension (`name\.(?:ts|js)`) so sibling prefixes don't false-positive.
- Identifier normalisation must match the runtime's: a gate that normalises hyphen/underscore while the runtime looks up byte-for-byte passes while every runtime lookup fails.
- Gate scope must match the invariant's claimed granularity: a file-level "some validation exists somewhere" scan is not "every handler validates". When a gate's name implies per-item coverage, read the implementation.
- Migration-scanning gates exclude down/rollback SQL (they legitimately re-CREATE dropped objects).
- Enumerate files inside Node with a glob library, not shell `find` piped to Node — Windows git-bash emits POSIX paths that `fs.existsSync` rejects, silently filtering every file (a verifier reporting zero findings on one OS and many on another is this).

## Diff-based gates

- Any step diffing against the PR base needs `fetch-depth: 0` (shallow checkout lacks the refs; the failure mode is an empty diff and a silent pass) and takes the base ref from the CI event, not a hardcoded branch.
- `workflow_dispatch` without an explicit ref input checks out the default branch — an empty diff range that trivially passes. Restrict diff gates to pull_request events or require a branch input; and verify `on.pull_request.types` covers every event the gate must observe.
- Diff-scoped review/gates miss contradictions between edited and unchanged sections of the same document; multi-section doc edits need a whole-file pass.

## Baselines and consolidation

- Gate baselines ("pass despite N pre-existing violations") are debt instruments: every entry gets an expiry or an ADR-level justification. Blind-regeneration launders drift; a counting-bug fix and its baseline ratchet are one atomic landing unit (a diff touching the verifier should touch the baseline, or neither).
- Consolidating workflows: the absorbed check inherits the host job's triggers/conditionals — the LEAST permissive set. Compare the deleted workflow's `on:` block side-by-side with the absorber's. Never label-gate safety-critical checks.
- Replacing one required check with N renamed checks: materialise the new names with a run, add as required, REMOVE the old name, re-run, then merge — or a phantom required check blocks every PR.
- Migrating a check to a new engine that carries a slice of the old logic: the original stays registered until the replacement proves equivalent (equivalence-diff old vs new outputs on first run); a promoted lint rule at `warn` without `--max-warnings=0` silently weakens enforcement.
- Silencing dead-code-detector findings via ignore lists satisfies numbers while destroying signal — route candidates to a triage backlog; keep entry lists to true entrypoints.
- A security gate keyed on a hand-maintained classification list rots silently while the gate keeps passing (permissive default on unknowns = false negatives in the one CI-visible defence). Validate the list against the canonical machine-readable source (e.g. migrations' CREATE POLICY statements) on every run and fail loudly and non-baselineably on drift — better, generate the set from the source.

## Actions/runner specifics (GitHub Actions)

- `actions/cache@v4` is restore+save combined: a step-level `if:` gates the restore only; the save runs unconditionally in post. Use the split restore/save forms for conditional saves; with matrix shards, pin the save to one deterministic shard.
- Include the lockfile in tool caches' keys even when not strictly required — conservative invalidation beats a silent stale hit.
- Don't assume `jq` exists on runners; in a Node repo, shell into `node` for JSON.
- Tight time budgets go on the harness STEP, generous ceilings on the JOB — a tight job timeout fails flakily on cold caches, and a flaky gate is worse than none.
- Tools deriving state from git history return spurious results in shallow clones: probe `git rev-parse --is-shallow-repository` and degrade to warning there.
- Timing-capture steps are scaffolding — remove them once the baseline is recorded.
- Stale compiled `.js` siblings of `.ts` sources can be resolved by the test runner instead of the source ("my change has no effect"): check `git status --ignored` when changes mysteriously don't take.
- PRs opened with the default `GITHUB_TOKEN` do not trigger `on: pull_request` workflows — automation rails that open "review-gated" PRs with it ship PRs CI never validated, with no visible error. Use a GitHub App token or PAT for the push + PR-open step.
- `schedule` events carry no `workflow_dispatch` inputs — "cron sets the input" is mechanically impossible. Derive mode from the event: `(github.event_name == 'workflow_dispatch') && inputs.flag`, with the scheduled run taking the live path.

## Metrics and detector gates

- A silence detector must exclude its own emitted incidents from trigger and proof-of-life counts or it self-validates; zero-activity alarms need minimum-population thresholds.
- Counting predicates bind to committed/terminal status; synthetic/suppressed outcomes are excluded from aggregates that mean real events; rollup writers match the consumer's exact WHERE key tuple.
- Re-surfacing detectors need material-change gates (relative threshold AND absolute floor), dismiss cooldowns with severity-escalation bypass, and two-consecutive-mismatch confirmation before acting.
- Never infer entity deletion from absence in incremental poll results — pagination truncation hides live entities.
