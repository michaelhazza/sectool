# Contributing to the Claude Code Framework

This repo is the canonical source for a portable agent fleet, governance docs, hooks, skills, and a sync engine. Consuming repos mount it as a submodule at `.claude-framework/` and deploy managed files via `sync.js`. Every contribution therefore lands in *many* repos — the bar for correctness, portability, and manifest hygiene is higher than for a single-project change.

## Repo layout

| Path | What lives here |
|------|-----------------|
| `.claude/agents/` | Agent definitions (framework-canonical — see ADR-0006) |
| `.claude/commands/` | Operator slash commands |
| `.claude/hooks/` | Portable hooks + their tests, registered in `.claude/settings.json` |
| `.claude/skills/` | Skills (`<name>/SKILL.md`) |
| `docs/` | Governance docs, templates, ADRs (`docs/decisions/`), context packs |
| `references/` | Single-source-of-truth reference docs agents consult |
| `schemas/` | Review-result JSON Schemas + schema CHANGELOG |
| `scripts/` | Sync/review/helper scripts + `scripts/__tests__/` |
| `migrations/` | Per-version consumer migrations run by `/claudeupdate` |
| `tests/` | End-to-end tests for `sync.js` (adopt, sync, merge, settings-merge, substitution) |
| `manifest.json` | The managed-file declaration — the authoritative list of what ships, how it syncs, and what gets substituted |
| `ADAPT.md` / `SYNC.md` | Adoption and upgrade walkthroughs |

## Adding an agent

1. Create `.claude/agents/<name>.md` with frontmatter and a caller contract.
2. **ADR-0006 canonical-file constraint (binding):** agent files are framework-canonical. Origin-specific or repo-specific content — CI job names, gate shards, DB roles, project paths — goes to the consuming repo's `.claude/context/agent-context.md` under a `## <agent-name>` section, **never** into the canonical agent file. No inline `LOCAL-OVERRIDE` blocks in agents. The agent's first body line after frontmatter carries the uniform read-instruction pointing at `agent-context.md`.
3. Use `{{PROJECT_NAME}}`-style placeholders (double-brace) for values substituted at adoption.
4. Agents are covered by the manifest glob `.claude/agents/*.md` — no new manifest entry needed.
5. Add the agent to the profile lists in `README.md` / `ADAPT.md` § 12 if it belongs to MINIMAL/STANDARD/FULL, and to the fleet table consumers copy into their CLAUDE.md.
6. If other agents invoke it, update their caller sections; if it's invoked inline (coordinator-style), say so explicitly — inline-vs-dispatched is a hard behavioural contract.

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` (directory + SKILL.md, single clear responsibility).
2. Add a manifest entry — skills are listed **per-skill** in `manifest.json` (`category: "skill"`, `mode: "sync"`, `substituteAt: "never"` unless the skill genuinely needs adoption-time substitution).
3. Add the skill to the `README.md` What-ships skills row (name + count).
4. Update `.claude/CHANGELOG.md` under the release version (Added).

## Adding a hook

1. Create `.claude/hooks/<name>.js` and a sibling `<name>.test.js`. Follow the established exit-code contract: `0` = allow, `2` = block with stderr fed back to Claude, and **fail-open on hook bugs** (a hook crash must never block legitimate work) unless the hook is explicitly a safety guard that must fail closed — document the choice in the file header.
2. Register it in `.claude/settings.json` under the right event (PreToolUse / UserPromptSubmit / SessionStart). Consumers receive this via `settings-merge` mode.
3. Hooks are covered by the manifest globs `.claude/hooks/*.{js,sh}` — verify your extension is covered; add an entry if not.
4. Run `npm run test:hooks`; update `README.md` hook row and `.claude/CHANGELOG.md`.

## Adding a command

1. Create `.claude/commands/<name>.md`. Commands are glob-covered by the manifest entry `.claude/commands/*.md` — a file is all that's needed.
2. Update the `README.md` commands row and `.claude/CHANGELOG.md`.

## Version bump + changelog protocol

- `.claude/FRAMEWORK_VERSION` (single-line semver) and `manifest.json`'s `frameworkVersion` must match.
- `.claude/CHANGELOG.md` must contain **one `## <version> — <date>` heading per released version**, using the Highlights / Breaking / Added / Changed / Deprecated / Removed / Fixed format defined at the top of that file.
- **CI asserts consistency** (`.github/workflows/ci.yml` "Version consistency" step): `FRAMEWORK_VERSION` == `manifest.frameworkVersion`, and the changelog contains a heading for that exact version. A PR that bumps one without the others fails CI.
- If the release needs consumer-side file changes beyond what `sync.js` deploys, ship a migration (below).

## Test expectations

- `npm test` runs everything (sync engine tests in `tests/`, script tests, hook tests). Targeted: `npm run test:sync`, `npm run test:scripts`, `npm run test:hooks`. `npm run validate` runs the framework validator.
- **New sync-engine features need coverage in `tests/`** (the e2e adopt/sync/merge suites) — sync.js writes into other people's repos; untested paths are not acceptable.
- **New migrations need coverage under the migrations harness** (see `migrations/README.md`): migrations must be idempotent, non-destructive on conflict, and return `{ status, notes }` — test all three.
- New pure helper scripts get a Vitest test in `scripts/__tests__/`.

## Migrations

One file per framework version: `migrations/v<MAJOR>.<MINOR>.<PATCH>.js`, exporting `async migrate(ctx)`. They run automatically during `/claudeupdate` **before** `sync.js`, are tracked in the consumer's `.framework-state.json` `appliedMigrations[]`, and must be idempotent and non-destructive on conflict. Full contract: `migrations/README.md`.

## Release flow

Use the `/release` command (`.claude/commands/release.md`) — it walks the version bump, changelog heading, manifest consistency, tag, and consumer-notification steps. Do not hand-roll releases.

## PR etiquette

- One concern per PR; keep the diff reviewable.
- Update `manifest.json`, `README.md` What-ships, and `.claude/CHANGELOG.md` **in the same PR** as the files they describe — doc drift across repos is expensive.
- No repo-specific content in canonical files (ADR-0006). If a consumer needs different behaviour, that's either project context (`agent-context.md`), a `LOCAL-OVERRIDE` slot in a non-agent doc, or a framework change — never a fork of a managed file.
- Never commit secrets; scripts read keys (e.g. `OPENAI_API_KEY`) from the consumer's environment only.
- PRs that change reviewer output shapes must update `schemas/` and `schemas/CHANGELOG.md` in lockstep with the TypeScript types and prompts.
