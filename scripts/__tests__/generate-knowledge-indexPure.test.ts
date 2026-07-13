/**
 * generate-knowledge-indexPure.test.ts
 *
 * Pure-function tests for the knowledge-index core: entry extraction (line
 * numbers, date/title split, template-placeholder skip, body bounding), body
 * path extraction, keyword derivation, archive inclusion, and the pinned
 * render format.
 *
 * Run via: npx vitest run scripts/__tests__/generate-knowledge-indexPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  extractEntries,
  extractBodyPaths,
  buildKeywords,
  buildIndex,
} from '../generate-knowledge-indexPure.js';

const SAMPLE = [
  '# Project Knowledge Base', // 1
  '', // 2
  '## How to Use', // 3
  '', // 4
  '### [YYYY-MM-DD] [Category] — [Short title]', // 5 (template placeholder — skipped)
  '', // 6
  '### [2026-07-07] Pattern - verify-rls.ts keys only on organisation_id', // 7
  '', // 8
  '`scripts/verify-rls.ts:450` misses subaccount-only tables. This is a tenant', // 9
  'RLS coverage gap. See docs/decisions/0012-rls.md for the follow-up.', // 10
  '', // 11
  '### [2026-07-06] Gotcha - Skill retries must not hold tenant transactions', // 12
  '', // 13
  'Keep `server/services/skillAnalyzerService/execute/retry.ts` in short blocks.', // 14
].join('\n');

test('extractEntries: skips the template placeholder and records 1-based lines', () => {
  const entries = extractEntries(SAMPLE);
  expect(entries).toHaveLength(2);
  expect(entries[0].line).toBe(7);
  expect(entries[0].date).toBe('2026-07-07');
  expect(entries[0].title).toBe('Pattern - verify-rls.ts keys only on organisation_id');
  expect(entries[1].line).toBe(12);
  expect(entries[1].date).toBe('2026-07-06');
});

test('extractEntries: body is bounded by the next heading', () => {
  const entries = extractEntries(SAMPLE);
  expect(entries[0].body).toContain('scripts/verify-rls.ts:450');
  expect(entries[0].body).toContain('docs/decisions/0012-rls.md');
  // The next entry's heading and body must NOT leak into this one.
  expect(entries[0].body).not.toContain('skillAnalyzerService');
});

test('extractBodyPaths: extracts extension-bearing paths verbatim, strips :line locators, dedupes', () => {
  const body = 'See `scripts/verify-rls.ts:450` and scripts/verify-rls.ts again, plus docs/x.md.';
  expect(extractBodyPaths(body)).toEqual(['scripts/verify-rls.ts', 'docs/x.md']);
});

test('extractBodyPaths: ignores directory-ish slashes without a file extension', () => {
  const body = 'test-run isolation at read/aggregate time for org/subaccount scoping.';
  expect(extractBodyPaths(body)).toEqual([]);
});

test('buildKeywords: title tokens, then body paths, then domain terms — deduped and ordered', () => {
  const title = 'Pattern - verify-rls.ts keys only on organisation_id';
  const body = '`scripts/verify-rls.ts:450` misses subaccount tables — a tenant RLS gap.';
  const kw = buildKeywords(title, body);
  // Title tokens come first (lowercased, stopwords/short/pure-number dropped).
  expect(kw).toContain('pattern');
  expect(kw).toContain('verify-rls.ts');
  expect(kw).toContain('organisation_id');
  // Body path kept verbatim.
  expect(kw).toContain('scripts/verify-rls.ts');
  // Domain terms detected as whole words.
  expect(kw).toContain('tenant');
  expect(kw).toContain('rls');
  expect(kw).toContain('subaccount');
  // Determinism: no duplicates.
  expect(new Set(kw).size).toBe(kw.length);
});

test('buildKeywords: whole-word domain matching does not fire on substrings', () => {
  // "reviewer" must not trigger the "review" domain term via substring.
  const kw = buildKeywords('Something about a reviewer role', 'nothing else here');
  expect(kw).not.toContain('review');
});

test('buildIndex: renders the pinned header + entry lines across multiple sources', () => {
  const archive = [
    '### [2026-04-01] Pattern - old webhook idempotency lesson', // line 1
    '',
    'The `server/webhooks/handler.ts` needs a dedupe key.',
  ].join('\n');

  const index = buildIndex(
    [
      { file: 'KNOWLEDGE.md', text: SAMPLE },
      { file: 'KNOWLEDGE-archive-2026-Q2.md', text: archive },
    ],
    '2026-07-10T00:00:00.000Z',
  );

  const lines = index.output.split('\n');
  expect(lines[0]).toBe('# Knowledge index — generated 2026-07-10T00:00:00.000Z');
  expect(lines[1]).toBe(
    '# sources: KNOWLEDGE.md (14 lines), KNOWLEDGE-archive-2026-Q2.md (3 lines)',
  );

  // Stats: two live entries in KNOWLEDGE.md, one in the archive.
  expect(index.stats).toEqual([
    { file: 'KNOWLEDGE.md', lineCount: 14, entryCount: 2 },
    { file: 'KNOWLEDGE-archive-2026-Q2.md', lineCount: 3, entryCount: 1 },
  ]);

  // Entry line format: <file>:<line> | <date> | <title> | <keywords>.
  const firstEntryLine = lines[2];
  expect(firstEntryLine.startsWith('KNOWLEDGE.md:7 | 2026-07-07 | ')).toBe(true);
  const parts = firstEntryLine.split(' | ');
  expect(parts).toHaveLength(4);

  // Archive entry appears last, keyed to its own file/line and greppable.
  const archiveLine = lines.find((l) => l.startsWith('KNOWLEDGE-archive-2026-Q2.md:1 | '));
  expect(archiveLine).toBeDefined();
  expect(archiveLine).toContain('webhook');
  expect(archiveLine).toContain('server/webhooks/handler.ts');
});

test('extractEntries: handles CRLF line terminators (archives are Windows-authored)', () => {
  // A CRLF document must yield the same entries as its LF twin — a trailing \r
  // would otherwise defeat the anchored heading regex and report zero entries.
  const crlf = SAMPLE.split('\n').join('\r\n');
  const lf = extractEntries(SAMPLE);
  const crlfEntries = extractEntries(crlf);
  expect(crlfEntries.map((e) => e.line)).toEqual(lf.map((e) => e.line));
  expect(crlfEntries[0].title).toBe(lf[0].title);
  expect(crlfEntries[0].body).not.toContain('\r');
});

test('buildIndex: entries are ordered file-then-line', () => {
  const index = buildIndex([{ file: 'KNOWLEDGE.md', text: SAMPLE }], '2026-07-10T00:00:00.000Z');
  expect(index.rows.map((r) => r.line)).toEqual([7, 12]);
});
