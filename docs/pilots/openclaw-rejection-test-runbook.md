# OpenClaw disposable-repo rejection test — operator runbook

Reference document for the live security gate at spec `framework-runtime-neutral-v3` §12.B Chunk B1. This gate proves — with real GitHub, not prompt text — that the dedicated OpenClaw builder identity cannot push, force-push or delete the default branch, and cannot merge a PR (whether OpenClaw-authored or Claude-authored) on the strength of an agent-identity approval. It must pass before the OpenClaw Builder adapter (B2) or its coordinator dispatch (B3) are enabled.

Companion files: `scripts/pilot/rejection-test.sh` (the live script), `scripts/pilot/classify-rejection.mjs` (the pure pass/fail/INCONCLUSIVE classifier), `scripts/pilot/classify-rejection.test.mjs` (its offline unit test — this is what CI runs; the live script itself is never invoked by CI). The invocation contract governing how a Claude Code coordinator later dispatches OpenClaw as a builder runtime, and the coordinator dispatch path itself, are covered in this pilot's later chunks — not in this runbook, which is scoped to the rejection test only.

---

## Prerequisites (spec §9, Decision 8)

All of the following must exist **before** this test is run. If any is missing, the script fails closed with `INCONCLUSIVE` rather than attempting a partial run.

1. **A disposable pilot GitHub repository.** Never run this against a production repository — several probes deliberately attempt destructive actions (direct push, force-push, branch deletion) against its default branch, and the whole point of the test is to prove GitHub rejects them.
2. **The dedicated OpenClaw builder identity/token** (per-consumer configuration; the identity is `myatdevelopment` for this project — spec §9). Branch-write and PR rights only: no Admin role, no ruleset bypass, never used by Claude sessions.
3. **The default-branch ruleset + CODEOWNERS installed on the pilot repo**, per spec §9 "Required default-branch rules": restrict updates and deletion, require a PR plus one code-owner approval after the latest push, block force pushes, and never grant the builder identity a bypass. CODEOWNERS assigns all paths to Michael, so only Michael's approval satisfies the approval requirement. Consumer-facing templates for both are shipped separately (`templates/CODEOWNERS.template`, `templates/default-branch-ruleset.json`).

   **Operator note:** if the ruleset's required status check is configured, pin it by `integration_id`, not just by context name. GitHub matches a required status check on context-name string alone; if any non-trusted app or workflow can post a check with the same context name, it can satisfy the requirement without the trusted check having run at all. Pinning the integration id closes that gap.
4. **`gh` and `git` on `PATH`, both usable non-interactively.**

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `OPENCLAW_BUILDER_TOKEN` | Yes (or `MYATDEVELOPMENT_TOKEN`) | GitHub token for the dedicated builder identity. Never committed, never printed in full by the script — read from the environment only. |
| `MYATDEVELOPMENT_TOKEN` | Alias | Accepted as a synonym for `OPENCLAW_BUILDER_TOKEN` for this project's per-consumer identity name. |
| `OPENCLAW_PILOT_REPO` | Yes | `owner/repo` of the disposable pilot repository. |
| `OPENCLAW_DEFAULT_BRANCH` | No | Default branch name to probe. Defaults to `main`. |
| `OPENCLAW_REJECTION_LOG_FILE` | No | Path for the JSON-lines probe-result log. Defaults to a fresh file under the system temp directory; the script prints the path it used. |

The ambient `gh` authentication the operator's own shell already carries (Michael's/Claude's administrator credential) is used for the one probe that needs a genuinely non-builder-authored PR (probe 6b) — the script never asks for a separate variable for that; it simply does not set `GH_TOKEN` for that step.

## Running the test

```bash
export OPENCLAW_BUILDER_TOKEN=***      # never echo this
export OPENCLAW_PILOT_REPO=owner/disposable-pilot-repo
bash scripts/pilot/rejection-test.sh
```

If either required variable is unset, the script prints `prerequisites missing — cannot run; INCONCLUSIVE` and exits non-zero **without making any `gh`/`git` call against GitHub.**

## What it does

The script runs seven probes against the pilot repo, as the builder identity (spec §13.4/§13.5, §14):

1. **Positive control** — push a feature branch, open/update a PR. Expected: allowed.
2. **Direct push to default** — expected: rejected.
3. **Force-push to default** — expected: rejected.
4. **Delete the default branch** — expected: rejected.
5. **Merge the open PR with no code-owner approval** — expected: rejected (not mergeable).
6. **Agent-identity approval does not satisfy the code-owner requirement**, tested against BOTH:
   - the OpenClaw-authored PR from probe 1, and
   - a second, Claude-authored PR (opened under the operator's own ambient credential, then approved by the builder token) — expected: rejected in both cases.

Each probe's result (`name`, `action`, `expected`, `observed`, optional `detail`) is appended as one JSON line to the log file. The script never contains classification logic — it calls `node scripts/pilot/classify-rejection.mjs` on the completed log, piping the JSON lines to stdin, and prints that module's JSON verdict.

## Reading the verdict

The script's stdout is the classifier's JSON output:

```json
{
  "verdict": "PASS",
  "reasons": ["all probes met their expected outcome"]
}
```

- **`PASS`** (exit 0) — every probe met its expected outcome. GitHub is proven to reject the builder identity's direct/force push, deletion and unapproved merge, and an agent approval does not satisfy the code-owner rule on either PR. The Phase-B gate is open — B2/B3 may proceed.
- **`FAIL`** (exit 1) — at least one forbidden action was observed **allowed**, or the positive control was observed **rejected**. `reasons[]` names the exact failing action. **STOP: quarantine B2 and B3** (plan Chunk B1 kill criteria) and record the failure as a blocker; the ruleset/CODEOWNERS configuration needs correction before retrying.
- **`INCONCLUSIVE`** (exit 2) — at least one probe errored (auth/network failure, or the run could not even start) rather than producing a definitive rejected/allowed observation. Treated identically to `FAIL` for gating purposes: **it blocks Phase B**. A `FAIL` verdict always takes precedence over an `INCONCLUSIVE` one when a run produces both, because a proven security failure is a stronger signal than an unproven probe.

## Evidence and cleanup

The JSON-lines probe log is preserved at the path the script prints (`rejection-test: probe log preserved at <path>`) and is the acceptance-evidence artifact for spec §13 rows 4 and 5. Copy it into the build's evidence record for the run (this framework repo does not track pilot run logs itself — the build directory that governs this pilot lives in the consuming project's `tasks/builds/<slug>/` tree, outside this repo).

The script leaves behind probe branches and PRs on the pilot repository (`openclaw-rejection-probe-*`, `claude-rejection-probe-*`) as a deliberate side effect of exercising real push/PR/merge/approval paths. Because the pilot repo is disposable, the operator closes and deletes these probe branches/PRs after reviewing the verdict rather than the script doing so automatically — leaving them intact until reviewed preserves the evidence trail in case a probe's observation needs to be re-examined against the GitHub UI.
