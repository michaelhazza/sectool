// ---------------------------------------------------------------------------
// architecture.md ranked section retrieval — pure parse + lexical ranking.
//
// architecture.md is ~6,300 lines / ~246K tokens; a full read is the biggest
// single per-session token pool. It already carries 80 `<a id="...">` anchors
// over 78 `## ` sections. This module slices the file into those sections and
// ranks them against a query with an offline lexical scorer (no embeddings, no
// API, no network) — deterministic and dependency-free, so agents can Read only
// the matching sections instead of the whole file. Mirrors the proven
// knowledge-search pattern (scripts/lib/knowledgeSearchPure.ts).
//
// No fs/process of its own; the CLI (scripts/architecture-search.ts) does I/O.
// Reuses buildCodeBlockMask from audit-context-packs (which transitively imports
// node:fs but is side-effect-free — its CLI is import.meta.url-guarded).
// ---------------------------------------------------------------------------

import { buildCodeBlockMask } from '../audit-context-packs.js';

export interface ArchSection {
  anchor: string;
  title: string;
  /** 1-indexed line of the FIRST anchor of the section's anchor stack. */
  startLine: number;
  /** 1-indexed last line of the section (the line before the next section, or EOF). */
  endLine: number;
  /** Section content after the `## ` heading, through endLine. */
  body: string;
}

export interface RankedSection extends ArchSection {
  score: number;
}

// Same stopword set as knowledge-search; trimming these sharpens scoring.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'with', 'as', 'by', 'from', 'into', 'if', 'then', 'else',
  'when', 'not', 'no', 'do', 'does', 'did', 'so', 'we', 'you', 'i', 'they',
  'he', 'she', 'them', 'his', 'her', 'our', 'your', 'their', 'will', 'can',
  'use', 'used', 'via', 'per', 'run', 'runs',
]);

/** Lowercase word tokens >= 3 chars, minus stopwords (mirrors knowledge-search). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const ANCHOR_RE = /^\s*<a id="([^"]+)"><\/a>\s*$/;

function anchorId(line: string): string | null {
  const m = line.match(ANCHOR_RE);
  return m ? m[1] : null;
}

/**
 * Parse architecture.md into its `## ` sections.
 *
 * Section rule (the anchors are NOT all section starts): a section starts at an
 * anchor line whose next non-anchor, non-fence-masked line is a `## ` heading.
 * Consecutive anchor lines are aliases: the section's `anchor` is the one
 * adjacent to the heading (last in the stack), its `startLine` is the FIRST
 * anchor of the stack. A section runs to the line before the next
 * SECTION-STARTING anchor (or EOF). Anchors that do not start a section stay
 * inside the enclosing body and do NOT terminate it. Fenced regions are ignored
 * when locating anchors and headings (shell comments and fake anchors live in
 * code blocks).
 */
export function parseArchitectureSections(md: string): ArchSection[] {
  const lines = md.split('\n');
  const mask = buildCodeBlockMask(lines);
  const n = lines.length;

  const isAnchor = (i: number): boolean => i < n && !mask[i] && ANCHOR_RE.test(lines[i]);

  // Pass 1: collect section starts as { startIdx, anchorIdx, headingIdx } (0-indexed).
  const starts: Array<{ startIdx: number; anchorIdx: number; headingIdx: number }> = [];
  let i = 0;
  while (i < n) {
    if (isAnchor(i)) {
      // Extend the consecutive anchor stack.
      let j = i;
      while (j + 1 < n && isAnchor(j + 1)) j++;
      // Find the next non-anchor, non-masked line after the stack.
      let k = j + 1;
      while (k < n && (isAnchor(k) || mask[k])) k++;
      if (k < n && lines[k].startsWith('## ')) {
        starts.push({ startIdx: i, anchorIdx: j, headingIdx: k });
      }
      // Advance past the stack; if it started a section, past the heading too.
      i = k < n && lines[k].startsWith('## ') ? k + 1 : j + 1;
    } else {
      i++;
    }
  }

  // Pass 2: build sections; endLine is the line before the next section start, or EOF.
  return starts.map((s, idx) => {
    const endIdx = idx + 1 < starts.length ? starts[idx + 1].startIdx - 1 : n - 1;
    const bodyLines = lines.slice(s.headingIdx + 1, endIdx + 1);
    return {
      anchor: anchorId(lines[s.anchorIdx]) as string,
      title: lines[s.headingIdx].replace(/^##\s+/, '').trim(),
      startLine: s.startIdx + 1,
      endLine: endIdx + 1,
      body: bodyLines.join('\n'),
    };
  });
}

/**
 * Rank sections against a query. Scoring (pinned): per unique query token,
 * +5 if it appears in the title, +4 if it appears in the anchor, +1 per
 * occurrence in the body capped at 5. Sort score desc, then startLine asc;
 * drop zero scores; slice to `limit`.
 */
export function rankSections(sections: ArchSection[], query: string, limit = 5): RankedSection[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0 || sections.length === 0) return [];

  const scored: RankedSection[] = sections.map((section) => {
    const titleTokens = new Set(tokenize(section.title));
    const anchorTokens = new Set(tokenize(section.anchor));
    const bodyCounts = new Map<string, number>();
    for (const t of tokenize(section.body)) {
      bodyCounts.set(t, (bodyCounts.get(t) ?? 0) + 1);
    }

    let score = 0;
    for (const token of queryTokens) {
      if (titleTokens.has(token)) score += 5;
      if (anchorTokens.has(token)) score += 4;
      score += Math.min(bodyCounts.get(token) ?? 0, 5);
    }
    return { ...section, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.startLine - b.startLine))
    .slice(0, limit);
}
