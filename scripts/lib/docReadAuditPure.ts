// ---------------------------------------------------------------------------
// doc-read audit — pure transcript mining for reference-doc Read cost.
//
// Mines Claude Code session transcripts (JSONL) for Read tool calls against the
// large reference docs and estimates the tokens those calls REQUESTED via the
// Read tool. It counts requests, not confirmed deliveries: a Read that the tool
// rejected (file-not-found, bad param) still counts, an accepted overcount that
// is stable across equal windows. Proves the "slice-first" trend: fewer
// whole-file reads over time.
//
// Pure: no fs, no process. The CLI (scripts/doc-read-audit.ts) does I/O and
// timestamp/window resolution; this module holds the accounting the Gate 2
// verdict depends on, so it lives under test.
// ---------------------------------------------------------------------------

export interface DocTarget {
  key: string;
  /** Canonical ABSOLUTE path of the tracked doc under the audited repo root.
   *  Attribution is exact-path equality after canonicalisation — never
   *  basename/suffix matching, which let unrelated files (docs/architecture.md,
   *  another repo's architecture.md) contaminate the decision-grade metric. */
  absPath: string;
  bytes: number;
  lines: number;
}

export interface DocReadEvent {
  key: string;
  session: string;
  ts: string | null;
  sliced: boolean;
  offsetLines: number;
  coveredLines: number;
  estTokens: number;
}

export interface DocReadSummary {
  key: string;
  unslicedReadCalls: number;
  slicedReadCalls: number;
  /** Estimated tokens REQUESTED via the Read tool (not confirmed deliveries):
   *  a failed/rejected Read still counts. A stable overcount across equal windows. */
  estRequestedReadTokens: number;
  wholeDocSessions: number;
}

interface ReadInput {
  file_path: string;
  offset: number | null;
  limit: number | null;
}

/** Recursively collect every Read tool_use `input` in a parsed JSONL object. */
function findReadInputs(node: unknown, out: ReadInput[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) findReadInputs(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const input = obj.input as Record<string, unknown> | undefined;
  if (obj.name === 'Read' && input && typeof input.file_path === 'string') {
    out.push({
      file_path: input.file_path,
      offset: typeof input.offset === 'number' ? input.offset : null,
      limit: typeof input.limit === 'number' ? input.limit : null,
    });
  }
  for (const value of Object.values(obj)) findReadInputs(value, out);
}

/**
 * Canonicalise a path for exact-equality comparison: backslashes to slashes,
 * duplicate slashes collapsed, `.`/`..` segments resolved textually. A
 * RELATIVE path is resolved against `repoRoot` first (the Read tool normally
 * records absolute paths, but a relative one must not silently fail to match
 * its own repo's target). Pure string logic — no fs.
 *
 * Case folding is PATH-SHAPE aware, not test-host aware: Windows-style paths
 * (drive-letter `X:/...` or UNC `//server/...`) are case-insensitive by
 * contract and fold to lowercase; POSIX absolute paths stay case-exact —
 * folding them would re-attribute a distinct /repo/Architecture.md to the
 * tracked /repo/architecture.md on a case-sensitive filesystem, the same
 * false-attribution class exact-path binding exists to prevent. Relative
 * paths inherit the semantics of the root they resolve against (the fold
 * decision is made AFTER resolution, on the resulting shape).
 */
export function canonicalisePath(p: string, repoRoot?: string): string {
  let s = p.replace(/\\/g, '/');
  const isAbsolute = s.startsWith('/') || /^[a-zA-Z]:\//.test(s);
  if (!isAbsolute && repoRoot != null) {
    s = `${repoRoot.replace(/\\/g, '/')}/${s}`;
  }
  const unc = s.startsWith('//');
  if (/^[a-zA-Z]:\//.test(s) || unc) s = s.toLowerCase();
  const segments = s.split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '' && i > 0) continue; // collapse //; keep the leading root marker
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '' && out[out.length - 1] !== '..') out.pop();
      continue;
    }
    out.push(seg);
  }
  // Keep the UNC `//server` prefix distinct from a POSIX `/server` path — the
  // shapes must never canonicalise into each other.
  return (unc ? '/' : '') + out.join('/');
}

