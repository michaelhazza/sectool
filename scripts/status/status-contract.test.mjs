/**
 * status-contract.test.mjs
 *
 * The Ajv-available path is exercised incidentally by every other status test
 * (Ajv is installed in this repo). This file targets the path that is NOT
 * exercised by default and was therefore where the defect lived: the
 * **Ajv-unavailable structural floor**.
 *
 * External review round 4 found that the floor checked `blockers` was an array
 * but never the shape of its elements, so `blockers: [null]` passed and then
 * threw on `blocker.cleared_at` inside buildCardBody — surfacing to the
 * operator as a "gh failure", i.e. blaming GitHub for malformed local data. It
 * also missed `title`, `branch` and `pr`, all of which the card renderer
 * dereferences.
 *
 * Ajv is made unavailable with vi.doMock + resetModules so the floor runs for
 * real rather than being reimplemented in the test.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

/** A fresh copy of the module with `import('ajv')` forced to fail. */
async function loadWithoutAjv() {
  vi.resetModules();
  vi.doMock('ajv', () => {
    throw new Error('Cannot find module ajv');
  });
  return import('./status-contract.mjs');
}

/** A fresh copy with Ajv left alone. */
async function loadWithAjv() {
  vi.resetModules();
  vi.doUnmock('ajv');
  return import('./status-contract.mjs');
}

function validRecord(overrides = {}) {
  return {
    contract_version: 'build-status.v2',
    slug: 'build-a',
    title: 'A build',
    classification: 'Standard',
    phase: 'build',
    status: 'BUILDING',
    branch: 'claude/build-a',
    pr: null,
    gates: {},
    gate_evidence: {},
    blockers: [],
    summary: 'Working',
    updated_at: '2026-07-29T00:00:00Z',
    updated_by: 'feature-coordinator',
    ...overrides,
  };
}

function validBlocker(overrides = {}) {
  return {
    id: 'b1',
    text: 'waiting on review',
    raised_by: 'feature-coordinator',
    raised_at: '2026-07-29T00:00:00Z',
    cleared_at: null,
    ...overrides,
  };
}

/** A schema-valid gate_evidence entry. run_ids items are STRINGS — the D2
 *  defect wrote a number here and the one-level floor accepted it. */
