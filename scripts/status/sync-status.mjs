/**
 * sync-status.mjs — the ONE status-sync command coordinators cite.
 *
 * WHY THIS EXISTS (D1/D2/D3, PR #828 finalisation)
 * A status transition required running generate-current-focus.mjs AND
 * board-sync.mjs, stated as a two-command sequence in prose. A rule an agent
 * can half-execute silently is a framework defect, not an agent error: in the
 * observed incident the generator ran and board-sync was skipped, the local
 * file said MERGED, the operator's board said FINALISING, and nothing detected
 * the skip. This wrapper makes the pair a single mechanism, and — the part
 * prose could never do — VALIDATES the load-bearing target record before it
 * touches the board, so a schema-invalid write (a numeric run_id, D2) is
 * refused loudly at write time instead of silently downstream.
 *
 *   node scripts/status/sync-status.mjs --slug <slug> [--expect-status STATUS]
 *        [--require-handover] [--root <dir>] [--repo <owner/name>]
 *   node scripts/status/sync-status.mjs --all [--root <dir>] [--repo <owner/name>]
 *
 * --slug is the coordinator mode and is NOT optional: a bare invocation would
 * satisfy the CI grep-gate (the pair is now unciteable) while bypassing the
 * target validation this exists to add, re-opening the exact hole. --all is a
 * visibly distinct maintenance sweep with no target semantics; coordinators
 * never cite it.
 *
 * TESTABILITY SEAM: runSyncStatus takes an injectable `deps = {runGenerator,
 * runBoardSync}`. Tests inject fakes and assert invocation ORDER and
 * short-circuiting without executing the real children; the CLI passes the real
 * ones. This mirrors the pure-core/thin-I/O convention board-sync.mjs follows.
 *
 * EXIT CONTRACT (also stated once in each coordinator's § Status contract):
 *   0  local projection succeeded AND the target's board projection was
 *      applied / already equivalent / created           → continue
 *   1  generator hard error                              → STOP the transition
 *   2  target record invalid or unresolvable            → STOP; fix + re-run
 *      (missing / unreadable / invalid_json / schema_invalid / slug_mismatch /
 *       status_mismatch / handover_incomplete / non_terminal_archive / usage)
 *   3  board not synced (unreachable / permissions / gh  → report to operator,
 *      failure, or target present but not projected)        continue; archive
 *                                                            eligibility per the
 *                                                            W3(a) table, keyed
 *                                                            on the printed
 *                                                            target outcome
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecordShape } from './status-contract.mjs';
import { runBoardSync } from './board-sync.mjs';

const GENERATOR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'generate-current-focus.mjs'
);

/** The schema's kebab-case slug pattern (build-status.schema.json). Validated
 *  BEFORE any path is built, so a value like `../../x` never reaches the fs. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Terminal statuses. A record resolved from _archive/ that is NOT terminal is
 *  a mis-archive, never "carry on". */
const TERMINAL_STATUSES = new Set(['MERGED', 'ABANDONED']);

/** Outcomes that count as the target's card reaching the board. */
const TARGET_SUCCESS = new Set(['applied', 'equivalent', 'created']);

export const SYNC_EXIT = Object.freeze({
  OK: 0,
  GENERATOR_ERROR: 1,
  INVALID_TARGET: 2,
  BOARD_NOT_SYNCED: 3,
});

/** Closed reason→remediation map (printed next to the board reason; never
 *  guessed). `reasons` is a list — one board run can carry several, each mapped
 *  independently. The drifting `-s project` vs `-s read:project` strings that
 *  coordinators retyped are pinned here once. */
const REMEDIATIONS = Object.freeze({
  no_config: 'add `projects_board` to .claude/project-registries.json',
  no_repo_identity: 'pass --repo <owner/name> or repair the `origin` remote',
  missing_project_scope: 'gh auth refresh -s project',
  missing_board_access: 'verify board owner/number and account access',
  board_contract_mismatch: 'migrate board fields/options (see the board-sync guidance printed above)',
  gh_failure: 'see the [board-sync] gh diagnostic printed above; no generic remediation',
  unexpected_error: 'see the [board-sync] diagnostic + cause printed above',
  // C2 outcomes — mapped so every exit-3 reason prints a remediation (the
  // coordinator contract), not a bare reason.
  inventory_incomplete: 'the board inventory could not be fully read (pagination did not reach totalCount); board-sync made ZERO changes to avoid a duplicate — re-run once the board is reachable and complete',
  unrecovered: 'an archived-card update could not be rolled back by this run; the next sync reconciles it — see the [board-sync] UNRECOVERED diagnostics above',
});

