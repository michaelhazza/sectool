/**
 * Static consistency check for the DG-4 evidence-flip contract.
 *
 * The finalisation coordinator's Step 7a flip instruction and the MODE
 * resolution ladder (references/review-mode-resolution.md rung 4) must name
 * the SAME flip file, and that file must NOT live under
 * .claude/session-state/ (which /cleanfiles deletes as transient — a durable
 * default stored there would silently revert). Added after a PR-review
 * finding that a mismatched or transient flip path makes the advertised
 * mechanism inert.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLIP_FILE = '.claude/review-mode-flip';

const resolution = readFileSync(resolve(root, 'references/review-mode-resolution.md'), 'utf8');
const coordinator = readFileSync(resolve(root, '.claude/agents/finalisation-coordinator.md'), 'utf8');

test('resolution ladder rung 4 names the durable flip file', () => {
  expect(resolution).toContain(FLIP_FILE);
});

test('Step 7a flip instruction names the same file the ladder reads', () => {
  expect(coordinator).toContain(FLIP_FILE);
});

test('neither document places the flip file under transient session-state', () => {
  expect(resolution).not.toContain('.claude/session-state/review-mode-flip');
  expect(coordinator).not.toContain('.claude/session-state/review-mode-flip');
});

test('the flip file is not confused with the per-session review-mode override', () => {
  // Rung 2 (per-session override) and rung 4 (durable default flip) are
  // distinct contracts; the flip file name must never collide with the
  // session-state mode file.
  expect(FLIP_FILE.endsWith('review-mode')).toBe(false);
});
