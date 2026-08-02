#!/usr/bin/env node
/**
 * SessionStart hook: memory-digest
 *
 * Emits a compact, plain-text digest of the repo's "working memory" so a
 * fresh session starts with recent context already in view: the current
 * focus, the most recent lessons, the most recent KNOWLEDGE.md entries, and
 * — when a consumer ships references/knowledge-index.md — a handful of OLDER
 * KNOWLEDGE.md entries whose keywords match the session's current-focus domain
 * (index-matched resurfacing), lifting coverage past the newest-N recency window.
 *
 * The digest is BOUNDED and ADVISORY, never authoritative — a hard 150-line
 * global cap plus per-source sub-budgets keep it small, and every read is
 * byte-bounded so the hook stays fast on the always-on SessionStart path even
 * when a consumer's KNOWLEDGE.md is 400KB+ (tail-read only).
 *
 * Index-matched resurfacing is strictly additive and fail-open: no index file,
 * an empty focus, no keyword match, a malformed index, or ANY error in the new
 * path → the digest emits exactly as it did before (recency-only). It is the
 * lowest-priority block, trimmed first under the global cap.
 *
 * Load-bearing ordering asymmetry:
 *   - KNOWLEDGE.md is append-only NEWEST-LAST  → read the TAIL.
 *   - tasks/lessons.md is NEWEST-FIRST under `## Lessons`, with a static
 *     format template at the file tail → read the HEAD of that section and
 *     STOP at the template boundary.
 * Reversing either would ship boilerplate instead of real content.
 *
 * Fail-open + silence contract:
 *   - Expected-absent inputs (missing file / missing `tasks/` dir / missing
 *     `## Lessons` heading / empty file) produce NO output at all — no stdout,
 *     no stderr. A consumer without these files must see a clean, silent start.
 *   - Unexpected errors are swallowed; a one-line diagnostic goes to stderr
 *     ONLY when MEMORY_DIGEST_DEBUG === '1'. Never to stdout.
 *   - Top-level try/catch wraps the whole body; always exits 0.
 *   - No network, no spawn, no writes. Pure read + stdout.
 *
 * Budget: synchronous reads cannot be interrupted mid-call, so the elapsed-
 * time gate (SOFT_BUDGET_MS) is checked BEFORE each block — a pathological
 * slow filesystem skips the remaining blocks rather than stalling. A real
 * `timeout` in .claude/settings.json backstops the whole hook.
 *
 * Tests: .claude/hooks/memory-digest.test.js
 *   Run with: node .claude/hooks/memory-digest.test.js
 */

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEBUG = process.env.MEMORY_DIGEST_DEBUG === '1';

// Per-source read caps (bytes) — every read is byte-bounded on the always-on path.
const KNOWLEDGE_TAIL_BYTES = 32_768; // 32KB tail — KNOWLEDGE.md is append-only newest-last
const FOCUS_MAX_BYTES = 262_144; // 256KB head — current-focus can carry a large legacy comment block
const LESSONS_MAX_BYTES = 262_144; // 256KB head — small in practice; cap removes ambiguity

// Per-source line/entry sub-budgets.
const FOCUS_MAX_LINES = 40;
const LESSONS_MAX_ENTRIES = 5;
const LESSONS_MAX_LINES = 40;
const KNOWLEDGE_MAX_ENTRIES = 6;
const KNOWLEDGE_MAX_LINES = 55;

// Index-matched resurfacing (references/knowledge-index.md → current-focus domain).
const INDEX_MAX_BYTES = 262_144; // 256KB head — one compact line per index entry
const INDEX_MATCH_MAX_ENTRIES = 3; // bounded resurfacing budget beyond the newest-N window
const MATCHED_SOURCE_MAX_BYTES = 524_288; // 512KB head per source file — byte-bounded, cached per file
const MATCHED_ENTRY_MAX_LINES = 12; // per resurfaced entry
const MATCHED_MAX_LINES = 40; // whole matched block sub-budget
const TOKEN_MIN_LEN = 4; // drop short tokens when matching focus ↔ index keywords
const FOCUS_STOPWORDS = new Set([
  'tasks', 'task', 'build', 'builds', 'spec', 'specs', 'current', 'focus', 'status',
  'phase', 'branch', 'slug', 'main', 'review', 'ready', 'merge', 'todo', 'notes', 'none',
  'this', 'that', 'with', 'from', 'http', 'https', 'into', 'over', 'under', 'done',
  'building', 'reviewing', 'blocked', 'pending', 'active', 'session',
]);

