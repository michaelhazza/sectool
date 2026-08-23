import { describe, test, expect } from 'vitest';
import {
  extractDocReads,
  summariseDocReads,
  countActiveSessions,
  parseAuditArgs,
  summariseArchSearch,
  resolvePerSessionMetric,
  isScanComplete,
  countAbsentTargetReads,
  resolveEvidenceComplete,
  matchTarget,
  canonicalisePath,
  auditReportFileName,
  type DocTarget,
} from '../docReadAuditPure.js';

const REPO = 'c:\\files\\Claude\\automation-v1-2nd';
const ARCH_PATH = `${REPO}\\architecture.md`;

// Pinned fallback sizes (measured 2026-08-11). Targets carry canonical
// ABSOLUTE paths — attribution is exact-path equality, never suffix matching.
const ARCH: DocTarget = { key: 'architecture.md', absPath: ARCH_PATH, bytes: 983920, lines: 6321 };
const KNOW: DocTarget = { key: 'KNOWLEDGE.md', absPath: `${REPO}\\KNOWLEDGE.md`, bytes: 550277, lines: 2323 };
const TARGETS: DocTarget[] = [ARCH, KNOW];

/** Build a JSONL transcript line carrying a nested Read tool_use. */
function readLine(
  file_path: string,
  opts: { offset?: number; limit?: number; ts?: string | null } = {},
): string {
  const input: Record<string, unknown> = { file_path };
  if (opts.offset != null) input.offset = opts.offset;
  if (opts.limit != null) input.limit = opts.limit;
  const obj: Record<string, unknown> = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Read', input }] },
  };
  if (typeof opts.ts === 'string') obj.timestamp = opts.ts;
  return JSON.stringify(obj);
}

describe('extractDocReads', () => {
  test('unsliced read of architecture.md: covered 2000, estTokens 77830', () => {
    const events = extractDocReads([readLine(ARCH_PATH, { ts: '2026-08-05T00:00:00Z' })], TARGETS, 'S1', REPO);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.key).toBe('architecture.md');
    expect(e.session).toBe('S1');
    expect(e.ts).toBe('2026-08-05T00:00:00Z');
    expect(e.sliced).toBe(false);
    expect(e.offsetLines).toBe(0);
    expect(e.coveredLines).toBe(2000);
    expect(e.estTokens).toBe(77830);
  });

  test('offset only, limit only, offset+limit, near-EOF, beyond-EOF', () => {
    const lines = [
      readLine(ARCH_PATH, { offset: 100 }),                 // offset only
      readLine(ARCH_PATH, { limit: 300 }),                  // limit only
      readLine(ARCH_PATH, { offset: 2236, limit: 200 }),    // both -> covered 200
      readLine(ARCH_PATH, { offset: 6300, limit: 500 }),    // near EOF -> covered 21
      readLine(ARCH_PATH, { offset: 7000 }),                // beyond EOF -> covered 0
    ];
    const events = extractDocReads(lines, TARGETS, 'S1', REPO);
    expect(events.map((e) => e.sliced)).toEqual([true, true, true, true, true]);
    expect(events[0].offsetLines).toBe(100);
    expect(events[0].coveredLines).toBe(2000);          // min(2000, 6321-100)
    expect(events[1].offsetLines).toBe(0);
    expect(events[1].coveredLines).toBe(300);           // limit only
    expect(events[2].coveredLines).toBe(200);           // offset+limit
    expect(events[3].coveredLines).toBe(21);            // NOT 500
    expect(events[4].coveredLines).toBe(0);
    expect(events[4].estTokens).toBe(0);
  });

  test('untracked doc ignored, malformed line skipped, ts absent -> null, deep nesting found', () => {
    const deepNested = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-06T01:02:03Z',
      message: { content: [{ type: 'tool_result', content: [{ type: 'tool_use', name: 'Read', input: { file_path: ARCH_PATH } }] }] },
    });
    const lines = [
      readLine('c:\\files\\Claude\\automation-v1-2nd\\README.md', { ts: '2026-08-05T00:00:00Z' }), // untracked
      'this is not json {',                                                                          // malformed
      readLine('c:\\files\\Claude\\automation-v1-2nd\\KNOWLEDGE.md'),                                // no timestamp -> ts null
      deepNested,                                                                                    // nested inside tool_result
    ];
    const events = extractDocReads(lines, TARGETS, 'S2', REPO);
    expect(events).toHaveLength(2);
    expect(events[0].key).toBe('KNOWLEDGE.md');
    expect(events[0].ts).toBeNull();
    expect(events[1].key).toBe('architecture.md');
    expect(events[1].ts).toBe('2026-08-06T01:02:03Z');
  });
});

