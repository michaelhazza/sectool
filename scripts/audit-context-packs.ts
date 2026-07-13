/**
 * audit-context-packs.ts
 *
 * Pure function: validates that every anchor reference in docs/context-packs/*.md
 * resolves to a declared anchor in architecture.md, and detects unmapped
 * `{{ARCHITECTURE_ANCHOR:<purpose>}}` placeholder tokens left over when
 * ADAPT.md Phase 3b (anchor mapping via .claude/.framework-state.json substitutions)
 * has not been run.
 *
 * Run via: npx tsx scripts/audit-context-packs.ts [--strict-unmapped] [--list-anchors]
 *
 * Exit 0 — all mapped anchors resolve (or no packs present). Unmapped
 *          placeholder tokens are reported as `UNMAPPED <pack>:<line> <token>`
 *          lines but do NOT fail the audit by default: they mean the packs are
 *          installed but not yet adopted, and every pack consumer falls back to
 *          whole-file reads in that state.
 * Exit 1 — one or more mapped anchor references are broken; prints
 *          <pack>:<line> <anchor> per miss. With --strict-unmapped, unmapped
 *          placeholder tokens also fail (for repos that have completed
 *          Phase 3b and want regressions caught).
 *
 * --list-anchors — prints the explicit <a id="..."></a> anchors declared in
 *          architecture.md, one per line, to make Phase 3b mapping mechanical.
 *
 * Also importable as a pure module (no side effects on import).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PackAnchorMiss {
  pack: string;
  anchor: string;
  line: number;
}

export interface PackUnmappedToken {
  pack: string;
  purpose: string;
  line: number;
}

export interface AuditContextPacksInput {
  packs: Array<{ path: string; content: string }>;
  architectureMarkdown: string;
}

// `unmapped` is present only when non-empty, so callers comparing against the
// historical `{ kind: 'ok' }` / `{ kind: 'fail', missing }` shapes keep working.
export type AuditContextPacksResult =
  | { kind: 'ok'; unmapped?: PackUnmappedToken[] }
  | { kind: 'fail'; missing: PackAnchorMiss[]; unmapped?: PackUnmappedToken[] };

// ---------------------------------------------------------------------------
// GFM heading slug algorithm
// ---------------------------------------------------------------------------

export function gfmSlug(heading: string): string {
  // GitHub's heading-anchor slugger preserves underscores in addition to
  // hyphens and alphanumerics — `# State machine (usability_state)` renders
  // to `state-machine-usability_state`, not `state-machine-usabilitystate`.
  // Without `_` in the allow-list, valid links in context packs would be
  // falsely reported as broken anchors.
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ---------------------------------------------------------------------------
// Declared anchors — parse architecture.md
// ---------------------------------------------------------------------------

function extractDeclaredAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const lines = markdown.split('\n');
  // Mask BOTH fenced code blocks AND 4-space-indented code blocks. Anchors and
  // headings inside either form are example markup, not real declared anchors.
  const codeBlocked = buildCodeBlockMask(lines);

  // 1. Explicit <a id="..."></a> tags — scan line-by-line so we can skip code-block lines.
  //    Multiple tags on one non-code-block line are still captured by the global regex.
  const aIdRe = /<a\s+id="([^"]+)"\s*(?:\/>|><\/a>|>.*?<\/a>)/g;
  for (let i = 0; i < lines.length; i++) {
    if (codeBlocked[i]) continue;
    let m: RegExpExecArray | null;
    aIdRe.lastIndex = 0;
    while ((m = aIdRe.exec(lines[i])) !== null) {
      anchors.add(m[1]);
    }
  }

  // 2. Heading-derived slugs with GFM duplicate-suffix algorithm.
  //    Track counts globally across the file (not reset per section).
  //    Skip heading-shape lines inside code blocks (fenced or indented).
  const seenSlugs = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if (codeBlocked[i]) continue;
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(lines[i]);
    if (!headingMatch) continue;
    // Strip inline code and links from heading text before slugging.
    const text = headingMatch[1]
      .replace(/`[^`]*`/g, (s) => s.slice(1, -1))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = gfmSlug(text);
    if (!base) continue;
    // GitHub's slug-assignment algorithm: first occurrence uses the bare base;
    // subsequent occurrences get `-1`, `-2`, etc. If the candidate slug already
    // collides with a slug claimed by an earlier heading (natural or suffixed),
    // keep incrementing until a free slot is found. Matches GitHub's renderer
    // for sequences like `# Setup` / `# Setup` / `# Setup 1` → setup, setup-1,
    // setup-1-1.
    let count = seenSlugs.get(base) ?? 0;
    let candidate = count === 0 ? base : `${base}-${count}`;
    while (anchors.has(candidate)) {
      count += 1;
      candidate = `${base}-${count}`;
    }
    anchors.add(candidate);
    seenSlugs.set(base, count + 1);
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// GFM fence tracking — returns true when a line is inside a fenced code block
// ---------------------------------------------------------------------------

/**
 * Returns an array of booleans, one per line, indicating whether that line is
 * inside a code block — either a GFM fenced code block (``` or ~~~, opening
 * fence >=3 chars, indented 0-3 spaces) OR a 4-space-indented Markdown code
 * block (CommonMark §4.4). Anchors and headings inside either form are example
 * markup, not real declared/referenced anchors.
 *
 * Indented-block rules (CommonMark): an indented code block cannot interrupt a
 * paragraph, so we only treat 4+ space-indent lines as code when the most
 * recent non-blank line was blank/SOF or already in an indented block. Blank
 * lines inside an indented block do not break it — only a non-blank,
 * less-than-4-space-indent line ends it.
 */
