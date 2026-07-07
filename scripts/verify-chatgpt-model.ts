#!/usr/bin/env tsx
/**
 * verify-chatgpt-model.ts
 *
 * Smoke test for the OpenAI Responses API model routing. Sends a tiny prompt
 * through the SAME runtime path as the production reviewer — callResponsesApi
 * in scripts/chatgpt-review-api.ts (same endpoint, body shape, response
 * extraction, timeout, and retry semantics) — then compares the requested
 * model against the model OpenAI actually served.
 *
 * Use this before/after changing CHATGPT_REVIEW_MODEL to confirm OpenAI
 * routes the requested model rather than silently substituting another one.
 *
 * Usage:
 *   npx tsx scripts/verify-chatgpt-model.ts
 *   CHATGPT_REVIEW_MODEL=gpt-5.5 npx tsx scripts/verify-chatgpt-model.ts
 *
 * Env:
 *   OPENAI_API_KEY           required (a local .env is loaded when dotenv
 *                            is installed, same as chatgpt-review.ts)
 *   CHATGPT_REVIEW_MODEL     optional, default: gpt-5.5
 *   CHATGPT_REVIEW_EFFORT    optional reasoning effort, default: minimal
 *   CHATGPT_REVIEW_TIMEOUT_MS optional per-request timeout in ms (default: 120000)
 *
 * Exit codes:
 *   0  served model matches the requested model
 *   3  model mismatch (OpenAI served a different model)
 *   2  API error (network, HTTP, timeout after retries) or missing API key
 */

import { createRequire } from 'node:module';
import { compareModels, parseReasoningEffort } from './chatgpt-reviewPure.js';
import { callResponsesApi } from './chatgpt-review-api.js';

// Dev-tool convenience: load OPENAI_API_KEY from a local .env when present.
// Optional — guarded so repos without the `dotenv` package are unaffected.
// Safe here for the same reason as in chatgpt-review.ts: the key is read
// lazily inside main(), never at module-import time.
try {
  createRequire(import.meta.url)('dotenv/config');
} catch {
  /* dotenv not installed — rely on the ambient environment */
}

const DEFAULT_MODEL = 'gpt-5.5';
const EXIT_API_ERROR = 2;
const EXIT_MODEL_MISMATCH = 3;

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    process.stderr.write('error: OPENAI_API_KEY is not set\n');
    process.exit(EXIT_API_ERROR);
  }

  const model = process.env.CHATGPT_REVIEW_MODEL || DEFAULT_MODEL;
  const effort = parseReasoningEffort(process.env.CHATGPT_REVIEW_EFFORT || 'minimal');

  let servedModel: string | null;
  try {
    // Tiny prompt; must mention JSON because the shared caller requests
    // json_object output format.
    const result = await callResponsesApi({
      apiKey,
      model,
      effort,
      messages: [{ role: 'user', content: 'Reply with the JSON object {"ok": true}.' }],
    });
    servedModel = result.servedModel;
  } catch (err) {
    process.stderr.write(
      `error: OpenAI API call failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(EXIT_API_ERROR);
  }

  const match = compareModels(model, servedModel);
  process.stdout.write(
    `requested model: ${match.requested_model}\n` +
      `served model:    ${match.served_model ?? '(missing model field)'}\n` +
      `match:           ${match.model_match ? 'yes' : 'NO'}\n`,
  );

  if (!match.model_match) {
    process.exit(EXIT_MODEL_MISMATCH);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT_API_ERROR);
});
