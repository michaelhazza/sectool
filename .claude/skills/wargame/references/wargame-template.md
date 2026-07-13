# Wargame artifact template

Copy this skeleton for every wargame. Frontmatter is machine-readable; body sections appear in exactly this order. Observations and triggers are checkable predicates wherever possible (exit code, HTTP status, file exists, string present in output). Prose-only observations are allowed but flagged `[JUDGEMENT]` so the executor knows deterministic matching is unavailable.

## Frontmatter

```yaml
---
mission: <slug>
subject: <repo path, URL, or system description>
generated_by: <planner model>
target_executor: <executor model, or "any">
repo_commit: <sha, or n/a for non-repo subjects>
env_fingerprint: <OS / runtime versions relevant to the mission, or n/a>
generated_at: <ISO date>
risk_ceiling: <highest-impact action class this wargame may instruct, e.g. "prod schema mutation">
branch_count: <n, must be 25 or fewer>
status: draft | red-teamed | approved | stale
entry_test: <score 0-5 with one clause per mark claimed; note operator override if any>
---
```

`status` starts at `draft`. It becomes `red-teamed` after the red-team pass is recorded, `approved` when all 10 success criteria pass (see `success-criteria.md`), and `stale` when any fingerprint no longer matches reality. Only `approved` executes.

## Body sections, in order

### 1. Recon Summary

What was inspected, read-only, before any move was written. Every claim carries a citation: `file:line`, the command and its output, or a URL. Claims with no citation are labelled `SPECULATIVE` inline.

### 2. Assumptions Ledger

| # | Assumption | Status | Settling check |
|---|---|---|---|
| A-1 | <assumption> | RECON NEEDED / RESOLVED (cite evidence) | <exact command or check that settles it> |
| A-2 | {{PLACEHOLDER_NAME}} = ? | OPERATOR INPUT | <who supplies it and where it is used> |

Placeholders are never filled by planner or executor. RECON NEEDED items name the exact check; "investigate further" is not a check.

### 3. Moves

Numbered, in execution order. A non-risky move records Risk marks, Intent, Action, Expected observation. A risky move (any entry-test mark at move level) adds Failure branches and, where relevant, a Fork trigger.

Worked example of a risky move:

```markdown
### Move 3: Apply the schema migration
Risk marks: irreversible (DDL on prod), shared-state. RISKY.
Intent: bring the production schema to v0042.
Action: `npm run db:migrate -- --to 0042` from the release runner.
Expected observation: exit code 0; `SELECT max(version) FROM schema_migrations`
returns 0042. [deterministic]

Failure branch 3a (most likely):
  Signal: exit code 1, stderr contains "lock timeout". [deterministic]
  Cause: long-running transaction holding a table lock (recon: pg_stat_activity
  snapshot showed a 40-minute analytics query on this table).
  Counter-move: wait 120 seconds, retry once. On second failure, trigger abort A2.
  Test ID: WG-<mission>-T3

Failure branch 3b (most damaging):
  Signal: exit code 0 but the version query returns 0041. [deterministic]
  Cause: migration recorded as applied without executing (split transaction).
  Counter-move: STOP. Do not retry. Trigger abort A1 (schema state ambiguous).
  Test ID: WG-<mission>-T4

Fork trigger: if {{TRAFFIC_WINDOW}} = "business hours", insert Move 3.5
(enable maintenance mode) before this move. [deterministic on the placeholder value]
```

Branch order within a move is the executor's matching order: deterministic signals first, `[JUDGEMENT]` signals last. Every fork's implicit default, when nothing matches, is the OFF-MAP rule in `executor-contract.md`: stop, and on a risky move escalate.

### 4. Abort Conditions

| ID | Trigger | On trigger, report |
|---|---|---|
| A1 | <specific observable condition> | <state to capture, what was and was not completed> |
| A2 | ... | ... |

Abort means stop and report. Never "try one more thing". This section is mandatory; a wargame without it is invalid and must not be emitted.

### 5. Verification Runs

| ID | Command / check | Pass definition |
|---|---|---|
| V1 | <command> | <exact expected output or state> |
| V2 [FORCED-FAILURE] | <check that must be able to fail> | <what failing correctly looks like> |

At least one run is a forced-failure check: it proves the verification can detect a bad state, not just confirm a good one.

### 6. Test Bridge Index

| Test ID | Branch | Forced test (one line) | Status |
|---|---|---|---|
| WG-<mission>-T3 | 3a | Hold a lock, run the migration, assert the retry-then-abort path | described / authored / passing |

Every failure branch appears here. "Described" is the minimum to reach `approved`; authoring is a follow-up unless the caller requires more.

### 7. Red-team Record

| Attack | Result | Patch |
|---|---|---|
| <path tried to defeat the wargame> | held / defeated it | <patch applied, or n/a> |

At least one successful attack with its patch is recorded before status moves past `red-teamed`. A red-team pass that found nothing is a failed red-team pass; attack harder or record why the artifact genuinely resisted.
