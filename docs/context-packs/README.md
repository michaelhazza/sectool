# Context Packs

Mode-scoped context packs reduce per-session token cost by loading only the architecture/guidelines sections relevant to the active mode, instead of the full `CLAUDE.md` + `architecture.md` + `KNOWLEDGE.md` + `DEVELOPMENT_GUIDELINES.md` (often thousands of lines).

> **Status: templates — anchors must be mapped at adoption.** The packs below reference sections of `architecture.md` and `DEVELOPMENT_GUIDELINES.md` rather than duplicating content, using `{{ARCHITECTURE_ANCHOR:<purpose>}}` placeholder tokens. Mapping happens through the sync substitution engine: one `"ARCHITECTURE_ANCHOR:<purpose>": "#<real-anchor>"` entry per token in the consuming repo's `.claude/.framework-state.json` → `substitutions`, then `node .claude-framework/sync.js --adopt` to rebaseline (full steps: ADAPT.md Phase 3b). Never hand-edit the pack files — they are `mode: sync` and hand edits accrue `.framework-new` merge debt on every update. Until mapped, every pack consumer (the loader and the pack-wired agents) falls back to loading the full reference docs, and `scripts/audit-context-packs.ts` prints `UNMAPPED` advisories.

## Why

The default Claude Code session prompt loads CLAUDE.md, architecture.md, KNOWLEDGE.md, DEVELOPMENT_GUIDELINES.md every time. That's ~6k lines of always-loaded context regardless of what the operator is doing — reviewing a 50-line PR, fixing a typo, debugging a single service. Most of those tokens carry no signal for the active task.

Context-router (the open-source MCP server we evaluated) exposes the same idea as token-budgeted retrieval packs (review / implement / debug / handover / minimal). We're not adopting context-router itself (stack mismatch, immaturity, duplication with our existing infra), but the mode-pack split is sharp and worth stealing.

## Packs

| Pack | When to load | Target size | Sources |
|------|--------------|-------------|---------|
| [`review.md`](./review.md) | Code review, PR review, spec conformance — reading and judging existing code | ≤2k lines | `pr-reviewer` checklist, RLS / tenant isolation rules, error contract, security surface |
| [`implement.md`](./implement.md) | Building from a spec or plan — chunk-by-chunk implementation | ≤2k lines | Service tier rules, schema discipline, idempotency, test posture, contract examples |
| [`debug.md`](./debug.md) | Investigating a bug or incident — tracing behaviour through layers | ≤2.5k lines | Layer boundaries, observability primitives, common gotchas (KNOWLEDGE.md filtered) |
| [`handover.md`](./handover.md) | Onboarding a new session to in-flight work, or writing a handoff | ≤4k lines | Active spec, plan, progress, current-focus, open ADRs |
| [`minimal.md`](./minimal.md) | Trivial change, single-file fix, no design decisions | ≤800 lines | CLAUDE.md fleet table only, plus the key files per domain index |

## How to use

### Manual mode (today)

At the start of a session, the operator can ask:

```
load context pack: review
```

The session reads `docs/context-packs/review.md`, follows its `## Sources` block to load the named sections, and skips the rest.

### Loader (shipped)

The loader exists: `.claude/agents/context-pack-loader.md` (shipped in framework v2.2.0). It is an inline playbook — invoked via "load context pack: <mode>" in the main session — that:
1. Detects the active mode from `tasks/current-focus.md` status (`PLANNING` → `implement`, `REVIEWING` → `review`, etc.) or from an explicit operator hint.
2. Loads only the sections named in the pack.
3. Skips the always-loaded full files.

## Authoring a pack

Each pack is a single markdown file that lists the sections to load and why. It does NOT duplicate content from `architecture.md` / `DEVELOPMENT_GUIDELINES.md` — it references them by heading anchor.

Example structure:

```markdown
# Review pack

For: code review, PR review, spec conformance.

## Sources

Load these sections only. Skip everything else in the named files.

- `architecture.md`:
  - § Route Conventions
  - § Service Layer
  - § Row-Level Security (RLS)
  - § Permission Model
- `DEVELOPMENT_GUIDELINES.md`:
  - § 1 Multi-tenancy and RLS
  - § 2 Service / Route / Lib tier boundaries
  - § 9 Multi-tenant safety checklist
- `KNOWLEDGE.md` filtered to entries tagged `pattern` or `gotcha`
- `references/test-gate-policy.md`

Skip: § 4 LLM routing (unless the diff touches LLM code), § 7 Testing posture (unless the diff includes tests), all worked examples in `docs/frontend-design-principles.md`.
```

## Tracking the migration

Remaining steps of the refactor:

1. **Create pack templates** ✅ — pack files exist and list intended sources via `{{ARCHITECTURE_ANCHOR:<purpose>}}` tokens; fall back to full files until anchors are mapped.
2. **Map anchors at adoption** — per consuming repo: section-anchor its `architecture.md` (`scripts/generate-architecture-anchors.ts`, idempotent), add one `ARCHITECTURE_ANCHOR:<purpose>` substitution per token, rebaseline with `sync.js --adopt` (ADAPT.md Phase 3b). `scripts/audit-context-packs.ts` reports unmapped tokens as `UNMAPPED` advisories; `--strict-unmapped` turns them into failures once a repo has mapped. **Automated as of v2.36.0:** `/claudeupdate` step 6c2 performs this once per repo on its next update — unmapped repos self-complete without a separate task.
3. **Loader** ✅ — `.claude/agents/context-pack-loader.md` (shipped v2.2.0) takes a pack name and loads the sliced content.
4. **Wire packs to agents** ✅ (v2.35.0) — `builder` and `architect` slice `architecture.md` via `implement.md`, `pr-reviewer` via `review.md`. Wiring is conditional and fail-safe: an unmapped or drifted pack falls back to the whole-file read, and each agent records which mode it used as a `context-load:` line in its output.
5. **Measure** — per consuming repo, after mapping: compare the `context-load:` lines (sections + approximate lines loaded) against the pre-mapping whole-file baseline across a few representative builds; cut or trim packs that don't pay back.
