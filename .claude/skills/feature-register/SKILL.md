---
name: feature-register
description: Use when the operator wants a paste-ready register entry for a feature/build — "feature register", "register row", "feature info for the sheet". Emits a dot-point block, one field per line (feature name, one-sentence description, branch, brief/spec/plan paths), sourced from tasks/builds/<slug>/.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## feature-register` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Feature Register Row

Emit a copy-paste-ready dot-point block describing a build, sourced from `tasks/builds/<slug>/`. Read-only: never create or modify build artifacts. One field per line so the operator can paste the whole block, or grab individual lines, into their register.

## Invocation

- `/feature-register` — row for the current build (resolution order below)
- `/feature-register <slug>` — row for that build directory
- `/feature-register all` — one row per build directory, newest first

## Field contract (fixed order, one dot point per line)

`Feature` → `Description` → `Branch` → `Brief` → `Spec` → `Plan`, each rendered as `- Label: value`.

1. **Feature** — the spec's H1 title, markdown and backticks stripped, truncated at the first ` — ` separator. Fallback when no spec: humanised slug (hyphens to spaces, Title Case).
2. **Description** — exactly ONE sentence, 25 words or fewer, plain English for a non-technical reader, no jargon, no em-dashes, no tabs/newlines/pipes. Distil it from the spec's Summary/Goals section (or the brief when no spec exists); never paste a raw spec sentence verbatim.
3. **Branch** — first hit of: (a) an explicit branch named in the build's `progress.md` or `handoff.md`; (b) this slug's branch field in `tasks/current-focus.md` (active or concurrent pointer); (c) if the target IS the current build, `git branch --show-current`; else `n/a`.
4. **Brief** — repo-relative path of the first existing of `intent.md`, `brief.md`, `exploration.md` in the build dir; else `n/a`.
5. **Spec** — `tasks/builds/<slug>/spec.md` if it exists; else `n/a`.
6. **Plan** — `tasks/builds/<slug>/plan.md` if it exists; else `n/a`.

## Current-build resolution (no argument)

1. The slug whose `progress.md`/`handoff.md` names the current git branch.
2. Else the active slug in `tasks/current-focus.md`.
3. Else the most recently modified directory under `tasks/builds/`.

State which rule fired in the one-line note after the block.

## Output format

- ONE fenced code block containing exactly six lines, one dot point per field in the fixed order: `- Feature: …`, `- Description: …`, `- Branch: …`, `- Brief: …`, `- Spec: …`, `- Plan: …`. Missing artifact = literal `n/a`. Nothing else in the block.
- After the block, exactly one plain line: which build and resolution rule fired, plus a reminder to sanity-check the description before pasting.
- `all` mode: one six-line block per feature, blank line between blocks, newest first; skip build dirs containing none of brief/spec/plan and report the skipped count in the closing line.

## Boundaries

- Read-only. No writes, no git mutations.
- Explicit slug with no brief, spec, or plan: report that plainly instead of emitting a fabricated row.
- Never pad or invent a description: when neither spec nor brief carries a summary, write `n/a` and say so in the closing line.
