/**
 * capture-surfacePure.test.ts
 *
 * Vitest pure-function tests for the capture extractors.
 * Run via: npx vitest run scripts/__tests__/capture-surfacePure.test.ts
 *
 * (Vitest style, per project MEMORY + verify-test-quality.sh — not node:test.)
 */

import { describe, expect, it } from 'vitest';
import {
  extractTokenSheet,
  navigatedAwayFromRoute,
  pruneDomOutline,
  type ComputedStyleRecord,
  type OutlineCandidate,
} from '../mockup/capture-surfacePure';

describe('extractTokenSheet', () => {
  it('de-duplicates into one page-wide sheet (§9 decision 1)', () => {
    const records: ComputedStyleRecord[] = [
      { color: '#111827', backgroundColor: '#ffffff', fontFamily: 'Inter', fontSize: '16px', fontWeight: '600', padding: '16px', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' },
      { color: '#111827', backgroundColor: '#f3f4f6', fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', padding: '16px', borderRadius: '6px' },
    ];
    const sheet = extractTokenSheet(records);
    expect(sheet.colors).toEqual(['#111827', '#ffffff', '#f3f4f6']); // de-duped, first-seen order
    expect(sheet.fontFamilies).toEqual(['Inter']);
    expect(sheet.fontSizes).toEqual(['16px', '14px']);
    expect(sheet.fontWeights).toEqual(['600', '400']);
    expect(sheet.spacing).toEqual(['16px']);
    expect(sheet.radii).toEqual(['6px']);
    expect(sheet.shadows).toEqual(['0 1px 2px rgba(0,0,0,0.05)']);
  });

  it('drops noise values (transparent, none, 0px, normal, ...)', () => {
    const records: ComputedStyleRecord[] = [
      { color: 'rgba(0, 0, 0, 0)', backgroundColor: 'transparent', borderColor: '#e5e7eb', margin: '0px', boxShadow: 'none', fontWeight: 'normal', borderRadius: '0' },
    ];
    const sheet = extractTokenSheet(records);
    expect(sheet.colors).toEqual(['#e5e7eb']);
    expect(sheet.spacing).toEqual([]);
    expect(sheet.shadows).toEqual([]);
    expect(sheet.fontWeights).toEqual([]);
    expect(sheet.radii).toEqual([]);
  });

  it('returns empty-but-valid structure for empty input', () => {
    const sheet = extractTokenSheet([]);
    expect(sheet).toEqual({ colors: [], fontFamilies: [], fontSizes: [], fontWeights: [], spacing: [], radii: [], shadows: [] });
  });

  it('caps each token array at MAX_PER_BUCKET (60) so a pathological page cannot run away', () => {
    const records: ComputedStyleRecord[] = Array.from({ length: 61 }, (_, i) => ({ color: `#${(i + 1).toString(16).padStart(6, '0')}` }));
    expect(extractTokenSheet(records).colors).toHaveLength(60);
  });
});

describe('pruneDomOutline', () => {
  it('buckets tagged candidates into the structured outline (§4.2)', () => {
    const candidates: OutlineCandidate[] = [
      { kind: 'nav', text: 'Skills' },
      { kind: 'nav', text: 'Workspaces' },
      { kind: 'tab', text: 'Active' },
      { kind: 'tab', text: 'Drafts' },
      { kind: 'heading', text: 'Skills' },
      { kind: 'columnHeader', text: 'Name' },
      { kind: 'columnHeader', text: 'Status' },
      { kind: 'primaryButton', text: 'Add skill' },
      { kind: 'statusPill', text: 'Live' },
    ];
    const outline = pruneDomOutline(candidates);
    expect(outline.navItems).toEqual(['Skills', 'Workspaces']);
    expect(outline.tabLabels).toEqual(['Active', 'Drafts']);
    expect(outline.headings).toEqual(['Skills']);
    expect(outline.tableColumnHeaders).toEqual(['Name', 'Status']);
    expect(outline.primaryButtons).toEqual(['Add skill']);
    expect(outline.statusPills).toEqual(['Live']);
  });

  it('trims, drops empties and de-duplicates within a bucket', () => {
    const candidates: OutlineCandidate[] = [
      { kind: 'tab', text: '  Inbox  ' },
      { kind: 'tab', text: 'Inbox' },
      { kind: 'tab', text: '' },
      { kind: 'tab', text: '   ' },
    ];
    expect(pruneDomOutline(candidates).tabLabels).toEqual(['Inbox']);
  });

  it('returns empty-but-valid structure for empty input', () => {
    expect(pruneDomOutline([])).toEqual({ navItems: [], tabLabels: [], headings: [], tableColumnHeaders: [], primaryButtons: [], statusPills: [] });
  });

  it('silently drops candidates with an unknown kind without throwing', () => {
    const candidates = [{ kind: 'sidebar' as OutlineCandidate['kind'], text: 'X' }, { kind: 'tab', text: 'Active' }] as OutlineCandidate[];
    const outline = pruneDomOutline(candidates);
    expect(outline.tabLabels).toEqual(['Active']);
    expect(outline).toEqual({ navItems: [], tabLabels: ['Active'], headings: [], tableColumnHeaders: [], primaryButtons: [], statusPills: [] });
  });
});

describe('navigatedAwayFromRoute (auth/redirect guard)', () => {
  const base = 'http://127.0.0.1:5000';

  it('returns false when still on the requested route', () => {
    expect(navigatedAwayFromRoute(`${base}/skills`, '/skills')).toBe(false);
    expect(navigatedAwayFromRoute(`${base}/skills/active`, '/skills')).toBe(false); // prefix match
  });

  it('returns true when redirected to a login/unauthorized page', () => {
    expect(navigatedAwayFromRoute(`${base}/login?next=/skills`, '/skills')).toBe(true);
    expect(navigatedAwayFromRoute(`${base}/unauthorized`, '/skills')).toBe(true);
  });

  it('returns true when redirected away from the requested prefix', () => {
    expect(navigatedAwayFromRoute(`${base}/dashboard`, '/skills')).toBe(true);
  });

  it('does not flag an intentionally-requested auth route', () => {
    expect(navigatedAwayFromRoute(`${base}/login`, '/login')).toBe(false);
  });

  it('skips the prefix check for a root request but still catches an auth redirect', () => {
    expect(navigatedAwayFromRoute(`${base}/anything`, '/')).toBe(false);
    expect(navigatedAwayFromRoute(`${base}/login`, '/')).toBe(true);
  });
});
