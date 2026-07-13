/**
 * generate-knowledge-indexPure.ts
 *
 * Pure (I/O-free) core for the knowledge-index generator. Entry extraction,
 * keyword derivation, and the fixed-format renderer live here so they are
 * deterministic and unit-testable without touching the filesystem. The I/O
 * module (`generate-knowledge-index.ts`) owns file reads/writes, archive
 * discovery, and process exit codes.
 *
 * The output format is a PINNED contract — a downstream consumer parses it.
 * Header lines:
 *   # Knowledge index — generated <ISO timestamp>
 *   # sources: <file> (<line-count> lines)[, ...]
 * Then one line per entry:
 *   <file>:<line> | <YYYY-MM-DD> | <entry title> | <keywords>
 * where <line> is the 1-based line of the entry heading and <keywords> is a
 * comma-separated, deterministic list (title tokens, then body file paths kept
 * verbatim, then domain terms).
 *
 * Ordering is stable: sources in the order supplied, entries in line order.
 */

// ── types ─────────────────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  /** 1-based line number of the `### [date] title` heading. */
  line: number;
  /** YYYY-MM-DD from the heading bracket. */
  date: string;
  /** Heading text after the `[date]` bracket, trimmed. */
  title: string;
  /** Raw body text between this heading and the next `##`/`###` heading (or EOF). */
  body: string;
}

export interface SourceDoc {
  file: string;
  text: string;
}

export interface IndexRow {
  file: string;
  line: number;
  date: string;
  title: string;
  keywords: string[];
}

export interface SourceStat {
  file: string;
  lineCount: number;
  entryCount: number;
}

export interface KnowledgeIndex {
  rows: IndexRow[];
  stats: SourceStat[];
  output: string;
}

// ── entry extraction ───────────────────────────────────────────────────────────

// Entry heading: `### [YYYY-MM-DD] <title>`. The literal template placeholder
// `### [YYYY-MM-DD] ...` at the top of KNOWLEDGE.md fails the digit match and is
// correctly skipped. Any `##`/`###` heading bounds the previous entry's body.
const ENTRY_RE = /^###\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;
const HEADING_RE = /^#{2,3}\s/;

/**
 * Extract every dated `### [date] title` entry from a KNOWLEDGE-style document.
 * Line numbers are 1-based. The body runs from the line after the heading up to
 * (but not including) the next `##`/`###` heading or end of file.
 */
export function extractEntries(text: string): KnowledgeEntry[] {
  // Split on CRLF or LF: archives written on Windows carry CRLF, and a trailing
  // \r left on each line would break the anchored `(.*)$` heading match (`.` and
  // `$` exclude \r without the `m` flag) — silently yielding zero entries.
  const lines = text.split(/\r?\n/);
  const entries: KnowledgeEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const date = m[1];
    const title = m[2].trim();
    // Body: subsequent lines until the next heading (level 2 or 3) or EOF.
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (HEADING_RE.test(lines[j])) break;
      bodyLines.push(lines[j]);
    }
    entries.push({ line: i + 1, date, title, body: bodyLines.join('\n').trim() });
  }
  return entries;
}

// ── path extraction (shared with the citations tool) ────────────────────────────

// A path is one or more `segment/` parts followed by a final segment carrying a
// file extension, optionally trailed by a `:line` or `:line-line` locator. The
// extension requirement keeps directory-ish slashes (`read/aggregate`,
// `org/subaccount`) and prose out of the match. The locator is stripped so the
// captured value is a clean, existence-checkable file path.
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]*/g;

/**
 * Extract distinct file paths referenced in an entry body, in first-seen order.
 * Paths are kept verbatim (no case-folding). Trailing `:line` locators and
 * common trailing punctuation are stripped.
 */
