---
name: llm-integration
description: Use when building features that CALL an LLM — prompt assembly, model-output handling, LLM-driven tools/agents, scoring or judge harnesses, embeddings, or any pipeline where model output feeds subsequent logic. Engineering rules for treating the model as an unreliable, injectable, non-deterministic dependency.
---

# LLM integration engineering

The model is an external dependency that lies, reorders, truncates, and can be hijacked by its own inputs. Build accordingly.

## Trust and verification

- Never trust the model's self-report of a measurable transformation (shortened, deduplicated, translated, "I fixed it"). Compute the objective measure on the artifact itself and gate on that; the self-report is triage input only. A "success" failing the measure is a protocol violation routed to a typed failure.
- When validating that a model echoed a structured object unchanged, canonicalise both sides first (recursively sort object keys; arrays keep order) — models routinely reorder JSON keys, and naive stringify-comparison rejects every semantically-identical response.
- Model output claiming to be structured is authoritative only in schema-validated form: validate on receipt, quarantine non-conforming output rather than applying it, and never parse decisions out of prose. Credential/identity resolution from LLM tool input: see the security-hardening skill — never act on identities the model puts in a field.
- In scoring/judge harnesses, parser failure is a distinct outcome (`parse_error`), never a neutral passable score — conflating "our parser broke" with "genuine regression" hides integration bugs behind green checks. Prompt scale, threshold constant, and clamp must agree on the same 0-N scale, with the scale named in the constant — a mismatch makes the gate trivially pass while looking consistent.

## Prompt assembly

- Untrusted content (user text, documents, tool results, diffs, prior model output) goes in the user channel wrapped in an explicit trust boundary with a treat-as-data directive — never substituted into the system prompt. Diffs and documents frequently contain instruction-shaped text. Render untrusted strings length-capped and field-by-field from parsed structure (never a raw blob), delimiter-wrapped with an ignore-embedded-directives instruction, fence-sanitised on every projection path.
- If middleware truncates messages downstream, the trust wrapper must survive truncation: escape `<`/`>` in the body so a sliced wrapper cannot be broken out of; a code fence opened at the top loses its closing delimiter to the slice.
- Never silently truncate inputs to embeddings, summaries, rankers, or prompts: every cap is an exported named constant and every truncation emits a structured warning with sizes — silent truncation is a quality regression invisible in metrics.
- Text a user or a prior model produced, interpolated into a subsequent prompt, is an injection surface (second-order) — second-pass LLM inputs get the full untrusted treatment. The security boundary is the locked tool surface plus approval gates, not prompt wording.
- Feed the approved verbatim TEXT to the model, never the obligation enum label — when a governance flow approves specific wording (disclosures, consent copy), the prompt carries the approved text with a say-verbatim instruction; an enum token invites paraphrase of legally-loaded wording. Tell: `obligations.map(o => '- ' + o)` feeding a prompt while the approved text sits unused on the same context object.

## Operational shape

- Never hold a DB row lock or open transaction across an LLM call — classify-before-lock and the multi-item batch-claim loop shape: see the db-concurrency skill. The LLM-specific rule: per-item budget gates re-read committed state inside the loop — a multi-item claim freezes the budget read at batch start, and a wrapping transaction makes rollback re-bill everything.
- Classify provider failures before retrying: auth/quota/content-policy rejections are permanent (dead-letter immediately); timeouts/5xx are transient (rethrow to the retry policy). Collapsing the classes either burns retry budgets on the unfixable or delays operator action by the whole budget. One HTTP status can carry both meanings — providers return 403 for authorization failure AND throttling; parse the structured error-body reason inside the status branch (rate/quota reasons → retryable) before classifying, or operators get told to re-auth healthy connections.
- Verify assumed provider/library mechanics (idempotency-key support, webhook timing, callback field names, package name@version existence in the registry) against docs or live behaviour before pinning logic to them — LLM-plausible placeholders survive review. State unverified mechanisms as hypotheses with a verification step.
- LLM calls are expensive fan-out points: every new dispatch path joins the existing per-run/per-tenant budget counters and rate limits — new paths repeatedly bypass established ceilings.
- Tunable parameters (thresholds, decay, prompts under test) evolve via append-only versioned config with an active pointer, never in-place edits, so every run records which version produced its results.
- Deterministic evaluation needs cached/pinned fixtures; a harness scoring live model output cannot distinguish model drift from regression.
- Two-phase interactions with different user-channel trust semantics need separate system prompts — one prompt serving both phases inherits the weaker phase's assumptions.

## LLM-as-reviewer

For adjudicating findings from LLM reviewers (false-positive taxonomy, round management, convergence), use the `review-triage` skill. The one rule that belongs here: stateless reviewers have no memory — re-inject prior decisions and the current artifact every round, or the loop relitigates forever.
