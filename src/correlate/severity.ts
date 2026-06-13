import type { Confidence, Reachability, Severity, VulnClass } from '../schemas/finding.js';

const SEVERITY_SCALE: Severity[] = ['low', 'medium', 'high', 'critical'];

// vulnClass values that are floored at 'high' regardless of demotion
const FLOORED_CLASSES = new Set<VulnClass>(['secrets', 'injection', 'tenant-isolation']);

function step(severity: Severity, delta: number): Severity {
  const idx = SEVERITY_SCALE.indexOf(severity);
  const next = Math.min(Math.max(idx + delta, 0), SEVERITY_SCALE.length - 1);
  const result = SEVERITY_SCALE[next];
  // SEVERITY_SCALE is a fixed-size const array indexed within [0,3]; result is always defined
  return result as Severity;
}

export interface SeverityInput {
  readonly baseSeverity: Severity;
  readonly reachability: Reachability;
  readonly vulnClass: VulnClass;
  readonly confidence: Confidence;
}

export interface CorrelationInput {
  readonly liveConfirmed: boolean;
}

export interface SeverityResult {
  readonly severity: Severity;
  readonly confidence: Confidence;
}

/**
 * Compute the exploitability-aware severity and confidence for a finding at
 * report stage. Applies the §8.1 modifier chain in order:
 *   1. Live-confirmed (+1, confidence → "confirmed")
 *   2. Reachability bump (unauthenticated +1)
 *   3. Reachability demotion (admin -1)
 *   4. Floor (secrets/injection/tenant-isolation never below "high")
 * Clamped to the critical…low scale throughout.
 */
export function computeSeverity(
  finding: SeverityInput,
  correlation: CorrelationInput,
): SeverityResult {
  let current = finding.baseSeverity;
  let confidence = finding.confidence;

  // Modifier 1: live-confirmed raises by one step and sets confidence to confirmed
  if (correlation.liveConfirmed) {
    current = step(current, 1);
    confidence = 'confirmed';
  }

  // Modifier 2: unauthenticated reachability raises by one step
  if (finding.reachability === 'unauthenticated') {
    current = step(current, 1);
  }

  // Modifier 3: admin reachability lowers by one step
  if (finding.reachability === 'admin') {
    current = step(current, -1);
  }

  // Modifier 4: floor — secrets/injection/tenant-isolation never drop below high
  if (FLOORED_CLASSES.has(finding.vulnClass)) {
    const floorIdx = SEVERITY_SCALE.indexOf('high');
    const currentIdx = SEVERITY_SCALE.indexOf(current);
    if (currentIdx < floorIdx) {
      current = 'high';
    }
  }

  return { severity: current, confidence };
}
