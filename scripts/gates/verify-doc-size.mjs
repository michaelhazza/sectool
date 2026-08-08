#!/usr/bin/env node
// Doc-size budget gate (prevention control C1 — framework cost-optimization,
// 2026-08-07). Keeps the always-loaded / accretion-prone docs from silently
// regrowing after a cleanup. This is the standing enforcement of the size
// targets in the framework-optimization report Part C.
//
// Canonical budget table + grace policy + per-session load target (C6):
//   references/doc-size-budgets.md
//
// What it budgets (all paths relative to GATE_ROOT, default: process.cwd()):
//   - tasks/current-focus.md   OPERATOR portion (whole file MINUS the
//                              STATUS:GENERATED:BEGIN..END region) <= 4KB and
//                              <= 50 lines. The generated region scales with
//                              the number of active builds and is regenerated,
//                              not accreted, so it is deliberately unbudgeted —
//                              the accretion risk is the operator-authored
//                              pointer block. (Aligns with control C2:
//                              generate-current-focus.mjs owns the whole file
//                              except the operator pointer block.)
//   - tasks/todo.md            <= 200 lines.
//   - KNOWLEDGE.md             <= 200KB and <= 150 live entries (`### [`
//                              indexable headings + legacy `## ` entry
//                              headings). GRACE until the next quarterly sweep.
//   - architecture.md          <= 400KB whole-file; `## ` sections <= 25KB
//                              each. GRACE until I2 (editorial passes).
//   - docs/capabilities.md     <= 300KB. GRACE until I1 (asset-register split).
//   - docs/*.md (root)         any file > 100KB that is NEITHER registered in
//                              docs/doc-sync.md NOR grandfathered in the
//                              consumer baseline is flagged — this is the
//                              "no new unregistered megadoc" prevention.
//
// Grace files (KNOWLEDGE.md, architecture.md, docs/capabilities.md) are
// EXPECTED to be over budget until their dedicated remediation chunks land;
// they are reported as `[grace]` and MUST NOT push an executor into
// force-trimming outside those reviewed processes. Every over-budget line
// prints the archive/promote command to run.
//
// Grandfather baseline (consumer-owned, optional):
//   <GATE_ROOT>/.claude/doc-size-baseline.json
//     { "grandfatheredRootDocs": ["docs/foo-spec.md", ...] }
//   Pre-existing large docs/ root files are listed here so the gate does not
//   retroactively fail on them; a NEW megadoc (absent from both doc-sync and
//   this list) still trips the check. Absent baseline => empty list.
//
// Exit codes:
//   0  every budget within limits (or only grace files, and they happen to be
//      within limits).
//   2  one or more budgets exceeded (WARNING-level rollout — this gate does
//      not block a merge on its own; promotion to blocking is a later operator
//      call per the report Part C).
//   1  misconfiguration (GATE_ROOT missing).
//
// Config (env, all optional):
//   GATE_ROOT   Consumer repo root to inspect. Default: process.cwd().

import * as fs from 'node:fs';
import * as path from 'node:path';

const GATE_ID = 'verify-doc-size';
const KB = 1024;
const ROOT = path.resolve(process.env.GATE_ROOT || process.cwd());

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`[FAIL] ${GATE_ID}: GATE_ROOT is not a directory: ${ROOT}`);
  process.exit(1);
}

/** Read a file relative to ROOT, or null if absent. */
function read(rel) {
  const abs = path.join(ROOT, rel);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}
function lines(s) {
  // Trailing newline should not count as an extra line.
  return s.length === 0 ? 0 : s.replace(/\n$/, '').split('\n').length;
}
function fmtKB(n) {
  return `${(n / KB).toFixed(1)}KB`;
}

const warnings = []; // { file, grace, message, fix }
function warn(file, grace, message, fix) {
  warnings.push({ file, grace, message, fix });
}
const infos = [];
function info(message) {
  infos.push(message);
}

