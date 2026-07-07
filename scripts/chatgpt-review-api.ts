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
 *
 * Robustness:
 * - Every request runs under an AbortController timeout — default 120000 ms,
 *   overridable via the CHATGPT_REVIEW_TIMEOUT_MS env var.
 * - Transient failures — HTTP 429, HTTP 5xx, network errors, and timeouts —
 *   are retried up to 2 times with exponential backoff (2s, then 4s).
 *   Non-transient failures (other HTTP statuses, error payloads, empty
 *   content) throw immediately with the original error semantics.
 */

import {
  extractResponsesApiText,
  extractServedModel,
  type ReasoningEffort,
} from './chatgpt-reviewPure.js';

export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

/** Default per-request timeout; override with CHATGPT_REVIEW_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 120_000;

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [2_000, 4_000];

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

/** Internal error carrying retry classification for HTTP/payload failures. */
class ApiCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

function resolveTimeoutMs(): number {
  const raw = process.env.CHATGPT_REVIEW_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an attempt failure: AbortError (timeout) and fetch network errors
 * are retryable; ApiCallError carries its own flag from the HTTP status.
 */
function classifyFailure(err: unknown, timeoutMs: number): { error: Error; retryable: boolean } {
  if (err instanceof ApiCallError) {
    return { error: err, retryable: err.retryable };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      error: new Error(`OpenAI API request timed out after ${timeoutMs}ms`),
      retryable: true,
    };
  }
  // fetch rejects with a TypeError on network failure — treat any other
  // non-ApiCallError as a transport-level error and retry.
  return { error: err instanceof Error ? err : new Error(String(err)), retryable: true };
}

/** One request/parse cycle. Throws ApiCallError for HTTP/payload failures. */
async function attemptOnce(
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
): Promise<ResponsesApiResult> {
  const res = await fetch(OPENAI_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiCallError(
      `OpenAI API ${res.status}: ${text.slice(0, 500)}`,
      isRetryableStatus(res.status),
    );
  }
  const json = (await res.json()) as OpenAIResponsesPayload;
  if (json.error) {
    throw new ApiCallError(`OpenAI API error: ${json.error.message ?? 'unknown'}`, false);
  }
  const content = extractResponsesApiText(json);
  if (!content.trim()) {
    throw new ApiCallError('OpenAI returned empty content', false);
  }
  return { content, servedModel: extractServedModel(json) };
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

  const timeoutMs = resolveTimeoutMs();
  let lastError: Error = new Error('OpenAI API call failed before any attempt');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BACKOFF_MS[attempt - 1];
      process.stderr.write(
        `warn: OpenAI API attempt ${attempt} failed (${lastError.message.slice(0, 200)}) — retrying in ${delay / 1000}s\n`,
      );
      await sleep(delay);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // The signal covers the full attempt — response body reads included —
      // so a stalled body cannot hang past the timeout either.
      return await attemptOnce(body, opts.apiKey, controller.signal);
    } catch (err) {
      const { error, retryable } = classifyFailure(err, timeoutMs);
      if (!retryable || attempt === MAX_RETRIES) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable: the final iteration either returns or throws.
  throw lastError;
}
