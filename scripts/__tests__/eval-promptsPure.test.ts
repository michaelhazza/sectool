/**
 * eval-promptsPure.test.ts
 *
 * Pure-function tests for the golden-set eval scoring core: case parsing +
 * validation, the strict default normalizer, metric computation (catchRate /
 * falseAlarmRate incl. single-class null rates), baseline comparison +
 * threshold breach, and the malformed-case → run-fails rule.
 *
 * Run via: npx tsx scripts/__tests__/eval-promptsPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  parseCasesJsonl,
  validateCaseObject,
  normalizeStrict,
  coerceNormalizeResult,
  validateConfig,
  scoreResults,
  compareToBaseline,
  evaluate,
  type CaseResult,
  type Baseline,
  type Thresholds,
} from '../eval-promptsPure.js';

const THRESHOLDS: Thresholds = { catchRateDrop: 0.05, falseAlarmRise: 0.05 };

// ── case parsing ─────────────────────────────────────────────────────────────

test('parseCasesJsonl: parses valid lines and skips blanks', () => {
  const text = [
    '{"id":"a","input":"x","expected":{"verdict":"issue"},"notes":"n","source":"s"}',
    '',
    '{"id":"b","input":"y","expected":{"verdict":"clean"},"notes":"n2","source":"s2"}',
  ].join('\n');
  const { cases, errors } = parseCasesJsonl(text);
  expect(errors).toEqual([]);
  expect(cases.map((c) => c.id)).toEqual(['a', 'b']);
  expect(cases[0].expected.verdict).toBe('issue');
  expect(cases[0].source).toBe('s');
});

test('parseCasesJsonl: reports invalid JSON and invalid verdict without throwing', () => {
  const text = [
    '{not json}',
    '{"id":"b","input":"y","expected":{"verdict":"maybe"},"notes":"n","source":"s"}',
    '{"id":"c","input":"z","expected":{"verdict":"clean"},"notes":"n","source":"s"}',
  ].join('\n');
  const { cases, errors } = parseCasesJsonl(text);
  expect(cases.map((c) => c.id)).toEqual(['c']);
  expect(errors.length).toBe(2);
  expect(errors[0]).toMatch(/line 1: invalid JSON/);
  expect(errors[1]).toMatch(/verdict/);
});

test('validateCaseObject: enforces all five required keys + shapes', () => {
  const good = { id: 'a', input: 'x', expected: { verdict: 'clean' }, notes: 'n', source: 's' };
  expect(validateCaseObject(good, 'r').case?.id).toBe('a');
  // missing each required key is rejected
  expect(validateCaseObject({ ...good, id: undefined }, 'r').error).toMatch(/"id"/);
  expect(validateCaseObject({ id: 'a', expected: { verdict: 'issue' }, notes: 'n', source: 's' }, 'r').error).toMatch(/input/);
  expect(validateCaseObject({ id: 'a', input: 'x', notes: 'n', source: 's' }, 'r').error).toMatch(/expected/);
  expect(validateCaseObject({ id: 'a', input: 'x', expected: {}, notes: 'n', source: 's' }, 'r').error).toMatch(/verdict/);
  // notes / source are required provenance
  expect(validateCaseObject({ id: 'a', input: 'x', expected: { verdict: 'clean' }, source: 's' }, 'r').error).toMatch(/notes/);
  expect(validateCaseObject({ id: 'a', input: 'x', expected: { verdict: 'clean' }, notes: 'n' }, 'r').error).toMatch(/source/);
  expect(validateCaseObject({ id: 'a', input: 'x', expected: { verdict: 'clean' }, notes: 5, source: 's' }, 'r').error).toMatch(/notes/);
});

// ── strict normalizer ────────────────────────────────────────────────────────

test('normalizeStrict: accepts JSON verdict issue/clean, carries optional label', () => {
  expect(normalizeStrict('{"verdict":"issue"}')).toEqual({ verdict: 'issue', label: undefined });
  expect(normalizeStrict('{"verdict":"clean","label":"perf"}')).toEqual({ verdict: 'clean', label: 'perf' });
});

test('normalizeStrict: marks non-JSON, non-object, and missing/invalid verdict as malformed', () => {
  expect('malformed' in normalizeStrict('flagged: yes')).toBe(true);
  expect('malformed' in normalizeStrict('"just a string"')).toBe(true);
  expect('malformed' in normalizeStrict('{"foo":"bar"}')).toBe(true);
  expect('malformed' in normalizeStrict('{"verdict":"issueish"}')).toBe(true);
});

// ── coerce (custom normalizer output validation) ─────────────────────────────

test('coerceNormalizeResult: passes through valid verdict + malformed shapes', () => {
  expect(coerceNormalizeResult({ verdict: 'issue' })).toEqual({ verdict: 'issue', label: undefined });
  expect(coerceNormalizeResult({ verdict: 'clean', label: 'x' })).toEqual({ verdict: 'clean', label: 'x' });
  expect(coerceNormalizeResult({ malformed: 'why' })).toEqual({ malformed: 'why' });
});

test('coerceNormalizeResult: rejects invalid shapes from a custom normalizer', () => {
  // wrong case, unknown verdict, empty object, non-object, array — all malformed.
  expect('malformed' in coerceNormalizeResult({ verdict: 'ISSUE' })).toBe(true);
  expect('malformed' in coerceNormalizeResult({ verdict: 'flag' })).toBe(true);
  expect('malformed' in coerceNormalizeResult({})).toBe(true);
  expect('malformed' in coerceNormalizeResult('issue')).toBe(true);
  expect('malformed' in coerceNormalizeResult(['issue'])).toBe(true);
  expect('malformed' in coerceNormalizeResult(null)).toBe(true);
});

// ── config validation ────────────────────────────────────────────────────────

test('validateConfig: requires promptModule, provider, numeric thresholds', () => {
  expect(validateConfig({ provider: 'openai', threshold: { catchRateDrop: 0, falseAlarmRise: 0 } }).error).toMatch(/promptModule/);
  expect(validateConfig({ promptModule: 'm', threshold: { catchRateDrop: 0, falseAlarmRise: 0 } }).error).toMatch(/provider/);
  expect(validateConfig({ promptModule: 'm', provider: 'openai', threshold: { catchRateDrop: 'x', falseAlarmRise: 0 } }).error).toMatch(/number/);
  const ok = validateConfig({ promptModule: 'm', provider: 'openai', model: 'gpt', threshold: { catchRateDrop: 0.1, falseAlarmRise: 0.1 } });
  expect(ok.config?.promptModule).toBe('m');
  expect(ok.config?.threshold.catchRateDrop).toBe(0.1);
});

// ── scoring ──────────────────────────────────────────────────────────────────

test('scoreResults: computes catchRate and falseAlarmRate', () => {
  const results: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'issue' }, // caught
    { id: '2', expected: 'issue', actual: 'clean' }, // missed
    { id: '3', expected: 'clean', actual: 'clean' }, // ok
    { id: '4', expected: 'clean', actual: 'issue' }, // false alarm
  ];
  const s = scoreResults(results);
  expect(s.catchRate).toBe(0.5);
  expect(s.falseAlarmRate).toBe(0.5);
  expect(s.issueTotal).toBe(2);
  expect(s.cleanTotal).toBe(2);
  expect(s.malformed).toEqual([]);
});

test('scoreResults: single-class suites report the missing rate as null', () => {
  const onlyIssues: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'issue' },
    { id: '2', expected: 'issue', actual: 'issue' },
  ];
  const s = scoreResults(onlyIssues);
  expect(s.catchRate).toBe(1);
  expect(s.falseAlarmRate).toBeNull();
});

test('scoreResults: malformed actuals are collected, not scored', () => {
  const results: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'issue' },
    { id: '2', expected: 'issue', actual: null, malformedReason: 'not JSON' },
  ];
  const s = scoreResults(results);
  expect(s.malformed).toEqual(['2']);
  expect(s.issueTotal).toBe(1); // the malformed one excluded from the denominator
  expect(s.catchRate).toBe(1);
});

// ── baseline comparison ──────────────────────────────────────────────────────

test('compareToBaseline: flags a catchRate drop beyond threshold', () => {
  const scores = scoreResults([
    { id: '1', expected: 'issue', actual: 'clean' },
    { id: '2', expected: 'issue', actual: 'issue' },
  ]); // catchRate 0.5
  const baseline: Baseline = { catchRate: 0.9, falseAlarmRate: 0 };
  const cmp = compareToBaseline(scores, baseline, THRESHOLDS);
  expect(cmp.regressions.length).toBe(1);
  expect(cmp.regressions[0]).toMatch(/catchRate dropped/);
  expect(cmp.catchRateDelta).toBeCloseTo(-0.4, 5);
});

test('compareToBaseline: flags a falseAlarmRate rise beyond threshold', () => {
  const scores = scoreResults([
    { id: '1', expected: 'clean', actual: 'issue' },
    { id: '2', expected: 'clean', actual: 'clean' },
  ]); // falseAlarmRate 0.5
  const baseline: Baseline = { catchRate: null, falseAlarmRate: 0.1 };
  const cmp = compareToBaseline(scores, baseline, THRESHOLDS);
  expect(cmp.regressions.some((r) => /falseAlarmRate rose/.test(r))).toBe(true);
});

test('compareToBaseline: within-threshold movement is not a regression', () => {
  const scores = scoreResults([
    { id: '1', expected: 'issue', actual: 'issue' },
    { id: '2', expected: 'issue', actual: 'clean' },
  ]); // catchRate 0.5
  const baseline: Baseline = { catchRate: 0.52, falseAlarmRate: 0 };
  const cmp = compareToBaseline(scores, baseline, THRESHOLDS);
  expect(cmp.regressions).toEqual([]);
});

// ── full evaluate ────────────────────────────────────────────────────────────

test('evaluate: passes when no regression and no malformed', () => {
  const results: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'issue' },
    { id: '2', expected: 'clean', actual: 'clean' },
  ];
  const report = evaluate(results, { catchRate: 1, falseAlarmRate: 0 }, THRESHOLDS);
  expect(report.pass).toBe(true);
  expect(report.regressions).toEqual([]);
});

test('evaluate: fails when any case is malformed even if rates look fine', () => {
  const results: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'issue' },
    { id: '2', expected: 'clean', actual: null, malformedReason: 'not JSON' },
  ];
  const report = evaluate(results, { catchRate: 1, falseAlarmRate: 0 }, THRESHOLDS);
  expect(report.pass).toBe(false);
  expect(report.malformed).toEqual(['2']);
});

test('evaluate: fails on a threshold-breaching regression', () => {
  const results: CaseResult[] = [
    { id: '1', expected: 'issue', actual: 'clean' },
    { id: '2', expected: 'issue', actual: 'clean' },
  ]; // catchRate 0
  const report = evaluate(results, { catchRate: 1, falseAlarmRate: 0 }, THRESHOLDS);
  expect(report.pass).toBe(false);
  expect(report.regressions.length).toBeGreaterThan(0);
});
