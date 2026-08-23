/**
 * classify-change.test.mjs
 *
 * Fixtures cover BOTH misclassification directions (a harness file must never
 * read as application; an application file must never read as inert), the
 * conservative unknown-path default, rename severity across old+new paths, the
 * most-severe-wins aggregation, domain-risk tagging, and consumer-registry
 * merging.
 *
 * Run: npx vitest run scripts/uat/__tests__/classify-change.test.mjs
 */

import { describe, test, expect } from 'vitest';
import { classifyChange, classifyPath, CLASSES } from '../classify-change.mjs';

describe('per-path classification', () => {
  test('docs-only change is acceptance-inert', () => {
    expect(classifyPath('README.md')).toBe(CLASSES.INERT);
    expect(classifyPath('docs/guide.md')).toBe(CLASSES.INERT);
  });

  test('a harness file is harness-impacting, NOT application-impacting', () => {
    expect(classifyPath('scripts/uat/validate-uat-evidence.mjs')).toBe(CLASSES.HARNESS);
    expect(classifyPath('schemas/uat-evidence.schema.json')).toBe(CLASSES.HARNESS);
    // a harness-semantic .md must NOT be swallowed by the generic docs->inert rule
    expect(classifyPath('.claude/skills/acceptance-testing/SKILL.md')).toBe(CLASSES.HARNESS);
    expect(classifyPath('.claude/agents/acceptance-phase.md')).toBe(CLASSES.HARNESS);
  });

  test('an application source file is application-impacting, NOT inert', () => {
    expect(classifyPath('src/money/aggregate.ts')).toBe(CLASSES.APPLICATION);
    expect(classifyPath('server/routes/networth.ts')).toBe(CLASSES.APPLICATION);
    expect(classifyPath('migrations/0003_add_col.sql')).toBe(CLASSES.APPLICATION);
  });

  test('an unknown path defaults conservatively to application-impacting', () => {
    expect(classifyPath('weird/unmapped/thing.xyz')).toBe(CLASSES.APPLICATION);
    expect(classifyPath('Makefile')).toBe(CLASSES.APPLICATION);
  });
});

describe('aggregation: most severe class wins', () => {
  test('docs + source => application-impacting (verify + uat)', () => {
    const r = classifyChange(['README.md', 'src/app.ts']);
    expect(r.staleness_class).toBe(CLASSES.APPLICATION);
    expect(r.reruns).toEqual({ verify: true, uat: true });
  });

  test('docs + harness => harness-impacting (uat only, no verify)', () => {
    const r = classifyChange(['README.md', 'scripts/uat/canonicalize.mjs']);
    expect(r.staleness_class).toBe(CLASSES.HARNESS);
    expect(r.reruns).toEqual({ verify: false, uat: true });
  });

  test('docs-only => inert (no reruns)', () => {
    const r = classifyChange(['README.md', 'docs/x.md']);
    expect(r.staleness_class).toBe(CLASSES.INERT);
    expect(r.reruns).toEqual({ verify: false, uat: false });
  });

  test('empty change set => inert', () => {
    expect(classifyChange([]).staleness_class).toBe(CLASSES.INERT);
  });
});

describe('rename classification uses both old and new path (most severe wins)', () => {
  test('source renamed to docs stays application-impacting', () => {
    const r = classifyChange([{ status: 'R', oldPath: 'src/money.ts', path: 'docs/money.md' }]);
    expect(r.staleness_class).toBe(CLASSES.APPLICATION);
  });

  test('docs renamed into the harness becomes harness-impacting', () => {
    const r = classifyChange([{ status: 'R', oldPath: 'docs/a.md', path: 'scripts/uat/new-helper.mjs' }]);
    expect(r.staleness_class).toBe(CLASSES.HARNESS);
  });
});

describe('domain-risk tags (A8 layer-1 baseline)', () => {
  test('migrations and sql tag database-route-migration', () => {
    expect(classifyChange(['migrations/0004_x.sql']).risk_tags).toContain('database-route-migration');
  });
  test('money surfaces tag money-precision', () => {
    expect(classifyChange(['server/services/networth-aggregate.ts']).risk_tags).toContain('money-precision');
  });
  test('client tsx tags ui-browser', () => {
    expect(classifyChange(['client/pages/Wallet.tsx']).risk_tags).toContain('ui-browser');
  });
  test('auth/session tags auth-tenant', () => {
    expect(classifyChange(['server/auth/session.ts']).risk_tags).toContain('auth-tenant');
  });
  test('tags are unioned and sorted across paths', () => {
    const r = classifyChange(['migrations/1.sql', 'client/pages/A.tsx']);
    expect(r.risk_tags).toEqual(['database-route-migration', 'ui-browser']);
  });
});

describe('consumer registry merging', () => {
  const registry = {
    staleness: { application_impacting: ['config/runtime/**'] },
    risk_tags: { 'money-precision': ['server/services/rebalance/**'] },
  };
  test('a consumer application pattern is honoured', () => {
    const r = classifyChange(['config/runtime/flags.json'], { registry });
    expect(r.staleness_class).toBe(CLASSES.APPLICATION);
  });
  test('a consumer risk-tag pattern is honoured', () => {
    const r = classifyChange(['server/services/rebalance/preview.ts'], { registry });
    expect(r.risk_tags).toContain('money-precision');
  });
  test('registry never weakens the conservative unknown default', () => {
    // an unmapped path is still application-impacting even with a registry present
    expect(classifyChange(['totally/unknown.bin'], { registry }).staleness_class).toBe(CLASSES.APPLICATION);
  });
});
