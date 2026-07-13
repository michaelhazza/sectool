/**
 * harness-metricsPure.test.ts
 *
 * Pure-function tests for the review-harness metrics aggregator: slug extraction,
 * multi-format timestamp normalization, malformed-line skip + count, per-slug
 * grouping, the derivable metrics (findings/reviewer, rejected FP-proxy, fix-loop
 * iterations, rounds, quarantine-rate), the not-derivable markers, the
 * corpus-range header, the rolling 30-day window, and the all-keys-present
 * emit contract.
 *
 * Run via: npx vitest run scripts/__tests__/harness-metricsPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  extractSlug,
  extractFileTs,
  normalizeTimestamp,
  parseDecisionsFile,
  computeMetrics,
  aggregate,
  METRIC_KEYS,
  type ParsedFile,
} from '../harness-metricsPure.js';

// ── slug + timestamp helpers ──────────────────────────────────────────────

test('extractSlug: strips prefix, timestamp suffix, and .jsonl', () => {
  expect(
    extractSlug('coordinator-decisions-instant-answers-ghl-writeback-2026-07-08T015917Z.jsonl'),
  ).toBe('instant-answers-ghl-writeback');
  // dashed-time timestamp form
  expect(
    extractSlug('coordinator-decisions-some-build-2026-05-18T14-35-17Z.jsonl'),
  ).toBe('some-build');
  // date-only timestamp form
  expect(extractSlug('coordinator-decisions-x-y-2026-07-08.jsonl')).toBe('x-y');
  // no recognizable timestamp → full remainder
  expect(extractSlug('coordinator-decisions-plain-slug.jsonl')).toBe('plain-slug');
});

test('extractFileTs: returns trailing timestamp or null', () => {
  expect(extractFileTs('coordinator-decisions-a-2026-07-08T015917Z.jsonl')).toBe('2026-07-08T015917Z');
  expect(extractFileTs('coordinator-decisions-a-b.jsonl')).toBeNull();
});

test('normalizeTimestamp: handles all observed shapes', () => {
  // compact HHMMSS
  expect(normalizeTimestamp('2026-07-08T015917Z')).toBe(Date.parse('2026-07-08T01:59:17Z'));
  // colon form
  expect(normalizeTimestamp('2026-07-08T01:59:17Z')).toBe(Date.parse('2026-07-08T01:59:17Z'));
  // dashed time
  expect(normalizeTimestamp('2026-05-18T14-35-17Z')).toBe(Date.parse('2026-05-18T14:35:17Z'));
  // date only
  expect(normalizeTimestamp('2026-07-08')).toBe(Date.parse('2026-07-08T00:00:00Z'));
  // junk
  expect(normalizeTimestamp('not-a-date')).toBeNull();
  expect(normalizeTimestamp(null)).toBeNull();
});

test('normalizeTimestamp: auditLog.ts writer form (hyphenated time, no Z) parses as UTC', () => {
  // buildAuditLogPath: new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)
  expect(normalizeTimestamp('2026-07-10T13-59-41')).toBe(Date.parse('2026-07-10T13:59:41Z'));
  // ...and is treated identically to the same instant with a trailing Z.
  expect(normalizeTimestamp('2026-07-10T13-59-41')).toBe(normalizeTimestamp('2026-07-10T13-59-41Z'));
});

test('extractSlug/extractFileTs: every real writer filename form yields slug + ts', () => {
  // auditLog.ts buildAuditLogPath form — hyphenated time, NO trailing Z
  const noZ = 'coordinator-decisions-demo-2026-07-10T13-59-41.jsonl';
  expect(extractSlug(noZ)).toBe('demo');
  expect(extractFileTs(noZ)).toBe('2026-07-10T13-59-41');
  expect(normalizeTimestamp(extractFileTs(noZ))).toBe(Date.parse('2026-07-10T13:59:41Z'));

  // same form with a trailing Z
  const withZ = 'coordinator-decisions-demo-2026-07-10T13-59-41Z.jsonl';
  expect(extractSlug(withZ)).toBe('demo');
  expect(extractFileTs(withZ)).toBe('2026-07-10T13-59-41Z');
  expect(normalizeTimestamp(extractFileTs(withZ))).toBe(Date.parse('2026-07-10T13:59:41Z'));

  // date-only
  const dateOnly = 'coordinator-decisions-demo-2026-07-10.jsonl';
  expect(extractSlug(dateOnly)).toBe('demo');
  expect(extractFileTs(dateOnly)).toBe('2026-07-10');
  expect(normalizeTimestamp(extractFileTs(dateOnly))).toBe(Date.parse('2026-07-10T00:00:00Z'));
});

test('extractSlug: a kebab slug with no date tail is never eaten by TS_TAIL', () => {
  expect(extractSlug('coordinator-decisions-instant-answers-ghl-writeback.jsonl')).toBe(
    'instant-answers-ghl-writeback',
  );
});

// ── malformed-line skip + count ───────────────────────────────────────────

test('parseDecisionsFile: skips and counts malformed lines, keeps valid ones', () => {
  const content = [
    '{"ts":"2026-07-08T015917Z","reviewer":"claude-plan-review","iteration":1,"decision":"applied","finding":"CPR-1"}',
    'not json at all',
    '', // blank skipped silently (not counted malformed)
    '[1,2,3]', // valid JSON but not an object → malformed
    '{"ts":"2026-07-08T020403Z","reviewer":"chatgpt-plan-review","iteration":1,"decision":"rejected","finding":"OAI-1"}',
  ].join('\n');
  const pf = parseDecisionsFile('coordinator-decisions-demo-2026-07-08T015917Z.jsonl', content);
  expect(pf.slug).toBe('demo');
  expect(pf.records).toHaveLength(2);
  expect(pf.malformedCount).toBe(2);
  expect(pf.malformedSamples.length).toBe(2);
  expect(pf.records[0].decision).toBe('applied');
  expect(pf.records[0].round).toBe(1);
});

test('parseDecisionsFile: reads finding_id/round aliases', () => {
  const content =
    '{"ts":"2026-07-08","reviewer":"claude-spec-review","round":2,"finding_id":"CSR-1","decision":"accepted"}';
  const pf = parseDecisionsFile('coordinator-decisions-alias-2026-07-08.jsonl', content);
  expect(pf.records[0].round).toBe(2);
  expect(pf.records[0].reviewer).toBe('claude-spec-review');
  expect(pf.records[0].decision).toBe('accepted');
});

// ── derivable metrics ─────────────────────────────────────────────────────

test('computeMetrics: derivable metrics compute correctly', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-m-2026-07-08T010000Z.jsonl',
    [
      '{"reviewer":"A","decision":"applied","round":1}',
      '{"reviewer":"A","decision":"rejected","round":1}',
      '{"reviewer":"B","decision":"rejected","round":2}',
      '{"reviewer":"B","decision":"quarantined","round":2}',
    ].join('\n'),
  );
  const m = computeMetrics(pf.records);
  expect(m['findings-per-reviewer-per-build'].value).toEqual({ A: 2, B: 2 });
  expect(m['fp-proxy-rejected-per-reviewer-per-build'].value).toEqual({ A: 1, B: 1 });
  expect(m['fix-loop-iterations-per-build'].value).toBe(2);
  expect(m['rounds-per-build'].value).toBe(2); // distinct rounds {1,2}
  expect(m['quarantine-rate'].value).toBe(0.25); // 1 of 4
  expect(m['quarantine-rate'].status).toBe('ok');
});

test('computeMetrics: quarantine-rate of 0 is ok, not no-data', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-z-2026-07-08.jsonl',
    '{"reviewer":"A","decision":"applied","round":1}',
  );
  const m = computeMetrics(pf.records);
  expect(m['quarantine-rate'].value).toBe(0);
  expect(m['quarantine-rate'].status).toBe('ok');
});

test('computeMetrics: no round field → fix-loop and rounds report no-data', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-nr-2026-07-08.jsonl',
    '{"reviewer":"A","decision":"applied"}',
  );
  const m = computeMetrics(pf.records);
  expect(m['fix-loop-iterations-per-build'].status).toBe('no-data');
  expect(m['rounds-per-build'].status).toBe('no-data');
});

// ── auto-apply-success-rate (derived from acceptance_check_outcome) ─────────

test('computeMetrics: auto-apply-success-rate = passed / (passed + failed)', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-aa-2026-07-10T13-59-41.jsonl',
    [
      '{"reviewer":"A","decision":"applied","acceptance_check_outcome":"passed"}',
      '{"reviewer":"A","decision":"already_applied_by_reviewer","acceptance_check_outcome":"passed"}',
      '{"reviewer":"A","decision":"auto_apply_failed","acceptance_check_outcome":"failed"}',
      // deferred → excluded from numerator AND denominator
      '{"reviewer":"A","decision":"overridden_to_surface","acceptance_check_outcome":"deferred"}',
      // missing field (legacy row) → excluded from both
      '{"reviewer":"A","decision":"applied"}',
    ].join('\n'),
  );
  const m = computeMetrics(pf.records);
  // 2 passed / (2 passed + 1 failed) = 3 attempts
  expect(m['auto-apply-success-rate'].status).toBe('ok');
  expect(m['auto-apply-success-rate'].value).toBeCloseTo(2 / 3, 10);
  // denominator (attempt count) reported in the note
  expect(m['auto-apply-success-rate'].note).toContain('2 passed of 3 auto-apply attempts');
});

test('computeMetrics: auto-apply-success-rate with zero attempts → null + no-attempts note', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-aa0-2026-07-10.jsonl',
    [
      // only deferred and missing-field rows: no attempt was ever made
      '{"reviewer":"A","decision":"overridden_to_surface","acceptance_check_outcome":"deferred"}',
      '{"reviewer":"A","decision":"applied"}',
    ].join('\n'),
  );
  const m = computeMetrics(pf.records);
  expect(m['auto-apply-success-rate'].value).toBeNull();
  expect(m['auto-apply-success-rate'].status).toBe('no-data');
  expect(m['auto-apply-success-rate'].note).toBe('no auto-apply attempts in corpus');
});

// ── not-derivable markers + all keys present ──────────────────────────────

test('computeMetrics: every METRIC_KEY is present; not-derivable ones are marked', () => {
  const pf = parseDecisionsFile(
    'coordinator-decisions-k-2026-07-08.jsonl',
    '{"reviewer":"A","decision":"applied","round":1}',
  );
  const m = computeMetrics(pf.records);
  for (const key of METRIC_KEYS) {
    expect(m).toHaveProperty(key);
  }
  // auto-apply-success-rate is now derivable; this fixture has no
  // acceptance_check_outcome field, so it reports no-data (null), not not-derivable.
  expect(m['auto-apply-success-rate'].status).toBe('no-data');
  expect(m['auto-apply-success-rate'].value).toBeNull();
  expect(m['operator-override-rate'].status).toBe('not-derivable');
  expect(m['schema-validation-rate'].status).toBe('not-derivable');
  expect(m['suppression-false-negative-rate'].status).toBe('not-derivable');
});

// ── per-slug grouping + corpus header + 30-day window ─────────────────────

function pf(name: string, lines: string[]): ParsedFile {
  return parseDecisionsFile(name, lines.join('\n'));
}

test('aggregate: groups per slug, builds corpus header, all keys per build', () => {
  const files = [
    pf('coordinator-decisions-build-one-2026-07-08T010000Z.jsonl', [
      '{"ts":"2026-07-08T010000Z","reviewer":"A","decision":"applied","round":1}',
      '{"ts":"2026-07-08T010500Z","reviewer":"A","decision":"rejected","round":1}',
    ]),
    pf('coordinator-decisions-build-two-2026-07-09T010000Z.jsonl', [
      '{"ts":"2026-07-09T010000Z","reviewer":"B","decision":"accepted","round":1}',
    ]),
  ];
  const report = aggregate(files);

  expect(report.header.fileCount).toBe(2);
  expect(report.header.recordCount).toBe(3);
  expect(report.header.slugs).toEqual(['build-one', 'build-two']);
  expect(report.header.earliestTs).toBe('2026-07-08T01:00:00.000Z');
  expect(report.header.latestTs).toBe('2026-07-09T01:00:00.000Z');

  expect(report.builds).toHaveLength(2);
  const one = report.builds.find((b) => b.slug === 'build-one')!;
  expect(one.recordCount).toBe(2);
  expect(one.metrics['findings-per-reviewer-per-build'].value).toEqual({ A: 2 });
  // every key present on every build block
  for (const b of report.builds) {
    for (const key of METRIC_KEYS) expect(b.metrics).toHaveProperty(key);
  }
});

test('aggregate: two files same slug merge into one build block', () => {
  const files = [
    pf('coordinator-decisions-same-2026-07-08T010000Z.jsonl', [
      '{"ts":"2026-07-08T010000Z","reviewer":"A","decision":"applied","round":1}',
    ]),
    pf('coordinator-decisions-same-2026-07-08T140000Z.jsonl', [
      '{"ts":"2026-07-08T140000Z","reviewer":"A","decision":"rejected","round":1}',
    ]),
  ];
  const report = aggregate(files);
  expect(report.header.slugs).toEqual(['same']);
  expect(report.builds).toHaveLength(1);
  expect(report.builds[0].fileCount).toBe(2);
  expect(report.builds[0].recordCount).toBe(2);
});

test('aggregate: two runs of one build (auditLog.ts + date-only ts) collapse to ONE build block', () => {
  // Regression for the leak where an un-parsed timestamp fell into the slug,
  // splitting repeated runs of the same build into distinct builds.
  const files = [
    pf('coordinator-decisions-demo-2026-07-10T13-59-41.jsonl', [
      '{"ts":"2026-07-10T13-59-41","reviewer":"A","decision":"applied","round":1}',
    ]),
    pf('coordinator-decisions-demo-2026-07-11.jsonl', [
      '{"ts":"2026-07-11","reviewer":"A","decision":"rejected","round":1}',
    ]),
  ];
  const report = aggregate(files);
  expect(report.header.slugs).toEqual(['demo']);
  expect(report.builds).toHaveLength(1);
  expect(report.builds[0].fileCount).toBe(2);
  expect(report.builds[0].recordCount).toBe(2);
});

test('aggregate: 30-day window anchors to latest ts and excludes older records', () => {
  const files = [
    pf('coordinator-decisions-old-2026-05-01T010000Z.jsonl', [
      '{"ts":"2026-05-01T010000Z","reviewer":"A","decision":"applied","round":1}', // >30d before anchor
    ]),
    pf('coordinator-decisions-new-2026-07-08T010000Z.jsonl', [
      '{"ts":"2026-07-08T010000Z","reviewer":"B","decision":"applied","round":1}',
    ]),
  ];
  const report = aggregate(files);
  expect(report.window30d.anchorTs).toBe('2026-07-08T01:00:00.000Z');
  // only the July record is inside the 30-day window
  expect(report.window30d.recordCount).toBe(1);
  for (const key of METRIC_KEYS) expect(report.window30d.metrics).toHaveProperty(key);
});

test('aggregate: malformed counts roll up into the header', () => {
  const files = [
    pf('coordinator-decisions-bad-2026-07-08T010000Z.jsonl', [
      '{"ts":"2026-07-08T010000Z","reviewer":"A","decision":"applied","round":1}',
      'garbage',
      '{"nope"',
    ]),
  ];
  const report = aggregate(files);
  expect(report.header.malformedSkipped).toBe(2);
  expect(report.header.recordCount).toBe(1);
});
