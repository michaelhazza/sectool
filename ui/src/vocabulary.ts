// Normative plain-language vocabulary — §5.2 of the spec.
// Every operator-facing label that maps from an internal term is defined here.
// Import from this module; never hardcode the labels elsewhere in the SPA.

export const SURFACE_LABELS = {
  static: 'In the code',
  live: 'On the live test site',
} as const;

export const SEVERITY_LABELS = {
  critical: 'Fix now',
  high: 'Fix soon',
  medium: 'Plan it',
  low: 'Low risk',
} as const;

// Severity technical sub-labels (shown secondary to the operator label)
export const SEVERITY_TECH = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
} as const;

export const BASELINE_LABELS = {
  entry: 'Acknowledged risk',
  suppressed: 'Accepted risk',
} as const;

export const ALLOWLIST_LABEL = 'Approved test sites';

// Config editing state labels
export const CONFIG_EDIT_DISABLED_LABEL = 'Config editing disabled';
export const CONFIG_EDIT_ENABLED_LABEL = 'Live editing enabled';

export const PARTIAL_RUN_LABEL = 'Some checks did not finish';
export const PARTIAL_RUN_PILL = 'Incomplete run';

// Run status labels
export const RUN_STATUS_LABELS = {
  success: 'All checks complete',
  partial: PARTIAL_RUN_LABEL,
  failed: 'Run failed',
  unknown: 'Unknown',
} as const;

// Screen titles (operator language, §5.2)
export const SCREEN_TITLES = {
  portfolio: 'Portfolio Overview',
  runReport: 'What Needs Fixing',
  findingDetail: 'Issue Detail',
  fixes: 'Fix Progress',
  trends: 'Progress Over Time',
  targets: 'Sites and Safety',
} as const;

// Fix-request state labels (§5.3 six-state machine)
export const FIX_STATUS_LABELS = {
  requested: 'Requested',
  'in-progress': 'In Progress',
  'awaiting-review': 'Awaiting Review',
  'merged-awaiting-verification': 'Merged, Awaiting Verification',
  'verified-fixed': 'Verified Fixed',
  reopened: 'Reopened',
} as const;

// Technical identifiers — always secondary sub-line, never a headline (§5.2)
export const TECH_SECONDARY_NOTE =
  'Rule IDs, fingerprints, and scanner names are shown as secondary details.';

// Nav labels
export const NAV_LABELS = {
  portfolio: 'Portfolio Overview',
  runReport: 'What Needs Fixing',
  fixes: 'Fix Progress',
  trends: 'Progress Over Time',
  targets: 'Sites and Safety',
  runAScan: 'Run a Scan',
} as const;

// Trigger-provenance labels — shown on job/report rows
export const TRIGGER_LABELS = {
  'on-demand': 'Operator',
  scheduled: 'Scheduled',
  replay: 'Replay',
} as const;