export function extractBodyPaths(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(body)) !== null) {
    let p = m[0];
    // Strip a trailing period that is sentence punctuation, not part of the path
    // (a real extension was already required, so a lone trailing dot is prose).
    p = p.replace(/\.$/, '');
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// ── keyword derivation ──────────────────────────────────────────────────────────

// Common words carry no retrieval signal — drop them from title tokens.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'not', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by',
  'from', 'into', 'over', 'per', 'via', 'that', 'this', 'these', 'those', 'it',
  'its', 'than', 'then', 'when', 'while', 'which', 'who', 'whose', 'only', 'also',
  'still', 'every', 'each', 'no', 'none', 'new', 'use', 'used', 'using', 'must',
  'can', 'may', 'will', 'now', 'not', 'do', 'does', 'did', 'has', 'have', 'had',
  'if', 'else', 'so', 'up', 'out', 'off', 'own', 'all', 'any', 'both', 'more',
  'most', 'some', 'such', 'their', 'them', 'they', 'you', 'your', 'we', 'our',
]);

// Curated domain vocabulary. A term is emitted when it appears as a whole word
// (case-insensitive) anywhere in the entry's title or body. Order here is the
// emit order — deterministic across runs.
const DOMAIN_TERMS = [
  'tenant', 'rls', 'subaccount', 'organisation', 'org', 'multi-tenant',
  'webhook', 'migration', 'schema', 'postgres', 'sql', 'index',
  'permission', 'auth', 'oauth', 'token', 'security',
  'review', 'gate', 'ci', 'lint', 'typecheck', 'test', 'fixture', 'baseline',
  'idempotency', 'idempotent', 'race', 'concurrency', 'lock', 'cache', 'queue',
  'worker', 'cron', 'job',
  'skill', 'agent', 'hook', 'prompt', 'eval', 'coordinator', 'builder',
  'spec', 'plan', 'finalisation', 'mockup',
  'seed', 'deploy', 'fly', 'replit',
  'client', 'server', 'shared', 'react', 'route', 'service',
  'knowledge', 'citation', 'staleness', 'retrieval', 'digest',
];

function titleTokens(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Keep dots/hyphens/slashes so filename-ish tokens survive; split on the rest.
  for (const raw of title.toLowerCase().split(/[^a-z0-9./_-]+/)) {
    const tok = raw.replace(/^[.\-_/]+|[.\-_/]+$/g, '');
    if (tok.length < 3) continue;
    if (/^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function domainTerms(title: string, body: string): string[] {
  const hay = `${title}\n${body}`.toLowerCase();
  const out: string[] = [];
  for (const term of DOMAIN_TERMS) {
    // Whole-word match; escape hyphens are literal in a char-class-free pattern.
    const re = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`);
    if (re.test(hay)) out.push(term);
  }
  return out;
}

/**
 * Build the deterministic keyword list for one entry: distinctive title tokens,
 * then file paths from the body (verbatim), then curated domain terms. Deduped
 * preserving first occurrence across the three groups.
 */
export function buildKeywords(title: string, body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const t of titleTokens(title)) push(t);
  for (const p of extractBodyPaths(body)) push(p);
  for (const d of domainTerms(title, body)) push(d);
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────────

/**
 * Render the pinned index format for the supplied sources. `timestamp` is the
 * ISO generation time (injected so the renderer stays deterministic/testable).
 * Line counts count newline-separated lines of each source's text.
 */
export function buildIndex(sources: SourceDoc[], timestamp: string): KnowledgeIndex {
  const rows: IndexRow[] = [];
  const stats: SourceStat[] = [];

  for (const src of sources) {
    const entries = extractEntries(src.text);
    const lineCount = src.text.split('\n').length;
    stats.push({ file: src.file, lineCount, entryCount: entries.length });
    for (const e of entries) {
      rows.push({
        file: src.file,
        line: e.line,
        date: e.date,
        title: e.title,
        keywords: buildKeywords(e.title, e.body),
      });
    }
  }

  const header = [
    `# Knowledge index — generated ${timestamp}`,
    `# sources: ${stats.map((s) => `${s.file} (${s.lineCount} lines)`).join(', ')}`,
  ];
  const body = rows.map(
    (r) => `${r.file}:${r.line} | ${r.date} | ${r.title} | ${r.keywords.join(',')}`,
  );
  const output = [...header, ...body].join('\n') + '\n';

  return { rows, stats, output };
}