function validGateEvidenceEntry(overrides = {}) {
  return {
    sha: 'deadbeef',
    run_ids: ['32310798762'],
    url: null,
    completed_at: '2026-08-19T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('validateRecordShape — Ajv unavailable (the structural floor)', () => {
  it('confirms the floor is actually running, not Ajv', async () => {
    // If this ever reports a `schema-invalid:` prefix, Ajv loaded after all and
    // every other test in this block is testing the wrong code path.
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ summary: 42 }));
    expect(error).toBeTruthy();
    expect(error).not.toContain('schema-invalid');
  });

  it('accepts a valid record', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
  });

  it('accepts a valid record carrying blockers', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const record = validRecord({
      blockers: [validBlocker(), validBlocker({ id: 'b2', cleared_at: '2026-07-29T01:00:00Z' })],
    });
    expect(await validateRecordShape(record)).toBeNull();
  });

  it('rejects blockers: [null] — the reported crash', async () => {
    // buildCardBody dereferences blocker.cleared_at and blocker.text on every
    // element. A null element threw, and the per-record catch reported it as a
    // gh failure.
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ blockers: [null] }));
    expect(error).toBeTruthy();
    expect(error).toContain('blockers[0]');
  });

  it('rejects a blocker missing the fields the renderer reads', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const missing of ['text', 'cleared_at']) {
      const blocker = validBlocker();
      delete blocker[missing];
      const error = await validateRecordShape(validRecord({ blockers: [blocker] }));
      expect(error, `blocker missing ${missing}`).toBeTruthy();
      expect(error).toContain(missing);
    }
  });

  it('rejects a blocker whose text is not a string', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(
      validRecord({ blockers: [validBlocker({ text: 42 })] })
    );
    expect(error).toContain('blockers[0].text');
  });

  it('rejects non-string title and branch — both dereferenced by the renderer', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const key of ['title', 'branch', 'slug', 'status', 'phase', 'summary', 'updated_at']) {
      const error = await validateRecordShape(validRecord({ [key]: 42 }));
      expect(error, `${key} must be type-checked`).toContain(key);
    }
  });

  it('accepts pr as an integer or null, rejects anything else', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ pr: 733 }))).toBeNull();
    expect(await validateRecordShape(validRecord({ pr: null }))).toBeNull();
    expect(await validateRecordShape(validRecord({ pr: '733' }))).toContain('pr');
    expect(await validateRecordShape(validRecord({ pr: 7.5 }))).toContain('pr');
  });

  it('rejects a missing required key', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const key of ['contract_version', 'title', 'branch', 'blockers', 'updated_by']) {
      const record = validRecord();
      delete record[key];
      expect(await validateRecordShape(record), key).toContain(key);
    }
  });

  it('does not treat null or an array as an object for `gates`', async () => {
    // JSON Schema's `object` excludes both; a plain typeof check does not.
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ gates: null }))).toContain('gates');
    expect(await validateRecordShape(validRecord({ gates: [] }))).toContain('gates');
  });

  it('rejects a non-object record instead of throwing', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const value of [null, 'a string', 42, []]) {
      expect(await validateRecordShape(value)).toContain('must be a JSON object');
    }
  });

  // -------------------------------------------------------------------------
  // Vocabulary (enum / const). External review round 5.
  //
  // A types-only floor accepted `status: "TESTNG"` because it is a string, and
  // board-sync has NO status check of its own (unlike the generator, which
  // tests STATUS_PRIORITY membership). So the typo reached the board: the card
  // body was written saying TESTNG, setFieldValues found no such option,
  // warned, skipped the field, and the card disagreed with its own column —
  // reopening the exact split-brain defect checkBoardContract was written for.
  // -------------------------------------------------------------------------

  it('rejects a status outside the enum — the reopened split-brain defect', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ status: 'TESTNG' }));
    expect(error).toBeTruthy();
    expect(error).toContain('status');
    // The message names the legitimate values, so the operator can see the typo.
    expect(error).toContain('TESTING');
  });

  it('accepts every legitimate status', async () => {
    const { validateRecordShape, readStatusEnum } = await loadWithoutAjv();
    for (const status of await readStatusEnum()) {
      expect(await validateRecordShape(validRecord({ status })), status).toBeNull();
    }
  });

  it('rejects a superseded contract_version — const, not just type', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ contract_version: 'build-status.v1' }));
    expect(error).toBeTruthy();
    expect(error).toContain('contract_version');
  });

  it('rejects out-of-enum phase and classification', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ phase: 'not-a-phase' }))).toContain('phase');
    expect(await validateRecordShape(validRecord({ classification: 'Enormous' }))).toContain('classification');
  });

  // -------------------------------------------------------------------------
  // Activity log (`log[]`, optional/additive — 2.61.0). buildCardBody
  // dereferences entry.at, entry.stage, entry.kind and iterates entry.note,
  // so a malformed element is the same renderer-crash class as blockers[null].
  // -------------------------------------------------------------------------

  it('accepts a record with no log — the pre-2.61.0 shape stays valid', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
  });

  it('accepts a valid activity log', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const record = validRecord({
      log: [
        { at: '2026-07-30T01:00:00Z', stage: 'Plan', kind: 'done', note: ['Plan approved: 12 chunks'] },
        { at: '2026-07-30T01:00:01Z', stage: 'Build', kind: 'start', note: ['Building 12 chunks', 'Sonnet builder'] },
      ],
    });
    expect(await validateRecordShape(record)).toBeNull();
  });

  it('rejects log: [null] — the renderer-crash class', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({ log: [null] }));
    expect(error).toBeTruthy();
    expect(error).toContain('log[0]');
  });

  it('rejects a log entry missing fields the renderer reads', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const missing of ['at', 'stage', 'kind', 'note']) {
      const entry = { at: '2026-07-30T01:00:00Z', stage: 'Build', kind: 'start', note: ['x'] };
      delete entry[missing];
      const error = await validateRecordShape(validRecord({ log: [entry] }));
      expect(error, `log entry missing ${missing}`).toBeTruthy();
      expect(error).toContain(missing);
    }
  });

  it('rejects an out-of-enum log kind and a malformed timestamp', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({
      log: [{ at: '2026-07-30T01:00:00Z', stage: 'Build', kind: 'finished', note: ['x'] }],
    }))).toContain('kind');
    expect(await validateRecordShape(validRecord({
      log: [{ at: 'yesterday', stage: 'Build', kind: 'done', note: ['x'] }],
    }))).toContain('at');
  });

  // -------------------------------------------------------------------------
  // Runtime-identity fields (top-level `runtime` object and `log[]`
  // `runtime`/`role` keys, optional/additive — 2.62.0). Both are
  // additionalProperties: false, so the additive proof is that a record with
  // NONE of these keys still validates, and a record carrying all of them
  // also validates once the keys are declared in `properties`.
  // -------------------------------------------------------------------------

  it('accepts a record with none of the new runtime-identity keys — the additive proof', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
  });

  it('accepts a record stamped with runtime-identity at both the top level and on log[] entries', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const record = validRecord({
      runtime: { coordinator_runtime: 'claude-code', coordinator_role: 'Coordinator' },
      log: [
        { at: '2026-08-02T01:00:00Z', stage: 'Build', kind: 'start', note: ['Building chunk A3'], runtime: 'claude-code', role: 'Builder' },
        { at: '2026-08-02T01:00:01Z', stage: 'Build', kind: 'done', note: ['Chunk A3 built'], runtime: 'openclaw', role: 'Builder' },
      ],
    });
    expect(await validateRecordShape(record)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // W2.1 (framework-status-sync-hardening) — the recursive floor. These are
  // the constraints the ONE-LEVEL floor could not reach, and every one is the
  // exact defect class observed in the PR #828 finalisation (D2) or its
  // neighbours. gate_evidence entries are typed via schema-valued
  // additionalProperties two levels down; note[] carries maxItems/maxLength;
  // the whole record and each gate_evidence entry are additionalProperties:false.
  // -------------------------------------------------------------------------

  it('rejects a numeric run_id nested in a gate_evidence entry — the D2 defect', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({
      gate_evidence: { merge_gate: validGateEvidenceEntry({ run_ids: [32310798762] }) },
    }));
    expect(error, 'a number where the schema demands string items must be rejected').toBeTruthy();
    expect(error).toContain('run_ids');
  });

  it('accepts a stringified run_id in a gate_evidence entry', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({
      gate_evidence: { merge_gate: validGateEvidenceEntry({ run_ids: ['32310798762'] }) },
    }))).toBeNull();
  });

  it('rejects a note bullet over the 200-char maxLength', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({
      log: [{ at: '2026-08-19T00:00:00Z', stage: 'Build', kind: 'info', note: ['x'.repeat(201)] }],
    }));
    expect(error).toBeTruthy();
    expect(error).toContain('note');
  });

  it('rejects a note with more than 6 items (maxItems)', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({
      log: [{ at: '2026-08-19T00:00:00Z', stage: 'Build', kind: 'info', note: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    }));
    expect(error).toBeTruthy();
    expect(error).toContain('note');
  });

  it('rejects an evidence_sha256 that violates the 64-hex pattern', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({
      gate_evidence: { uat: validGateEvidenceEntry({ evidence_sha256: 'not-a-valid-digest' }) },
    }));
    expect(error).toBeTruthy();
    expect(error).toContain('evidence_sha256');
  });

  it('rejects an unknown key inside a gate_evidence entry (additionalProperties: false)', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const error = await validateRecordShape(validRecord({
      gate_evidence: { merge_gate: validGateEvidenceEntry({ bogus_key: 'x' }) },
    }));
    expect(error).toBeTruthy();
    expect(error).toContain('bogus_key');
  });

  it('rejects an unknown top-level key (additionalProperties: false)', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    const record = validRecord();
    record.an_unknown_key = 'x';
    const error = await validateRecordShape(record);
    expect(error).toBeTruthy();
    expect(error).toContain('an_unknown_key');
  });

  it('accepts a full gate_evidence UAT entry with all optional fields', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({
      gate_evidence: {
        uat: validGateEvidenceEntry({
          evidence_sha256: 'a'.repeat(64),
          code_candidate_sha: 'b'.repeat(40),
          enforcement: 'blocking',
        }),
      },
    }))).toBeNull();
  });
});

