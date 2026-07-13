# Harness metrics — review-cascade measurement definitions

Canonical definitions for the review-harness launch metrics. Each metric has a stable
machine key (kebab-case), an owner, a formula, the source field(s) it reads, and the
review action a bad value triggers. The aggregator `scripts/harness-metrics.ts` (F11)
emits **exactly** the machine keys in the summary table below — one entry per key per
build, plus a rolling 30-day summary. A key with no supporting data in the current logs
is emitted with a `no-data` marker; a key whose formula the current log shape cannot
support is emitted with a `not-derivable` marker and the reason. Neither is ever faked.

Domain-neutral: metrics describe the review harness itself (reviewers, findings,
coordinator apply loop), not any consuming product. "Reviewer" means any review tier
(first-pass model reviewer, external-model reviewer, adjudicator). "Build" is one unit of
work identified by its slug. "Coordinator" is the orchestrator that emits the audit log.

## Source of truth

All metrics are computed from the coordinator audit log:
`tasks/review-logs/coordinator-decisions-<slug>-<timestamp>.jsonl`. One JSON object per
line records one adjudication decision. Observed field shapes vary across log generations;
the parser reads the union and tolerates absent fields. Fields the aggregator reads:

| Field | Also seen as | Meaning |
|---|---|---|
| `reviewer` | — | Which review tier produced the finding |
| `decision` | — | Adjudication outcome (see decision vocabulary below) |
| `round` | `iteration` | Review round / fix-loop iteration counter |
| `ts` | — | Decision timestamp (multiple formats normalized) |
| `finding` | `finding_id` | Finding identifier |
| `severity`, `risk_domain`, `triage`, `mode` | — | Finding classification (informational) |

**Decision vocabulary** (union across observed logs; parser normalizes):
`applied`, `accepted`, `accepted-as-wording-reconciliation` (apply-equivalent);
`rejected` (false-positive proxy); `acknowledged`; and the spec-defined
`quarantined`, `overridden_to_surface`, `already_applied_by_reviewer` (handled if present).

## Summary table (machine keys — F11 emits exactly these)

| Machine key | Owner | Source status |
|---|---|---|
| `findings-per-reviewer-per-build` | review coordinator | derivable |
| `fp-proxy-rejected-per-reviewer-per-build` | review coordinator | derivable |
| `fix-loop-iterations-per-build` | review coordinator | derivable |
| `rounds-per-build` | review coordinator | derivable |
| `quarantine-rate` | review coordinator | derivable |
| `auto-apply-success-rate` | review coordinator | derivable |
| `operator-override-rate` | review coordinator | not-derivable (no operator-override record) |
| `schema-validation-rate` | review coordinator | not-derivable (no `schema_validation_passed`) |
| `openai-repair-retry-rate` | review coordinator | not-derivable (no `repair_retry_attempted`) |
| `cumulative-revert-rate` | review coordinator | not-derivable (no revert/batch record) |
| `claude-first-pass-latency` | review coordinator | not-derivable (no latency field) |
| `claude-first-pass-token-cost` | review coordinator | not-derivable (no token field) |
| `openai-review-cost` | review coordinator | not-derivable (no cost field) |
| `suppression-false-negative-rate` | review coordinator | not-derivable (no suppression field; longitudinal) |
| `disagreement-rate` | review coordinator | not-derivable (no `disagreements[]` field) |

"Source status" is the status against the **currently observed** log shape. A field added
to future logs promotes a metric from `not-derivable` to `derivable` with no change to the
key set; the aggregator will emit real values automatically once the field appears.

## Derivable metrics

### `findings-per-reviewer-per-build`
- **Owner:** review coordinator.
- **Formula:** count of decision records grouped by `reviewer`, per build slug. Every log
  line is one finding decision.
- **Source field(s):** `reviewer` (one count per record).
- **Review action:** a reviewer with an outlier finding count relative to peers on the same
  build signals classification drift or a noisy prompt — audit that reviewer's prompt.

### `fp-proxy-rejected-per-reviewer-per-build`
- **Owner:** review coordinator.
- **Formula:** count of records with `decision == rejected`, grouped by `reviewer`, per
  build. A rejected reviewer finding is a false-positive proxy (the coordinator judged the
  finding wrong or inapplicable).
- **Source field(s):** `decision`, `reviewer`.
- **Review action:** a reviewer averaging more than ~2 rejected findings per build is
  over-flagging; tighten its eligibility criteria and prompt precision.

### `fix-loop-iterations-per-build`
- **Owner:** review coordinator.
- **Formula:** maximum `round`/`iteration` value across all records for the build (deepest
  fix-loop iteration reached). Null when no record carries a round.
- **Source field(s):** `round` (or `iteration`).
- **Review action:** builds that repeatedly reach high iteration counts indicate findings
  that interact or a prompt that re-raises resolved items — inspect the loop transcript.

### `rounds-per-build`
- **Owner:** review coordinator.
- **Formula:** count of distinct `round` values across the build's records (how many review
  rounds ran). Null when no record carries a round.
- **Source field(s):** `round` (or `iteration`).
- **Review action:** if the average exceeds ~5 rounds across a 10-build window, set a hard
  round cap and investigate prompt drift or insufficient prior-round dedupe.

