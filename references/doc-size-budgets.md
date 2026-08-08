# Doc-size budgets + per-session load target (controls C1, C6)

The always-loaded and accretion-prone docs have hard size budgets so a cleanup
does not silently regrow. `scripts/gates/verify-doc-size.mjs` enforces them
(warning-level rollout — exit 2 on breach, does not block a merge on its own).

## Budgets (control C1)

| File | Budget | Notes |
|---|---|---|
| `tasks/current-focus.md` | operator portion ≤ 4KB and ≤ 50 lines | The `STATUS:GENERATED:BEGIN..END` region is EXCLUDED — it is regenerated (not accreted) and scales with active builds. The accretion risk is the operator-authored pointer block. |
| `tasks/todo.md` | ≤ 200 lines | Archive completed / stale items to `tasks/todo-archive/<quarter>.md`. |
| `CLAUDE.md` | ≤ 16KB and ≤ 400 lines | The one always-loaded doc the gate did not previously budget (measured ~30KB at one consumer, ~15KB adoption history). Warning-level, non-grace. Move version archaeology / adoption history to `references/` or `tasks/builds/`. |
| `KNOWLEDGE.md` | ≤ 200KB and ≤ 150 live entries | Live entry = `### [` indexable heading + legacy `## ` entry heading. **GRACE** until the next quarterly archival sweep. |
| `architecture.md` | ≤ 400KB whole-file; `## ` sections ≤ 25KB each | **GRACE** until I2 (editorial passes). |
| `docs/capabilities.md` | ≤ 300KB | **GRACE** until I1 (asset-register split); target is prose-only after the split. |
| `docs/*.md` (root) | ≤ 100KB unless doc-sync-registered | A NEW megadoc absent from both `docs/doc-sync.md` and the consumer grandfather baseline trips the gate. |
| `.claude/agents/*.md` `description:` | ≤ 400B **BLOCKING** | Agent `description:` frontmatter is injected into every session's system prompt (the roster). Enforced by `scripts/gates/verify-description-budgets.mjs` (exit 1), NOT the warning-level doc-size gate. WHEN-TO-INVOKE only; procedure lives in the body, which loads on dispatch. |
| `.claude/skills/*/SKILL.md` `description:` | ≤ 450B **BLOCKING** | Skill `description:` loads into every session's skills listing. Enforced by `verify-description-budgets.mjs` (exit 1). |
| `.claude/commands/*.md` `description:` | ≤ 180B **BLOCKING** | Command `description:` loads into every session's command listing. Enforced by `verify-description-budgets.mjs` (exit 1). |

**Grace files** (`KNOWLEDGE.md`, `architecture.md`, `docs/capabilities.md`) are
expected over budget until their dedicated remediation chunks land. The gate
reports them as `[grace]` and MUST NOT push an executor into force-trimming
outside those reviewed processes.

**Grandfather baseline** (consumer-owned, optional):
`.claude/doc-size-baseline.json` —
`{ "grandfatheredRootDocs": ["docs/foo-spec.md", ...] }`. Pre-existing large
`docs/` root files are listed here so the gate does not retroactively fail on
them; shrink or archive them over time and remove each entry when it drops
under budget or is registered in `docs/doc-sync.md`.

## Wiring

- **Run locally / on demand:** `node scripts/gates/verify-doc-size.mjs` from the
  consumer repo root (or `GATE_ROOT=<path> node .../verify-doc-size.mjs`).
- **CI:** where the consumer owns its CI config, add a step that runs the gate
  on push. It is warning-level (exit 2), so wire it as a non-blocking reporting
  step until the operator promotes it to blocking (a later call, per the
  framework-optimization report Part C).

## Per-session load target (control C6 — budget telemetry)

Target pre-work context injected at session start: **~25K tokens** —
`CLAUDE.md` + the memory-digest + context-pack slices + on-demand retrieval.
The point of the pack-scoped loading is that a session slices the sections it
needs from `architecture.md` rather than reading the whole file.

**Regression signal (wired into the scheduled cleanfiles audit — I3):** grep the
most recent build's logs for `context-load:` lines. Any line reporting
`full architecture.md` (rather than named sliced sections) is a regression to
investigate — a pack fell back to whole-file loading, which blows the
per-session budget. The cleanfiles audit reports every such hit.
