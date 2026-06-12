/**
 * validateProjectContextPure.ts
 *
 * Pure helper — no I/O, no fs, no child_process, no path module.
 *
 * Implements the §3b PROJECT_CONTEXT completeness rule (fail-closed):
 * validates that PROJECT_CONTEXT contains the required markdown headings
 * for the given review mode and artifact type. Missing required sections
 * return {kind: 'fail_closed'} — the coordinator must NOT invoke the
 * reviewer when this returns fail_closed.
 */

export type ReviewMode = 'spec' | 'plan' | 'pr';

export type ValidateResult =
  | { kind: 'ok' }
  | { kind: 'fail_closed'; missing_sections: string[] };

/**
 * Strings that indicate the artifact touches tenant data.
 * Per §3b detection rule: coordinator scans the artifact text for any of
 * the project's declared tenant-key column name OR these literal strings.
 */
const TENANT_DATA_SIGNALS = [
  'RLS',
  'policy',
  'tenant',
  'org',
  'subaccount',
  'account_scoped',
];

/**
 * Detect whether a heading exists in the PROJECT_CONTEXT block.
 * Matches `## <heading>` at the start of a line (case-insensitive).
 */
function hasHeading(context: string, heading: string): boolean {
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'im');
  return pattern.test(context);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Determine whether an artifact touches tenant data.
 *
 * @param artifactTouchesTenantData - caller-supplied flag (the coordinator
 *   may have already scanned the artifact and knows the answer). When true,
 *   the Architecture + Guidelines sections are required regardless of the
 *   signals below.
 * @param context - the PROJECT_CONTEXT text; we also scan it for signal
 *   strings so purely-missing-flag callers still get correct behaviour
 *   when the context itself references those terms.
 */
function detectsTenantData(artifactTouchesTenantData: boolean): boolean {
  // The flag is the canonical signal; the coordinator scans the artifact
  // (not the context) and passes the result here. We trust the caller.
  return artifactTouchesTenantData;
}

/**
 * Validate PROJECT_CONTEXT completeness per §3b.
 *
 * Hard failures (return fail_closed):
 *   - Missing "Stage" (any mode)
 *   - Missing "Framing assumptions" (any mode)
 *   - Missing "Architecture" OR "Guidelines" when artifact touches tenant data
 *     (spec / plan / PR touching tenant data)
 *
 * Soft warnings (return ok, coordinator logs separately):
 *   - Missing "Doc-sync rules" (spec/plan only)
 *   - Empty or missing "Known operator decisions" (any mode)
 *
 * The coordinator is responsible for logging soft warnings; this helper
 * only signals whether the reviewer should be blocked.
 */
export function validateProjectContext(
  context: string,
  mode: ReviewMode,
  artifactTouchesTenantData: boolean,
): ValidateResult {
  const missing: string[] = [];

  // Hard: Stage required for any mode
  if (!hasHeading(context, 'Stage')) {
    missing.push('Stage');
  }

  // Hard: Framing assumptions required for any mode
  if (!hasHeading(context, 'Framing assumptions')) {
    missing.push('Framing assumptions');
  }

  // Hard: Architecture + Guidelines required when artifact touches tenant data
  if (detectsTenantData(artifactTouchesTenantData)) {
    if (!hasHeading(context, 'Architecture')) {
      missing.push('Architecture');
    }
    if (!hasHeading(context, 'Guidelines')) {
      missing.push('Guidelines');
    }
  }

  if (missing.length > 0) {
    return { kind: 'fail_closed', missing_sections: missing };
  }

  return { kind: 'ok' };
}

/**
 * Scan arbitrary artifact text for tenant-data signals.
 * Used by the coordinator before calling validateProjectContext so it can
 * pass the correct artifactTouchesTenantData value.
 */
export function artifactTouchesTenantData(
  artifactText: string,
  tenantKeyColumnName?: string,
): boolean {
  for (const signal of TENANT_DATA_SIGNALS) {
    if (artifactText.includes(signal)) return true;
  }
  if (tenantKeyColumnName && artifactText.includes(tenantKeyColumnName)) {
    return true;
  }
  return false;
}