// Global cap + soft time budget.
const TOTAL_MAX_LINES = 150;
const SOFT_BUDGET_MS = 100;

// ── bounded reads ───────────────────────────────────────────────────────────

/** Read up to maxBytes from the START of a file. Throws on absent/unreadable. */
function readHead(file, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    if (len === 0) return '';
    const buf = Buffer.allocUnsafe(len);
    // Decode only the bytes actually read — a short read must never let the
    // uninitialised tail of an allocUnsafe buffer reach stdout.
    const n = readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read up to maxBytes from the END of a file. Returns { text, truncated }
 * where truncated is true when the file was larger than maxBytes (so the
 * caller drops the first, possibly partial, line). Throws on absent/unreadable.
 */
function readTail(file, maxBytes) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len === 0) return { text: '', truncated: false };
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8', 0, n), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/** Strip leading `<!-- ... -->` HTML comment block(s) and surrounding blanks. */
function stripLeadingHtmlComments(s) {
  let str = s;
  for (;;) {
    const t = str.replace(/^\s+/, '');
    if (t.startsWith('<!--')) {
      const end = t.indexOf('-->');
      if (end === -1) return ''; // unterminated (truncated) comment — nothing usable follows
      str = t.slice(end + 3);
    } else {
      return t;
    }
  }
}

/**
 * A real dated lessons entry heading vs the format-template decoy at the file
 * tail. Assumes the documented lessons convention: entries are `### YYYY-MM-DD …`
 * (digit-first), while the trailing template/archive markers are non-digit
 * (`### [Date] …`, `### Archived …`). A consumer whose first real entry is not
 * digit-prefixed would yield an empty lessons block — acceptable (fail-quiet),
 * and the price of never emitting the boilerplate template to every session.
 */
function isDateLikeHeadingText(rest) {
  return /^\d/.test(rest.trim());
}

// ── block builders (each returns content lines, [] when nothing to show) ─────

function buildFocus(dir) {
  const raw = readHead(join(dir, 'tasks', 'current-focus.md'), FOCUS_MAX_BYTES);
  const body = stripLeadingHtmlComments(raw);
  const lines = trimBlankEdges(body.split('\n'));
  return lines.slice(0, FOCUS_MAX_LINES);
}

function buildLessons(dir) {
  const raw = readHead(join(dir, 'tasks', 'lessons.md'), LESSONS_MAX_BYTES);
  const lines = raw.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+Lessons\b/.test(l));
  if (headingIdx === -1) return []; // expected-absent — silent

  const out = [];
  let entries = 0;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // section change — stop
    if (/^###\s/.test(line)) {
      const rest = line.replace(/^###\s+/, '');
      if (!isDateLikeHeadingText(rest)) break; // archived/format-template boundary — stop
      entries++;
      if (entries > LESSONS_MAX_ENTRIES) break;
    }
    out.push(line);
    if (out.length >= LESSONS_MAX_LINES) break;
  }
  return trimBlankEdges(out);
}

function buildKnowledge(dir) {
  const { text, truncated } = readTail(join(dir, 'KNOWLEDGE.md'), KNOWLEDGE_TAIL_BYTES);
  let lines = text.split('\n');
  if (truncated && lines.length > 0) lines = lines.slice(1); // drop partial leading line

  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) headings.push(i);
  }
  if (headings.length === 0) return []; // no recognisable entries — silent

  const startIdx =
    headings.length > KNOWLEDGE_MAX_ENTRIES
      ? headings[headings.length - KNOWLEDGE_MAX_ENTRIES]
      : headings[0];

  let block = trimBlankEdges(lines.slice(startIdx));
  if (block.length > KNOWLEDGE_MAX_LINES) {
    block = block.slice(block.length - KNOWLEDGE_MAX_LINES); // keep the newest tail
    const h = block.findIndex((l) => /^#{2,3}\s/.test(l));
    if (h > 0) block = block.slice(h); // realign to a clean heading boundary
  }
  return block;
}

