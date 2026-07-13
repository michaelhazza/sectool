# Eval suite format

The pinned on-disk contract for a golden-set prompt eval suite. The framework ships the runner (`scripts/eval-prompts.ts` + `scripts/eval-promptsPure.ts`), the `/eval-prompts` command, and this spec; **repos own their suites** (`eval/<suite>/`).

## Why golden-set evals

A prompt change should land only if it does not regress catch rate (true-positive rate) or spike false alarms. A suite pins a labeled corpus and a last-accepted baseline; the runner scores the current prompt against the baseline and fails when a regression exceeds the configured threshold. The numbers are only trustworthy if the output→verdict mapping is unambiguous — hence the strict normalizer (no fuzzy keyword guessing).

## Suite layout

```
eval/<suite>/
  config.json      # runner configuration
  cases.jsonl      # one labeled case per line
  baseline.json    # last-accepted scores — written by --accept
```

## config.json

```json
{
  "promptModule": "./eval/support-reply/prompt.ts",
  "provider": "openai",
  "model": "gpt-5.5",
  "normalizer": "./eval/support-reply/normalizer.ts",
  "threshold": { "catchRateDrop": 0.05, "falseAlarmRise": 0.05 },
  "notes": "seeded from review-mining findings 2026-Q2"
}
```

| Field | Required | Meaning |
|---|---|---|
| `promptModule` | yes | Importable module whose callable takes a case `input` and returns the model-facing prompt for that case. |
| `provider` | yes | LLM seam. v1 ships only `openai`; an unknown provider is a hard error. |
| `model` | no | Model override; else `EVAL_PROMPTS_MODEL` env, else `gpt-5.5`. |
| `normalizer` | no | Importable module mapping raw prompt output → `{ verdict, label? }`. Omitted → the strict default normalizer. |
| `threshold.catchRateDrop` | yes | Max tolerated catchRate decrease vs baseline. |
| `threshold.falseAlarmRise` | yes | Max tolerated falseAlarmRate increase vs baseline. |
| `notes` | no | Provenance / free text. |

### promptModule contract

The module's callable (default export or `module.exports` function) receives one case's `input` and returns (synchronously or as a Promise — the runner `await`s it) one of:

- a `string` — treated as the user message;
- an object `{ system?, user }` — assembled into system + user messages;
- a `ResponsesMessage[]` (`{ role, content }[]`) — used as-is (each entry validated for `role` + string `content`).

Any other shape is a hard error — the adapter never guesses.

### normalizer contract

`(raw: string) => { verdict: "issue" | "clean", label? } | { malformed: string }` (sync or async — the runner `await`s it, and validates the returned shape; a wrong-cased or unknown verdict is coerced to `malformed` rather than trusted). Omitting `normalizer` uses the **strict default**: the raw output MUST be JSON carrying `verdict: "issue" | "clean"`. Non-JSON output, a non-object, or a missing/invalid verdict marks that case **malformed**, and the run **fails** (non-zero) naming the offending case id. There is NO fuzzy issue-detection fallback: a keyword guess would make the golden-set numbers untrustworthy. Suites whose target prompt does not emit JSON must supply an explicit `normalizer`.

## cases.jsonl

One JSON object per non-blank line. Required keys: `id`, `input`, `expected`, `notes`, `source`.

```jsonl
{ "id": "rev-0012", "input": { "diff": "..." }, "expected": { "verdict": "issue", "label": "sql-injection" }, "notes": "adjudicated true positive", "source": "review-mining#0012" }
{ "id": "rev-0044", "input": { "diff": "..." }, "expected": { "verdict": "clean" }, "notes": "clean control", "source": "review-mining#0044" }
```

- `input` is fed to `promptModule`; its shape is suite-defined.
- `expected` is an object `{ verdict: "issue" | "clean", label? }`. `verdict: "issue"` means the target prompt SHOULD flag this input; `verdict: "clean"` means it should NOT. **v1 scores on `verdict` only** — `label` is carried for reporting, not scoring. Richer / graded scoring is a post-v1 extension.
- `notes` / `source` are provenance (e.g. a review-mining finding id).

## baseline.json

Written by `--accept`; never hand-edited in normal flow.

```json
{ "catchRate": 0.92, "falseAlarmRate": 0.04, "at": "2026-07-09T12:00:00.000Z", "commit": "abc1234" }
```

## Metrics (pinned)

- `catchRate` = (# `expected.verdict === "issue"` cases the prompt flagged) / (# `issue` cases). Higher is better.
- `falseAlarmRate` = (# `expected.verdict === "clean"` cases the prompt flagged) / (# `clean` cases). Lower is better.
- A suite with zero `issue` (or zero `clean`) cases reports the corresponding rate as `null`; it is excluded from threshold comparison.

## Run semantics

- `/eval-prompts <suite>` — score vs baseline; **exit 1** on a threshold breach or any malformed case.
- `/eval-prompts <suite> --accept` — seed/refresh `baseline.json` from this run (the only write path). Refuses if any case is malformed.
- `/eval-prompts <suite> --dry-run` — print scores, no comparison, exit 0.
- **Missing baseline:** a normal run against a suite with no `baseline.json` exits **non-zero** with `no baseline for suite <suite> — run '/eval-prompts <suite> --accept' to seed one`. It never silently passes (that would let the first prompt change ship unmeasured). `--accept` and `--dry-run` are the two escapes.
- **LLM non-determinism** is the inherent variance the catch/false-alarm rates and thresholds absorb. Size a suite so noise stays under the threshold. Provider failures throw (reusing `chatgpt-review-api.ts` retry/timeout) — never a silent pass.

## Not shipped

`tasks/knowledge-to-framework-skills-map.md` is unrelated to eval suites (it belongs to the skill-overlay drain, `references/skill-overlay-convention.md`). No eval suite ships with the framework — the format spec + `/framework-doctor` Check 8 are the framework's testable surface; consuming repos author their own suites (e.g. automation-v1 seeds cases from `tasks/review-mining` and wires `/eval-prompts` into its parallel-mode Step 7 — consumer-side follow-ups, out of scope for the framework).
