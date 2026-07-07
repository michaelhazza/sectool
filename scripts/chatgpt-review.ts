#!/usr/bin/env tsx
/**
 * chatgpt-review.ts
 *
 * Dev-tool CLI that calls the OpenAI Responses API (reasoning models) to
 * produce a ChatGPT-style code, spec, or plan review. Replaces the manual
 * copy/paste loop in the chatgpt-pr-review, chatgpt-spec-review, and
 * chatgpt-plan-review agents.
 *
 * The CLI is stateless: input → JSON findings on stdout. The agent owns
 * the per-round session log, the user-approval flow, and the KNOWLEDGE.md
 * finalisation step.
 *
 * Architecture:
 * - Bypasses server/services/providers/llmRouter on purpose. This is a
 *   developer-machine tool with its own OPENAI_API_KEY, not application code.
 *
 * Usage:
 *   echo "<diff>" | tsx scripts/chatgpt-review.ts --mode pr
 *   tsx scripts/chatgpt-review.ts --mode spec --file docs/my-spec.md
 *   tsx scripts/chatgpt-review.ts --mode plan --file tasks/builds/foo/plan.md
 *
 * Env:
 *   OPENAI_API_KEY                       required
 *   CHATGPT_REVIEW_MODEL                 optional, default: gpt-5.5
 *   CHATGPT_REVIEW_EFFORT                optional reasoning effort:
 *                                        minimal | low | medium | high | off (default: high)
 *                                        set to "off" when overriding to a non-reasoning model
 *   CHATGPT_REVIEW_REQUIRE_MODEL_MATCH   when truthy (1|true|yes), fail with exit 3
 *                                        if OpenAI serves a different model than requested.
 *                                        Default: off (warn only).
 *   CHATGPT_REVIEW_PROMPT_VERSION        prompt version to send (default: 2)
 *   CHATGPT_REVIEW_TIMEOUT_MS            optional per-request timeout in ms
 *                                        (default: 120000; see chatgpt-review-api.ts)
 *
 * Exit codes:
 *   0  ok — result written to stdout
 *   2  API error or bad arguments (existing)
 *   3  model mismatch in strict mode (existing)
 *   4  schema_fail after repair attempt (quarantined)
 *   5  parse_fail after repair attempt (quarantined)
 *   6  version_mismatch (no repair retry)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildAdHocPromptVars,
  buildInputSummary,
  buildRepairPrompt,
  compareModels,
  getSystemPrompt,
  getUserPromptTemplate,
  OUTPUT_ENVELOPE_SKELETON,
  parseModelOutput,
  parseReasoningEffort,
  parseReviewResult,
  parseStrictModelMatch,
  setReviewResultValidator,
  substitutePromptPlaceholders,
  SYSTEM_PROMPT_REPAIR_V2,
  type ChatGPTReviewResult,
  type ParseOptions,
  type ReasoningEffort,
  type ReviewMode,
} from './chatgpt-reviewPure.js';
import { callResponsesApi } from './chatgpt-review-api.js';

// Dev-tool convenience: load OPENAI_API_KEY from a local .env when present.
// Optional — guarded so repos without the `dotenv` package are unaffected.
//
// Ordering note: ESM static imports above evaluate before this block, so this
// only works if no imported module reads the key at import time. Verified: the
// sole consumer reads `process.env.OPENAI_API_KEY` lazily inside main() at
// runtime, and callResponsesApi() takes the key as a parameter — neither reads
// it at module load. So this post-import load runs before the key is read. If a
// future change adds an import-time env read, promote this into a bootstrap
// module imported first (before the rest of the implementation).
try {
  createRequire(import.meta.url)('dotenv/config');
} catch {
  /* dotenv not installed — rely on the ambient environment */
}

