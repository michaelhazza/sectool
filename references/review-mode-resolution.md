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
4. **Evidence-flip rung (DORMANT until the DG-4 criterion is met).** If
   `.claude/review-mode-flip` exists containing the single line `automated`,
   the default becomes `automated` instead of `manual`. The file lives at
   `.claude/review-mode-flip` — deliberately NOT under `.claude/session-state/`,
   which `/cleanfiles` treats as transient and deletes; the flip is a durable
   default, not a per-session mode. That file may ONLY be created by the
   operator, after the pinned flip criterion holds:
   **automated-tier catch-rate ≥ 90% of manual-tier on the repo's pinned eval
   suite AND ≤ 1 false positive per review, sustained across 3 consecutive
   measured framework-consuming builds each with a complete harness-metrics
   report** (`scripts/harness-metrics.ts`; see `references/harness-metrics.md`).
   An agent never creates or edits this file; absent file = rung skipped.
   Tiers 1–3 still override it — the operator can always force `manual`.
5. **Hard default: `manual`.**

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

## External-review artifact handoff — MANDATORY, ANY artifact, ANY route

**Binding on every artifact produced for a human to hand to an external reviewer**, whichever route produced it: a review agent's round loop, or a bare operator request ("give me a code-only diff", "link the spec", "export the plan for review"). The next section's round-loop rule is a *special case* of this one — it was written first and scoped only to the three ChatGPT agents, so an ad-hoc request bound nothing and the handoff was produced wrong. Hence this section.

### Where this binds — the full surface, not three places

**All three requirements (file in workspace + clickable link + reviewer prompt)** apply to every artifact that leaves for an external reviewer:

| Artifact | Produced by |
|---|---|
| **Spec** | `chatgpt-spec-review` (manual / parallel) |
| **Plan** | `chatgpt-plan-review` (manual / parallel) |
| **Code diff / PR** | `chatgpt-pr-review` (manual / parallel), or a bare operator request |
| **Brief** | `brief-reviewer` Round B — the ChatGPT direction pass |
| **Cross-tool handoff** | any document written FOR another tool to act on (e.g. a Codex handoff), whether or not a review agent produced it |

The brief tier is easy to forget because it has no Claude pre-screen and runs a single round; it is still an external handoff and still binds.

**Requirements 1 and 2 only (in workspace + clickable link; no prompt needed)** apply to *any* file the operator is told about and expected to open themselves — the prompt requirement is what distinguishes "someone else will review this" from "you will read this":

- mockups and prototypes (`prototypes/<slug>.html`) — `mockup-coordinator`, `mockup-designer`
- audit logs and review logs (`tasks/review-logs/**`) — `audit-runner` and every reviewer
- incident post-mortems (`docs/incidents/**`) — `regression-scribe`, `incident-commander`
- research briefs (`tasks/research-briefs/**`), codebase tours (`docs/codebase-tour.md`)
- generated capability artifacts (`docs/generated/**`)

**The simple test:** if a message tells the operator a file exists, that file is linked. If someone other than the operator will review it, it also ships a prompt.

Three requirements. All three, every time, in the SAME message:

**1. The file lives INSIDE the workspace.** Never outside the repo root, never in a system temp directory, never in a scratchpad. The operator's editor can only link, open and copy files inside the workspace, and copying into the external tool is the entire purpose of the artifact. If the file must not be committed, **gitignore it** — do not exile it. Exiling it to solve a commit-hygiene worry trades the deliverable's only function for a problem `.gitignore` already solves.

- Canonical path for a build's code diff: `tasks/builds/<slug>/code-only.diff`
- Canonical path for its companion prompt: `tasks/builds/<slug>/code-only-review-prompt.md`
- Add `tasks/builds/*/code-only.diff` to the consuming repo's `.gitignore` once; it then covers every future build.

**2. Link it clickably, in the editor's own format.** A bare absolute path like `c:\files\...\x.diff` is not a link and cannot be opened. Use a workspace-relative markdown link: `[code-only.diff](tasks/builds/<slug>/code-only.diff)`. Link the prompt the same way. State the size and file count so the operator knows what they are pasting.

**3. Ship a ready-to-paste reviewer prompt with it.** An artifact with no prompt is half a deliverable — the operator should never have to compose the ask. The prompt is a file (linked, per rule 2), not buried in chat, so it survives the scrollback. It must contain:
   - what the code **is**, and what it is **not** (e.g. "no application runtime code") so the reviewer calibrates;
   - **how to read the artifact** — multi-repo layout, why apparently-duplicated filenames are not duplicates, and where fixes must land;
   - **what to prioritise**, informed by where prior passes actually found defects;
   - an explicit **do-not-re-report** list (known/deferred) and a **verified-clean** list, so review budget is not spent re-deriving settled ground;
   - the **output format** wanted back.

**Verification before sending the message:** the file is inside the workspace; `git check-ignore` confirms it cannot be committed (when it should not be); the link is workspace-relative; the prompt file exists and is linked too. A message that names a path but does not link it fails this rule.

## Next-round artifact discipline (manual + parallel) — MANDATORY

Binding on `manual` AND `parallel` in all three review agents. `automated`-only
is the sole exemption (no human upload step).

**Always assume another round is coming.** At the END of every round, BEFORE the
round summary is printed, the agent produces the round-N+1 bundle — the updated
artifact, the `PROJECT_CONTEXT` refreshed with this round's applied findings in
its do-not-re-raise register, the pinned artifact hash, and a ready-to-paste
prompt — with clickable links in the SAME message. Applies even on a zero-change
round. Stop only on an explicit `proceed` / `approved` / `done`; silence, a
question, or a hedge is not a stop signal.

Canonical text and per-agent detail live in each agent's
`### Next-round artifact discipline` section (`chatgpt-pr-review.md`,
`chatgpt-spec-review.md`, `chatgpt-plan-review.md`). Recorded here because this
rule was missed repeatedly when it existed only in one agent, and MODE is the
first thing every reviewer resolves.

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
