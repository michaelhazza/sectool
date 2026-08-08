#!/usr/bin/env node
// generate-current-focus.mjs — reads every tasks/builds/*/status.json
// (contract: schemas/build-status.schema.json) and (re)writes the generated
// region of tasks/current-focus.md. Idempotent; safe to run at any time.
//
// No single-active semantics (spec §7.3 Codex #8): the generated block LISTS
// every non-terminal build (MERGED/ABANDONED excluded), deterministically
// ordered by status priority (MERGE_READY > REVIEWING > BUILDING > PLANNING),
// then updated_at desc, tie-break slug asc. Each entry emits exactly one
// `build_slug: <slug>` line, so the highest-priority build's line is the
// FIRST `build_slug:` occurrence inside the marker region — this is the
// generator half of the phase-lock slug-resolution fix (the hook half is
// .claude/hooks/phase-lock.js, inventory row 33). Also emits a fenced
// machine-readable block (raw status records, stable JSON) for the future
// Mission Control migration (§18 deferred item — not this build's scope).
//
// Markers: <!-- STATUS:GENERATED:BEGIN --> / <!-- STATUS:GENERATED:END -->.
//   - Absent: insert below the legacy `<!-- mission-control ... -->` HTML
//     comment when the file starts with one (that block is FROZEN history),
//     else at the top of the file.
//   - Present once: replace the region between the markers; markers and
//     everything outside them are byte-preserved.
//   - Present twice or more, or a mismatched/out-of-order pair: hard error,
//     NO write (fail loud — never "use the first pair").
//
// Contract (control C2 — overwrite-not-append): the generated marker region is
// the WHOLE file except the operator pointer block. Everything the generator
// does not own is that single operator pointer block, which coordinators
// OVERWRITE (never append history to). It is hard-capped at <= 50 lines / <= 4KB
// and enforced by scripts/gates/verify-doc-size.mjs (which measures exactly the
// non-generated region). Per-build history belongs in
// tasks/builds/<slug>/handoff.md, never accreted here. See
// references/doc-size-budgets.md.
//
// Fail-loud channel INSIDE the generated block (never a silent drop):
//   - unparseable/unreadable status.json           -> INVALID: <dir> — <error>
//   - missing required schema fields               -> INVALID: <dir> — missing required field(s): ...
//   - slug does not match its directory (OAI-SPEC-003, reader half)
//                                                    -> INVALID: <dir> — slug <slug> does not match directory <dir>
// These all exit 0 — the block records the problem. Only malformed markers
// or an I/O error exit non-zero.
//
// Writes are atomic: a temp file in the same directory, then rename.
//
// Usage: node scripts/status/generate-current-focus.mjs [--root <dir>]
//   --root  Repo root to operate against (default: process.cwd()). Makes the
//           generator testable against temp-dir fixtures without touching a
//           real checkout.
//
// stdlib-only by design — no ajv, no third-party deps at runtime.
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecordShape } from './status-contract.mjs';

const BEGIN_MARKER = '<!-- STATUS:GENERATED:BEGIN -->';
const END_MARKER = '<!-- STATUS:GENERATED:END -->';
const LEGACY_COMMENT_PREFIX = '<!-- mission-control';

// Validation is shared with board-sync via status-contract.mjs so the two
// readers of status.json cannot disagree about what "valid" means — they did,
// and a record the generator called INVALID was still published to the board.

const REQUIRED_KEYS = [
  'contract_version',
  'slug',
  'title',
  'classification',
  'phase',
  'status',
  'branch',
  'pr',
  'gates',
  'gate_evidence',
  'blockers',
  'summary',
  'updated_at',
  'updated_by',
];

// Lower value = higher display priority. Terminal statuses (MERGED,
// ABANDONED) are deliberately absent — they are excluded from the block.
// Lower value = higher display priority. Ordered by pipeline progress, so the
// build closest to landing sorts to the top of the generated block — that is
// the one whose state the operator most often needs.
// Widened to build-status.v2 (2026-07-29): SPECIFYING split out of PLANNING,
// and TESTING/FINALISING split out of the old catch-all REVIEWING span.
export const STATUS_PRIORITY = {
  MERGE_READY: 0,
  FINALISING: 1,
  TESTING: 2,
  REVIEWING: 3,
  BUILDING: 4,
  PLANNING: 5,
  SPECIFYING: 6,
};

// The terminal half of the schema's status enum (schemas/build-status.schema.json).
// Named explicitly so "terminal, deliberately excluded" is distinguishable from
// "unrecognised, therefore invalid" — collapsing the two is how a typo'd status
// silently disappeared from the generated block.
export const TERMINAL_STATUSES = new Set(['MERGED', 'ABANDONED']);

function parseArgs(argv) {
  let root = process.cwd();
  const idx = argv.indexOf('--root');
  if (idx !== -1 && argv[idx + 1]) root = argv[idx + 1];
  return { root: path.resolve(root) };
}

function allIndicesOf(text, needle) {
  const indices = [];
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    indices.push(idx);
    idx = text.indexOf(needle, idx + needle.length);
  }
  return indices;
}

