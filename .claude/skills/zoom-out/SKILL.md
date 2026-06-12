---
name: zoom-out
description: Use when about to recommend changes, write code, or propose architecture in a domain Claude has not Read in this session, or when the user asks to zoom out. Produces a higher-level map of the relevant modules and callers using the project's domain vocabulary before any code is written.
---

# Zoom out

> Ported from [mattpocock/skills](https://github.com/mattpocock/skills) at commit `e74f0061bb67222181640effa98c675bdb2fdaa7` (MIT licensed). Voice adapted; methodology preserved.

When you (the agent) are about to recommend changes in a domain you have not Read in this session, stop. Go up a layer of abstraction first.

Produce a map of the relevant modules and callers using the project's domain vocabulary. Sources, in order:

1. `references/project-map.md` and `references/import-graph/<dir>.json` for the code-intelligence cache (per `CLAUDE.md` § Local Dev Agent Fleet).
2. `architecture.md` for canonical domain conventions.
3. `Grep` and `Glob` for symbols and entry points the cache does not cover.

Then state the map back: name the modules, the callers, and the domain term each piece corresponds to.

Do this before writing any code in the area.
