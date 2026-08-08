#!/usr/bin/env node
// board-sync.mjs — upserts one draft-item card per build onto a single
// account-level GitHub Projects v2 board, sourced from every
// tasks/builds/*/status.json (contract: schemas/build-status.schema.json).
// Companion to generate-current-focus.mjs (C8) — same status.json source,
// different sink (a board, not a markdown block). The board is a VIEW, not
// a gate (spec §7.4/§8.4): its failure modes are recorded and non-blocking.
//
// ---------------------------------------------------------------------------
// §5.3 OPEN ITEM CLOSED HERE — the `gh project` command surface, pinned
// against `gh 2.87.3` by running `--help` on every relevant subcommand
// (read-only; no board was created or edited while writing this chunk).
// Confirmed subcommands + flags:
//
//   gh project create --owner <login> --title <title> --format json
//     -> one-time board creation. Returns { number, id, ... }.
//   gh project field-list <number> --owner <login> --format json
//     -> { fields: [{ id, name, type, options?: [{id,name}], ... }] }
//        (options present only on SINGLE_SELECT fields). Read once per run
//        to resolve field ids for item-edit mutations.
//   gh project field-create <number> --owner <login> --name <name>
//     --data-type {TEXT|SINGLE_SELECT|DATE|NUMBER}
//     [--single-select-options "a,b,c"] --format json
//     -> one-time custom-field creation (--init only).
//     IMPORTANT: there is NO `field-edit` subcommand in this gh version
//     (confirmed against the full `gh project --help` command list:
//     close/copy/create/delete/edit/field-create/field-delete/field-list/
//     item-add/item-archive/item-create/item-delete/item-edit/item-list/
//     link/list/mark-template/unlink/view). A field's options can only be
//     set at creation time. `gh project create` auto-provisions a default
//     single-select "Status" field per GitHub's standard project template —
//     this cannot be verified or renamed via the CLI without creating a live
//     board (out of scope here — no mutating command was run). --init
//     therefore REUSES a pre-existing "Status" field if field-list already
//     reports one, and prints an operator instruction to confirm its
//     options match the enum via the web UI; otherwise it creates one fresh
//     with the correct options. WATCH-OUT FOR C21/C22: verify this against
//     a real board on the first --init run and correct this comment +
//     runInit() if the default field's name/type differs from what's
//     assumed here.
//   gh project item-create <number> --owner <login> --title <t> --body <b>
//     --format json -> creates ONE draft-issue card, returns { id, ... }.
//   gh project item-edit --id <item-id> [--title <t>] [--body <b>]
//     [--project-id <id> --field-id <id>
//       (--text <v> | --number <n> | --date <YYYY-MM-DD>
//        | --single-select-option-id <id> | --clear)]
//     --format json
//     -> per --help: "only a single field value can be updated per
//     invocation" for project-item field edits, so upserting a card's
//     custom fields costs one item-edit call per field. Draft-issue
//     title/body edits use --id alone (no --project-id/--field-id needed)
//     BUT that --id must be the draft-issue CONTENT id (`DI_…`), not the
//     project-item id (`PVTI_…`) the field edits take: gh refuses with "ID
//     must be the ID of the draft issue content which is prefixed with
//     `DI_`". Confirmed against a live board (gh 2.87.3) during the
//     cryptotrackr pilot, where the wrong id made every UPDATE a silent
//     no-op. See buildDraftContentEditArgs + normaliseItem's contentId.
//   gh project item-list <number> --owner <login> --format json [-L <n>]
//     -> list existing cards to resolve the {Build Repo, Slug} upsert key.
//   gh project item-archive <number> --id <item-id> --owner <login>
//     --format json [--undo] -> archive (or unarchive) one item. NOTE:
//     unlike item-edit, item-archive DOES take the project <number> as a
//     positional (per its USAGE line), matching item-create/item-list.
//   gh project view <number> --owner <login> --format json
//     -> { id, number, title, ... }. Used to resolve the project's internal
//     node id (required by item-edit --project-id), separate from the
//     user-facing project --number.
//
// DELTA FROM THE PLAN'S ASSUMPTION: none at the subcommand-name level —
// every subcommand the plan named (item-create, item-edit, field-list)
// exists exactly as named, with the flags above. The delta is the missing
// `field-edit` subcommand, which the plan did not anticipate and which
// changes how --init must treat a pre-existing default "Status" field (see
// above).
//
// FIELD-VALUE KEY SHAPE: `gh project item-list --format json` flattens custom
// field values onto the item and lower-cases the first character of the
// display name (`Build Repo` -> `build Repo`, `Slug` -> `slug`) rather than
// keying them by the display name verbatim. readItemFieldValue() below
// therefore matches a display name in three passes of decreasing precision
// (exact, then case-insensitive, then case-and-separator-insensitive, first
// hit wins), and also looks in a nested `fieldValues` map, so the read side
// does not depend on pinning that transformation exactly. Because
// `updated_at` is explicitly a card-BODY value per the contract (not a
// field — see below), the stale/duplicate logic never depends on this
// assumption: it reads updated_at back out of the body text instead, via a
// stable hidden marker this script itself writes. If the field-value shape
// turns out to differ, only normaliseItem() needs correcting.
// ---------------------------------------------------------------------------
//
// Board contract (spec §7.4/§8.4):
//   - Identity = {repository, slug}, held in two custom TEXT fields `Build Repo`
//     + `Slug`. The repo value is canonicalised to lowercase before any key
//     comparison (OAI-SPEC-002 — GitHub owner/repo is case-insensitive, so
//     `Owner/Repo` vs `owner/repo` must not create a duplicate card).
//   - Item type: draft issues only. No per-build GitHub issue is created.
//   - Column mapping: the board's Kanban column comes from the `Status`
//     SINGLE_SELECT field (one option per status enum value). `phase` is a
//     plain field, never a column. `branch`/`pr`/`blockers`/`updated_at` go
//     in the card BODY (not fields) — this script embeds `updated_at` in a
//     hidden HTML-comment marker inside the body so it stays machine
//     -readable for the stale/duplicate checks below without becoming a
//     seventh custom field.
//   - Stale-update protection: skip a write when the existing card's
//     updated_at is strictly newer than the incoming record's.
//   - Duplicate recovery: two cards matching one {Build Repo, Slug} key -> keep
//     the newest (by updated_at), archive the rest, warn. Equal updated_at
//     -> lowest card id wins (OAI-SPEC-002 deterministic tie-break;
//     GitHub Projects v2 item ids are opaque node-id strings, so "lowest"
//     is plain code-point string comparison — deterministic regardless of
//     API return order).
//   - Archive: MERGED/ABANDONED records auto-archive their card after
//     ARCHIVE_AFTER_DAYS (default 14, substitutable via the
//     BOARD_SYNC_ARCHIVE_AFTER_DAYS env var).
//
// Error handling — deliberately asymmetric; this asymmetry IS the contract:
//   - `gh` failure, network error, or missing `projects_board` config in
//     `.claude/project-registries.json` -> RECORDED (console.warn) and
//     NON-BLOCKING: this script never throws on the sync path and never stops
//     a build, no matter what `gh` does. DO NOT "harden" this into a hard
//     failure later — the board is a view, not a gate (spec §7.4), and this is
//     the one place in the pipeline where a failure is intentionally
//     swallowed-with-a-record.
//   - OBSERVABLE, though. Any run that did not reach the board also emits the
//     stable marker `[board-sync] NOT_SYNCED reason=<reason>` (closed reason
//     set: NOT_SYNCED_REASONS) and sets exit code EXIT_NOT_SYNCED (3). This is
//     NOT a gate — callers report it, they do not stop on it. It exists
//     because "board updated" and "board silently not updated" were previously
//     indistinguishable: a missing `projects_board` key made every push a
//     silent no-op across an unknown number of builds, and the only way anyone
//     found out was an operator opening the board and seeing an empty column.
//     Marker format is contract; callers grep `NOT_SYNCED reason=`.
//     Per-card `gh` failures set it too — a single stale card is the same
//     class of bug as a whole run that never landed.
//   - EXCEPTION: slug !== directory name -> REFUSE the upsert for that one
//     record (fails closed even though the rest of this script is fail-
//     open) — a wrong slug would otherwise upsert under the WRONG board
//     identity and silently corrupt another build's card. Uses the exact
//     same wording contract as generate-current-focus.mjs (C8):
//     `slug <slug> does not match directory <dir>`.
//   --init keeps exit 1 for operator-input errors (bad --owner, missing
//   --title, gh error): it is an operator-run, interactive bootstrap command
//   and the operator is actively watching the terminal. Exit 1 stays reserved
//   for that path; the sync path's did-not-reach-the-board signal is the
//   distinct EXIT_NOT_SYNCED (3), so the two are never confused.
//
// Structure for testability: all decision logic lives in exported PURE
// functions (no fs, no gh, no Date.now()) — canonicaliseRepo, buildCardKey,
// validateSlugMatchesDir, extractUpdatedAtFromBody, buildCardBody,
// mapRecordToCard, chooseSurvivor, shouldSkipStale, shouldArchive,
// parseOwnerRepoFromGitUrl, buildDraftContentEditArgs. All `gh` invocation is
// isolated below in the thin I/O layer (ghJson + its callers). Tests exercise
// only the pure functions and never shell out to `gh` — which is why the
// which-id-goes-where rule lives in a pure arg-builder: an argv choice made
// inline inside the I/O layer is untestable, and that is exactly where the
// silent-update defect hid.
//
// Usage:
//   node scripts/status/board-sync.mjs [--root <dir>] [--repo <owner/name>]
//   node scripts/status/board-sync.mjs --init --owner <login> --title <title>
//
//   --root   Repo root to scan tasks/builds/* from (default: process.cwd()).
//            Makes the sync path testable against temp-dir fixtures.
//   --repo   owner/name identity for this repo's cards (default: parsed
//            from `git remote get-url origin` run in --root).
//   --init   One-time board + field creation (operator-run once per
//            account; NOT invoked by any coordinator playbook). Prints the
//            resulting project number for the operator to record in
//            `.claude/project-registries.json` under
//            `projects_board: { owner, number }`.
//
// stdlib-only at runtime (gh is an external binary, not an npm dependency),
// matching generate-current-focus.mjs's convention.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with generate-current-focus.mjs so the two readers of status.json
// cannot disagree about what "valid" means, and so the board's Status options
// are checked against the schema enum rather than a second hand-kept copy.
import { readStatusEnum, validateRecordShape } from './status-contract.mjs';

