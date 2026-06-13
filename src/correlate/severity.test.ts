import { describe, expect, it } from 'vitest';
import { computeSeverity } from './severity.js';
import type { SeverityInput, CorrelationInput } from './severity.js';

// Helper to build a default SeverityInput, overriding only the fields under test
function base(overrides: Partial<SeverityInput>): SeverityInput {
  return {
    baseSeverity: 'medium',
    reachability: 'unknown',
    vulnClass: 'misconfiguration',
    confidence: 'probable',
    ...overrides,
  };
}

const noCorrelation: CorrelationInput = { liveConfirmed: false };
const liveCorrelation: CorrelationInput = { liveConfirmed: true };

describe('computeSeverity — §8.1 modifier order', () => {
  describe('no modifiers apply (unknown reachability, no correlation)', () => {
    it('passes through baseSeverity unchanged', () => {
      expect(computeSeverity(base({ baseSeverity: 'medium' }), noCorrelation)).toMatchObject({
        severity: 'medium',
        confidence: 'probable',
      });
    });

    it('passes through each base level unchanged', () => {
      for (const lvl of ['low', 'medium', 'high', 'critical'] as const) {
        expect(computeSeverity(base({ baseSeverity: lvl }), noCorrelation).severity).toBe(lvl);
      }
    });
  });

  describe('modifier 1 — live-confirmed raises by one step', () => {
    it('raises low → medium and sets confidence confirmed', () => {
      const result = computeSeverity(base({ baseSeverity: 'low', confidence: 'probable' }), liveCorrelation);
      expect(result.severity).toBe('medium');
      expect(result.confidence).toBe('confirmed');
    });

    it('raises medium → high', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'medium' }), liveCorrelation).severity,
      ).toBe('high');
    });

    it('raises high → critical', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'high' }), liveCorrelation).severity,
      ).toBe('critical');
    });

    it('clamps critical → critical (no overflow)', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'critical' }), liveCorrelation).severity,
      ).toBe('critical');
    });

    it('overrides confidence to confirmed even when original was tentative', () => {
      expect(
        computeSeverity(base({ confidence: 'tentative' }), liveCorrelation).confidence,
      ).toBe('confirmed');
    });
  });

  describe('modifier 2 — unauthenticated reachability raises by one step', () => {
    it('raises low → medium', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'low', reachability: 'unauthenticated' }), noCorrelation).severity,
      ).toBe('medium');
    });

    it('raises medium → high', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'unauthenticated' }), noCorrelation).severity,
      ).toBe('high');
    });

    it('clamps critical → critical (no overflow)', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'critical', reachability: 'unauthenticated' }), noCorrelation).severity,
      ).toBe('critical');
    });

    it('does NOT change confidence (that is modifier 1 only)', () => {
      expect(
        computeSeverity(base({ reachability: 'unauthenticated', confidence: 'probable' }), noCorrelation).confidence,
      ).toBe('probable');
    });
  });

  describe('modifier 3 — admin reachability lowers by one step', () => {
    it('lowers critical → high', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'critical', reachability: 'admin' }), noCorrelation).severity,
      ).toBe('high');
    });

    it('lowers high → medium', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'high', reachability: 'admin' }), noCorrelation).severity,
      ).toBe('medium');
    });

    it('lowers medium → low', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'admin' }), noCorrelation).severity,
      ).toBe('low');
    });

    it('clamps low → low (no underflow)', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'low', reachability: 'admin', vulnClass: 'misconfiguration' }), noCorrelation).severity,
      ).toBe('low');
    });
  });

  describe('modifier 4 — floor: secrets/injection/tenant-isolation never below high', () => {
    it('injection on admin route: NOT lowered below high', () => {
      const result = computeSeverity(
        base({ baseSeverity: 'high', reachability: 'admin', vulnClass: 'injection' }),
        noCorrelation,
      );
      expect(result.severity).toBe('high');
    });

    it('secrets on admin route starting at medium: raised to high by floor', () => {
      const result = computeSeverity(
        base({ baseSeverity: 'medium', reachability: 'admin', vulnClass: 'secrets' }),
        noCorrelation,
      );
      // modifier 3 lowers medium → low, floor raises low → high
      expect(result.severity).toBe('high');
    });

    it('tenant-isolation on admin route: NOT lowered below high', () => {
      const result = computeSeverity(
        base({ baseSeverity: 'high', reachability: 'admin', vulnClass: 'tenant-isolation' }),
        noCorrelation,
      );
      expect(result.severity).toBe('high');
    });

    it('injection already at critical: floor does not lower it', () => {
      const result = computeSeverity(
        base({ baseSeverity: 'critical', reachability: 'unknown', vulnClass: 'injection' }),
        noCorrelation,
      );
      expect(result.severity).toBe('critical');
    });

    it('misconfiguration on admin route: CAN drop below high (no floor protection)', () => {
      const result = computeSeverity(
        base({ baseSeverity: 'medium', reachability: 'admin', vulnClass: 'misconfiguration' }),
        noCorrelation,
      );
      expect(result.severity).toBe('low');
    });
  });

  describe('neutral reachability (unknown, authenticated)', () => {
    it('unknown reachability: neither bump nor demotion', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'unknown' }), noCorrelation).severity,
      ).toBe('medium');
    });

    it('authenticated reachability: neither bump nor demotion', () => {
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'authenticated' }), noCorrelation).severity,
      ).toBe('medium');
    });
  });

  describe('modifier order is applied sequentially (all four active)', () => {
    it('live-confirmed + unauthenticated on injection: low → medium (confirmed) → high (unauth) → floor no-op', () => {
      // baseSeverity: low, live-confirmed: +1 → medium, unauthenticated: +1 → high
      // floor: injection >= high, already satisfied
      const result = computeSeverity(
        base({ baseSeverity: 'low', reachability: 'unauthenticated', vulnClass: 'injection', confidence: 'probable' }),
        liveCorrelation,
      );
      expect(result.severity).toBe('high');
      expect(result.confidence).toBe('confirmed');
    });

    it('live-confirmed + admin on secrets: high → critical (confirmed) → high (admin) → floor: high', () => {
      // baseSeverity: high, live-confirmed: +1 → critical, admin: -1 → high
      // floor: secrets >= high, already satisfied
      const result = computeSeverity(
        base({ baseSeverity: 'high', reachability: 'admin', vulnClass: 'secrets', confidence: 'probable' }),
        liveCorrelation,
      );
      expect(result.severity).toBe('high');
      expect(result.confidence).toBe('confirmed');
    });

    it('live-confirmed + admin on non-floored: medium → high (confirmed) → medium (admin)', () => {
      // baseSeverity: medium, live-confirmed: +1 → high, admin: -1 → medium, no floor
      const result = computeSeverity(
        base({ baseSeverity: 'medium', reachability: 'admin', vulnClass: 'misconfiguration', confidence: 'probable' }),
        liveCorrelation,
      );
      expect(result.severity).toBe('medium');
      expect(result.confidence).toBe('confirmed');
    });

    it('no correlation + unauthenticated + admin: bump then demotion cancel out (net 0)', () => {
      // Both reachability values cannot coexist on a real finding (it's a union),
      // but the modifier order is exercised here by having unauthenticated applied
      // as modifier 2 and admin as modifier 3 are mutually exclusive at the schema level.
      // Instead, verify that applying only one doesn't clobber the other's step:
      // unauthenticated: medium → high
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'unauthenticated' }), noCorrelation).severity,
      ).toBe('high');
      // admin: medium → low
      expect(
        computeSeverity(base({ baseSeverity: 'medium', reachability: 'admin' }), noCorrelation).severity,
      ).toBe('low');
    });
  });

  describe('confidence passthrough when no live-confirmed', () => {
    it('preserves confirmed confidence when not live-correlated', () => {
      expect(
        computeSeverity(base({ confidence: 'confirmed' }), noCorrelation).confidence,
      ).toBe('confirmed');
    });

    it('preserves tentative confidence when not live-correlated', () => {
      expect(
        computeSeverity(base({ confidence: 'tentative' }), noCorrelation).confidence,
      ).toBe('tentative');
    });
  });
});