describe('matchTarget path binding (attribution is exact-path, never suffix)', () => {
  test('REGRESSION: a nested docs/architecture.md under the repo root does NOT match the root target', () => {
    expect(matchTarget(`${REPO}\\docs\\architecture.md`, TARGETS, REPO)).toBeNull();
    const events = extractDocReads([readLine(`${REPO}\\docs\\architecture.md`, { ts: '2026-08-05T00:00:00Z' })], TARGETS, 'S1', REPO);
    expect(events).toHaveLength(0);
  });

  test("REGRESSION: another repo's architecture.md does NOT match this repo's root target", () => {
    expect(matchTarget('c:\\other\\repo\\architecture.md', TARGETS, REPO)).toBeNull();
    expect(matchTarget('/some/other/repo/architecture.md', TARGETS, REPO)).toBeNull();
    const events = extractDocReads(
      [
        readLine('c:\\other\\repo\\architecture.md', { ts: '2026-08-05T00:00:00Z' }),
        readLine(`${REPO}\\vendor\\foo\\architecture.md`, { ts: '2026-08-05T00:00:00Z' }),
      ],
      TARGETS,
      'S1',
      REPO,
    );
    expect(events).toHaveLength(0);
  });

  test('the exact target path matches across separator and casing variants', () => {
    expect(matchTarget(ARCH_PATH, TARGETS, REPO)?.key).toBe('architecture.md');
    expect(matchTarget('c:/files/Claude/automation-v1-2nd/architecture.md', TARGETS, REPO)?.key).toBe('architecture.md');
    expect(matchTarget('C:\\FILES\\CLAUDE\\AUTOMATION-V1-2ND\\ARCHITECTURE.MD', TARGETS, REPO)?.key).toBe('architecture.md');
  });

  test('a relative Read path resolves against the repo root before binding', () => {
    expect(matchTarget('architecture.md', TARGETS, REPO)?.key).toBe('architecture.md');
    expect(matchTarget('docs/architecture.md', TARGETS, REPO)).toBeNull();
  });

  test('dot-segment traversal canonicalises before binding', () => {
    expect(matchTarget(`${REPO}\\docs\\..\\architecture.md`, TARGETS, REPO)?.key).toBe('architecture.md');
    expect(matchTarget(`${REPO}\\.\\architecture.md`, TARGETS, REPO)?.key).toBe('architecture.md');
    expect(canonicalisePath(`${REPO}\\docs\\..\\architecture.md`)).toBe(canonicalisePath(ARCH_PATH));
  });

  // POSIX paths are case-SENSITIVE: folding them would re-attribute a distinct
  // /repo/Architecture.md to the tracked /repo/architecture.md — the same
  // false-attribution class the exact-path binding exists to prevent.
  const POSIX_REPO = '/home/dev/repo';
  const POSIX_TARGETS: DocTarget[] = [
    { key: 'architecture.md', absPath: `${POSIX_REPO}/architecture.md`, bytes: 983920, lines: 6321 },
  ];

  test('REGRESSION (POSIX): a case-variant /repo/Architecture.md does NOT match the tracked /repo/architecture.md', () => {
    expect(matchTarget(`${POSIX_REPO}/Architecture.md`, POSIX_TARGETS, POSIX_REPO)).toBeNull();
    expect(matchTarget(`${POSIX_REPO}/ARCHITECTURE.MD`, POSIX_TARGETS, POSIX_REPO)).toBeNull();
    const events = extractDocReads(
      [readLine(`${POSIX_REPO}/Architecture.md`, { ts: '2026-08-05T00:00:00Z' })],
      POSIX_TARGETS,
      'S1',
      POSIX_REPO,
    );
    expect(events).toHaveLength(0);
  });

  test('POSIX exact-case path and repo-root-relative path still bind; relative case variant does not', () => {
    expect(matchTarget(`${POSIX_REPO}/architecture.md`, POSIX_TARGETS, POSIX_REPO)?.key).toBe('architecture.md');
    expect(matchTarget('architecture.md', POSIX_TARGETS, POSIX_REPO)?.key).toBe('architecture.md');
    expect(matchTarget('Architecture.md', POSIX_TARGETS, POSIX_REPO)).toBeNull();
  });

  test('case folding is path-shape aware: drive-letter and UNC paths fold, POSIX paths preserve case', () => {
    expect(canonicalisePath('C:/Repo/Doc.md')).toBe('c:/repo/doc.md');
    expect(canonicalisePath('\\\\Server\\Share\\Doc.md')).toBe('//server/share/doc.md');
    expect(canonicalisePath('/Repo/Doc.md')).toBe('/Repo/Doc.md');
  });
});

