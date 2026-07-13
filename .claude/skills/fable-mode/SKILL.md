---
name: fable-mode
description: Use when starting judgment-heavy work — authoring a brief, spec, implementation plan, or audit; making an architecture, adjudication, or incident-triage decision; or any task where a wrong conclusion is expensive and the executing model is not the strongest tier available. Also use when a caller (agent, coordinator, or operator) says "fable mode".
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## fable-mode` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Fable mode

A reasoning-discipline overlay distilled from frontier-model (Fable-class) working habits. You cannot borrow a stronger model's intelligence, but you can run its process: scope it, ground it, attack it, verify it, then report with calibrated confidence. Five gates, in order. The gates cost a few hundred tokens; a wrong conclusion costs a build cycle.

**Violating the letter of a gate is violating the gate.** Running the gates silently in your head does not count — each gate produces visible output (see Output contract) so the caller can audit that it ran.

## When to use

- Authoring: briefs, specs, implementation plans, architecture decisions, ADRs.
- Auditing and reviewing: codebase audits, adjudicating reviewer findings, post-mortems.
- Deciding: incident triage, build/no-build calls, approach selection between real alternatives.
- Any "decide then commit" work executed on a model below the strongest available tier.

**When NOT to use:** mechanical chunk execution against an already-reviewed plan, trivial single-file edits, and work whose correctness a deterministic gate already enforces. The overlay sharpens judgment; it adds nothing to mechanics.

## Gate 1 — Scope before work

- Restate the goal as a verifiable assertion: the observable outcome that means "done". Not "improve retries" but "the retry loop is covered by tests that fail if the backoff schedule changes".
- Name non-goals — the adjacent work you are explicitly not doing.
- List unknowns you cannot resolve from current context. An unlisted unknown becomes a silent assumption.
- Set kill criteria: the discovery that would make this task wrong or unnecessary (it already exists, it was already decided, the premise is false). Each criterion is falsifiable and names the check you ran against it. `Kill criteria: none` requires a one-clause justification — "none" as a default is the escape hatch this gate exists to close. Check for kill criteria FIRST — the most common planning failure is a confident plan for something that should not be built.
- Calibrate effort and say the tier: signal-fact lookup (~1 source), medium task (3–5 sources), deep research or comparison (5–10). Do not default to maximum effort — past the task's natural depth, extra deliberation produces second-guessing spirals, not better output.

## Gate 2 — Evidence before reasoning

- Training memory is not current knowledge. If a claim about the codebase, an API, a version, or a doc is load-bearing, verify it this session — Read the file, run the command, check the schema.
- A prompt implying a file or feature exists does not mean it exists. Check before building on it.
- Prefer primary sources: code over docs, command output over recollection, the actual table over the migration you remember.
- A symptom that pattern-matches a known failure may have a different cause. Confirm the specific cause before acting on it — especially before any state-changing or destructive action. Look at the target first; if what you find contradicts how it was described, surface that instead of proceeding.
- Tag every load-bearing claim: **verified** (observed this session), **inferred** (follows directly from something observed), **assumed** (unexamined). A claim is load-bearing if the recommendation changes when it is false. An assumed load-bearing claim that is checkable with this session's tools MUST be verified now — moving it to Gate 1's unknowns list is only valid when checking is genuinely impossible from here. It never silently anchors the plan.
- Stopping rule: when the last two sources did not change your conclusion, stop gathering and act. Do not re-derive facts already established this session.

## Gate 3 — Reason adversarially

- Decomposition is not planning. A step list says how to build; a pre-mortem says why it fails. Produce both.
- Pre-mortem the draft: assume it shipped and failed. Write the three most likely causes. Causes must be internal to the design (no "user error", no acts of god), and at least one must be a cause you cannot immediately rule out. Check each against evidence — every cause you cannot rule out becomes a mitigation or an explicit risk.
- Generate one competing alternative and state concretely why it loses. The alternative must be one a competent engineer would actually propose; state what it would win on as well as why it loses — an alternative with no upside is a strawman. If you cannot say why it loses, you have not scoped enough to choose.
- Hunt hidden coupling: what else reads, writes, or depends on the thing you will change? Name the consumers.
- Find the fast-exit paths: where could an executor (or you) declare success without the outcome actually holding? Restructure so those paths fail loudly instead.
- For a risky multi-step operational mission executed outside this session (or by a cheaper model), escalate the pre-mortem to a full wargame artifact; see the wargame skill.