/**
 * Bind a requested Read path to a tracked target by canonical ABSOLUTE-path
 * equality. Suffix/basename matching is forbidden here: transcripts legitimately
 * contain Reads outside the repo root, and nested files with generic names
 * (docs/architecture.md, vendor/x/architecture.md, another repo's
 * architecture.md) must never be valued at the root target's size.
 */
export function matchTarget(filePath: string, targets: DocTarget[], repoRoot: string): DocTarget | null {
  const p = canonicalisePath(filePath, repoRoot);
  for (const t of targets) {
    if (p === canonicalisePath(t.absPath)) return t;
  }
  return null;
}

// Pinned token formula (covers offset-only, limit-only, both, near-EOF, beyond-EOF):
//   linesBeforeOffset = offset ?? 0     // 0/1-index imprecision immaterial at estimate scale
//   requestedLines    = limit ?? 2000   // the Read tool's default cap
//   remainingLines    = max(0, docLines - linesBeforeOffset)
//   coveredLines      = min(requestedLines, remainingLines)
//   sliced            = (offset != null) || (limit != null)
//   estTokens         = ceil(coveredLines / docLines * docBytes / 4)
function estimateEvent(target: DocTarget, offset: number | null, limit: number | null): {
  sliced: boolean; offsetLines: number; coveredLines: number; estTokens: number;
} {
  const linesBeforeOffset = offset ?? 0;
  const requestedLines = limit ?? 2000;
  const remainingLines = Math.max(0, target.lines - linesBeforeOffset);
  const coveredLines = Math.min(requestedLines, remainingLines);
  const sliced = offset != null || limit != null;
  const estTokens = Math.ceil((coveredLines / target.lines) * target.bytes / 4);
  return { sliced, offsetLines: linesBeforeOffset, coveredLines, estTokens };
}

/**
 * Extract Read events against the tracked docs from a session's JSONL lines.
 * Each Read tool_use REQUEST becomes one event — this does not correlate the
 * request with its tool_result, so a rejected/failed Read is still counted
 * (request-based accounting; see the module header). Malformed lines are
 * skipped; untracked docs are ignored. `ts` is the enclosing line's top-level
 * `timestamp`, or null when absent. `repoRoot` resolves relative Read paths
 * before the exact-path target binding (see matchTarget).
 */
export function extractDocReads(jsonlLines: string[], targets: DocTarget[], session: string, repoRoot: string): DocReadEvent[] {
  const events: DocReadEvent[] = [];
  for (const line of jsonlLines) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // malformed line
    }
    const ts = obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>).timestamp === 'string'
      ? ((obj as Record<string, unknown>).timestamp as string)
      : null;
    const reads: ReadInput[] = [];
    findReadInputs(obj, reads);
    for (const r of reads) {
      const target = matchTarget(r.file_path, targets, repoRoot);
      if (!target) continue;
      const est = estimateEvent(target, r.offset, r.limit);
      events.push({ key: target.key, session, ts, ...est });
    }
  }
  return events;
}

/** Merge [start, end) intervals and return the total covered length. */
function mergedLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * Summarise events per target. `unslicedReadCalls`/`slicedReadCalls` count Read
 * CALLS; `wholeDocSessions` counts sessions whose merged covered line ranges
 * reach >= 80% of docLines (catches whole-file traversal via chunked reads).
 * Every target appears in the result even with zero events.
 */