const DEFAULT_MODEL = 'gpt-5.5';
const EXIT_MODEL_MISMATCH = 3;
const EXIT_SCHEMA_FAIL = 4;
const EXIT_PARSE_FAIL = 5;
const EXIT_VERSION_MISMATCH = 6;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function initSchemaValidator(): void {
  const schemasDir = resolve(__dirname, '../schemas');
  function loadSchema(filename: string): object {
    return JSON.parse(readFileSync(resolve(schemasDir, filename), 'utf-8'));
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(loadSchema('review-finding.schema.json'), 'review-finding.schema.json');
  const validate = ajv.compile(loadSchema('review-result.schema.json'));
  const errorsRef = { errors: null as Ajv['errors'] };
  setReviewResultValidator(
    (data) => {
      const ok = validate(data) as boolean;
      errorsRef.errors = validate.errors ?? null;
      return ok;
    },
    errorsRef,
  );
}

interface CliArgs {
  kind: 'ok';
  mode: ReviewMode;
  inputFile: string | null;
  model: string;
  effort: ReasoningEffort;
  promptVersion: string;
  tier: 'openai' | 'claude';
  expectedContractVersion: string;
  expectedSourceArtifactSha: string | undefined;
  projectContextFile: string | null;
  prContextFile: string | null;
  priorRoundsFile: string | null;
  projectContextVersion: string | null;
  sourceArtifactSha: string | null;
  help: boolean;
}

interface CliArgsError {
  kind: 'error';
  error: string;
}

function parseArgs(argv: string[]): CliArgs | CliArgsError {
  const defaultPromptVersion =
    process.env.CHATGPT_REVIEW_PROMPT_VERSION ?? '2';
  const args: CliArgs = {
    kind: 'ok',
    mode: 'pr',
    inputFile: null,
    model: process.env.CHATGPT_REVIEW_MODEL || DEFAULT_MODEL,
    effort: parseReasoningEffort(process.env.CHATGPT_REVIEW_EFFORT),
    promptVersion: defaultPromptVersion,
    tier: 'openai',
    expectedContractVersion: 'review-result.v2',
    expectedSourceArtifactSha: undefined,
    projectContextFile: null,
    prContextFile: null,
    priorRoundsFile: null,
    projectContextVersion: null,
    sourceArtifactSha: null,
    help: false,
  };
  let modeSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const v = argv[++i];
      if (v !== 'pr' && v !== 'spec' && v !== 'plan') {
        return { kind: 'error', error: `--mode must be "pr", "spec", or "plan" (got: ${v})` };
      }
      args.mode = v as ReviewMode;
      modeSet = true;
    } else if (a === '--file') {
      args.inputFile = argv[++i] ?? null;
    } else if (a === '--model') {
      args.model = argv[++i] ?? args.model;
    } else if (a === '--effort') {
      args.effort = parseReasoningEffort(argv[++i]);
    } else if (a === '--prompt-version') {
      args.promptVersion = argv[++i] ?? defaultPromptVersion;
    } else if (a === '--tier') {
      const v = argv[++i];
      if (v !== 'openai' && v !== 'claude') {
        return { kind: 'error', error: `--tier must be "openai" or "claude" (got: ${v})` };
      }
      args.tier = v;
    } else if (a === '--expected-contract-version') {
      args.expectedContractVersion = argv[++i] ?? args.expectedContractVersion;
    } else if (a === '--expected-sha' || a === '--source-artifact-sha') {
      // True alias: both flags resolve to the same canonical field used for
      // BOTH parser validation AND prompt substitution. Round-2 fix for the
      // split-brain bug where --source-artifact-sha fed the prompt but the
      // parser only honoured --expected-sha (CGPT-PR-R2-002 / OAI-PR-002).
      const sha = argv[++i];
      if (
        typeof sha === 'string' &&
        args.expectedSourceArtifactSha !== undefined &&
        args.expectedSourceArtifactSha !== sha
      ) {
        return {
          kind: 'error',
          error: `conflicting --expected-sha / --source-artifact-sha values (got: "${args.expectedSourceArtifactSha}" then "${sha}")`,
        };
      }
      args.expectedSourceArtifactSha = sha ?? undefined;
      args.sourceArtifactSha = sha ?? null;
    } else if (a === '--project-context') {
      args.projectContextFile = argv[++i] ?? null;
    } else if (a === '--pr-context') {
      args.prContextFile = argv[++i] ?? null;
    } else if (a === '--prior-rounds') {
      args.priorRoundsFile = argv[++i] ?? null;
    } else if (a === '--project-context-version') {
      args.projectContextVersion = argv[++i] ?? null;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      return { kind: 'error', error: `unknown argument: ${a}` };
    }
  }
  if (args.help) return args;
  if (!modeSet) return { kind: 'error', error: '--mode pr|spec|plan is required' };
  return args;
}

