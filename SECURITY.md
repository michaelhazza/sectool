# Security Posture

This framework deploys files into consuming repos and registers hooks that Claude Code executes automatically. This document states exactly what runs, what talks to the network, where secrets live, and what the sync engine will and will not write.

## What executes automatically in consumers

Hooks registered via `.claude/settings.json` (merged into the consumer's settings by `sync.js` `settings-merge` mode) run without operator interaction. Failure mode key: **fail-open** = a hook bug or crash exits 0 and never blocks work; **fail-closed** = the hook blocks (exit 2) when its guard condition trips.

| Hook | Event | What it does | Failure mode |
|------|-------|--------------|--------------|
| `long-doc-guard.js` | PreToolUse (Write) | Blocks single Writes of doc files over ~10k chars, forcing the chunked-write workflow | Blocks on trip; fail-open on hook bugs |
| `config-protection.js` | PreToolUse (Write/Edit/MultiEdit) | Blocks edits to protected config files (settings, hook registrations) without explicit approval | Blocks on trip; fail-open on hook bugs |
| `phase-lock.js` | PreToolUse (Write/Edit/MultiEdit) | Enforces the per-phase allowed-paths matrix from `tasks/builds/{slug}/.phase`; also blocks any path containing `..` segments | Blocks on trip and on `..` paths (deliberately fail-closed for traversal); missing/absent `.phase` is a no-op (fail-open) |
| `correction-nudge.js` | UserPromptSubmit | Injects a KNOWLEDGE.md-capture nudge when the prompt looks like a correction | Never blocks (exit 0 always) |
| `spec-creation-grill-nudge.js` | UserPromptSubmit | Injects a grill-me reminder when the prompt looks like spec creation | Never blocks (exit 0 always) |
| `code-graph-freshness-check.js` | SessionStart | Checks code-intelligence cache freshness and may spawn a local rebuild (via `npx`, 180s timeout) | Fail-open — a stale cache, missing script, or build failure never blocks session start |
| `bash-config-guard.js` | PreToolUse (Bash) | Guards shell-based writes to protected config AND KNOWLEDGE.md — all Bash write shapes incl. `>>` appends block with HITL (added 2.30.0) | See file header for its exit-code contract |
| `framework-merge-reminder.js` | (added 2.30.0) | Reminds about pending `.framework-new` merges | See file header for its exit-code contract |
| `knowledge-append-guard.js` | PreToolUse (Edit/Write/MultiEdit, added 2.30.0) | Enforces strict append-only on KNOWLEDGE.md: ONLY pure tail appends pass; any other edit (body rewrites included) requires HITL | See file header for its exit-code contract |

Every hook is plain Node with no third-party dependencies, readable in `.claude/hooks/`. The only hook that spawns a subprocess is `code-graph-freshness-check.js`, and only to run the consumer's own code-graph build script if one exists.

## Network egress

- **The OpenAI review driver is the only component that calls out.** `scripts/chatgpt-review.ts` / `scripts/chatgpt-review-api.ts` POST to `https://api.openai.com/v1/responses` using `OPENAI_API_KEY` read from the environment. These run only when an operator (or a coordinator the operator invoked) runs an automated/parallel ChatGPT review; `manual` mode makes no API calls.
- Nothing else in the framework — hooks, `sync.js`, migrations, helper scripts — makes network requests. `sync.js` operates entirely on the local filesystem; `/claudeupdate` uses the consumer's own `git` remotes.

## Secret expectations

- All keys live in the **consumer repo's `.env`** (gitignored) or environment — never in framework files, never committed, never echoed to logs or chat.
- The framework never persists a key: the review driver reads `OPENAI_API_KEY` from `process.env` per invocation.
- Review logs and quarantine files under `tasks/review-logs/` contain model output and diffs — they must not contain secrets; do not paste `.env` contents into review inputs.

## sync.js write boundaries

The sync engine writes into consuming repos, so its write surface is deliberately constrained:

- **Root containment (`assertWithinRoot`).** Every resolved source and target path must stay inside the framework root / target repo root respectively; anything that escapes throws.
- **Manifest path validation.** Manifest patterns must be relative, must not contain `..` segments or absolute paths, and `**` globs are rejected outright — a compromised `manifest.json` cannot direct writes outside the repo.
- **`doNotTouch` hard refusal.** Paths matching a manifest `doNotTouch` entry (`CLAUDE.md`, `KNOWLEDGE.md`, `architecture.md`, `DEVELOPMENT_GUIDELINES.md`, `tasks/**`) are never written, even if also listed as managed — the write is refused and logged.
- **No clobbering of customised files.** Locally modified managed files get a `.framework-new` sibling for manual merge instead of an overwrite; `adopt-only` files are deployed once and never overwritten.

Note: `sync.js` does not currently perform an explicit symlink check on target paths; root containment and manifest validation are the enforced boundaries. Treat a consumer repo containing symlinked managed paths as unsupported.

## Schemas are advisory for inputs

`schemas/pr-context.schema.json` and `schemas/prior-rounds.schema.json` document expected input shapes but **are not yet enforced** — the review driver reads `--pr-context` / `--prior-rounds` files without validating them (see `schemas/CHANGELOG.md`). Do not rely on them as a security control. Review *results* are Ajv-validated against `review-result.schema.json`; failures are quarantined, never applied.

## Reporting a vulnerability

Open a GitHub issue against this repo titled `SECURITY: <short description>` **without** exploit details, and the maintainer will follow up through a private channel — or contact the maintainer directly if you have a private route. Include: affected file(s), the framework version (`.claude/FRAMEWORK_VERSION`), and whether consuming repos are affected at sync time or at runtime. Vulnerabilities in deployed hooks or `sync.js` write boundaries are the highest-priority class, since they execute automatically in every consuming repo.
