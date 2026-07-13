#!/usr/bin/env tsx
/**
 * eval-prompts.ts
 *
 * Golden-set prompt eval runner (I/O module). Runs each case in a repo-local
 * suite through its target prompt via an LLM provider, scores catchRate +
 * falseAlarmRate against a pinned baseline, and exits non-zero on a regression
 * beyond the configured threshold — so a prompt change lands only if its suite
 * still passes.
 *
 * The pure scoring/parsing/normalizing core lives in eval-promptsPure.ts and is
 * vitest-tested. This module owns file reads, the provider call, and exit codes.
 *
 * Suite layout (repo-owned; the framework ships only the format spec):
 *   eval/<suite>/
 *     config.json   { promptModule, provider, model?, normalizer?, threshold: { catchRateDrop, falseAlarmRise }, notes? }
 *     cases.jsonl   one { id, input, expected: { verdict, label? }, notes, source } per line
 *     baseline.json last-accepted { catchRate, falseAlarmRate, at, commit } — written by --accept
 *
 * Usage:
 *   npx tsx scripts/eval-prompts.ts <suite>            # score vs baseline; exit 1 on breach
 *   npx tsx scripts/eval-prompts.ts <suite> --accept   # seed/refresh baseline.json from this run
 *   npx tsx scripts/eval-prompts.ts <suite> --dry-run  # print scores, no comparison, exit 0
 *
 * Env:
 *   OPENAI_API_KEY        required for the openai provider
 *   EVAL_PROMPTS_MODEL    optional model override (default: gpt-5.5)
 *   EVAL_PROMPTS_EFFORT   optional reasoning effort (minimal|low|medium|high|off; default: off)
 *
 * Exit codes: 0 ok · 1 regression / malformed / missing baseline · 2 usage or
 * config error (bad args, invalid config/cases) · 3 provider / runtime failure
 * (e.g. the model was unreachable) — kept distinct from 2 so a CI wrapper can
 * tell a retryable network blip from a permanent misconfiguration.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  parseCasesJsonl,
  validateConfig,
  normalizeStrict,
  coerceNormalizeResult,
  evaluate,
  type Baseline,
  type CaseResult,
  type EvalConfig,
  type NormalizeResult,
} from './eval-promptsPure.js';
import { callResponsesApi, type ResponsesMessage } from './chatgpt-review-api.js';
import { parseReasoningEffort, type ReasoningEffort } from './chatgpt-reviewPure.js';

// Dev-tool convenience: load OPENAI_API_KEY from a local .env when present.
// Guarded — repos without `dotenv` are unaffected. No consumer reads the key at
// import time (callResponsesApi takes it as a parameter; we read it lazily in
// the provider), so this post-import load runs before the key is ever read.
try {
  createRequire(import.meta.url)('dotenv/config');
} catch {
  /* dotenv not installed — rely on the ambient environment */
}

const DEFAULT_MODEL = 'gpt-5.5';
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_PROVIDER = 3;

// ── provider seam ─────────────────────────────────────────────────────────────

export interface EvalProvider {
  runPrompt(messages: ResponsesMessage[], opts: { model?: string }): Promise<string>;
}

function resolveEffort(): ReasoningEffort {
  // Default to 'off' — eval prompts are typically deterministic classifiers, not
  // reasoning tasks; a suite can opt into reasoning via EVAL_PROMPTS_EFFORT.
  const raw = process.env.EVAL_PROMPTS_EFFORT;
  return raw ? parseReasoningEffort(raw) : 'off';
}

const openaiProvider: EvalProvider = {
  async runPrompt(messages, opts) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set (load it from .env or the environment)');
    }
    const model = opts.model || process.env.EVAL_PROMPTS_MODEL || DEFAULT_MODEL;
    const result = await callResponsesApi({ apiKey, model, effort: resolveEffort(), messages });
    return result.content;
  },
};

function makeProvider(name: string): EvalProvider {
  if (name === 'openai') return openaiProvider;
  throw new Error(`unknown provider "${name}" — v1 ships only the "openai" provider`);
}

// ── prompt-module adapter ─────────────────────────────────────────────────────

