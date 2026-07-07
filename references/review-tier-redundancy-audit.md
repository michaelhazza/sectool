# Review-tier redundancy audit — runbook

How to measure whether a review tier earns its keep, using the method that
retired `reality-checker` in 2.21.0. Run this before cutting or collapsing any
tier — never cut on intuition. Owner: the operator, roughly quarterly or after
every ~10 merged builds.

## The question

For each review tier in the cascade — claude-spec-review / spec-reviewer
(Codex) / chatgpt-spec-review on specs; claude-plan-review /
chatgpt-plan-review on plans; pr-reviewer / adversarial-reviewer /
dual-reviewer / chatgpt-pr-review on code — how many **net-new, accepted,
non-trivial** findings did it contribute that no earlier tier had already
surfaced?

## Data sources

- `tasks/review-logs/*.md` and `*.json` — per-session findings, verdicts,
  triage decisions (`[ACCEPT]`/`[REJECT]` logs, applied/surfaced lists).
- `tasks/review-logs/_index.jsonl` — structured per-finding records with
  fingerprints (dedup key).
- `tasks/review-logs/coordinator-decisions-*.jsonl` — applyFindings audit
  trail (applied vs surfaced vs quarantined).
- Git history — which findings produced commits.

## Procedure

1. **Pick the window:** the last N merged builds (N ≥ 5 for signal).
2. **Per build, per tier, count:**
   - `raised` — findings the tier emitted.
   - `net_new` — raised findings whose fingerprint (or file+issue match) does
     NOT appear in any EARLIER tier's log for the same artifact. Order:
     claude-* → Codex → ChatGPT for specs/plans; spec-conformance →
     adversarial → pr-reviewer → dual-reviewer → chatgpt-pr-review for code.
   - `accepted` — net-new findings that were applied (commit exists) or
     operator-approved.
   - `blocking_caught` — accepted findings that were severity high/critical.
3. **Tabulate** per tier across the window:
   `tier | builds | raised | net_new | accepted | blocking_caught | est. minutes/build`.
4. **Decide** against the thresholds below and record the outcome as an ADR
   (the 2.21.0 retirement is the precedent — see `.claude/agents/_retired/`).

## Decision thresholds

- `accepted / builds < 0.5` AND `blocking_caught == 0` across ≥ 8 builds →
  **retire or make conditional** (e.g. run only on Significant/Major, or only
  when the earlier tier's verdict was not APPROVED).
- Tier's `net_new` is dominated by one finding category → keep the category
  as a targeted check in an earlier tier; retire the tier.
- Two tiers' accepted sets overlap > 70 % → merge them (keep the cheaper one).
- Anything else → keep, re-measure next window.

## Notes

- Count what was ACCEPTED, not what was raised — a tier that raises 20
  rejected nitpicks per build is negative-value.
- Time cost matters: a manual ChatGPT-web round costs operator minutes; an
  automated round costs API tokens; a Claude tier costs context + latency.
  Note the cost column even if approximate.
- The measurement is cheap to run as a Claude session: point it at
  `tasks/review-logs/` with this file and ask for the table.
