/**
 * capture-surface.ts
 *
 * Render-grounding capture (impure orchestrator). Drives a real browser against
 * the consuming repo's running UI-test server, reads the live DOM + computed CSS
 * off each existing surface, and emits a capture manifest the mockup-designer
 * grounds against and the mockup-reviewer verifies (spec §4.2/§4.3).
 *
 * Observe, don't guess: this script captures EXISTING surfaces only (grounding
 * inputs). It never captures the prototype. Capture is best-effort grounding —
 * NEVER a gate (§4.6): any failure degrades to `fallback_source_read` (or, for an
 * unrecoverable internal error, `failed`) and the designer falls back to
 * source-read grounding, explicitly logged.
 *
 * Reuse over rebuild (§4.2): this reuses the consuming repo's existing UI-test
 * server + Playwright storageState auth rather than re-implementing login.
 * ADR-0006 — it references CONVENTIONAL consuming-repo paths only, never a
 * specific project's names:
 *   - UI server:    `npm run dev:server:ui` (the operator boots it; this script
 *                   ATTACHES to it and degrades to `server_unavailable` if absent)
 *   - baseURL:      http://127.0.0.1:5000  (override via --base-url / CAPTURE_BASE_URL)
 *   - auth:         .test-runs/playwright/auth/{role}.json  (Playwright storageState)
 *
 * Pure extraction (token-sheet de-dup, DOM-outline pruning) and the manifest
 * contract/validator live in `capture-surfacePure.ts` / `capture-manifestPure.ts`
 * and are unit-tested there; this orchestrator is exercised by the live A1/A2 run
 * in the consuming repo (the framework repo has no browser — see the build's
 * REVIEW_GAP).
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import {
  validateCaptureManifest,
  validateScreenEntry,
  type CaptureManifest,
  type CaptureScreenEntry,
  type FallbackReason,
} from './capture-manifestPure';
import {
  extractTokenSheet,
  navigatedAwayFromRoute,
  pruneDomOutline,
  type ComputedStyleRecord,
  type OutlineCandidate,
} from './capture-surfacePure';

export interface CaptureInput {
  screenId: string;
  route: string;
  role: string;
  /** Defaults to DEFAULT_VIEWPORTS (375/768/1280) when omitted. */
  viewports?: number[];
  /**
   * Optional selector that MUST be present on the target surface (e.g. a page
   * heading or a data-testid). If supplied and absent after navigation, the
   * capture downgrades — guards against a stale-auth redirect or a 200
   * login/unauthorized page being captured as the requested surface.
   */
  requireSelector?: string;
}

export interface CaptureOptions {
  slug: string;
  projectRoot?: string;
  baseURL?: string;
  /** Directory holding Playwright storageState files, `{role}.json`. */
  authDir?: string;
  /** Output dir for screenshots + manifest. Defaults to `prototypes/{slug}/_captures`. */
  outDir?: string;
  /** Settle delay after network-idle, ms. */
  settleMs?: number;
}

/** §4.2 / §9 — mirror the mobile-shape mandate's three widths. */
export const DEFAULT_VIEWPORTS = [375, 768, 1280];
const DEFAULT_BASE_URL = process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:5000';
const DEFAULT_AUTH_DIR = '.test-runs/playwright/auth';
const DEFAULT_SETTLE_MS = 400;
const NAV_TIMEOUT_MS = 15_000;
/** Cap a full-page screenshot's height so a pathological page cannot produce a giant PNG (§9 decision 3). */
const MAX_FULLPAGE_HEIGHT = 6000;
const MAX_COMPUTED_ELEMENTS = 2000;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Manifest paths are repo-relative POSIX (review OAI-PR-002): the manifest is
 * committed (§9 decision 3), so an absolute path would make it machine-specific
 * and could leak a local username/workspace layout. The PNG is still WRITTEN to
 * its absolute filesystem location; only the value persisted into `screenshotPaths`
 * is normalised. A path outside `projectRoot` (custom `outDir`) is left as-is.
 */
function toRepoRelative(absPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, absPath);
  if (rel === '' || rel.startsWith('..')) return absPath;
  return rel.split('\\').join('/');
}

function isServerReachable(baseURL: string): Promise<boolean> {
  return fetch(baseURL, { method: 'HEAD' })
    .then((r) => r.ok || r.status < 500)
    .catch(() => false);
}

/** Atomic screenshot: write to a temp path, rename on success; never leave a partial PNG (A2). */
async function screenshotAtomic(page: Page, finalPath: string): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  try {
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    if (scrollHeight > MAX_FULLPAGE_HEIGHT) {
      await page.screenshot({ path: tmpPath, clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 1280, height: MAX_FULLPAGE_HEIGHT } });
    } else {
      await page.screenshot({ path: tmpPath, fullPage: true });
    }
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Remove screenshots written for a screen that ends up degrading/failing, so no orphan PNG remains. */
async function removePartials(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => undefined)));
}