/**
 * Validates a post-merge handover markdown blob against the fixed W6 contract:
 * the `## Post-merge handover` heading, the three subheads, the
 * `### Follow-on triage` subsection, and per-section either real content or the
 * mandated empty-state literal (so absence is always distinguishable from
 * omission). Returns null when complete, or a short reason string.
 *
 * Pure and exported so both this wrapper (--require-handover) and the
 * source-contract test can assert one definition of "complete". When `slug` is
 * given, the `**Shipped:**` line's slug must match it — the wrapper always
 * passes the --slug target, so the provenance line cannot name a different build.
 */
export function validatePostMergeHandover(markdown, { slug = null } = {}) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return 'handover file is empty or missing';
  }

  const HEADING = '## Post-merge handover';
  const headingIdx = markdown.indexOf(HEADING);
  if (headingIdx === -1) return `missing heading "${HEADING}"`;

  // Bound the section to the next same-or-higher-level heading, never a `---`
  // rule (a formatting token any later editor may add).
  const rest = markdown.slice(headingIdx + HEADING.length);
  const nextHeading = rest.search(/\n#{1,2} /);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  // Provenance line — the whole point of a durable, greppable handover is that
  // it names WHICH merge it belongs to. Require `**Shipped:** PR #<n> · <slug>
  // · squash <sha> · <date>` and validate its shape, not just the subheads.
  const shipped = section.match(
    /\*\*Shipped:\*\*\s*PR #(\d+)\s*·\s*([a-z0-9][a-z0-9-]*)\s*·\s*squash\s*([0-9a-f]{7,40})\s*·\s*(\S[^\n]*)/
  );
  if (!shipped) {
    return 'missing or malformed "**Shipped:**" line (expected: PR #<n> · <slug> · squash <sha> · <date>)';
  }
  if (slug && shipped[2] !== slug) {
    return `the "**Shipped:**" slug "${shipped[2]}" does not match the target build "${slug}"`;
  }

  // Empty-state literal for the triage ledger: a genuinely clean build (nothing
  // added to tasks/todo.md, no deferrals, no REVIEW_GAP) has zero follow-on
  // items, so the ledger is legitimately empty — it needs an empty-state line
  // the way the two sections above do, or a valid clean build could never
  // produce a complete handover and its terminal sync would hard-fail.
  const LEDGER_EMPTY = 'None: no follow-on items.';
  const markers = [
    { key: '**What was built**', literal: null },
    { key: '**To enable / configure**', literal: 'None: live on deploy.' },
    { key: '**Urgent follow-on engineering**', literal: /None urgent: \d+ routine item\(s\) in the backlog\./ },
    { key: '### Follow-on triage', literal: null },
  ];

  // Presence + order.
  const positions = [];
  for (const { key } of markers) {
    const idx = section.indexOf(key);
    if (idx === -1) return `missing subhead "${key}"`;
    positions.push(idx);
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) return `subhead "${markers[i].key}" is out of order`;
  }

  // Per-section content: real bullet(s) OR the mandated literal.
  for (let i = 0; i < markers.length; i++) {
    const start = positions[i] + markers[i].key.length;
    const end = i + 1 < positions.length ? positions[i + 1] : section.length;
    const body = section.slice(start, end);
    const bullets = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^-\s+\S/.test(l));

    if (markers[i].key === '### Follow-on triage') {
      // Every ledger line carries an explicit urgent-now / routine verdict; a
      // clean build with no items uses the empty-state literal instead.
      const ledger = bullets.filter((l) => /\|\s*(urgent-now|routine)\s*\|/.test(l));
      if (ledger.length === 0 && !body.includes(LEDGER_EMPTY)) {
        return 'the "### Follow-on triage" ledger has no `<ref> | urgent-now|routine | reason` lines and no empty-state literal';
      }
      continue;
    }

    const literal = markers[i].literal;
    const hasLiteral = literal
      ? (typeof literal === 'string' ? body.includes(literal) : literal.test(body))
      : false;
    if (!hasLiteral && bullets.length === 0) {
      return literal
        ? `section "${markers[i].key}" is empty — add content or the literal empty-state line`
        : `section "${markers[i].key}" has no content`;
    }
  }

  return null;
}

