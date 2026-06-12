/**
 * chatgpt-reviewPure.test.ts
 *
 * Pure-function tests for the ChatGPT review CLI helpers.
 * Run via: npx tsx scripts/__tests__/chatgpt-reviewPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  buildAdHocPromptVars,
  buildInputSummary,
  buildRepairPrompt,
  compareFindingSets,
  compareModels,
  countFilesChangedInDiff,
  deriveVerdictFromFindings,
  extractResponsesApiText,
  extractServedModel,
  getSystemPrompt,
  getUserPromptTemplate,
  jaccard,
  mdCell,
  modelsAreCompatible,
  normaliseFinding,
  normaliseTitleForMatch,
  OUTPUT_ENVELOPE_SKELETON,
  parseModelOutput,
  parseReasoningEffort,
  parseStrictModelMatch,
  renderComparePanel,
  stripJsonFence,
  substitutePromptPlaceholders,
  translateAjvErrorsToChecklist,
  type Finding,
} from '../chatgpt-reviewPure.js';

function f(title: string, partial: Partial<Finding> = {}): Finding {
  return {
    id: partial.id ?? 'X1',
    title,
    severity: partial.severity ?? 'medium',
    category: partial.category ?? 'bug',
    finding_type: partial.finding_type ?? 'other',
    rationale: partial.rationale ?? 'r',
    ...partial,
  } as Finding;
}

function eq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  expect(a === e, `${label}: expected ${e}, got ${a}`).toBeTruthy();
}

// --- countFilesChangedInDiff ---

test('countFilesChangedInDiff returns 0 for empty input', () => {
  eq(countFilesChangedInDiff(''), 0, 'count');
});

test('countFilesChangedInDiff counts a single-file diff', () => {
  const diff =
    'diff --git a/src/foo.ts b/src/foo.ts\nindex 1234..5678 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new';
  eq(countFilesChangedInDiff(diff), 1, 'count');
});

test('countFilesChangedInDiff counts multiple files', () => {
  const diff =
    'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n' +
    'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n' +
    'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-x\n+y\n';
  eq(countFilesChangedInDiff(diff), 3, 'count');
});

test('countFilesChangedInDiff handles paths with spaces and dashes', () => {
  const diff =
    'diff --git a/path with-spaces/x.ts b/path with-spaces/x.ts\n@@ -1 +1 @@\n-x\n+y\n';
  eq(countFilesChangedInDiff(diff), 1, 'count');
});

// --- buildInputSummary ---

test('buildInputSummary pr mode populates files_changed and nulls spec_path', () => {
  const diff = 'diff --git a/x b/x\n';
  const summary = buildInputSummary('pr', diff, { branch: 'feature/foo' });
  eq(summary, { branch: 'feature/foo', spec_path: null, files_changed: 1 }, 'summary');
});

test('buildInputSummary spec mode populates spec_path and nulls files_changed', () => {
  const summary = buildInputSummary('spec', '# Spec', {
    branch: 'feature/foo',
    specPath: 'docs/x.md',
  });
  eq(
    summary,
    { branch: 'feature/foo', spec_path: 'docs/x.md', files_changed: null },
    'summary',
  );
});

test('buildInputSummary defaults branch and spec_path to null when omitted', () => {
  const summary = buildInputSummary('pr', '', {});
  eq(summary, { branch: null, spec_path: null, files_changed: 0 }, 'summary');
});

// --- normaliseFinding ---

test('normaliseFinding returns null for non-objects', () => {
  expect(normaliseFinding(null, 0) === null, 'null').toBeTruthy();
  expect(normaliseFinding('string', 0) === null, 'string').toBeTruthy();
  expect(normaliseFinding(42, 0) === null, 'number').toBeTruthy();
});

test('normaliseFinding drops findings without a title', () => {
  expect(normaliseFinding({ title: '' }, 0) === null, 'empty title').toBeTruthy();
  expect(normaliseFinding({}, 0) === null, 'no title').toBeTruthy();
});

test('normaliseFinding accepts a fully-valid finding verbatim', () => {
  const raw = {
    id: 'f-007',
    title: 'NPE risk on user.email',
    severity: 'high',
    category: 'bug',
    finding_type: 'null_check',
    rationale: 'No guard before access',
    evidence: 'server/services/userService.ts:42',
  };
  const f = normaliseFinding(raw, 6);
  expect(f !== null, 'not null').toBeTruthy();
  eq(f as Finding, raw as Finding, 'finding');
});

test('normaliseFinding regenerates id when missing', () => {
  const f = normaliseFinding({ title: 'x' }, 4);
  expect(f !== null, 'not null').toBeTruthy();
  eq((f as Finding).id, 'f-005', 'id');
});

test('normaliseFinding falls back unknown enums to safe defaults', () => {
  const f = normaliseFinding(
    {
      title: 'x',
      severity: 'extreme',
      category: 'cosmic',
      finding_type: 'gibberish',
      rationale: '',
      evidence: '',
    },
    0,
  );
  expect(f !== null, 'not null').toBeTruthy();
  eq((f as Finding).severity, 'medium', 'severity default');
  eq((f as Finding).category, 'improvement', 'category default');
  eq((f as Finding).finding_type, 'other', 'finding_type default');
});

// --- parseModelOutput ---

test('parseModelOutput throws on non-objects', () => {
  let threw = false;
  try {
    parseModelOutput(null);
  } catch {
    threw = true;
  }
  expect(threw, 'should throw').toBeTruthy();
});

test('parseModelOutput accepts well-formed model JSON', () => {
  const raw = {
    findings: [
      {
        id: 'f-001',
        title: 'oops',
        severity: 'critical',
        category: 'bug',
        finding_type: 'security',
        rationale: 'leak',
        evidence: 'server/x.ts:1',
      },
    ],
    verdict: 'CHANGES_REQUESTED',
  };
  const result = parseModelOutput(raw);
  eq(result.findings.length, 1, 'findings count');
  eq(result.verdict, 'CHANGES_REQUESTED', 'verdict');
});

test('parseModelOutput drops malformed findings without aborting', () => {
  const raw = {
    findings: [
      { title: 'good' },
      null,
      { title: '' },
      'string',
      { title: 'also-good', severity: 'low' },
    ],
    verdict: 'APPROVED',
  };
  const result = parseModelOutput(raw);
  eq(result.findings.length, 2, 'findings kept');
  eq(result.findings[0].id, 'f-001', 'first id');
  eq(result.findings[1].id, 'f-005', 'second id keeps original index');
});

test('parseModelOutput derives verdict when missing', () => {
  const raw = {
    findings: [{ title: 'x', severity: 'high' }],
  };
  const result = parseModelOutput(raw);
  eq(result.verdict, 'CHANGES_REQUESTED', 'derived verdict');
});

test('parseModelOutput derives APPROVED for low/medium-only findings', () => {
  const raw = {
    findings: [{ title: 'x', severity: 'medium' }, { title: 'y', severity: 'low' }],
    verdict: 'NOT_VALID',
  };
  const result = parseModelOutput(raw);
  eq(result.verdict, 'APPROVED', 'derived verdict');
});

// --- deriveVerdictFromFindings ---

test('deriveVerdictFromFindings APPROVED for empty list', () => {
  eq(deriveVerdictFromFindings([]), 'APPROVED', 'empty');
});

test('deriveVerdictFromFindings CHANGES_REQUESTED for any high/critical', () => {
  const findings: Finding[] = [
    {
      id: 'f-001',
      title: 'x',
      severity: 'high',
      category: 'bug',
      finding_type: 'other',
      rationale: '',
      evidence: '',
    },
  ];
  eq(deriveVerdictFromFindings(findings), 'CHANGES_REQUESTED', 'high');
});

// --- stripJsonFence ---

test('stripJsonFence returns input unchanged when no fence', () => {
  eq(stripJsonFence('{"a": 1}'), '{"a": 1}', 'no fence');
});

test('stripJsonFence strips ```json fences', () => {
  eq(stripJsonFence('```json\n{"a": 1}\n```'), '{"a": 1}', 'json fence');
});

test('stripJsonFence strips bare ``` fences', () => {
  eq(stripJsonFence('```\n{"a": 1}\n```'), '{"a": 1}', 'bare fence');
});

test('stripJsonFence trims surrounding whitespace', () => {
  eq(stripJsonFence('   \n```json\n{"a": 1}\n```\n  '), '{"a": 1}', 'trim');
});

// --- extractResponsesApiText ---

test('extractResponsesApiText returns empty for non-objects', () => {
  eq(extractResponsesApiText(null), '', 'null');
  eq(extractResponsesApiText('string'), '', 'string');
  eq(extractResponsesApiText(42), '', 'number');
});

test('extractResponsesApiText prefers the output_text convenience field', () => {
  eq(extractResponsesApiText({ output_text: '{"findings":[]}' }), '{"findings":[]}', 'direct');
});

test('extractResponsesApiText falls back to walking output[] when output_text is empty', () => {
  const payload = {
    output_text: '',
    output: [
      { type: 'reasoning', summary: 'thinking...' },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: '{"findings":' },
          { type: 'output_text', text: '[]}' },
        ],
      },
    ],
  };
  eq(extractResponsesApiText(payload), '{"findings":[]}', 'walked');
});

test('extractResponsesApiText ignores non-message output items', () => {
  const payload = {
    output: [
      { type: 'reasoning', summary: 'ignored' },
      { type: 'message', content: [{ type: 'output_text', text: 'kept' }] },
      { type: 'tool_call', name: 'ignored' },
    ],
  };
  eq(extractResponsesApiText(payload), 'kept', 'filtered');
});

test('extractResponsesApiText returns empty when payload has nothing usable', () => {
  eq(extractResponsesApiText({ output: [{ type: 'reasoning' }] }), '', 'no message');
  eq(extractResponsesApiText({}), '', 'empty object');
});

// --- parseReasoningEffort ---

test('parseReasoningEffort defaults to high for empty input', () => {
  eq(parseReasoningEffort(undefined), 'high', 'undefined');
  eq(parseReasoningEffort(null), 'high', 'null');
  eq(parseReasoningEffort(''), 'high', 'empty string');
});

test('parseReasoningEffort accepts all five valid values', () => {
  eq(parseReasoningEffort('minimal'), 'minimal', 'minimal');
  eq(parseReasoningEffort('low'), 'low', 'low');
  eq(parseReasoningEffort('medium'), 'medium', 'medium');
  eq(parseReasoningEffort('high'), 'high', 'high');
  eq(parseReasoningEffort('off'), 'off', 'off');
});

test('parseReasoningEffort is case-insensitive and trims', () => {
  eq(parseReasoningEffort('  HIGH  '), 'high', 'trim+lower');
  eq(parseReasoningEffort('Medium'), 'medium', 'mixed case');
});

test('parseReasoningEffort falls back to high for unknown values', () => {
  eq(parseReasoningEffort('extreme'), 'high', 'unknown');
  eq(parseReasoningEffort('thinking'), 'high', 'unknown 2');
});

// --- modelsAreCompatible ---

test('modelsAreCompatible accepts exact matches', () => {
  expect(modelsAreCompatible('gpt-5.5', 'gpt-5.5')).toBe(true);
});

test('modelsAreCompatible accepts snapshot resolutions (gpt-5.5 -> gpt-5.5-2026-05-01)', () => {
  expect(modelsAreCompatible('gpt-5.5', 'gpt-5.5-2026-05-01')).toBe(true);
});

test('modelsAreCompatible rejects reverse collapse (asked for preview, got family) — this is a downgrade', () => {
  expect(modelsAreCompatible('gpt-5.5-preview', 'gpt-5.5')).toBe(false);
  expect(modelsAreCompatible('gpt-5.5-thinking', 'gpt-5.5')).toBe(false);
});

test('modelsAreCompatible rejects distinct model families', () => {
  expect(modelsAreCompatible('gpt-5.5', 'gpt-4o-2024-08-06')).toBe(false);
});

test('modelsAreCompatible requires a "-" boundary so gpt-5 does not absorb gpt-5.5', () => {
  expect(modelsAreCompatible('gpt-5', 'gpt-5.5')).toBe(false);
  expect(modelsAreCompatible('gpt-5.5', 'gpt-5')).toBe(false);
});

// --- compareModels ---

test('compareModels matches when served exactly equals requested', () => {
  eq(
    compareModels('gpt-5.5', 'gpt-5.5'),
    { requested_model: 'gpt-5.5', served_model: 'gpt-5.5', model_match: true },
    'match',
  );
});

test('compareModels treats a snapshot resolution as a match', () => {
  eq(
    compareModels('gpt-5.5', 'gpt-5.5-2026-05-01'),
    { requested_model: 'gpt-5.5', served_model: 'gpt-5.5-2026-05-01', model_match: true },
    'snapshot',
  );
});

test('compareModels reports mismatch when served differs from requested', () => {
  eq(
    compareModels('gpt-5.5', 'gpt-4o-2024-08-06'),
    { requested_model: 'gpt-5.5', served_model: 'gpt-4o-2024-08-06', model_match: false },
    'mismatch',
  );
});

test('compareModels treats a missing served field as a non-match', () => {
  eq(
    compareModels('gpt-5.5', null),
    { requested_model: 'gpt-5.5', served_model: null, model_match: false },
    'null served',
  );
  eq(
    compareModels('gpt-5.5', undefined),
    { requested_model: 'gpt-5.5', served_model: null, model_match: false },
    'undefined served',
  );
});

test('compareModels treats empty / whitespace served values as missing', () => {
  eq(
    compareModels('gpt-5.5', ''),
    { requested_model: 'gpt-5.5', served_model: null, model_match: false },
    'empty',
  );
  eq(
    compareModels('gpt-5.5', '   '),
    { requested_model: 'gpt-5.5', served_model: null, model_match: false },
    'whitespace',
  );
});

// --- extractServedModel ---

test('extractServedModel returns the model string from a Responses-API success payload', () => {
  eq(extractServedModel({ model: 'gpt-5.5', output_text: 'x' }), 'gpt-5.5', 'model');
});

test('extractServedModel returns null for non-objects', () => {
  eq(extractServedModel(null), null, 'null');
  eq(extractServedModel('string'), null, 'string');
  eq(extractServedModel(42), null, 'number');
});

test('extractServedModel returns null when model field is missing or non-string', () => {
  eq(extractServedModel({ output_text: 'x' }), null, 'missing');
  eq(extractServedModel({ output_text: 'x', model: 42 }), null, 'non-string');
  eq(extractServedModel({ output_text: 'x', model: '' }), null, 'empty');
});

test('extractServedModel ignores payloads that do not look like Responses-API success bodies', () => {
  // Error envelope: has model but no output/output_text — should not be trusted.
  eq(extractServedModel({ model: 'gpt-5.5', error: { message: 'no access' } }), null, 'error envelope');
  eq(extractServedModel({ model: 'gpt-5.5' }), null, 'bare model');
});

test('extractServedModel accepts payloads with output[] when output_text is absent', () => {
  eq(extractServedModel({ model: 'gpt-5.5', output: [] }), 'gpt-5.5', 'output array');
});

// --- parseStrictModelMatch ---

test('parseStrictModelMatch is false for empty / undefined / null', () => {
  expect(parseStrictModelMatch(undefined)).toBe(false);
  expect(parseStrictModelMatch(null)).toBe(false);
  expect(parseStrictModelMatch('')).toBe(false);
});

test('parseStrictModelMatch accepts 1 / true / yes case-insensitively', () => {
  expect(parseStrictModelMatch('1')).toBe(true);
  expect(parseStrictModelMatch('true')).toBe(true);
  expect(parseStrictModelMatch('TRUE')).toBe(true);
  expect(parseStrictModelMatch(' Yes ')).toBe(true);
});

test('parseStrictModelMatch rejects 0 / false / other strings', () => {
  expect(parseStrictModelMatch('0')).toBe(false);
  expect(parseStrictModelMatch('false')).toBe(false);
  expect(parseStrictModelMatch('strict')).toBe(false);
});

// --- substitutePromptPlaceholders ---

test('substitutePromptPlaceholders replaces a single placeholder', () => {
  const out = substitutePromptPlaceholders('hello {{NAME}}', { NAME: 'world' });
  expect(out).toBe('hello world');
});

test('substitutePromptPlaceholders replaces multiple placeholders including repeats', () => {
  const out = substitutePromptPlaceholders('{{A}}/{{B}}/{{A}}', { A: 'x', B: 'y' });
  expect(out).toBe('x/y/x');
});

test('substitutePromptPlaceholders throws on missing key', () => {
  expect(() => substitutePromptPlaceholders('{{MISSING}}', {})).toThrow(/missing or non-string value for placeholder \{\{MISSING\}\}/);
});

test('substitutePromptPlaceholders throws on non-string value', () => {
  expect(() => substitutePromptPlaceholders('{{X}}', { X: undefined })).toThrow(/missing or non-string value/);
});

test('substitutePromptPlaceholders inserts substituted values verbatim, NOT re-scanned (single pass)', () => {
  // Substituted values may legitimately contain `{{KEY}}` literals (spec /
  // plan / diff bodies often do — e.g. the review-cascade-v3 spec documents
  // the prompt template format). Single-pass substitution is intentional.
  const out = substitutePromptPlaceholders('start {{A}} end', { A: 'literal {{B}} text' });
  expect(out).toBe('start literal {{B}} text end');
});

test('substitutePromptPlaceholders works when a substituted document body contains placeholder literals', () => {
  // Regression for the spec-mode end-to-end failure (2026-05-28): a spec body
  // that documents the prompt template format contains literal {{PROJECT_CONTEXT}}
  // strings as documentation. These must pass through, not throw.
  const specBody = '# Spec\n\nThe template looks like:\n\nPROJECT_CONTEXT:\n{{PROJECT_CONTEXT}}\n\nThis is intentional documentation.';
  const out = substitutePromptPlaceholders(
    'SPEC:\n{{SPEC_DOCUMENT}}\n\nVERSION: {{V}}',
    { SPEC_DOCUMENT: specBody, V: '1.0' },
  );
  expect(out).toContain('{{PROJECT_CONTEXT}}'); // preserved from spec body
  expect(out).toContain('VERSION: 1.0');
  expect(out).not.toContain('{{SPEC_DOCUMENT}}');
  expect(out).not.toContain('{{V}}');
});

test('substitutePromptPlaceholders leaves text without placeholders unchanged', () => {
  const txt = 'no placeholders here';
  expect(substitutePromptPlaceholders(txt, {})).toBe(txt);
});

// --- buildAdHocPromptVars ---

test('buildAdHocPromptVars pr mode populates DIFF and PR_CONTEXT sentinel', () => {
  const v = buildAdHocPromptVars('pr', 'diff --git a/x b/x\n', { branch: 'feature/foo' });
  expect(v.DIFF).toBe('diff --git a/x b/x\n');
  expect(v.PR_CONTEXT).toMatch(/ad-hoc CLI run.*feature\/foo/);
  expect(v.SPEC_DOCUMENT).toBeUndefined();
  expect(v.PLAN_DOCUMENT).toBeUndefined();
  expect(v.PROJECT_CONTEXT_VERSION).toBe('unknown');
  expect(v.SOURCE_ARTIFACT_SHA).toBe('unknown');
});

test('buildAdHocPromptVars spec mode populates SPEC_DOCUMENT, not DIFF', () => {
  const v = buildAdHocPromptVars('spec', '# my spec');
  expect(v.SPEC_DOCUMENT).toBe('# my spec');
  expect(v.DIFF).toBeUndefined();
  expect(v.PR_CONTEXT).toBeUndefined();
});

test('buildAdHocPromptVars plan mode populates PLAN_DOCUMENT and SPEC_DOCUMENT sentinel', () => {
  const v = buildAdHocPromptVars('plan', '# my plan');
  expect(v.PLAN_DOCUMENT).toBe('# my plan');
  expect(v.SPEC_DOCUMENT).toMatch(/no SPEC_DOCUMENT supplied/);
  expect(v.DIFF).toBeUndefined();
});

// --- Every v2 prompt fully substitutes with ad-hoc vars (no leftover placeholders) ---

test('SYSTEM_PROMPT_PR_V2 substitutes cleanly with ad-hoc vars (no {{...}} leftovers)', () => {
  const template = getSystemPrompt('pr', 2);
  const adHoc = buildAdHocPromptVars('pr', 'diff --git a/x b/x\n', { branch: 'main' });
  const vars: Record<string, string | undefined> = {
    ...adHoc,
    OUTPUT_ENVELOPE_SKELETON: OUTPUT_ENVELOPE_SKELETON('openai-pr-review.v2'),
  };
  const out = substitutePromptPlaceholders(template, vars);
  expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  expect(out).toContain('Canonical envelope');
});

test('SYSTEM_PROMPT_SPEC_V2 substitutes cleanly with ad-hoc vars', () => {
  const template = getSystemPrompt('spec', 2);
  const adHoc = buildAdHocPromptVars('spec', '# spec body');
  const vars: Record<string, string | undefined> = {
    ...adHoc,
    OUTPUT_ENVELOPE_SKELETON: OUTPUT_ENVELOPE_SKELETON('openai-spec-review.v2'),
  };
  const out = substitutePromptPlaceholders(template, vars);
  expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  expect(out).toContain('openai-spec-review.v2');
});

test('SYSTEM_PROMPT_PLAN_V2 substitutes cleanly with ad-hoc vars', () => {
  const template = getSystemPrompt('plan', 2);
  const adHoc = buildAdHocPromptVars('plan', '# plan body');
  const vars: Record<string, string | undefined> = {
    ...adHoc,
    OUTPUT_ENVELOPE_SKELETON: OUTPUT_ENVELOPE_SKELETON('openai-plan-review.v2'),
  };
  const out = substitutePromptPlaceholders(template, vars);
  expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  expect(out).toContain('openai-plan-review.v2');
});

// --- OUTPUT_ENVELOPE_SKELETON ---

test('OUTPUT_ENVELOPE_SKELETON names every required envelope field', () => {
  const sk = OUTPUT_ENVELOPE_SKELETON('openai-pr-review.v2');
  // Top-level required keys
  for (const key of [
    'contract_version',
    'prompt_version',
    'project_context_version',
    'source_artifact_sha',
    'verdict',
    'integrity_check',
    'findings',
  ]) {
    expect(sk).toContain(`"${key}"`);
  }
  // Verdict enum spelled out so model never invents NEEDS_WORK
  expect(sk).toContain('APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION');
  // integrity_check string contract called out by name
  expect(sk).toContain('integrity_check` is a STRING');
  // source_refs object shape called out by name
  expect(sk).toContain('source_refs[]');
  expect(sk).toMatch(/NOT `\{file, line, quote\}`/);
});

test('OUTPUT_ENVELOPE_SKELETON documents all three conditional finding-level requirements with their triggers', () => {
  // Regression for OAI-PR-001 / OAI-PR-002: the skeleton must teach all three
  // schema conditionals or the model will fail Ajv on the un-named one and
  // the repair retry (which embeds the same skeleton) will quarantine.
  const sk = OUTPUT_ENVELOPE_SKELETON('openai-pr-review.v2');

  // Conditional 1 — operator_decision_required_reason
  expect(sk).toContain('operator_decision_required_reason');
  // The trigger must be named both at the example block (so the model sees
  // when to include it) AND in the hard-rules block (so the rule is
  // unambiguous). Proximity check via substring.
  expect(sk).toMatch(/operator_decision_required_reason[\s\S]*auto_apply_eligible: false[\s\S]*triage_hint/);
  expect(sk).toMatch(/user-facing[\s\S]*technical-escalated/);

  // Conditional 2 — defer requires deferred_until + backlog_target
  expect(sk).toContain('deferred_until');
  expect(sk).toContain('backlog_target');
  expect(sk).toMatch(/recommendation: "defer"[\s\S]*deferred_until/);

  // Conditional 3 — auto_apply_eligible: true requires proposed_edits + the literal reason
  expect(sk).toContain('proposed_edits');
  expect(sk).toContain('local_one_obvious_fix');
});

// --- translateAjvErrorsToChecklist ---

test('translateAjvErrorsToChecklist renders the historical defects in human form', () => {
  // The exact Ajv errors the schema-gate produced for the PR #440 quarantine.
  const errors = [
    { instancePath: '', keyword: 'required', params: { missingProperty: 'contract_version' }, message: '' },
    { instancePath: '', keyword: 'required', params: { missingProperty: 'verdict' }, message: '' },
    { instancePath: '/integrity_check', keyword: 'type', params: { type: 'string' }, message: '' },
    { instancePath: '', keyword: 'additionalProperties', params: { additionalProperty: 'summary' }, message: '' },
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'category' }, message: '' },
    { instancePath: '/findings/0/source_refs/0', keyword: 'required', params: { missingProperty: 'type' }, message: '' },
  ];
  const out = translateAjvErrorsToChecklist(errors);
  expect(out).toContain('missing required key "contract_version"');
  expect(out).toContain('missing required key "verdict"');
  expect(out).toContain('wrong type — expected string');
  expect(out).toContain('disallowed extra key "summary"');
  expect(out).toContain('missing required key "category"');
  expect(out).toContain('missing required key "type"');
});

test('translateAjvErrorsToChecklist handles enum + const violations', () => {
  const errors = [
    { instancePath: '/verdict', keyword: 'enum', params: { allowedValues: ['APPROVED', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION'] }, message: '' },
    { instancePath: '/contract_version', keyword: 'const', params: { allowedValue: 'review-result.v2' }, message: '' },
  ];
  const out = translateAjvErrorsToChecklist(errors);
  expect(out).toContain('value not in allowed enum ["APPROVED","CHANGES_REQUESTED","NEEDS_DISCUSSION"]');
  expect(out).toContain('value must be exactly "review-result.v2"');
});

test('translateAjvErrorsToChecklist returns sentinel for empty errors', () => {
  expect(translateAjvErrorsToChecklist([])).toMatch(/no specific Ajv errors/);
});

test('translateAjvErrorsToChecklist appends conditional-trigger context for the three finding-level conditional fields', () => {
  // Regression for OAI-PR-003: when the model fails a conditional requirement,
  // the checklist must explain WHY the field is required so the repair retry
  // has new information vs the prior round.
  const out = translateAjvErrorsToChecklist([
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'operator_decision_required_reason' }, message: '' },
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'deferred_until' }, message: '' },
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'backlog_target' }, message: '' },
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'proposed_edits' }, message: '' },
  ]);
  expect(out).toContain('operator_decision_required_reason');
  expect(out).toMatch(/operator_decision_required_reason.*triage_hint/);
  expect(out).toContain('deferred_until');
  expect(out).toMatch(/deferred_until.*"defer"/);
  expect(out).toContain('backlog_target');
  expect(out).toMatch(/backlog_target.*"defer"/);
  expect(out).toContain('proposed_edits');
  expect(out).toMatch(/proposed_edits.*auto_apply_eligible: true/);
});

test('translateAjvErrorsToChecklist leaves non-conditional missing fields without a trigger suffix', () => {
  // Ensure the conditional-hint map doesn't accidentally mark every required
  // field as conditional. A plain `category` missing should not get a suffix.
  const out = translateAjvErrorsToChecklist([
    { instancePath: '/findings/0', keyword: 'required', params: { missingProperty: 'category' }, message: '' },
  ]);
  expect(out).toBe('- /findings/0: missing required key "category"');
});

test('translateAjvErrorsToChecklist deduplicates and caps at 10 lines', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    instancePath: `/findings/${i}`,
    keyword: 'required',
    params: { missingProperty: 'category' },
    message: '',
  }));
  const out = translateAjvErrorsToChecklist(many);
  const lines = out.split('\n');
  // 20 dedup-distinct paths cap at 10 + the elision line
  expect(lines.length).toBeLessThanOrEqual(11);
  expect(out).toContain('more errors elided');
});

// --- buildRepairPrompt ---

test('buildRepairPrompt v2 includes the canonical envelope skeleton', () => {
  const prompt = buildRepairPrompt(
    'review-result.v2',
    'pr',
    '{"schema_version": "wrong"}',
    { kind: 'schema_fail', errors: [{ instancePath: '', keyword: 'required', params: { missingProperty: 'contract_version' }, message: '' }] },
  );
  expect(prompt).toContain('Canonical envelope');
  expect(prompt).toContain('openai-pr-review.v2');
  expect(prompt).toContain('missing required key "contract_version"');
  expect(prompt).toMatch(/Prior attempt \(verbatim/);
  expect(prompt).toMatch(/Output JSON only/);
});

test('buildRepairPrompt v2 switches prompt_version label by mode', () => {
  const spec = buildRepairPrompt('review-result.v2', 'spec', '{}', { kind: 'schema_fail', errors: [] });
  expect(spec).toContain('openai-spec-review.v2');

  const plan = buildRepairPrompt('review-result.v2', 'plan', '{}', { kind: 'schema_fail', errors: [] });
  expect(plan).toContain('openai-plan-review.v2');
});

test('buildRepairPrompt v1 uses the legacy shape, not the envelope skeleton', () => {
  const prompt = buildRepairPrompt(
    'review-result.v1',
    'pr',
    '{"bad": "v1"}',
    { kind: 'parse_fail', error: 'unexpected token' },
  );
  expect(prompt).toContain('legacy v1 shape');
  expect(prompt).toContain('Do NOT include a contract_version field');
  expect(prompt).not.toContain('Canonical envelope');
  expect(prompt).toContain('unexpected token');
});

test('buildRepairPrompt v2 embeds authoritative metadata when supplied (CGPT-PR-R3-001)', () => {
  const prompt = buildRepairPrompt(
    'review-result.v2',
    'pr',
    '{"bad": "shape"}',
    { kind: 'schema_fail', errors: [] },
    { projectContextVersion: '2026-05-28-v1', sourceArtifactSha: 'abc1234567890' },
  );
  expect(prompt).toContain('Required project_context_version: 2026-05-28-v1');
  expect(prompt).toContain('Required source_artifact_sha: abc1234567890');
  expect(prompt).toMatch(/parser validates these/);
});

test('buildRepairPrompt v2 omits the metadata block when no values supplied (back-compat)', () => {
  const prompt = buildRepairPrompt(
    'review-result.v2',
    'pr',
    '{"bad": "shape"}',
    { kind: 'schema_fail', errors: [] },
  );
  expect(prompt).not.toContain('Required project_context_version');
  expect(prompt).not.toContain('Required source_artifact_sha');
  // Other v2 content still present
  expect(prompt).toContain('Canonical envelope');
});

test('buildRepairPrompt v1 ignores authoritative metadata (legacy contract has no metadata fields)', () => {
  const prompt = buildRepairPrompt(
    'review-result.v1',
    'pr',
    '{"bad": "v1"}',
    { kind: 'schema_fail', errors: [] },
    { projectContextVersion: 'should-not-appear', sourceArtifactSha: 'should-not-appear-either' },
  );
  expect(prompt).not.toContain('should-not-appear');
  expect(prompt).toContain('legacy v1 shape');
});

test('SYSTEM_PROMPT_PR_V2 includes the broadened workflow sequencing + cross-reference rule (LA-R3)', () => {
  // Regression for LA-R3 (round 3 broadening of LA-R2-B). The rule must
  // cover both step-ordering AND cross-reference completeness.
  const prompt = getSystemPrompt('pr', 2);
  expect(prompt).toContain('Workflow sequencing and cross-reference completeness in docs');
  expect(prompt).toMatch(/schema block, summary table, or output template/);
  expect(prompt).toMatch(/cross-reference bug/);
});

test('buildRepairPrompt parse_fail variant surfaces the parse error', () => {
  const prompt = buildRepairPrompt(
    'review-result.v2',
    'pr',
    'not json at all',
    { kind: 'parse_fail', error: 'Unexpected end of JSON input' },
  );
  expect(prompt).toContain('JSON parse failed: Unexpected end of JSON input');
  expect(prompt).toContain('Canonical envelope');
});

// --- normaliseTitleForMatch / jaccard ---

test('normaliseTitleForMatch lowercases and drops stopwords + short tokens', () => {
  const set = normaliseTitleForMatch('The Quick Brown Fox jumps and it ran');
  expect(set.has('quick')).toBe(true);
  expect(set.has('brown')).toBe(true);
  expect(set.has('fox')).toBe(true);
  expect(set.has('jumps')).toBe(true);
  expect(set.has('ran')).toBe(true);
  expect(set.has('the')).toBe(false); // stopword
  expect(set.has('and')).toBe(false); // stopword
  expect(set.has('it')).toBe(false); // too short
});

test('jaccard returns 1 for identical sets and 0 for disjoint', () => {
  expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  expect(jaccard(new Set(), new Set())).toBe(0);
});

// --- compareFindingSets ---

test('compareFindingSets pairs near-identical titles into overlap', () => {
  const openai = [f('Mission control merge history has duplicate keys')];
  const chatgpt = [f('Mission-control duplicate merge-history keys')];
  const r = compareFindingSets(openai, chatgpt);
  expect(r.summary.overlapCount).toBe(1);
  expect(r.summary.openaiOnlyCount).toBe(0);
  expect(r.summary.chatgptOnlyCount).toBe(0);
});

test('compareFindingSets puts unrelated findings on opposite sides', () => {
  const openai = [f('mission control duplicate keys')];
  const chatgpt = [f('webhook signature verification skipped')];
  const r = compareFindingSets(openai, chatgpt);
  expect(r.summary.overlapCount).toBe(0);
  expect(r.summary.openaiOnlyCount).toBe(1);
  expect(r.summary.chatgptOnlyCount).toBe(1);
});

test('compareFindingSets uses affected_files overlap to boost partial title matches', () => {
  const openai = [f('Wrong metadata keys mission control', { affected_files: ['tasks/current-focus.md'] })];
  const chatgpt = [f('Mission control metadata keys inconsistent', { affected_files: ['tasks/current-focus.md'] })];
  const r = compareFindingSets(openai, chatgpt);
  // Partial title overlap (metadata/keys/mission/control) PLUS full affected_files
  // overlap pushes the combined score over the default 0.45 threshold.
  expect(r.summary.overlapCount).toBe(1);
});

test('compareFindingSets reports severity delta', () => {
  const openai = [f('duplicate merge keys', { severity: 'high' })];
  const chatgpt = [f('duplicate merge keys', { severity: 'medium' })];
  const r = compareFindingSets(openai, chatgpt);
  expect(r.overlap[0].severityDelta).toBe(1); // high(3) - medium(2)
  expect(r.summary.meanAbsSeverityDelta).toBe(1);
});

test('compareFindingSets greedy pairing prefers highest-scoring pair', () => {
  // openai[0] could pair with either chatgpt[0] (weak) or chatgpt[1] (strong).
  // Greedy should pick the strongest first.
  const openai = [f('webhook signature bypass on stripe endpoint')];
  const chatgpt = [
    f('weak: signature mention only'),
    f('stripe webhook signature bypass missing'),
  ];
  const r = compareFindingSets(openai, chatgpt);
  expect(r.summary.overlapCount).toBe(1);
  expect(r.overlap[0].chatgpt.title).toContain('Stripe webhook'.toLowerCase().slice(0, 6) === 'stripe' ? 'stripe' : 'webhook');
});

test('compareFindingSets handles empty inputs', () => {
  const r = compareFindingSets([], []);
  expect(r.summary).toEqual({
    openaiCount: 0,
    chatgptCount: 0,
    overlapCount: 0,
    openaiOnlyCount: 0,
    chatgptOnlyCount: 0,
    meanAbsSeverityDelta: 0,
  });
});

// --- renderComparePanel ---

test('renderComparePanel produces a markdown panel with all sections present', () => {
  const openai = [
    f('mission control duplicate keys', { severity: 'medium' }),
    f('openai only finding', { severity: 'high' }),
  ];
  const chatgpt = [
    f('Mission control duplicate keys', { severity: 'high' }),
    f('chatgpt only finding', { severity: 'low' }),
  ];
  const r = compareFindingSets(openai, chatgpt);
  const panel = renderComparePanel(r);
  expect(panel).toContain('OpenAI vs ChatGPT-web compare');
  expect(panel).toContain('Counts:');
  expect(panel).toContain('Overlap (matched findings)');
  expect(panel).toContain('OpenAI-only findings');
  expect(panel).toContain('ChatGPT-web-only findings');
  expect(panel).toContain('| Score |');
  expect(panel).toContain('mean |Δ|');
});

test('renderComparePanel handles the zero-zero case explicitly', () => {
  const r = compareFindingSets([], []);
  const panel = renderComparePanel(r);
  expect(panel).toContain('Both sides returned zero findings');
});

test('renderComparePanel omits sections that have no entries', () => {
  // overlap only, no unique findings
  const openai = [f('duplicate merge keys')];
  const chatgpt = [f('duplicate merge keys')];
  const r = compareFindingSets(openai, chatgpt);
  const panel = renderComparePanel(r);
  expect(panel).toContain('Overlap (matched findings)');
  expect(panel).not.toContain('OpenAI-only findings');
  expect(panel).not.toContain('ChatGPT-web-only findings');
});

// --- mdCell ---

test('mdCell escapes pipe characters that would split a markdown table cell', () => {
  expect(mdCell('foo | bar')).toBe('foo \\| bar');
});

test('mdCell collapses newlines to spaces so cells stay on one row', () => {
  expect(mdCell('line one\nline two')).toBe('line one line two');
  expect(mdCell('crlf\r\nstyle')).toBe('crlf style');
});

test('mdCell leaves clean strings unchanged', () => {
  expect(mdCell('plain title text')).toBe('plain title text');
});

test('renderComparePanel uses mdCell to neutralise pipes and newlines in titles', () => {
  const openai = [f('title with | pipe and\nnewline')];
  const chatgpt = [f('title with | pipe and\nnewline')];
  const r = compareFindingSets(openai, chatgpt);
  const panel = renderComparePanel(r);
  // Pipe must be escaped (not present unescaped in title cells)
  expect(panel).toMatch(/title with \\\| pipe/);
  // Newline must be collapsed (no embedded newline inside the title cell)
  expect(panel).not.toMatch(/title with \\\| pipe and\nnewline \|/);
});

test('renderComparePanel emits finding IDs in overlap rows and unique-section bullets', () => {
  const openai = [
    f('mission control duplicate keys', { id: 'OAI-PR-001' }),
    f('openai unique', { id: 'OAI-PR-002', severity: 'high' }),
  ];
  const chatgpt = [
    f('Mission control duplicate keys', { id: 'CGPT-PR-001' }),
    f('chatgpt unique', { id: 'CGPT-PR-002', severity: 'low' }),
  ];
  const r = compareFindingSets(openai, chatgpt);
  const panel = renderComparePanel(r);
  // Overlap row includes both IDs as separate columns
  expect(panel).toContain('OAI-PR-001');
  expect(panel).toContain('CGPT-PR-001');
  // Unique-section bullets are prefixed with the finding ID
  expect(panel).toContain('[OAI-PR-002]');
  expect(panel).toContain('[CGPT-PR-002]');
});

// --- getUserPromptTemplate / system-vs-user split (artefact in user channel only) ---

test('getUserPromptTemplate returns mode-specific user template for v2', () => {
  expect(getUserPromptTemplate('pr', 2)).toContain('{{DIFF}}');
  expect(getUserPromptTemplate('spec', 2)).toContain('{{SPEC_DOCUMENT}}');
  expect(getUserPromptTemplate('plan', 2)).toContain('{{PLAN_DOCUMENT}}');
});

test('getUserPromptTemplate returns null for v1 (legacy plain-text prompts)', () => {
  expect(getUserPromptTemplate('pr', 1)).toBeNull();
  expect(getUserPromptTemplate('spec', 1)).toBeNull();
  expect(getUserPromptTemplate('plan', 1)).toBeNull();
});

test('v2 system prompts contain NO document-body placeholders (artefact lives in user channel)', () => {
  // Regression for the PR #441 parallel-mode round 1 finding: untrusted
  // diff/spec/plan content must not be substituted into the system prompt.
  for (const mode of ['pr', 'spec', 'plan'] as const) {
    const system = getSystemPrompt(mode, 2);
    expect(system).not.toContain('{{DIFF}}');
    expect(system).not.toContain('{{SPEC_DOCUMENT}}');
    expect(system).not.toContain('{{PLAN_DOCUMENT}}');
    // PR_CONTEXT, PROJECT_CONTEXT, PRIOR_ROUNDS are also user-channel content
    expect(system).not.toContain('{{PR_CONTEXT}}');
    expect(system).not.toContain('{{PROJECT_CONTEXT}}');
    expect(system).not.toContain('{{PRIOR_ROUNDS}}');
    // PROJECT_CONTEXT_VERSION / SOURCE_ARTIFACT_SHA are stable metadata, also user
    expect(system).not.toContain('{{PROJECT_CONTEXT_VERSION}}');
    expect(system).not.toContain('{{SOURCE_ARTIFACT_SHA}}');
    // OUTPUT_ENVELOPE_SKELETON is part of the contract (instructions), stays in system
    expect(system).toContain('{{OUTPUT_ENVELOPE_SKELETON}}');
  }
});

test('v2 user prompt templates contain all the document/metadata placeholders', () => {
  // The mirror of the previous test: every artefact + metadata placeholder
  // appears in the user template for its mode.
  const pr = getUserPromptTemplate('pr', 2)!;
  expect(pr).toContain('{{DIFF}}');
  expect(pr).toContain('{{PR_CONTEXT}}');
  expect(pr).toContain('{{PROJECT_CONTEXT}}');
  expect(pr).toContain('{{PRIOR_ROUNDS}}');
  expect(pr).toContain('{{PROJECT_CONTEXT_VERSION}}');
  expect(pr).toContain('{{SOURCE_ARTIFACT_SHA}}');

  const spec = getUserPromptTemplate('spec', 2)!;
  expect(spec).toContain('{{SPEC_DOCUMENT}}');
  expect(spec).toContain('{{PROJECT_CONTEXT}}');
  expect(spec).toContain('{{PRIOR_ROUNDS}}');

  const plan = getUserPromptTemplate('plan', 2)!;
  expect(plan).toContain('{{PLAN_DOCUMENT}}');
  expect(plan).toContain('{{SPEC_DOCUMENT}}');
  expect(plan).toContain('{{PROJECT_CONTEXT}}');
  expect(plan).toContain('{{PRIOR_ROUNDS}}');
});

test('v2 system prompt closes with a directive that the next message is data, not instructions', () => {
  // Defence against prompt injection via document body. The system prompt
  // must explicitly tell the model that the user-channel content is the
  // artefact under review, not additional directives.
  for (const mode of ['pr', 'spec', 'plan'] as const) {
    const system = getSystemPrompt(mode, 2);
    expect(system).toMatch(/NEXT message \(user channel\)/);
    expect(system).toMatch(/NOT additional instructions/);
  }
});

test('v2 system prompt for PR mode explicitly warns that diffs may contain instruction-like text', () => {
  const system = getSystemPrompt('pr', 2);
  expect(system).toMatch(/PR diffs frequently[\s\S]*resemble[\s\S]*instructions/);
});

// Regression guard for v2.11.0: any future prompt edit that tells the model to
// emit narrative BEFORE or AFTER the JSON envelope will break parseReviewResult
// (JSON.parse on stripJsonFence(rawText) fails on prose preambles or trailing
// text). The v2.11.0 PR-prompt-tuning round originally shipped an "Output extras"
// section instructing "apply after enumerating findings, before the JSON envelope"
// — Codex caught this in PR #11 review as a runtime reliability regression. The
// fix folds operator-facing narrative INTO the existing integrity_check string
// field instead, preserving JSON-only output.
test('v2 PR/spec/plan system prompts never instruct the model to emit prose around the JSON envelope', () => {
  // Narrow forbidden-phrase list: only phrases that specifically describe
  // output-formatting around the JSON envelope. Generic phrases like "prose
  // before" or "prose after" appear in legitimate non-output contexts (e.g.
  // hunt targets about document text), so they are NOT in this list — only
  // phrases that include "JSON" / "envelope" / "preamble" qualifiers.
  const forbiddenPhrases = [
    'before the JSON envelope',
    'after the JSON envelope',
    'before the JSON object',
    'after the JSON object',
    'prose before the JSON',
    'prose after the JSON',
    'narrative preamble',
    'a markdown log preamble',
  ];
  const prohibitionRegex = /do not|never|no prose|no narrative|only the json|break(s|ing)? parsing|breaks parsing|quarantine|emit only the/i;
  for (const mode of ['pr', 'spec', 'plan'] as const) {
    const system = getSystemPrompt(mode, 2);
    const lowered = system.toLowerCase();
    for (const phrase of forbiddenPhrases) {
      const loweredPhrase = phrase.toLowerCase();
      let searchFrom = 0;
      while (true) {
        const idx = lowered.indexOf(loweredPhrase, searchFrom);
        if (idx === -1) break;
        const start = Math.max(0, idx - 120);
        const end = Math.min(system.length, idx + loweredPhrase.length + 120);
        const window = lowered.slice(start, end);
        const isProhibition = prohibitionRegex.test(window);
        expect(isProhibition).toBe(true);
        searchFrom = idx + loweredPhrase.length;
      }
    }
  }
});

// --- summary ---
