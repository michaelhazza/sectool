# Codex invocation contract

> Single source of truth for how every Codex tier (`spec-reviewer`, `plan-reviewer`, `brief-reviewer`, `dual-reviewer`, `verify-phase`) shells out to the Codex CLI. Agent files **cite** this document; none embeds a divergent command line. When an agent file and this contract disagree, THIS CONTRACT WINS — fix the agent file in the same commit.

Two named modes. Review tiers use read-only; the verify phase's test-authoring step alone uses write-enabled. No tier infers write access from the read-only shape below, and no reader should treat "Codex writes the tests" as a contradiction of "Codex tiers are read-only."

## Review mode (read-only) — spec / plan / brief / dual tiers

```bash
$CODEX_BIN exec -s read-only "<prompt naming the artefact path or changed-file set + grounding instruction>"
```

- **cwd:** repo root. Never invoke from a subdirectory.
- **Artefact delivery:** the artefact path (or, for diff-scoped review, the changed-file set + base ref) is named **inside the prompt string**. Never pipe the artefact via stdin — stdin-piping starves Codex of repository context and is the exact pattern this contract replaces.
- **Grounding instruction (mandatory, explicit, in the prompt):** read the artefact, then explore the repository — does this exist already, what does it touch, are there cross-file conflicts, is this a duplication of existing logic. A prompt that only says "review this file" is under-specified; the grounding clause is what turns a text review into a repository-aware one.
- **Diff-scoped variant (`dual-reviewer`):** the prompt names the changed-file set and the base ref; Codex still explores the whole repo for context but the review itself is scoped to the branch diff.

## Write-enabled mode — verify-phase test authoring only

Used exclusively by the verify phase's step 2 (author) when it writes new test files. Two acceptable mechanisms, pinned per invoking playbook:

- **Workspace-write sandbox** — `codex exec -s workspace-write "<prompt>"` — Codex edits the working tree directly, scoped to the test-file paths the prompt names.
- **Patch-emit-and-apply** — Codex runs in read-only mode and emits a patch (diff) in its output; Claude reviews and applies it via `Edit`/`Write`. Preferred when the invoking playbook wants an explicit apply step between Codex's output and the working tree.

Write-enabled mode never governs a review tier. A review tier that needs write-enabled mode for anything is out of contract — route it back to plan-time as a gap, not a workaround.

## Binary resolution

Resolve the runnable Codex binary as the **newer of PATH vs the npm global shim**, not "whatever PATH gives first." An older PATH-resolved binary can hard-error against a newer model even though a newer binary is installed and reachable elsewhere.

**There is one implementation. Call it; do not re-derive it.**

```bash
CODEX_BIN=$(bash scripts/codex/resolve-codex-bin.sh) || {
  echo "No runnable Codex binary found — record a REVIEW_GAP and stop." >&2
  exit 1
}
```

`scripts/codex/resolve-codex-bin.sh` considers the PATH binary, the npm global shim, and `CODEX_FALLBACK_PATH` (which a project may pin in `.claude/context/agent-context.md`), reads `--version` from each, and returns the **newest**. It fails closed — exit 1 with empty stdout — when nothing runnable is found, rather than emitting a bare `codex` for a caller to invoke blindly. It syncs to consumers at the same relative path, so the command above works verbatim in any adopting repo.

> **Do not substitute `CODEX_BIN=$(command -v codex …)`.** That was the lookup every tier used until 2026-07-28, and it is PATH-first with no version comparison. This section already required newer-of resolution at the time, but the rule existed **only as prose while six agent files carried the PATH-first snippet** — so on the operator's reference machine every tier silently selected 0.138.0, which hard-errors, while a working 0.144.3 sat in the npm prefix. Codex found the contradiction in review. The lesson generalises: a resolution rule stated in prose and re-implemented per caller will drift; one script, called by every caller, cannot.