const ARCHIVE_AFTER_DAYS = Number(process.env.BOARD_SYNC_ARCHIVE_AFTER_DAYS ?? 14);
const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// How many activity-log entries render on the card (newest first). Purely a
// body-size guard — GitHub caps issue bodies at 65,536 chars and a schema-max
// entry is ~1.3KB, so 40 stays an order of magnitude clear while covering far
// more than a full pipeline run (~15-20 entries). The full log always remains
// in status.json.
export const ACTIVITY_RENDER_CAP = Number(process.env.BOARD_SYNC_ACTIVITY_RENDER_CAP ?? 40);

const UPDATED_AT_MARKER = /<!-- board-sync:v1(?: key=\S+)? updated_at=(\S+) -->/;
// The identity key travels IN THE BODY, written atomically with item-create.
// Field values (`Build Repo`, `Slug`) are applied by separate item-edit calls
// that can fail after the item exists; a card that lost that race used to be
// invisible to the upsert (no fields -> "not one of ours" -> skipped) and the
// sync then created ANOTHER card — one new duplicate per run, forever, under
// any persistent field/permission error (external review, 2026-07-29). The
// body key makes such orphans recognisable, so they are adopted and healed
// instead of multiplied.
const KEY_MARKER = /<!-- board-sync:v1 key=(\S+) updated_at=\S+ -->/;