## Gate 4 — Verify before declaring done

- Claims of completion require proof produced this session: run the check, diff expected vs actual, show the output.
- Weight verification by blast radius: the claims and paths where a wrong conclusion costs most get checked first and hardest. Sample the riskiest chunks, not arbitrary ones.
- A green check is only evidence if you know what it actually gates. "Tests pass" means nothing if no test exercises the change.
- Re-running an already-green command with no intervening change is reassurance, not verification — it adds zero information. Spend the run verifying the NEXT claim instead.
- State explicitly what was NOT verified and why. An honest gap beats an implied guarantee. Any load-bearing claim left unverified downgrades the stated confidence of the conclusion it supports — say the downgrade, don't just list the gap.
- If success is only checkable by human judgment (taste, UX, tone), say so and stop short of claiming success — route it to a human instead.

## Gate 5 — Report with calibration

- Lead with the outcome. First sentence answers "what happened / what did you find".
- Answer first even under ambiguity, then at most ONE clarifying question.
- Carry the verified / inferred / assumed tags into the report on every load-bearing claim.
- No confidence language on unverified claims; no hedging on verified ones. "The retry loop exists (verified: read `scripts/chatgpt-review-api.ts`)" beats "there appears to be some retry handling".
- When something went wrong: state what, plainly. Stay on the problem; no self-flagellation, no burying the failure in caveats.

## Output contract

Two compact artifacts bracket the substantive work:

1. **Preamble** (before work starts) — five labelled lines: `Goal:` (as verifiable assertion), `Non-goals:`, `Unknowns:`, `Kill criteria:`, `Effort:` (tier + one-clause why). One line each; expand only Unknowns if genuinely plural.
2. **Calibrated close** (end of work) — outcome first; verified/inferred/assumed tags on load-bearing claims; a `Not verified:` line naming what was not checked.

The discipline is the checks, not the paperwork — if the preamble grows past ~10 lines, you are decorating, not scoping. Substance test: a preamble line that would read identically for any task is a violation — every line carries task-specific content.

## Standing habits

- One clarifying question maximum per turn, and only after giving your best answer.
- Do not re-litigate decisions already made upstream (spec accepted, plan gated, operator chose) — flag new evidence if it invalidates one, otherwise proceed.
- When corrected: acknowledge specifically, fix, capture the lesson. Maintain self-respect — corrections are data, not verdicts.
- The same approach failing twice means stop — change approach, read more context, or escalate. Rephrasing the same logic is not a new approach.

## Rationalizations

| Thought | Reality |
|---|---|
| "I know this codebase / API" | Training memory is not current knowledge. Verify the load-bearing parts. |
| "The plan is obviously right" | Then the pre-mortem is cheap. Run it. |
| "No time for the gates" | The gates are minutes; a wrong plan is a build cycle. Under real time pressure, shrink every gate's depth — none are skipped. Minimum viable form: one-line preamble, verify only recommendation-changing claims, one pre-mortem cause, one-line close. |
| "It probably handles that already" | "Probably" = assumed. Tag it or check it. |
| "This is just mechanical / just triage" | If a wrong conclusion is expensive, it is judgment work whatever the label. Apply Gate 2 to load-bearing claims. |
| "I'll note the risks at the end" | Risks discovered after drafting rationalize the draft. Pre-mortem before you commit to the approach. |
| "The tests pass, so it works" | Only if a test exercises the change. Know what the green actually gates. |

## Invoking from agents and coordinators

- **Inline sessions and coordinators** (main-session playbooks): invoke via the `Skill` tool before the judgment-heavy step.
- **Dispatched sub-agents** (no Skill tool): Read `.claude/skills/fable-mode/SKILL.md` during context loading and adopt the gates; the Output contract applies to the agent's returned report. Exception: when the returned artifact is schema-locked (e.g. review-result JSON), the Output contract is satisfied by evidence tags inside the existing text fields — do not emit a separate preamble or close, and never add JSON fields.
- **Callers dispatching workers:** paste the five gate names into the worker prompt and require the Output contract — the overlay is model-portable by design and works on any tier.
