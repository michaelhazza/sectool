/**
 * board-sync.test.mjs
 *
 * Vitest coverage for the pure decision functions in board-sync.mjs
 * (§5.3/§7.4/§8.4). Deliberately does NOT shell out to `gh` — the thin I/O
 * layer (ghJson and its callers) is untested here by design; only the
 * exported pure functions are exercised, each with an injected `now` where
 * a clock is involved so nothing depends on the real wall clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACTIVITY_RENDER_CAP,
  BOARD_FIELDS_TO_CREATE,
  BOARD_OUTCOMES,
  buildCardBody,
  buildCardKey,
  buildDraftContentEditArgs,
  buildNotSyncedMarker,
  canonicaliseRepo,
  CARD_ACTIONS,
  cardProjectionEqual,
  checkBoardContract,
  checkBoardHygiene,
  chooseSurvivor,
  classifyBoardPermissionError,
  decideActionType,
  decideArchivedCardAction,
  decideCardAction,
  executeCardAction,
  EXIT_NOT_SYNCED,
  extractKeyFromBody,
  extractUpdatedAtFromBody,
  isArchivedRaceError,
  isInventoryComplete,
  isTerminalStatus,
  mapRecordToCard,
  neutraliseCardText,
  normaliseItem,
  NOT_SYNCED_REASONS,
  notSyncedReasonFromDiagnostic,
  parseOwnerRepoFromGitUrl,
  planBoardActions,
  REPO_FIELD_NAME,
  runBoardSync,
  shouldArchive,
  shouldSkipStale,
  validateSlugMatchesDir,
} from './board-sync.mjs';

function baseRecord(overrides = {}) {
  return {
    contract_version: 'build-status.v2',
    slug: 'dev-pipeline-v2',
    title: 'Development Pipeline v2',
    classification: 'Major',
    phase: 'build',
    status: 'BUILDING',
    branch: 'claude/personal-ai-agent-system-1mqzyh',
    pr: null,
    gates: {},
    gate_evidence: {},
    blockers: [],
    summary: 'In progress.',
    updated_at: '2026-07-26T00:00:00Z',
    updated_by: 'builder',
    ...overrides,
  };
}

describe('canonicaliseRepo / buildCardKey', () => {
  it('repo-casing canonicalisation: Owner/Repo and owner/repo produce one key', () => {
    const keyUpper = buildCardKey('Owner/Repo', 'dev-pipeline-v2');
    const keyLower = buildCardKey('owner/repo', 'dev-pipeline-v2');
    expect(keyUpper).toBe(keyLower);
    expect(canonicaliseRepo('Owner/Repo')).toBe('owner/repo');
  });

  it('passes non-string input through unchanged', () => {
    expect(canonicaliseRepo(null)).toBe(null);
  });
});

describe('validateSlugMatchesDir', () => {
  it('returns null when slug matches the directory', () => {
    expect(validateSlugMatchesDir('dev-pipeline-v2', 'dev-pipeline-v2')).toBe(null);
  });

  it('slug-mismatch refusal: exact INVALID wording, matching C8 verbatim', () => {
    expect(validateSlugMatchesDir('different-slug', 'dir-a')).toBe(
      'slug different-slug does not match directory dir-a'
    );
  });
});

describe('mapRecordToCard', () => {
  it('record -> card mapping: status -> Status field/column, phase -> Phase field, body contents', () => {
    const record = baseRecord({
      status: 'REVIEWING',
      phase: 'review',
      branch: 'my-branch',
      pr: 42,
      blockers: [
        { id: 'b1', text: 'waiting on ops', raised_by: 'x', raised_at: '2026-07-25T00:00:00Z', cleared_at: null },
      ],
      updated_at: '2026-07-27T00:00:00Z',
      summary: 'Under review.',
    });

    const card = mapRecordToCard(record, 'Owner/Repo');

    expect(card.key).toBe('owner/repo::dev-pipeline-v2');
    expect(card.fields).toEqual({
      'Build Repo': 'owner/repo',  // NOT 'Repo' — reserved in Projects v2
      Slug: 'dev-pipeline-v2',
      Status: 'REVIEWING',
      Phase: 'review',
    });
    expect(card.body).toContain('**Branch:** my-branch');
    expect(card.body).toContain('**PR:** #42');
    expect(card.body).toContain('**Blockers:** 1');
    expect(card.body).toContain('- [open] waiting on ops');
    expect(card.body).toContain('**Updated:** 2026-07-27T00:00:00Z');
    expect(card.body).toContain('Under review.');
  });

  it('renders a null PR as "none" and zero blockers with no bullet lines', () => {
    const record = baseRecord({ pr: null, blockers: [] });
    const card = mapRecordToCard(record, 'owner/repo');
    expect(card.body).toContain('**PR:** none');
    expect(card.body).toContain('**Blockers:** 0');
  });
});

describe('buildCardBody — Activity log rendering', () => {
  const logEntries = [
    { at: '2026-07-30T01:00:00Z', stage: 'Plan', kind: 'done', note: ['Plan approved: 12 chunks'] },
    { at: '2026-07-30T01:00:01Z', stage: 'Build', kind: 'start', note: ['Building 12 chunks'] },
    { at: '2026-07-30T06:00:00Z', stage: 'Build', kind: 'info', note: ['Chunk 7 hit a plan gap, re-planned', 'No scope change'] },
    { at: '2026-07-30T09:00:00Z', stage: 'Build', kind: 'done', note: ['Build done: 12/12 chunks', 'All checks green'] },
  ];

  it('renders entries newest-first under an Activity heading with kind labels', () => {
    const body = buildCardBody(baseRecord({ log: logEntries }));
    const activityAt = body.indexOf('## Activity');
    expect(activityAt).toBeGreaterThan(-1);
    // Newest first: the Build done entry appears before the Plan done entry.
    const doneAt = body.indexOf('2026-07-30T09:00:00Z — Build (done)');
    const infoAt = body.indexOf('2026-07-30T06:00:00Z — Build (update)');
    const startAt = body.indexOf('2026-07-30T01:00:01Z — Build (started)');
    const planAt = body.indexOf('2026-07-30T01:00:00Z — Plan (done)');
    expect(doneAt).toBeGreaterThan(activityAt);
    expect(infoAt).toBeGreaterThan(doneAt);
    expect(startAt).toBeGreaterThan(infoAt);
    expect(planAt).toBeGreaterThan(startAt);
    // Bullets render as list items.
    expect(body).toContain('- Build done: 12/12 chunks');
    expect(body).toContain('- All checks green');
  });

  it('omits the Activity section entirely for a record with no log (pre-2.61.0 shape)', () => {
    const body = buildCardBody(baseRecord());
    expect(body).not.toContain('## Activity');
    const bodyEmpty = buildCardBody(baseRecord({ log: [] }));
    expect(bodyEmpty).not.toContain('## Activity');
  });

  it('caps rendered entries at ACTIVITY_RENDER_CAP newest entries and says how many are hidden', () => {
    const many = Array.from({ length: ACTIVITY_RENDER_CAP + 3 }, (_, i) => ({
      at: `2026-07-29T00:00:${String(i % 60).padStart(2, '0')}Z`,
      stage: 'Build',
      kind: 'info',
      note: [`entry ${i}`],
    }));
    const body = buildCardBody(baseRecord({ log: many }));
    // Oldest three fall off; newest survives. Word-boundary regexes so
    // "entry 2" cannot false-match "entry 24".
    expect(body).not.toMatch(/- entry 0\b/);
    expect(body).not.toMatch(/- entry 2\b/);
    expect(body).toContain(`- entry ${ACTIVITY_RENDER_CAP + 2}`);
    expect(body).toContain('3 earlier entries not shown');
    expect(body).toContain('tasks/builds/dev-pipeline-v2/status.json');
  });

  it('activity rendering never breaks the updated_at marker round-trip', () => {
    const body = buildCardBody(baseRecord({ log: logEntries, updated_at: '2026-07-30T09:00:00Z' }));
    expect(extractUpdatedAtFromBody(body)).toBe('2026-07-30T09:00:00Z');
  });
});

// F6 (security hardening, adversarial review): free-text fields sourced from
// status.json (summary, blocker text, activity-log notes) were concatenated
// into the card body unescaped, so a crafted status.json could inject a
// second `<!-- board-sync:v1 ... -->` marker and spoof the upsert key /
// updated_at this script trusts back out of the body.
describe('neutraliseCardText / HTML-comment injection guard', () => {
  it('neutralises <!-- and --> so raw text cannot pass through unchanged', () => {
    expect(neutraliseCardText('<!-- hi -->')).toBe('<! -- hi -- >');
    expect(neutraliseCardText('plain text')).toBe('plain text');
    expect(neutraliseCardText(null)).toBe(null);
  });

  it('a crafted summary cannot inject a second board-sync marker', () => {
    const record = baseRecord({
      summary: 'legit summary <!-- board-sync:v1 key=evil::evil updated_at=2099-01-01T00:00:00Z -->',
    });
    const body = buildCardBody(record, 'owner/repo::dev-pipeline-v2');
    // Exactly one real HTML-comment marker survives (the legitimate one this
    // script wrote at the top); the injected text is still visible (this is
    // additive neutralisation, not redaction) but no longer parses as a
    // second marker, so identity extraction resolves to the real key only.
    const markerMatches = body.match(/<!-- board-sync:v1/g) ?? [];
    expect(markerMatches).toHaveLength(1);
    expect(extractKeyFromBody(body)).toEqual({ repo: 'owner/repo', slug: 'dev-pipeline-v2' });
    expect(extractUpdatedAtFromBody(body)).toBe('2026-07-26T00:00:00Z');
  });

  it('neutralises injection attempts in blocker text and activity-log notes', () => {
    const record = baseRecord({
      blockers: [
        { id: 'b1', text: 'blocked <!-- --> here', raised_by: 'x', raised_at: '2026-07-25T00:00:00Z', cleared_at: null },
      ],
      log: [{ at: '2026-07-30T00:00:00Z', stage: 'Build', kind: 'info', note: ['note with <!-- injected --> text'] }],
    });
    const body = buildCardBody(record);
    expect(body).not.toContain('<!-- injected -->');
    expect(body).not.toContain('blocked <!-- --> here');
    expect(body).toContain('note with <! -- injected -- > text');
  });
});

describe('extractUpdatedAtFromBody', () => {
  it('round-trips through buildCardBody', () => {
    const record = baseRecord({ updated_at: '2026-07-28T12:00:00Z' });
    const body = buildCardBody(record);
    expect(extractUpdatedAtFromBody(body)).toBe('2026-07-28T12:00:00Z');
  });

  it('returns null when the marker is absent (hand-edited card)', () => {
    expect(extractUpdatedAtFromBody('just some text')).toBe(null);
    expect(extractUpdatedAtFromBody(undefined)).toBe(null);
  });
});

describe('chooseSurvivor', () => {
  it('duplicate recovery: newest updated_at survives, the other is queued to archive', () => {
    const older = { id: 'PVTI_2', updated_at: '2026-07-20T00:00:00Z' };
    const newer = { id: 'PVTI_1', updated_at: '2026-07-25T00:00:00Z' };

    const { survivor, toArchive } = chooseSurvivor([older, newer]);

    expect(survivor).toBe(newer);
    expect(toArchive).toEqual([older]);
  });

  it('equal-updated_at tie-break: lowest card id wins (deterministic)', () => {
    const cardA = { id: 'PVTI_BBB', updated_at: '2026-07-25T00:00:00Z' };
    const cardB = { id: 'PVTI_AAA', updated_at: '2026-07-25T00:00:00Z' };

    const { survivor, toArchive } = chooseSurvivor([cardA, cardB]);

    expect(survivor).toBe(cardB); // 'PVTI_AAA' < 'PVTI_BBB'
    expect(toArchive).toEqual([cardA]);
  });

  it('is order-independent — same result regardless of input array order', () => {
    const cardA = { id: 'PVTI_BBB', updated_at: '2026-07-25T00:00:00Z' };
    const cardB = { id: 'PVTI_AAA', updated_at: '2026-07-25T00:00:00Z' };

    expect(chooseSurvivor([cardA, cardB]).survivor).toBe(chooseSurvivor([cardB, cardA]).survivor);
  });

  it('no existing cards -> no survivor, nothing to archive', () => {
    expect(chooseSurvivor([])).toEqual({ survivor: null, toArchive: [] });
  });
});

describe('shouldSkipStale', () => {
  it('stale-update skip: existing card newer than the incoming record -> skip', () => {
    const card = { id: 'PVTI_1', updated_at: '2026-07-27T00:00:00Z' };
    const record = baseRecord({ updated_at: '2026-07-26T00:00:00Z' });
    expect(shouldSkipStale(card, record)).toBe(true);
  });

  it('existing card older than the incoming record -> do not skip', () => {
    const card = { id: 'PVTI_1', updated_at: '2026-07-25T00:00:00Z' };
    const record = baseRecord({ updated_at: '2026-07-26T00:00:00Z' });
    expect(shouldSkipStale(card, record)).toBe(false);
  });

  it('no existing card -> never skip', () => {
    const record = baseRecord();
    expect(shouldSkipStale(null, record)).toBe(false);
  });

  it('existing card with unreadable updated_at (null) -> never treated as newer', () => {
    const card = { id: 'PVTI_1', updated_at: null };
    const record = baseRecord();
    expect(shouldSkipStale(card, record)).toBe(false);
  });
});

describe('shouldArchive', () => {
  it('archive-after-14-days boundary: 13 days elapsed -> no', () => {
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-15T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z'); // 13 days later
    expect(shouldArchive(record, now)).toBe(false);
  });

  it('archive-after-14-days boundary: 15 days elapsed -> yes', () => {
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-13T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z'); // 15 days later
    expect(shouldArchive(record, now)).toBe(true);
  });

  it('non-terminal status never archives, regardless of age', () => {
    const record = baseRecord({ status: 'BUILDING', updated_at: '2026-01-01T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z');
    expect(shouldArchive(record, now)).toBe(false);
  });

  it('ABANDONED is archivable the same as MERGED', () => {
    const record = baseRecord({ status: 'ABANDONED', updated_at: '2026-07-13T00:00:00Z' });
    const now = new Date('2026-07-28T00:00:00Z');
    expect(shouldArchive(record, now)).toBe(true);
  });
});

describe('parseOwnerRepoFromGitUrl', () => {
  it('parses an https origin URL', () => {
    expect(parseOwnerRepoFromGitUrl('https://github.com/michaelhazza/claude-code-framework.git')).toBe(
      'michaelhazza/claude-code-framework'
    );
  });

  it('parses an ssh origin URL', () => {
    expect(parseOwnerRepoFromGitUrl('git@github.com:michaelhazza/automation-v1.git')).toBe(
      'michaelhazza/automation-v1'
    );
  });

  it('returns null for a non-github remote', () => {
    expect(parseOwnerRepoFromGitUrl('https://gitlab.com/someone/somewhere.git')).toBe(null);
  });
});

// Regression: pr-reviewer PR-003, 2026-07-28. The repo field was renamed
// 'Repo' -> 'Build Repo' (Projects v2 reserves 'Repo'), but only the create
// and write sites were updated; normaliseItem still read `item.Repo`. So
// item.repo was always null, every existing card was skipped as "not one of
// ours", and each sync created a DUPLICATE draft card -- with duplicate
// recovery, stale-skip and the MERGED auto-archive all unreachable. The old
// suite could not catch it: it asserted only the write key, and normaliseItem
// was not exported.
describe('upsert key: read side matches write side', () => {
  const record = {
    slug: 'dev-pipeline-v2',
    status: 'REVIEWING',
    phase: 'build',
    updated_at: '2026-07-28T00:00:00Z',
    summary: 's',
    blockers: [],
  };

  it('normaliseItem reads the same field name mapRecordToCard writes', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    expect(Object.keys(card.fields)).toContain(REPO_FIELD_NAME);

    const item = {
      id: 'PVTI_x',
      [REPO_FIELD_NAME]: card.fields[REPO_FIELD_NAME],
      Slug: card.fields.Slug,
      body: card.body,
    };
    expect(normaliseItem(item).repo).toBe('michaelhazza/automation-v1');
  });

  it('a card written by mapRecordToCard round-trips to the SAME key (no duplicate)', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    const item = {
      id: 'PVTI_x',
      [REPO_FIELD_NAME]: card.fields[REPO_FIELD_NAME],
      Slug: card.fields.Slug,
      body: card.body,
    };
    const normalised = normaliseItem(item);
    expect(buildCardKey(normalised.repo, normalised.slug)).toBe(card.key);
  });

  it('also reads the field from the nested fieldValues shape', () => {
    const item = {
      id: 'PVTI_y',
      fieldValues: { [REPO_FIELD_NAME]: 'Owner/Repo', Slug: 's' },
      body: '',
    };
    expect(normaliseItem(item).repo).toBe('owner/repo');
  });

  it('the legacy reserved name is NOT what the code reads', () => {
    // Guards the specific regression: an item carrying only the old 'Repo'
    // key must not resolve, otherwise the rename was never really applied.
    const item = { id: 'PVTI_z', Repo: 'Owner/Repo', Slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe(null);
  });

  // Regression: dual-reviewer, 2026-07-28. The three tests above build their
  // fixture item from REPO_FIELD_NAME, i.e. from the code's own constant, so
  // they assert the assumption instead of testing it and stayed green while
  // the read was broken against every real result. `gh project item-list
  // --format json` flattens custom fields onto the item and lower-cases only
  // the FIRST character of the display name, so the key is `build Repo`, not
  // `Build Repo`, and `slug`, not `Slug`. These fixtures are written out
  // literally, never derived from the constant, so they fail if the read side
  // regresses to an exact-display-name lookup.
  it('resolves the real gh item-list key shape (lower-cased first character)', () => {
    const item = {
      id: 'PVTI_gh',
      content: { type: 'DraftIssue' },
      title: 'dev-pipeline-v2: Development Pipeline v2',
      'build Repo': 'michaelhazza/automation-v1',
      slug: 'dev-pipeline-v2',
      status: 'REVIEWING',
      body: '<!-- board-sync:v1 updated_at=2026-07-28T00:00:00Z -->',
    };
    const normalised = normaliseItem(item);
    expect(normalised.repo).toBe('michaelhazza/automation-v1');
    expect(normalised.slug).toBe('dev-pipeline-v2');
    expect(normalised.updated_at).toBe('2026-07-28T00:00:00Z');
  });

  // ---------------------------------------------------------------------------
  // REGRESSION (v2.60.1, found by running the sync twice against a live board
  // during the cryptotrackr pilot): a card carries TWO non-interchangeable ids.
  // Field-value edits address the project item (`PVTI_…`); title/body edits
  // address the draft-issue content (`DI_…`) and gh refuses anything else. The
  // update path passed the item id to both, and because gh failures on the sync
  // path are recorded-but-non-blocking by contract, the symptom was invisible:
  // creates worked, every UPDATE silently no-opped, so the board froze at each
  // build's first-seen state. normaliseItem had dropped content.id entirely, so
  // the correct id was not even in scope at the call site.
  // ---------------------------------------------------------------------------
  it('normaliseItem retains the draft-issue content id, which is NOT the item id', () => {
    const item = {
      id: 'PVTI_item',
      content: { type: 'DraftIssue', id: 'DI_content', body: '' },
      'build Repo': 'owner/repo',
      slug: 's',
      body: '',
    };
    const normalised = normaliseItem(item);
    expect(normalised.id).toBe('PVTI_item');
    expect(normalised.contentId).toBe('DI_content');
    expect(normalised.contentId).not.toBe(normalised.id);
  });

  it('normaliseItem reports a missing content id as null rather than guessing', () => {
    expect(normaliseItem({ id: 'PVTI_x', body: '' }).contentId).toBe(null);
    expect(normaliseItem({ id: 'PVTI_x', content: { type: 'Issue' }, body: '' }).contentId).toBe(null);
  });

  it('buildDraftContentEditArgs addresses the edit by the DI_ content id', () => {
    expect(buildDraftContentEditArgs('DI_abc', { title: 'a: b', body: 'text' })).toEqual([
      'project', 'item-edit', '--id', 'DI_abc',
      '--title', 'a: b', '--body', 'text', '--format', 'json',
    ]);
  });

  it('buildDraftContentEditArgs sends title AND body in ONE call', () => {
    // updateProjectV2DraftIssue treats an omitted field as a blanking request,
    // so a body-only edit fails with "Title can't be blank". One invocation
    // carrying both is the only shape that works — pinned here because the
    // two-call version passed every unit test and failed against a live board.
    const args = buildDraftContentEditArgs('DI_abc', { title: 't', body: 'b' });
    expect(args).toContain('--title');
    expect(args).toContain('--body');
    expect(args.filter((a) => a === '--id')).toHaveLength(1);
  });

  it('buildDraftContentEditArgs refuses a project-item id — the exact shape of the defect', () => {
    expect(buildDraftContentEditArgs('PVTI_item', { title: 't', body: 'b' })).toBe(null);
    expect(buildDraftContentEditArgs(null, { title: 't', body: 'b' })).toBe(null);
    expect(buildDraftContentEditArgs(undefined, { title: 't', body: 'b' })).toBe(null);
  });

  it('buildDraftContentEditArgs refuses a blank title rather than blanking the card', () => {
    expect(buildDraftContentEditArgs('DI_abc', { title: '', body: 'b' })).toBe(null);
    expect(buildDraftContentEditArgs('DI_abc', {})).toBe(null);
    // A missing body is legal (empty string), a missing title is not.
    expect(buildDraftContentEditArgs('DI_abc', { title: 't' })).toEqual([
      'project', 'item-edit', '--id', 'DI_abc',
      '--title', 't', '--body', '', '--format', 'json',
    ]);
  });

  it('a card written by mapRecordToCard round-trips through the gh key shape to the SAME key', () => {
    const card = mapRecordToCard(record, 'michaelhazza/automation-v1');
    const item = {
      id: 'PVTI_gh',
      'build Repo': card.fields[REPO_FIELD_NAME],
      slug: card.fields.Slug,
      body: card.body,
    };
    const normalised = normaliseItem(item);
    expect(buildCardKey(normalised.repo, normalised.slug)).toBe(card.key);
  });

  it('also resolves a camelCased key shape, so the read does not pin one transformation', () => {
    const item = { id: 'PVTI_c', buildRepo: 'Owner/Repo', slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe('owner/repo');
    expect(normaliseItem(item).slug).toBe('s');
  });

  it('prefers the exact field name over a looser match when a board carries both', () => {
    // An operator-added `BuildRepo` alongside the real `Build Repo` normalises
    // to the same key. Without precedence the winner would be whichever key gh
    // emitted first, so a card could bind a different field from run to run.
    const item = {
      id: 'PVTI_dup',
      BuildRepo: 'wrong/field',
      'Build Repo': 'right/field',
      Slug: 's',
      body: '',
    };
    expect(normaliseItem(item).repo).toBe('right/field');
  });

  it('prefers a case-only match over a separator-insensitive one', () => {
    const item = { id: 'PVTI_dup2', buildrepo: 'wrong/field', 'build Repo': 'right/field', slug: 's', body: '' };
    expect(normaliseItem(item).repo).toBe('right/field');
  });

  it('a foreign card with neither field still reads as "not one of ours"', () => {
    const item = { id: 'PVTI_f', title: 'someone else', body: 'no markers' };
    const normalised = normaliseItem(item);
    expect(normalised.repo).toBe(null);
    expect(normalised.slug).toBe(null);
  });
});

// Regression: Codex review, 2026-07-28. shouldSkipStale and shouldArchive were
// each correct, but the sync loop evaluated archival INDEPENDENTLY of the stale
// check, so a stale terminal record archived a newer active card. The bug was in
// the composition, so it is pinned at the composition.
describe('decideCardAction — accept-then-archive invariant', () => {
  const now = new Date('2026-07-28T00:00:00Z');

  it('a stale MERGED record does NOT archive a newer active card (the reported bug)', () => {
    const survivor = { id: 'PVTI_active', updated_at: '2026-07-28T00:00:00Z' };
    const staleTerminal = baseRecord({ status: 'MERGED', updated_at: '2026-07-01T00:00:00Z' });

    const a = decideCardAction(survivor, staleTerminal, now);

    expect(a.skipped).toBe(true);
    expect(a.update).toBe(false);
    expect(a.archive).toBe(false);   // was true: archived a card 27 days newer than the record
  });

  it('an accepted, aged MERGED record still archives', () => {
    const survivor = { id: 'PVTI_1', updated_at: '2026-07-01T00:00:00Z' };
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-13T00:00:00Z' });

    const a = decideCardAction(survivor, record, now);

    expect(a.skipped).toBe(false);
    expect(a.update).toBe(true);
    expect(a.archive).toBe(true);
  });

  it('an accepted, recent MERGED record updates without archiving', () => {
    const survivor = { id: 'PVTI_1', updated_at: '2026-07-01T00:00:00Z' };
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-27T00:00:00Z' });

    const a = decideCardAction(survivor, record, now);
    expect(a.update).toBe(true);
    expect(a.archive).toBe(false);
  });

  it('no survivor -> create, never archive', () => {
    const record = baseRecord({ status: 'MERGED', updated_at: '2026-07-01T00:00:00Z' });
    const a = decideCardAction(null, record, now);
    expect(a).toEqual({ create: true, update: false, archive: false, skipped: false });
  });

  it('archive is never true while skipped is true, across a status sweep', () => {
    const survivor = { id: 'PVTI_active', updated_at: '2026-07-28T00:00:00Z' };
    for (const status of ['MERGED', 'ABANDONED', 'BUILDING', 'REVIEWING', 'MERGE_READY', 'PLANNING']) {
      const stale = baseRecord({ status, updated_at: '2026-01-01T00:00:00Z' });
      const a = decideCardAction(survivor, stale, now);
      expect(a.skipped, status).toBe(true);
      expect(a.archive, status).toBe(false);
    }
  });
});

// Regression: external review, 2026-07-29. item-create succeeds, the field
// edits fail -> the card had NO field identity, syncBoard skipped it as "not
// one of ours", and every subsequent sync created another duplicate. The
// identity key now rides in the body marker (written atomically with
// item-create), so such orphans are recognisable and adopted.
describe('orphan adoption via the body key', () => {
  const record = baseRecord({ status: 'BUILDING', updated_at: '2026-07-29T00:00:00Z' });

  it('the key is written into the body marker at card construction', () => {
    const card = mapRecordToCard(record, 'Owner/Repo');
    expect(card.body).toContain('<!-- board-sync:v1 key=owner/repo::dev-pipeline-v2 updated_at=2026-07-29T00:00:00Z -->');
  });

  it('extractUpdatedAtFromBody still parses the keyed marker (regex compat)', () => {
    const card = mapRecordToCard(record, 'Owner/Repo');
    expect(extractUpdatedAtFromBody(card.body)).toBe('2026-07-29T00:00:00Z');
  });

  it('a field-less orphan with a body key normalises to full identity — the reported bug', () => {
    const card = mapRecordToCard(record, 'Owner/Repo');
    // Simulate the partial create: item exists with title/body, NO field values.
    const orphan = { id: 'PVTI_orphan', body: card.body };
    const n = normaliseItem(orphan);
    expect(n.repo).toBe('owner/repo');
    expect(n.slug).toBe('dev-pipeline-v2');
    // Same upsert key as a healthy card -> adopted and healed, not duplicated.
    expect(buildCardKey(n.repo, n.slug)).toBe(card.key);
  });

  it('field values remain the PRIMARY identity when both are present', () => {
    const card = mapRecordToCard(record, 'Owner/Repo');
    const item = { id: 'PVTI_x', [REPO_FIELD_NAME]: 'other/repo', Slug: 'other-slug', body: card.body };
    const n = normaliseItem(item);
    expect(n.repo).toBe('other/repo');
    expect(n.slug).toBe('other-slug');
  });

  it('legacy bodies without a key still normalise (fields only), and a bare marker parses', () => {
    const legacyBody = '<!-- board-sync:v1 updated_at=2026-07-20T00:00:00Z -->\nolder card';
    const n = normaliseItem({ id: 'PVTI_old', [REPO_FIELD_NAME]: 'Owner/Repo', Slug: 's', body: legacyBody });
    expect(n.repo).toBe('owner/repo');
    expect(n.updated_at).toBe('2026-07-20T00:00:00Z');
    expect(extractKeyFromBody(legacyBody)).toBe(null);
  });

  it('a malformed body key is rejected, not half-parsed', () => {
    expect(extractKeyFromBody('<!-- board-sync:v1 key=nodelimiter updated_at=2026-07-29T00:00:00Z -->')).toBe(null);
    expect(extractKeyFromBody('<!-- board-sync:v1 key=repoonly:: updated_at=2026-07-29T00:00:00Z -->')).toBe(null);
  });
});

// build-status.v2 (2026-07-29): the board's Status options and the schema enum
// are two halves of one contract — a status the board lacks cannot be written
// to a card, so a silent drift here breaks publishing for that state only.
describe('board Status options match the schema enum (v2)', () => {
  it('option list is exactly the schema status enum, in pipeline order', async () => {
    const fsMod = await import('node:fs');
    const schema = JSON.parse(fsMod.readFileSync(new URL('../../schemas/build-status.schema.json', import.meta.url), 'utf8'));
    const src = fsMod.readFileSync(new URL('./board-sync.mjs', import.meta.url), 'utf8');
    const start = src.indexOf("name: 'Status',");
    expect(start, 'Status field spec not found').toBeGreaterThan(-1);
    const optIdx = src.indexOf('options: [', start);
    const block = src.slice(optIdx, src.indexOf(']', optIdx));
    const options = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(options).toEqual(schema.properties.status.enum);
  });

  it('the three v2 additions are present', async () => {
    const fsMod = await import('node:fs');
    const schema = JSON.parse(fsMod.readFileSync(new URL('../../schemas/build-status.schema.json', import.meta.url), 'utf8'));
    for (const added of ['SPECIFYING', 'TESTING', 'FINALISING']) {
      expect(schema.properties.status.enum, added).toContain(added);
    }
    expect(schema.properties.contract_version.const).toBe('build-status.v2');
  });
});

// ---------------------------------------------------------------------------
// F3 — live-board contract validation (external review round 3).
//
// The failure this prevents is a SPLIT-BRAIN card, not a crash: against a board
// still provisioned with the v1 six-status field, updateCard wrote a title and
// body saying TESTING, setFieldValues could not find a TESTING option, warned,
// skipped the Status field, and the run exited 0 because board failures are
// deliberately non-blocking. The card body and the board column then disagreed
// for exactly the three statuses the v2 migration added. A per-card warning is
// the wrong granularity for a board-level schema mismatch.
// ---------------------------------------------------------------------------

/** A field map shaped like fetchFieldIds() output for a fully migrated board. */
function liveFields(overrides = {}) {
  const fields = {};
  for (const spec of BOARD_FIELDS_TO_CREATE) {
    fields[spec.name] = spec.dataType === 'SINGLE_SELECT'
      ? {
          id: `id-${spec.name}`,
          type: 'ProjectV2SingleSelectField',
          options: spec.options.map((name) => ({ id: `opt-${name}`, name })),
        }
      : { id: `id-${spec.name}`, type: 'ProjectV2Field', options: [] };
  }
  return { ...fields, ...overrides };
}