// Single source of truth for the repo field's display name. It is NOT 'Repo':
// that name is reserved in Projects v2 and createProjectV2Field rejects it
// (found live during board provisioning). The rename originally touched only
// the create + write sites while normaliseItem still read `item.Repo`, so the
// upsert key never matched, every existing card was skipped as "not one of
// ours", and each sync created a duplicate draft card while the MERGED
// auto-archive stayed permanently unreachable. Both sides read this constant
// so they cannot drift apart again.
export const REPO_FIELD_NAME = 'Build Repo';

export const BOARD_FIELDS_TO_CREATE = [
  { name: REPO_FIELD_NAME, dataType: 'TEXT' },
  { name: 'Slug', dataType: 'TEXT' },
  { name: 'Phase', dataType: 'TEXT' },
  {
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    // build-status.v2 order — these ARE the board columns, left to right, so the
    // sequence is the pipeline order and not alphabetical. Must stay in step
    // with schemas/build-status.schema.json's status enum; a value the board
    // lacks cannot be written to a card.
    options: [
      'SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING',
      'FINALISING', 'MERGE_READY', 'MERGED', 'ABANDONED',
    ],
  },
];

// ---------------------------------------------------------------------------
// Pure functions (exported for tests — no fs, no gh, no wall-clock reads).
// ---------------------------------------------------------------------------

/** Lowercase a repo identity for case-insensitive key comparison
 *  (OAI-SPEC-002). Non-strings pass through unchanged. */
export function canonicaliseRepo(repo) {
  return typeof repo === 'string' ? repo.toLowerCase() : repo;
}

/** Composite upsert key = canonicalised {repository, slug}. */
export function buildCardKey(repo, slug) {
  return `${canonicaliseRepo(repo)}::${slug}`;
}

/** OAI-SPEC-003, board half. Returns null when slug matches the directory,
 *  else the exact wording C8's generator asserts for the same invariant. */
export function validateSlugMatchesDir(slug, dirName) {
  if (slug === dirName) return null;
  return `slug ${slug} does not match directory ${dirName}`;
}

/** Reads the hidden updated_at marker this script writes into every card
 *  body, so the stale/duplicate checks stay machine-readable without a
 *  seventh custom field. Returns null when absent or unparseable. */
export function extractUpdatedAtFromBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(UPDATED_AT_MARKER);
  return match ? match[1] : null;
}

/** Neutralises HTML-comment delimiters in free-text fields rendered into a
 *  card body (summary, blocker text, activity-log notes), so a crafted
 *  status.json cannot inject a second `<!-- board-sync:v1 ... -->` marker
 *  (spoofing the upsert key/updated_at this script trusts back out of the
 *  body) or otherwise break out into raw markdown via an HTML comment.
 *  Additive and non-behavioural for normal text: only the literal `<!--` /
 *  `-->` delimiter sequences are altered, never surrounding text. */
export function neutraliseCardText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<!--/g, '<! --').replace(/-->/g, '-- >');
}

/** Card body: hidden updated_at marker, then the human-readable
 *  branch/PR/blockers/updated_at/summary fields the contract assigns to
 *  the body rather than to custom fields, then the Activity section
 *  (schema `log[]`, optional) rendered newest-first. */