/** Default child: spawn the generator, teeing its output to the terminal.
 *  Returns { exitCode }. A non-zero exit is the "generator hard error blocks
 *  the transition" signal. */
function defaultRunGenerator({ root }) {
  try {
    execFileSync('node', [GENERATOR_PATH, '--root', root], { stdio: 'inherit' });
    return { exitCode: 0 };
  } catch (err) {
    return { exitCode: typeof err.status === 'number' ? err.status : 1 };
  }
}

function usage(message) {
  console.error(`[sync-status] usage error: ${message}`);
  console.error('  node scripts/status/sync-status.mjs --slug <slug> [--expect-status STATUS] [--require-handover] [--root <dir>] [--repo <owner/name>]');
  console.error('  node scripts/status/sync-status.mjs --all [--root <dir>] [--repo <owner/name>]');
  return { exitCode: SYNC_EXIT.INVALID_TARGET, stage: 'usage' };
}

function invalidTarget(slug, reason, detail = null) {
  console.error(`[sync-status] INVALID_TARGET slug=${slug} reason=${reason}${detail ? ` — ${detail}` : ''}`);
  return { exitCode: SYNC_EXIT.INVALID_TARGET, stage: 'validation', reason, targetOutcome: null };
}

function reportBoard(board) {
  for (const reason of board.reasons ?? []) {
    const remediation = REMEDIATIONS[reason];
    console.warn(`[sync-status] board reason=${reason}${remediation ? ` — remediation: ${remediation}` : ''}`);
  }
}

/**
 * The wrapper core. See the file header for the exit contract. Returns
 * `{ exitCode, stage, reason?, targetOutcome? }`; the CLI translates exitCode
 * to process.exitCode. Never mutates process state itself.
 */
