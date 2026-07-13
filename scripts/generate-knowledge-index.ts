#!/usr/bin/env tsx
/**
 * generate-knowledge-index.ts
 *
 * Builds a greppable index of a consuming repo's knowledge base. Run from the
 * consumer repo root, it reads KNOWLEDGE.md plus every KNOWLEDGE-archive-*.md at
 * the repo root and emits references/knowledge-index.md in the pinned format
 * (see generate-knowledge-indexPure.ts). Each dated `### [date] title` entry
 * becomes one line: `<file>:<line> | <date> | <title> | <keywords>`.
 *
 * The pure extraction/keyword/render core lives in generate-knowledge-indexPure.ts
 * and is vitest-tested. This module owns file discovery, reads/writes, and exit
 * codes.
 *
 * Usage:
 *   npx tsx scripts/generate-knowledge-index.ts            # write references/knowledge-index.md
 *   npx tsx scripts/generate-knowledge-index.ts --dry-run  # print stats, write nothing
 *
 * Exit 0 — index written (or dry-run printed).
 * Exit 1 — KNOWLEDGE.md not found at the repo root, or an unexpected error.
 *
 * Also importable as a pure module (no side effects on import).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex, type SourceDoc } from './generate-knowledge-indexPure.js';

const ARCHIVE_RE = /^KNOWLEDGE-archive-.*\.md$/;

/** Discover the ordered source files: KNOWLEDGE.md first, then archives ascending. */
export function discoverSources(repoDir: string): { knowledgePath: string; archivePaths: string[] } {
  const knowledgePath = join(repoDir, 'KNOWLEDGE.md');
  const archivePaths = readdirSync(repoDir)
    .filter((f) => ARCHIVE_RE.test(f))
    .sort()
    .map((f) => join(repoDir, f));
  return { knowledgePath, archivePaths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const DRY_RUN = process.argv.slice(2).includes('--dry-run');

  try {
    const { knowledgePath, archivePaths } = discoverSources(REPO_DIR);

    if (!existsSync(knowledgePath)) {
      process.stderr.write(
        `generate-knowledge-index: KNOWLEDGE.md not found at ${knowledgePath}\n` +
          `  Run this from a consumer repo root that owns a KNOWLEDGE.md.\n`,
      );
      process.exit(1);
    }

    const sources: SourceDoc[] = [
      { file: 'KNOWLEDGE.md', text: readFileSync(knowledgePath, 'utf8') },
      ...archivePaths.map((p) => ({
        file: p.slice(REPO_DIR.length + 1).split('\\').join('/'),
        text: readFileSync(p, 'utf8'),
      })),
    ];

    const index = buildIndex(sources, new Date().toISOString());

    const outDir = join(REPO_DIR, 'references');
    const outPath = join(outDir, 'knowledge-index.md');

    const statLine = index.stats
      .map((s) => `${s.file}: ${s.entryCount} entries (${s.lineCount} lines)`)
      .join('; ');
    const totalEntries = index.rows.length;
    const indexLineCount = index.output.split('\n').filter((l) => l !== '').length;

    if (DRY_RUN) {
      process.stdout.write(
        `generate-knowledge-index [dry-run]: ${totalEntries} entries across ${index.stats.length} source(s)\n` +
          `  ${statLine}\n` +
          `  index would be ${indexLineCount} non-blank lines\n`,
      );
      process.exit(0);
    }

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    // Atomic write: tmp + rename.
    const tmpPath = `${outPath}.tmp`;
    writeFileSync(tmpPath, index.output, 'utf8');
    renameSync(tmpPath, outPath);

    process.stdout.write(
      `generate-knowledge-index: wrote references/knowledge-index.md — ${totalEntries} entries, ${indexLineCount} lines\n` +
        `  ${statLine}\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`generate-knowledge-index: unexpected error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