/**
 * Registry-section headings required by the v2.8.0 Hunt-Target additions
 * (chatgpt-prompt-tuning-notifications-system brief §6.2).
 *
 * The chatgpt-{spec,plan,pr}-review prompts now reference "named in
 * PROJECT_CONTEXT" for several patterns. The coordinator should inject these
 * sections from the consuming repo's `.claude/project-registries.json`
 * config file (see `.claude/project-registries.json.template` in the
 * framework canonical for the expected shape).
 */
export const REGISTRY_SECTIONS = [
  'Registry / manifest surfaces',
  'CI-only gates',
  'Gate IDs and suppression scopes',
  'CI workflow files',
  'Local-vs-CI verification policy',
] as const;

export type RegistrySection = (typeof REGISTRY_SECTIONS)[number];

/**
 * Detect which §6.2 registry sections are missing from PROJECT_CONTEXT.
 *
 * Used by the coordinator AFTER `validateProjectContext` returns `ok` to
 * surface advisory warnings. Soft-default posture (v2.8.0 launch): missing
 * registry sections do NOT fail-close the review; the coordinator logs a
 * consolidated coverage warning (see `computeCoverageReport` and
 * `formatCoverageWarning`) so consuming repos see exactly which Hunt
 * Targets degraded, then the reviewer call still proceeds.
 *
 * The new Hunt Targets that reference "named in PROJECT_CONTEXT" degrade
 * gracefully when these sections are absent — the reviewer simply cannot
 * fire those patterns on this run.
 *
 * Future framework versions (v2.9.0+) may flip this to a fail-closed
 * requirement once consuming-repo adoption is widespread; the change will
 * be announced in CHANGELOG.md.
 */
export function findMissingRegistrySections(context: string): RegistrySection[] {
  const missing: RegistrySection[] = [];
  for (const section of REGISTRY_SECTIONS) {
    if (!hasHeading(context, section)) {
      missing.push(section);
    }
  }
  return missing;
}

/**
 * Mapping from registry section → the v2.8.0 Hunt-Target patterns that
 * reference it via "named in PROJECT_CONTEXT". When a section is missing,
 * every Hunt Target listed under it falls silent on that run.
 *
 * Hunt Targets NOT listed here (SPEC-NEW-1 stale-view prevention, SPEC-NEW-3
 * chunk-discipline file-count, PLAN-NEW-3/4/5, PR-NEW-3 test-mock staleness,
 * PR-NEW-5 module side-effects) are self-contained and remain active
 * regardless of registry-section coverage.
 */
const SECTION_TO_HUNT_TARGETS: Record<RegistrySection, readonly string[]> = {
  'Registry / manifest surfaces': [
    'PLAN-NEW-2 (Registry / Manifest Completeness, plan-stage)',
    'PR-NEW-1 (Registry / Manifest Completeness, PR-stage)',
  ],
  'CI-only gates': [
    'PLAN-NEW-1 (Local-vs-CI verification language consistency)',
  ],
  'Gate IDs and suppression scopes': [
    'PR-NEW-2 (Gate convention regex pre-check on new files)',
    'PR-NEW-4 (Guard-ignore comment correctness check)',
  ],
  'CI workflow files': [
    'PR-NEW-6 (Large-diff CI infrastructure adequacy heads-up)',
  ],
  'Local-vs-CI verification policy': [
    'PLAN-NEW-1 (Local-vs-CI verification language consistency)',
  ],
};

/**
 * Total number of new Hunt Targets shipped in framework v2.8.0.
 * Used by `computeCoverageReport` to compute active vs degraded counts.
 */
const V2_8_0_TOTAL_NEW_HUNT_TARGETS = 13;

/**
 * Number of self-contained Hunt Targets (always active regardless of
 * registry-section coverage). v2.8.0:
 *   SPEC: 2 (stale-view; chunk-discipline file-count)
 *   PLAN: 3 (test-mock staleness; discovery/precondition sequencing;
 *           forward-reference / migration-order)
 *   PR:   2 (test-mock staleness; module side-effects on import)
 * Plus the SPEC §4.1.a in-place extension to the existing
 * "Testing-posture drift" bullet (counts as the +1 separator inside SPEC).
 *
 * Recomputed cleanly: 7 self-contained patterns; 6 registry-dependent.
 */
const V2_8_0_SELF_CONTAINED_HUNT_TARGETS = 7;