**Illustrative note (machine-specific, not a rule):** on the operator's reference machine, the PATH binary (`…/Programs/OpenAI/Codex/bin/codex`, version 0.138.0) hard-errors on the account's provisioned model; the working binary is the npm shim (`/c/Users/Michael/AppData/Roaming/npm/codex`, version 0.144.3). This is one instance of the newer-of-PATH-vs-npm-shim rule above, not a hardcoded path — other machines and other consuming repos will have different binary locations and versions.

## Fallback chain and fail-closed sandbox clause (OAI-SPEC-005, security carve-out — REQUIRED wording)

The fallback chain preserves the `-s read-only` sandbox for as long as any fallback accepts it — an older installed Codex that rejects one flag combination still gets tried with a narrower read-only-preserving command before anything weaker is attempted.

**If NO fallback accepts a read-only sandbox: STOP and record a `REVIEW_GAP`. NEVER run an unsandboxed review invocation.** This is required behaviour, not advice — no tier may fall through to a bare unsandboxed `codex exec` as a "better than nothing" last resort. A read-only review that cannot get a sandbox is a `REVIEW_GAP`, not a downgrade.

**Output capture:**
- Capture full stdout+stderr as the review output.
- Empty or clearly truncated output → retry once.
- Two consecutive failures (including two truncated/empty attempts) → stop and report to the caller. Do not attempt a third time.
- **Absence of findings after a failure is never treated as approval.** A tier that could not get a clean Codex run has no verdict to report — it must not synthesize `APPROVED` (or equivalent) from silence.

## Environment parity for TEST-EXECUTING dispatches — MANDATORY precondition

Binding on every dispatch where Codex (or any external tool) will **execute tests**, not merely read code: the verify-phase author/run loop, a dual-review iteration that runs tests live, a bug-fix verification, a browser-test session.

**The caller brings the local environment to parity BEFORE the dispatch, and states the parity in the handoff prompt.** The one that has already burned a build: **database migrations.** A test-executing session against a database that is behind on migrations produces results against stand-in data, and the failure mode is the worst kind — the tests *run*, the session *completes*, and the gap surfaces only as a reviewer's closing caveat ("the local database is behind on migrations, so the browser tests ran against stand-in data") **after everything is done**. A caveat delivered after the work is a precondition that was skipped.

Concretely, before any test-executing dispatch the caller MUST:

1. **Apply pending migrations** using the consuming repo's declared migrate command (automation-v1: `npm run migrate`; each repo pins its own in `.claude/context/agent-context.md`). Run it unconditionally — "probably at head" is not a state, and the command is idempotent at head by definition.
2. **Verify, not assume:** confirm the command exited 0. Non-zero is a **blocking stop** — report the failure and do not dispatch. A dispatch against a knowingly-stale database is never acceptable, and neither is discovering staleness afterwards.
3. **State parity in the handoff prompt**, one line: `Environment: migrations applied to head via <command> (exit 0) at <ISO timestamp>.` This gives the executing session grounds to trust the data AND an instruction to re-check if it does something (like switching branches) that could invalidate it.
4. **The executing session re-checks on doubt.** If Codex switches branches, pulls, or observes schema-shaped test failures (missing table/column), its first move is to re-run the migrate command, not to author around the gap or annotate results with a caveat.

The same rule generalises to any state a test run depends on: seeded fixtures, built artifacts a suite imports, environment variables a harness requires. Migrations are named explicitly because they are the instance that actually happened.

## Citing this contract

Agent files reference this document instead of restating the command line:

```markdown
Codex invocation follows [`references/codex-invocation-contract.md`](../../references/codex-invocation-contract.md) — read-only review mode, cwd = repo root, artefact by path in the prompt.
```

A literal `codex exec` command line appearing in a Codex-tier agent file outside this document is drift the tier should not carry — cite, don't embed.

---

## Project-specific notes

Project-specific operating notes for this contract (e.g. a project's `CODEX_FALLBACK_PATH` pin) live in `.claude/context/agent-context.md` under the section for the citing agent (ADR-0006), not here.