/** Read computed styles (sampled, capped) + tagged outline candidates off the live page. Runs in the browser. */
function collectPageData(maxElements: number): { styles: ComputedStyleRecord[]; outline: OutlineCandidate[] } {
  const styles: ComputedStyleRecord[] = [];
  const els = Array.from(document.querySelectorAll<HTMLElement>('*')).slice(0, maxElements);
  for (const el of els) {
    const cs = getComputedStyle(el);
    styles.push({
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      margin: cs.margin,
      padding: cs.padding,
      gap: cs.gap,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
    });
  }

  const outline: OutlineCandidate[] = [];
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const push = (kind: OutlineCandidate['kind'], nodes: Iterable<Element>): void => {
    for (const n of nodes) {
      const t = text(n);
      if (t) outline.push({ kind, text: t });
    }
  };

  push('nav', document.querySelectorAll('nav a, nav button, [role="navigation"] a, [role="navigation"] button'));
  push('tab', document.querySelectorAll('[role="tab"]'));
  push('heading', document.querySelectorAll('h1, h2, h3'));
  push('columnHeader', document.querySelectorAll('th, [role="columnheader"]'));
  push('primaryButton', document.querySelectorAll('button, [role="button"]'));
  push('statusPill', document.querySelectorAll('[class*="pill" i], [class*="badge" i], [data-status]'));

  return { styles, outline };
}

function fallbackEntry(input: CaptureInput, viewports: number[], reason: FallbackReason): CaptureScreenEntry {
  return {
    screenId: input.screenId,
    route: input.route,
    role: input.role,
    capturedAt: nowIso(),
    viewports,
    captureStatus: 'fallback_source_read',
    fallbackReason: reason,
  };
}

function failedEntry(input: CaptureInput, viewports: number[], failureReason: string): CaptureScreenEntry {
  return {
    screenId: input.screenId,
    route: input.route,
    role: input.role,
    capturedAt: nowIso(),
    viewports,
    captureStatus: 'failed',
    failureReason,
  };
}

async function captureOneScreen(
  browser: Browser,
  input: CaptureInput,
  viewports: number[],
  opts: Required<Pick<CaptureOptions, 'slug' | 'baseURL' | 'authDir' | 'outDir' | 'settleMs'>> & { projectRoot: string },
): Promise<CaptureScreenEntry> {
  const storageStatePath = join(opts.authDir, `${input.role}.json`);
  if (!existsSync(storageStatePath)) {
    // Cannot authenticate as this role — degrade, do not fail the round.
    return fallbackEntry(input, viewports, `route_unreachable_as_${input.role}`);
  }

  const context = await browser.newContext({ storageState: storageStatePath });
  // Screenshots written so far for THIS screen — removed if the screen degrades or throws,
  // so a non-`captured` entry never leaves an orphan PNG on disk (keeps A2 true at the file-tree level).
  const written: string[] = [];
  try {
    const screenshotPaths: Record<number, string> = {};
    let widestStyles: ComputedStyleRecord[] = [];
    let widestOutline: OutlineCandidate[] = [];
    let widestSeen = -1;

    for (const viewport of viewports) {
      const page = await context.newPage();
      await page.setViewportSize({ width: viewport, height: 900 });
      const url = new URL(input.route, opts.baseURL).toString();
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
      if (response && response.status() >= 400) {
        await page.close();
        await removePartials(written);
        return fallbackEntry(input, viewports, `route_unreachable_as_${input.role}`);
      }
      await page.waitForTimeout(opts.settleMs);

      // Auth/route guard (review: stale-auth false-positive). A redirect away from
      // the requested route (e.g. to a login page), or a missing required selector,
      // means we are NOT on the target surface — downgrade rather than ground the
      // mockup in the wrong page.
      const offTarget = navigatedAwayFromRoute(page.url(), input.route);
      const selectorMissing = input.requireSelector ? (await page.$(input.requireSelector)) === null : false;
      if (offTarget || selectorMissing) {
        await page.close();
        await removePartials(written);
        return fallbackEntry(input, viewports, `route_unreachable_as_${input.role}`);
      }

      const finalPath = join(opts.outDir, `${input.screenId}-${viewport}.png`);
      await screenshotAtomic(page, finalPath);
      written.push(finalPath);
      // Persist a repo-relative POSIX path in the committed manifest (OAI-PR-002);
      // the PNG itself is written to `finalPath` on the local filesystem.
      screenshotPaths[viewport] = toRepoRelative(finalPath, opts.projectRoot);

      // Ground the token sheet / outline in the WIDEST captured viewport (fullest
      // desktop layout), regardless of the order viewports were supplied in — the
      // viewport set is caller-parameterised (§9 decision 2) and may be unsorted.
      const data = await page.evaluate(collectPageData, MAX_COMPUTED_ELEMENTS);
      if (viewport > widestSeen) {
        widestSeen = viewport;
        widestStyles = data.styles;
        widestOutline = data.outline;
      }
      await page.close();
    }

    const captured: CaptureScreenEntry = {
      screenId: input.screenId,
      route: input.route,
      role: input.role,
      capturedAt: nowIso(),
      viewports,
      captureStatus: 'captured',
      screenshotPaths,
      tokenSheet: extractTokenSheet(widestStyles),
      domOutline: pruneDomOutline(widestOutline),
    };

    // The screenshots succeeded, but the page may have yielded an all-empty token
    // sheet or DOM outline (a blank/loading/unusual surface). A `captured` entry
    // that fails the contract would make writeManifest() throw and kill the whole
    // round — capture is NEVER a gate (§4.6). Validate the would-be entry against
    // the SAME contract the writer enforces; if it does not qualify as `captured`,
    // drop the screenshots and downgrade to a clean `data_absent` fallback.
    if (validateScreenEntry(captured).valid) {
      return captured;
    }
    await removePartials(written);
    return fallbackEntry(input, viewports, 'data_absent');
  } catch (err) {
    // Unrecoverable mid-screen error — drop any partial screenshots before the
    // caller records this screen as `failed` (which must carry no captured-shape fields).
    await removePartials(written);
    throw err;
  } finally {
    await context.close();
  }
}