export async function runSyncStatus({
  root = process.cwd(),
  slug = null,
  all = false,
  repo = null,
  expectStatus = null,
  requireHandover = false,
  deps = {},
} = {}) {
  const runGenerator = deps.runGenerator ?? defaultRunGenerator;
  const runBoardSyncFn = deps.runBoardSync ?? runBoardSync;

  // Mode resolution — exactly one of --slug / --all.
  if (slug && all) return usage('--slug and --all are mutually exclusive');
  if (!slug && !all) return usage('one of --slug <slug> or --all is required');

  if (all) {
    const gen = await runGenerator({ root });
    if (gen.exitCode !== 0) {
      console.error('[sync-status] generator hard error — transition blocked (exit 1)');
      return { exitCode: SYNC_EXIT.GENERATOR_ERROR, stage: 'generator' };
    }
    const board = await runBoardSyncFn({ root, repo, targetSlug: null });
    reportBoard(board);
    return {
      exitCode: board.exitCode === 3 ? SYNC_EXIT.BOARD_NOT_SYNCED : SYNC_EXIT.OK,
      stage: 'board',
      reasons: board.reasons,
    };
  }

  // ---- --slug mode: containment BEFORE any path is built ----
  if (!SLUG_PATTERN.test(slug)) {
    return invalidTarget(slug, 'invalid_slug', 'not a kebab-case slug — refused before any path is read');
  }

  const buildsDir = path.join(root, 'tasks', 'builds');
  const activePath = path.join(buildsDir, slug, 'status.json');
  const archivePath = path.join(buildsDir, '_archive', slug, 'status.json');
  // Defence in depth: even a pattern-valid slug must resolve under builds/.
  const buildsPrefix = path.resolve(buildsDir) + path.sep;
  if (!path.resolve(activePath).startsWith(buildsPrefix)
      || !path.resolve(archivePath).startsWith(buildsPrefix)) {
    return invalidTarget(slug, 'invalid_slug', 'resolved target escapes tasks/builds/');
  }

  // ---- resolution ----
  const activeExists = existsSync(activePath);
  const archiveExists = existsSync(archivePath);
  let targetPath;
  let fromArchive;
  if (activeExists && archiveExists) {
    console.warn(`[sync-status] duplicate-location slug=${slug} — active copy wins over _archive/, proceeding`);
    targetPath = activePath;
    fromArchive = false;
  } else if (activeExists) {
    targetPath = activePath;
    fromArchive = false;
  } else if (archiveExists) {
    targetPath = archivePath;
    fromArchive = true;
  } else {
    return invalidTarget(slug, 'missing', 'no status.json under tasks/builds/ or tasks/builds/_archive/');
  }

  // ---- validation (blocking; runs NO children) ----
  let raw;
  try {
    raw = await readFile(targetPath, 'utf8');
  } catch (err) {
    return invalidTarget(slug, 'unreadable', err.message);
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return invalidTarget(slug, 'invalid_json', err.message);
  }

  const shapeError = await validateRecordShape(record);
  if (shapeError) return invalidTarget(slug, 'schema_invalid', shapeError);

  if (record.slug !== slug) {
    return invalidTarget(slug, 'slug_mismatch', `record.slug=${JSON.stringify(record.slug)} does not match the directory`);
  }

  if (expectStatus && record.status !== expectStatus) {
    return invalidTarget(slug, 'status_mismatch', `expected ${expectStatus}, record is ${record.status}`);
  }

  if (fromArchive && !TERMINAL_STATUSES.has(record.status)) {
    return invalidTarget(slug, 'non_terminal_archive', `archived record is ${record.status}, not terminal`);
  }

  if (requireHandover) {
    const handoverPath = path.join(path.dirname(targetPath), 'handoff.md');
    let handover = '';
    try {
      handover = existsSync(handoverPath) ? await readFile(handoverPath, 'utf8') : '';
    } catch {
      handover = '';
    }
    const handoverError = validatePostMergeHandover(handover, { slug });
    if (handoverError) return invalidTarget(slug, 'handover_incomplete', handoverError);
  }

  // ---- children: generator first, then board-sync ----
  const gen = await runGenerator({ root });
  if (gen.exitCode !== 0) {
    console.error('[sync-status] generator hard error — transition blocked (exit 1)');
    return { exitCode: SYNC_EXIT.GENERATOR_ERROR, stage: 'generator' };
  }

  const board = await runBoardSyncFn({ root, repo, targetSlug: slug });
  reportBoard(board);
  const targetOutcome = board.target?.outcome ?? 'absent';

  // Success is keyed on the TARGET, never the global exit code — an unrelated
  // historical record's gh_failure raises board.exitCode to 3, but if THIS
  // slug's card was applied/equivalent/created the transition succeeded. Keying
  // on the global code here would be the false-failure the target-aware
  // contract exists to prevent (a ~43-minute labelled run discarded for a
  // stranger's rotten record).
  if (TARGET_SUCCESS.has(targetOutcome)) {
    return { exitCode: SYNC_EXIT.OK, stage: 'board', targetOutcome, reasons: board.reasons };
  }

  // Target NOT projected: board unreachable (target 'absent'), a gh failure on
  // the target, or a logical conflict (stale_conflict / partial / refused).
  // Report + defer per W3(a), never block, never a false success. The printed
  // targetOutcome is what the archive-eligibility table keys on.
  console.warn(`[sync-status] target ${slug} not projected to the board — outcome=${targetOutcome} (archive eligibility per W3a)`);
  return { exitCode: SYNC_EXIT.BOARD_NOT_SYNCED, stage: 'board', targetOutcome, reasons: board.reasons };
}

function extractFlag(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runSyncStatus({
    root: path.resolve(extractFlag(argv, '--root') ?? process.cwd()),
    slug: extractFlag(argv, '--slug'),
    all: argv.includes('--all'),
    repo: extractFlag(argv, '--repo'),
    expectStatus: extractFlag(argv, '--expect-status'),
    requireHandover: argv.includes('--require-handover'),
  });
  if (result.exitCode) process.exitCode = result.exitCode;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[sync-status] unexpected error: ${err.message}`);
    process.exitCode = SYNC_EXIT.INVALID_TARGET;
  });
}