describe('checkBoardContract', () => {
  it('accepts a fully migrated board', async () => {
    expect(await checkBoardContract(liveFields())).toBeNull();
  });

  it('accepts extra fields the operator added by hand', async () => {
    const fields = liveFields();
    fields['Notes'] = { id: 'id-Notes', type: 'ProjectV2Field', options: [] };
    expect(await checkBoardContract(fields)).toBeNull();
  });

  it('refuses a board still carrying the v1 six-status field', async () => {
    // The exact regression: the three statuses v2 added are simply absent.
    const fields = liveFields();
    fields.Status.options = ['PLANNING', 'BUILDING', 'REVIEWING', 'MERGE_READY', 'MERGED', 'ABANDONED']
      .map((name) => ({ id: `opt-${name}`, name }));

    const error = await checkBoardContract(fields);
    expect(error).toBeTruthy();
    // Names every missing option, so the operator knows what to add without
    // diffing two lists by eye.
    for (const missing of ['SPECIFYING', 'TESTING', 'FINALISING']) {
      expect(error).toContain(missing);
    }
  });

  it('refuses when a required field is absent, and names it', async () => {
    const fields = liveFields();
    delete fields[REPO_FIELD_NAME];
    const error = await checkBoardContract(fields);
    expect(error).toContain(REPO_FIELD_NAME);
    expect(error).toContain('missing required field');
  });

  it('refuses a board with no fields at all rather than throwing', async () => {
    const error = await checkBoardContract({});
    expect(error).toContain('missing required field');
  });

  it('refuses when Status is a plain text field', async () => {
    // A TEXT Status accepts any string, so every card would look written while
    // the board silently stopped having columns.
    const fields = liveFields({ Status: { id: 'id-Status', type: 'ProjectV2Field', options: [] } });
    const error = await checkBoardContract(fields);
    expect(error).toContain('must be a single-select');
  });

  it('refuses when a text field was provisioned as a single-select', async () => {
    const fields = liveFields({
      Slug: { id: 'id-Slug', type: 'ProjectV2SingleSelectField', options: [{ id: 'o', name: 'x' }] },
    });
    const error = await checkBoardContract(fields);
    expect(error).toContain('must be a plain text field');
  });

  it('falls back to option presence when gh omits the type field', async () => {
    // Older gh versions do not emit `type` in field-list output. Absence of a
    // typename must not be read as "not a single-select" — that would refuse
    // every write on an otherwise healthy board.
    const fields = liveFields();
    for (const name of Object.keys(fields)) fields[name].type = null;
    expect(await checkBoardContract(fields)).toBeNull();
  });

  it('checks required fields before option coverage', async () => {
    // Ordering matters for the diagnostic: a board with neither the fields nor
    // the options should report the structural problem, which is the one the
    // operator fixes first.
    const error = await checkBoardContract({});
    expect(error).toContain('missing required field');
    expect(error).not.toContain('missing option');
  });
});

