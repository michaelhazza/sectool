/**
 * knowledge-citationsPure.test.ts
 *
 * Pure-function tests for the citations/staleness core: a cited entry is
 * counted (incl. the 3+ promotion threshold), an entry naming a deleted path is
 * flagged (spec acceptance criterion), and the advisory report renders both
 * sections.
 *
 * Run via: npx vitest run scripts/__tests__/knowledge-citationsPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  countCitations,
  findStaleEntries,
  renderReport,
  parseKnowledgeEntries,
} from '../knowledge-citationsPure.js';

const KNOWLEDGE = [
  '### [2026-07-07] Pattern - RLS coverage gate keys only on organisation_id', // 1
  '',
  '`scripts/verify-rls.ts` and `scripts/gates/verify-fk-only-tenant-tables.sh` miss', // 3
  'subaccount-only tables. This is a tenant isolation gap.', // 4
  '',
  '### [2026-07-06] Gotcha - Skill retries reference a since-deleted helper', // 6
  '',
  'The old `server/services/skillAnalyzerService/legacy/retry.ts` was removed.', // 8
].join('\n');

test('parseKnowledgeEntries: two entries with correct lines', () => {
  const entries = parseKnowledgeEntries(KNOWLEDGE);
  expect(entries.map((e) => e.line)).toEqual([1, 6]);
});

test('countCitations: a cited entry is counted across docs and ordered by count', () => {
  const entries = parseKnowledgeEntries(KNOWLEDGE);
  const docs = [
    {
      path: 'tasks/builds/x/spec.md',
      // Quotes the first entry's title three times → hits the promotion threshold.
      text:
        'See Pattern - RLS coverage gate keys only on organisation_id.\n' +
        'Again: pattern - rls coverage gate keys only on organisation_id (case-insensitive).\n' +
        'Pattern - RLS coverage gate keys only on organisation_id — third mention.',
    },
    {
      path: 'docs/decisions/0009.md',
      text: 'Unrelated prose that cites nothing from the knowledge base.',
    },
  ];
  const results = countCitations(entries, docs);
  expect(results).toHaveLength(1);
  expect(results[0].entry.date).toBe('2026-07-07');
  expect(results[0].count).toBe(3);
  expect(results[0].citingFiles).toEqual(['tasks/builds/x/spec.md']);
});

test('findStaleEntries: flags a fixture entry naming a deleted path', () => {
  const entries = parseKnowledgeEntries(KNOWLEDGE);
  // Everything exists EXCEPT the legacy retry helper named by the 2nd entry.
  const existing = new Set([
    'scripts/verify-rls.ts',
    'scripts/gates/verify-fk-only-tenant-tables.sh',
  ]);
  const stale = findStaleEntries(entries, (p) => existing.has(p));
  expect(stale).toHaveLength(1);
  expect(stale[0].entry.date).toBe('2026-07-06');
  expect(stale[0].missing).toEqual(['server/services/skillAnalyzerService/legacy/retry.ts']);
});

test('findStaleEntries: no findings when every referenced path exists', () => {
  const entries = parseKnowledgeEntries(KNOWLEDGE);
  const stale = findStaleEntries(entries, () => true);
  expect(stale).toEqual([]);
});

test('renderReport: both sections render with the promotion flag', () => {
  const entries = parseKnowledgeEntries(KNOWLEDGE);
  const citations = countCitations(entries, [
    { path: 'tasks/a.md', text: 'Pattern - RLS coverage gate keys only on organisation_id '.repeat(3) },
  ]);
  const stale = findStaleEntries(entries, (p) => p !== 'server/services/skillAnalyzerService/legacy/retry.ts');
  const report = renderReport({
    timestamp: '2026-07-10T00:00:00.000Z',
    scannedDocCount: 1,
    entryCount: entries.length,
    citations,
    stale,
  });
  expect(report).toContain('# Knowledge citation & staleness report — generated 2026-07-10T00:00:00.000Z');
  expect(report).toContain('## Citation counts');
  expect(report).toContain('[PROMOTE?]');
  expect(report).toContain('## Stale entries');
  expect(report).toContain('server/services/skillAnalyzerService/legacy/retry.ts');
});

test('renderReport: empty-state copy when nothing is cited or stale', () => {
  const report = renderReport({
    timestamp: '2026-07-10T00:00:00.000Z',
    scannedDocCount: 0,
    entryCount: 0,
    citations: [],
    stale: [],
  });
  expect(report).toContain('_No KNOWLEDGE entries are referenced in the scanned docs._');
  expect(report).toContain('_No stale path references found._');
});