export function buildCodeBlockMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inIndentedBlock = false;
  let prevLineBlank = true; // SOF behaves like a blank line

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inFence) {
      mask[i] = true;
      const closeRe = new RegExp(`^ {0,3}(\\${fenceChar}{${fenceLen},})\\s*$`);
      if (closeRe.test(line)) inFence = false;
      prevLineBlank = false;
      continue;
    }

    const isBlank = /^\s*$/.test(line);
    const isIndented4 = /^( {4,}|\t)/.test(line);
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fenceOpen) {
      inFence = true;
      fenceChar = fenceOpen[1][0];
      fenceLen = fenceOpen[1].length;
      mask[i] = true;
      inIndentedBlock = false;
      prevLineBlank = false;
      continue;
    }

    if (isBlank) {
      // Blank lines inside an indented block remain in the block. Indented
      // block doesn't end here; we wait for a non-blank, less-indented line.
      if (inIndentedBlock) mask[i] = true;
      prevLineBlank = true;
      continue;
    }

    if (isIndented4 && (prevLineBlank || inIndentedBlock)) {
      mask[i] = true;
      inIndentedBlock = true;
      prevLineBlank = false;
      continue;
    }

    // Non-blank, non-code line — ends any in-progress indented block.
    inIndentedBlock = false;
    prevLineBlank = false;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Reference anchor extraction — parse a single pack file
// ---------------------------------------------------------------------------

/**
 * Extract all anchor references from a pack file.
 * Returns an array of { anchor, line } (1-indexed line numbers).
 */