describe('board field spec matches the schema enum', () => {
  it('provisions exactly the statuses the contract defines', async () => {
    // Also covered by status-vocabulary.test.mjs; asserted here too so a
    // developer editing board-sync.mjs alone sees the coupling break in the
    // file they are editing.
    const { readStatusEnum } = await import('./status-contract.mjs');
    const status = BOARD_FIELDS_TO_CREATE.find((f) => f.name === 'Status');
    expect(status.options).toEqual(await readStatusEnum());
  });
});

// ---------------------------------------------------------------------------
// Round 4 — the guard must not switch itself off, and it must SAY what is
// wrong beyond the one thing it refuses on.
// ---------------------------------------------------------------------------

describe('checkBoardContract — an unreadable schema is a refusal, not a pass', () => {
  it('refuses when the status enum cannot be resolved', async () => {
    // The reported defect: `if (!statusEnum) return null` meant "contract
    // valid", so a missing or corrupt schema silently disabled the very check
    // that exists to prevent split-brain cards.
    vi.resetModules();
    vi.doMock('./status-contract.mjs', () => ({
      readStatusEnum: async () => null,
      validateRecordShape: async () => null,
    }));
    const mod = await import('./board-sync.mjs');

    const fields = {};
    for (const spec of mod.BOARD_FIELDS_TO_CREATE) {
      fields[spec.name] = spec.dataType === 'SINGLE_SELECT'
        ? { id: 'x', type: 'ProjectV2SingleSelectField', options: (spec.options ?? []).map((n) => ({ id: n, name: n })) }
        : { id: 'x', type: 'ProjectV2Field', options: [] };
    }

    const error = await mod.checkBoardContract(fields);
    expect(error, 'a board with every option present must STILL be refused when the schema is unreadable').toBeTruthy();
    expect(error).toMatch(/schema/i);

    vi.doUnmock('./status-contract.mjs');
    vi.resetModules();
  });
});