export function buildCardBody(record, key = null) {
  const lines = [];
  // The key rides in the marker so identity survives even when the field-value
  // edits after item-create fail — see KEY_MARKER for the duplicate-card bug
  // this prevents. Old cards without a key in the body keep working: field
  // values remain the primary identity source and the marker regexes accept
  // both shapes.
  lines.push(key
    ? `<!-- board-sync:v1 key=${key} updated_at=${record.updated_at} -->`
    : `<!-- board-sync:v1 updated_at=${record.updated_at} -->`);
  lines.push(`**Branch:** ${record.branch}`);
  lines.push(`**PR:** ${record.pr === null || record.pr === undefined ? 'none' : `#${record.pr}`}`);
  lines.push(`**Blockers:** ${record.blockers.length}`);
  for (const blocker of record.blockers) {
    lines.push(`- [${blocker.cleared_at ? 'cleared' : 'open'}] ${neutraliseCardText(blocker.text)}`);
  }
  lines.push(`**Updated:** ${record.updated_at}`);
  lines.push('');
  lines.push(neutraliseCardText(record.summary));
  // Activity log (schema `log[]`, optional/additive — absent in pre-2.61.0
  // records): the operator-facing build history, rendered newest-first so
  // opening the card answers "what is it doing / what has it done" without
  // the session transcript. Coordinators append entries at stage boundaries;
  // this renderer never mutates them. ACTIVITY_RENDER_CAP bounds the body
  // size; the full log stays in status.json.
  const log = Array.isArray(record.log) ? record.log : [];
  if (log.length > 0) {
    lines.push('');
    lines.push('## Activity');
    const shown = log.slice(-ACTIVITY_RENDER_CAP).reverse();
    for (const entry of shown) {
      const kindLabel = entry.kind === 'start' ? 'started' : entry.kind === 'done' ? 'done' : 'update';
      lines.push('');
      lines.push(`**${entry.at} — ${entry.stage} (${kindLabel})**`);
      for (const bullet of entry.note) {
        lines.push(`- ${neutraliseCardText(bullet)}`);
      }
    }
    const hidden = log.length - shown.length;
    if (hidden > 0) {
      lines.push('');
      lines.push(`_${hidden} earlier ${hidden === 1 ? 'entry' : 'entries'} not shown — full log in tasks/builds/${record.slug}/status.json_`);
    }
  }
  return lines.join('\n');
}

/** Maps one BUILD_STATUS record (§8.1) to a board card: {repository, slug}
 *  -> key/fields (§8.4), status -> Status field/column, phase -> Phase
 *  field, branch/PR/blockers/updated_at -> body. */
export function mapRecordToCard(record, repository) {
  const repo = canonicaliseRepo(repository);
  return {
    key: buildCardKey(repo, record.slug),
    title: `${record.slug}: ${record.title}`,
    body: buildCardBody(record, buildCardKey(repo, record.slug)),
    fields: {
      [REPO_FIELD_NAME]: repo,
      Slug: record.slug,
      Status: record.status,
      Phase: record.phase,
    },
  };
}

/** Duplicate recovery: newest updated_at survives; on an exact tie, the
 *  lowest card id survives (deterministic — OAI-SPEC-002). `cards` are
 *  normalised existing-card shapes: { id, updated_at, ... }. */
export function chooseSurvivor(cards) {
  if (!cards || cards.length === 0) return { survivor: null, toArchive: [] };
  const sorted = [...cards].sort((a, b) => {
    const at = a.updated_at ?? '';
    const bt = b.updated_at ?? '';
    if (at !== bt) return at < bt ? 1 : -1; // desc: newest first, missing sorts last
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { survivor: sorted[0], toArchive: sorted.slice(1) };
}

/** Stale-update protection: skip the write when the surviving card's
 *  updated_at is strictly newer than the incoming record's. A card with no
 *  readable updated_at (null) is never treated as newer. */
export function shouldSkipStale(card, record) {
  if (!card || card.updated_at == null) return false;
  return card.updated_at > record.updated_at;
}

/** Auto-archive: MERGED/ABANDONED records archive their card once
 *  ARCHIVE_AFTER_DAYS has elapsed since updated_at. `now` is always
 *  injected — never reads the real clock, so this stays deterministic. */
/**
 * Composes the per-record card decision. Extracted and exported because the
 * defect it now pins was a COMPOSITION bug, not a predicate bug: both
 * shouldSkipStale and shouldArchive were individually correct, but the sync
 * loop evaluated archival independently of whether it had accepted the record,
 * so a stale terminal record archived a newer active card. A test over the two
 * predicates alone could never have caught that.
 *
 * The invariant: `archive` is only ever true when the incoming record was
 * ACCEPTED. A record too stale to apply is too stale to archive on.
 */
export function decideCardAction(survivor, record, now) {
  if (!survivor) {
    return { create: true, update: false, archive: false, skipped: false };
  }
  if (shouldSkipStale(survivor, record)) {
    return { create: false, update: false, archive: false, skipped: true };
  }
  return { create: false, update: true, archive: shouldArchive(record, now), skipped: false };
}

export function shouldArchive(record, now) {
  if (record.status !== 'MERGED' && record.status !== 'ABANDONED') return false;
  const ageMs = now.getTime() - new Date(record.updated_at).getTime();
  return ageMs >= ARCHIVE_AFTER_MS;
}

/** Classifies a `gh` failure as a named permission diagnostic when its
 *  message matches a known missing-scope / missing-access shape (FR-6, spec
 *  §6A "Projects V2 -> permission diagnostics only"), so a swallowed board
 *  failure is diagnosable ("your token lacks the project scope") rather than
 *  a generic "gh failure" pointing the operator nowhere. Purely
 *  informational — the board stays a non-blocking projection regardless of
 *  the result (see the asymmetric error-handling contract above); this never
 *  turns the board into a gate, it only labels a swallowed failure. Returns
 *  null when the message shows no permission signal at all, so an unrelated
 *  gh failure (network, rate limit, malformed JSON) is not mislabelled. */
/** Exit code for "this run did not reach the board". Distinct from 1, which
 *  --init reserves for operator-input errors. The board stays NON-BLOCKING —
 *  a coordinator does not stop a build on this code; it reports it. What the
 *  code buys is that "board updated" and "board silently not updated" stop
 *  being indistinguishable to any caller, which is the defect this exists to
 *  close: a missing `projects_board` config made every push a no-op for an
 *  unknown number of builds, and nothing upstream could tell. */
export const EXIT_NOT_SYNCED = 3;

/** Closed set of reasons a run did not reach the board. Kept closed so a
 *  caller can branch on the value; a new failure mode adds a member here
 *  rather than inventing free text at the call site. */
export const NOT_SYNCED_REASONS = Object.freeze({
  NO_CONFIG: 'no_config',
  NO_REPO_IDENTITY: 'no_repo_identity',
  MISSING_PROJECT_SCOPE: 'missing_project_scope',
  MISSING_BOARD_ACCESS: 'missing_board_access',
  BOARD_CONTRACT_MISMATCH: 'board_contract_mismatch',
  GH_FAILURE: 'gh_failure',
  UNEXPECTED_ERROR: 'unexpected_error',
});

/** The stable, greppable stdout marker. Format is contract: callers and CI
 *  grep for `NOT_SYNCED reason=` — do not reword it. */
export function buildNotSyncedMarker(reason) {
  return `[board-sync] NOT_SYNCED reason=${reason}`;
}

/** Maps a classifyBoardPermissionError diagnostic onto a NOT_SYNCED reason.
 *  Anything unclassified (network, rate limit, malformed JSON) degrades to
 *  GH_FAILURE rather than being mislabelled as a permission problem. */
export function notSyncedReasonFromDiagnostic(diagnostic) {
  if (diagnostic === 'MISSING_PROJECT_SCOPE') return NOT_SYNCED_REASONS.MISSING_PROJECT_SCOPE;
  if (diagnostic === 'MISSING_BOARD_ACCESS') return NOT_SYNCED_REASONS.MISSING_BOARD_ACCESS;
  return NOT_SYNCED_REASONS.GH_FAILURE;
}

/** Impure companion to the two pure helpers above: emits the marker and sets
 *  the exit code. Deliberately NOT a throw — the sync path stays fail-open. */
function markNotSynced(reason) {
  console.warn(buildNotSyncedMarker(reason));
  process.exitCode = EXIT_NOT_SYNCED;
}

export function classifyBoardPermissionError(err) {
  const message = typeof err?.message === 'string' ? err.message : String(err ?? '');
  const lower = message.toLowerCase();

  if (lower.includes("'project' scope") || (lower.includes('scope') && lower.includes('project'))) {
    return 'MISSING_PROJECT_SCOPE';
  }
  if (lower.includes('not accessible') || lower.includes('does not have access')
      || lower.includes('permission') || lower.includes('forbidden') || /\b403\b/.test(lower)) {
    return 'MISSING_BOARD_ACCESS';
  }
  if (lower.includes('unauthorized') || lower.includes('authentication') || /\b401\b/.test(lower)) {
    return 'UNKNOWN';
  }
  return null;
}

/** Parses `owner/name` out of an `origin` remote URL (https or ssh form).
 *  Returns null when the URL isn't a recognisable github.com remote. */
export function parseOwnerRepoFromGitUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

// ---------------------------------------------------------------------------
// Thin I/O layer — every `gh` invocation and every fs read lives below this
// line. Nothing here is exercised by the unit tests.
// ---------------------------------------------------------------------------

function extractFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

async function loadBoardConfig(root) {
  const configPath = path.join(root, '.claude', 'project-registries.json');
  if (!existsSync(configPath)) return null;
  let data;
  try {
    data = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return null;
  }
  const board = data.projects_board;
  if (!board || !board.owner || !board.number) return null;
  return board;
}

function detectRepoFromGitRemote(root) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    return parseOwnerRepoFromGitUrl(url);
  } catch {
    return null;
  }
}

async function collectStatusRecords(root) {
  const buildsDir = path.join(root, 'tasks', 'builds');
  const records = [];
  const refused = [];

  let entries;
  try {
    entries = await readdir(buildsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { records, refused };
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
      refused.push({ dir: dirName, error: `cannot read status.json: ${err.message}` });
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      refused.push({ dir: dirName, error: `invalid JSON: ${err.message}` });
      continue;
    }

    const slugError = validateSlugMatchesDir(data.slug, dirName);
    if (slugError) {
      refused.push({ dir: dirName, error: slugError });
      continue;
    }

    // Full schema validation, shared with generate-current-focus via
    // status-contract.mjs. This reader previously checked only "JSON parses"
    // and "slug matches directory", so the two consumers of the same file could
    // disagree — the generator classifying a record INVALID while board-sync
    // published it anyway. Worse, a malformed record reaching mapRecordToCard
    // threw inside the sync loop and was reported as a "gh failure", pointing
    // the operator at GitHub for a defect in local data. Refuse BEFORE any gh
    // mutation. (External review round 3.)
    const shapeError = await validateRecordShape(data);
    if (shapeError) {
      refused.push({ dir: dirName, error: shapeError });
      continue;
    }

    records.push(data);
  }

  return { records, refused };
}

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

function fetchFieldIds(owner, number) {
  const data = ghJson(['project', 'field-list', String(number), '--owner', owner, '--format', 'json']);
  const fields = {};
  for (const field of data.fields ?? []) {
    // `type` is the GraphQL typename (ProjectV2SingleSelectField vs the generic
    // ProjectV2Field for text/number/date). Kept so checkBoardContract can tell
    // a single-select apart from a text field — a Status field provisioned as
    // TEXT accepts any string, so the board would silently stop being a board.
    fields[field.name] = { id: field.id, type: field.type ?? null, options: field.options ?? [] };
  }
  return fields;
}

function fetchProjectId(owner, number) {
  const data = ghJson(['project', 'view', String(number), '--owner', owner, '--format', 'json']);
  return data.id;
}

/** Reads one custom-field value off a `gh project item-list` item, matching
 *  the field's DISPLAY name against whatever key shape gh actually emitted.
 *
 *  gh does not key field values by their display name: it lower-cases the
 *  first character and leaves the rest, so `Build Repo` comes back as
 *  `build Repo` and `Slug` as `slug`. Reading `item['Build Repo']` therefore
 *  matched nothing on a real result — item.repo and item.slug were always
 *  null, every existing card failed the "is this one of ours" test in
 *  syncBoard(), and each sync created a fresh duplicate while stale-skip,
 *  duplicate recovery and the MERGED auto-archive all stayed unreachable.
 *  That is the SAME failure the 'Repo' -> 'Build Repo' rename caused: the fix
 *  for it unified the field NAME across the read and write sites but not the
 *  key SHAPE, and the regression test built its fixture item from the code's
 *  own constant, so it asserted the assumption rather than testing it.
 *
 *  Matching runs in three passes of DECREASING precision — exact, then
 *  case-insensitive, then case-and-separator-insensitive — and the first pass
 *  that hits wins. The looser passes keep the read working if gh's
 *  transformation ever changes (that brittleness is what caused this bug), but
 *  they must never outrank a better match: on a board carrying both
 *  `Build Repo` and an operator-added `BuildRepo`, a single normalise-everything
 *  pass would bind whichever key gh happened to emit first, so the card read
 *  could silently flip between fields from run to run. Precedence makes the
 *  result deterministic and independent of key enumeration order. */
export function readItemFieldValue(item, fieldName) {
  const sources = [item, item?.fieldValues].filter((s) => s && typeof s === 'object');
  const foldCase = (k) => k.toLowerCase();
  const foldAll = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const fold of [(k) => k, foldCase, foldAll]) {
    const wanted = fold(fieldName);
    for (const source of sources) {
      for (const [key, value] of Object.entries(source)) {
        if (fold(key) === wanted) return value;
      }
    }
  }
  return null;
}