// ── index-matched resurfacing ────────────────────────────────────────────────

/** Lowercase, split on non-alphanumerics, drop short/numeric/stopword tokens. */
function tokenize(text, stopwords) {
  const set = new Set();
  for (const tok of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= TOKEN_MIN_LEN && !/^\d+$/.test(tok) && !stopwords.has(tok)) set.add(tok);
  }
  return set;
}

/**
 * Parse one index line: `<file>:<line> | <YYYY-MM-DD> | <title> | <keywords>`.
 * Returns null for malformed lines (fail-quiet — a bad row never breaks the run).
 */
function parseIndexLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 4) return null;
  const loc = parts[0].match(/^(.+):(\d+)$/);
  if (!loc) return null;
  const lineNo = parseInt(loc[2], 10);
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  const title = parts[2];
  // Match tokens come from BOTH the title and the comma-separated keyword field.
  const tokens = new Set([
    ...tokenize(title, FOCUS_STOPWORDS),
    ...tokenize(parts[3], FOCUS_STOPWORDS),
  ]);
  return { file: loc[1], lineNo, date: parts[1], title, tokens };
}

/** Entry text starting at lineNo (1-based), stopping at the next `##`/`###` heading. */
function sliceEntryAtLine(sourceLines, lineNo, maxLines) {
  const idx = lineNo - 1;
  if (idx < 0 || idx >= sourceLines.length) return []; // line beyond the read window — skip
  const out = [];
  for (let i = idx; i < sourceLines.length && out.length < maxLines; i++) {
    if (i > idx && /^#{2,3}\s/.test(sourceLines[i])) break;
    out.push(sourceLines[i]);
  }
  return trimBlankEdges(out);
}

/**
 * Resurface OLDER KNOWLEDGE.md entries matched to the current-focus domain.
 * Throws when references/knowledge-index.md is absent (→ safe() returns [],
 * silent, digest as today). knowledgeLines is the already-built recency block,
 * used to skip entries the digest is already showing.
 */
function buildIndexMatched(dir, knowledgeLines) {
  const indexRaw = readHead(join(dir, 'references', 'knowledge-index.md'), INDEX_MAX_BYTES);
  const entries = [];
  for (const raw of indexRaw.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue; // header/blank lines
    const parsed = parseIndexLine(line);
    if (parsed && parsed.tokens.size) entries.push(parsed);
  }
  if (entries.length === 0) return [];

  const focusRaw = readHead(join(dir, 'tasks', 'current-focus.md'), FOCUS_MAX_BYTES);
  const focusTokens = tokenize(focusRaw, FOCUS_STOPWORDS);
  if (focusTokens.size === 0) return []; // no domain to match against

  const knowledgeText = knowledgeLines.join('\n');
  const scored = [];
  for (const e of entries) {
    if (e.title && knowledgeText.includes(e.title)) continue; // already in the recency block
    let score = 0;
    for (const tok of e.tokens) if (focusTokens.has(tok)) score++;
    if (score > 0) scored.push({ e, score });
  }
  if (scored.length === 0) return [];
  // Best keyword overlap first; newer date breaks ties (dates are YYYY-MM-DD).
  scored.sort((a, b) => b.score - a.score || b.e.date.localeCompare(a.e.date));

  // One bounded read per source file, reused across every match in that file.
  const sourceCache = new Map();
  function sourceLines(file) {
    if (!sourceCache.has(file)) {
      let lines;
      try {
        lines = readHead(join(dir, file), MATCHED_SOURCE_MAX_BYTES).split('\n');
      } catch {
        lines = []; // unreadable source — skip its matches
      }
      sourceCache.set(file, lines);
    }
    return sourceCache.get(file);
  }

  const out = [];
  let used = 0;
  for (const { e } of scored) {
    if (used >= INDEX_MATCH_MAX_ENTRIES) break;
    const body = sliceEntryAtLine(sourceLines(e.file), e.lineNo, MATCHED_ENTRY_MAX_LINES);
    if (body.length === 0) continue;
    const chunk = [`[${e.file}:${e.lineNo}]`, ...body];
    if (out.length + chunk.length > MATCHED_MAX_LINES) break;
    out.push(...chunk);
    used++;
  }
  return out;
}

// ── assembly ────────────────────────────────────────────────────────────────

/** Run a block builder; on unexpected error, degrade to [] (stderr under DEBUG). */
function safe(fn, dir, label) {
  try {
    return fn(dir);
  } catch (err) {
    if (err && err.code !== 'ENOENT' && DEBUG) {
      process.stderr.write(`memory-digest: ${label} skipped: ${err.message}\n`);
    }
    return [];
  }
}

function totalLines(blocks) {
  // 1 header line per block + its content lines + 1 separator between blocks.
  let n = 0;
  for (let i = 0; i < blocks.length; i++) {
    n += 1 + blocks[i].lines.length + (i > 0 ? 1 : 0);
  }
  return n;
}

try {
  const start = Date.now();

  const focus = Date.now() - start <= SOFT_BUDGET_MS ? safe(buildFocus, PROJECT_DIR, 'current-focus') : [];
  const lessons = Date.now() - start <= SOFT_BUDGET_MS ? safe(buildLessons, PROJECT_DIR, 'lessons') : [];
  const knowledge = Date.now() - start <= SOFT_BUDGET_MS ? safe(buildKnowledge, PROJECT_DIR, 'knowledge') : [];
  // Index-matched resurfacing runs last — it needs the recency block to avoid
  // re-showing entries, and fails open (safe → []) when the index is absent.
  const matched =
    Date.now() - start <= SOFT_BUDGET_MS
      ? safe((d) => buildIndexMatched(d, knowledge), PROJECT_DIR, 'index-matched')
      : [];

  // Order: [current focus, lessons, knowledge]. dropFrom marks the OLDEST edge
  // for the global-cap trim — knowledge is newest-last (drop the start), lessons
  // is newest-first (drop the end), current-focus is newest-by-nature (drop the
  // end, and only after the other two are exhausted).
  const blocks = [];
  if (focus.length) blocks.push({ role: 'focus', header: '— Current focus (tasks/current-focus.md) —', lines: focus, dropFrom: 'end' });
  if (lessons.length) blocks.push({ role: 'lessons', header: '— Recent lessons (tasks/lessons.md) —', lines: lessons, dropFrom: 'end' });
  if (knowledge.length) blocks.push({ role: 'knowledge', header: '— Recent knowledge (KNOWLEDGE.md) —', lines: knowledge, dropFrom: 'start' });
  if (matched.length) blocks.push({ role: 'matched', header: '— Related knowledge (index-matched to current focus) —', lines: matched, dropFrom: 'end' });

  // Global cap — trim oldest/lowest-priority content first; current-focus last.
  // 'matched' is supplementary → trimmed before the recency blocks.
  const dropOrder = ['matched', 'knowledge', 'lessons', 'focus'];
  while (totalLines(blocks) > TOTAL_MAX_LINES) {
    let dropped = false;
    for (const role of dropOrder) {
      const b = blocks.find((x) => x.role === role && x.lines.length > 0);
      if (b) {
        if (b.dropFrom === 'start') b.lines.shift();
        else b.lines.pop();
        dropped = true;
        break;
      }
    }
    if (!dropped) break; // only headers left — cannot trim further
  }

  const present = blocks.filter((b) => b.lines.length > 0);
  if (present.length === 0) {
    process.exit(0); // all empty/absent — silent, clean start
  }

  const out = [];
  for (let i = 0; i < present.length; i++) {
    if (i > 0) out.push('');
    out.push(present[i].header);
    for (const l of present[i].lines) out.push(l);
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
} catch (err) {
  // Fail open: never block session start.
  if (DEBUG) process.stderr.write(`memory-digest: internal error, skipping: ${err && err.message}\n`);
  process.exit(0);
}