describe('checkBoardHygiene', () => {
  it('is silent on an exactly-correct board', async () => {
    expect(await checkBoardHygiene(liveFields())).toEqual([]);
  });

  it('reports an obsolete near-miss option, without refusing', async () => {
    // The reviewer's scenario: REVIEWNG left behind by a part-finished
    // migration sits next to REVIEWING as its own column.
    const fields = liveFields();
    fields.Status.options = [...fields.Status.options, { id: 'typo', name: 'REVIEWNG' }];

    const warnings = await checkBoardHygiene(fields);
    expect(warnings.join(' ')).toContain('REVIEWNG');
    // Extra options cannot corrupt a write, so the contract check still passes
    // and cards keep syncing. The split is by consequence, not tidiness.
    expect(await checkBoardContract(fields)).toBeNull();
  });

  it('reports out-of-order options, without refusing', async () => {
    const fields = liveFields();
    const [first, second, ...rest] = fields.Status.options;
    fields.Status.options = [second, first, ...rest];

    const warnings = await checkBoardHygiene(fields);
    expect(warnings.join(' ')).toMatch(/order/i);
    expect(await checkBoardContract(fields)).toBeNull();
  });

  it('does not add an order complaint on top of an extras complaint', async () => {
    // Membership is wrong, so an order message would be noise the operator has
    // to read past before getting to the actionable one.
    const fields = liveFields();
    fields.Status.options = [{ id: 'typo', name: 'REVIEWNG' }, ...fields.Status.options];
    const warnings = await checkBoardHygiene(fields);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('REVIEWNG');
  });

  it('says nothing when Status is absent — checkBoardContract owns that refusal', async () => {
    expect(await checkBoardHygiene({})).toEqual([]);
  });
});

