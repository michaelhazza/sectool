/**
 * capture-manifestPure.ts
 *
 * Pure contract + validator for the render-grounding capture manifest
 * (`prototypes/{slug}/_captures/manifest.json`).
 *
 * This module is the gate `mockup-reviewer` Axis 1 trusts: if a screen entry
 * claims `captureStatus: 'captured'`, the validator guarantees a screenshot for
 * every listed viewport, a non-empty token sheet, and a non-empty structured DOM
 * outline. It never throws — it returns a structured result so a capture round
 * can log and degrade rather than crash.
 *
 * Pure-function module (no Playwright, no fs). Tested by
 * `scripts/__tests__/capture-manifestPure.test.ts` (Vitest). The impure
 * Playwright orchestrator lives in `capture-surface.ts`.
 *
 * Spec: tasks/builds/grounded-mockups-render-and-behaviour/spec.md §4.3, §4.6.
 */

export type CaptureStatus = 'captured' | 'fallback_source_read' | 'failed';

/**
 * Fallback reasons (§4.6). `route_unreachable_as_{role}` is a template — the
 * validator accepts the `route_unreachable_as_` prefix plus a non-empty role
 * token (e.g. `route_unreachable_as_org-admin`).
 */
export type FallbackReason =
  | 'server_unavailable'
  | 'data_absent'
  | 'n/a_new_surface'
  | `route_unreachable_as_${string}`;

/**
 * Page-wide de-duplicated token sheet (§9 decision 1 — one set per page, NOT
 * per-element). Each field is the de-duplicated set of computed values actually
 * in use on the page.
 */
export interface TokenSheet {
  colors: string[];
  fontFamilies: string[];
  fontSizes: string[];
  fontWeights: string[];
  spacing: string[];
  radii: string[];
  shadows: string[];
}

/**
 * Structured DOM outline (§4.2) — the "real vocabulary" source. Each array holds
 * the page's real `textContent`, so `mockup-reviewer` Axis 1 can match the
 * mockup's inherited vocabulary against observed reality. NOT an opaque digest.
 */
export interface DomOutline {
  navItems: string[];
  tabLabels: string[];
  headings: string[];
  tableColumnHeaders: string[];
  primaryButtons: string[];
  statusPills: string[];
}

interface BaseScreenEntry {
  screenId: string;
  route: string;
  role: string;
  /** UTC ISO 8601. */
  capturedAt: string;
  /** Default 375 / 768 / 1280; `role`/viewport set is parameterised (§9 decision 2). */
  viewports: number[];
}

export interface CapturedScreenEntry extends BaseScreenEntry {
  captureStatus: 'captured';
  /** One key per entry in `viewports` (review #1). */
  screenshotPaths: Record<number, string>;
  tokenSheet: TokenSheet;
  domOutline: DomOutline;
}

export interface FallbackSourceReadScreenEntry extends BaseScreenEntry {
  captureStatus: 'fallback_source_read';
  fallbackReason: FallbackReason;
  /** Present only for `data_absent` (empty-state capture). */
  screenshotPaths?: Record<number, string>;
}

export interface FailedScreenEntry extends BaseScreenEntry {
  captureStatus: 'failed';
  /** Required, non-empty. Carries no captured-shape fields. */
  failureReason: string;
}

export type CaptureScreenEntry =
  | CapturedScreenEntry
  | FallbackSourceReadScreenEntry
  | FailedScreenEntry;

export interface CaptureManifest {
  slug: string;
  /** UTC ISO 8601. */
  generatedAt: string;
  screens: CaptureScreenEntry[];
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

const CAPTURE_STATUSES: CaptureStatus[] = ['captured', 'fallback_source_read', 'failed'];
const FIXED_FALLBACK_REASONS = ['server_unavailable', 'data_absent', 'n/a_new_surface'];
const ROUTE_UNREACHABLE_PREFIX = 'route_unreachable_as_';

const TOKEN_SHEET_FIELDS: (keyof TokenSheet)[] = [
  'colors',
  'fontFamilies',
  'fontSizes',
  'fontWeights',
  'spacing',
  'radii',
  'shadows',
];

const DOM_OUTLINE_FIELDS: (keyof DomOutline)[] = [
  'navItems',
  'tabLabels',
  'headings',
  'tableColumnHeaders',
  'primaryButtons',
  'statusPills',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/** A valid `FallbackReason`: one of the fixed set, or the route-unreachable template with a non-empty role token. */
function isValidFallbackReason(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (FIXED_FALLBACK_REASONS.includes(value)) return true;
  if (value.startsWith(ROUTE_UNREACHABLE_PREFIX)) {
    return value.slice(ROUTE_UNREACHABLE_PREFIX.length).trim().length > 0;
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** A token sheet is well-formed (every field a string[]) and non-empty (≥1 field has entries). */
function tokenSheetIssues(value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${path}: tokenSheet must be an object`);
    return errors;
  }
  let anyNonEmpty = false;
  for (const field of TOKEN_SHEET_FIELDS) {
    const arr = value[field];
    if (arr === undefined) continue;
    if (!isStringArray(arr)) {
      errors.push(`${path}: tokenSheet.${field} must be an array of strings`);
      continue;
    }
    if (arr.length > 0) anyNonEmpty = true;
  }
  if (!anyNonEmpty) errors.push(`${path}: tokenSheet must have at least one non-empty token array`);
  return errors;
}

/** A DOM outline is well-formed and non-empty (≥1 array has entries). */
function domOutlineIssues(value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${path}: domOutline must be an object`);
    return errors;
  }
  let anyNonEmpty = false;
  for (const field of DOM_OUTLINE_FIELDS) {
    const arr = value[field];
    if (arr === undefined) continue;
    if (!isStringArray(arr)) {
      errors.push(`${path}: domOutline.${field} must be an array of strings`);
      continue;
    }
    if (arr.length > 0) anyNonEmpty = true;
  }
  if (!anyNonEmpty) errors.push(`${path}: domOutline must have at least one non-empty array (review #2)`);
  return errors;
}

function viewportsIssues(value: unknown, path: string): { errors: string[]; viewports: number[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { errors: [`${path}: viewports must be a non-empty array`], viewports: [] };
  }
  const errors: string[] = [];
  const viewports: number[] = [];
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      errors.push(`${path}: viewports must contain positive numbers, got ${JSON.stringify(v)}`);
    } else {
      viewports.push(v);
    }
  }
  return { errors, viewports };
}