function printHelp(): void {
  process.stderr.write(
    `chatgpt-review — call OpenAI Responses API for a code, spec, or plan review\n` +
      `\n` +
      `usage:\n` +
      `  echo "<diff>" | tsx scripts/chatgpt-review.ts --mode pr\n` +
      `  tsx scripts/chatgpt-review.ts --mode spec --file docs/my-spec.md\n` +
      `  tsx scripts/chatgpt-review.ts --mode plan --file tasks/builds/foo/plan.md\n` +
      `\n` +
      `options:\n` +
      `  --mode pr|spec|plan          review mode (required)\n` +
      `                               --mode pr expects the diff to be prepended with the §3c truncation\n` +
      `                               manifest in this format:\n` +
      `                                 ## Truncation manifest\n` +
      `                                 ### Included (full diff)\n` +
      `                                 - <path>\n` +
      `                                 ### Summarised (file-level)\n` +
      `                                 - <path>: <summary>\n` +
      `                                 ### Omitted (with reason)\n` +
      `                                 - <path>: <reason>\n` +
      `                                 ---\n` +
      `                                 <diff bytes>\n` +
      `  --file <path>                read input from file instead of stdin\n` +
      `  --model <id>                 OpenAI model (default: $CHATGPT_REVIEW_MODEL or ${DEFAULT_MODEL})\n` +
      `  --effort <level>             reasoning effort: minimal|low|medium|high|off (default: high)\n` +
      `                               set to "off" when --model is a non-reasoning model\n` +
      `  --prompt-version <n>         prompt version 1|2 (default: $CHATGPT_REVIEW_PROMPT_VERSION or 2)\n` +
      `                               v2 prompts expect risk_domain and source_refs[] fields in the JSON output.\n` +
      `  --tier openai|claude         reviewer tier — controls repair-retry policy (default: openai)\n` +
      `  --expected-contract-version  expected contract_version for version audit (default: review-result.v2)\n` +
      `  --expected-sha <sha>         expected source_artifact_sha for version audit (optional)\n` +
      `  --project-context <path>     file with PROJECT_CONTEXT text (coordinator-supplied; falls back to ad-hoc sentinel if omitted)\n` +
      `  --pr-context <path>          file with PR_CONTEXT text (PR mode; falls back to ad-hoc sentinel if omitted)\n` +
      `  --prior-rounds <path>        file with PRIOR_ROUNDS text (round 2+; falls back to 'round 1' sentinel if omitted)\n` +
      `  --project-context-version    echoed into the result envelope (default: 'unknown')\n` +
      `  --source-artifact-sha <sha>  echoed into the result envelope (default: 'unknown')\n` +
      `  -h, --help                   show this help\n` +
      `\n` +
      `env:\n` +
      `  OPENAI_API_KEY                       required\n` +
      `  CHATGPT_REVIEW_MODEL                 optional model override\n` +
      `  CHATGPT_REVIEW_EFFORT                optional reasoning-effort override\n` +
      `  CHATGPT_REVIEW_PROMPT_VERSION        optional prompt version (default: 2)\n` +
      `  CHATGPT_REVIEW_TIMEOUT_MS            optional per-request timeout in ms (default: 120000)\n` +
      `\n` +
      `exit codes:\n` +
      `  0  ok\n` +
      `  2  API error or bad arguments\n` +
      `  3  model mismatch (--require-model-match)\n` +
      `  4  schema_fail after repair attempt (quarantined)\n` +
      `  5  parse_fail after repair attempt (quarantined)\n` +
      `  6  version_mismatch (no repair retry)\n`,
  );
}

