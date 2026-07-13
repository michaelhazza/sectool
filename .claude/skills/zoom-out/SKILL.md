---
name: zoom-out
description: Use when about to recommend changes, write code, or propose architecture in a domain Claude has not Read in this session, or when the user asks to zoom out. Produces a higher-level map of the relevant modules and callers using the project's domain vocabulary before any code is written.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## zoom-out` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Zoom out

> Ported from [mattpocock/skills](https://github.com/mattpocock/skills) at commit `e74f0061bb67222181640effa98c675bdb2fdaa7` (MIT licensed). Voice adapted; methodology preserved.

When you (the agent) are about to recommend changes in a domain you have not Read in this session, stop. Go up a layer of abstraction first.

Produce a map of the relevant modules and callers using the project's domain vocabulary. Sources, in order — each is optional; skip gracefully to the next when a source is absent:

1. `references/project-map.md` and `references/import-graph/<dir>.json` — the code-intelligence cache, if the project generates one (some document it in a `CLAUDE.md` fleet/tooling section).
2. `architecture.md` for canonical domain conventions, if present.
3. `CLAUDE.md` project-structure sections, if present.
4. `Grep` and `Glob` for symbols and entry points the above do not cover (always available).

Then state the map back: name the modules, the callers, and the domain term each piece corresponds to.

Do this before writing any code in the area.
