---
name: grill-me
description: Use when the user wants to stress-test a plan or design by being interviewed relentlessly until shared understanding is reached, or when they say "grill me". The agent walks down each branch of the design tree, resolving dependencies between decisions one-by-one, asking one question at a time, and providing a recommended answer with each question.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## grill-me` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Grill me

> Ported from [mattpocock/skills](https://github.com/mattpocock/skills) at commit `e74f0061bb67222181640effa98c675bdb2fdaa7` (MIT licensed). Voice adapted; methodology preserved. Confidence protocol, hollow-yes gate, de-sophistication probe, and stop conditions adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `interview-me` at commit `98967c4` (MIT licensed).

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

## Confidence protocol

- Before the first question, state a one-line HYPOTHESIS of what the user wants plus an honest confidence number (0-100%). Below ~70%, the same line must name what is missing — the user cannot help close a gap they cannot see.
- Restate the updated read and confidence whenever an answer shifts it. Several rounds without confidence visibly rising means the questions are wrong or something foundational is missing — say so and step back rather than grinding.

## Hollow-yes gate

Only an explicit yes ends the interview. These are NOT yes, and each gets a counter-move:

- "Whatever you think is best" — delegation, not decision. Re-ask as a choice between two concrete options.
- "Sounds good" — ambiguous. Ask "anything you'd refine?"; silence is not confirmation.
- "Sure, let's go" — often a polite exit, not endorsement. Same follow-up.
- Silence, then "okay let's start" — the user gave up on the interview, not converged. Ask what you missed.

## De-sophistication probe

When an answer is best-practice talk without specifics ("scalable", "clean architecture", "the standard approach", "I'm supposed to..."), probe: *"If you didn't have to justify this to anyone, what would you actually want?"* — that one question often does more work than the previous five.

## Stop conditions

- Stop when you can predict the user's reaction to the next three questions you would ask — a checkable test, not a vibe. Until then, keep asking.
- The final restate must include an explicit **Out of scope** line; half of misalignment is silent disagreement about what is NOT being built.
- Do not run this interview in non-interactive contexts (CI, scheduled runs, headless loops) — flag the underspecified ask as a blocker instead of guessing.