function extractPackAnchors(content: string): Array<{ anchor: string; line: number }> {
  const refs: Array<{ anchor: string; line: number }> = [];
  const lines = content.split('\n');
  const fenced = buildCodeBlockMask(lines);

  // Track whether we are under a "- `architecture.md`:" style source-block heading.
  // Such headings introduce a list of anchor refs as bare backtick fragments.
  let underSourceBlockHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    if (fenced[i]) {
      // Inside a fenced block — anchors here are code examples, not refs.
      underSourceBlockHeading = false;
      continue;
    }

    // Detect source-block heading: a list item or heading containing `architecture.md`:
    //   - `architecture.md`:
    //   ### `architecture.md` sections
    if (/`architecture\.md`/.test(line)) {
      underSourceBlockHeading = true;
    } else if (/^#{1,6}\s/.test(line)) {
      // A new markdown heading always resets the source-block context.
      underSourceBlockHeading = false;
    } else if (/^[-*]\s/.test(line)) {
      // A top-level list item (no leading whitespace) that doesn't look like an
      // anchor ref resets the context. Sub-items (indented) may be anchor-ref lines
      // and do NOT reset the context — let the bare-fragment check run on them.
      // Underscore is part of the GFM-slug allow-list (see gfmSlug above), so
      // the regex must accept `_` to match anchors like `state-machine-usability_state`.
      if (!/`#[a-z0-9_-]+`/.test(line)) {
        underSourceBlockHeading = false;
      }
    }

    // Form 1: Markdown links — [text](architecture.md#anchor) or [text](#anchor)
    const mdLinkRe = /\[([^\]]*)\]\((?:architecture\.md)?#([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdLinkRe.exec(line)) !== null) {
      refs.push({ anchor: m[2], line: lineNo });
    }

    // Form 2: Bare backtick fragment under source-block heading: `#anchor-id`
    // Mirror the declared-anchor slug character class — must include `_` so
    // underscore-bearing anchors are extracted and validated.
    if (underSourceBlockHeading) {
      const bareFragRe = /`(#[a-z0-9_-]+)`/g;
      while ((m = bareFragRe.exec(line)) !== null) {
        // Strip the leading '#'
        refs.push({ anchor: m[1].slice(1), line: lineNo });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Unmapped placeholder extraction — parse a single pack file
// ---------------------------------------------------------------------------

/**
 * Extract unmapped `{{ARCHITECTURE_ANCHOR:<purpose>}}` tokens from a pack file.
 * The purpose charset is deliberately strict ([a-z0-9_-]+) so documentation
 * mentions of the token *syntax* (e.g. `{{ARCHITECTURE_ANCHOR:<purpose>}}` in
 * README prose) never register as real unmapped tokens. Tokens inside code
 * blocks are example markup and are skipped, matching the anchor extractors.
 */
function extractUnmappedTokens(content: string): Array<{ purpose: string; line: number }> {
  const tokens: Array<{ purpose: string; line: number }> = [];
  const lines = content.split('\n');
  const masked = buildCodeBlockMask(lines);
  const tokenRe = /\{\{ARCHITECTURE_ANCHOR:([a-z0-9_-]+)\}\}/g;

  for (let i = 0; i < lines.length; i++) {
    if (masked[i]) continue;
    let m: RegExpExecArray | null;
    tokenRe.lastIndex = 0;
    while ((m = tokenRe.exec(lines[i])) !== null) {
      tokens.push({ purpose: m[1], line: i + 1 });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Explicit declared anchors — for --list-anchors (mapping helper)
// ---------------------------------------------------------------------------

/**
 * Extract only the explicit <a id="..."></a> anchors (not heading slugs).
 * These are the intended Phase 3b mapping targets: the anchor-generation pass
 * inserts explicit tags, and the context-pack-loader slices on them.
 */
export function extractExplicitAnchors(markdown: string): string[] {
  const anchors: string[] = [];
  const lines = markdown.split('\n');
  const masked = buildCodeBlockMask(lines);
  const aIdRe = /<a\s+id="([^"]+)"\s*(?:\/>|><\/a>|>.*?<\/a>)/g;
  for (let i = 0; i < lines.length; i++) {
    if (masked[i]) continue;
    let m: RegExpExecArray | null;
    aIdRe.lastIndex = 0;
    while ((m = aIdRe.exec(lines[i])) !== null) {
      anchors.push(m[1]);
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Pure exported function
// ---------------------------------------------------------------------------

export function auditContextPacks(input: AuditContextPacksInput): AuditContextPacksResult {
  if (input.packs.length === 0) {
    return { kind: 'ok' };
  }

  const declared = extractDeclaredAnchors(input.architectureMarkdown);
  const missing: PackAnchorMiss[] = [];
  const unmapped: PackUnmappedToken[] = [];

  for (const pack of input.packs) {
    const refs = extractPackAnchors(pack.content);
    for (const ref of refs) {
      if (!declared.has(ref.anchor)) {
        missing.push({ pack: pack.path, anchor: ref.anchor, line: ref.line });
      }
    }
    for (const token of extractUnmappedTokens(pack.content)) {
      unmapped.push({ pack: pack.path, purpose: token.purpose, line: token.line });
    }
  }

  if (missing.length === 0) {
    return unmapped.length === 0 ? { kind: 'ok' } : { kind: 'ok', unmapped };
  }
  return unmapped.length === 0 ? { kind: 'fail', missing } : { kind: 'fail', missing, unmapped };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — guarded so import has no side effects
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ARCH_PATH = join(PROJECT_DIR, 'architecture.md');
  const argFlags = process.argv.slice(2);
  const STRICT_UNMAPPED = argFlags.includes('--strict-unmapped');
  const LIST_ANCHORS = argFlags.includes('--list-anchors');

  (async () => {
    try {
      // --list-anchors: mapping helper for ADAPT.md Phase 3b. Prints the
      // explicit anchors declared in architecture.md and exits.
      if (LIST_ANCHORS) {
        if (!existsSync(ARCH_PATH)) {
          process.stderr.write(`audit-context-packs: architecture.md not found at ${ARCH_PATH}\n`);
          process.exit(1);
        }
        for (const anchor of extractExplicitAnchors(readFileSync(ARCH_PATH, 'utf8'))) {
          process.stdout.write(`${anchor}\n`);
        }
        process.exit(0);
      }
      // Read pack files from docs/context-packs/. If the directory is absent
      // OR contains no *.md files, there is nothing to validate — short-circuit
      // to exit 0 to match the pure helper's "empty packs returns ok" contract.
      // This must run BEFORE the architecture.md existence check: a consumer
      // with no context packs and no architecture.md should not have
      // finalisation falsely blocked by this advisory check.
      const packPaths: string[] = [];
      const packsDir = join(PROJECT_DIR, 'docs', 'context-packs');
      if (existsSync(packsDir)) {
        for (const f of readdirSync(packsDir)) {
          if (f.endsWith('.md')) packPaths.push(join(packsDir, f));
        }
      }

      if (packPaths.length === 0) {
        process.stdout.write('OK\n');
        process.exit(0);
      }

      // Read architecture.md — only required when there are packs to validate.
      if (!existsSync(ARCH_PATH)) {
        process.stderr.write(`audit-context-packs: architecture.md not found at ${ARCH_PATH}\n`);
        process.exit(1);
      }
      const architectureMarkdown = readFileSync(ARCH_PATH, 'utf8');

      const packs = packPaths.map((p) => ({
        path: basename(p),
        content: readFileSync(p, 'utf8'),
      }));

      const result = auditContextPacks({ packs, architectureMarkdown });
      const unmapped = result.unmapped ?? [];

      // Unmapped placeholder tokens: always reported, advisory by default.
      // They mean "packs installed but not adopted" — every pack consumer
      // falls back to whole-file reads in that state, so nothing is broken;
      // the repo is just not yet getting the token savings.
      for (const token of unmapped) {
        process.stdout.write(
          `UNMAPPED ${token.pack}:${token.line} {{ARCHITECTURE_ANCHOR:${token.purpose}}}\n`
        );
      }
      if (unmapped.length > 0) {
        process.stdout.write(
          `NOTE: ${unmapped.length} unmapped anchor placeholder(s) — context packs are installed but not adopted. ` +
            `Map each purpose to a real anchor via .claude/.framework-state.json substitutions ` +
            `(ADAPT.md Phase 3b; run with --list-anchors to see available anchors), then rebaseline with ` +
            `\`node .claude-framework/sync.js --adopt\`.\n`
        );
      }

      if (result.kind === 'ok') {
        if (unmapped.length > 0 && STRICT_UNMAPPED) {
          process.exit(1);
        }
        process.stdout.write(
          unmapped.length === 0
            ? 'OK\n'
            : `OK — no broken anchor references (adoption incomplete: ${unmapped.length} unmapped placeholder(s))\n`
        );
        process.exit(0);
      } else {
        for (const miss of result.missing) {
          process.stdout.write(`${miss.pack}:${miss.line} ${miss.anchor}\n`);
        }
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`audit-context-packs: unexpected error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();
}
