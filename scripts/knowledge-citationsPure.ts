/**
 * knowledge-citationsPure.ts
 *
 * Pure (I/O-free) core for the knowledge-citations advisory tool. Citation
 * counting and staleness detection live here so they are deterministic and
 * unit-testable. The I/O module (`knowledge-citations.ts`) owns file reads,
 * repo walking, filesystem existence checks, and stdout.
 *
 * (a) Citations — for each KNOWLEDGE entry, how many times its heading title is
 *     referenced across the supplied docs (feeds the "promote at 3+ citations"
 *     valve). "title/anchor" is matched on the heading title text, which is the
 *     source GitHub derives an anchor from; a case-insensitive substring match
 *     counts each non-overlapping occurrence.
 * (b) Staleness — flags entries whose body references file paths that no longer
 *     exist in the repo, via an injected `exists` predicate (kept out of the
 *     pure core so the caller owns all filesystem access).
 *
 * Advisory only: this module never signals failure on findings — it just
 * reports. The CLI exits non-zero only on hard I/O errors.
 */

import { extractEntries, extractBodyPaths, type KnowledgeEntry } from './generate-knowledge-indexPure.js';

// ── types ─────────────────────────────────────────────────────────────────────

export interface DocFile {
  path: string;
  text: string;
}

export interface CitationResult {
  entry: KnowledgeEntry;
  /** Total non-overlapping title occurrences across all docs. */
  count: number;
  /** Distinct doc paths that reference the entry, in scan order. */
  citingFiles: string[];
}

export interface StaleResult {
  entry: KnowledgeEntry;
  /** Body-referenced paths that failed the `exists` predicate. */
  missing: string[];
}

// ── citation counting ───────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of `needle` in `haystack` (both pre-lowered). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Count how many times each entry's title is referenced across `docs`. Returns
 * only entries with count ≥ 1, sorted by count descending then entry line
 * ascending (stable, deterministic).
 */
export function countCitations(entries: KnowledgeEntry[], docs: DocFile[]): CitationResult[] {
  const loweredDocs = docs.map((d) => ({ path: d.path, text: d.text.toLowerCase() }));
  const results: CitationResult[] = [];

  for (const entry of entries) {
    const needle = entry.title.toLowerCase().trim();
    if (needle === '') continue;
    let count = 0;
    const citingFiles: string[] = [];
    for (const doc of loweredDocs) {
      const n = countOccurrences(doc.text, needle);
      if (n > 0) {
        count += n;
        citingFiles.push(doc.path);
      }
    }
    if (count > 0) results.push({ entry, count, citingFiles });
  }

  results.sort((a, b) => (b.count - a.count) || (a.entry.line - b.entry.line));
  return results;
}

// ── staleness detection ─────────────────────────────────────────────────────────

/**
 * Flag entries whose body references file paths that fail the `exists`
 * predicate. `exists` receives each extracted path verbatim (repo-root-relative,
 * forward-slashed). Returns entries in original line order, each with its list
 * of missing paths. Entries with no missing paths are omitted.
 */
export function findStaleEntries(
  entries: KnowledgeEntry[],
  exists: (path: string) => boolean,
): StaleResult[] {
  const results: StaleResult[] = [];
  for (const entry of entries) {
    const missing = extractBodyPaths(entry.body).filter((p) => !exists(p));
    if (missing.length > 0) results.push({ entry, missing });
  }
  return results;
}

// ── rendering ───────────────────────────────────────────────────────────────────

/** Render the advisory markdown report. */
export function renderReport(opts: {
  timestamp: string;
  scannedDocCount: number;
  entryCount: number;
  citations: CitationResult[];
  stale: StaleResult[];
}): string {
  const { timestamp, scannedDocCount, entryCount, citations, stale } = opts;
  const out: string[] = [];

  out.push(`# Knowledge citation & staleness report — generated ${timestamp}`);
  out.push(`# entries scanned: ${entryCount}; docs scanned: ${scannedDocCount} (tasks/**/*.md + docs/**/*.md)`);
  out.push('');

  out.push('## Citation counts (entries referenced at least once)');
  out.push('');
  if (citations.length === 0) {
    out.push('_No KNOWLEDGE entries are referenced in the scanned docs._');
  } else {
    const promotable = citations.filter((c) => c.count >= 3).length;
    out.push(`${citations.length} entr${citations.length === 1 ? 'y' : 'ies'} cited; ${promotable} at the 3+ promotion threshold.`);
    out.push('');
    for (const c of citations) {
      const flag = c.count >= 3 ? ' [PROMOTE?]' : '';
      out.push(`- ${c.count}x  [${c.entry.date}] ${c.entry.title}${flag}`);
    }
  }
  out.push('');

  out.push('## Stale entries (body references a path that no longer exists)');
  out.push('');
  if (stale.length === 0) {
    out.push('_No stale path references found._');
  } else {
    for (const s of stale) {
      out.push(`- [${s.entry.date}] ${s.entry.title}  (KNOWLEDGE.md:${s.entry.line})`);
      out.push(`    missing: ${s.missing.join(', ')}`);
    }
  }
  out.push('');

  return out.join('\n');
}

/** Convenience: parse KNOWLEDGE text into entries (re-exported for the CLI). */
export function parseKnowledgeEntries(text: string): KnowledgeEntry[] {
  return extractEntries(text);
}
