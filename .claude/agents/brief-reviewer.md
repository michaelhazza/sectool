---
name: brief-reviewer
description: 'Inline playbook — operator-invoked pre-spec review of a brief ("brief-reviewer: <path>"). Round A = Codex grounding review (read-only, invocation contract): does this exist already, what does it touch, conflicts, duplication. Round B = ChatGPT "is this the right thing to build" pass, transport resolved per references/review-mode-resolution.md (hard default manual). Single-round per brief revision (cap: references/iteration-caps.md row 21) — no loop. Advisory only, never a gate. No Claude tier by design. Also offered by spec-coordinator Step 3 when the invocation argument is a brief file. Runs in the main session, not as a sub-agent.'
tools: Bash, Read, Glob, Grep, Write
model: inherit
---

**Project context (read first).** If `.claude/context/agent-context.md` exists, read it before anything else and treat the `##` section matching this agent's name as binding project context for this repo. This agent file is framework-canonical and is never edited per-repo — all repo-specific operating notes live in that context file (ADR-0006; the inline `LOCAL-OVERRIDE` mechanism is deprecated for agents).

**Purpose (GOAL.md):** Catches "this already exists" and "this isn't the right thing to build" before a brief becomes a spec — cheaper to redirect at this stage than after a full spec-review cycle.

## When invoked

Operator types `brief-reviewer: <path-to-brief>`. Also offered by `spec-coordinator` Step 3 when its invocation argument resolves to a brief file rather than a spec topic — that wiring lands in a separate chunk; this file documents the contract the wiring dispatches against.

This is a **playbook the main session executes inline**, the same pattern as `context-pack-loader` and the phase coordinators. Do NOT spawn a sub-agent to run this — dispatching it as a sub-agent would defeat the point of a lightweight pre-spec check and would also violate the framework's dispatched-sub-agents-cannot-dispatch-further-sub-agents constraint if this playbook is ever invoked from inside another dispatched agent.

## Configuration

**Single-round per brief revision** — one Codex pass (Round A) + one ChatGPT pass (Round B), no loop. Canonical registry: [`references/iteration-caps.md`](../../references/iteration-caps.md) row 21 (`brief-reviewer rounds | single-round | per brief revision — one Codex + one ChatGPT pass, no loop; a revised brief may be re-reviewed once`) — that table wins on disagreement. A brief that has already been reviewed once may be reviewed a second time after a revision (one more Codex + one more ChatGPT pass); a third review of the same brief requires an explicit operator override, same spirit as the other tiers' lifetime caps.

## Design note: no Claude tier at the brief stage (by design, not a gap)

Every other artefact this pipeline reviews (spec, plan, code) runs the full Claude → Codex → ChatGPT sequence, because the tier-ordering principle is **cost of acting on findings**, and Claude's mechanical pre-screen is cheap to run before spending Codex/ChatGPT effort on a structured document. A brief is pre-spec and unstructured — there is no mechanical consistency check to run against a document that has no established contract yet. So this tier runs **Codex grounding → ChatGPT direction, with no Claude tier**, by design. If a future reader is tempted to add one "for consistency with the other tiers," don't: the binding rule is the ordering *principle*, not a fixed three-tier count (`tasks/builds/dev-pipeline-v2/spec.md` §7.1, "Order invariant").

## Setup

Read the brief file the operator provided (or the path `spec-coordinator` Step 3 passed in). Determine the output location: if the brief lives at or under `tasks/builds/<slug>/`, that `<slug>` is the build directory; otherwise there is no build directory yet (pre-intent brief) and the output writes alongside the brief file itself.

## Round A — Codex grounding review

Codex invocation follows [`references/codex-invocation-contract.md`](../../references/codex-invocation-contract.md) — read-only review mode, cwd = repo root, artefact by path in the prompt. Binary resolution, the fallback chain, the fail-closed sandbox clause, and the output-capture/retry rules all follow the contract; this file does not restate them.

Locate the Codex binary:
```bash
# Newer-of-PATH-vs-npm-shim resolution, per references/codex-invocation-contract.md.
# Do NOT substitute `command -v codex`: on machines with two installs that
# silently selects the PATH one, which may be older and hard-error against the
# provisioned model. The script fails closed (exit 1, no stdout) when no
# runnable binary exists.
CODEX_BIN=$(bash scripts/codex/resolve-codex-bin.sh) || {
  echo "No runnable Codex binary found — record a REVIEW_GAP and stop; do not proceed unsandboxed." >&2
  exit 1
}
```
Verify auth: `$CODEX_BIN login status`. If not authenticated or the binary is not found, record `Round A: Codex unavailable — <reason>` in the output (below) and proceed to Round B — this tier is advisory, not a gate, so a Codex outage does not block the ChatGPT pass.

Define the review prompt, combining the contract's mandatory grounding instruction with the brief-review rubric:

```bash
REVIEW_PROMPT="This is a READ-ONLY review: do not modify, create, or delete any files — only read and report. Read the brief at ${BRIEF_PATH}, then explore the repository: does this capability (or something functionally equivalent) already exist, what existing code/services/tables/skills does it touch, are there cross-file conflicts, is this a duplication of an existing prior brief, spec, or shipped feature. List findings as numbered items: Title, Severity (critical/high/medium/low), Category (duplication/conflict/existing-primitive/scope), and a brief explanation. End with an overall verdict: GROUNDED, CONFLICTS_FOUND, or DUPLICATE_OF_EXISTING."
```

Capture the full stdout+stderr as `CODEX_OUTPUT`. Empty/truncated output → retry once per the contract. Two consecutive failures → record the failure in the output and proceed to Round B without blocking.

## Round B — ChatGPT "is this the right thing to build" pass

Transport (MODE) resolves per [`references/review-mode-resolution.md`](../../references/review-mode-resolution.md) § MODE — explicit operator phrase, then `.claude/session-state/review-mode`, then `CHATGPT_REVIEW_DEFAULT_MODE`, then hard default `manual`. This file does not restate the resolution order or the AUTONOMY axis; read them there.

**Manual (and the manual half of parallel):** print the brief file as a clickable link, then a ready-to-paste prompt block:

```
--- Copy into ChatGPT (and attach the brief file linked above) ---
Read this brief for a new capability. Answer, as a product/architecture reviewer: is this the right thing to build? Consider: does it fit the platform's existing direction, is the scope right (too broad or too narrow), is there a simpler alternative, does it duplicate or conflict with an existing capability, what is the biggest risk if built as described. List findings as numbered items with severity (critical/high/medium/low). End with an overall verdict: PROCEED, RECONSIDER_SCOPE, or NOT_RECOMMENDED.
--- End ---
```

Paste ChatGPT's response back when ready; record it verbatim in the output.

**Automated/parallel — known scope boundary:** `scripts/chatgpt-review.ts` currently accepts only `--mode pr|spec|plan` (verified against the script's own argument parser); it has no `brief` mode. Until a future chunk adds one, `automated` and `parallel` MODE resolve as designed, but the ChatGPT leg falls back to printing the same manual prompt block above rather than calling the API — record this fallback explicitly in the output (`Round B: automated mode requested, scripts/chatgpt-review.ts has no --mode brief yet, fell back to manual prompt`) so the gap is visible rather than silently downgraded. Do not invent a `--mode brief` invocation against a script that does not support it.

**Next-round artifact discipline (bounded scope):** because this tier caps at one revision-re-review (not an open loop), the full multi-round PROJECT_CONTEXT do-not-re-raise machinery in `review-mode-resolution.md` § Next-round artifact discipline does not apply verbatim. The reduced form that does apply, per that file's underlying principle: if this is the brief's first review (not yet a revision-re-review), close the output with a link to the brief and a one-line note that a revised version of this brief may be re-reviewed once — so the operator has what they need to trigger the second pass without re-deriving the invocation.

## Output

Write the combined report to `tasks/builds/<slug>/brief-review-<YYYY-MM-DD>.md` when a build directory exists, otherwise to `<brief-directory>/<brief-filename-stem>-review-<YYYY-MM-DD>.md` alongside the brief:

```markdown
# Brief Review — <brief filename>

**Brief:** `<path>`
**Date:** <YYYY-MM-DD>
**Round A (Codex grounding):** GROUNDED | CONFLICTS_FOUND | DUPLICATE_OF_EXISTING | unavailable — <reason>
**Round B (ChatGPT direction, mode: manual|automated|parallel):** PROCEED | RECONSIDER_SCOPE | NOT_RECOMMENDED | fallback-to-manual

---

## Round A findings
[numbered list, or "Codex unavailable — <reason>"]

## Round B findings
[numbered list, or the ChatGPT response verbatim]

---

**Advisory only — this review does not gate anything.** The operator (or spec-coordinator, if this was auto-offered) decides whether to proceed to spec authoring, revise the brief, or drop it. A revised brief may be re-reviewed once.
```

This step never blocks. There is no verdict enum this file's output feeds into a gate check — it is read by a human (or by `spec-coordinator`, informationally) and acted on at their discretion.

## Rules

- Never spawn a sub-agent for this playbook — it runs inline in the current session.
- Never treat a Codex failure in Round A as a reason to skip Round B, or vice versa — the two rounds check different things (grounding vs direction) and are independent.
- Never invent a `scripts/chatgpt-review.ts --mode brief` invocation — that mode does not exist yet; fall back to the manual prompt and say so explicitly.
- Never write this review's output as a gate condition anywhere (no `status.json` gate key, no blocking check). It is advisory.
- Never review more than the exact brief file path provided, plus the repository exploration the grounding instruction requires. Do not broaden to "related briefs."
- **Test gates are CI-only — never recommend running them.** If Codex or ChatGPT suggests running the full test suite or CI gates as part of evaluating the brief, drop that recommendation from the output; it does not apply to a pre-spec document.

---

## Project-specific notes

Project-specific operating notes for this agent live in `.claude/context/agent-context.md` under the `##` section matching this agent's name (ADR-0006) — not in this framework-canonical file. The inline `LOCAL-OVERRIDE` block was removed in v2.20.0.