/** Insertion point for a first-run marker pair: below the legacy
 *  mission-control HTML comment when present, else the top of the file. */
function findInsertionPoint(text) {
  if (!text.startsWith(LEGACY_COMMENT_PREFIX)) return 0;
  const closeIdx = text.indexOf('-->');
  if (closeIdx === -1) return 0;
  const afterClose = closeIdx + 3;
  const nlIdx = text.indexOf('\n', afterClose);
  return nlIdx === -1 ? text.length : nlIdx + 1;
}

function compareRecords(a, b) {
  const pa = STATUS_PRIORITY[a.status];
  const pb = STATUS_PRIORITY[b.status];
  if (pa !== pb) return pa - pb;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1; // desc
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

async function collectRecords(root) {
  const buildsDir = path.join(root, 'tasks', 'builds');
  const records = [];
  const invalids = [];

  let entries;
  try {
    entries = await readdir(buildsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { records, invalids };
    throw err;
  }

  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  for (const dirName of dirNames) {
    const statusPath = path.join(buildsDir, dirName, 'status.json');
    if (!existsSync(statusPath)) continue; // pre-migration build dir — not yet part of this contract

    let raw;
    try {
      raw = await readFile(statusPath, 'utf8');
    } catch (err) {
      invalids.push({ dir: dirName, error: `cannot read status.json: ${err.message}` });
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      invalids.push({ dir: dirName, error: `invalid JSON: ${err.message}` });
      continue;
    }

    const missing = REQUIRED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
    if (missing.length > 0) {
      invalids.push({ dir: dirName, error: `missing required field(s): ${missing.join(', ')}` });
      continue;
    }

    if (data.slug !== dirName) {
      invalids.push({ dir: dirName, error: `slug ${data.slug} does not match directory ${dirName}` });
      continue;
    }

    // Terminal and UNRECOGNISED are different outcomes and must not share a
    // branch. Both were previously a bare `continue`, so a typo'd or
    // future-enum status vanished from the block entirely — silently, despite
    // this module's documented promise of a fail-loud INVALID channel for
    // schema problems. A status outside the schema enum IS a schema problem.
    // VALIDATE BEFORE CLASSIFYING. Ordering is the contract here: the terminal
    // check used to `continue` first, so a MERGED/ABANDONED record with
    // `blockers: null` and a bogus phase vanished entirely — neither rendered
    // nor surfaced as INVALID — purely because its status happened to be
    // terminal. That defeats the very distinction this module promises between
    // "valid terminal, deliberately excluded" and "schema-invalid, surfaced"
    // (external review round 2). Every record now faces validation; only then
    // is it classified.
    //
    // Type/shape validation — key-complete is not schema-valid. A malformed
    // VALUE (`"blockers": null`) sailed past the presence check and crashed
    // buildBody on `.length`, exiting non-zero and writing NOTHING, so one bad
    // build dir took every healthy build's status with it. Full JSON-Schema
    // validation when ajv is importable (both current repos ship it); a
    // structural check of exactly the renderer's dereferences when it is not —
    // this file is stdlib-only BY DESIGN, so ajv is an enhancement, never a
    // hard dependency.
    // Status FIRST, for the diagnostic — ajv would otherwise catch it as a
    // generic "must be equal to one of the allowed values", losing the message
    // that names the offending value and lists the legal ones. Note this is a
    // check, NOT a classification: it does not skip validation for terminal
    // records, which was the whole defect.
    if (!TERMINAL_STATUSES.has(data.status) && !Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, data.status)) {
      invalids.push({
        dir: dirName,
        error:
          `unrecognised status ${JSON.stringify(data.status)} — expected one of ` +
          `${[...Object.keys(STATUS_PRIORITY), ...TERMINAL_STATUSES].join(', ')}`,
      });
      continue;
    }

    const shapeError = await validateRecordShape(data);
    if (shapeError) {
      invalids.push({ dir: dirName, error: shapeError });
      continue;
    }

    // Only now classify: a VALID terminal record is deliberately excluded from
    // the active-builds block. An INVALID one was surfaced above.
    if (TERMINAL_STATUSES.has(data.status)) continue;

    records.push({
      slug: data.slug,
      status: data.status,
      phase: data.phase,
      branch: data.branch,
      pr: data.pr,
      summary: data.summary,
      updated_at: data.updated_at,
      blockers: data.blockers,
      raw: data,
    });
  }

  records.sort(compareRecords);
  invalids.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { records, invalids };
}

function buildBody(records, invalids) {
  const lines = [];
  lines.push('## Active builds');
  lines.push('');
  lines.push(
    '_Generated by `scripts/status/generate-current-focus.mjs` from every non-terminal `tasks/builds/*/status.json`. Do not hand-edit — the next run overwrites this region._'
  );

  if (records.length === 0 && invalids.length === 0) {
    lines.push('');
    lines.push('No active builds.');
  }

  for (const record of records) {
    lines.push('');
    lines.push(`### ${record.slug}`);
    lines.push(`build_slug: ${record.slug}`);
    lines.push(`status: ${record.status}`);
    lines.push(`phase: ${record.phase}`);
    lines.push(`branch: ${record.branch}`);
    lines.push(`pr: ${record.pr === null ? 'none' : record.pr}`);
    lines.push(`summary: ${record.summary}`);
    lines.push(`updated_at: ${record.updated_at}`);
    lines.push(`blockers: ${record.blockers.length}`);
  }

  for (const invalid of invalids) {
    lines.push('');
    lines.push(`INVALID: ${invalid.dir} — ${invalid.error}`);
  }

  lines.push('');
  lines.push('### Machine-readable (status-records.v1)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(records.map((r) => r.raw), null, 2));
  lines.push('```');

  return lines.join('\n');
}

async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const { records, invalids } = await collectRecords(root);
  const body = buildBody(records, invalids);

  const currentFocusPath = path.join(root, 'tasks', 'current-focus.md');
  let existing = '';
  try {
    existing = await readFile(currentFocusPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const beginIndices = allIndicesOf(existing, BEGIN_MARKER);
  const endIndices = allIndicesOf(existing, END_MARKER);

  let newText;
  if (beginIndices.length === 0 && endIndices.length === 0) {
    const insertPos = findInsertionPoint(existing);
    const blockText = `${BEGIN_MARKER}\n${body}\n${END_MARKER}\n`;
    newText = existing.slice(0, insertPos) + blockText + existing.slice(insertPos);
  } else if (beginIndices.length === 1 && endIndices.length === 1 && beginIndices[0] < endIndices[0]) {
    // Both boundaries come from the already-validated indices. The previous
    // version re-derived them with two unchecked indexOf calls, and each
    // -1 sentinel silently destroyed content:
    //   - indexOf('\n', begin) + 1 === 0 when BEGIN has no following newline,
    //     collapsing `before` to '' and deleting everything above the block;
    //   - a fresh indexOf(END_MARKER, ...) returning -1 made slice(-1)
    //     substitute the file's LAST CHARACTER for the entire tail.
    // Reproduced: a marker pair sharing one line deleted the operator's prose
    // below it while the script printed success and exited 0 — directly
    // against this module's byte-preservation promise.
    const newlineAfterBegin = existing.indexOf('\n', beginIndices[0]);
    // Only usable when that newline actually falls INSIDE the block; when the
    // two markers share a line it lands after END and must not be consumed.
    const beginLineEnd =
      newlineAfterBegin !== -1 && newlineAfterBegin < endIndices[0]
        ? newlineAfterBegin + 1
        : null;
    const before =
      beginLineEnd !== null
        ? existing.slice(0, beginLineEnd)
        : existing.slice(0, beginIndices[0] + BEGIN_MARKER.length) + '\n';
    const after = existing.slice(endIndices[0]);
    newText = before + body + '\n' + after;
  } else {
    console.error(
      `[FAIL] generate-current-focus: malformed STATUS:GENERATED markers in ${currentFocusPath} ` +
        `(BEGIN x${beginIndices.length}, END x${endIndices.length}) — refusing to write`
    );
    process.exit(1);
    return;
  }

  // Post-condition, checked BEFORE the write. Only the file being READ was
  // marker-validated above; the text being WRITTEN never was, and buildBody()
  // emits operator-authored free text (title, summary, branch) plus the whole
  // raw status record. A status.json field holding the literal marker string
  // therefore wrote a file with a duplicated or interleaved marker pair, exited
  // 0, and then made every later run hit the malformed-marker refusal — a
  // permanent, hand-repair-only brick of the file the phase-lock hook and the
  // coordinators all read. Refusing here keeps the failure in the run that
  // caused it, with the file untouched.
  const writtenBegin = allIndicesOf(newText, BEGIN_MARKER).length;
  const writtenEnd = allIndicesOf(newText, END_MARKER).length;
  if (writtenBegin !== 1 || writtenEnd !== 1) {
    console.error(
      `[FAIL] generate-current-focus: the generated content would put BEGIN x${writtenBegin}, END x${writtenEnd} ` +
        `into ${currentFocusPath} — a status.json field contains the marker text. Refusing to write: the next run ` +
        `could not parse the result. Remove the marker text from the offending build's status.json and re-run.`
    );
    process.exit(1);
    return;
  }

  await writeAtomic(currentFocusPath, newText);
  console.log(
    `generate-current-focus: wrote ${records.length} active build(s), ${invalids.length} invalid entr${
      invalids.length === 1 ? 'y' : 'ies'
    } to ${currentFocusPath}`
  );
}

// Entry-point guard, matching board-sync.mjs and adopt-ci-templates.mjs.
// main() defaults --root to process.cwd() and WRITES tasks/current-focus.md,
// so without this an `import` of the module rewrites whichever repo the
// importing process happens to be running in. That already happened once
// during a chunk probe, against the framework's own current-focus.md.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[FAIL] generate-current-focus: ${err.message}`);
    process.exit(1);
  });
}
