/**
 * eval-promptsPure.ts
 *
 * Pure (I/O-free) scoring core for the golden-set prompt eval runner. Parsing,
 * the strict output normalizer, metric computation, and baseline comparison
 * live here so they are deterministic and unit-testable without a network call.
 * The I/O module (`eval-prompts.ts`) owns file reads, the provider call, and
 * process exit codes.
 *
 * Metric definitions (pinned — see references/eval-suite-format.md):
 *   catchRate      = (# expected-issue cases the prompt flagged) / (# expected-issue cases)
 *   falseAlarmRate = (# expected-clean cases the prompt flagged) / (# expected-clean cases)
 * A suite with zero issue (or zero clean) cases reports the corresponding rate
 * as null and it is excluded from threshold comparison.
 *
 * There is NO fuzzy issue-detection heuristic: the strict default normalizer
 * requires the prompt output to be JSON carrying verdict "issue" | "clean".
 * Anything else marks the case malformed and the run fails — a keyword-guess
 * fallback would make the golden-set numbers untrustworthy, defeating the tool.
 */

export type Verdict = 'issue' | 'clean';

export interface ExpectedShape {
  verdict: Verdict;
  label?: string;
}

export interface EvalCase {
  id: string;
  input: unknown;
  expected: ExpectedShape;
  notes: string;
  source: string;
}

export interface Thresholds {
  /** Max tolerated catchRate decrease vs baseline. */
  catchRateDrop: number;
  /** Max tolerated falseAlarmRate increase vs baseline. */
  falseAlarmRise: number;
}

export interface EvalConfig {
  promptModule: string;
  provider: string;
  model?: string;
  normalizer?: string;
  threshold: Thresholds;
  notes?: string;
}

export interface Baseline {
  catchRate: number | null;
  falseAlarmRate: number | null;
  at?: string;
  commit?: string;
}

/** Result of normalizing one prompt output; `actual: null` means malformed. */
export interface CaseResult {
  id: string;
  expected: Verdict;
  actual: Verdict | null;
  malformedReason?: string;
}

export interface ScoreReport {
  catchRate: number | null;
  falseAlarmRate: number | null;
  issueTotal: number;
  cleanTotal: number;
  malformed: string[];
}

export interface EvalReport {
  pass: boolean;
  catchRate: number | null;
  falseAlarmRate: number | null;
  deltas: { catchRate: number | null; falseAlarm: number | null };
  regressions: string[];
  malformed: string[];
  counts: { issue: number; clean: number };
}

// ── case parsing / validation ────────────────────────────────────────────────

const REQUIRED_KEYS = ['id', 'input', 'expected', 'notes', 'source'] as const;

/** Validate one parsed case object. Returns either `{ case }` or `{ error }`. */
export function validateCaseObject(obj: unknown, ref: string): { case?: EvalCase; error?: string } {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { error: `${ref}: case is not a JSON object` };
  }
  const o = obj as Record<string, unknown>;
  // All five keys are the pinned contract (references/eval-suite-format.md +
  // framework-doctor Check 8). Enforce presence before shape checks.
  for (const k of REQUIRED_KEYS) {
    if (!(k in o)) return { error: `${ref}: missing required key "${k}"` };
  }
  if (typeof o.id !== 'string' || o.id.trim() === '') {
    return { error: `${ref}: "id" must be a non-empty string` };
  }
  const exp = o.expected;
  if (typeof exp !== 'object' || exp === null || Array.isArray(exp)) {
    return { error: `${o.id}: "expected" must be an object { verdict, label? }` };
  }
  const v = (exp as Record<string, unknown>).verdict;
  if (v !== 'issue' && v !== 'clean') {
    return { error: `${o.id}: "expected.verdict" must be "issue" or "clean"` };
  }
  // notes / source are provenance — the point of a golden case — and required.
  if (typeof o.notes !== 'string') {
    return { error: `${o.id}: "notes" must be a string (provenance is required)` };
  }
  if (typeof o.source !== 'string') {
    return { error: `${o.id}: "source" must be a string (provenance is required)` };
  }
  const label = (exp as Record<string, unknown>).label;
  return {
    case: {
      id: o.id,
      input: o.input,
      expected: { verdict: v, label: typeof label === 'string' ? label : undefined },
      notes: o.notes,
      source: o.source,
    },
  };
}

/** Parse a cases.jsonl blob (one JSON object per non-blank line). */
export function parseCasesJsonl(text: string): { cases: EvalCase[]; errors: string[] } {
  const cases: EvalCase[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      errors.push(`line ${i + 1}: invalid JSON (${(err as Error).message})`);
      continue;
    }
    const { case: c, error } = validateCaseObject(obj, `line ${i + 1}`);
    if (error) errors.push(error);
    else if (c) cases.push(c);
  }
  return { cases, errors };
}

// ── strict default normalizer ────────────────────────────────────────────────

export type NormalizeResult = { verdict: Verdict; label?: string } | { malformed: string };

/**
 * Strict default normalizer: the prompt output MUST be JSON containing a
 * verdict of "issue" | "clean". Anything else is malformed. Suites whose
 * target prompt does not emit JSON must supply an explicit `normalizer` in
 * config.json.
 */
export function normalizeStrict(raw: string): NormalizeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: 'output is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { malformed: 'output JSON is not an object' };
  }
  const v = (parsed as Record<string, unknown>).verdict;
  if (v !== 'issue' && v !== 'clean') {
    return { malformed: `"verdict" must be "issue" or "clean", got ${JSON.stringify(v)}` };
  }
  const label = (parsed as Record<string, unknown>).label;
  return { verdict: v, label: typeof label === 'string' ? label : undefined };
}