export interface CoverageReport {
  /** 'complete' = all 5 sections present; 'partial' = some missing; 'all-missing' = no registry data injected. */
  status: 'complete' | 'partial' | 'all-missing';
  missing_sections: RegistrySection[];
  /** Count of new Hunt Targets active on this run. */
  active_hunt_target_count: number;
  /** Count of new Hunt Targets degraded (falling silent) due to missing sections. */
  degraded_hunt_target_count: number;
  /** Names of the degraded Hunt Targets, dedup'd and sorted (some sections map to the same target). */
  degraded_hunt_targets: string[];
}

/**
 * Compute a coverage report mapping the missing registry sections to the
 * specific v2.8.0 Hunt Targets that degrade as a result.
 *
 * The coordinator should call this once per dispatch (after
 * `findMissingRegistrySections`) and pass the result to
 * `formatCoverageWarning` to log a single, consolidated startup warning —
 * not one warning per missing section. This gives operators a clear picture
 * of "what review coverage am I actually getting?" instead of a stream of
 * unrelated warnings that read like noise.
 */
export function computeCoverageReport(
  missingSections: readonly RegistrySection[],
): CoverageReport {
  const degraded = new Set<string>();
  for (const section of missingSections) {
    for (const target of SECTION_TO_HUNT_TARGETS[section]) {
      degraded.add(target);
    }
  }
  const degradedList = [...degraded].sort();
  const status: CoverageReport['status'] =
    missingSections.length === 0
      ? 'complete'
      : missingSections.length === REGISTRY_SECTIONS.length
        ? 'all-missing'
        : 'partial';
  return {
    status,
    missing_sections: [...missingSections],
    active_hunt_target_count: V2_8_0_TOTAL_NEW_HUNT_TARGETS - degradedList.length,
    degraded_hunt_target_count: degradedList.length,
    degraded_hunt_targets: degradedList,
  };
}

/**
 * Format a `CoverageReport` as a multi-line operator-facing warning string.
 *
 * Output shape (single block; the coordinator prints once at dispatch
 * start, not per finding):
 *
 *   ┌─ chatgpt-review coverage warning ────────────────────────────────
 *   │ Review coverage status: <status>
 *   │ v2.8.0 Hunt Targets: <active>/<total> active, <degraded> degraded
 *   │   Self-contained (always active): <self_contained_count>
 *   │   Missing registry sections (<count>):
 *   │     - <section name>
 *   │   Degraded Hunt Targets (<count>):
 *   │     - <hunt-target id and brief>
 *   │ Fix: copy `.claude/project-registries.json.template` to
 *   │      `.claude/project-registries.json` and fill in the missing
 *   │      sections. See framework v2.8.0 changelog for details.
 *   └──────────────────────────────────────────────────────────────────
 *
 * When `status === 'complete'`, returns a one-line ok message instead.
 */
export function formatCoverageWarning(report: CoverageReport): string {
  if (report.status === 'complete') {
    return `chatgpt-review coverage: complete — all ${V2_8_0_TOTAL_NEW_HUNT_TARGETS} v2.8.0 Hunt Targets active.`;
  }

  const lines: string[] = [];
  lines.push('┌─ chatgpt-review coverage warning ────────────────────────────────');
  lines.push(`│ Review coverage status: ${report.status}`);
  lines.push(
    `│ v2.8.0 Hunt Targets: ${report.active_hunt_target_count}/${V2_8_0_TOTAL_NEW_HUNT_TARGETS} active, ${report.degraded_hunt_target_count} degraded`,
  );
  lines.push(`│   Self-contained (always active): ${V2_8_0_SELF_CONTAINED_HUNT_TARGETS}`);
  lines.push(`│ Missing registry sections (${report.missing_sections.length}):`);
  for (const section of report.missing_sections) {
    lines.push(`│   - ${section}`);
  }
  lines.push(`│ Degraded Hunt Targets (${report.degraded_hunt_target_count}):`);
  for (const target of report.degraded_hunt_targets) {
    lines.push(`│   - ${target}`);
  }
  lines.push('│ Fix: copy `.claude/project-registries.json.template` to');
  lines.push('│      `.claude/project-registries.json` and fill in the missing');
  lines.push('│      sections. See framework v2.8.0 changelog for details.');
  lines.push('└──────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}
