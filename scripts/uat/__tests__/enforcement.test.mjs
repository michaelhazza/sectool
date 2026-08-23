/**
 * enforcement.test.mjs — the §10 enforcement matrix and refusal rows 9-10 as
 * mechanical tests (R2.4). Covers the transition matrix, shadow surfacing
 * (never machine-blocking), the strict-protection conditioning pair, the
 * override rejection, and the disabled skip.
 *
 * Run: npx vitest run scripts/uat/__tests__/enforcement.test.mjs
 */

import { describe, test, expect } from 'vitest';
import {
  deriveEnforcement, escalate, pipelineAction, baseFreshnessRequired,
  row9Passes, row10Passes,
} from '../enforcement.mjs';

describe('deriveEnforcement — rollout mode -> run + enforcement', () => {
  test('absent/disabled -> gate does not run (plan A9)', () => {
    expect(deriveEnforcement({})).toEqual({ run: false, enforcement: null });
    expect(deriveEnforcement({ rolloutMode: 'disabled' })).toEqual({ run: false, enforcement: null });
    expect(deriveEnforcement({ rolloutMode: 'bogus' })).toEqual({ run: false, enforcement: null });
  });
  test('shadow -> runs, advisory', () => {
    expect(deriveEnforcement({ rolloutMode: 'shadow', riskTags: ['money-precision'] })).toEqual({ run: true, enforcement: 'advisory' });
  });
  test('default -> runs, blocking', () => {
    expect(deriveEnforcement({ rolloutMode: 'default' })).toEqual({ run: true, enforcement: 'blocking' });
  });
  test('high-risk -> blocking for a graduated tag, advisory for an ungraduated one', () => {
    expect(deriveEnforcement({ rolloutMode: 'high-risk', riskTags: ['money-precision'] })).toEqual({ run: true, enforcement: 'blocking' });
    expect(deriveEnforcement({ rolloutMode: 'high-risk', riskTags: ['refactor-internal'] })).toEqual({ run: true, enforcement: 'advisory' });
  });
});

test('escalate is monotonic advisory -> blocking, never back', () => {
  expect(escalate('advisory', 'blocking')).toBe('blocking');
  expect(escalate('blocking', 'advisory')).toBe('blocking');
  expect(escalate('advisory', 'advisory')).toBe('advisory');
});

describe('pipelineAction — the §10 transition matrix', () => {
  test('pass / valid proceed continue under both enforcements', () => {
    for (const enforcement of ['advisory', 'blocking']) {
      expect(pipelineAction({ enforcement, verdict: 'pass' }).action).toBe('continue');
      expect(pipelineAction({ enforcement, verdict: 'proceed' }).action).toBe('continue');
    }
  });
  test('shadow-fail is advisory, never machine-blocking', () => {
    const r = pipelineAction({ enforcement: 'advisory', verdict: 'fail' });
    expect(r.action).toBe('record-advisory');
    expect(r.writesBlocker).toBe(false);
    expect(r.advisory).toBe(true);
  });
  test('shadow-incomplete is advisory, no halt, no blocker', () => {
    const r = pipelineAction({ enforcement: 'advisory', verdict: 'incomplete' });
    expect(r.action).toBe('record-advisory');
    expect(r.writesBlocker).toBe(false);
  });
  test('blocking-fail back-edges with a blocker', () => {
    const r = pipelineAction({ enforcement: 'blocking', verdict: 'fail' });
    expect(r.action).toBe('back-edge');
    expect(r.writesBlocker).toBe(true);
  });
  test('blocking-incomplete halts (never label), no blocker written', () => {
    const r = pipelineAction({ enforcement: 'blocking', verdict: 'incomplete' });
    expect(r.action).toBe('halt');
    expect(r.writesBlocker).toBe(false);
  });
});

describe('Row 9 — enforcement + verdict together + override rejection', () => {
  test('an override field always refuses', () => {
    expect(row9Passes({ enforcement: 'advisory', verdict: 'pass', hasOverrideField: true })).toBe(false);
    expect(row9Passes({ enforcement: 'blocking', verdict: 'pass', hasOverrideField: true })).toBe(false);
  });
  test('blocking: only pass / valid proceed pass the row', () => {
    expect(row9Passes({ enforcement: 'blocking', verdict: 'pass' })).toBe(true);
    expect(row9Passes({ enforcement: 'blocking', verdict: 'proceed' })).toBe(true);
    expect(row9Passes({ enforcement: 'blocking', verdict: 'fail' })).toBe(false);
    expect(row9Passes({ enforcement: 'blocking', verdict: 'incomplete' })).toBe(false);
  });
  test('advisory: any current verdict passes the row (surfaced elsewhere)', () => {
    expect(row9Passes({ enforcement: 'advisory', verdict: 'fail' })).toBe(true);
    expect(row9Passes({ enforcement: 'advisory', verdict: 'incomplete' })).toBe(true);
  });
});

describe('Row 10 — evidence binding + staleness always; base freshness iff blocking', () => {
  const ok = { enforcement: 'advisory', evidenceBound: true, staleTail: false, hasStrictProtection: false, headMatches: true };
  test('unbound evidence refuses regardless of enforcement', () => {
    expect(row10Passes({ ...ok, evidenceBound: false })).toBe(false);
    expect(row10Passes({ ...ok, enforcement: 'blocking', evidenceBound: false, hasStrictProtection: true })).toBe(false);
  });
  test('a stale (application/harness) tail refuses regardless of enforcement', () => {
    expect(row10Passes({ ...ok, staleTail: true })).toBe(false);
  });
  test('a moved head refuses (expected-remote-head precondition)', () => {
    expect(row10Passes({ ...ok, headMatches: false })).toBe(false);
  });
  test('the strict-protection conditioning PAIR', () => {
    // advisory + NO strict protection -> row passes (telemetry only)
    expect(row10Passes({ ...ok, enforcement: 'advisory', hasStrictProtection: false })).toBe(true);
    // blocking + NO strict protection -> row refuses
    expect(row10Passes({ ...ok, enforcement: 'blocking', hasStrictProtection: false })).toBe(false);
    // blocking + strict protection -> row passes
    expect(row10Passes({ ...ok, enforcement: 'blocking', hasStrictProtection: true })).toBe(true);
  });
  test('baseFreshnessRequired is blocking-only', () => {
    expect(baseFreshnessRequired('blocking')).toBe(true);
    expect(baseFreshnessRequired('advisory')).toBe(false);
  });
});
