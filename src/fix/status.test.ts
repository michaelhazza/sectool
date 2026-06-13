/**
 * Tests for src/fix/status.ts — Fix-status derivation (§5.3 step 4)
 *
 * Covers:
 * - All 6 states derived from their corresponding GitHub/scan inputs
 * - Label-without-marker is NOT treated as canonical (hasMarker: false)
 * - reopened derives when fingerprint still fires after merge
 * - verified-fixed is fenced by family completion (partial-run guard)
 * - fixes.json update is fingerprint-keyed and atomic (via upsertFix)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  deriveStatus,
  readFixesFile,
  upsertFix,
  type IssueState,
  type PrState,
  type ScanState,
} from './status.js';
import type { FixEntry } from '../schemas/fix.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPEN_ISSUE_WITH_MARKER: IssueState = {
  open: true,
  assigned: false,
  hasMarker: true,
};

const OPEN_ASSIGNED_ISSUE: IssueState = {
  open: true,
  assigned: true,
  hasMarker: true,
};

const OPEN_UNASSIGNED_NO_MARKER: IssueState = {
  open: true,
  assigned: false,
  hasMarker: false,
};

const DRAFT_PR: PrState = {
  draft: true,
  open: true,
  merged: false,
};

const NON_DRAFT_OPEN_PR: PrState = {
  draft: false,
  open: true,
  merged: false,
};

const MERGED_PR: PrState = {
  draft: false,
  open: false,
  merged: true,
};

const SCAN_FINGERPRINT_GONE_FAMILY_COMPLETE: ScanState = {
  fingerprintStillFires: false,
  familyCompleted: true,
};

const SCAN_FINGERPRINT_FIRES_FAMILY_COMPLETE: ScanState = {
  fingerprintStillFires: true,
  familyCompleted: true,
};

const SCAN_FINGERPRINT_GONE_FAMILY_FAILED: ScanState = {
  fingerprintStillFires: false,
  familyCompleted: false,
};

// ---------------------------------------------------------------------------
// deriveStatus — 6-state derivation
// ---------------------------------------------------------------------------

describe('deriveStatus', () => {
  it('returns requested when issue is null', () => {
    expect(deriveStatus(null, null, null)).toBe('requested');
  });

  it('returns requested when issue has the label but no fingerprint marker (hasMarker: false)', () => {
    expect(deriveStatus(OPEN_UNASSIGNED_NO_MARKER, null, null)).toBe('requested');
  });

  it('returns requested when issue is open, unassigned, and no PR', () => {
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, null, null)).toBe('requested');
  });

  it('returns in-progress when issue is open and assigned', () => {
    expect(deriveStatus(OPEN_ASSIGNED_ISSUE, null, null)).toBe('in-progress');
  });

  it('returns in-progress when issue is open with a draft PR (regardless of assignment)', () => {
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, DRAFT_PR, null)).toBe('in-progress');
  });

  it('returns awaiting-review when a non-draft PR is open', () => {
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, NON_DRAFT_OPEN_PR, null)).toBe('awaiting-review');
  });

  it('returns merged-awaiting-verification when PR is merged and no scan yet', () => {
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, null)).toBe('merged-awaiting-verification');
  });

  it('returns merged-awaiting-verification when PR merged but responsible family did not complete', () => {
    // Family failed → partial-run masquerade guard; must NOT graduate to verified-fixed
    expect(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_GONE_FAMILY_FAILED),
    ).toBe('merged-awaiting-verification');
  });

  it('returns verified-fixed when PR merged, family completed, and fingerprint no longer fires', () => {
    expect(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_GONE_FAMILY_COMPLETE),
    ).toBe('verified-fixed');
  });

  it('returns reopened when PR merged, family completed, and fingerprint still fires', () => {
    expect(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_FIRES_FAMILY_COMPLETE),
    ).toBe('reopened');
  });

  it('returns merged-awaiting-verification when PR merged, family SKIPPED (familyCompleted:false), fingerprint gone', () => {
    const skippedFamily: ScanState = { fingerprintStillFires: false, familyCompleted: false };
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, skippedFamily)).toBe(
      'merged-awaiting-verification',
    );
  });

  it('non-draft open PR takes precedence over assignment (awaiting-review wins over in-progress)', () => {
    expect(deriveStatus(OPEN_ASSIGNED_ISSUE, NON_DRAFT_OPEN_PR, null)).toBe('awaiting-review');
  });

  it('draft PR on assigned issue still returns in-progress', () => {
    const assignedWithDraftPr: IssueState = { open: true, assigned: true, hasMarker: true };
    expect(deriveStatus(assignedWithDraftPr, DRAFT_PR, null)).toBe('in-progress');
  });
});

// ---------------------------------------------------------------------------
// fixes.json read/write helpers
// ---------------------------------------------------------------------------

describe('readFixesFile / upsertFix', () => {
  let tmpDir: string;
  let fixesPath: string;
  let lockPath: string;

  beforeEach(() => {
    const suffix = randomBytes(4).toString('hex');
    tmpDir = resolve(tmpdir(), `status-test-${suffix}`);
    mkdirSync(tmpDir, { recursive: true });
    fixesPath = resolve(tmpDir, 'fixes.json');
    lockPath = resolve(tmpDir, '.lock');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('readFixesFile returns empty object when file does not exist', () => {
    expect(readFixesFile(fixesPath)).toEqual({});
  });

  it('readFixesFile parses a valid fixes.json', () => {
    const fp = 'a'.repeat(64);
    const entry: FixEntry = {
      fingerprint: fp,
      ruleId: 'BS-SQL-001',
      status: 'requested',
      issueUrl: 'https://github.com/org/repo/issues/1',
      filedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(fixesPath, JSON.stringify({ [fp]: entry }), 'utf8');
    const result = readFixesFile(fixesPath);
    expect(result[fp]?.status).toBe('requested');
  });

  it('upsertFix creates fixes.json with the first entry (fingerprint-keyed)', async () => {
    const fp = 'b'.repeat(64);
    const entry: FixEntry = {
      fingerprint: fp,
      ruleId: 'BS-AUTH-001',
      status: 'requested',
    };
    await upsertFix(fp, () => entry, { fixesPath, lockPath });

    expect(existsSync(fixesPath)).toBe(true);
    const data = readFixesFile(fixesPath);
    expect(data[fp]?.status).toBe('requested');
    expect(data[fp]?.ruleId).toBe('BS-AUTH-001');
  });

  it('upsertFix updates an existing entry (fingerprint-keyed read-modify-write)', async () => {
    const fp = 'c'.repeat(64);
    const initial: FixEntry = {
      fingerprint: fp,
      ruleId: 'BS-SQL-002',
      status: 'requested',
    };
    await upsertFix(fp, () => initial, { fixesPath, lockPath });

    await upsertFix(
      fp,
      (existing) => ({
        ...existing!,
        status: 'in-progress',
        updatedAt: new Date().toISOString(),
      }),
      { fixesPath, lockPath },
    );

    const data = readFixesFile(fixesPath);
    expect(data[fp]?.status).toBe('in-progress');
    expect(data[fp]?.ruleId).toBe('BS-SQL-002');
  });

  it('upsertFix is keyed by full fingerprint (two different fingerprints are independent)', async () => {
    const fp1 = '1'.repeat(64);
    const fp2 = '2'.repeat(64);

    const entry1: FixEntry = { fingerprint: fp1, ruleId: 'BS-RLS-001', status: 'requested' };
    const entry2: FixEntry = { fingerprint: fp2, ruleId: 'BS-JWT-001', status: 'awaiting-review' };

    await upsertFix(fp1, () => entry1, { fixesPath, lockPath });
    await upsertFix(fp2, () => entry2, { fixesPath, lockPath });

    const data = readFixesFile(fixesPath);
    expect(data[fp1]?.status).toBe('requested');
    expect(data[fp2]?.status).toBe('awaiting-review');
  });

  it('upsertFix is atomic: file is valid JSON after write (not left as tmp file)', async () => {
    const fp = 'd'.repeat(64);
    const entry: FixEntry = { fingerprint: fp, ruleId: 'BS-XSS-001', status: 'requested' };
    await upsertFix(fp, () => entry, { fixesPath, lockPath });

    const raw = readFileSync(fixesPath, 'utf8');
    let parsed: unknown;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
    expect(parsed).toBeTruthy();

    // No tmp file left behind
    const tmpFile = `${fixesPath}.tmp.${process.pid}`;
    expect(existsSync(tmpFile)).toBe(false);
  });

  it('upsertFix last-writer-wins on status: final call\'s value persists', async () => {
    const fp = 'e'.repeat(64);
    const base: FixEntry = { fingerprint: fp, ruleId: 'BS-CORS-001', status: 'requested' };

    await upsertFix(fp, () => base, { fixesPath, lockPath });
    await upsertFix(fp, () => ({ ...base, status: 'in-progress' }), { fixesPath, lockPath });
    await upsertFix(fp, () => ({ ...base, status: 'awaiting-review' }), { fixesPath, lockPath });

    const data = readFixesFile(fixesPath);
    expect(data[fp]?.status).toBe('awaiting-review');
  });
});

// ---------------------------------------------------------------------------
// reopened is non-terminal: re-enters loop correctly
// ---------------------------------------------------------------------------

describe('reopened re-entry', () => {
  it('a new non-draft open PR after reopened re-derives to awaiting-review', () => {
    // After being reopened, a new/updated PR referencing the issue transitions back
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, NON_DRAFT_OPEN_PR, null)).toBe('awaiting-review');
  });

  it('a merged PR after reopened + new fix re-derives to merged-awaiting-verification', () => {
    expect(deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, null)).toBe(
      'merged-awaiting-verification',
    );
  });

  it('after reopened + new PR merged + family completes + fingerprint gone = verified-fixed', () => {
    expect(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_GONE_FAMILY_COMPLETE),
    ).toBe('verified-fixed');
  });
});

// ---------------------------------------------------------------------------
// Status enum completeness
// ---------------------------------------------------------------------------

describe('status enum completeness', () => {
  it('each of the 6 status tokens is reachable via deriveStatus', () => {
    const reached = new Set<string>();

    reached.add(deriveStatus(null, null, null)); // requested (no issue)
    reached.add(deriveStatus(OPEN_ISSUE_WITH_MARKER, null, null)); // requested (open, no PR, unassigned)
    reached.add(deriveStatus(OPEN_ASSIGNED_ISSUE, null, null)); // in-progress
    reached.add(deriveStatus(OPEN_ISSUE_WITH_MARKER, NON_DRAFT_OPEN_PR, null)); // awaiting-review
    reached.add(deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, null)); // merged-awaiting-verification
    reached.add(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_GONE_FAMILY_COMPLETE),
    ); // verified-fixed
    reached.add(
      deriveStatus(OPEN_ISSUE_WITH_MARKER, MERGED_PR, SCAN_FINGERPRINT_FIRES_FAMILY_COMPLETE),
    ); // reopened

    expect(reached).toContain('requested');
    expect(reached).toContain('in-progress');
    expect(reached).toContain('awaiting-review');
    expect(reached).toContain('merged-awaiting-verification');
    expect(reached).toContain('verified-fixed');
    expect(reached).toContain('reopened');
    expect(reached.size).toBe(6);
  });
});
