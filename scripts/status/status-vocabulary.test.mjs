// status-vocabulary.test.mjs — drift guard for the build-status vocabulary.
//
// WHY THIS EXISTS
// The status enum widened 6 -> 9 on 2026-07-29 (build-status.v2). The enum, the
// board's single-select options, the generator's display-priority table and the
// schema's own prose all had to move together, and one of them did not: the
// schema's top-level $comment went on describing the v1 back-edges
// (MERGE_READY->REVIEWING, REVIEWING->BUILDING) for a full external review round
// before a reviewer caught it by eye.
//
// Every assertion here is one of those couplings, made mechanical. Each failure
// message names the file that has to change, because "the vocabulary drifted" is
// only useful if it tells you where.
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARD_FIELDS_TO_CREATE } from './board-sync.mjs';
import { STATUS_PRIORITY, TERMINAL_STATUSES } from './generate-current-focus.mjs';
import { readStatusEnum } from './status-contract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schemas', 'build-status.schema.json');

// Uppercase words that appear in the schema's prose and are NOT status values.
// Deliberately explicit: an unrecognised token failing the test and forcing a
// one-line addition here is the cheap outcome. The expensive outcome is the
// prose quietly naming a status that no longer exists.
const NON_STATUS_TOKENS = new Set([
  'FORMAT', 'INVALID', 'JSON', 'NEVER', 'ONLY', 'OPEN', 'OPTIONAL', 'READER',
  'SPEC', 'VALID_PHASES',
]);

// Pointer-only value: it lives in tasks/current-focus.md when no build is
// active and is deliberately absent from the per-build enum.
const POINTER_ONLY = new Set(['NONE']);

/** Every string in the schema except the enum arrays themselves. */
function collectProse(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'enum') continue; // the values themselves, not prose about them
      collectProse(value, out);
    }
  }
  return out;
}

describe('build-status vocabulary drift guard', () => {
  it('board single-select options match the schema enum exactly, in order', async () => {
    const statusEnum = await readStatusEnum();
    const boardStatus = BOARD_FIELDS_TO_CREATE.find((f) => f.name === 'Status');

    expect(boardStatus, 'board-sync.mjs BOARD_FIELDS_TO_CREATE has no Status field').toBeTruthy();
    // Order matters: these ARE the board columns left to right, so the sequence
    // is the pipeline order the operator reads.
    expect(
      boardStatus.options,
      'board-sync.mjs BOARD_FIELDS_TO_CREATE Status options drifted from schemas/build-status.schema.json'
    ).toEqual(statusEnum);
  });

  it('generator priority table covers exactly the non-terminal statuses', async () => {
    const statusEnum = await readStatusEnum();
    const nonTerminal = statusEnum.filter((s) => !TERMINAL_STATUSES.has(s));

    expect(
      Object.keys(STATUS_PRIORITY).sort(),
      'generate-current-focus.mjs STATUS_PRIORITY drifted from the schema enum — a status with no priority sorts as undefined and lands in an arbitrary position'
    ).toEqual([...nonTerminal].sort());
  });

  it('generator priority values are a dense, unambiguous ranking', async () => {
    const values = Object.values(STATUS_PRIORITY);
    expect(new Set(values).size, 'two statuses share a display priority — their relative order is then decided by the tiebreak, not by pipeline position').toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(values.map((_, i) => i));
  });

  it('terminal statuses are a subset of the enum', async () => {
    const statusEnum = await readStatusEnum();
    for (const terminal of TERMINAL_STATUSES) {
      expect(statusEnum, `TERMINAL_STATUSES contains "${terminal}", which is not in the schema enum`).toContain(terminal);
    }
  });

  it('schema prose names no status outside the enum', async () => {
    const statusEnum = await readStatusEnum();
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const known = new Set([...statusEnum, ...NON_STATUS_TOKENS, ...POINTER_ONLY]);

    const unknown = new Set();
    for (const text of collectProse(schema)) {
      for (const [token] of text.matchAll(/\b[A-Z][A-Z_]{3,}\b/g)) {
        if (!known.has(token)) unknown.add(token);
      }
    }

    expect(
      [...unknown].sort(),
      'schemas/build-status.schema.json prose names a status value that is not in its own enum. '
        + 'Either the prose is stale (the v1-transition bug), or the token is a new non-status word that belongs in NON_STATUS_TOKENS.'
    ).toEqual([]);
  });

  it('the operator-facing pointer doc documents the same enum', async () => {
    const statusEnum = await readStatusEnum();
    const docPath = path.join(REPO_ROOT, 'tasks', 'current-focus.md');
    let doc;
    try {
      doc = await readFile(docPath, 'utf8');
    } catch {
      return; // Framework repo template state — the consuming repo owns this file.
    }

    for (const status of statusEnum) {
      expect(doc, `tasks/current-focus.md does not document the "${status}" status — the operator reads this file to know what the board columns mean`).toContain(status);
    }
  });
});