/**
 * Map a target prompt module's output for one case into ResponsesMessage[].
 * The module's callable may return: a ResponsesMessage[] (used as-is), a plain
 * string (treated as user content), or an object { system?, user }. Anything
 * else is a hard error — the adapter never guesses.
 */
export function toMessages(promptOutput: unknown, caseId: string): ResponsesMessage[] {
  if (Array.isArray(promptOutput)) {
    const ok =
      promptOutput.length > 0 &&
      promptOutput.every(
        (m) =>
          m &&
          typeof m === 'object' &&
          (m.role === 'system' || m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string',
      );
    if (!ok) {
      throw new Error(
        `promptModule returned a bad ResponsesMessage[] for case "${caseId}" — each entry needs role (system|user|assistant) + string content`,
      );
    }
    return promptOutput as ResponsesMessage[];
  }
  if (typeof promptOutput === 'string') {
    return [{ role: 'user', content: promptOutput }];
  }
  if (promptOutput && typeof promptOutput === 'object') {
    const o = promptOutput as Record<string, unknown>;
    const messages: ResponsesMessage[] = [];
    if (typeof o.system === 'string') messages.push({ role: 'system', content: o.system });
    if (typeof o.user === 'string') messages.push({ role: 'user', content: o.user });
    if (messages.length > 0) return messages;
  }
  throw new Error(
    `promptModule returned an unusable shape for case "${caseId}" — expected string, { system?, user }, or ResponsesMessage[]`,
  );
}

async function importCallable(modulePath: string): Promise<(input: unknown) => unknown> {
  const abs = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const mod = await import(pathToFileURL(abs).href);
  const fn = typeof mod.default === 'function' ? mod.default : mod;
  if (typeof fn !== 'function') {
    throw new Error(`module "${modulePath}" does not export a callable (default export or module.exports function)`);
  }
  return fn as (input: unknown) => unknown;
}

async function loadNormalizer(config: EvalConfig): Promise<(raw: string) => Promise<NormalizeResult>> {
  if (!config.normalizer) return async (raw: string) => normalizeStrict(raw);
  const fn = await importCallable(config.normalizer);
  // A custom normalizer is untrusted: validate its output (and catch throws) so
  // an invalid verdict becomes `malformed` rather than a silent scoring miss.
  // `await` supports both sync and async normalizers.
  return async (raw: string) => {
    try {
      return coerceNormalizeResult(await fn(raw));
    } catch (err) {
      return { malformed: `normalizer threw: ${(err as Error).message}` };
    }
  };
}

// ── suite loading ─────────────────────────────────────────────────────────────

interface Suite {
  dir: string;
  config: EvalConfig;
  cases: ReturnType<typeof parseCasesJsonl>['cases'];
  baselinePath: string;
  baseline: Baseline | null;
}

function loadSuite(suiteName: string): Suite {
  const dir = resolve(process.cwd(), 'eval', suiteName);
  if (!existsSync(dir)) fail(`suite directory not found: eval/${suiteName}`);

  const configPath = resolve(dir, 'config.json');
  if (!existsSync(configPath)) fail(`missing eval/${suiteName}/config.json`);
  let configRaw: unknown;
  try {
    configRaw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail(`eval/${suiteName}/config.json is not valid JSON (${(err as Error).message})`);
  }
  const { config, error: configErr } = validateConfig(configRaw);
  if (configErr || !config) fail(`eval/${suiteName}/config.json: ${configErr}`);

  const casesPath = resolve(dir, 'cases.jsonl');
  if (!existsSync(casesPath)) fail(`missing eval/${suiteName}/cases.jsonl`);
  const { cases, errors } = parseCasesJsonl(readFileSync(casesPath, 'utf8'));
  if (errors.length > 0) {
    fail(`eval/${suiteName}/cases.jsonl has ${errors.length} invalid case(s):\n  - ${errors.join('\n  - ')}`);
  }
  if (cases.length === 0) fail(`eval/${suiteName}/cases.jsonl has no cases`);

  const baselinePath = resolve(dir, 'baseline.json');
  let baseline: Baseline | null = null;
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    } catch (err) {
      fail(`eval/${suiteName}/baseline.json is not valid JSON (${(err as Error).message})`);
    }
  }
  return { dir, config, cases, baselinePath, baseline };
}