describe('auditReportFileName (same-day runs must never overwrite each other)', () => {
  const NOW = '2026-08-12T10:00:00.000Z';

  test('REGRESSION: the documented baseline/post workflow — two distinct windows on the same wall-clock date — yields two distinct artifacts', () => {
    const baseline = auditReportFileName(NOW, { since: '2026-06-01T00:00:00Z', until: '2026-07-27T00:00:00Z' });
    const post = auditReportFileName(NOW, { since: '2026-07-27T00:00:00Z', until: '2026-08-12T00:00:00Z' });
    expect(baseline).not.toBe(post);
  });

  test('identical windows generated at different times yield distinct artifacts', () => {
    const window = { since: '2026-06-01T00:00:00Z', until: '2026-07-27T00:00:00Z' };
    expect(auditReportFileName(NOW, window)).not.toBe(auditReportFileName('2026-08-12T10:05:00.000Z', window));
  });

  test('unbounded and half-bounded windows name themselves and stay inside the shipped gitignore glob', () => {
    for (const name of [
      auditReportFileName(NOW, {}),
      auditReportFileName(NOW, { since: '2026-06-01T00:00:00Z' }),
      auditReportFileName(NOW, { until: '2026-07-27T00:00:00Z' }),
    ]) {
      expect(name.startsWith('.doc-read-audit-')).toBe(true);
      expect(name.endsWith('.md')).toBe(true);
      expect(name).not.toMatch(/[:*?"<>|\\/]/); // filename-safe on every platform
    }
    expect(auditReportFileName(NOW, {})).toContain('-all-');
  });
});

describe('summariseDocReads', () => {
  test('4-chunk traversal = 1 unsliced + 3 sliced calls AND 1 wholeDocSession; a lone slice is not whole', () => {
    const traversal = extractDocReads(
      [
        readLine(ARCH_PATH, {}),               // no offset
        readLine(ARCH_PATH, { offset: 2001 }),
        readLine(ARCH_PATH, { offset: 4001 }),
        readLine(ARCH_PATH, { offset: 6001 }),
      ],
      TARGETS,
      'S1',
      REPO,
    );
    const loneSlice = extractDocReads([readLine(ARCH_PATH, { offset: 100, limit: 200 })], TARGETS, 'S2', REPO);
    const summaries = summariseDocReads([...traversal, ...loneSlice], TARGETS);
    const arch = summaries.find((s) => s.key === 'architecture.md')!;
    expect(arch.unslicedReadCalls).toBe(1);
    expect(arch.slicedReadCalls).toBe(4); // 3 from S1 + 1 from S2
    expect(arch.wholeDocSessions).toBe(1); // only S1 covers >= 80%
    expect(arch.estRequestedReadTokens).toBeGreaterThan(0);
    // A target with no events still appears with zeroes.
    const know = summaries.find((s) => s.key === 'KNOWLEDGE.md')!;
    expect(know.unslicedReadCalls).toBe(0);
    expect(know.wholeDocSessions).toBe(0);
  });
});

describe('countActiveSessions', () => {
  test('multiple stamps from one session count once (main + subagent share the parent id)', () => {
    const stamps = [
      { session: 'P', ts: '2026-08-05T00:00:00Z' },
      { session: 'P', ts: '2026-08-05T01:00:00Z' }, // e.g. a subagent line already stamped with parent id
    ];
    expect(countActiveSessions(stamps, {})).toBe(1);
  });

  test('bounded window activates only sessions with an in-window stamp; half-open excludes until', () => {
    const stamps = [
      { session: 'A', ts: '2026-07-01T00:00:00Z' }, // before since
      { session: 'B', ts: '2026-08-05T00:00:00Z' }, // inside
      { session: 'C', ts: '2026-08-10T00:00:00Z' }, // == until -> excluded (half-open)
    ];
    expect(countActiveSessions(stamps, { since: '2026-08-01T00:00:00Z', until: '2026-08-10T00:00:00Z' })).toBe(1);
  });

  test('ts:null never activates in a bounded window but always activates when unbounded', () => {
    const stamps = [{ session: 'A', ts: null }];
    expect(countActiveSessions(stamps, { since: '2026-08-01T00:00:00Z' })).toBe(0);
    expect(countActiveSessions(stamps, {})).toBe(1);
  });

  test('empty stamp list returns 0 (report layer renders n/a, not Infinity/NaN)', () => {
    expect(countActiveSessions([], {})).toBe(0);
    expect(countActiveSessions([], { since: '2026-08-01T00:00:00Z' })).toBe(0);
  });
});

describe('parseAuditArgs (F2: reject malformed invocations)', () => {
  test('valid --since/--until parse into bounds', () => {
    const r = parseAuditArgs(['--since', '2026-06-01T00:00:00Z', '--until', '2026-07-27T00:00:00Z']);
    expect(r).toEqual({ ok: true, dir: null, since: '2026-06-01T00:00:00Z', until: '2026-07-27T00:00:00Z' });
  });

  test('unknown flag (typo --untill) is rejected, not silently ignored', () => {
    const r = parseAuditArgs(['--since', '2026-06-01T00:00:00Z', '--untill', '2026-07-27T00:00:00Z']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument.*--untill/);
  });

  test('a bare --until (no value) is rejected', () => {
    const r = parseAuditArgs(['--until']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--until requires a value/);
  });

  test('a flag whose value is another flag is rejected', () => {
    const r = parseAuditArgs(['--since', '--until', '2026-07-27T00:00:00Z']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--since requires a value/);
  });

  test('reversed bounds (since >= until) are rejected', () => {
    const r = parseAuditArgs(['--since', '2026-08-01T00:00:00Z', '--until', '2026-07-01T00:00:00Z']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--since must be before --until/);
  });

  test('an unparseable bound is rejected; positional junk is rejected', () => {
    expect(parseAuditArgs(['--since', 'not-a-date']).ok).toBe(false);
    expect(parseAuditArgs(['garbage']).ok).toBe(false);
  });
});

describe('summariseArchSearch (F1: attribution + telemetry completeness)', () => {
  const logLines = [
    JSON.stringify({ ts: '2026-08-05T00:00:00Z', query: 'a', chars: 400, origin: 'agent' }),   // in window
    JSON.stringify({ ts: '2026-08-05T01:00:00Z', query: 'b', chars: 800, origin: 'manual' }),  // excluded origin
    JSON.stringify({ ts: '2026-08-05T02:00:00Z', query: 'c', chars: 40 }),                       // missing origin
    JSON.stringify({ ts: '2026-07-01T00:00:00Z', query: 'd', chars: 4000, origin: 'agent' }),   // out of window
  ];
  const window = { since: '2026-08-01T00:00:00Z', until: '2026-08-10T00:00:00Z' };

  test('only agent origin counts; manual excluded; missing origin is unattributed; windowed by ts', () => {
    const s = summariseArchSearch(logLines, null, window);
    expect(s.agentTokens).toBe(100);        // 400/4, the out-of-window agent event excluded
    expect(s.manualTokens).toBe(200);       // 800/4
    expect(s.unattributedTokens).toBe(10);  // 40/4
    expect(s.malformedRows).toBe(0);
    expect(s.telemetryComplete).toBe(true); // no marker, no malformed rows
  });

  test('a malformed (non-empty, unparseable) telemetry row forces incompleteness even with no marker', () => {
    // A truncated JSONL row is a lost, un-attributable event.
    const truncated = '{"ts":"2026-08-05T10:00:00Z","query":"rls","chars":1800,"origin":"agent"';
    const s = summariseArchSearch([logLines[0], truncated, '   ', ''], null, window);
    expect(s.malformedRows).toBe(1);         // blank/whitespace lines are NOT malformed
    expect(s.telemetryComplete).toBe(false); // fail closed: cannot claim completeness
  });

  test('bounded run: valid JSON with missing or invalid ts is unattributable, not silently dropped', () => {
    const missingTs = JSON.stringify({ query: 'rls', chars: 4000, origin: 'agent' });
    const invalidTs = JSON.stringify({ ts: 'not-a-date', query: 'rls', chars: 4000, origin: 'agent' });
    const s = summariseArchSearch([missingTs, invalidTs], null, window);
    expect(s.agentTokens).toBe(0);           // neither counted
    expect(s.unattributableRows).toBe(2);
    expect(s.telemetryComplete).toBe(false); // fail closed
  });

  test('bounded run: an in-window row with non-numeric chars is unattributable', () => {
    const stringChars = JSON.stringify({ ts: '2026-08-05T00:00:00Z', chars: '4000', origin: 'agent' });
    const s = summariseArchSearch([stringChars], null, window);
    expect(s.agentTokens).toBe(0);
    expect(s.unattributableRows).toBe(1);
    expect(s.telemetryComplete).toBe(false);
  });

  test('unbounded run: a row with missing ts is still countable (no window to miss) and stays complete', () => {
    const missingTs = JSON.stringify({ query: 'rls', chars: 4000, origin: 'agent' });
    const s = summariseArchSearch([missingTs], null, {});
    expect(s.agentTokens).toBe(1000);        // 4000/4, counted
    expect(s.unattributableRows).toBe(0);
    expect(s.telemetryComplete).toBe(true);
  });

  test('a gap that began before the window ends makes telemetry incomplete', () => {
    const s = summariseArchSearch(logLines, '2026-08-04T00:00:00Z', window); // gap < until
    expect(s.telemetryComplete).toBe(false);
  });

  test('a gap after the window end leaves the window complete', () => {
    const s = summariseArchSearch(logLines, '2026-08-10T00:00:00Z', window); // gap == until (>= until)
    expect(s.telemetryComplete).toBe(true);
  });

  test('any gap makes an open-ended or unbounded window incomplete; corrupt marker is conservative', () => {
    expect(summariseArchSearch(logLines, '2026-08-05T00:00:00Z', { since: '2026-08-01T00:00:00Z' }).telemetryComplete).toBe(false);
    expect(summariseArchSearch(logLines, '2026-08-05T00:00:00Z', {}).telemetryComplete).toBe(false);
    expect(summariseArchSearch(logLines, 'invalid-marker', window).telemetryComplete).toBe(false);
  });
});

describe('resolvePerSessionMetric (F1: incomplete telemetry can never emit a valid metric)', () => {
  test('complete telemetry yields the computed per-session number', () => {
    expect(resolvePerSessionMetric(1_724_332, 0, 170, true)).toBe('10,143');
  });

  test('incomplete evidence refuses a decision-grade metric even with sessions and tokens present', () => {
    expect(resolvePerSessionMetric(1_724_332, 500_000, 170, false)).toBe('n/a (incomplete evidence)');
  });

  test('zero active sessions yields n/a, not a division blow-up', () => {
    expect(resolvePerSessionMetric(1000, 0, 0, true)).toBe('n/a');
  });
});

describe('isScanComplete (R3: transcript-scan evidence must fail closed)', () => {
  test('a malformed transcript line makes the scan incomplete in every mode', () => {
    expect(isScanComplete({ malformedRows: 1, undatedEvents: 0, invalidTsEvents: 0 }, true)).toBe(false);
    expect(isScanComplete({ malformedRows: 1, undatedEvents: 0, invalidTsEvents: 0 }, false)).toBe(false);
  });

  test('bounded run: undated or invalid-ts Read events fail closed (cannot be windowed)', () => {
    expect(isScanComplete({ malformedRows: 0, undatedEvents: 1, invalidTsEvents: 0 }, true)).toBe(false);
    expect(isScanComplete({ malformedRows: 0, undatedEvents: 0, invalidTsEvents: 1 }, true)).toBe(false);
  });

  test('unbounded run: undated/invalid-ts events are still counted, so only malformed lines matter', () => {
    expect(isScanComplete({ malformedRows: 0, undatedEvents: 5, invalidTsEvents: 3 }, false)).toBe(true);
  });

  test('a clean scan is complete', () => {
    expect(isScanComplete({ malformedRows: 0, undatedEvents: 0, invalidTsEvents: 0 }, true)).toBe(true);
  });
});

describe('countAbsentTargetReads (historical reads of deleted docs must not vanish)', () => {
  // Placeholder target as the CLI builds it for an absent doc: bytes 0, lines 1.
  const KNOW_ABSENT: DocTarget = { key: 'KNOWLEDGE.md', absPath: 'c:\\repo\\KNOWLEDGE.md', bytes: 0, lines: 1 };

  test('a Read of a currently-absent doc inside the window is counted; outside is not; tokens stay 0', () => {
    const events = extractDocReads(
      [
        readLine('c:\\repo\\KNOWLEDGE.md', { ts: '2026-06-10T00:00:00Z' }), // in window
        readLine('c:\\repo\\KNOWLEDGE.md', { ts: '2026-09-10T00:00:00Z' }), // after window
      ],
      [KNOW_ABSENT],
      'S1',
      'c:\\repo',
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.estTokens === 0)).toBe(true); // placeholder sizing cannot leak tokens
    const counts = countAbsentTargetReads(events, ['KNOWLEDGE.md'], {
      since: '2026-06-01T00:00:00Z',
      until: '2026-07-01T00:00:00Z',
    });
    expect(counts.get('KNOWLEDGE.md')).toBe(1);
  });

  test('unbounded run counts undated reads; zero-read absent target reports 0', () => {
    const events = extractDocReads([readLine('c:\\repo\\KNOWLEDGE.md')], [KNOW_ABSENT], 'S1', 'c:\\repo');
    expect(countAbsentTargetReads(events, ['KNOWLEDGE.md'], {}).get('KNOWLEDGE.md')).toBe(1);
    expect(countAbsentTargetReads([], ['KNOWLEDGE.md'], {}).get('KNOWLEDGE.md')).toBe(0);
  });

  test('DECISION BOUNDARY: one absent-doc historical read forces the metric to n/a even with everything else clean', () => {
    // End-to-end through the same pure functions the CLI composes: extraction
    // -> count -> evidence decision -> metric refusal.
    const events = extractDocReads(
      [readLine('c:\\repo\\KNOWLEDGE.md', { ts: '2026-06-10T00:00:00Z' })],
      [KNOW_ABSENT],
      'S1',
      'c:\\repo',
    );
    const window = { since: '2026-06-01T00:00:00Z', until: '2026-07-01T00:00:00Z' };
    const counts = countAbsentTargetReads(events, ['KNOWLEDGE.md'], window);
    const evidenceComplete = resolveEvidenceComplete(true, true, counts);
    expect(evidenceComplete).toBe(false);
    expect(resolvePerSessionMetric(1_000_000, 0, 100, evidenceComplete)).toBe('n/a (incomplete evidence)');
    // Control: zero absent reads with clean telemetry + transcript yields a real number.
    const cleanCounts = countAbsentTargetReads([], ['KNOWLEDGE.md'], window);
    expect(resolveEvidenceComplete(true, true, cleanCounts)).toBe(true);
    expect(resolvePerSessionMetric(1_000_000, 0, 100, true)).toBe('10,000');
  });
});
