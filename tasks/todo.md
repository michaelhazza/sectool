# Todo

Active backlog. Items captured here are queued for work; resolved items move to `tasks/todo-archive/<quarter>.md` once a section is fully `[x]`.

## How items land here

- `triage-agent` captures ideas + bugs surfaced during dev sessions.
- Review agents (`pr-reviewer`, `spec-conformance`, `chatgpt-pr-review`, `chatgpt-spec-review`) route deferred / directional findings here.
- Audit runs (`audit-runner`) write deferred items here under a `## Deferred from <scope> audit — <YYYY-MM-DD>` section.

## Item shape

```markdown
- [ ] [origin:<source>:<YYYY-MM-DD>] [status:open|deferred|resolved] Short title
  - Why: one or two sentences.
  - Approach: one or two sentences.
  - Risk: one sentence (optional).
```

`origin` lets you grep the source of every backlog item. Examples: `origin:pr-1234-r2-f3`, `origin:setup-audit:2026-05-03`.

---

## Sections

### Framework adoption gaps

- [ ] [origin:validate-setup:2026-06-12] [status:open] Two origin-repo specs cited by agents are absent everywhere
  - Why: `.claude/agents/spec-coordinator.md` and `finalisation-coordinator.md` cite `tasks/builds/development-lifecycle-governance-upgrade/spec.md` and `docs/superpowers/specs/2026-04-30-dev-pipeline-coordinators-spec.md` as authoritative; neither exists in this repo or the framework submodule.
  - Approach: the governing tables (intent field rules, Lifecycle Declaration, ABCd) are already inlined in the agent files and `docs/spec-authoring-checklist.md`, so the pipeline runs without them; import from the origin repo or localise the citations when convenient.
  - Risk: low — citations are provenance pointers, not runtime dependencies.
- [ ] [origin:validate-setup:2026-06-12] [status:open] doc-sync coverage gaps
  - Why: `references/verification-commands.md`, `references/local-override-convention.md`, `docs/frontend-design-examples.md`, `docs/mobile-capability-principles.md`, `docs/spec-authoring-checklist.md` are neither in the `docs/doc-sync.md` table nor explicitly excluded.
  - Approach: add rows or exclusions to `docs/doc-sync.md` during the first finalisation pass.
- [ ] [origin:validate-setup:2026-06-12] [status:open] Author `architecture.md` so context-pack anchors resolve
  - Why: all 5 context packs reference `architecture.md` anchors; the doc doesn't exist yet (fresh adoption).
  - Approach: author after audit-tool v1 lands its real architecture; anchor IDs per framework convention.
