# Framework migrations

Per-version migration scripts that run automatically during `/claudeupdate` on consuming repos. The pattern is modelled on Rails / Drizzle / Flyway database migrations: every framework version that needs operator-visible cleanup or per-repo file changes ships a script here; `scripts/run-migrations.js` discovers them and runs in order.

## Convention

- One file per framework version: `v<MAJOR>.<MINOR>.<PATCH>.js`
- Each file exports a single async function `migrate(ctx)` where `ctx` is `{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }`
- The function is called from the consuming repo's root (`process.cwd() === ctx.consumerRoot`)
- Migrations MUST be **idempotent** — safe to re-run. Always check whether the change is already applied before applying it.
- Migrations MUST be **non-destructive on conflict** — if a file the migration would modify has been customised locally, leave it alone and report; do not auto-overwrite.
- Migrations SHOULD return a structured result: `{ status: 'applied' | 'skipped' | 'conflict', notes: string[] }`. The runner aggregates these for the per-repo report.

## Execution model

`scripts/run-migrations.js` is called with `(consumerRoot, fromVersion, toVersion)`:

1. Reads the consuming repo's `.claude/.framework-state.json` to get `appliedMigrations: string[]` (list of versions already applied)
2. Discovers all `migrations/v*.js` files in the framework canonical
3. Sorts by semver
4. Filters to `version > fromVersion && version <= toVersion && !appliedMigrations.includes(version)`
5. Runs each in order, capturing the result
6. Records the version in `appliedMigrations[]` and writes back **only on `applied` or `skipped`** — `conflict` is left unrecorded so the next `/claudeupdate` re-runs the migration after the operator resolves the underlying conflict
7. Returns a per-version report

If any migration throws, the runner stops and propagates the error. The state file is updated only for migrations that completed (with status `applied` or `skipped`) before the failure.

## Lifecycle position — migrations run BEFORE sync.js

The one-shot `/claudeupdate` flow runs migrations **before** `sync.js`. This ordering is deliberate:

- **Pre-sync auto-adoption.** The v2.8.0 migration's main job is to pre-populate `.framework-state.json` with hashes of pre-existing local copies that match the framework version. Running this before `sync.js` means `sync.js` then sees those files as `clean`/`already-on-version` and does NOT write `.framework-new` siblings. Running after `sync.js` would defeat the purpose — `sync.js` would write `.framework-new` first, trip the conflict-pause check, and the migration would never run.
- **State setup.** Migrations that need to seed config files (e.g. copy `.template` files, rename consumer files, retire deprecated entries from state) belong before `sync.js` so the deploy step sees a consistent post-migration state.
- **Read framework canonical from `frameworkRoot`.** Migrations have access to the post-bump framework submodule via `ctx.frameworkRoot`. They don't need `sync.js` to have run; they read framework files directly from the submodule and compare against `ctx.consumerRoot`.

If a future migration genuinely needs to operate on files `sync.js` has already deployed (none today), we'll add a `phase: 'pre-sync' | 'post-sync'` field to the migration's exported metadata and update the runner to make two passes. For now, all migrations are pre-sync.

## State tracking

The `appliedMigrations: string[]` field in `.framework-state.json` is the source of truth for what's been applied. It's authoritative — the runner never assumes a migration has been applied based on file presence or content. This means:

- A consuming repo that adopts framework v2.9.0 fresh (no prior `.framework-state.json`) gets all migrations from v2.0.0 onward, in order
- A consuming repo that's at v2.8.0 and bumps to v2.9.0 gets only the v2.9.0 migration
- A consuming repo that was at v2.7.x, then v2.8.0 was adopted manually (per the v2.8.0 CHANGELOG migration notes), the operator can pre-populate `appliedMigrations: ["2.8.0"]` to mark it done; the runner will skip v2.8.0 next bump

## Authoring a new migration

1. Copy `migrations/_template.js` to `v<version>.js`, matching `.claude/FRAMEWORK_VERSION` at the time of authoring. The template documents the full contract: exported `migrate(ctx)` signature, the `applied`/`skipped`/`conflict` return statuses and their state-recording semantics, and worked examples of the shared helpers.
2. Use the shared helpers in `migrations/_helpers.js` (content normalisation + hashing, single-`*` glob expansion, state read/persist, the adopt-if-matches loop, idempotent `.gitignore` append) — do not copy-paste boilerplate from older migrations. The pre-v2.30.0 migrations (v2.8.0/v2.12.0/v2.13.0/v2.27.0) keep their inline copies deliberately: they have already run across the fleet and are frozen; do not refactor them onto the helpers. `_helpers.js` and `_template.js` are underscore-prefixed so the runner's discovery regex (`^v<semver>\.js$`) never executes them and the `migrations/v*.js` manifest glob never deploys them.
3. Make it idempotent (use `existsSync`, content hashing, or marker files)
4. **Tests are a required deliverable for every new migration.** Extend `tests/migrations.test.ts` (fixture harness: temp consumer root + fake framework root) with coverage for the new migration — at minimum fresh apply, idempotent re-run, and any conflict path. Run `npx tsx --test tests/migrations.test.ts`. Additionally smoke-test the real flow with `node scripts/run-migrations.js <consumer-root> <previous-version> <this-version>` against a smoke target
5. Update `CHANGELOG.md` to reference the migration: `Migration: <script-name> — <what-it-does-and-why>`
6. Ensure the file is in `manifest.json` `managedFiles` (the `migrations/v*.js` glob covers it automatically)

## Why migrations, not just sync.js

`sync.js` deploys files declaratively from `managedFiles`. It can't:

- Delete files that the framework used to manage but no longer does (sync.js leaves them — they're now "customised")
- Copy templates to non-template destinations (e.g. copy `.claude/project-registries.json.template` → `.claude/project-registries.json` on first adoption)
- Rename or move files within the consuming repo
- Run arbitrary one-time setup commands

Migrations cover this gap. They're operator-visible (reported per-repo by `/claudeupdate`), versioned (no surprise re-runs), and idempotent (safe under repeated execution).
