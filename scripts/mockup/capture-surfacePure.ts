/**
 * capture-surfacePure.ts
 *
 * Pure extraction helpers for render-grounding capture. Given raw records
 * collected from a live page (via `page.evaluate` in the impure
 * `capture-surface.ts`), produce the de-duplicated page-wide token sheet and the
 * structured DOM outline that ground the mockup-designer's draft.
 *
 * Observe, don't guess (spec §1, §4.2): these helpers transform OBSERVED computed
 * styles and OBSERVED DOM text into the manifest's `tokenSheet` / `domOutline`.
 * No inference, no Playwright, no fs — tested by
 * `scripts/__tests__/capture-surfacePure.test.ts` (Vitest).
 *
 * Spec: tasks/builds/grounded-mockups-render-and-behaviour/spec.md §4.2,
 * §9 decision 1 (page-wide de-duplicated token sheet, NOT per-element).
 */

import type { DomOutline, TokenSheet } from './capture-manifestPure';

/** One element's relevant computed styles, as read off the live page. All optional — elements vary. */
export interface ComputedStyleRecord {
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  margin?: string;
  padding?: string;
  gap?: string;
  borderRadius?: string;
  boxShadow?: string;
}

export type OutlineKind =
  | 'nav'
  | 'tab'
  | 'heading'
  | 'columnHeader'
  | 'primaryButton'
  | 'statusPill';

/** A DOM node the impure `page.evaluate` tagged as interesting, with its visible text. */
export interface OutlineCandidate {
  kind: OutlineKind;
  text: string;
}

/** Cap per bucket/token array so a pathological page cannot produce a runaway manifest. */
const MAX_PER_BUCKET = 60;

const AUTH_ROUTE_HINTS = ['/login', '/signin', '/sign-in', '/auth', '/unauthorized', '/forbidden'];

/**
 * True if, after navigation, the page is no longer on the requested surface — a
 * stale-auth redirect to a login/unauthorized page, or any redirect that drops
 * the requested route prefix. Guards against capturing the WRONG surface as
 * `captured` (the reviewer trusts the capture as observed truth). Catches server
 * redirects; an SPA that renders a login wall inline WITHOUT changing the URL is
 * caught instead by the orchestrator's optional `requireSelector`.
 */
export function navigatedAwayFromRoute(finalUrl: string, requestedRoute: string): boolean {
  let finalPath: string;
  try {
    finalPath = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    return false;
  }
  let wantPath: string;
  try {
    wantPath = new URL(requestedRoute, 'http://x').pathname.toLowerCase();
  } catch {
    wantPath = requestedRoute.toLowerCase();
  }
  const wantIsAuth = AUTH_ROUTE_HINTS.some((h) => wantPath.startsWith(h));
  if (!wantIsAuth && AUTH_ROUTE_HINTS.some((h) => finalPath.startsWith(h))) return true;
  if (wantPath !== '/' && !finalPath.startsWith(wantPath)) return true;
  return false;
}

/** Computed values that carry no design signal — dropped from the token sheet. */
const NOISE_VALUES = new Set([
  '',
  'none',
  'normal',
  'auto',
  '0px',
  '0',
  'rgba(0, 0, 0, 0)',
  'transparent',
  'inherit',
  'initial',
  'unset',
]);

function isSignal(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  return !NOISE_VALUES.has(value.trim().toLowerCase());
}

/** De-duplicate, preserving first-seen order, after trimming; drop empties; cap length. */
function dedupeOrdered(values: Iterable<string>, cap = MAX_PER_BUCKET): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Collapse per-element computed styles into ONE page-wide de-duplicated token
 * sheet (§9 decision 1). Colours pool background/text/border; fonts, spacing,
 * radii and shadows each pool their sources. Noise values (transparent, none,
 * 0px, ...) are dropped.
 */
export function extractTokenSheet(records: ComputedStyleRecord[]): TokenSheet {
  const colors: string[] = [];
  const fontFamilies: string[] = [];
  const fontSizes: string[] = [];
  const fontWeights: string[] = [];
  const spacing: string[] = [];
  const radii: string[] = [];
  const shadows: string[] = [];

  for (const r of records ?? []) {
    for (const c of [r.color, r.backgroundColor, r.borderColor]) if (isSignal(c)) colors.push(c);
    if (isSignal(r.fontFamily)) fontFamilies.push(r.fontFamily);
    if (isSignal(r.fontSize)) fontSizes.push(r.fontSize);
    if (isSignal(r.fontWeight)) fontWeights.push(r.fontWeight);
    for (const s of [r.margin, r.padding, r.gap]) if (isSignal(s)) spacing.push(s);
    if (isSignal(r.borderRadius)) radii.push(r.borderRadius);
    if (isSignal(r.boxShadow)) shadows.push(r.boxShadow);
  }

  return {
    colors: dedupeOrdered(colors),
    fontFamilies: dedupeOrdered(fontFamilies),
    fontSizes: dedupeOrdered(fontSizes),
    fontWeights: dedupeOrdered(fontWeights),
    spacing: dedupeOrdered(spacing),
    radii: dedupeOrdered(radii),
    shadows: dedupeOrdered(shadows),
  };
}

/**
 * Bucket tagged DOM candidates into the structured outline (§4.2): nav items,
 * tab labels, headings, table column headers, primary buttons, status-pill text.
 * Trims, drops empties, de-duplicates, caps. This is the "real vocabulary" the
 * designer inherits and `mockup-reviewer` Axis 1 greps against.
 */
export function pruneDomOutline(candidates: OutlineCandidate[]): DomOutline {
  const buckets: Record<OutlineKind, string[]> = {
    nav: [],
    tab: [],
    heading: [],
    columnHeader: [],
    primaryButton: [],
    statusPill: [],
  };

  for (const c of candidates ?? []) {
    if (!c || typeof c.text !== 'string') continue;
    const bucket = buckets[c.kind];
    if (bucket) bucket.push(c.text);
  }

  return {
    navItems: dedupeOrdered(buckets.nav),
    tabLabels: dedupeOrdered(buckets.tab),
    headings: dedupeOrdered(buckets.heading),
    tableColumnHeaders: dedupeOrdered(buckets.columnHeader),
    primaryButtons: dedupeOrdered(buckets.primaryButton),
    statusPills: dedupeOrdered(buckets.statusPill),
  };
}
