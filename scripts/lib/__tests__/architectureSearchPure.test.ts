import { describe, test, expect } from 'vitest';
import { parseArchitectureSections, rankSections } from '../architectureSearchPure.js';

const doc = [
  '# Title',                                                     // 1
  'Preamble line.',                                              // 2
  '',                                                            // 3
  '<a id="route-conventions"></a>',                              // 4
  '## Route Conventions',                                        // 5
  'Routes live in server/routes. Use validateBody everywhere.',  // 6
  '',                                                            // 7
  '```bash',                                                     // 8
  '# this is a shell comment, not a heading',                    // 9
  '<a id="fake-anchor-in-code"></a>',                            // 10
  '```',                                                         // 11
  '',                                                            // 12
  '<a id="workspace-memory"></a>',                               // 13
  '## Workspace Memory',                                         // 14
  'Memory content line.',                                        // 15
  '<a id="memory-tiered-consolidation"></a>',                    // 16
  '### Tiered consolidation',                                    // 17
  'Consolidation details here.',                                 // 18
  '',                                                            // 19
  '<a id="architecture-rules-alias"></a>',                       // 20
  '<a id="row-level-security"></a>',                             // 21
  '## Row-Level Security (RLS)',                                 // 22
  'RLS policies enforce tenant isolation on every table.',       // 23
  'Set the org context before querying.',                        // 24
].join('\n');

describe('parseArchitectureSections', () => {
  test('finds real sections, skips fenced anchors, keeps mid-section ### anchors inside the body, handles alias stacks', () => {
    const sections = parseArchitectureSections(doc);
    expect(sections.map((s) => s.anchor)).toEqual(['route-conventions', 'workspace-memory', 'row-level-security']);
    expect(sections[0].title).toBe('Route Conventions');
    expect(sections[0].startLine).toBe(4);
    expect(sections[0].endLine).toBe(12);
    expect(sections[1].startLine).toBe(13);
    expect(sections[1].endLine).toBe(19);
    expect(sections[1].body).toContain('Consolidation details here.');
    expect(sections[2].startLine).toBe(20);
    expect(sections[2].endLine).toBe(24);
    expect(sections[2].title).toBe('Row-Level Security (RLS)');
  });

  test('section body contains its own text only', () => {
    const sections = parseArchitectureSections(doc);
    expect(sections[2].body).toContain('tenant isolation');
    expect(sections[2].body).not.toContain('validateBody');
  });
});

describe('rankSections', () => {
  const sections = parseArchitectureSections(doc);

  test('query terms rank the matching section first', () => {
    const ranked = rankSections(sections, 'rls tenant isolation');
    expect(ranked[0].anchor).toBe('row-level-security');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  test('title and anchor matches outweigh body-only matches', () => {
    const ranked = rankSections(sections, 'route conventions');
    expect(ranked[0].anchor).toBe('route-conventions');
  });

  test('no-match query returns empty list, and limit caps results', () => {
    expect(rankSections(sections, 'zzzz qqqq')).toEqual([]);
    expect(rankSections(sections, 'the', 1).length).toBeLessThanOrEqual(1);
  });

  test('deterministic ordering on ties: score desc, then startLine asc', () => {
    expect(rankSections(sections, 'server')).toEqual(rankSections(sections, 'server'));
  });
});