// Exported so the read side of the upsert key is directly testable. It was
// unexported when the 'Repo' -> 'Build Repo' rename silently broke it, which
// is why board-sync.test.mjs could only assert the write key and the
// divergence survived a full test run.
/** The body-marker identity, or null. Shape: `<repo>::<slug>`. */
export function extractKeyFromBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(KEY_MARKER);
  if (!match) return null;
  const sep = match[1].indexOf('::');
  if (sep <= 0 || sep === match[1].length - 2) return null;
  return { repo: canonicaliseRepo(match[1].slice(0, sep)), slug: match[1].slice(sep + 2) };
}

export function normaliseItem(item) {
  const body = item.body ?? item.content?.body ?? '';
  // Field values are the primary identity; the body key is the fallback that
  // makes a partially-created card (item-create succeeded, field edits failed)
  // recognisable instead of invisible. An adopted orphan then flows through
  // the normal update path, which re-writes its fields — self-healing rather
  // than one duplicate per sync.
  const bodyKey = extractKeyFromBody(body);
  return {
    id: item.id,
    // A card has TWO ids and they are not interchangeable: `id` is the
    // project-item id (`PVTI_…`) that field-value edits address, while
    // `contentId` is the draft-issue content id (`DI_…`) that title/body edits
    // require. Retaining it here is what lets updateCard address each edit
    // correctly; dropping it is what made every update fail (see
    // buildDraftContentEditArgs).
    contentId: item.content?.id ?? null,
    repo: canonicaliseRepo(readItemFieldValue(item, REPO_FIELD_NAME)) ?? bodyKey?.repo ?? null,
    slug: readItemFieldValue(item, 'Slug') ?? bodyKey?.slug ?? null,
    updated_at: extractUpdatedAtFromBody(body),
    body,
  };
}

