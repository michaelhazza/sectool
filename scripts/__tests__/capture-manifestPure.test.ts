/**
 * capture-manifestPure.test.ts
 *
 * Vitest pure-function tests for the capture-manifest validator.
 * Run via: npx vitest run scripts/__tests__/capture-manifestPure.test.ts
 *
 * (Vitest style, matching chatgpt-reviewPure.test.ts — NOT the node:test style
 * of the older cross-repo-scoutPure.test.ts, which verify-test-quality.sh rejects.)
 */

import { describe, expect, it } from 'vitest';
import {
  validateCaptureManifest,
  validateScreenEntry,
  type CaptureManifest,
  type CapturedScreenEntry,
} from '../mockup/capture-manifestPure';

const ISO = '2026-06-19T12:00:00.000Z';

function capturedEntry(overrides: Partial<CapturedScreenEntry> = {}): CapturedScreenEntry {
  return {
    screenId: 'skills-page',
    route: '/skills',
    role: 'org-admin',
    capturedAt: ISO,
    viewports: [375, 768, 1280],
    captureStatus: 'captured',
    screenshotPaths: {
      375: 'prototypes/x/_captures/skills-page-375.png',
      768: 'prototypes/x/_captures/skills-page-768.png',
      1280: 'prototypes/x/_captures/skills-page-1280.png',
    },
    tokenSheet: {
      colors: ['#111827', '#ffffff'],
      fontFamilies: ['Inter'],
      fontSizes: ['14px', '16px'],
      fontWeights: ['400', '600'],
      spacing: ['8px', '16px'],
      radii: ['6px'],
      shadows: ['0 1px 2px rgba(0,0,0,0.05)'],
    },
    domOutline: {
      navItems: ['Skills', 'Workspaces'],
      tabLabels: ['Active', 'Drafts'],
      headings: ['Skills'],
      tableColumnHeaders: ['Name', 'Status', 'Updated'],
      primaryButtons: ['Add skill'],
      statusPills: ['Live', 'Paused'],
    },
    ...overrides,
  };
}

function manifest(screens: CaptureManifest['screens']): CaptureManifest {
  return { slug: 'grounded-mockups', generatedAt: ISO, screens };
}