/**
 * Validate the return value of ANY normalizer (the strict default OR a
 * consumer-supplied one) into a trusted NormalizeResult. A custom normalizer is
 * untrusted code: if it returns a wrong-cased verdict (`"ISSUE"`), an unknown
 * verdict, a non-object, or a bare `{}`, this coerces it to `malformed` rather
 * than letting an invalid `verdict` flow into scoring as a silent miss — the
 * exact "untrustworthy golden-set numbers" failure the strict normalizer exists
 * to prevent. The I/O runner routes a custom normalizer's output through here.
 */
export function coerceNormalizeResult(x: unknown): NormalizeResult {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    if (typeof o.malformed === 'string') return { malformed: o.malformed };
    if (o.verdict === 'issue' || o.verdict === 'clean') {
      return { verdict: o.verdict, label: typeof o.label === 'string' ? o.label : undefined };
    }
  }
  let shown: string;
  try {
    shown = JSON.stringify(x);
  } catch {
    shown = String(x);
  }
  return { malformed: `normalizer returned an invalid shape: ${(shown ?? String(x)).slice(0, 120)}` };
}

// ── config validation ─────────────────────────────────────────────────────────

export function validateConfig(obj: unknown): { config?: EvalConfig; error?: string } {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { error: 'config.json is not a JSON object' };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.promptModule !== 'string' || o.promptModule.trim() === '') {
    return { error: 'config.promptModule must be a non-empty string' };
  }
  if (typeof o.provider !== 'string' || o.provider.trim() === '') {
    return { error: 'config.provider must be a non-empty string' };
  }
  const th = o.threshold;
  if (typeof th !== 'object' || th === null) {
    return { error: 'config.threshold must be an object { catchRateDrop, falseAlarmRise }' };
  }
  const { catchRateDrop, falseAlarmRise } = th as Record<string, unknown>;
  if (typeof catchRateDrop !== 'number' || typeof falseAlarmRise !== 'number') {
    return { error: 'config.threshold.catchRateDrop and falseAlarmRise must be numbers' };
  }
  return {
    config: {
      promptModule: o.promptModule,
      provider: o.provider,
      model: typeof o.model === 'string' ? o.model : undefined,
      normalizer: typeof o.normalizer === 'string' ? o.normalizer : undefined,
      threshold: { catchRateDrop, falseAlarmRise },
      notes: typeof o.notes === 'string' ? o.notes : undefined,
    },
  };
}

// ── scoring ──────────────────────────────────────────────────────────────────

export function scoreResults(results: CaseResult[]): ScoreReport {
  let issueTotal = 0;
  let issueCaught = 0;
  let cleanTotal = 0;
  let cleanFlagged = 0;
  const malformed: string[] = [];

  for (const r of results) {
    if (r.actual === null) {
      malformed.push(r.id);
      continue;
    }
    if (r.expected === 'issue') {
      issueTotal++;
      if (r.actual === 'issue') issueCaught++;
    } else {
      cleanTotal++;
      if (r.actual === 'issue') cleanFlagged++;
    }
  }

  return {
    catchRate: issueTotal === 0 ? null : issueCaught / issueTotal,
    falseAlarmRate: cleanTotal === 0 ? null : cleanFlagged / cleanTotal,
    issueTotal,
    cleanTotal,
    malformed,
  };
}

export function compareToBaseline(
  scores: ScoreReport,
  baseline: Baseline,
  thresholds: Thresholds,
): { regressions: string[]; catchRateDelta: number | null; falseAlarmDelta: number | null } {
  const regressions: string[] = [];
  let catchRateDelta: number | null = null;
  let falseAlarmDelta: number | null = null;

  if (scores.catchRate !== null && baseline.catchRate !== null && baseline.catchRate !== undefined) {
    catchRateDelta = scores.catchRate - baseline.catchRate;
    const drop = baseline.catchRate - scores.catchRate;
    if (drop > thresholds.catchRateDrop) {
      regressions.push(
        `catchRate dropped ${drop.toFixed(3)} (baseline ${baseline.catchRate.toFixed(3)} → ${scores.catchRate.toFixed(3)}), max tolerated ${thresholds.catchRateDrop}`,
      );
    }
  }
  if (
    scores.falseAlarmRate !== null &&
    baseline.falseAlarmRate !== null &&
    baseline.falseAlarmRate !== undefined
  ) {
    falseAlarmDelta = scores.falseAlarmRate - baseline.falseAlarmRate;
    const rise = scores.falseAlarmRate - baseline.falseAlarmRate;
    if (rise > thresholds.falseAlarmRise) {
      regressions.push(
        `falseAlarmRate rose ${rise.toFixed(3)} (baseline ${baseline.falseAlarmRate.toFixed(3)} → ${scores.falseAlarmRate.toFixed(3)}), max tolerated ${thresholds.falseAlarmRise}`,
      );
    }
  }
  return { regressions, catchRateDelta, falseAlarmDelta };
}

/** Full pass/fail evaluation: any malformed case OR any regression fails. */
export function evaluate(results: CaseResult[], baseline: Baseline, thresholds: Thresholds): EvalReport {
  const scores = scoreResults(results);
  const cmp = compareToBaseline(scores, baseline, thresholds);
  const pass = scores.malformed.length === 0 && cmp.regressions.length === 0;
  return {
    pass,
    catchRate: scores.catchRate,
    falseAlarmRate: scores.falseAlarmRate,
    deltas: { catchRate: cmp.catchRateDelta, falseAlarm: cmp.falseAlarmDelta },
    regressions: cmp.regressions,
    malformed: scores.malformed,
    counts: { issue: scores.issueTotal, clean: scores.cleanTotal },
  };
}