/**
 * Builds the single argv that edits a draft card's title AND body together.
 *
 * Two live-verified gh constraints are encoded here, both of which a separate
 * per-field call gets wrong:
 *
 * 1. WHICH ID. `gh project item-edit` takes DIFFERENT ids for its two jobs: a
 *    field-value edit addresses the PROJECT ITEM (`PVTI_…`, with --project-id
 *    and --field-id), while a title/body edit addresses the DRAFT ISSUE
 *    CONTENT (`DI_…`) and refuses anything else with "ID must be the ID of the
 *    draft issue content which is prefixed with `DI_`".
 * 2. TOGETHER, IN ONE CALL. A draft-issue edit maps to the
 *    `updateProjectV2DraftIssue` mutation, which treats an omitted field as a
 *    blanking request: editing the body alone fails with "GraphQL: Title can't
 *    be blank". So --title and --body must travel in the SAME invocation.
 *
 * Because the sync path records gh failures as non-blocking warnings, neither
 * constraint surfaced as an error: card CREATION kept working while every card
 * UPDATE silently no-opped, so a board went permanently stale after the first
 * sync of a build. Both were found by running the sync twice against a live
 * board (gh 2.87.3) during the cryptotrackr pilot.
 *
 * Exported so a test pins both rules rather than a comment. Returns null when
 * no usable content id is available, which the caller treats as "skip
 * title/body, still write the fields" rather than as a failure.
 */
export function buildDraftContentEditArgs(contentId, card) {
  if (typeof contentId !== 'string' || !contentId.startsWith('DI_')) return null;
  if (!card || typeof card.title !== 'string' || card.title === '') return null;
  return [
    'project', 'item-edit', '--id', contentId,
    '--title', card.title, '--body', card.body ?? '', '--format', 'json',
  ];
}

function fetchExistingItems(owner, number) {
  const data = ghJson(['project', 'item-list', String(number), '--owner', owner, '--format', 'json', '-L', '200']);
  return (data.items ?? []).map(normaliseItem);
}

function setFieldValues(boardCtx, fields, itemId, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = fields[name];
    if (!field) {
      console.warn(`[board-sync] field "${name}" not found on board — run --init or check board setup`);
      continue;
    }
    const args = [
      'project', 'item-edit', '--id', itemId,
      '--project-id', boardCtx.projectId, '--field-id', field.id, '--format', 'json',
    ];
    if (field.options.length > 0) {
      const option = field.options.find((o) => o.name === value);
      if (!option) {
        console.warn(`[board-sync] field "${name}" has no option "${value}" — skipping`);
        continue;
      }
      args.push('--single-select-option-id', option.id);
    } else {
      args.push('--text', String(value));
    }
    execFileSync('gh', args, { encoding: 'utf8' });
  }
}

function createCard(boardCtx, fields, card) {
  const created = ghJson([
    'project', 'item-create', String(boardCtx.number), '--owner', boardCtx.owner,
    '--title', card.title, '--body', card.body, '--format', 'json',
  ]);
  try {
    setFieldValues(boardCtx, fields, created.id, card.fields);
  } catch (err) {
    // Compensate: a card whose field writes failed has no field identity, and
    // an unrecognisable card used to mean one fresh duplicate per sync under a
    // persistent field/permission error. Two layers of defence, deliberately
    // redundant: archive the partial item now (best effort), and even if THIS
    // archive also fails, the body key written atomically at item-create makes
    // the orphan adoptable on the next run instead of invisible.
    try {
      archiveItem(boardCtx.owner, boardCtx.number, created.id);
      console.warn(`[board-sync] field writes failed after creating ${card.key} — archived the partial card (${created.id}) to prevent duplicates: ${err.message}`);
    } catch (archiveErr) {
      console.warn(`[board-sync] field writes AND compensating archive failed for ${card.key} (${created.id}) — the body key will let the next sync adopt it: ${archiveErr.message}`);
    }
    throw err;
  }
}

function updateCard(boardCtx, fields, item, card) {
  // Field values go FIRST, deliberately. `Status` IS the board column — the
  // single most load-bearing value on the card — so a later title/body failure
  // must not be able to leave the column stale. (Before this ordering, a
  // title-edit failure aborted the whole update and the column never moved.)
  setFieldValues(boardCtx, fields, item.id, card.fields);

  const contentArgs = buildDraftContentEditArgs(item.contentId, card);
  if (!contentArgs) {
    console.warn(
      `[board-sync] no draft-issue content id for ${card.key} — field values updated, title/body left unchanged`
    );
    return;
  }
  execFileSync('gh', contentArgs, { encoding: 'utf8' });
}

function archiveItem(owner, number, itemId) {
  execFileSync('gh', ['project', 'item-archive', String(number), '--id', itemId, '--owner', owner, '--format', 'json'], {
    encoding: 'utf8',
  });
}