### `quarantine-rate`
- **Owner:** review coordinator.
- **Formula:** `count(decision == quarantined) / total decision records`, per build and over
  the window. A legitimate `0` (no quarantines observed) is a real value, not `no-data`.
- **Source field(s):** `decision`.
- **Review action:** above ~2% of all reviewer calls indicates a contract, parser, or prompt
  problem; investigate the failing reviewer's output format.

### `auto-apply-success-rate`
- **Owner:** review coordinator.
- **Formula (pinned):**
  `count(records with acceptance_check_outcome == 'passed') /
   count(records with acceptance_check_outcome in {'passed','failed'})`.
- **Source field(s):** `acceptance_check_outcome` (emitted by `applyFindings.ts` on every
  `logDecision`: `'passed'` when a finding is applied or already applied by the reviewer,
  `'failed'` when an attempted apply or verification failed and was reverted, `'deferred'`
  when an apply was never attempted — gate-ineligible, suppressed, or production-DSN).
- **Row treatment (explicit):**
  - `'passed'` → counted in numerator and denominator.
  - `'failed'` → counted in denominator only.
  - `'deferred'` → excluded from **both** (an apply was never attempted).
  - missing field (legacy hand-written jsonl rows) → excluded from **both**.
  - rejected / skipped / any decision without the field → excluded from both.
- **Empty-corpus rule:** when the denominator is `0` the formula is still live — the metric is
  emitted with value `null` and the note `no auto-apply attempts in corpus`. It is **not**
  `not-derivable` (the field exists; the corpus simply has no attempts). The aggregator reports
  the attempted count (the denominator) alongside the rate in both the markdown and jsonl output.
- **Review action:** below 90% means the apply gate is admitting unsafe fixes; tighten reviewer
  `auto_apply_eligible` discipline.

## Not-derivable metrics (emitted with a marker + reason)

These are §16 launch metrics whose formula the **current** log shape cannot support. The key
is always emitted so the contract is stable and the gap is visible; the value is `null` with
a `not-derivable` status and the reason below. Do not fake a value.

### `operator-override-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** `count(operator rejects a coordinator-applied finding) /
  count(applied)`.
- **Blocker:** logged decisions are coordinator-side (apply/reject/acknowledge); no record
  represents an operator overriding a landed apply.
- **Review action when computable:** above 5% means reviewer eligibility is over-confident;
  tighten eligibility criteria.

### `schema-validation-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** `count(reviewer output passing schema on first try) /
  count(reviewer outputs)`.
- **Blocker:** no per-output schema-validation field in the current logs.
- **Review action when computable:** below 95% per reviewer indicates prompt drift; revise
  the prompt or schema.

### `openai-repair-retry-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** `count(external-reviewer calls that triggered a repair retry) /
  count(external-reviewer calls)`.
- **Blocker:** no `repair_retry_attempted` field present.
- **Review action when computable:** above 10% means output-format instructions are weak;
  tighten them. Above 25% pause and revert the prompt version.

### `cumulative-revert-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** `count(apply batches that pass individually but fail
  collectively and are reverted) / count(apply batches)`.
- **Blocker:** no revert / batch-outcome field present.
- **Review action when computable:** above 5% means findings interact; lower the batch-size
  cap or add file-level overlap detection.

### `claude-first-pass-latency`
- **Owner:** review coordinator.
- **Formula (target shape):** wall-clock seconds per artifact for the first-pass reviewers.
- **Blocker:** no latency / duration field recorded.
- **Review action when computable:** sustained excess over target means the multi-pass
  discipline is doing redundant reads; profile it.

### `claude-first-pass-token-cost`
- **Owner:** review coordinator.
- **Formula (target shape):** input + output tokens per artifact for the first-pass reviewers.
- **Blocker:** no token-count field recorded.
- **Review action when computable:** input over budget means context over-injection; audit
  the injected project-context size.

### `openai-review-cost`
- **Owner:** review coordinator.
- **Formula (target shape):** summed monetary cost across all external-review rounds per build.
- **Blocker:** no cost field recorded.
- **Review action when computable:** over budget means revisit the round cap and prompt
  efficiency.

### `suppression-false-negative-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** `count(suppressed findings later confirmed as real bugs) /
  count(suppressed findings)`.
- **Blocker:** no suppression field; inherently longitudinal (needs later confirmation).
- **Review action when computable:** any occurrence triggers immediate review of the
  suppression entry; mark it harmful and re-classify the pattern.

### `disagreement-rate`
- **Owner:** review coordinator.
- **Formula (target shape):** rate of cross-reviewer disagreements per build from the
  adjudication `disagreements[]` log.
- **Blocker:** no `disagreements[]` field in the current logs.
- **Review action when computable:** high disagreement between two reviewers indicates
  classification drift between their prompts.

## Report shape

The aggregator writes two files per run to `tasks/review-logs/metrics/`:
a dated markdown report and a `.jsonl` report. Both carry a corpus header (earliest/latest
source timestamp, processed file count, total records, malformed-lines-skipped count, and
the slugs found), one block per build slug, and a rolling 30-day summary anchored to the
latest source timestamp in the corpus (deterministic — independent of wall-clock run time).
Every machine key in the summary table appears in every build block and in the window
summary, with `value`, `status` (`ok` | `no-data` | `not-derivable`), and a `note`.
