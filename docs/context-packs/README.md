# Context Packs

Mode-scoped context packs reduce per-session token cost by loading only the architecture/guidelines sections relevant to the active mode, instead of the full `CLAUDE.md` + `architecture.md` + `KNOWLEDGE.md` + `DEVELOPMENT_GUIDELINES.md` (~5,956 lines today).

> **Status: convention introduced 2026-05-03. Migration in progress.** The packs below are scaffolds — sections are referenced from `architecture.md` and `DEVELOPMENT_GUIDELINES.md` rather than duplicating content. Until each pack is filled, fall back to loading the full reference docs.

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

### Automated mode (future)

A thin `context-pack-loader` skill (see `references/context-pack-loader.md` once written) will:
1. Detect the active mode from `tasks/current-focus.md` status (`PLANNING` → `implement`, `REVIEWING` → `review`, etc.) or from an explicit operator hint.
2. Load only the sections named in the pack.
3. Skip the always-loaded full files.

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

This is a multi-step refactor:

1. **Create scaffolds** ✅ (this commit) — pack files exist, list intended sources, fall back to full files until populated.
2. **Section-anchor architecture.md** — add HTML anchors so packs can reference `#service-layer` etc. and the loader can splice precisely.
3. **Build the loader skill** — a small `context-pack-loader.md` skill that takes a pack name and emits the sliced content.
4. **Wire packs to agents** — `pr-reviewer` loads `review.md`, `architect` loads `implement.md`, etc.
5. **Measure** — token count per session before/after; cut packs that don't pay back.

Steps 1–2 are this week. Step 3 is a small skill. Step 4 is a per-agent edit. Step 5 closes the loop.
