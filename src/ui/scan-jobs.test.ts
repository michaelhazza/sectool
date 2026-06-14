import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve, join } from 'node:path';
import {
  SCAN_JOBS_PATH,
  appendEvent,
  foldJobs,
  DISPATCH_TTL_MS,
  type RequestedEvent,
  type DispatchedEvent,
  type DispatchFailedEvent,
  type UploadedEvent,
  type ReportIngestedEvent,
} from './scan-jobs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(resolve(os.tmpdir(), 'scan-jobs-test-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const BASE_TIME = new Date('2026-06-14T10:00:00Z').getTime();

function requested(
  jobId: string,
  overrides?: Partial<RequestedEvent>,
): RequestedEvent {
  return {
    event: 'requested',
    jobId,
    targetRepo: 'my-app',
    stagingUrl: 'https://staging.example.com',
    at: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

function dispatched(jobId: string, atMs = BASE_TIME + 1000): DispatchedEvent {
  return { event: 'dispatched', jobId, at: new Date(atMs).toISOString() };
}

function dispatchFailed(jobId: string): DispatchFailedEvent {
  return {
    event: 'dispatch_failed',
    jobId,
    reason: 'github 502',
    at: new Date(BASE_TIME + 500).toISOString(),
  };
}

function uploaded(jobId: string): UploadedEvent {
  return {
    event: 'uploaded',
    jobId,
    runId: '2026-06-14T10-05-00Z-abcd',
    at: new Date(BASE_TIME + 5000).toISOString(),
  };
}

function reportIngested(): ReportIngestedEvent {
  return {
    event: 'report_ingested',
    trigger: 'scheduled',
    runId: '2026-06-14T09-00-00Z-1234',
    at: new Date(BASE_TIME - 3600_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCAN_JOBS_PATH', () => {
  it('returns <dataDir>/history/scan-jobs.jsonl', () => {
    // Use join for an OS-neutral expected value (resolve normalizes separators).
    const dataDir = os.tmpdir();
    expect(SCAN_JOBS_PATH(dataDir)).toBe(resolve(dataDir, 'history', 'scan-jobs.jsonl'));
  });

  it('places the file under history/ inside dataDir', () => {
    const result = SCAN_JOBS_PATH('/some/data/dir');
    // The result must end with the history/scan-jobs.jsonl segment (sep-agnostic check).
    expect(result).toContain(join('history', 'scan-jobs.jsonl'));
  });
});

describe('appendEvent', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('creates the history/ directory if absent', () => {
    appendEvent(requested('job1'), dir);
    expect(fs.existsSync(resolve(dir, 'history'))).toBe(true);
  });

  it('writes a newline-terminated JSON line', () => {
    const ev = requested('job1');
    appendEvent(ev, dir);
    const content = fs.readFileSync(SCAN_JOBS_PATH(dir), 'utf8');
    expect(content).toBe(JSON.stringify(ev) + '\n');
  });

  it('accumulates multiple events as separate lines', () => {
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1'), dir);
    appendEvent(uploaded('job1'), dir);
    const lines = fs
      .readFileSync(SCAN_JOBS_PATH(dir), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'requested' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: 'dispatched' });
    expect(JSON.parse(lines[2]!)).toMatchObject({ event: 'uploaded' });
  });
});

describe('foldJobs — missing file', () => {
  it('returns [] when the scan-jobs file does not exist', () => {
    const dir = tmpDir();
    try {
      expect(foldJobs(dir, BASE_TIME)).toEqual([]);
    } finally {
      rmDir(dir);
    }
  });
});

describe('foldJobs — §4.3 identity carry-forward (named test)', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('preserves targetRepo/stagingUrl from requested event through dispatched state', () => {
    appendEvent(
      requested('job1', { targetRepo: 'original-repo', stagingUrl: 'https://original.example.com' }),
      dir,
    );
    appendEvent(dispatched('job1'), dir);

    const jobs = foldJobs(dir, BASE_TIME + 2000);
    expect(jobs).toHaveLength(1);
    // Identity MUST come from requested, not be lost to last-event-wins.
    expect(jobs[0]!.targetRepo).toBe('original-repo');
    expect(jobs[0]!.stagingUrl).toBe('https://original.example.com');
    expect(jobs[0]!.state).toBe('in_progress');
  });

  it('preserves targetRepo/stagingUrl from requested event through uploaded state', () => {
    appendEvent(
      requested('job2', { targetRepo: 'original-repo', stagingUrl: 'https://original.example.com' }),
      dir,
    );
    appendEvent(dispatched('job2'), dir);
    appendEvent(uploaded('job2'), dir);

    const jobs = foldJobs(dir, BASE_TIME + 6000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.targetRepo).toBe('original-repo');
    expect(jobs[0]!.stagingUrl).toBe('https://original.example.com');
    expect(jobs[0]!.state).toBe('complete');
    expect(jobs[0]!.runId).toBe('2026-06-14T10-05-00Z-abcd');
  });

  it('requestedAt comes from the requested event at field', () => {
    const requestedAt = new Date(BASE_TIME).toISOString();
    appendEvent(requested('job3', { at: requestedAt }), dir);
    appendEvent(dispatched('job3'), dir);

    const jobs = foldJobs(dir, BASE_TIME + 2000);
    expect(jobs[0]!.requestedAt).toBe(requestedAt);
  });
});

