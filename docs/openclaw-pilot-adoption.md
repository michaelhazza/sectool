# OpenClaw pilot adoption — consumer walkthrough

How a consumer repository adopts the OpenClaw sequential-Builder pilot (spec `framework-runtime-neutral-v3` §7, §9, §12.B–C). Four steps: create the dedicated builder identity, install the CODEOWNERS + ruleset templates, run the disposable-repo rejection test, then run the Claude-only regression that proves nothing already working changed.

Role boundaries for the runtimes involved are recorded once in [`references/runtime-roles.md`](../references/runtime-roles.md) — this doc does not restate them. The invocation path a Claude Code coordinator uses to dispatch OpenClaw as a Builder, and the coordinator's dispatch playbook changes, ship in this pilot's adapter and dispatch chunks; consult those once they land on your integrated branch. This walkthrough covers identity, access-control and gate-verification setup only.

---

## Step 1 — create the dedicated OpenClaw builder identity

Create a GitHub account or machine identity distinct from the operator's own account and distinct from any Claude/administrator credential (spec §9 "Identities"). This project's own identity is named `myatdevelopment`; name yours per your own convention.

Grant it:

- Repository **write** access (branch push, PR open/update) on the target repo.
- **No Admin role.**
- **No ruleset bypass** of any kind.
- Never share this identity's token with a Claude session, and never use Michael's/the operator's own credential for OpenClaw dispatch — the whole pilot security model depends on these staying separate (spec §9 "Permission separation").

Store its token in your own secrets manager. Never commit it. The rejection test in Step 3 reads it from the environment only (`OPENCLAW_BUILDER_TOKEN`, or a per-consumer alias — see the runbook linked there).

## Step 2 — install CODEOWNERS and the default-branch ruleset

Two templates ship with the framework:

- [`templates/CODEOWNERS.template`](../templates/CODEOWNERS.template) — copy to `CODEOWNERS` at your repository root (or `.github/CODEOWNERS`), replace `{{OPERATOR_GITHUB_HANDLE}}` with your own GitHub username, and commit it to the default branch. GitHub only honours CODEOWNERS from the default branch's HEAD.
- [`templates/default-branch-ruleset.json`](../templates/default-branch-ruleset.json) — a GitHub repository ruleset payload matching spec §9 "Required default-branch rules": restrict updates and deletion, require a pull request with one code-owner approval **after the latest push**, require review from Code Owners, require conversation resolution, require status checks when available, and block force pushes. `bypass_actors` stays empty — never add the builder identity as a bypass actor. Direct updates to the default branch are restricted by the required-pull-request rule (no ref update lands except through an approved PR); the standalone GitHub `update` ("Restrict updates") rule is intentionally **omitted** because, with an empty `bypass_actors` list, it blocks the PR-merge ref update itself and would leave the default branch unmergeable for everyone including the operator. Do not add it.

Before installing, fill in the placeholders:

| Placeholder | Replace with |
|---|---|
| `{{RULESET_NAME}}` | Any descriptive name, e.g. `"Default branch protection"` |
| `{{CI_STATUS_CHECK_NAME}}` | The exact context/check name your CI reports (e.g. your `ci.yml` job name). If your repo has no CI status check configured yet, remove the `required_status_checks` rule entry rather than leaving a placeholder value — an unfulfillable check name blocks every PR. |
| `integration_id` (defaults to `0`) | Context-name matching alone is spoofable — any app or workflow that posts a check with the same context name can satisfy the requirement without your trusted check having run (see the runbook's Operator note). Replace the `0` sentinel with your CI app's numeric GitHub App integration id. For GitHub Actions, that id is `15368`. |

Install the ruleset via the GitHub UI (Settings → Rules → Rulesets → New branch ruleset → paste the JSON under "Import a ruleset") or via `gh api repos/{owner}/{repo}/rulesets -X POST --input templates/default-branch-ruleset.json` once the placeholders are filled.

## Step 3 — run the disposable-repo rejection test

This is the live security gate (spec §12.B Chunk B1) that proves — with real GitHub, not prompt text — that the builder identity cannot push, force-push or delete the default branch, and that an agent-identity approval never satisfies the code-owner requirement.

Full prerequisites, environment variables and probe descriptions are in the runbook: [`docs/pilots/openclaw-rejection-test-runbook.md`](./pilots/openclaw-rejection-test-runbook.md). In short:

```bash
export OPENCLAW_BUILDER_TOKEN=***      # never echo this
export OPENCLAW_PILOT_REPO=owner/disposable-pilot-repo
bash scripts/pilot/rejection-test.sh
```

Run this against a **disposable** repository, never production — several probes deliberately attempt destructive actions against the default branch to confirm GitHub rejects them.

Read the verdict:

- **`PASS`** — every probe met its expected outcome. Your CODEOWNERS + ruleset configuration is proven correct; the OpenClaw Builder adapter and coordinator dispatch may be enabled once they ship.
- **`FAIL`** — at least one forbidden action was observed allowed, or the positive control was rejected. Fix the ruleset/CODEOWNERS configuration (return to Step 2) and rerun.
- **`INCONCLUSIVE`** — a probe errored (auth/network) rather than producing a definitive observation. Treated the same as `FAIL` for gating purposes: do not enable OpenClaw dispatch until you get a clean `PASS`.

Keep the preserved probe log as your acceptance-evidence artifact (spec §13 rows 4 and 5).

## Step 4 — Claude-only regression on an existing consumer

Spec §12.C requires proving that everything a Claude-only consumer already relies on keeps working unchanged once the runtime-neutral contracts (packet schemas, additive `build-status` fields, the transition validator, recovery checks) are on that consumer's synced framework version. Run this on a real, already-adopted consumer repository — not the disposable pilot repo from Step 3.

1. Sync the consumer to the framework version that ships this pilot (`git submodule update --remote .claude-framework && node .claude-framework/sync.js`), same as any routine framework upgrade.
2. Pick one Trivial or Standard task already in that consumer's backlog and run it end to end through the normal Claude-only pipeline: `spec-coordinator` (if spec-driven) → `feature-coordinator` (plan, build, review) → `finalisation-coordinator` (G4/G5, `chatgpt-pr-review`, `MERGE_READY`, merge). Do not invoke any OpenClaw dispatch path — this run stays 100% Claude Code end to end.
3. Confirm the merge lands and writes `MERGED` in the consumer's `status.json` exactly as it did before this pilot's changes synced — no `runtime`/`role` fields are required on a Claude-only run (they are additive-optional per `schemas/CHANGELOG.md`), and their absence must not fail validation.
4. Confirm the consumer's own CI (`npm test`, lint, typecheck, build) stays green throughout, with no new failures attributable to the synced framework files.
5. Record the run (task, branch, PR link, merge commit) as the acceptance-evidence artifact for spec §13 row 11 ("Claude-only consumers pass regressions").

A regression here means: STOP, do not proceed with any further OpenClaw rollout, and route the failure back through this pilot's build as a blocker.