function baseFieldIssues(entry: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(entry.screenId)) errors.push(`${path}: screenId must be a non-empty string`);
  if (!isNonEmptyString(entry.route)) errors.push(`${path}: route must be a non-empty string`);
  if (!isNonEmptyString(entry.role)) errors.push(`${path}: role must be a non-empty string`);
  if (!isIsoTimestamp(entry.capturedAt)) errors.push(`${path}: capturedAt must be a valid ISO 8601 timestamp`);
  return errors;
}

function screenshotPathsForViewports(value: unknown, viewports: number[], path: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${path}: screenshotPaths must be an object keyed by viewport`);
    return errors;
  }
  for (const vp of viewports) {
    const p = value[String(vp)];
    if (!isNonEmptyString(p)) {
      errors.push(`${path}: screenshotPaths missing a path for viewport ${vp} (review #1 — every viewport needs a screenshot)`);
    }
  }
  return errors;
}

/** True if the entry carries any captured-shape field (used to reject `failed` lying about a capture). */
function hasCapturedShapeFields(entry: Record<string, unknown>): boolean {
  return (
    entry.screenshotPaths !== undefined ||
    entry.tokenSheet !== undefined ||
    entry.domOutline !== undefined
  );
}

function screenEntryIssues(entry: unknown, index: number): string[] {
  const path = `screens[${index}]`;
  if (!isRecord(entry)) return [`${path}: must be an object`];

  const errors: string[] = [...baseFieldIssues(entry, path)];
  const { errors: vpErrors, viewports } = viewportsIssues(entry.viewports, path);
  errors.push(...vpErrors);

  const status = entry.captureStatus;
  if (typeof status !== 'string' || !CAPTURE_STATUSES.includes(status as CaptureStatus)) {
    errors.push(`${path}: unknown captureStatus ${JSON.stringify(status)}`);
    return errors;
  }

  switch (status as CaptureStatus) {
    case 'captured': {
      errors.push(...screenshotPathsForViewports(entry.screenshotPaths, viewports, path));
      errors.push(...tokenSheetIssues(entry.tokenSheet, path));
      errors.push(...domOutlineIssues(entry.domOutline, path));
      break;
    }
    case 'fallback_source_read': {
      if (!isValidFallbackReason(entry.fallbackReason)) {
        errors.push(`${path}: fallback_source_read requires a valid fallbackReason`);
      }
      // data_absent may carry an empty-state screenshot; any other captured-shape fields are not required.
      break;
    }
    case 'failed': {
      if (!isNonEmptyString(entry.failureReason)) {
        errors.push(`${path}: failed requires a non-empty failureReason`);
      }
      if (hasCapturedShapeFields(entry)) {
        errors.push(`${path}: failed must not carry captured-shape fields (screenshots/tokenSheet/domOutline) (review #3)`);
      }
      break;
    }
  }

  return errors;
}

/**
 * Validate a single would-be screen entry against the contract. Used by the
 * capture orchestrator to decide — BEFORE committing to `captured` — whether the
 * extracted token sheet / DOM outline actually satisfy the `captured` rules; if
 * not, it downgrades rather than letting `validateCaptureManifest` throw at write
 * time (keeps "capture is never a hard gate" — §4.6). Never throws.
 */
export function validateScreenEntry(entry: unknown): ValidationResult {
  const errors = screenEntryIssues(entry, 0);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validate a capture manifest. Never throws — returns a structured result even
 * for `null`/wrong-type input, so a capture round can log and degrade.
 */
export function validateCaptureManifest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }
  if (!isNonEmptyString(input.slug)) errors.push('slug must be a non-empty string');
  if (!isIsoTimestamp(input.generatedAt)) errors.push('generatedAt must be a valid ISO 8601 timestamp');

  if (!Array.isArray(input.screens)) {
    errors.push('screens must be an array');
  } else {
    input.screens.forEach((entry, i) => errors.push(...screenEntryIssues(entry, i)));
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