describe('foldJobs — state machine', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('requested-only → pre_dispatch', () => {
    appendEvent(requested('job1'), dir);
    const jobs = foldJobs(dir, BASE_TIME + 1000);
    expect(jobs[0]!.state).toBe('pre_dispatch');
  });

  it('dispatched (within TTL) → in_progress', () => {
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1', BASE_TIME + 1000), dir);
    // nowMs is 2 seconds after dispatch — well within TTL
    const jobs = foldJobs(dir, BASE_TIME + 2000);
    expect(jobs[0]!.state).toBe('in_progress');
  });

  it('dispatch_failed → failed, never in_progress', () => {
    appendEvent(requested('job1'), dir);
    appendEvent(dispatchFailed('job1'), dir);
    const jobs = foldJobs(dir, BASE_TIME + 1000);
    expect(jobs[0]!.state).toBe('failed');
  });

  it('uploaded → complete', () => {
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1'), dir);
    appendEvent(uploaded('job1'), dir);
    const jobs = foldJobs(dir, BASE_TIME + 6000);
    expect(jobs[0]!.state).toBe('complete');
  });

  it('dispatched with no uploaded past TTL → timed_out', () => {
    const dispatchedAt = BASE_TIME + 1000;
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1', dispatchedAt), dir);
    // nowMs is TTL + 1ms after dispatch → timed_out
    const nowMs = dispatchedAt + DISPATCH_TTL_MS + 1;
    const jobs = foldJobs(dir, nowMs);
    expect(jobs[0]!.state).toBe('timed_out');
  });

  it('dispatched exactly at TTL boundary is still in_progress', () => {
    const dispatchedAt = BASE_TIME + 1000;
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1', dispatchedAt), dir);
    // Exactly at TTL — not past it; should remain in_progress.
    const nowMs = dispatchedAt + DISPATCH_TTL_MS;
    const jobs = foldJobs(dir, nowMs);
    expect(jobs[0]!.state).toBe('in_progress');
  });
});

describe('foldJobs — malformed lines', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('tolerates a malformed trailing partial line', () => {
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1'), dir);
    // Simulate a partial write: append a broken JSON fragment at the end.
    fs.appendFileSync(SCAN_JOBS_PATH(dir), '{"event":"uploaded","job');

    const jobs = foldJobs(dir, BASE_TIME + 2000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('in_progress');
    expect(jobs[0]!.targetRepo).toBe('my-app');
  });

  it('malformed interior line does NOT corrupt the fold of valid lines', () => {
    // Write valid requested line
    fs.mkdirSync(resolve(dir, 'history'), { recursive: true });
    const path = SCAN_JOBS_PATH(dir);
    fs.appendFileSync(path, JSON.stringify(requested('job1')) + '\n');
    // Write a malformed interior line (not the last)
    fs.appendFileSync(path, 'NOT_JSON_AT_ALL\n');
    // Write valid dispatched line after the malformed one
    fs.appendFileSync(path, JSON.stringify(dispatched('job1')) + '\n');
    // Write valid requested for second job
    fs.appendFileSync(path, JSON.stringify(requested('job2')) + '\n');
    fs.appendFileSync(path, JSON.stringify(uploaded('job2')) + '\n');

    const jobs = foldJobs(dir, BASE_TIME + 6000);
    // Both jobs should be present and correct despite the interior bad line.
    expect(jobs).toHaveLength(2);

    const j1 = jobs.find((j) => j.jobId === 'job1');
    const j2 = jobs.find((j) => j.jobId === 'job2');
    expect(j1?.state).toBe('in_progress');
    expect(j2?.state).toBe('complete');
  });
});

describe('foldJobs — report_ingested excluded', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('report_ingested events are excluded from the folded job list', () => {
    appendEvent(reportIngested(), dir);
    appendEvent(requested('job1'), dir);
    appendEvent(dispatched('job1'), dir);

    const jobs = foldJobs(dir, BASE_TIME + 2000);
    // Only the on-demand job appears; report_ingested has no jobId and is excluded.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe('job1');
  });

  it('a file with only report_ingested events produces []', () => {
    appendEvent(reportIngested(), dir);
    appendEvent(reportIngested(), dir);
    expect(foldJobs(dir, BASE_TIME)).toEqual([]);
  });
});

describe('appendEvent — parallel appends (store-layer §9 invariant)', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('concurrent appendEvent calls do not drop or corrupt entries', async () => {
    const COUNT = 50;

    // Fire COUNT concurrent appendEvent calls for distinct jobs.
    await Promise.all(
      Array.from({ length: COUNT }, (_, i) => {
        const jobId = `job-${i.toString().padStart(4, '0')}`;
        return Promise.resolve().then(() => appendEvent(requested(jobId), dir));
      }),
    );

    const content = fs.readFileSync(SCAN_JOBS_PATH(dir), 'utf8');
    const lines = content.split('\n').filter(Boolean);

    // Every line must be parseable.
    const parsed = lines.map((l) => JSON.parse(l) as RequestedEvent);

    // All COUNT events must be present.
    expect(parsed).toHaveLength(COUNT);

    // All jobIds must be unique and present.
    const jobIds = new Set(parsed.map((e) => e.jobId));
    expect(jobIds.size).toBe(COUNT);
    for (let i = 0; i < COUNT; i++) {
      expect(jobIds.has(`job-${i.toString().padStart(4, '0')}`)).toBe(true);
    }
  });
});

describe('foldJobs — multiple jobs', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmDir(dir); });

  it('correctly folds independent jobs from the same log', () => {
    appendEvent(requested('j1'), dir);
    appendEvent(requested('j2'), dir);
    appendEvent(dispatched('j1'), dir);
    appendEvent(dispatchFailed('j2'), dir);

    const jobs = foldJobs(dir, BASE_TIME + 2000);
    expect(jobs).toHaveLength(2);

    const j1 = jobs.find((j) => j.jobId === 'j1');
    const j2 = jobs.find((j) => j.jobId === 'j2');
    expect(j1?.state).toBe('in_progress');
    expect(j2?.state).toBe('failed');
  });
});