export function summariseDocReads(events: DocReadEvent[], targets: DocTarget[]): DocReadSummary[] {
  return targets.map((target) => {
    const own = events.filter((e) => e.key === target.key);
    const unslicedReadCalls = own.filter((e) => !e.sliced).length;
    const slicedReadCalls = own.filter((e) => e.sliced).length;
    const estRequestedReadTokens = own.reduce((sum, e) => sum + e.estTokens, 0);

    const bySession = new Map<string, Array<[number, number]>>();
    for (const e of own) {
      const list = bySession.get(e.session) ?? [];
      list.push([e.offsetLines, e.offsetLines + e.coveredLines]);
      bySession.set(e.session, list);
    }
    let wholeDocSessions = 0;
    for (const intervals of bySession.values()) {
      if (mergedLength(intervals) >= 0.8 * target.lines) wholeDocSessions++;
    }

    return { key: target.key, unslicedReadCalls, slicedReadCalls, estRequestedReadTokens, wholeDocSessions };
  });
}

/** Whether a window is bounded (at least one edge present). */
export function isBoundedWindow(window: { since?: string; until?: string }): boolean {
  return window.since != null || window.until != null;
}

/**
 * Half-open [since, until) membership by event timestamp. Single source of the
 * windowing rule so the CLI's event filter and countActiveSessions cannot drift
 * (critical invariant: --since/--until filter EVENTS by ts, never file mtime).
 * A null ts is never in any window (bounded runs exclude undated events; the
 * unbounded case is handled by the caller, not here).
 */
export function tsInWindow(ts: string | null, window: { since?: string; until?: string }): boolean {
  if (ts == null) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  if (window.since != null && t < Date.parse(window.since)) return false;
  if (window.until != null && t >= Date.parse(window.until)) return false;
  return true;
}

export type ParsedAuditArgs =
  | { ok: true; dir: string | null; since?: string; until?: string }
  | { ok: false; error: string };

const KNOWN_AUDIT_FLAGS = new Set(['--dir', '--since', '--until']);

/**
 * Parse and VALIDATE doc-read-audit CLI args. Rejects unknown flags/positional
 * args, a flag with no value, an unparseable ISO `--since`/`--until`, and
 * reversed bounds (since >= until). A silently-dropped `--untill` or a bare
 * `--until` would leave a decision-grade run unbounded with no signal, so every
 * malformed invocation fails loud instead. Pure so it can be unit-tested.
 */
export function parseAuditArgs(argv: string[]): ParsedAuditArgs {
  let dir: string | null = null;
  let since: string | undefined;
  let until: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN_AUDIT_FLAGS.has(a)) return { ok: false, error: `unknown argument: "${a}"` };
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) return { ok: false, error: `${a} requires a value` };
    i++;
    if (a === '--dir') dir = v;
    else if (a === '--since') since = v;
    else until = v;
  }

  for (const [flag, val] of [['--since', since], ['--until', until]] as const) {
    if (val != null && Number.isNaN(Date.parse(val))) {
      return { ok: false, error: `${flag} is not a parseable ISO timestamp: "${val}"` };
    }
  }
  if (since != null && until != null && Date.parse(since) >= Date.parse(until)) {
    return { ok: false, error: `--since must be before --until (got since=${since}, until=${until})` };
  }
  return { ok: true, dir, since, until };
}

/**
 * Deterministic, collision-free report filename. A date-only name made two
 * same-day runs overwrite each other — exactly the documented baseline/post
 * comparison workflow, which runs two windows back-to-back. The name embeds
 * the WINDOW identifiers (so the two comparison artifacts are distinguishable
 * at a glance) plus the generation timestamp (so even identical re-runs never
 * clobber earlier evidence). Always matches the shipped .gitignore glob
 * `references/.doc-read-audit-*.md`.
 */
export function auditReportFileName(nowIso: string, window: { since?: string; until?: string }): string {
  const safe = (s: string): string => s.replace(/[^0-9A-Za-z]+/g, '');
  const windowPart = isBoundedWindow(window)
    ? `${safe(window.since ?? 'start')}-${safe(window.until ?? 'end')}`
    : 'all';
  return `.doc-read-audit-${windowPart}-gen-${safe(nowIso)}.md`;
}