// ── current-focus.md: operator portion only ────────────────────────────────
{
  const rel = 'tasks/current-focus.md';
  const s = read(rel);
  if (s === null) {
    info(`${rel} absent — skipped`);
  } else {
    const b = s.indexOf('<!-- STATUS:GENERATED:BEGIN -->');
    const e = s.indexOf('<!-- STATUS:GENERATED:END -->');
    let operator = s;
    if (b >= 0 && e >= 0 && e > b) {
      // Everything except the generated region (inclusive of its end marker).
      const endOfRegion = e + '<!-- STATUS:GENERATED:END -->'.length;
      operator = s.slice(0, b) + s.slice(endOfRegion);
    } else {
      info(`${rel}: no STATUS:GENERATED markers found — measuring whole file`);
    }
    const ob = bytes(operator);
    const ol = lines(operator);
    if (ob > 4 * KB) {
      warn(rel, false, `operator portion ${fmtKB(ob)} > 4.0KB budget`, 'relocate history to the active build\'s handoff.md; the pointer block stays lean');
    }
    if (ol > 50) {
      warn(rel, false, `operator portion ${ol} lines > 50-line budget`, 'trim the operator pointer block; history lives in handoff.md');
    }
  }
}

// ── todo.md: line budget ───────────────────────────────────────────────────
{
  const rel = 'tasks/todo.md';
  const s = read(rel);
  if (s === null) info(`${rel} absent — skipped`);
  else {
    const l = lines(s);
    if (l > 200) warn(rel, false, `${l} lines > 200-line budget`, 'archive completed / stale items to tasks/todo-archive/<quarter>.md');
  }
}

// ── CLAUDE.md: byte + line budget (the one always-loaded doc not yet watched) ─
{
  const rel = 'CLAUDE.md';
  const s = read(rel);
  if (s === null) info(`${rel} absent — skipped`);
  else {
    const b = bytes(s);
    const l = lines(s);
    const fix = 'move adoption history and version archaeology to references/ or tasks/builds/ — CLAUDE.md is loaded into every session and carries only always-needed guidance';
    if (b > 16 * KB) warn(rel, false, `${fmtKB(b)} > 16.0KB budget`, fix);
    if (l > 400) warn(rel, false, `${l} lines > 400-line budget`, fix);
  }
}

