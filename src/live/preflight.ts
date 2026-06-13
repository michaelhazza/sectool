import { assertAllowlisted, AllowlistViolationError } from './gate.js';
import type { AllowedTarget } from './gate.js';
import type { LoadedAllowlist } from '../config/load.js';
import type { StagingTarget, TargetRegistry } from '../schemas/targets.js';

// ---------------------------------------------------------------------------
// UnregisteredTargetError — thrown when the gate passes but the host has no
// enabled registry entry. Ad-hoc scanning of non-registered hosts is not
// a v1 feature (§5.1).
// ---------------------------------------------------------------------------

export class UnregisteredTargetError extends Error {
  constructor(hostname: string) {
    super(
      `Host "${hostname}" passed the allowlist gate but has no enabled registry entry in config/targets.json. ` +
        `Add and enable a stagingTargets entry for this host (§5.1).`,
    );
    this.name = 'UnregisteredTargetError';
  }
}

// ---------------------------------------------------------------------------
// PreflightResult — returned by a successful preflight call.
// ---------------------------------------------------------------------------

export interface PreflightResult {
  readonly target: AllowedTarget;
  readonly registryEntry: StagingTarget;
}

// ---------------------------------------------------------------------------
// CHECK_FAMILIES — the families that would run for a given registry entry.
// Order: passive families always, active only when activeScan:true.
// ---------------------------------------------------------------------------

const PASSIVE_FAMILIES = ['probe', 'nuclei (passive)', 'zap (passive)'] as const;
const ACTIVE_FAMILIES = ['nuclei (active)', 'zap (active)'] as const;

function checkFamilies(entry: StagingTarget): readonly string[] {
  if (entry.activeScan) {
    return [...PASSIVE_FAMILIES, ...ACTIVE_FAMILIES];
  }
  return [...PASSIVE_FAMILIES];
}

// ---------------------------------------------------------------------------
// preflight — the ordering-critical entrypoint.
//
// INVARIANT: assertAllowlisted() is called FIRST — before any registry lookup,
// DNS resolution, or network operation. The scan phases are unreachable unless
// this function returns successfully (§4.6).
//
// The optional `resolver` parameter exists solely for testing: callers may pass
// a spy to assert zero DNS calls. The implementation never calls it — it is
// typed here to make the invariant observable in tests (§10 preflight-before-DNS
// guardrail).
// ---------------------------------------------------------------------------

export function preflight(
  url: string,
  allowlist: LoadedAllowlist,
  registry: TargetRegistry,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _resolver?: (hostname: string) => Promise<string>,
): PreflightResult {
  // STEP 1: gate — throws AllowlistViolationError before any registry/DNS access.
  const target = assertAllowlisted(url, allowlist);

  // STEP 2: registry lookup (pure string comparison — no network).
  const entry = registry.stagingTargets.find(
    (t) => t.enabled && new URL(t.url).hostname === target.hostname,
  );

  if (entry === undefined) {
    throw new UnregisteredTargetError(target.hostname);
  }

  return { target, registryEntry: entry };
}

// ---------------------------------------------------------------------------
// dryRun — prints the allowlist verdict + check families; sends zero traffic.
//
// A denied host prints its deny verdict and exits; registry lookup and DNS
// resolution are never reached (§4.6). An allowed but unregistered host prints
// the UnregisteredTargetError message.
// ---------------------------------------------------------------------------

export function dryRun(
  url: string,
  allowlist: LoadedAllowlist,
  registry: TargetRegistry,
  opts?: {
    readonly output?: (msg: string) => void;
    readonly resolver?: (hostname: string) => Promise<string>;
  },
): void {
  const emit = opts?.output ?? ((msg: string) => process.stdout.write(msg + '\n'));

  let result: PreflightResult;
  try {
    result = preflight(url, allowlist, registry, opts?.resolver);
  } catch (err) {
    if (err instanceof AllowlistViolationError) {
      emit(`[dry-run] DENIED: ${err.message}`);
      return;
    }
    if (err instanceof UnregisteredTargetError) {
      emit(`[dry-run] DENIED (unregistered): ${err.message}`);
      return;
    }
    throw err;
  }

  const families = checkFamilies(result.registryEntry);
  emit(`[dry-run] ALLOWED: ${result.target.hostname}`);
  emit(`[dry-run] Registry entry: ${result.registryEntry.name}`);
  emit(`[dry-run] Check families that would run: ${families.join(', ')}`);
  emit(`[dry-run] Zero traffic sent.`);
}
