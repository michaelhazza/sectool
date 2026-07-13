---
description: Run a golden-set prompt eval suite — score catch rate + false-alarm rate against the pinned baseline and fail on a regression beyond threshold, so a prompt change lands only if its suite still passes
---

# /eval-prompts

Run a repo-local golden-set eval suite through its target prompt and score it against the last-accepted baseline. Use before shipping a prompt change: the change lands only if its suite still passes. Suites are repo-owned under `eval/<suite>/`; the framework ships the runner + the format spec (`references/eval-suite-format.md`) + `/framework-doctor` Check 8.

## What to do

1. **Confirm the suite exists.** `eval/<suite>/` must carry `config.json` and `cases.jsonl`. If not, point the operator at `references/eval-suite-format.md` to author one. Do not fabricate a suite.

2. **Run the suite.** The runner loads `.env` itself (guarded dotenv), so no shell env-loading preamble is needed:

   ```
   npx tsx scripts/eval-prompts.ts <suite>
   ```

   It prints `catchRate` / `falseAlarmRate` (with issue/clean counts) and exits:
   - **0** — within baseline thresholds (PASS).
   - **1** — a regression beyond `threshold` OR one or more malformed cases OR no baseline yet. Read the `REGRESSION:` / malformed lines on stderr.
   - **2** — usage or config error (bad args, missing/invalid `config.json` or `cases.jsonl`).
   - **3** — provider / runtime failure (e.g. the model was unreachable). Kept distinct from 2 so a CI wrapper can tell a retryable network blip from a permanent misconfiguration.

3. **Seed or refresh the baseline** (explicit, operator-driven — the only write path):

   ```
   npx tsx scripts/eval-prompts.ts <suite> --accept
   ```

   Writes the current scores to `eval/<suite>/baseline.json`. Refuses if any case is malformed. Use this the first time a suite runs (a normal run with no baseline exits non-zero by design — it never silently passes) and whenever you deliberately accept a new prompt as the reference.

4. **Preview without comparing:**

   ```
   npx tsx scripts/eval-prompts.ts <suite> --dry-run
   ```

   Prints scores and exits 0 with no baseline comparison.

## Integration contract

A prompt change lands only if its suite passes. A consuming repo wires this into its own review pipeline — e.g. automation-v1's parallel-mode Step 7 prompt-evolution runs the relevant suite before accepting a prompt edit (a consumer-side follow-up, not shipped by the framework). Keep suites sized so LLM non-determinism stays under the configured threshold.

## Env

- `OPENAI_API_KEY` — required for the `openai` provider (from `.env` or the environment; never committed).
- `EVAL_PROMPTS_MODEL` — optional model override (default `gpt-5.5`).
- `EVAL_PROMPTS_EFFORT` — optional reasoning effort `minimal|low|medium|high|off` (default `off`).

## Arguments

`$ARGUMENTS` — the suite name (a directory under `eval/`), optionally followed by `--accept` or `--dry-run`.