function quarantine(
  reviewer: string,
  rawOutput: string,
  repairAttempt: string | null,
  kind: 'schema_fail' | 'parse_fail',
): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(process.cwd(), 'tasks/review-logs/quarantined');
  try {
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${reviewer}-${timestamp}.json`);
    writeFileSync(
      path,
      JSON.stringify({ kind, reviewer, timestamp, raw_output: rawOutput, repair_attempt: repairAttempt }, null, 2),
    );
    process.stderr.write(`quarantined: ${path}\n`);
  } catch {
    process.stderr.write(`warn: could not write quarantine file to ${dir}\n`);
  }
}

async function readStdin(): Promise<string> {
  // S1: when invoked from a TTY with no piped input, 'end' never fires until
  // Ctrl-D, which silently hangs the CLI. Detect and return empty so the
  // caller's "no input received" branch surfaces a clean error.
  if (process.stdin.isTTY) return '';
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function safeGitBranch(): string | null {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function callOpenAI(
  apiKey: string,
  model: string,
  effort: ReasoningEffort,
  systemPrompt: string,
  userInput: string,
) {
  return callResponsesApi({
    apiKey,
    model,
    effort,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ],
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'error') {
    process.stderr.write(`error: ${parsed.error}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  // Initialise the Ajv validator so parseReviewResult can schema-gate responses
  initSchemaValidator();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    process.stderr.write('error: OPENAI_API_KEY is not set\n');
    process.exit(2);
  }

  const input = parsed.inputFile
    ? readFileSync(parsed.inputFile, 'utf-8')
    : await readStdin();
  if (!input.trim()) {
    process.stderr.write('error: no input received (pass --file <path> or pipe to stdin)\n');
    process.exit(2);
  }

  const branch = safeGitBranch();
  const summary = buildInputSummary(parsed.mode, input, {
    branch,
    specPath: parsed.mode !== 'pr' ? parsed.inputFile : null,
  });

  const promptVersionNum = parsed.promptVersion === '1' ? 1 : 2;
  const systemPromptTemplate = getSystemPrompt(parsed.mode, promptVersionNum);
  const userPromptTemplate = getUserPromptTemplate(parsed.mode, promptVersionNum);

  // When the operator selects prompt v1, the legacy prompt does not
  // instruct the model to emit `contract_version`. Align the parser's
  // expectation so the v1 backward-compat path is reachable rather than
  // forcing a schema_fail / version_mismatch on otherwise-valid output.
  if (promptVersionNum === 1 && parsed.expectedContractVersion === 'review-result.v2') {
    parsed.expectedContractVersion = 'review-result.v1';
  }

  // v2 split-channel layout: the system prompt carries only the reviewer
  // contract + envelope skeleton (instructions); the user message carries
  // PROJECT_CONTEXT, PRIOR_ROUNDS, and the artefact body (data). This split
  // keeps untrusted reviewed content out of the highest-priority instruction
  // channel — the prompt-injection blast-radius fix flagged in PR #441
  // parallel-mode round 1 (2026-05-28). v1 prompts are plain text and have
  // no split — the document goes through the user channel verbatim.
  let systemPrompt = systemPromptTemplate;
  let userMessage = input;
  if (promptVersionNum === 2 && userPromptTemplate) {
    const adHoc = buildAdHocPromptVars(parsed.mode, input, { branch });
    const vars: Record<string, string | undefined> = {
      ...adHoc,
      PROJECT_CONTEXT: parsed.projectContextFile
        ? readFileSync(parsed.projectContextFile, 'utf-8')
        : adHoc.PROJECT_CONTEXT,
      PR_CONTEXT: parsed.prContextFile
        ? readFileSync(parsed.prContextFile, 'utf-8')
        : adHoc.PR_CONTEXT,
      PRIOR_ROUNDS: parsed.priorRoundsFile
        ? readFileSync(parsed.priorRoundsFile, 'utf-8')
        : adHoc.PRIOR_ROUNDS,
      PROJECT_CONTEXT_VERSION: parsed.projectContextVersion ?? adHoc.PROJECT_CONTEXT_VERSION,
      // --expected-sha is the long-standing flag; --source-artifact-sha was
      // added as an alias. Fall through to --expected-sha so callers passing
      // only --expected-sha (the version-audit path) also feed the prompt
      // correctly. Bug found in PR #441 parallel-mode round 1.
      SOURCE_ARTIFACT_SHA:
        parsed.sourceArtifactSha ??
        parsed.expectedSourceArtifactSha ??
        adHoc.SOURCE_ARTIFACT_SHA,
      OUTPUT_ENVELOPE_SKELETON: OUTPUT_ENVELOPE_SKELETON(
        parsed.mode === 'pr'
          ? 'openai-pr-review.v2'
          : parsed.mode === 'spec'
            ? 'openai-spec-review.v2'
            : 'openai-plan-review.v2',
      ),
    };
    systemPrompt = substitutePromptPlaceholders(systemPromptTemplate, vars);
    userMessage = substitutePromptPlaceholders(userPromptTemplate, vars);
  }

  let rawContent: string;
  let servedModel: string | null;
  try {
    const apiResult = await callOpenAI(
      apiKey,
      parsed.model,
      parsed.effort,
      systemPrompt,
      userMessage,
    );
    rawContent = apiResult.content;
    servedModel = apiResult.servedModel;
  } catch (err) {
    // Documented contract (header + --help): API errors exit 2 — previously
    // these propagated to main().catch and exited 1, off-contract.
    process.stderr.write(
      `error: OpenAI API call failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  const modelMatch = compareModels(parsed.model, servedModel);
  const strict = parseStrictModelMatch(process.env.CHATGPT_REVIEW_REQUIRE_MODEL_MATCH);
  if (!modelMatch.model_match) {
    const prefix = strict ? 'error' : 'WARN';
    process.stderr.write(
      `${prefix}: requested model "${modelMatch.requested_model}" but OpenAI served "${modelMatch.served_model ?? '(missing model field)'}"\n`,
    );
    if (strict) {
      process.exit(EXIT_MODEL_MISMATCH);
    }
  }

  const parseOptions: ParseOptions = {
    expectedContractVersion: parsed.expectedContractVersion,
    expectedSourceArtifactSha: parsed.expectedSourceArtifactSha,
    tier: parsed.tier,
  };

  const reviewerLabel = `${parsed.tier}-${parsed.mode}-review`;

  let outcome = parseReviewResult(rawContent, parseOptions);

  // Repair retry: OpenAI tier only, ONE attempt for schema_fail or parse_fail
  if (
    parsed.tier === 'openai' &&
    (outcome.kind === 'schema_fail' || outcome.kind === 'parse_fail')
  ) {
    process.stderr.write(`warn: ${outcome.kind} on first attempt — building repair prompt\n`);

    // buildRepairPrompt embeds the canonical envelope skeleton and a
    // human-readable Ajv-error checklist. The v1 of this prompt was generic
    // ("conform to v2") and let the model re-emit invalid verdict enums and
    // wrong source_refs shapes (PR #440, 2026-05-28).
    const repairPrompt = buildRepairPrompt(
      parsed.expectedContractVersion,
      parsed.mode,
      rawContent,
      outcome.kind === 'schema_fail'
        ? { kind: 'schema_fail', errors: outcome.errors }
        : { kind: 'parse_fail', error: outcome.error },
      {
        // Pass the authoritative metadata so the repair retry echoes the
        // values the parser is expecting — closes the version-audit edge
        // case where a first-attempt corruption of source_artifact_sha
        // survives into the repair output (CGPT-PR-R3-001).
        projectContextVersion: parsed.projectContextVersion ?? 'unknown',
        sourceArtifactSha: parsed.expectedSourceArtifactSha ?? 'unknown',
      },
    );

    // Repair uses a dedicated system prompt — the main v2 system prompt
    // declares the next user message is artefact data, but the repair's user
    // message is INSTRUCTIONS (the repair payload). Self-conflict bug
    // surfaced in PR #441 parallel-mode round 2 (CGPT-PR-R2-001).
    // v1 contract path keeps the legacy main system prompt for back-compat.
    const repairSystemPrompt =
      parsed.expectedContractVersion === 'review-result.v1' ? systemPrompt : SYSTEM_PROMPT_REPAIR_V2;

    let repairContent: string;
    try {
      const repairResult = await callOpenAI(
        apiKey,
        parsed.model,
        parsed.effort,
        repairSystemPrompt,
        repairPrompt,
      );
      repairContent = repairResult.content;
    } catch (err) {
      process.stderr.write(`error: repair API call failed: ${err instanceof Error ? err.message : String(err)}\n`);
      quarantine(reviewerLabel, rawContent, null, outcome.kind);
      process.exit(outcome.kind === 'schema_fail' ? EXIT_SCHEMA_FAIL : EXIT_PARSE_FAIL);
    }

    const repairOutcome = parseReviewResult(repairContent, parseOptions);
    if (repairOutcome.kind === 'ok') {
      outcome = repairOutcome;
    } else {
      // Second fail → quarantine
      quarantine(reviewerLabel, rawContent, repairContent, outcome.kind);
      if (repairOutcome.kind === 'schema_fail') {
        process.stderr.write(`error: schema_fail after repair attempt — quarantined\n`);
        process.exit(EXIT_SCHEMA_FAIL);
      } else if (repairOutcome.kind === 'parse_fail') {
        process.stderr.write(`error: parse_fail after repair attempt — quarantined\n`);
        process.exit(EXIT_PARSE_FAIL);
      } else {
        // version_mismatch after repair — treat as version_mismatch
        process.stderr.write(`error: version_mismatch after repair attempt\n`);
        process.exit(EXIT_VERSION_MISMATCH);
      }
    }
  } else if (
    parsed.tier === 'claude' &&
    (outcome.kind === 'schema_fail' || outcome.kind === 'parse_fail')
  ) {
    // Claude tier: no repair retry, quarantine immediately
    quarantine(reviewerLabel, rawContent, null, outcome.kind);
    process.stderr.write(`error: ${outcome.kind} from Claude-tier reviewer — quarantined immediately\n`);
    process.exit(outcome.kind === 'schema_fail' ? EXIT_SCHEMA_FAIL : EXIT_PARSE_FAIL);
  }

  // version_mismatch: no repair retry for either tier
  if (outcome.kind === 'version_mismatch') {
    process.stderr.write(
      `error: version_mismatch — drift_field=${outcome.drift_field} expected=${outcome.expected} actual=${outcome.actual}\n`,
    );
    process.exit(EXIT_VERSION_MISMATCH);
  }

  // At this point outcome.kind === 'ok'
  if (outcome.kind !== 'ok') {
    // Exhaustiveness guard — TypeScript never branch
    process.stderr.write(`error: unexpected parse outcome\n`);
    process.exit(2);
  }

  const reviewResult = outcome.result;

  // Derive findings and verdict from the v2 result; fall back to legacy
  // parseModelOutput shape for v1 read-only results
  let findings: ChatGPTReviewResult['findings'];
  let verdict: ChatGPTReviewResult['verdict'];
  if (outcome.read_only_parse_mode) {
    // v1 shape — use legacy parser
    const legacy = parseModelOutput(reviewResult as unknown);
    findings = legacy.findings;
    verdict = legacy.verdict;
  } else {
    findings = (reviewResult.findings ?? []) as ChatGPTReviewResult['findings'];
    verdict = reviewResult.verdict ?? 'NEEDS_DISCUSSION';
  }

  const result: ChatGPTReviewResult = {
    mode: parsed.mode,
    model: parsed.model,
    requested_model: modelMatch.requested_model,
    served_model: modelMatch.served_model,
    model_match: modelMatch.model_match,
    input_summary: summary,
    findings,
    verdict,
    raw_response: rawContent,
    contract_version: reviewResult.contract_version,
    prompt_version: reviewResult.prompt_version,
    reviewer_version: reviewResult.reviewer_version,
    project_context_version: reviewResult.project_context_version,
    source_artifact_sha: reviewResult.source_artifact_sha,
    integrity_check: reviewResult.integrity_check,
    read_only_parse_mode: outcome.read_only_parse_mode,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  // Exit 1 is not part of the documented contract — anything reaching this
  // catch-all (unreadable --file, missing schema files, unexpected API
  // failures) maps to the documented "API error or bad arguments" code.
  process.exit(2);
});
