/**
 * chatgpt-review-api.ts
 *
 * Shared OpenAI Responses API caller. Both `scripts/chatgpt-review.ts` (the
 * production reviewer) and `scripts/verify-chatgpt-model.ts` (the smoke test)
 * MUST go through this module so the verifier exercises the same runtime
 * path as the reviewer — same endpoint, same body shape, same response
 * extraction, same error semantics. Pull the helper here, not into the
 * "pure" module, because it owns the fetch + JSON-parsing I/O that the
 * pure module is deliberately free of.
 */

import {
  extractResponsesApiText,
  extractServedModel,
  type ReasoningEffort,
} from './chatgpt-reviewPure.js';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export interface ResponsesMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ResponsesApiResult {
  content: string;
  servedModel: string | null;
}

interface OpenAIResponsesPayload {
  output_text?: string;
  output?: unknown[];
  model?: string;
  error?: { message?: string };
}

export async function callResponsesApi(opts: {
  apiKey: string;
  model: string;
  effort: ReasoningEffort;
  messages: ResponsesMessage[];
}): Promise<ResponsesApiResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    input: opts.messages,
    text: { format: { type: 'json_object' } },
  };
  if (opts.effort !== 'off') {
    body.reasoning = { effort: opts.effort };
  }
  const res = await fetch(OPENAI_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as OpenAIResponsesPayload;
  if (json.error) {
    throw new Error(`OpenAI API error: ${json.error.message ?? 'unknown'}`);
  }
  const content = extractResponsesApiText(json);
  if (!content.trim()) {
    throw new Error('OpenAI returned empty content');
  }
  return { content, servedModel: extractServedModel(json) };
}