// ── run ───────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  process.stderr.write(`eval-prompts: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function gitHead(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const suiteName = positional[0];
  if (!suiteName) fail('usage: eval-prompts <suite> [--accept | --dry-run]');

  const accept = flags.has('--accept');
  const dryRun = flags.has('--dry-run');

  const suite = loadSuite(suiteName);
  const provider = makeProvider(suite.config.provider);
  const promptFn = await importCallable(suite.config.promptModule);
  const normalize = await loadNormalizer(suite.config);

  const results: CaseResult[] = [];
  for (const c of suite.cases) {
    let raw: string;
    try {
      // `await` supports both sync and async prompt modules.
      const messages = toMessages(await promptFn(c.input), c.id);
      raw = await provider.runPrompt(messages, { model: suite.config.model });
    } catch (err) {
      // Provider / adapter failures surface loudly — never a silent pass. Exit 3
      // (runtime failure), distinct from exit 2 (usage/config) so CI can tell a
      // retryable network blip from a permanent misconfiguration.
      process.stderr.write(`eval-prompts: case "${c.id}" failed: ${(err as Error).message}\n`);
      process.exit(EXIT_PROVIDER);
    }
    const norm = await normalize(raw);
    if ('malformed' in norm) {
      results.push({ id: c.id, expected: c.expected.verdict, actual: null, malformedReason: norm.malformed });
    } else {
      results.push({ id: c.id, expected: c.expected.verdict, actual: norm.verdict });
    }
  }

  const report = evaluate(results, suite.baseline ?? { catchRate: null, falseAlarmRate: null }, suite.config.threshold);

  const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));
  process.stdout.write(
    `eval-prompts[${suiteName}]: catchRate=${fmt(report.catchRate)} falseAlarmRate=${fmt(report.falseAlarmRate)} ` +
      `(issue=${report.counts.issue}, clean=${report.counts.clean})\n`,
  );
  if (report.malformed.length > 0) {
    process.stdout.write(`  malformed cases (no usable verdict): ${report.malformed.join(', ')}\n`);
  }

  if (accept) {
    if (report.malformed.length > 0) {
      fail(`cannot accept a baseline with malformed cases: ${report.malformed.join(', ')}`);
    }
    const newBaseline: Baseline = {
      catchRate: report.catchRate,
      falseAlarmRate: report.falseAlarmRate,
      at: new Date().toISOString(),
      commit: gitHead(),
    };
    writeFileSync(suite.baselinePath, JSON.stringify(newBaseline, null, 2) + '\n', 'utf8');
    process.stdout.write(`  baseline written → eval/${suiteName}/baseline.json\n`);
    process.exit(0);
  }

  if (dryRun) {
    if (report.malformed.length > 0) {
      process.stdout.write(
        `  dry run — WARNING: ${report.malformed.length} malformed case(s) would fail a real run\n`,
      );
    }
    process.stdout.write('  dry run — no baseline comparison\n');
    process.exit(0);
  }

  if (!suite.baseline) {
    process.stderr.write(
      `eval-prompts: no baseline for suite ${suiteName} — run '/eval-prompts ${suiteName} --accept' to seed one\n`,
    );
    process.exit(EXIT_FAIL);
  }

  if (!report.pass) {
    for (const r of report.regressions) process.stderr.write(`  REGRESSION: ${r}\n`);
    if (report.malformed.length > 0) {
      process.stderr.write(`  FAIL: ${report.malformed.length} malformed case(s)\n`);
    }
    process.exit(EXIT_FAIL);
  }

  process.stdout.write('  PASS — within baseline thresholds\n');
  process.exit(0);
}

// Only run the CLI when invoked directly (not when imported for a check/test).
const invokedDirectly = process.argv[1] !== undefined && /eval-prompts\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv).catch((err) => {
    process.stderr.write(`eval-prompts: ${err && err.message}\n`);
    process.exit(EXIT_USAGE);
  });
}