// ── KNOWLEDGE.md: byte + live-entry budget (GRACE) ─────────────────────────
{
  const rel = 'KNOWLEDGE.md';
  const s = read(rel);
  if (s === null) info(`${rel} absent — skipped`);
  else {
    const b = bytes(s);
    const indexable = (s.match(/^### \[/gm) || []).length;
    const legacy = (s.match(/^## /gm) || []).length;
    const entries = indexable + legacy;
    const fix = 'run the next quarterly KNOWLEDGE.md archival sweep (pre-quarter entries -> KNOWLEDGE-archive-<Q>.md); regenerate references/knowledge-index.md';
    if (b > 200 * KB) warn(rel, true, `${fmtKB(b)} > 200KB budget (grace: until next quarterly sweep)`, fix);
    if (entries > 150) warn(rel, true, `${entries} live entries (${indexable} \`### [\` + ${legacy} \`## \`) > 150 budget (grace: until next quarterly sweep)`, fix);
  }
}

// ── architecture.md: whole-file + per-section budget (GRACE) ───────────────
{
  const rel = 'architecture.md';
  const s = read(rel);
  if (s === null) info(`${rel} absent — skipped`);
  else {
    const b = bytes(s);
    const fix = 'run I2 (architecture.md editorial passes): shrink the key-files table, route build-history narrative out per the four-way routing rule';
    if (b > 400 * KB) warn(rel, true, `${fmtKB(b)} > 400KB budget (grace: until I2)`, fix);
    // Per-section: split on top-level `## ` headings.
    const parts = s.split(/^## /m);
    let over = 0;
    let biggest = 0;
    for (const p of parts) {
      const sb = bytes(p);
      if (sb > biggest) biggest = sb;
      if (sb > 25 * KB) over++;
    }
    if (over > 0) warn(rel, true, `${over} \`## \` section(s) > 25KB (biggest ${fmtKB(biggest)}) (grace: until I2)`, fix);
  }
}

// ── capabilities.md: byte budget (GRACE) ───────────────────────────────────
{
  const rel = 'docs/capabilities.md';
  const s = read(rel);
  if (s === null) info(`${rel} absent — skipped`);
  else {
    const b = bytes(s);
    if (b > 300 * KB) {
      warn(rel, true, `${fmtKB(b)} > 300KB budget (grace: until I1; target is prose-only after the asset-register split)`,
        'run I1 (split docs/capabilities.md): move the Asset Register out to docs/capabilities/register/ or capabilities.registry.yaml; archive >90d changelog');
    }
  }
}

// ── docs/ root new-megadoc prevention ──────────────────────────────────────
{
  const docsDir = path.join(ROOT, 'docs');
  const graceRootDocs = new Set(['docs/capabilities.md']); // budgeted above
  // Consumer-owned grandfather baseline.
  let grandfathered = new Set();
  const baselineRaw = read('.claude/doc-size-baseline.json');
  if (baselineRaw) {
    try {
      const parsed = JSON.parse(baselineRaw);
      grandfathered = new Set(parsed.grandfatheredRootDocs || []);
    } catch (err) {
      warn('.claude/doc-size-baseline.json', false, `unreadable JSON (${err.message}) — treating baseline as empty`, 'fix the baseline JSON');
    }
  }
  const docSync = read('docs/doc-sync.md') || '';
  // Registration = the file's path is the KEY (first column) of a doc-sync
  // registry ROW, not any backtick token anywhere in the file. Matching any code
  // span still false-greens on prose like "do not register `docs/legacy.md`";
  // only a table row `| `docs/foo.md` | … |` registers a doc. Extract the
  // first-cell backtick path from table rows exclusively.
  const docSyncPaths = new Set();
  for (const line of docSync.split('\n')) {
    const m = line.match(/^\s*\|\s*`([^`]+)`\s*\|/);
    if (m) docSyncPaths.add(m[1].trim());
  }
  let entries;
  try {
    entries = fs.readdirSync(docsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const rel = `docs/${ent.name}`;
    if (graceRootDocs.has(rel)) continue;
    const b = bytes(read(rel) || '');
    if (b <= 100 * KB) continue;
    const registered = docSyncPaths.has(rel) || docSyncPaths.has(ent.name);
    if (grandfathered.has(rel)) {
      info(`${rel}: ${fmtKB(b)} > 100KB but grandfathered in .claude/doc-size-baseline.json`);
      continue;
    }
    if (registered) {
      info(`${rel}: ${fmtKB(b)} > 100KB but registered in docs/doc-sync.md`);
      continue;
    }
    warn(rel, false, `${fmtKB(b)} > 100KB and neither doc-sync-registered nor grandfathered`,
      'archive it to docs/_archive/, register it in docs/doc-sync.md, or add it to .claude/doc-size-baseline.json if it is a sanctioned large doc');
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (warnings.length === 0) {
  for (const m of infos) console.log(`  [info] ${m}`);
  console.log(`[GATE] ${GATE_ID}: violations=0 root=${path.relative(process.cwd(), ROOT) || '.'}`);
  process.exit(0);
}

const nonGrace = warnings.filter((w) => !w.grace);
const grace = warnings.filter((w) => w.grace);
console.error(`${GATE_ID}: ${warnings.length} budget warning(s) (${nonGrace.length} action-needed, ${grace.length} grace):`);
for (const w of nonGrace) {
  console.error(`  [action-needed] ${w.file}: ${w.message}`);
  console.error(`      fix: ${w.fix}`);
}
for (const w of grace) {
  console.error(`  [grace] ${w.file}: ${w.message}`);
  console.error(`      fix: ${w.fix}`);
}
for (const m of infos) console.error(`  [info] ${m}`);
console.error(
  `[GATE] ${GATE_ID}: violations=${warnings.length} action_needed=${nonGrace.length} grace=${grace.length} ` +
  `root=${path.relative(process.cwd(), ROOT) || '.'}`
);
process.exit(2);
