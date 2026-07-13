# Parallel Mode — split-test automated OpenAI vs manual ChatGPT-web

**Audience:** the three review agents (`chatgpt-pr-review`, `chatgpt-spec-review`, `chatgpt-plan-review`) and the operator driving them.

**Purpose:** run both the automated OpenAI path AND the manual ChatGPT-web path on the same artefact, then render a side-by-side compare panel before triage. Captures both outputs and operator tuning notes in the session log so the OpenAI prompts can be A/B'd over time. End state: OpenAI consistently catches what ChatGPT-web catches plus things it misses, at which point the operator flips the default mode to `automated` and demotes `manual` to fallback.

This contract is shared by all three agents. Each agent file documents its mode-specific entry hooks but defers to this file for the loop shape, compare-panel rendering, log schema, and config gate.

---

## Modes (canonical set)

The three review agents accept these `MODE` values:

| Value | Path | Cost | Default for |
|---|---|---|---|
| `manual` | Operator pastes artefact into ChatGPT-web, pastes response back. | $0 (operator's ChatGPT subscription) | Today |
| `automated` | Agent calls `scripts/chatgpt-review.ts` via OpenAI API. | Per-call (≈$0.50–$2 per round) | Future (once parallel-mode A/B'ing shows OpenAI is consistently ≥ ChatGPT-web) |
| `parallel` | Both run on the same artefact; agent renders compare panel before triage. | Per-call PLUS operator time | A/B tuning sessions |

**Mode resolution order (highest priority first):**
1. Explicit operator phrase at invocation: `"automated"` / `"manual"` / `"parallel"` keyword in the request.
2. `CHATGPT_REVIEW_DEFAULT_MODE` env var: `manual` | `automated` | `parallel`.
3. Hard default: `manual` (so a missing env var on a fresh machine never burns OpenAI tokens without operator intent).

The resolved mode is recorded in the session log Session Info block under `Mode:` and restored on resume. If the resumed invocation specifies a different mode than the log records, the agent warns and uses the log's mode (continuity over re-derivation).

---

## Parallel-mode loop (per round)

The agent runs both halves of the round in interleaved order so the operator's wall-clock wait is minimised: kick off the OpenAI CLI in the background, then immediately generate the ChatGPT-web diff bundle so the operator can start uploading while the OpenAI call is in flight.

1. **Generate the artefact bundle** as manual mode does (PR: code-only + full diff files in `.chatgpt-diffs/`; spec/plan: the file itself).
2. **Kick off the OpenAI CLI in the background**, pinning input redirection per mode (PR reads diff from stdin; spec/plan use `--file`). Capture stdout to a temp file; do NOT block on it. Note the background process id in `progress.md` for resume safety. **Do not omit the redirection** — `scripts/chatgpt-review.ts`'s `readStdin` only resolves on the EOF event, so a backgrounded process without input deadlocks silently and the operator sees no symptom while the wait loop runs.

   ```bash
   # PR mode: pipe the round's diff file into stdin. Keep stderr in its own
   # file so the JSON capture stays clean — the CLI writes operational warnings
   # (repair-retry kicks, model-mismatch warnings, schema-fail logs) to stderr,
   # and `2>&1` would merge those into the JSON file, breaking the
   # parseReviewResult path.
   npx tsx scripts/chatgpt-review.ts --mode pr \
     < .chatgpt-diffs/<round-file>.diff \
     > <openai-json-file> \
     2> <openai-stderr-file> &

   # Spec mode:
   npx tsx scripts/chatgpt-review.ts --mode spec --file <spec-path> \
     > <openai-json-file> \
     2> <openai-stderr-file> &

   # Plan mode:
   npx tsx scripts/chatgpt-review.ts --mode plan --file <plan-path> \
     > <openai-json-file> \
     2> <openai-stderr-file> &
   ```
3. **Print the operator instructions:** show the diff/spec/plan upload link AND a note that the OpenAI call is running in the background. Phrasing: `OpenAI call started (background). Upload the diff to ChatGPT, then paste the response back; the agent will assemble the compare panel once both are in.`

   **Include in the operator-paste prompt template the following 4 reviewer-discipline rules** (L2 + L4 + L5 + L6 from the 9-round admin-partner-console learning, May 2026; codified to address the 3 false positives that emerged across rounds R1 and R8):

   ```
   HARD RULES for ChatGPT-web review:

   L2 — Negative-claim citation. For every NEGATIVE claim ("I could not find X",
        "the diff appears to be missing Y"), quote the literal search string you
        used and the file path you'd expect it in.

   L5 — Quoted search RESULTS (refinement of L2). The Negative-claim audit must
        also quote the result count + a representative match line (or the
        explicit empty-result acknowledgement). Pattern:
          > Searched: `grep -n withPartnerScope server/src/services/accountService.ts`
          > Result count: 0
          > Representative match: (none — confirms absence)
        A negative claim without a quoted search result is downgraded to Consider
        regardless of the claimed severity.

   L4 — Diff size discipline. If the diff exceeds ~5,000 lines or ~200 KB,
        split the operator paste into two messages (server-only and
        frontend-only) sharing the same PR_CONTEXT, rather than risking
        under-scanning a single large message.

   L6 — Acknowledged false-positive recovery. If PRIOR_ROUNDS contains a finding
        the coordinator marked FALSE POSITIVE: (a) do NOT re-raise; (b) confirm
        you re-verified the alleged gap in your verified-clean notes; (c) treat
        the false-positive disposition as canonical unless your evidence
        contradicts it with quoted search results.
   ```

   These rules also apply to the OpenAI side via SYSTEM_PROMPT_PR_V2 / SYSTEM_PROMPT_PLAN_V2 / SYSTEM_PROMPT_SPEC_V2; including them in the operator paste keeps the two tiers calibrated.
4. **Wait for the operator paste.** When the operator pastes the ChatGPT-web response, the agent:
   - Extracts findings from the pasted text using the agent's existing manual-mode extraction logic (NL parsing of the numbered list — same as today's manual flow).
   - Polls the background CLI; if not yet complete, waits for it (do NOT prompt the operator again — the wait is silent).
   - On CLI completion: validates the JSON via the existing `parseReviewResult` path. If the OpenAI side fails (quarantined, parse_fail, etc.): record the failure in the round log, but still render the panel with `(OpenAI side: <failure-kind>)` in place of OpenAI findings. The operator drives triage on the ChatGPT-web side alone for this round. Do NOT abort the round.
5. **Build and render the compare panel.** Call `compareFindingSets(openai_findings, chatgpt_findings)` then `renderComparePanel(result)` from `scripts/chatgpt-reviewPure.ts`. Print the panel to chat in full (do NOT collapse — operator needs to read every row to A/B tune).
6. **Ask which finding set drives triage.** Present three options to the operator: `(a) overlap only`, `(b) union (all findings)`, `(c) operator selection — list IDs to keep`. Default `(b)` for first few rounds (catches the most issues while A/B'ing); operator may shift to `(a)` once OpenAI consistently catches the ChatGPT-web set.
7a. **Run pre-triage learning analysis** (Channels 1 + 2 only — see § Learning analysis — Step 7 below). This is the closed-loop step that improves the OpenAI prompt every round and is the load-bearing reason parallel mode exists at all. Operator may skip with `skip learning` if the round is being driven by other priorities.
8. **Run triage** on the chosen finding set using the agent's existing triage flow (technical → auto-act, user-facing → operator-approval). No change to this part. Capture any operator rejections of OpenAI findings for use by Step 7b.
8b. **Run post-triage learning analysis** (Channel 3 only) — propose anti-hunt rules for any OpenAI findings the operator rejected as false positives. Skipped automatically when zero rejections fired.
9. **Append the round to the session log** per the schema below. The compare panel + both raw outputs + the learning analysis outcome (both passes) persist verbatim.

---

## Learning analysis — Step 7

Triggered after the compare panel renders. Without this step, parallel mode is just a comparison view; with it, every round teaches the OpenAI prompt something new and moves the system toward the Phase 3 flip to fully automated. **This is the part that retires the manual half.**

### Three learning channels

The agent inspects the compare result and identifies learning opportunities in each of the three channels below. For each opportunity, the agent produces a **proposal** — a specific, minimal edit to the OpenAI prompt for the current mode — and surfaces it for operator approval before applying.

**Channel 1 — ChatGPT-only findings (the main signal).** Every finding in `result.chatgptOnly` is something the OpenAI prompt is currently blind to. For each one, the agent:

1. Reads the OpenAI system prompt for the mode (`SYSTEM_PROMPT_PR_V2` / `SYSTEM_PROMPT_SPEC_V2` / `SYSTEM_PROMPT_PLAN_V2` in `scripts/chatgpt-reviewPure.ts`).
2. Identifies the specific gap — most often a missing hunt-target bullet, occasionally a missing process-pass instruction, occasionally a missing example. Reverse-engineering question: "what single line, if added to this prompt, would make a future OpenAI run catch a finding of this shape?"
3. Proposes a minimal patch: a one-bullet addition (or one paragraph at most) anchored to a specific spot in the prompt. Avoids broad rewrites — small targeted additions accumulate over rounds without making the prompt unwieldy.

**Channel 2 — High severity-calibration deltas.** Any overlap row where `|severityDelta| >= 2` (e.g. ChatGPT-web rated `high`, OpenAI rated `low`) is a calibration miss. The agent proposes a sharpening of the severity-recalibration pass in the prompt — typically a new trigger phrase under one of the existing severity bands.

**Channel 3 — Operator-rejected OpenAI findings (anti-hunt).** When the operator marks an OpenAI finding as a false positive during triage, the agent proposes an anti-hunt rule to suppress similar false positives in future rounds. (Stretch goal; this channel may fire zero proposals per round.) **Sequencing note:** Channel 3 depends on triage having already produced rejection signals, so it fires AFTER Step 8 (triage), not at Step 7 alongside Channels 1 and 2. The Step 7 round is therefore split into two passes: Step 7a (pre-triage) runs Channels 1 and 2 only; Step 7b (post-triage) runs Channel 3 only. Both passes append to the same `tasks/review-logs/prompt-evolution-log.md`.

### Per-proposal operator gate

**Eval-gated auto-apply (symmetric trust, DG-7).** Before surfacing a proposal, check whether the repo carries a pinned eval suite for the affected prompt (`eval/<suite>/baseline.json` present for the mode's prompt module). If it does: apply the patch provisionally, run the suite (`npx tsx scripts/eval-prompts.ts <suite>`), and
- **suite passes** (no regression beyond threshold on catch rate or false-alarm rate) → the proposal is auto-apply eligible under the same four-key gate as code findings; apply it, log the eval scores next to the entry in `prompt-evolution-log.md`, and report it in the round summary as `auto-applied (eval-gated)`. No operator interaction consumed.
- **suite fails or errors** → revert the patch and surface the proposal to the operator as below, with the eval failure attached.
Repos without a pinned suite for that prompt see no change: every proposal surfaces to the operator as before.

For each proposal that surfaces (no suite, or suite failed), the agent presents in chat:
- **Channel:** which of the three above
- **Source finding:** the ChatGPT-web finding (or severity-delta pair, or rejected OpenAI finding)
- **Diagnosis:** one sentence on what the OpenAI prompt is currently missing
- **Edit location:** file:line range with anchor text
- **Patch:** before/after text, exact bytes
- **Risk:** any concern about over-fitting or unintended hunting

Operator response options per proposal: `apply`, `reject`, `defer` (record but don't apply), or `discuss`. There is also a `apply all` shortcut for runs where the operator trusts the agent's judgement.

### Apply protocol

When the operator approves a proposal, the agent:

1. Edits `scripts/chatgpt-reviewPure.ts` with the patch.
2. Re-runs the targeted unit tests (`npx vitest run scripts/__tests__/chatgpt-reviewPure.test.ts`) to confirm no regression. If a test fails, the edit is reverted and the failure is logged. Do NOT attempt to fix the test in the same round — that's a separate engineering task.
3. Appends an entry to `tasks/review-logs/prompt-evolution-log.md` using the template in that file's header. Every edit is recorded with rationale, before/after, operator decision, and test outcome.
4. Records the apply in the round's session log alongside the round's triage.

**Note on framework canonical:** `scripts/chatgpt-reviewPure.ts` (including the prompts) has been **framework-managed since v2.8.0** — it syncs from the framework submodule. A learning edit applied in a consuming repo therefore marks the file `customisedLocally` and will surface as a `.framework-new` merge on the next framework sync. That is the intended flow: tune locally, and when an edit proves out, upstream it to the framework repo (open a PR there) so the improvement cascades to every consuming project instead of being re-derived per repo.

### When the learning step does nothing

If `chatgptOnly.length === 0` AND no overlap row has `|severityDelta| >= 2` AND no operator false-positive flags fired: the agent prints `_Learning analysis: no proposals this round (zero ChatGPT-only findings, severity calibration aligned)._` and continues straight to triage.

The Phase 3 flip-to-automated is criterion-triggered, not vibe-triggered. The pinned criterion (DG-4, 2026-07-10) lives in `references/review-mode-resolution.md` § MODE rung 4: automated-tier catch-rate ≥ 90% of manual-tier on the pinned eval suite AND ≤ 1 false positive per review, sustained across 3 consecutive measured framework-consuming builds each with a complete harness-metrics report. Zero learning proposals across consecutive rounds is supporting evidence, not the trigger.

---

## Compare-panel rendering

`renderComparePanel(result)` in `scripts/chatgpt-reviewPure.ts` returns a markdown block with these sections (omitted when empty):

- Header line with counts: `OpenAI N | ChatGPT-web N | overlap N (X OpenAI-only, Y ChatGPT-web-only)`
- Severity calibration: `mean |Δ| = 0.00` (0 = both sides assigned the same severity to overlap findings)
- `Overlap (matched findings)` table: score | OpenAI severity | ChatGPT severity | Δ | titles
- `OpenAI-only findings` list with severities and affected files
- `ChatGPT-web-only findings` list — same shape

Matching is deterministic and pure (no LLM): Jaccard over normalised title word sets, weighted 70%, plus affected-files overlap weighted 30%. Default match threshold 0.45 (combined). Configurable via the function's options for experimentation.

---

## Session log schema additions for parallel mode

Each round entry in the session log gains four sub-sections in parallel mode (in addition to the existing triage section):

```
## Round N (mode: parallel)

### OpenAI raw response
<verbatim JSON from scripts/chatgpt-review.ts stdout, or `(failed: <kind>)`>

### ChatGPT-web raw response
<verbatim operator paste>

### Compare panel
<output of renderComparePanel — markdown block, copied as-is>

### Learning analysis 7a (pre-triage, Channels 1 + 2)
<per-proposal block per chatgpt-only finding and per severity-delta overlap: channel, source finding, diagnosis, edit location, before/after, risk note, operator decision (apply/reject/defer/discuss), apply result if any (test outcome, prompt-evolution-log entry id)>

### Operator decision
- Driving set: <overlap | union | custom>
- Custom IDs (if applicable): <list>
- Tuning notes: <operator's freeform notes — what OpenAI missed, where calibration was off, prompt-improvement candidates>

### Triage
<unchanged from existing schema>

### Learning analysis 7b (post-triage, Channel 3)
<per-proposal block per OpenAI finding rejected by operator during triage: channel, rejected finding, anti-hunt rule proposal, operator decision, apply result. This sub-section may be omitted entirely when zero rejections fired.>
```

The `Operator decision → Tuning notes` field is the load-bearing one for A/B history. Every round's notes feed into the eventual decision to flip default-mode to `automated`. The operator may leave it empty; the panel itself is the audit trail.

---

## Failure handling

- **OpenAI CLI quarantines (exit 4 / 5 / 6)** → record `(OpenAI side: <kind>)` in the round, continue with ChatGPT-web only. The quarantined response is already in `tasks/review-logs/quarantined/`; the round log links to it. This is itself signal for prompt-tightening.
- **Operator never pastes ChatGPT-web response** → resume picks up where the agent left off; OpenAI background stdout is in the temp file. Re-running the round just re-prompts the operator.
- **CHATGPT_REVIEW_DEFAULT_MODE set to `parallel` but OPENAI_API_KEY missing** → agent prints a one-line error at start: `parallel mode requires OPENAI_API_KEY (or use 'manual' / set CHATGPT_REVIEW_DEFAULT_MODE=manual)` and stops. No silent fallback to manual — environment surprises are worse than an explicit stop.

---

## Flipping to fully automated (Phase 3 transition)

Once parallel-mode A/B sessions consistently show OpenAI catching the ChatGPT-web finding set + things ChatGPT-web missed, the operator flips:

1. Set `CHATGPT_REVIEW_DEFAULT_MODE=automated` in shell or `.env`.
2. Existing manual / parallel invocations still work when the operator names the mode explicitly.
3. Eventually, manual mode is demoted to fallback — used only when `OPENAI_API_KEY` is unavailable or the operator wants a sanity check on a specific finding.

There is no separate "v1 deprecation" pass on the manual flow. The mode survives in the agent definitions indefinitely as a fallback; only the default changes.
