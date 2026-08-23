#!/usr/bin/env node
// Description-budget gate (prevention control — framework cost-optimization,
// 2026-08-07). BLOCKING sibling of verify-doc-size.mjs: agent, skill, and
// command `description:` frontmatter is injected into every session's system
// prompt (the roster / skills listing), so it is a per-session cost paid on
// EVERY turn. Descriptions must carry WHEN-TO-INVOKE routing signals only;
// procedure and rationale belong in the file body, which loads on dispatch.
//
// Unlike verify-doc-size (warning-level, exit 2), this gate is BLOCKING:
// exit 1 on any over-budget description so the bloat cannot silently regrow.
//
// Budgets (bytes of the description scalar VALUE, UTF-8):
//   .claude/agents/*.md        <= 400B
//   .claude/skills/*/SKILL.md  <= 450B
//   .claude/commands/*.md      <= 180B
//
// A file with no frontmatter, or frontmatter with no `description:` key, is
// skipped silently — this gate only budgets descriptions that exist.
//
// Exit codes:
//   0  every description within its budget.
//   1  one or more descriptions over budget (BLOCKING), OR misconfiguration
//      (GATE_ROOT not a directory).
//
// Config (env, optional):
//   GATE_ROOT   Repo root to inspect. Default: process.cwd().

import * as fs from 'node:fs';
import * as path from 'node:path';

const GATE_ID = 'verify-description-budgets';
const ROOT = path.resolve(process.env.GATE_ROOT || process.cwd());

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`[FAIL] ${GATE_ID}: GATE_ROOT is not a directory: ${ROOT}`);
  process.exit(1);
}

/**
 * Extract the value of the frontmatter `description:` scalar, or null if there
 * is no leading `---` frontmatter block or no `description:` key inside it.
 * Handles the four YAML scalar styles that appear in agent/skill/command files:
 *   - inline plain:   description: some text
 *   - inline quoted:  description: "some text"   /   description: 'some text'
 *   - folded block:   description: >  (or >-, >+)  + indented continuation
 *   - literal block:  description: |  (or |-, |+)  + indented continuation
 * Continuation lines are those indented deeper than the (column-0) key; the
 * scan STOPS at the next column-0 key or the closing `---`, so the measured
 * value is the description alone and never the following frontmatter.
 */
function extractDescription(content) {
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return null;

  let di = -1;
  for (let i = 1; i < end; i++) {
    if (/^description\s*:/.test(lines[i])) { di = i; break; }
  }
  if (di < 0) return null;

  const inline = lines[di].replace(/^description\s*:/, '').trim();

  // Collect continuation lines: indented (start with whitespace) or blank,
  // stopping at the first column-0 non-blank line (next key) or the fm end.
  const cont = [];
  for (let i = di + 1; i < end; i++) {
    const l = lines[i];
    if (l.trim() === '') { cont.push(''); continue; }
    if (/^\s/.test(l)) { cont.push(l); continue; }
    break;
  }
  while (cont.length && cont[cont.length - 1] === '') cont.pop();

  // Block scalar (folded `>` or literal `|`, with optional YAML indentation
  // and/or chomping indicators in either order: `>`, `>-`, `|+`, `>2`, `|2-`,
  // `>-4`). Detection only — the actual indent is auto-derived from the content
  // lines below, so the indicator's digit does not need parsing here.
  if (/^[>|][0-9+-]*$/.test(inline)) {
    const style = inline[0];
    const nonBlank = cont.filter((l) => l.trim() !== '');
    const minIndent = nonBlank.length
      ? Math.min(...nonBlank.map((l) => l.match(/^\s*/)[0].length))
      : 0;
    const dedented = cont.map((l) => l.slice(minIndent));
    if (style === '|') return dedented.join('\n').replace(/\n+$/, '');
    // folded: non-blank lines joined by a single space.
    return dedented.filter((l) => l.trim() !== '').map((l) => l.trim()).join(' ');
  }

  // Inline quoted.
  if (inline.length >= 2 && inline[0] === '"' && inline[inline.length - 1] === '"') {
    return inline.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (inline.length >= 2 && inline[0] === "'" && inline[inline.length - 1] === "'") {
    return inline.slice(1, -1).replace(/''/g, "'");
  }

  // Inline plain, possibly with plain multi-line continuation (space-folded).
  if (cont.length) {
    return [inline, ...cont.map((l) => l.trim())].filter((s) => s !== '').join(' ');
  }
  return inline;
}

const violations = [];

function check(rel, budget) {
  const abs = path.join(ROOT, rel);
  let content;
  try { content = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const desc = extractDescription(content);
  if (desc === null) return; // no frontmatter / no description — not this gate's concern
  const b = Buffer.byteLength(desc, 'utf8');
  if (b > budget) violations.push({ rel, bytes: b, budget });
}

// ── .claude/agents/*.md (top-level only; _retired/ subdir excluded) ─────────
{
  const dir = path.join(ROOT, '.claude/agents');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) check(`.claude/agents/${e.name}`, 400);
  }
}

// ── .claude/skills/*/SKILL.md ──────────────────────────────────────────────
{
  const dir = path.join(ROOT, '.claude/skills');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (e.isDirectory()) check(`.claude/skills/${e.name}/SKILL.md`, 450);
  }
}

// ── .claude/commands/*.md ──────────────────────────────────────────────────
{
  const dir = path.join(ROOT, '.claude/commands');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) check(`.claude/commands/${e.name}`, 180);
  }
}

for (const v of violations) {
  console.error(
    `[FAIL] ${v.rel}: description ${v.bytes}B > ${v.budget}B — move procedure/rationale into the body; ` +
    `descriptions are WHEN-TO-INVOKE routing signals loaded into every session`,
  );
}
console.log(`[GATE] ${GATE_ID}: violations=${violations.length}`);
process.exit(violations.length ? 1 : 0);