export interface ArchSearchSummary {
  agentTokens: number;
  manualTokens: number;
  unattributedTokens: number;
  /** Non-empty telemetry rows that failed to parse (truncated/corrupt writes). */
  malformedRows: number;
  /** Parsed rows that cannot be safely attributed/windowed: an unparseable ts in
   *  a bounded run, or a non-finite/negative `chars` on a countable row. Both are
   *  un-valuable evidence of loss. */
  unattributableRows: number;
  /**
   * False when arch:search telemetry is known to be incomplete for this window:
   * the log hit its size cap or a write failed (durable gap marker), OR a
   * telemetry row is malformed, OR a row cannot be attributed/windowed. The
   * guarantee FAILS CLOSED — the audit never claims completeness while it holds
   * any evidence of loss/corruption, because incomplete telemetry biases the
   * treated-arm numerator DOWN (flattering the intervention). The remaining path
   * — log AND marker writes both fail — cannot leave evidence here; it is closed
   * at the producer: arch:search refuses to deliver context it cannot account
   * for, so no untracked delivery occurs.
   */
  telemetryComplete: boolean;
}

/**
 * A gap taints the window iff it began before the window ended. An unparseable
 * gap timestamp is treated as intersecting (conservative). Open-ended or fully
 * unbounded windows are tainted by any gap.
 */
function gapIntersectsWindow(gapTs: string, window: { since?: string; until?: string }): boolean {
  const t = Date.parse(gapTs);
  if (Number.isNaN(t)) return true;
  if (window.until == null) return true;
  return t < Date.parse(window.until);
}

/**
 * Attribute arch:search-delivered context tokens by origin, windowed by event
 * ts, and assess telemetry completeness. Only `origin:"agent"` events count
 * toward the estimate; `manual` is excluded; missing origin is surfaced as
 * `unattributed`. Any malformed (non-empty, unparseable) row or an intersecting
 * gap marker makes the window incomplete.
 */
export function summariseArchSearch(
  logLines: string[],
  markerFirstGapTs: string | null,
  window: { since?: string; until?: string },
): ArchSearchSummary {
  const bounded = isBoundedWindow(window);
  let agentTokens = 0;
  let manualTokens = 0;
  let unattributedTokens = 0;
  let malformedRows = 0;
  let unattributableRows = 0;

  for (const line of logLines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformedRows++; // a lost, un-attributable event — fail closed below
      continue;
    }
    // Bounded runs must place every countable row in the window; an unparseable
    // ts cannot be assigned to either arm, so it fails closed rather than vanish.
    if (bounded) {
      const tsValid = typeof obj.ts === 'string' && !Number.isNaN(Date.parse(obj.ts));
      if (!tsValid) { unattributableRows++; continue; }
      if (!tsInWindow(obj.ts as string, window)) continue; // legitimately out of window
    }
    // Countable (in-window bounded, or any unbounded row): needs a valuable chars.
    const charsOk = typeof obj.chars === 'number' && Number.isFinite(obj.chars) && obj.chars >= 0;
    if (!charsOk) { unattributableRows++; continue; }
    const tokens = obj.chars / 4;
    if (obj.origin === 'agent') agentTokens += tokens;
    else if (obj.origin === 'manual') manualTokens += tokens;
    else unattributedTokens += tokens;
  }

  const telemetryComplete =
    malformedRows === 0 &&
    unattributableRows === 0 &&
    (markerFirstGapTs == null || !gapIntersectsWindow(markerFirstGapTs, window));

  return { agentTokens, manualTokens, unattributedTokens, malformedRows, unattributableRows, telemetryComplete };
}

export interface ScanIssueCounts {
  /** Non-empty transcript lines that failed to parse. */
  malformedRows: number;
  /** Read events with a null (missing) top-level timestamp. */
  undatedEvents: number;
  /** Read events with a present-but-unparseable timestamp string. */
  invalidTsEvents: number;
}

