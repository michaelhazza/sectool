/**
 * recovery-checks.test.mjs
 *
 * Covers `evaluateRecoveryState` (the pure decision layer) against
 * fabricated probe fixtures — the same convention board-sync.test.mjs and
 * classify-rejection.test.mjs use for their gh/fs-touching I/O layers, so
 * this suite never shells out to `git`/`gh`. One end-to-end test exercises
 * the real `detectRecoveryState` (§14 "timeout/resume and orphaned-worktree
 * recovery") against a non-git temp directory to pin the never-throws,
 * fails-soft contract with zero mocking.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectRecoveryState, evaluateRecoveryState } from './recovery-checks.mjs';

const NOW = new Date('2026-08-02T12:00:00Z');

function baseRecord(overrides = {}) {
  return {
    slug: 'dev-pipeline-v2',
    status: 'BUILDING',
    branch: 'claude/dev-pipeline-v2',
    updated_at: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

describe('evaluateRecoveryState — dirty branch', () => {
  it('flags a worktree with uncommitted changes', () => {
    const report = evaluateRecoveryState(
      { repo: 'o/r', slug: 'dev-pipeline-v2' },
      { statusRecord: baseRecord(), worktree: { path: '/tmp/wt', branch: 'claude/dev-pipeline-v2' }, workingTreeDirty: true },
      NOW
    );
    expect(report.checks.dirtyBranch.flagged).toBe(true);
    expect(report.anyFlagged).toBe(true);
  });

  it('does not flag a clean worktree', () => {
    const report = evaluateRecoveryState(
      { slug: 'dev-pipeline-v2' },
      { statusRecord: baseRecord(), worktree: { path: '/tmp/wt', branch: 'claude/dev-pipeline-v2' }, workingTreeDirty: false },
      NOW
    );
    expect(report.checks.dirtyBranch.flagged).toBe(false);
  });

  it('reports a probeError instead of flagging when the probe could not run', () => {
    const report = evaluateRecoveryState(
      { slug: 'dev-pipeline-v2' },
      { statusRecord: baseRecord(), workingTreeError: 'no worktree found for branch "x"' },
      NOW
    );
    expect(report.checks.dirtyBranch.flagged).toBe(false);
    expect(report.checks.dirtyBranch.probeError).toContain('no worktree found');
    expect(report.probeErrors).toContain('no worktree found for branch "x"');
  });
});

describe('evaluateRecoveryState — orphaned worktree', () => {
  it('flags a registered worktree whose build already terminated', () => {
    const report = evaluateRecoveryState(
      { slug: 'dev-pipeline-v2' },
      {
        statusRecord: baseRecord({ status: 'MERGED' }),
        worktree: { path: '/tmp/wt-old', branch: 'claude/dev-pipeline-v2' },
      },
      NOW
    );
    expect(report.checks.orphanedWorktree.flagged).toBe(true);
    expect(report.checks.orphanedWorktree.detail).toContain('/tmp/wt-old');
  });

  it('flags a registered worktree with no corresponding status.json', () => {
    const report = evaluateRecoveryState(
      { slug: 'dev-pipeline-v2' },
      { statusRecord: null, worktree: { path: '/tmp/wt-orphan', branch: 'claude/dev-pipeline-v2' } },
      NOW
    );
    expect(report.checks.orphanedWorktree.flagged).toBe(true);
    expect(report.checks.orphanedWorktree.detail).toContain('unknown (no status.json)');
  });

  it('does not flag a worktree for an in-progress build', () => {
    const report = evaluateRecoveryState(
      { slug: 'dev-pipeline-v2' },
      { statusRecord: baseRecord({ status: 'REVIEWING' }), worktree: { path: '/tmp/wt', branch: 'claude/dev-pipeline-v2' } },
      NOW
    );
    expect(report.checks.orphanedWorktree.flagged).toBe(false);
  });

  it('does not flag when there is no worktree at all', () => {
    const report = evaluateRecoveryState({ slug: 'dev-pipeline-v2' }, { statusRecord: baseRecord(), worktree: null }, NOW);
    expect(report.checks.orphanedWorktree.flagged).toBe(false);
  });
});

describe('evaluateRecoveryState — already-completed work', () => {
  it('flags MERGED status', () => {
    const report = evaluateRecoveryState({ slug: 's' }, { statusRecord: baseRecord({ status: 'MERGED' }) }, NOW);
    expect(report.checks.alreadyCompleted.flagged).toBe(true);
    expect(report.checks.alreadyCompleted.detail).toContain('MERGED');
  });

  it('flags ABANDONED status', () => {
    const report = evaluateRecoveryState({ slug: 's' }, { statusRecord: baseRecord({ status: 'ABANDONED' }) }, NOW);
    expect(report.checks.alreadyCompleted.flagged).toBe(true);
  });

  it('flags a branch already merged to default even if status.json disagrees', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), branchMergedToDefault: true },
      NOW
    );
    expect(report.checks.alreadyCompleted.flagged).toBe(true);
    expect(report.checks.alreadyCompleted.detail).toContain('default branch');
  });

  it('does not flag an in-progress build that is not merged', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), branchMergedToDefault: false },
      NOW
    );
    expect(report.checks.alreadyCompleted.flagged).toBe(false);
  });

  it('reports a probeError when both status.json and the merge check are unreadable', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusError: 'cannot read status.json', mergeCheckError: 'cannot resolve ref' },
      NOW
    );
    expect(report.checks.alreadyCompleted.flagged).toBe(false);
    expect(report.checks.alreadyCompleted.probeError).toBeTruthy();
  });
});

describe('evaluateRecoveryState — partial integration', () => {
  it('flags a merged branch whose status.json is still non-terminal', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'TESTING' }), branchMergedToDefault: true },
      NOW
    );
    expect(report.checks.partialIntegration.flagged).toBe(true);
  });

  it('does not flag when the merged branch status is already terminal', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'MERGED' }), branchMergedToDefault: true },
      NOW
    );
    expect(report.checks.partialIntegration.flagged).toBe(false);
  });

  it('does not flag when the branch is not merged', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), branchMergedToDefault: false },
      NOW
    );
    expect(report.checks.partialIntegration.flagged).toBe(false);
  });

  it('flags a squash-merged branch (branchMergedToDefault derived from a merged-PR fixture, no git ancestry link) with a non-terminal status.json', () => {
    // PR-001: this framework merges via `--admin squash`, which leaves no
    // ancestry link, so branchMergedToDefault must come from PR state (gh pr
    // list --state merged), not git merge-base --is-ancestor. This pins the
    // decision layer's behaviour for exactly that gh-derived true value.
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'TESTING' }), branchMergedToDefault: true },
      NOW
    );
    expect(report.checks.partialIntegration.flagged).toBe(true);
    expect(report.checks.alreadyCompleted.flagged).toBe(true);
  });
});

describe('evaluateRecoveryState — stale status', () => {
  it('flags a non-terminal status older than the threshold', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING', updated_at: '2026-07-25T00:00:00Z' }) }, // 8 days before NOW
      NOW
    );
    expect(report.checks.staleStatus.flagged).toBe(true);
    expect(report.checks.staleStatus.detail).toMatch(/\d+h/);
  });

  it('does not flag a recently updated non-terminal status', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING', updated_at: '2026-08-02T10:00:00Z' }) }, // 2h before NOW
      NOW
    );
    expect(report.checks.staleStatus.flagged).toBe(false);
  });

  it('never flags a terminal status regardless of age', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'MERGED', updated_at: '2026-01-01T00:00:00Z' }) },
      NOW
    );
    expect(report.checks.staleStatus.flagged).toBe(false);
  });

  it('reports a probeError for an unparseable updated_at rather than flagging', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING', updated_at: 'not-a-date' }) },
      NOW
    );
    expect(report.checks.staleStatus.flagged).toBe(false);
    expect(report.checks.staleStatus.probeError).toContain('not a parseable date');
  });
});

describe('evaluateRecoveryState — missing CI', () => {
  it('flags an in-progress build with no CI runs found', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), ciFound: false },
      NOW
    );
    expect(report.checks.missingCI.flagged).toBe(true);
  });

  it('does not flag when CI runs were found', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), ciFound: true },
      NOW
    );
    expect(report.checks.missingCI.flagged).toBe(false);
  });

  it('does not flag a terminal build even with no CI runs found', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'MERGED' }), ciFound: false },
      NOW
    );
    expect(report.checks.missingCI.flagged).toBe(false);
  });

  it('reports a probeError instead of flagging when gh is unavailable', () => {
    const report = evaluateRecoveryState(
      { slug: 's' },
      { statusRecord: baseRecord({ status: 'BUILDING' }), ciError: 'cannot read CI status: gh: command not found' },
      NOW
    );
    expect(report.checks.missingCI.flagged).toBe(false);
    expect(report.checks.missingCI.probeError).toContain('gh: command not found');
  });
});

describe('evaluateRecoveryState — never throws on a missing/malformed probes object', () => {
  it('degrades to an all-clear report with no probes supplied', () => {
    expect(() => evaluateRecoveryState({ slug: 's' })).not.toThrow();
    const report = evaluateRecoveryState({ slug: 's' });
    expect(report.anyFlagged).toBe(false);
  });

  it('degrades gracefully when statusRecord is missing entirely', () => {
    const report = evaluateRecoveryState({ slug: 's' }, { statusError: 'not found' }, NOW);
    expect(report.checks.staleStatus.probeError).toBe('not found');
    expect(report.checks.partialIntegration.probeError).toBe('not found');
  });
});

describe('detectRecoveryState — end to end, fails soft (§14 timeout/resume)', () => {
  it('never throws for a slug with no status.json in a non-git root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `recovery-checks-${crypto.randomUUID()}-`));
    let report;
    await expect((async () => { report = await detectRecoveryState({ repo: 'o/r', slug: 'no-such-build', root }); })()).resolves.not.toThrow();
    expect(report.slug).toBe('no-such-build');
    expect(report.anyFlagged).toBe(false);
    expect(report.probeErrors.length).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never throws when no slug is supplied', async () => {
    const report = await detectRecoveryState({ repo: 'o/r' });
    expect(report.slug).toBe(null);
    expect(report.probeErrors.length).toBeGreaterThan(0);
  });
});
