# Review MODE / AUTONOMY resolution — single source of truth

This is the shared contract for how `chatgpt-spec-review`, `chatgpt-plan-review`,
and `chatgpt-pr-review` (and any coordinator invoking them) resolve their
transport MODE and their AUTONOMY. Agent files summarise this contract; when a
summary and this file disagree, THIS FILE WINS. Do not restate resolution rules
in coordinator files — link here.

## MODE (review transport)

Three values: `manual`, `automated`, `parallel`.

Resolution order — first hit wins:

1. **Explicit operator phrase** at invocation (e.g. "run chatgpt-pr-review automated",
   a trailing `manual` / `automated` / `parallel` keyword on a trigger phrase).
2. **Session-state file** `.claude/session-state/review-mode` — single line
   containing `manual`, `automated`, or `parallel`. Written by orchestrators
   (e.g. `bug-fixer`) so the choice survives sub-agent dispatches without an
   env-var session restart. Any other content = unset.
3. **`CHATGPT_REVIEW_DEFAULT_MODE` env var** — accept `manual` / `automated` /
   `parallel`; any other value is treated as unset.
4. **Hard default: `manual`.**

**Do NOT auto-detect mode from `OPENAI_API_KEY` presence.** That legacy
behaviour was removed (PR #441): having a key on the machine is not consent to
spend it. The operator opts into `automated`/`parallel` explicitly via tiers 1–3.

Mode meanings:

- `manual` — operator copies the artifact/diff into the ChatGPT UI and pastes
  the response back. No API key required, no API cost.
- `automated` — the agent calls the OpenAI API via `scripts/chatgpt-review.ts`.
  Requires `OPENAI_API_KEY`. Model: `CHATGPT_REVIEW_MODEL` (default `gpt-5.5`).
- `parallel` — both paths, interleaved, with the side-by-side compare panel.
  Requires `OPENAI_API_KEY`. Contract: `docs/review-pipeline/parallel-mode.md`.

The resolved MODE is recorded in the session log's Session Info block and
restored from there on resume (log wins over tiers 2–3 on resume).

**Session-log `Mode:` field accepts all three values** — `manual | automated | parallel`.

## AUTONOMY (blocking behaviour)

Two values: `attended` (interactive gates pause for the operator) |
`unattended` (surface-and-continue; never blocks).

MODE selects the review TRANSPORT only; it NEVER implies autonomy.

Resolution order — first hit wins:

1. Explicit operator phrase (`autonomous`/`unattended` → unattended;
   `attended`/`interactive` → attended).
2. Session-state file `.claude/session-state/review-autonomy` (single line:
   `attended` / `unattended`).
3. Dispatch context — on a FIRST (non-resumed) run dispatched as a sub-agent
   with no interactive operator, default `unattended` (a wait-for-input gate
   with no operator deadlocks).
4. Default `attended`.

On resume, the session log's recorded autonomy takes precedence over tiers 2–3;
if it cannot be restored, fail closed to `attended`. A resumed session is never
re-evaluated from dispatch context.

`unattended` semantics (identical across the three agents): HUMAN_IN_LOOP forced
`no`; user-facing/escalated findings surfaced-but-non-blocking and routed to
`tasks/todo.md`; `NEEDS_DISCUSSION` resolved conservatively and logged, never a
silent `APPROVED`; finalization auto-triggers on convergence; only genuine
tooling failures hard-stop.

## Invocation context (chatgpt-pr-review only)

`standalone` | `coordinator-invoked` — controls whether the agent runs its own
finalisation tail (merge/label/CI/auto-merge). See the INVOCATION CONTEXT block
in `chatgpt-pr-review.md`. Coordinators MUST pass `coordinator-invoked`
explicitly; sub-agent dispatch with unknown context fails safe to
`coordinator-invoked`.
