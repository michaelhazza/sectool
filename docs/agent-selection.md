# Agent Selection — which agent or command, when

One page mapping operator intent to the right entry point. Full caller contracts live in each `.claude/agents/<name>.md` — read the agent file before invoking. Adoption-time pitfalls are in `ADAPT.md` § 13; this page covers **runtime** selection.

## New feature

| Size | Signal | Entry point |
|------|--------|-------------|
| Trivial | Single file, obvious change, no design decisions | Implement directly in the main session |
| Standard | 2–4 files, clear approach, no new patterns | Implement directly, then `spec-conformance` (if spec-driven) and `pr-reviewer` |
| Significant | Multiple domains, design decisions, or new patterns | `architect: <description>` first, then implement, then the graded review posture |
| Major / full pipeline | New subsystem, cross-cutting, or you want the whole governed flow | Phase 1: `spec-coordinator: <brief>` → Phase 2: `launch feature coordinator` → Phase 3: `launch finalisation` |

If you're unsure between Standard and Significant, classify up — the review overhead is cheaper than an unreviewed design decision.

## Bug

| Situation | Entry point |
|-----------|-------------|
| Tracked GitHub issue, normal urgency | `bug-fixer: <issue-number>` (fix mode → PR); `bug-fixer: done <N>` to finalise |
| Time-critical (broken main, prod outage fix) | `hotfix: <what's broken>` — bypasses the pipeline, keeps the minimum review bar |
| Production incident needing coordination (SEV, timeline, post-mortem) | `incident-commander: ...` — coordinates the response; `hotfix` fixes the fire |

## Review

| You want | Invoke |
|----------|--------|
| Independent review of changes just made | `pr-reviewer: review the changes I just made to <files>` |
| Verify code matches its spec | `spec-conformance: verify the current branch against its spec` |
| Threat-model hunt (tenant isolation, auth, races, injection) | `adversarial-reviewer: hunt holes in <files>` (read-only, advisory) |
| Codex second opinion with adjudication | `dual-reviewer: <brief description>` (local Codex CLI required) |
| Spec / plan review | `spec-reviewer: <spec path>`, `claude-spec-review: <spec path>`, `claude-plan-review: <plan path>` |
| ChatGPT-tier review (PR / spec / plan) | `chatgpt-pr-review` / `chatgpt-spec-review` / `chatgpt-plan-review` — mode `manual` / `automated` / `parallel` |

The coordinators auto-invoke the right reviewers per task class — you only invoke these manually outside the pipeline.

## Maintenance

| You want | Invoke |
|----------|--------|
| Repo sweep of accumulated working files | `/cleanfiles` |
| Bump the framework submodule + sync + migrations | `/claudeupdate` |
| Diagnose framework health / drift | `/framework-doctor` (deep) or `validate-setup` (read-only checks) |
| Codebase audit (cleanup or production-readiness) | `audit-runner: hotspot <area>` — runs INLINE; default to Hotspot mode |
| Fix all failing CI gates at the root | `/fix-ci-gate-debt` |

## Ideas and mockups

- Idea surfaced mid-session: `triage-agent: idea: <description>` — capture, don't implement. Triage later with `triage-agent: let's triage`.
- Any "mock up / create mockups / clickable prototype" request: the main session adopts `mockup-coordinator` (never dispatch `mockup-designer` alone — the reviewer loop is what enforces grounding and simplicity).

## Runtime FAQ

(Adoption-time pitfalls — settings merge, placeholder substitution, profile pruning — are `ADAPT.md` § 13. These are the runtime ones.)

- **Coordinators run INLINE.** `spec-coordinator`, `feature-coordinator`, `finalisation-coordinator`, `mockup-coordinator`, `incident-commander`, and `audit-runner` are playbooks the main session adopts — never dispatch them via the Agent tool. The runtime blocks sub-agents from dispatching further sub-agents, so a dispatched coordinator breaks at its first delegation.
- **Review-mode resolution.** ChatGPT review mode resolves: explicit operator phrase → `.claude/session-state/review-mode` → `CHATGPT_REVIEW_DEFAULT_MODE` env var → hard default `manual`. Full rules: `references/review-mode-resolution.md`. "Missing OPENAI_API_KEY" usually means `.env` wasn't sourced, not that the key is absent.
- **Where specs live.** `tasks/builds/{slug}/spec.md` is the canonical path the whole pipeline keys on (plan: `plan.md`, progress: `progress.md`, handoff: `handoff.md` in the same directory). Stubs in `tasks/builds/_example/` show the expected shapes.
- **Test gates are CI-only.** Full suites do not run locally; local verification is lint / typecheck / build / targeted test files. Single source of truth: `references/test-gate-policy.md`. The one exception is finalisation's G5 CI-parity gate.
- **Iteration caps are real.** Review loops have lifetime caps per artifact (see `references/iteration-caps.md`) — when a cap is hit, the loop ends and remaining findings route to the backlog, not to another round.