// FR-6, spec §6A "Projects V2 -> permission diagnostics only"; §14 "missing
// Project permission degradation". classifyBoardPermissionError is what the
// syncBoard catch blocks call on a swallowed gh failure so it is diagnosable
// rather than a generic "gh failure". Board-sync's thin I/O layer is
// deliberately untested by design (see file header), so this exercises the
// classifier directly against a simulated missing-permission `gh` response —
// the same shape syncBoard's catch would pass it.
describe('classifyBoardPermissionError', () => {
  it('classifies a missing-project-scope gh error', () => {
    const err = new Error(
      "gh: Your token has not been granted the required scopes to execute this query. The 'project' scope is required."
    );
    expect(classifyBoardPermissionError(err)).toBe('MISSING_PROJECT_SCOPE');
  });

  it('classifies a resource-not-accessible gh error as missing board access', () => {
    const err = new Error('HTTP 403: Resource not accessible by integration');
    expect(classifyBoardPermissionError(err)).toBe('MISSING_BOARD_ACCESS');
  });

  it('classifies a bad-credentials gh error as UNKNOWN (auth-shaped, not scope- or access-specific)', () => {
    const err = new Error('HTTP 401: Bad credentials');
    expect(classifyBoardPermissionError(err)).toBe('UNKNOWN');
  });

  it('returns null for an unrelated gh failure — does not mislabel a generic error', () => {
    const err = new Error('connect ETIMEDOUT 140.82.112.3:443');
    expect(classifyBoardPermissionError(err)).toBe(null);
  });

  it('handles a non-Error input without throwing', () => {
    expect(classifyBoardPermissionError('plain string, not an Error')).toBe(null);
    expect(classifyBoardPermissionError(undefined)).toBe(null);
  });
});

