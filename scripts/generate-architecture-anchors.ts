/**
 * generate-architecture-anchors.ts
 *
 * Idempotent anchor-generation pass for a consuming repo's architecture.md
 * (ADAPT.md Phase 3b step 1, automated during /claudeupdate step 6c2 as of
 * v2.36.0): inserts `<a id="<kebab-case-slug>"></a>` immediately before every
 * `## ` heading that does not already have an explicit anchor on the line
 * above it. Headings inside code blocks are example markup and are skipped.
 *
 * Slugs use the same GFM algorithm as audit-context-packs.ts (shared import),
 * so generated anchors are exactly what the audit validates and the
 * context-pack-loader slices on. Slug collisions (duplicate headings, or a
 * heading whose slug matches an existing explicit anchor) get `-1`, `-2`, …
 * suffixes.
 *
 * Run via: npx tsx scripts/generate-architecture-anchors.ts [--dry-run]
 *
 * Exit 0 — architecture.md updated in place (or already fully anchored).
 *          Prints `added <N> anchors (<M> level-2 headings already anchored)`.
 *          With --dry-run, prints the same summary and writes nothing.
 * Exit 1 — architecture.md not found, or unexpected error.
 *
 * Also importable as a pure module (no side effects on import).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gfmSlug, buildCodeBlockMask } from './audit-context-packs.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateAnchorsResult {
  content: string;
  added: number;
  alreadyAnchored: number;
}

// ---------------------------------------------------------------------------
// Pure exported function
// ---------------------------------------------------------------------------

const A_ID_RE = /<a\s+id="([^"]+)"\s*(?:\/>|><\/a>|>.*?<\/a>)/g;

/** Strip inline code and markdown links from heading text before slugging —
 * mirrors extractDeclaredAnchors in audit-context-packs.ts so generated ids
 * match what the audit derives for the same heading. */
function headingTextForSlug(raw: string): string {
  return raw
    .replace(/`[^`]*`/g, (s) => s.slice(1, -1))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

export function generateArchitectureAnchors(markdown: string): GenerateAnchorsResult {
  const lines = markdown.split('\n');
  const masked = buildCodeBlockMask(lines);

  // Seed the used-slug set with every existing explicit anchor (outside code
  // blocks) so new anchors never collide with ones already declared.
  const used = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (masked[i]) continue;
    let m: RegExpExecArray | null;
    A_ID_RE.lastIndex = 0;
    while ((m = A_ID_RE.exec(lines[i])) !== null) {
      used.add(m[1]);
    }
  }

  const out: string[] = [];
  let added = 0;
  let alreadyAnchored = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLevel2Heading = !masked[i] && /^##\s+\S/.test(line) && !/^###/.test(line);

    if (isLevel2Heading) {
      // Idempotency: an explicit anchor on the immediately-preceding line
      // (in the ORIGINAL document) means this heading is already anchored.
      const prev = i > 0 ? lines[i - 1] : '';
      A_ID_RE.lastIndex = 0;
      if (i > 0 && !masked[i - 1] && A_ID_RE.test(prev)) {
        alreadyAnchored++;
      } else {
        const base = gfmSlug(headingTextForSlug(line.replace(/^##\s+/, '')));
        if (base) {
          let candidate = base;
          let n = 0;
          while (used.has(candidate)) {
            n += 1;
            candidate = `${base}-${n}`;
          }
          used.add(candidate);
          out.push(`<a id="${candidate}"></a>`);
          added++;
        }
      }
    }
    out.push(line);
  }

  return { content: out.join('\n'), added, alreadyAnchored };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — guarded so import has no side effects
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ARCH_PATH = join(PROJECT_DIR, 'architecture.md');
  const DRY_RUN = process.argv.slice(2).includes('--dry-run');

  try {
    if (!existsSync(ARCH_PATH)) {
      process.stderr.write(`generate-architecture-anchors: architecture.md not found at ${ARCH_PATH}\n`);
      process.exit(1);
    }
    const result = generateArchitectureAnchors(readFileSync(ARCH_PATH, 'utf8'));
    if (result.added > 0 && !DRY_RUN) {
      // Atomic write: tmp + rename, matching sync.js's write discipline.
      const tmpPath = `${ARCH_PATH}.anchors-tmp`;
      writeFileSync(tmpPath, result.content, 'utf8');
      renameSync(tmpPath, ARCH_PATH);
    }
    process.stdout.write(
      `added ${result.added} anchors (${result.alreadyAnchored} level-2 headings already anchored)` +
        (DRY_RUN ? ' [dry-run — nothing written]' : '') +
        '\n'
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `generate-architecture-anchors: unexpected error: ${(err as Error).message}\n`
    );
    process.exit(1);
  }
}