describe('validateCaptureManifest', () => {
  it('accepts a well-formed captured manifest (A3 happy path)', () => {
    expect(validateCaptureManifest(manifest([capturedEntry()]))).toEqual({ valid: true });
  });

  it('never throws on null / wrong-type input — returns invalid', () => {
    expect(validateCaptureManifest(null).valid).toBe(false);
    expect(validateCaptureManifest(42).valid).toBe(false);
    expect(validateCaptureManifest('nope').valid).toBe(false);
    expect(validateCaptureManifest([]).valid).toBe(false);
  });

  it('rejects an unknown captureStatus', () => {
    const bad = { ...capturedEntry(), captureStatus: 'screenshotted' };
    const result = validateCaptureManifest(manifest([bad as unknown as CapturedScreenEntry]));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join('\n')).toContain('unknown captureStatus');
  });

  // Review #1 — three-viewport contract.
  it('rejects a captured entry missing the 768 screenshot path (review #1)', () => {
    const entry = capturedEntry();
    delete (entry.screenshotPaths as Record<number, string>)[768];
    const result = validateCaptureManifest(manifest([entry]));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join('\n')).toContain('viewport 768');
  });

  it('rejects a captured entry with an empty token sheet', () => {
    const entry = capturedEntry({
      tokenSheet: { colors: [], fontFamilies: [], fontSizes: [], fontWeights: [], spacing: [], radii: [], shadows: [] },
    });
    const result = validateCaptureManifest(manifest([entry]));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join('\n')).toContain('tokenSheet');
  });

  // Review #2 — structured DOM outline must be non-empty.
  it('rejects a captured entry whose domOutline is all-empty (review #2)', () => {
    const entry = capturedEntry({
      domOutline: { navItems: [], tabLabels: [], headings: [], tableColumnHeaders: [], primaryButtons: [], statusPills: [] },
    });
    const result = validateCaptureManifest(manifest([entry]));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join('\n')).toContain('domOutline');
  });

  it('accepts a captured entry whose domOutline carries real tab labels / column headers (review #2)', () => {
    const entry = capturedEntry({
      domOutline: { navItems: [], tabLabels: ['Inbox'], headings: [], tableColumnHeaders: ['Subject'], primaryButtons: [], statusPills: [] },
    });
    expect(validateCaptureManifest(manifest([entry]))).toEqual({ valid: true });
  });

  it('rejects malformed capturedAt', () => {
    const result = validateCaptureManifest(manifest([capturedEntry({ capturedAt: 'last tuesday' })]));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join('\n')).toContain('capturedAt');
  });

  it('rejects empty screenId / route / role and empty viewports', () => {
    const entry = capturedEntry({ screenId: '', route: '  ', role: '', viewports: [] });
    const result = validateCaptureManifest(manifest([entry]));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const joined = result.errors.join('\n');
      expect(joined).toContain('screenId');
      expect(joined).toContain('route');
      expect(joined).toContain('role');
      expect(joined).toContain('viewports');
    }
  });

  describe('fallback_source_read', () => {
    it('accepts a fixed fallback reason', () => {
      expect(
        validateCaptureManifest(
          manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'fallback_source_read', fallbackReason: 'server_unavailable' }]),
        ),
      ).toEqual({ valid: true });
    });

    it('accepts the route_unreachable_as_{role} template with a role token', () => {
      expect(
        validateCaptureManifest(
          manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'fallback_source_read', fallbackReason: 'route_unreachable_as_org-admin' }]),
        ),
      ).toEqual({ valid: true });
    });

    it('rejects the bare route_unreachable_as_ prefix with no role token', () => {
      const result = validateCaptureManifest(
        manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'fallback_source_read', fallbackReason: 'route_unreachable_as_' } as never]),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.join('\n')).toContain('fallbackReason');
    });

    it('rejects fallback_source_read missing a reason', () => {
      const result = validateCaptureManifest(
        manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'fallback_source_read' } as never]),
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('failed (review #3)', () => {
    it('accepts a failed entry with a failureReason and no captured-shape fields', () => {
      expect(
        validateCaptureManifest(
          manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'failed', failureReason: 'playwright launch threw' }]),
        ),
      ).toEqual({ valid: true });
    });

    it('rejects a failed entry with no failureReason', () => {
      const result = validateCaptureManifest(
        manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'failed' } as never]),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.join('\n')).toContain('failureReason');
    });

    it('rejects a failed entry that carries a screenshot (it must not lie about a capture)', () => {
      const result = validateCaptureManifest(
        manifest([{ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'failed', failureReason: 'x', screenshotPaths: { 375: 'a.png' } } as never]),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.join('\n')).toContain('captured-shape');
    });
  });

  it('reports errors for every bad screen in a multi-screen manifest', () => {
    const result = validateCaptureManifest(
      manifest([capturedEntry(), { captureStatus: 'failed' } as never]),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.startsWith('screens[1]'))).toBe(true);
  });
});

describe('validateScreenEntry (orchestrator pre-captured guard)', () => {
  it('accepts a well-formed captured entry', () => {
    expect(validateScreenEntry(capturedEntry())).toEqual({ valid: true });
  });

  // The orchestrator downgrades to data_absent instead of returning a captured entry
  // that would make writeManifest throw — this is the contract that decision rests on.
  it('rejects a captured entry whose domOutline is all-empty (would-be writeManifest throw)', () => {
    const entry = capturedEntry({
      domOutline: { navItems: [], tabLabels: [], headings: [], tableColumnHeaders: [], primaryButtons: [], statusPills: [] },
    });
    expect(validateScreenEntry(entry).valid).toBe(false);
  });

  it('rejects a captured entry with an empty token sheet', () => {
    const entry = capturedEntry({
      tokenSheet: { colors: [], fontFamilies: [], fontSizes: [], fontWeights: [], spacing: [], radii: [], shadows: [] },
    });
    expect(validateScreenEntry(entry).valid).toBe(false);
  });

  it('accepts a fallback_source_read entry', () => {
    expect(
      validateScreenEntry({ screenId: 's', route: '/r', role: 'org-admin', capturedAt: ISO, viewports: [375], captureStatus: 'fallback_source_read', fallbackReason: 'data_absent' }),
    ).toEqual({ valid: true });
  });
});
