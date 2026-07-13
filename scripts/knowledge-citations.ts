#!/usr/bin/env tsx
/**
 * knowledge-citations.ts
 *
 * Advisory KNOWLEDGE.md maintenance tool, consumed by /cleanfiles. Run from a
 * consumer repo root, it:
 *   (a) counts how many times each KNOWLEDGE entry's title is referenced across
 *       tasks/**\/*.md and docs/**\/*.md — feeding the "promote at 3+ citations"
 *       valve; and
 *   (b) flags entries whose body references file paths that no longer exist.
 * It prints a markdown report to stdout and NEVER exits non-zero on findings —
 * only on a hard error (KNOWLEDGE.md missing/unreadable).
 *
 * The pure counting/staleness/render core lives in knowledge-citationsPure.ts
 * and is vitest-tested. This module owns file discovery, reads, existence
 * checks, and exit codes.
 *
 * Usage:
 *   npx tsx scripts/knowledge-citations.ts   # print the report to stdout
 *
 * Exit 0 — report printed (findings are not failures).
 * Exit 1 — KNOWLEDGE.md not found at the repo root, or an unexpected error.
 *
 * Also importable as a pure module (no side effects on import).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  countCitations,
  findStaleEntries,
  renderReport,
  parseKnowledgeEntries,
  type DocFile,
} from './knowledge-citationsPure.js';

const SCAN_DIRS = ['tasks', 'docs'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude-framework']);

/** Collect every *.md file under `dir` (recursive), returned as repo-relative paths. */
function collectMarkdown(repoDir: string, dir: string, out: string[]): string[] {
  const abs = join(repoDir, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMarkdown(repoDir, join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name).split(sep).join('/'));
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  try {
    const knowledgePath = join(REPO_DIR, 'KNOWLEDGE.md');
    if (!existsSync(knowledgePath)) {
      process.stderr.write(
        `knowledge-citations: KNOWLEDGE.md not found at ${knowledgePath}\n` +
          `  Run this from a consumer repo root that owns a KNOWLEDGE.md.\n`,
      );
      process.exit(1);
    }

    const entries = parseKnowledgeEntries(readFileSync(knowledgePath, 'utf8'));

    const docPaths: string[] = [];
    for (const d of SCAN_DIRS) collectMarkdown(REPO_DIR, d, docPaths);
    const docs: DocFile[] = docPaths.map((p) => ({
      path: p,
      text: readFileSync(join(REPO_DIR, p.split('/').join(sep)), 'utf8'),
    }));

    const citations = countCitations(entries, docs);

    // Existence predicate: repo-root-relative, forward-slashed paths. A cached
    // set of already-resolved answers keeps repeated paths cheap and stable.
    const existsCache = new Map<string, boolean>();
    const pathExists = (p: string): boolean => {
      const cached = existsCache.get(p);
      if (cached !== undefined) return cached;
      let ok = false;
      try {
        ok = existsSync(join(REPO_DIR, p.split('/').join(sep)));
      } catch {
        ok = false;
      }
      existsCache.set(p, ok);
      return ok;
    };
    const stale = findStaleEntries(entries, pathExists);

    const report = renderReport({
      timestamp: new Date().toISOString(),
      scannedDocCount: docs.length,
      entryCount: entries.length,
      citations,
      stale,
    });
    process.stdout.write(report);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`knowledge-citations: unexpected error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