/**
 * Capture the listed existing surfaces. Returns a validated manifest. A failed
 * capture for one screen degrades that screen only; the round always completes.
 */
export async function captureSurfaces(inputs: CaptureInput[], options: CaptureOptions): Promise<CaptureManifest> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const authDir = join(projectRoot, options.authDir ?? DEFAULT_AUTH_DIR);
  const outDir = options.outDir ?? join(projectRoot, 'prototypes', options.slug, '_captures');
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const resolved = { slug: options.slug, baseURL, authDir, outDir, settleMs, projectRoot };

  const screens: CaptureScreenEntry[] = [];

  const reachable = await isServerReachable(baseURL);
  if (!reachable) {
    // §4.6: server not running — every screen degrades, no partial artifacts written.
    for (const input of inputs) {
      screens.push(fallbackEntry(input, input.viewports ?? DEFAULT_VIEWPORTS, 'server_unavailable'));
    }
    return writeManifest(outDir, options.slug, screens);
  }

  // Launching the browser can itself fail (no installed Chromium binary, sandbox
  // denied). That is not a per-screen failure — it means the whole capture cannot
  // run — but capture is NEVER a gate (§4.6), so every screen degrades to
  // source-read grounding rather than rejecting the round. `browser_unavailable`
  // is recorded as a per-screen `failed` reason (no captured-shape fields), so the
  // designer falls back explicitly and the manifest is still written.
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const reason = `browser_unavailable: ${err instanceof Error ? err.message : String(err)}`;
    for (const input of inputs) {
      screens.push(failedEntry(input, input.viewports ?? DEFAULT_VIEWPORTS, reason));
    }
    return writeManifest(outDir, options.slug, screens);
  }

  try {
    for (const input of inputs) {
      const viewports = input.viewports ?? DEFAULT_VIEWPORTS;
      try {
        screens.push(await captureOneScreen(browser, input, viewports, resolved));
      } catch (err) {
        // Unrecoverable per-screen error — record `failed` (no captured-shape fields), keep going.
        screens.push(failedEntry(input, viewports, err instanceof Error ? err.message : String(err)));
      }
    }
  } finally {
    await browser.close();
  }

  return writeManifest(outDir, options.slug, screens);
}

async function writeManifest(outDir: string, slug: string, screens: CaptureScreenEntry[]): Promise<CaptureManifest> {
  const manifest: CaptureManifest = { slug, generatedAt: nowIso(), screens };
  const result = validateCaptureManifest(manifest);
  if (!result.valid) {
    // The orchestrator produced an invalid manifest — surface loudly; this is a bug, not a capture failure.
    throw new Error(`capture-surface produced an invalid manifest:\n${result.errors.join('\n')}`);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Minimal CLI: `tsx capture-surface.ts --slug <slug> --screens '<json>'`. */
function parseArgs(argv: string[]): { slug: string; screens: CaptureInput[]; baseURL?: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const slug = get('--slug');
  const screensRaw = get('--screens');
  if (!slug || !screensRaw) {
    throw new Error("usage: capture-surface --slug <slug> --screens '[{\"screenId\":..,\"route\":..,\"role\":..}]' [--base-url <url>]");
  }
  return { slug, screens: JSON.parse(screensRaw) as CaptureInput[], baseURL: get('--base-url') };
}

// Run as a script (not when imported). `import.meta.url` guard keeps it importable for tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { slug, screens, baseURL } = parseArgs(process.argv.slice(2));
  captureSurfaces(screens, { slug, baseURL })
    .then((m) => {
      const statuses = m.screens.map((s) => `${s.screenId}:${s.captureStatus}`).join(', ');
      process.stdout.write(`capture complete — ${statuses}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}