describe('validateRecordShape — Ajv available', () => {
  it('accepts a valid record and rejects a malformed one', async () => {
    const { validateRecordShape } = await loadWithAjv();
    expect(await validateRecordShape(validRecord())).toBeNull();
    expect(await validateRecordShape(validRecord({ blockers: [null] }))).toBeTruthy();
  });

  it('agrees with the floor across structure AND vocabulary', async () => {
    // The two paths must not disagree about validity, or which one happened to
    // load becomes a correctness variable.
    //
    // Round 5: the first version of this test only covered cases the floor
    // already implemented, so the paths "agreed" over a subset that excluded
    // every enum and const rule — which is precisely where they diverged. The
    // vocabulary cases below are the ones that were missing.
    const withAjv = await loadWithAjv();
    const cases = [
      // Structure
      validRecord(),
      validRecord({ blockers: [validBlocker()] }),
      validRecord({ blockers: [null] }),
      validRecord({ title: 42 }),
      validRecord({ pr: '733' }),
      validRecord({ gates: [] }),
      // Vocabulary
      validRecord({ status: 'TESTNG' }),
      validRecord({ status: 'TESTING' }),
      validRecord({ status: 'ABANDONED' }),
      validRecord({ contract_version: 'build-status.v1' }),
      validRecord({ phase: 'not-a-phase' }),
      validRecord({ classification: 'Enormous' }),
      validRecord({ blockers: [validBlocker({ text: '' })] }),
      // Recursive-floor constraints (W2.1) — the two paths must agree on every
      // one, or which validator loaded becomes a correctness variable.
      validRecord({ gate_evidence: { merge_gate: validGateEvidenceEntry({ run_ids: [32310798762] }) } }),
      validRecord({ gate_evidence: { merge_gate: validGateEvidenceEntry({ run_ids: ['32310798762'] }) } }),
      validRecord({ log: [{ at: '2026-08-19T00:00:00Z', stage: 'Build', kind: 'info', note: ['x'.repeat(201)] }] }),
      validRecord({ log: [{ at: '2026-08-19T00:00:00Z', stage: 'Build', kind: 'info', note: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] }),
      validRecord({ gate_evidence: { uat: validGateEvidenceEntry({ evidence_sha256: 'nope' }) } }),
      validRecord({ gate_evidence: { uat: validGateEvidenceEntry({ evidence_sha256: 'a'.repeat(64), enforcement: 'blocking' }) } }),
      validRecord({ gate_evidence: { merge_gate: validGateEvidenceEntry({ bogus_key: 'x' }) } }),
      (() => { const r = validRecord(); r.an_unknown_key = 'x'; return r; })(),
      // Formats — promoted out of the known-divergence pin in round 6, where
      // the pin turned out to be encoding a real defect as intended behaviour.
      validRecord({ updated_at: 'zzzz' }),
      validRecord({ updated_at: '2026-07-29' }),
      validRecord({ updated_at: '2026-07-29T00:00:00.123Z' }),
      validRecord({ blockers: [validBlocker({ cleared_at: 'zzzz' })] }),
      validRecord({ blockers: [validBlocker({ cleared_at: null })] }),
      validRecord({ blockers: [validBlocker({ raised_at: 'zzzz' })] }),
      // Calendar rollover: Date.parse accepts this (it becomes 3 March) but
      // ajv-formats rejects it, so a Date.parse-only floor would diverge.
      validRecord({ updated_at: '2026-02-31T00:00:00Z' }),
      // Out-of-range time-of-day — an unbounded \d{2} floor accepted these while
      // Ajv rejects them (the floor-vs-Ajv divergence fixed by bounding the
      // hour/minute/second ranges).
      validRecord({ updated_at: '2026-01-01T00:75:00Z' }),
      validRecord({ updated_at: '2026-01-01T25:00:00Z' }),
      validRecord({ updated_at: '2026-01-01T00:00:99Z' }),
      validRecord({ updated_at: '2026-01-01T12:30:45+15:00' }),
    ];
    const ajvVerdicts = [];
    for (const record of cases) ajvVerdicts.push(await withAjv.validateRecordShape(record) === null);

    const withoutAjv = await loadWithoutAjv();
    const floorVerdicts = [];
    for (const record of cases) floorVerdicts.push(await withoutAjv.validateRecordShape(record) === null);

    expect(floorVerdicts).toEqual(ajvVerdicts);
  });
});

describe('no remaining divergences between Ajv and the floor', () => {
  // Every keyword this schema uses is now implemented by BOTH paths: the floor
  // was made genuinely recursive in W2.1 (framework-status-sync-hardening), so
  // `additionalProperties: false`, schema-valued `additionalProperties`,
  // maxLength/maxItems/pattern and nested `properties` are no longer floor
  // blind-spots. This block is the tripwire: if a future schema edit introduces
  // a keyword the floor does not implement (allOf, if/then, $ref, numeric
  // bounds), the agreement test above fails on the case that exercises it and
  // sends the author here to teach the floor before shipping.
  it('the floor now enforces additionalProperties: false', async () => {
    const record = validRecord();
    record.an_unknown_key = 'x';
    const withAjv = await loadWithAjv();
    expect(await withAjv.validateRecordShape(record)).toBeTruthy();
    const withoutAjv = await loadWithoutAjv();
    expect(await withoutAjv.validateRecordShape(record)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// format: date-time. External review round 6.
//
// This was pinned as an ACCEPTABLE divergence for one round, on the stated
// grounds that a malformed timestamp produced only a wrong-looking card. That
// reasoning was wrong, and the pin encoded it as intended behaviour. All three
// consumers below were verified in board-sync.mjs before this was fixed:
//
//   shouldSkipStale  compares timestamps as PLAIN STRINGS
//   chooseSurvivor   orders duplicates by the same string comparison
//   shouldArchive    does `now - new Date(updated_at)`, which is NaN
// ---------------------------------------------------------------------------

describe('validateRecordShape — date-time formats (Ajv unavailable)', () => {
  it('rejects a malformed updated_at — the reported defect', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const bad of ['zzzz', 'not-a-date', '2026-07-29', '', 'Jul 29 2026']) {
      const error = await validateRecordShape(validRecord({ updated_at: bad }));
      expect(error, `updated_at: ${JSON.stringify(bad)}`).toBeTruthy();
      expect(error).toContain('updated_at');
    }
  });

  it('rejects the specific value that defeats stale-write protection', async () => {
    // 'zzzz' sorts ABOVE any ISO timestamp under plain string comparison, so
    // shouldSkipStale returns false and an older record overwrites a newer
    // card. Named explicitly so the case survives any future refactor of the
    // loop above.
    const { validateRecordShape } = await loadWithoutAjv();
    expect('2026-07-29T10:00:00Z' > 'zzzz', 'the string-ordering premise').toBe(false);
    expect(await validateRecordShape(validRecord({ updated_at: 'zzzz' }))).toBeTruthy();
  });

  it('accepts legitimate RFC 3339 forms', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    for (const good of [
      '2026-07-29T00:00:00Z',
      '2026-07-29T00:00:00.123Z',
      '2026-07-29T00:00:00+10:00',
      '2026-07-29T00:00:00-05:30',
      '2026-07-29t00:00:00z',
    ]) {
      expect(await validateRecordShape(validRecord({ updated_at: good })), good).toBeNull();
    }
  });

  it('rejects well-shaped but impossible dates', async () => {
    // The regex alone accepts these; the Date.parse check is what rejects them.
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(validRecord({ updated_at: '2026-02-31T00:00:00Z' }))).toBeTruthy();
    expect(await validateRecordShape(validRecord({ updated_at: '2026-13-01T00:00:00Z' }))).toBeTruthy();
  });

  it('is stricter than Date.parse, which accepts far more than RFC 3339', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    // Date.parse happily reads this; JSON Schema's date-time does not.
    expect(Number.isFinite(Date.parse('29 Jul 2026')), 'the premise').toBe(true);
    expect(await validateRecordShape(validRecord({ updated_at: '29 Jul 2026' }))).toBeTruthy();
  });

  it('enforces date-time inside the nullable oneOf shapes', async () => {
    // blocker.cleared_at is `oneOf [{string, date-time}, {null}]`, so the
    // keyword sits in a BRANCH, not on the property. null must still pass.
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(
      validRecord({ blockers: [validBlocker({ cleared_at: null })] })
    )).toBeNull();
    expect(await validateRecordShape(
      validRecord({ blockers: [validBlocker({ cleared_at: '2026-07-29T00:00:00Z' })] })
    )).toBeNull();
    expect(await validateRecordShape(
      validRecord({ blockers: [validBlocker({ cleared_at: 'zzzz' })] })
    )).toContain('cleared_at');
  });

  it('enforces date-time on nested blocker.raised_at', async () => {
    const { validateRecordShape } = await loadWithoutAjv();
    expect(await validateRecordShape(
      validRecord({ blockers: [validBlocker({ raised_at: 'zzzz' })] })
    )).toContain('raised_at');
  });
});

describe('readStatusEnum', () => {
  it('returns the nine v2 statuses in pipeline order', async () => {
    const { readStatusEnum } = await loadWithAjv();
    expect(await readStatusEnum()).toEqual([
      'SPECIFYING', 'PLANNING', 'BUILDING', 'REVIEWING', 'TESTING',
      'FINALISING', 'MERGE_READY', 'MERGED', 'ABANDONED',
    ]);
  });
});