/**
 * Whether a transcript scan is complete enough for a decision-grade metric.
 * A malformed (unparseable) line could hide any Read, so it fails closed in
 * every mode. In a BOUNDED run, a Read event that cannot be placed in the
 * window (null OR invalid ts) also fails closed — it may be an in-window loss
 * we cannot rule out. In an UNBOUNDED run those events are still counted (no
 * window to miss), so only malformed lines matter.
 */
export function isScanComplete(counts: ScanIssueCounts, bounded: boolean): boolean {
  if (counts.malformedRows > 0) return false;
  if (bounded && (counts.undatedEvents > 0 || counts.invalidTsEvents > 0)) return false;
  return true;
}

/**
 * Resolve the headline referenceContextTokensPerActiveSession display string.
 * Returns a decision-grade refusal ("n/a (incomplete evidence)") whenever ANY
 * input to the numerator (arch:search telemetry OR the transcript scan) is
 * incomplete, so a biased numerator can never be emitted as a valid metric.
 */
export function resolvePerSessionMetric(
  totalRequestedReadTokens: number,
  archAgentTokens: number,
  activeSessions: number,
  evidenceComplete: boolean,
): string {
  if (!evidenceComplete) return 'n/a (incomplete evidence)';
  if (activeSessions <= 0) return 'n/a';
  return Math.round((totalRequestedReadTokens + archAgentTokens) / activeSessions).toLocaleString('en-US');
}

/**
 * Count distinct active sessions (the Gate 2 denominator). A session counts once
 * regardless of stamp count. In a BOUNDED window (since and/or until present) a
 * session is active only if >= 1 stamp's ts falls in the half-open [since, until);
 * ts:null stamps never activate a bounded window. In an UNBOUNDED run any stamp
 * (dated or not) activates. Returns 0 for an empty list (the report renders "n/a").
 */
export function countActiveSessions(
  lineStamps: Array<{ session: string; ts: string | null }>,
  window: { since?: string; until?: string },
): number {
  const bounded = isBoundedWindow(window);
  const active = new Set<string>();
  for (const { session, ts } of lineStamps) {
    if (!bounded) {
      active.add(session); // unbounded: any stamp (dated or not) activates
    } else if (tsInWindow(ts, window)) {
      active.add(session);
    }
  }
  return active.size;
}

/**
 * Count Read calls against targets whose doc no longer exists on disk (no live
 * size available). A doc deleted after the measurement window still leaves its
 * reads in the transcripts; dropping them would make the decision-grade metric
 * silently optimistic, so resolveEvidenceComplete (below) refuses the metric
 * when any count here is nonzero. Bounded windows count only events with a
 * valid in-window ts —
 * undated/invalid-ts events already poison transcript completeness upstream.
 * Unbounded runs count every event, dated or not.
 */
export function countAbsentTargetReads(
  events: DocReadEvent[],
  absentKeys: string[],
  window: { since?: string; until?: string },
): Map<string, number> {
  const bounded = isBoundedWindow(window);
  const counts = new Map<string, number>();
  for (const key of absentKeys) counts.set(key, 0);
  for (const e of events) {
    if (!counts.has(e.key)) continue;
    if (bounded && !tsInWindow(e.ts, window)) continue;
    counts.set(e.key, (counts.get(e.key) as number) + 1);
  }
  return counts;
}

/**
 * The single decision point for whether the Gate 2 numerator evidence is
 * complete. Pure so the refusal invariant is provable in tests: ANY historical
 * read of a now-deleted doc, incomplete arch:search telemetry, or an incomplete
 * transcript scan makes the decision-grade metric unavailable.
 */
export function resolveEvidenceComplete(
  telemetryComplete: boolean,
  transcriptComplete: boolean,
  absentReadCounts: Map<string, number>,
): boolean {
  for (const n of absentReadCounts.values()) {
    if (n > 0) return false;
  }
  return telemetryComplete && transcriptComplete;
}
