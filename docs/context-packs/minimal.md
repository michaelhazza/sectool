# Minimal pack

For: trivial changes — single-file fix, typo, comment-only change. No design decisions.

Status: scaffold (2026-05-03).

## Sources

- `CLAUDE.md` § Local Dev Agent Fleet (the table only, ~30 lines)
- `architecture.md#key-files-per-domain` (the table only, ~50 lines)
- `references/test-gate-policy.md` (one screen)

## Skip

Everything else.

## Why this scope

A trivial change does not need the full review checklist, the full architecture guide, or the threat model. It needs to know: which agent (if any) to invoke after, where the file probably lives, and what NOT to run locally. That's it.

## Hard rule

If the change becomes non-trivial mid-session — surfaces a design decision, touches multiple files, breaks an existing pattern — STOP and load the implement pack. Do not silently expand the minimal pack's scope.