async function runInit(owner, title) {
  console.log(`[board-sync] --init: creating project "${title}" for ${owner}...`);
  const project = ghJson(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
  console.log(`[board-sync] --init: created project number ${project.number} (id ${project.id}).`);

  const existingFields = fetchFieldIds(owner, project.number);
  for (const fieldSpec of BOARD_FIELDS_TO_CREATE) {
    if (existingFields[fieldSpec.name]) {
      console.log(
        `[board-sync] --init: field "${fieldSpec.name}" already exists — reusing. If this is the ` +
          `default "Status" field, confirm its options match ${(fieldSpec.options || []).join('/')} ` +
          'via the web UI (no field-edit subcommand exists to do this from the CLI, so this is the ' +
          'one genuinely manual step). A status the board lacks cannot be written to a card.'
      );
      continue;
    }
    const args = [
      'project', 'field-create', String(project.number), '--owner', owner,
      '--name', fieldSpec.name, '--data-type', fieldSpec.dataType, '--format', 'json',
    ];
    if (fieldSpec.options) args.push('--single-select-options', fieldSpec.options.join(','));
    ghJson(args);
    console.log(`[board-sync] --init: created field "${fieldSpec.name}".`);
  }

  console.log(
    '[board-sync] --init complete. Record this in .claude/project-registries.json:\n' +
      `  "projects_board": { "owner": "${owner}", "number": ${project.number} }`
  );
}

/**
 * Verifies the LIVE board can carry every status this schema can produce.
 * Returns an error string, or null when the board is compatible.
 *
 * Exported for tests. Takes the already-fetched field map so it makes no
 * network calls of its own.
 */
export async function checkBoardContract(fields) {
  // Required-field list is derived from the same constant --init provisions
  // from, so "what we create" and "what we require" cannot drift.
  const missing = BOARD_FIELDS_TO_CREATE.map((f) => f.name).filter((n) => !fields[n]);
  if (missing.length > 0) {
    return `board is missing required field(s): ${missing.join(', ')}. Present: ${Object.keys(fields).join(', ') || '(none)'}.`;
  }

  // Type check, in the only direction gh's field-list can actually resolve: it
  // reports the GraphQL typename, so SINGLE_SELECT is distinguishable but TEXT
  // and DATE are not (both are the generic ProjectV2Field). We therefore assert
  // single-select-ness rather than inventing a precision gh does not give us —
  // and that IS the failure mode: a Status provisioned as text swallows any
  // string, and a text field provisioned as single-select rejects every write.
  for (const spec of BOARD_FIELDS_TO_CREATE) {
    const isSingleSelect = isSingleSelectField(fields[spec.name]);
    const wantSingleSelect = spec.dataType === 'SINGLE_SELECT';
    if (isSingleSelect !== wantSingleSelect) {
      return wantSingleSelect
        ? `board field "${spec.name}" must be a single-select, but it is not. It cannot carry status columns.`
        : `board field "${spec.name}" is a single-select, but it must be a plain text field. Free-text values cannot be written to it.`;
    }
  }

  const statusEnum = await readStatusEnum();
  if (!statusEnum) {
    // NOT a pass. Returning null here would mean "contract valid", so an absent
    // or corrupt schema would silently switch off the guard that exists to stop
    // split-brain cards — precisely when we can least justify writing. The
    // schema ships with the framework; not finding it means a broken sync.
    // (External review round 4.)
    return 'cannot read schemas/build-status.schema.json, so the required Status options are unknown. '
      + 'Refusing board mutations rather than writing statuses this board may not be able to display.';
  }

  const liveOptions = fields.Status.options.map((o) => o.name);
  const missingOptions = statusEnum.filter((s) => !liveOptions.includes(s));
  if (missingOptions.length > 0) {
    return `board field "Status" is missing option(s): ${missingOptions.join(', ')}. `
      + `Present: ${liveOptions.join(', ') || '(none)'}. Required by schemas/build-status.schema.json: ${statusEnum.join(', ')}.`;
  }
  return null;
}

/**
 * Non-fatal board hygiene: options the board carries that the schema does not,
 * and an option order that does not match the pipeline order.
 * Returns an array of warning strings (empty when the board is exactly right).
 *
 * Deliberately SEPARATE from checkBoardContract, and deliberately non-fatal.
 * The split is by consequence, not by tidiness:
 *   - A MISSING option means a status cannot be written at all. Cards would
 *     disagree with their own column. That is a correctness failure -> refuse.
 *   - An EXTRA option, or the right options in the wrong order, still writes
 *     every status correctly. It is a display problem. Refusing all mutations
 *     over column order would take the board offline for a cosmetic issue, and
 *     would also brick the board of an operator who deliberately added a column
 *     of their own. So: say it loudly, every run, and keep writing.
 * External review round 4 asked for exact-match refusal here; this reports the
 * same three categories separately, as asked, but only escalates the one that
 * corrupts data.
 */
export async function checkBoardHygiene(fields) {
  const statusEnum = await readStatusEnum();
  if (!statusEnum || !fields?.Status?.options) return [];

  const liveOptions = fields.Status.options.map((o) => o.name);
  const warnings = [];

  const extras = liveOptions.filter((name) => !statusEnum.includes(name));
  if (extras.length > 0) {
    warnings.push(
      `board field "Status" carries option(s) the schema does not define: ${extras.join(', ')}. `
      + 'A near-miss spelling of a real status (a leftover from a part-finished migration) shows as its own column '
      + 'and is easy to mistake for the real one. Delete them in the web UI unless they are deliberate.'
    );
  }

  // Order is only meaningful once membership matches; otherwise the extras/
  // missing warnings already say everything useful and an order complaint on
  // top of them is noise.
  const orderable = liveOptions.filter((name) => statusEnum.includes(name));
  if (extras.length === 0 && orderable.length === statusEnum.length) {
    const outOfOrder = orderable.some((name, i) => name !== statusEnum[i]);
    if (outOfOrder) {
      warnings.push(
        `board field "Status" lists its options in a different order to the pipeline. `
        + `Board: ${liveOptions.join(', ')}. Pipeline: ${statusEnum.join(', ')}. `
        + 'Cards still land in the right column; the columns just read out of sequence left to right.'
      );
    }
  }
  return warnings;
}

/** True when a live field is a single-select. Typename first; option presence
 *  is the fallback for gh versions that omit `type` from field-list. */
function isSingleSelectField(field) {
  if (!field) return false;
  if (typeof field.type === 'string' && field.type.length > 0) {
    return field.type.includes('SingleSelect');
  }
  return (field.options?.length ?? 0) > 0;
}

async function syncBoard(root, repository, boardConfig) {
  const { records, refused } = await collectStatusRecords(root);
  for (const r of refused) {
    console.warn(`[board-sync] REFUSED ${r.dir}: ${r.error}`);
  }
  if (records.length === 0) {
    console.log('[board-sync] no builds to sync.');
    return;
  }

  let fields;
  let projectId;
  let existingItems;
  try {
    fields = fetchFieldIds(boardConfig.owner, boardConfig.number);
    projectId = fetchProjectId(boardConfig.owner, boardConfig.number);
    existingItems = fetchExistingItems(boardConfig.owner, boardConfig.number);
  } catch (err) {
    const diagnostic = classifyBoardPermissionError(err);
    console.warn(
      `[board-sync] gh failure reading board state — recorded, non-blocking: ${err.message}`
      + (diagnostic ? ` [diagnostic: ${diagnostic}]` : '')
    );
    markNotSynced(notSyncedReasonFromDiagnostic(diagnostic));
    return;
  }

  // Live-board contract check — BEFORE any mutation, and it refuses the whole
  // run rather than degrading per card.
  //
  // Without it, a board still provisioned under build-status.v1 produced a
  // SPLIT-BRAIN card: updateCard set the title and body (which say TESTING),
  // setFieldValues could not find the TESTING option, warned, skipped the
  // Status field, and the run exited successfully because board failures are
  // deliberately non-blocking. The card body and the board column then
  // disagreed, for exactly the three statuses the migration added — the states
  // whose visibility was the entire point of the change. A per-card warning is
  // the wrong granularity for a schema mismatch: it is a property of the board,
  // so it is checked once and stops everything. (External review round 3.)
  const contractError = await checkBoardContract(fields);
  if (contractError) {
    console.warn(
      `[board-sync] BOARD CONTRACT MISMATCH — no cards were written.\n` +
      `  ${contractError}\n` +
      `  The board must be migrated before it can carry this build's status. The Status field's\n` +
      `  single-select options cannot be edited from the CLI, so this is a web-UI step:\n` +
      `  Project settings -> Status -> add the missing options, then delete any that are not listed.\n` +
      `  Refusing all writes rather than updating card bodies whose Status column would then be stale.`
    );
    markNotSynced(NOT_SYNCED_REASONS.BOARD_CONTRACT_MISMATCH);
    return;
  }

  for (const warning of await checkBoardHygiene(fields)) {
    console.warn(`[board-sync] board hygiene: ${warning}`);
  }

  const boardCtx = { owner: boardConfig.owner, number: boardConfig.number, projectId };

  const byKey = new Map();
  for (const item of existingItems) {
    if (!item.repo || !item.slug) continue; // not one of ours
    const key = buildCardKey(item.repo, item.slug);
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }

  const now = new Date();

  for (const record of records) {
    try {
      const card = mapRecordToCard(record, repository);
      const bucket = byKey.get(card.key) ?? [];
      const { survivor, toArchive } = chooseSurvivor(bucket);

      for (const dup of toArchive) {
        console.warn(`[board-sync] duplicate card for ${card.key} — archiving ${dup.id}, keeping ${survivor.id}`);
        archiveItem(boardCtx.owner, boardCtx.number, dup.id);
      }

      // One decision, made in a pure function (decideCardAction) so the
      // accept-then-archive invariant is testable. Previously the loop
      // evaluated archival independently of the stale check, so a stale
      // terminal record archived a NEWER active card: existing card updated
      // 28 Jul, incoming MERGED record dated 1 Jul -> update correctly skipped,
      // then the newer card archived on the strength of the record just
      // rejected. Duplicate archival above is unaffected — it keys on card
      // identity, not on the incoming record's freshness.
      const action = decideCardAction(survivor, record, now);

      if (action.create) {
        createCard(boardCtx, fields, card);
      } else if (action.skipped) {
        console.warn(
          `[board-sync] skip ${card.key} — existing card is newer than the incoming record ` +
            `(no update, and no archival: a record too stale to apply is too stale to archive on)`
        );
      } else if (action.update) {
        updateCard(boardCtx, fields, survivor, card);
      }

      if (action.archive && survivor) {
        archiveItem(boardCtx.owner, boardCtx.number, survivor.id);
      }
    } catch (err) {
      const diagnostic = classifyBoardPermissionError(err);
      console.warn(
        `[board-sync] gh failure syncing ${record.slug} — recorded, non-blocking: ${err.message}`
        + (diagnostic ? ` [diagnostic: ${diagnostic}]` : '')
      );
      // Per-card failure still means a card the operator expects to see did
      // not move. Same signal as a whole-run failure: a silently stale card is
      // exactly the class of bug this marker exists to surface.
      markNotSynced(notSyncedReasonFromDiagnostic(diagnostic));
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(extractFlagValue(argv, '--root') ?? process.cwd());
  const repoFlag = extractFlagValue(argv, '--repo');
  const isInit = argv.includes('--init');

  if (isInit) {
    const owner = extractFlagValue(argv, '--owner');
    const title = extractFlagValue(argv, '--title');
    if (!owner || !title) {
      console.error('[board-sync] --init requires --owner <login> --title <title>');
      process.exitCode = 1;
      return;
    }
    await runInit(owner, title);
    return;
  }

  const boardConfig = await loadBoardConfig(root);
  if (!boardConfig) {
    console.warn(
      '[board-sync] projects_board not configured in .claude/project-registries.json — skipping sync (board is a view, not a gate)'
    );
    markNotSynced(NOT_SYNCED_REASONS.NO_CONFIG);
    return;
  }

  const repository = repoFlag ?? detectRepoFromGitRemote(root);
  if (!repository) {
    console.warn('[board-sync] could not determine repository identity (no --repo and no git remote) — skipping sync');
    markNotSynced(NOT_SYNCED_REASONS.NO_REPO_IDENTITY);
    return;
  }

  await syncBoard(root, repository, boardConfig);
}

// Entry-point guard: this module is imported directly by board-sync.test.mjs
// to reach the pure functions above, so main() must NOT run as a side effect
// of import — only when this file is executed as a script. Without this
// guard, importing the module in a test process would unconditionally shell
// out toward `gh` the moment `projects_board` is ever configured.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.warn(`[board-sync] unexpected error — recorded, non-blocking: ${err.message}`);
    markNotSynced(NOT_SYNCED_REASONS.UNEXPECTED_ERROR);
  });
}