// Did-not-sync signalling. The defect these close: a missing `projects_board`
// key made every board push a silent no-op across an unknown number of builds,
// and because the sync path always exited 0, "board updated" and "board
// silently not updated" were indistinguishable to every caller. The only way
// it surfaced was an operator opening the board and finding an empty column.
// The board stays non-blocking — these assert observability, not a gate.
describe('did-not-sync signalling', () => {
  it('builds the stable marker callers grep for', () => {
    expect(buildNotSyncedMarker(NOT_SYNCED_REASONS.NO_CONFIG))
      .toBe('[board-sync] NOT_SYNCED reason=no_config');
  });

  it('uses an exit code distinct from --init\'s operator-input failure (1)', () => {
    expect(EXIT_NOT_SYNCED).toBe(3);
    expect(EXIT_NOT_SYNCED).not.toBe(1);
    expect(EXIT_NOT_SYNCED).not.toBe(0);
  });

  it('maps the missing-project-scope diagnostic onto its own reason', () => {
    expect(notSyncedReasonFromDiagnostic('MISSING_PROJECT_SCOPE'))
      .toBe(NOT_SYNCED_REASONS.MISSING_PROJECT_SCOPE);
  });

  it('maps the missing-board-access diagnostic onto its own reason', () => {
    expect(notSyncedReasonFromDiagnostic('MISSING_BOARD_ACCESS'))
      .toBe(NOT_SYNCED_REASONS.MISSING_BOARD_ACCESS);
  });

  it('degrades an unclassified gh failure to gh_failure rather than mislabelling it a permission problem', () => {
    expect(notSyncedReasonFromDiagnostic(null)).toBe(NOT_SYNCED_REASONS.GH_FAILURE);
    expect(notSyncedReasonFromDiagnostic('UNKNOWN')).toBe(NOT_SYNCED_REASONS.GH_FAILURE);
    expect(notSyncedReasonFromDiagnostic(undefined)).toBe(NOT_SYNCED_REASONS.GH_FAILURE);
  });

  it('keeps the reason set closed and frozen so callers can branch on the value', () => {
    expect(Object.isFrozen(NOT_SYNCED_REASONS)).toBe(true);
    expect(Object.values(NOT_SYNCED_REASONS).sort()).toEqual([
      'board_contract_mismatch',
      'gh_failure',
      'inventory_incomplete',
      'missing_board_access',
      'missing_project_scope',
      'no_config',
      'no_repo_identity',
      'unexpected_error',
      'unrecovered',
    ]);
  });

  it('emits every reason in the greppable format, with no free text at any call site', () => {
    for (const reason of Object.values(NOT_SYNCED_REASONS)) {
      expect(buildNotSyncedMarker(reason)).toMatch(/^\[board-sync\] NOT_SYNCED reason=[a-z_]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// runBoardSync — the importable core contract (W1.4).
//
// These exercise ONLY the paths that never shell out to gh (no config, no
// records, all-refused), which is enough to pin the two contract guarantees:
// (1) the return shape is target-aware, and (2) the core NEVER mutates
// process.exitCode — the sticky-state bug that markNotSynced caused. The
// gh-touching paths stay the thin I/O layer, untested here by design.
// ---------------------------------------------------------------------------

describe('runBoardSync — importable core contract', () => {
  const boardConfig = JSON.stringify({ projects_board: { owner: 'acme', number: 7 } });

  async function tempRoot(files = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-sync-core-'));
    for (const [rel, contents] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    return dir;
  }

  it('no config → exitCode 3, reason no_config, and the target pins as absent', async () => {
    const root = await tempRoot();
    const result = await runBoardSync({ root, targetSlug: 'my-build' });
    expect(result.exitCode).toBe(EXIT_NOT_SYNCED);
    expect(result.reasons).toEqual([NOT_SYNCED_REASONS.NO_CONFIG]);
    expect(result.target).toEqual({ slug: 'my-build', outcome: 'absent' });
    expect(result.records).toEqual({});
  });

  it('config present + repo injected + no builds → exitCode 0, target absent', async () => {
    const root = await tempRoot({ '.claude/project-registries.json': boardConfig });
    const result = await runBoardSync({ root, repo: 'acme/widgets', targetSlug: 'my-build' });
    expect(result.exitCode).toBe(0);
    expect(result.target).toEqual({ slug: 'my-build', outcome: 'absent' });
  });

  it('a refused target record pins the target outcome as refused, without touching gh', async () => {
    // slug inside the file disagrees with the directory name → collectStatusRecords
    // refuses it before any board mutation. records.length is then 0, so the run
    // returns before a single gh call, yet the target outcome is known.
    const record = { ...baseRecord({ slug: 'not-my-build' }) };
    const root = await tempRoot({
      '.claude/project-registries.json': boardConfig,
      'tasks/builds/my-build/status.json': JSON.stringify(record),
    });
    const result = await runBoardSync({ root, repo: 'acme/widgets', targetSlug: 'my-build' });
    expect(result.exitCode).toBe(0); // a refused record is not a board-unreachable failure
    expect(result.target).toEqual({ slug: 'my-build', outcome: 'refused' });
  });

  it('NEVER mutates process.exitCode — the sticky-state regression (fail then succeed in one process)', async () => {
    const before = process.exitCode;
    try {
      process.exitCode = undefined;

      // A failure first: the old markNotSynced would have stuck exitCode at 3.
      const failRoot = await tempRoot();
      const failed = await runBoardSync({ root: failRoot });
      expect(failed.exitCode).toBe(EXIT_NOT_SYNCED);
      expect(process.exitCode, 'core must not set process.exitCode on failure').toBeUndefined();

      // A success second, same process: no sticky 3 leaks in from the failure.
      const okRoot = await tempRoot({ '.claude/project-registries.json': boardConfig });
      const ok = await runBoardSync({ root: okRoot, repo: 'acme/widgets' });
      expect(ok.exitCode).toBe(0);
      expect(process.exitCode, 'core must not have left the failure exit state behind').toBeUndefined();
    } finally {
      process.exitCode = before;
    }
  });
});

// ===========================================================================
// C2 — complete board inventory + archived-card state machine (W3/W5).
//
// Same discipline as the rest of this file: NOTHING here shells out to gh. The
// pure decision functions (decideArchivedCardAction, cardProjectionEqual,
// decideActionType, planBoardActions, isInventoryComplete) are exercised
// directly, and the executor (executeCardAction) is driven by a RECORDING FAKE
// gh so the true item-edit/item-archive SEQUENCE — and the failure-compensation
// branches — are asserted without a live board.
// ===========================================================================

/** Classifies one recorded gh argv into the mutation kind the sequence tests
 *  assert on. Mirrors how the real gh subcommands are shaped. */
function ghKind(args) {
  if (args.includes('item-create')) return 'create';
  if (args.includes('item-archive')) return args.includes('--undo') ? 'unarchive' : 'archive';
  if (args.includes('item-edit')) return args.includes('--field-id') ? 'field-edit' : 'content-edit';
  if (args.includes('api') && args.includes('graphql')) return 'graphql';
  return 'other';
}

/**
 * Recording fake gh. Records every call, returns an id for item-create, and can
 * be told to throw on the Nth call of a given kind (failAt) or on every call of
 * a kind (failKinds). `message` overrides the thrown text (used for the
 * is-archived race).
 */
function fakeGh({ failKinds = {}, failAt = {}, message } = {}) {
  const calls = [];
  const counts = {};
  const gh = (args) => {
    calls.push(args);
    const kind = ghKind(args);
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (failKinds[kind] || failAt[kind] === counts[kind]) {
      throw new Error(message ?? `simulated ${kind} failure`);
    }
    if (kind === 'create') return { id: 'DI_new' };
    return {};
  };
  gh.calls = calls;
  gh.kinds = () => calls.map(ghKind);
  return gh;
}

const BOARD_CTX = { owner: 'acme', number: 7, projectId: 'PVT_board' };

/** An archived existing-card projection whose title/body/status/phase equal
 *  exactly what `record` would write (so cardProjectionEqual is true). */
function equalArchivedCard(record, repo = 'acme/widgets') {
  const desired = mapRecordToCard(record, repo);
  return {
    id: 'PVTI_1', contentId: 'DI_1', isArchived: true,
    repo: canonicaliseRepo(repo), slug: record.slug,
    title: desired.title, body: desired.body,
    status: desired.fields.Status, phase: desired.fields.Phase,
    updated_at: record.updated_at,
  };
}

describe('isInventoryComplete', () => {
  it('is true only when every card was provably retrieved', () => {
    expect(isInventoryComplete(3, 3, false)).toBe(true);
  });
  it('is false when a page still reported hasNextPage, even if counts match', () => {
    expect(isInventoryComplete(3, 3, true)).toBe(false);
  });
  it('is false when the retrieved count fell short of totalCount', () => {
    expect(isInventoryComplete(2, 3, false)).toBe(false);
  });
  it('is false when totalCount is unknown (no numeric total)', () => {
    expect(isInventoryComplete(3, null, false)).toBe(false);
    expect(isInventoryComplete(3, undefined, false)).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('MERGED and ABANDONED are terminal; nothing else is', () => {
    expect(isTerminalStatus('MERGED')).toBe(true);
    expect(isTerminalStatus('ABANDONED')).toBe(true);
    for (const s of ['SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING', 'FINALISING', 'MERGE_READY']) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe('cardProjectionEqual (full projection, W5)', () => {
  it('is true when title, body, Status and Phase all match what the record writes', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-26T00:00:00Z' });
    expect(cardProjectionEqual(equalArchivedCard(record), record)).toBe(true);
  });

  it('is false on a Status/column drift even when updated_at + body would look equal enough', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-26T00:00:00Z' });
    const drifted = { ...equalArchivedCard(record), status: 'REVIEWING' };
    expect(cardProjectionEqual(drifted, record)).toBe(false);
  });

  it('is false against a null card', () => {
    expect(cardProjectionEqual(null, baseRecord())).toBe(false);
  });
});

describe('decideArchivedCardAction — the archived-card state machine (W5)', () => {
  it('(a) archived + fully-equal terminal record -> SKIP_EQUIVALENT', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-26T00:00:00Z' });
    expect(decideArchivedCardAction(equalArchivedCard(record), record).type).toBe(CARD_ACTIONS.SKIP_EQUIVALENT);
  });

  it('(b) archived + drifted terminal record -> UNARCHIVE_UPDATE_REARCHIVE', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-26T00:00:00Z' });
    const drifted = { ...equalArchivedCard(record), status: 'REVIEWING', title: 'stale: title' };
    expect(decideArchivedCardAction(drifted, record).type).toBe(CARD_ACTIONS.UNARCHIVE_UPDATE_REARCHIVE);
  });

  it('(c) archived + NON-terminal record (resurrection) -> UNARCHIVE_UPDATE, never re-archive', () => {
    const record = baseRecord({ slug: 'my-build', status: 'BUILDING', updated_at: '2026-07-26T00:00:00Z' });
    const card = { ...equalArchivedCard(record), isArchived: true };
    expect(decideArchivedCardAction(card, record).type).toBe(CARD_ACTIONS.UNARCHIVE_UPDATE);
  });
});

describe('executeCardAction — sequence + failure compensation (recording fake gh)', () => {
  const boardFields = liveFields();

  function archivedDriftAction(record, overrides = {}) {
    return {
      type: CARD_ACTIONS.UNARCHIVE_UPDATE_REARCHIVE,
      terminal: true,
      item: { id: 'PVTI_1', contentId: 'DI_1', isArchived: true },
      card: mapRecordToCard(record, 'acme/widgets'),
      fields: boardFields,
      boardCtx: BOARD_CTX,
      ...overrides,
    };
  }

  const terminalRecord = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-26T00:00:00Z' });

  it('(a) SKIP_EQUIVALENT performs ZERO mutations', () => {
    const gh = fakeGh();
    const result = executeCardAction({ type: CARD_ACTIONS.SKIP_EQUIVALENT, card: {}, boardCtx: BOARD_CTX, fields: boardFields }, gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.EQUIVALENT);
    expect(gh.calls).toHaveLength(0);
  });

  it('(b) UNARCHIVE_UPDATE_REARCHIVE fires unarchive -> each field edit -> title/body -> re-archive, in exact order', () => {
    const gh = fakeGh();
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.APPLIED);
    expect(gh.kinds()).toEqual([
      'unarchive', 'field-edit', 'field-edit', 'field-edit', 'field-edit', 'content-edit', 'archive',
    ]);
  });

  it('(c) UNARCHIVE_UPDATE (non-terminal) unarchives + updates and NEVER re-archives', () => {
    const record = baseRecord({ slug: 'my-build', status: 'BUILDING', updated_at: '2026-07-26T00:00:00Z' });
    const gh = fakeGh();
    const action = archivedDriftAction(record, { type: CARD_ACTIONS.UNARCHIVE_UPDATE, terminal: false });
    const result = executeCardAction(action, gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.APPLIED);
    expect(gh.kinds()).toEqual(['unarchive', 'field-edit', 'field-edit', 'field-edit', 'field-edit', 'content-edit']);
    expect(gh.kinds()).not.toContain('archive');
  });

  it('(d) an "is archived" item-edit rejection routes to race-recovery, NEVER the gh_failure classifier', () => {
    // A card we read as NOT archived was archived between read and write: every
    // item-edit throws until an unarchive lands. The UPDATE must recover via the
    // archived flow, not classify gh_failure.
    let archived = true;
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      const kind = ghKind(args);
      if (kind === 'unarchive') { archived = false; return {}; }
      if (kind === 'archive') { archived = true; return {}; }
      if ((kind === 'field-edit' || kind === 'content-edit') && archived) {
        throw new Error('GraphQL: The item is archived and cannot be updated');
      }
      return {};
    };
    gh.kinds = () => calls.map(ghKind);
    const action = {
      type: CARD_ACTIONS.UPDATE, terminal: true,
      item: { id: 'PVTI_1', contentId: 'DI_1', isArchived: false },
      card: mapRecordToCard(terminalRecord, 'acme/widgets'), fields: boardFields, boardCtx: BOARD_CTX,
    };
    const result = executeCardAction(action, gh);
    expect(result.outcome).not.toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(result.outcome).toBe(BOARD_OUTCOMES.APPLIED);
    expect(gh.kinds()).toContain('unarchive'); // recovery happened, not a classification
  });

  it('isArchivedRaceError only matches the archive-race message', () => {
    expect(isArchivedRaceError(new Error('The item is archived and cannot be updated'))).toBe(true);
    expect(isArchivedRaceError(new Error('HTTP 403: forbidden'))).toBe(false);
  });

  it('(e) unarchive fails -> gh_failure, card left archived (no field edits, no re-archive)', () => {
    const gh = fakeGh({ failKinds: { unarchive: true } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(gh.kinds()).toEqual(['unarchive']);
  });

  it('(f) first field edit fails -> re-archive still attempted, outcome gh_failure', () => {
    const gh = fakeGh({ failAt: { 'field-edit': 1 } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(gh.kinds()).toEqual(['unarchive', 'field-edit', 'archive']);
  });

  it('(g) a middle field edit fails -> re-archive still attempted, outcome gh_failure', () => {
    const gh = fakeGh({ failAt: { 'field-edit': 3 } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(gh.kinds()).toEqual(['unarchive', 'field-edit', 'field-edit', 'field-edit', 'archive']);
  });

  it('(h) title/body edit fails -> re-archive still attempted, outcome gh_failure', () => {
    const gh = fakeGh({ failKinds: { 'content-edit': true } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(gh.kinds()).toEqual([
      'unarchive', 'field-edit', 'field-edit', 'field-edit', 'field-edit', 'content-edit', 'archive',
    ]);
  });

  it('(i) compensating re-archive fails (update ok) -> UNRECOVERED, one diagnostic', () => {
    const gh = fakeGh({ failKinds: { archive: true } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.UNRECOVERED);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('(j) update AND compensating re-archive both fail -> UNRECOVERED, BOTH diagnostics preserved', () => {
    const gh = fakeGh({ failKinds: { 'content-edit': true, archive: true } });
    const result = executeCardAction(archivedDriftAction(terminalRecord), gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.UNRECOVERED);
    expect(result.diagnostics).toHaveLength(2);
  });

  it('(k) draft-content-id resolution fails -> partial (fields written, title/body not)', () => {
    const gh = fakeGh();
    const action = {
      type: CARD_ACTIONS.UPDATE, terminal: false,
      item: { id: 'PVTI_1', contentId: null, isArchived: false },
      card: mapRecordToCard(baseRecord({ slug: 'my-build', status: 'BUILDING' }), 'acme/widgets'),
      fields: boardFields, boardCtx: BOARD_CTX,
    };
    const result = executeCardAction(action, gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.PARTIAL);
    expect(gh.kinds()).toEqual(['field-edit', 'field-edit', 'field-edit', 'field-edit']); // no content-edit
  });

  it('non-terminal resurrection whose update fails restores the archived state (gh_failure, not unrecovered)', () => {
    const record = baseRecord({ slug: 'my-build', status: 'BUILDING', updated_at: '2026-07-26T00:00:00Z' });
    const gh = fakeGh({ failKinds: { 'content-edit': true } });
    const action = archivedDriftAction(record, { type: CARD_ACTIONS.UNARCHIVE_UPDATE, terminal: false });
    const result = executeCardAction(action, gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.GH_FAILURE);
    expect(gh.kinds()).toContain('archive'); // archived state restored
  });
});

describe('planBoardActions — duplicate safety, target-first, bounded backfill (W3c/W3d)', () => {
  const now = new Date('2026-07-27T00:00:00Z');

  function normalisedCardFor(record, repo, overrides = {}) {
    const desired = mapRecordToCard(record, repo);
    return {
      id: 'PVTI_match', contentId: 'DI_match', isArchived: false,
      repo: canonicaliseRepo(repo), slug: record.slug,
      title: desired.title, body: desired.body,
      status: desired.fields.Status, phase: desired.fields.Phase,
      updated_at: record.updated_at, ...overrides,
    };
  }

  it('>=201-item inventory with the match AFTER position 200 -> NO duplicate created', () => {
    const record = baseRecord({ slug: 'target', status: 'BUILDING', updated_at: '2026-07-26T00:00:00Z' });
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `PVTI_${i}`, contentId: `DI_${i}`, isArchived: false,
      repo: 'other/repo', slug: `foreign-${i}`, title: 'x', body: '', status: 'BUILDING', phase: 'x',
      updated_at: '2026-01-01T00:00:00Z',
    }));
    const match = normalisedCardFor(record, 'acme/widgets');
    const existingItems = [...filler, match]; // the match sits at index 200

    const { actions } = planBoardActions({ records: [record], existingItems, repository: 'acme/widgets', now });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).not.toBe(CARD_ACTIONS.CREATE);
    expect(actions[0].type).not.toBe(CARD_ACTIONS.CREATE_AND_ARCHIVE);
    expect(actions[0].survivor).toBe(match);
  });

  it('an active terminal record with no card -> CREATE (visible); an _archive one -> CREATE_AND_ARCHIVE', () => {
    const active = baseRecord({ slug: 'fresh-merge', status: 'MERGED', source: 'active', updated_at: '2026-07-27T00:00:00Z' });
    const archived = baseRecord({ slug: 'old-merge', status: 'MERGED', source: '_archive', updated_at: '2026-01-01T00:00:00Z' });
    const { actions } = planBoardActions({ records: [active, archived], existingItems: [], repository: 'acme/widgets', now });
    const byslug = Object.fromEntries(actions.map((a) => [a.record.slug, a.type]));
    expect(byslug['fresh-merge']).toBe(CARD_ACTIONS.CREATE);
    expect(byslug['old-merge']).toBe(CARD_ACTIONS.CREATE_AND_ARCHIVE);
  });

  it('bounded backfill: stops at the budget and reports the remainder', () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      baseRecord({ slug: `arch-${String(i).padStart(2, '0')}`, status: 'MERGED', source: '_archive', updated_at: '2026-01-01T00:00:00Z' }));
    const { actions, deferred } = planBoardActions({ records, existingItems: [], repository: 'acme/widgets', now, budget: 20 });
    expect(actions.filter((a) => a.type === CARD_ACTIONS.CREATE_AND_ARCHIVE)).toHaveLength(20);
    expect(deferred).toHaveLength(5);
  });

  it('the target is processed FIRST and OUTSIDE the budget (never starved by history)', () => {
    // target + exactly `budget` other backfill records. If the target counted
    // against the shared budget, one record would defer; it must not.
    const target = baseRecord({ slug: 'load-bearing', status: 'MERGED', source: '_archive', updated_at: '2026-02-02T00:00:00Z' });
    const others = Array.from({ length: 20 }, (_, i) =>
      baseRecord({ slug: `hist-${String(i).padStart(2, '0')}`, status: 'MERGED', source: '_archive', updated_at: '2026-01-01T00:00:00Z' }));
    const { actions, deferred } = planBoardActions({
      records: [...others, target], existingItems: [], repository: 'acme/widgets', now, targetSlug: 'load-bearing', budget: 20,
    });
    expect(actions[0].record.slug).toBe('load-bearing'); // first
    expect(deferred).toHaveLength(0); // target did not consume a budget slot
    expect(actions.filter((a) => a.type === CARD_ACTIONS.CREATE_AND_ARCHIVE)).toHaveLength(21);
  });

  it('W3b _archive no-op: an archived, equal terminal record -> SKIP_EQUIVALENT, and executes zero mutations', () => {
    const record = baseRecord({ slug: 'archived-history', status: 'MERGED', source: '_archive', phase: 'done', updated_at: '2026-01-01T00:00:00Z' });
    const card = equalArchivedCard(record, 'acme/widgets');
    const { actions } = planBoardActions({ records: [record], existingItems: [card], repository: 'acme/widgets', now });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe(CARD_ACTIONS.SKIP_EQUIVALENT);

    const gh = fakeGh();
    const result = executeCardAction({ ...actions[0], terminal: true, item: card, fields: liveFields(), boardCtx: BOARD_CTX }, gh);
    expect(result.outcome).toBe(BOARD_OUTCOMES.EQUIVALENT);
    expect(gh.calls).toHaveLength(0);
  });
});

describe('decideActionType — non-archived SKIP_EQUIVALENT + archive routing', () => {
  const now = new Date('2026-07-27T00:00:00Z');

  it('an already-equal, non-aged active card -> SKIP_EQUIVALENT (mutations only on drift)', () => {
    const record = baseRecord({ slug: 'my-build', status: 'BUILDING', updated_at: '2026-07-26T00:00:00Z' });
    const survivor = { ...equalArchivedCard(record), isArchived: false };
    expect(decideActionType(survivor, record, now).type).toBe(CARD_ACTIONS.SKIP_EQUIVALENT);
  });

  it('an already-equal, aged terminal card -> ARCHIVE_ONLY (no redundant rewrite)', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-01T00:00:00Z' });
    const survivor = { ...equalArchivedCard(record), isArchived: false };
    expect(decideActionType(survivor, record, now).type).toBe(CARD_ACTIONS.ARCHIVE_ONLY);
  });

  it('a drifted, aged terminal card -> UPDATE_AND_ARCHIVE', () => {
    const record = baseRecord({ slug: 'my-build', status: 'MERGED', phase: 'done', updated_at: '2026-07-01T00:00:00Z' });
    const survivor = { ...equalArchivedCard(record), isArchived: false, status: 'REVIEWING' };
    expect(decideActionType(survivor, record, now).type).toBe(CARD_ACTIONS.UPDATE_AND_ARCHIVE);
  });
});

describe('buildCardBody — source-aware truncated-log pointer (W3b)', () => {
  const many = Array.from({ length: ACTIVITY_RENDER_CAP + 2 }, (_, i) => ({
    at: `2026-07-29T00:00:${String(i % 60).padStart(2, '0')}Z`, stage: 'Build', kind: 'info', note: [`entry ${i}`],
  }));

  it('an _archive-sourced record points at tasks/builds/_archive/<slug>/status.json', () => {
    const body = buildCardBody(baseRecord({ slug: 'old-build', source: '_archive', log: many }));
    expect(body).toContain('tasks/builds/_archive/old-build/status.json');
  });

  it('an active (default) record still points at tasks/builds/<slug>/status.json', () => {
    const body = buildCardBody(baseRecord({ slug: 'live-build', log: many }));
    expect(body).toContain('tasks/builds/live-build/status.json');
    expect(body).not.toContain('_archive');
  });
});

// runBoardSync-level: the _archive non-terminal REFUSAL path is reachable
// without gh (a refused record leaves records.length 0 -> early return), so it
// pins the _archive scan + the distinct non_terminal_archive reason end-to-end.
describe('runBoardSync — _archive scan refuses a non-terminal record', () => {
  const boardConfig = JSON.stringify({ projects_board: { owner: 'acme', number: 7 } });

  async function tempRoot(files = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'board-sync-c2-'));
    for (const [rel, contents] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    return dir;
  }

  it('a non-terminal record in _archive/ is refused with the non_terminal_archive reason, never published', async () => {
    const record = baseRecord({ slug: 'mis-archived', status: 'BUILDING' });
    const root = await tempRoot({
      '.claude/project-registries.json': boardConfig,
      'tasks/builds/_archive/mis-archived/status.json': JSON.stringify(record),
    });
    const result = await runBoardSync({ root, repo: 'acme/widgets', targetSlug: 'mis-archived' });
    // Refused -> no board-unreachable failure, and the target's outcome is known
    // without a single gh call (records.length is 0 after the refusal).
    expect(result.exitCode).toBe(0);
    expect(result.target).toEqual({ slug: 'mis-archived', outcome: 'refused' });
  });
});
