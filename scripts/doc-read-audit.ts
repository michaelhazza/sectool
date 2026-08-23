#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// docs:read-audit — transcript-mined reference-doc Read cost, event-time windowed.
//
// Streams Claude Code session transcripts (JSONL) and estimates the tokens the
// big reference docs REQUESTED via the Read tool (request-based: a failed Read
// still counts, a stable overcount across equal windows). Proves the
// slice-first trend and feeds the Gate 2 payback comparison.
//
// Usage:
//   npx tsx scripts/doc-read-audit.ts
//   npx tsx scripts/doc-read-audit.ts --since 2026-06-01T00:00:00Z --until 2026-07-27T00:00:00Z
//   npx tsx scripts/doc-read-audit.ts --dir /path/to/project-transcript-dir
//
// Flags:
//   --dir <path>    override the derived transcript dir
//   --since <ISO>   window start (inclusive), filtered by EVENT ts
//   --until <ISO>   window end (exclusive), filtered by EVENT ts
//
// Windowing is by event timestamp, never file mtime. mtime is only a safe skip:
// a file last modified before --since cannot hold later events. Undated events
// (ts:null) are excluded from any bounded run and reported separately.
// ---------------------------------------------------------------------------

import { existsSync, statSync, readFileSync, readdirSync, createReadStream, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import {
  extractDocReads,
  summariseDocReads,
  countActiveSessions,
  isBoundedWindow,
  tsInWindow,
  parseAuditArgs,
  summariseArchSearch,
  resolvePerSessionMetric,
  isScanComplete,
  countAbsentTargetReads,
  resolveEvidenceComplete,
  auditReportFileName,
  type DocTarget,
  type DocReadEvent,
} from './lib/docReadAuditPure.js';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// The framework-standard large reference docs. Sizes always come from the live
// files at runtime; a doc the consumer has not authored is skipped (reported).
// Attribution binds to the CANONICAL ABSOLUTE path under REPO_ROOT (exact-path
// equality in matchTarget) — a nested docs/architecture.md or another repo's
// architecture.md must never be valued against these targets.
const TARGET_DEFS: Array<{ key: string; path: string }> = [
  { key: 'architecture.md', path: 'architecture.md' },
  { key: 'KNOWLEDGE.md', path: 'KNOWLEDGE.md' },
  { key: 'DEVELOPMENT_GUIDELINES.md', path: 'DEVELOPMENT_GUIDELINES.md' },
  { key: 'docs/capabilities.md', path: join('docs', 'capabilities.md') },
];

function deriveTranscriptDir(): string {
  const slug = REPO_ROOT.replace(/[:\\/]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

/** Sized targets for docs the consumer has authored (live sizes), plus the
 *  ABSENT targets. Absent docs are NOT dropped from extraction: a doc deleted
 *  after the measurement window still leaves its Read calls in the transcripts,
 *  and losing them would make the decision-grade metric silently optimistic.
 *  Absent targets cannot be token-sized, so any historical read of one forces
 *  the metric to n/a instead (wired in main()). */
function buildTargets(): { targets: DocTarget[]; absent: Array<{ key: string; absPath: string }> } {
  const targets: DocTarget[] = [];
  const absent: Array<{ key: string; absPath: string }> = [];
  for (const d of TARGET_DEFS) {
    const abs = join(REPO_ROOT, d.path);
    if (existsSync(abs)) {
      const bytes = statSync(abs).size;
      const lines = readFileSync(abs, 'utf8').split('\n').length;
      targets.push({ key: d.key, absPath: abs, bytes, lines });
    } else {
      absent.push({ key: d.key, absPath: abs });
    }
  }
  return { targets, absent };
}

/** Recursively list *.jsonl files under dir, returning paths relative to dir. */
function listTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(childRel);
    }
  };
  walk('');
  return out;
}

/**
 * Session identity (pinned): the top-level session id. A top-level file
 * `<id>.jsonl` is `<id>`; anything nested under `<id>/**` (subagents, tool
 * results) stamps the parent `<id>` — a session and its subagents are ONE
 * active session.
 */
function sessionIdFor(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return parts.length === 1 ? parts[0].replace(/\.jsonl$/, '') : parts[0];
}

async function streamFile(
  abs: string,
  session: string,
  targets: DocTarget[],
  events: DocReadEvent[],
  stamps: Array<{ session: string; ts: string | null }>,
  scan: { malformedRows: number },
): Promise<void> {
  const rl = createInterface({ input: createReadStream(abs, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    // One lineStamp per parsed transcript line (the active-session denominator).
    let ts: string | null;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    } catch {
      scan.malformedRows++; // a corrupt line could hide a Read — fail closed below
      continue;
    }
    stamps.push({ session, ts });
    for (const e of extractDocReads([line], targets, session, REPO_ROOT)) events.push(e);
  }
}

function readArchSearchLogLines(): string[] {
  const logPath = join(REPO_ROOT, 'references', '.arch-search-log.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n');
}

/** First telemetry-gap timestamp, or null if none. A present-but-corrupt marker
 *  returns an unparseable sentinel so completeness is treated conservatively. */
function readTelemetryGapMarker(): string | null {
  const markerPath = join(REPO_ROOT, 'references', '.arch-search-telemetry-incomplete');
  if (!existsSync(markerPath)) return null;
  try {
    const first = readFileSync(markerPath, 'utf8').split('\n').find((l) => l.trim());
    if (!first) return 'invalid-marker';
    const obj = JSON.parse(first) as Record<string, unknown>;
    return typeof obj.firstGapTs === 'string' ? obj.firstGapTs : 'invalid-marker';
  } catch {
    return 'invalid-marker';
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

async function main(): Promise<void> {
  // Fail loud on any malformed invocation: unknown flags, missing values,
  // unparseable ISO bounds, or reversed bounds. A silently-ignored --untill or a
  // bare --until would leave a decision-grade run unbounded with no signal.
  const parsed = parseAuditArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`docs:read-audit: ${parsed.error}`);
    process.exit(1);
  }
  const args = parsed;
  const window = { since: args.since, until: args.until };
  const bounded = isBoundedWindow(window);
  const sinceMs = args.since ? Date.parse(args.since) : null;

  const transcriptDir = args.dir ?? deriveTranscriptDir();
  if (!existsSync(transcriptDir)) {
    console.error(`docs:read-audit: transcript dir not found: ${transcriptDir}\n` +
      `Derived from ${REPO_ROOT}. Pass --dir <path> to override.`);
    process.exit(1);
  }

  const { targets, absent } = buildTargets();
  // Detection-only placeholder targets: historical reads of now-deleted docs are
  // still extracted and counted. bytes:0 makes every estTokens 0 and lines:1
  // avoids division by zero, so these events can never contaminate token totals;
  // they are excluded from summariseDocReads below (it only maps sized targets).
  const detectionTargets: DocTarget[] = absent.map((a) => ({ key: a.key, absPath: a.absPath, bytes: 0, lines: 1 }));
  const extractionTargets: DocTarget[] = [...targets, ...detectionTargets];
  const events: DocReadEvent[] = [];
  const stamps: Array<{ session: string; ts: string | null }> = [];
  const scan = { malformedRows: 0 };

  const relPaths = listTranscripts(transcriptDir);
  let skippedByMtime = 0;
  for (const rel of relPaths) {
    const abs = join(transcriptDir, rel);
    // Safe skip only: a file last modified before --since cannot hold later events.
    if (sinceMs != null && statSync(abs).mtimeMs < sinceMs) {
      skippedByMtime++;
      continue;
    }
    await streamFile(abs, sessionIdFor(rel), extractionTargets, events, stamps, scan);
  }

  // Event-ts window filter (never mtime). A Read event that cannot be placed in a
  // bounded window (null OR unparseable ts) is a possible in-window loss, so it is
  // counted for the fail-closed completeness check rather than silently dropped.
  let undated = 0;
  let invalidTsEvents = 0;
  const scopedEvents = events.filter((e) => {
    if (!bounded) return true;
    if (e.ts == null) { undated++; return false; }
    if (Number.isNaN(Date.parse(e.ts))) { invalidTsEvents++; return false; }
    return tsInWindow(e.ts, window);
  });

  const summaries = summariseDocReads(scopedEvents, targets);
  const activeSessions = countActiveSessions(stamps, window);
  const arch = summariseArchSearch(readArchSearchLogLines(), readTelemetryGapMarker(), window);
  const transcriptComplete = isScanComplete(
    { malformedRows: scan.malformedRows, undatedEvents: undated, invalidTsEvents },
    bounded,
  );
  // Fail closed on historical reads of docs that no longer exist: their token
  // cost cannot be sized, so a nonzero count refuses the decision-grade metric.
  const absentReadCounts = countAbsentTargetReads(events, absent.map((a) => a.key), window);
  // Fail closed on ANY numerator input that could not be parsed or windowed.
  const evidenceComplete = resolveEvidenceComplete(arch.telemetryComplete, transcriptComplete, absentReadCounts);

  const totalRequestedReadTokens = summaries.reduce((sum, s) => sum + s.estRequestedReadTokens, 0);
  const perSession = resolvePerSessionMetric(
    totalRequestedReadTokens,
    arch.agentTokens,
    activeSessions,
    evidenceComplete,
  );

  // ---- Build the report ----
  const nowIso = new Date().toISOString();
  const windowLine = bounded
    ? `Window: [${args.since ?? '-inf'}, ${args.until ?? '+inf'}) by event timestamp`
    : `Window: unbounded (all retained transcript history), generated ${nowIso}`;

  const lines: string[] = [];
  lines.push(`# Doc-read audit`);
  lines.push('');
  lines.push(windowLine);
  lines.push(`Transcript dir: ${transcriptDir}`);
  lines.push(`Transcripts scanned: ${relPaths.length - skippedByMtime} (skipped by mtime: ${skippedByMtime})`);
  for (const [key, n] of absentReadCounts.entries()) {
    if (n === 0) {
      lines.push(`Target skipped (doc not authored in this repo, no historical reads in window): ${key}`);
    } else {
      lines.push(`ABSENT TARGET WITH HISTORICAL READS: ${key}, ${n} Read call(s) in window but the doc no longer exists so its token cost cannot be sized; decision-grade metric refused`);
    }
  }
  lines.push('');
  lines.push(`| Doc | unslicedReadCalls | slicedReadCalls | Estimated requested-Read tokens (Read requests, not confirmed deliveries; arch:search output NOT included) | wholeDocSessions |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: |`);
  for (const s of summaries) {
    lines.push(`| ${s.key} | ${s.unslicedReadCalls} | ${s.slicedReadCalls} | ${fmt(s.estRequestedReadTokens)} | ${s.wholeDocSessions} |`);
  }
  lines.push(`| **total** | | | **${fmt(totalRequestedReadTokens)}** | |`);
  lines.push(`Note: request-based - counts Read REQUESTS, not confirmed deliveries; a failed/rejected Read still counts (an accepted overcount, stable across equal windows).`);
  lines.push('');
  lines.push(`arch:search-delivered context (agent origin, tokens): ${fmt(arch.agentTokens)}`);
  lines.push(`  excluded manual-origin: ${fmt(arch.manualTokens)}; unattributed (missing origin): ${fmt(arch.unattributedTokens)}`);
  lines.push(`arch:search telemetry completeness: ${arch.telemetryComplete ? 'complete' : 'incomplete'} (malformed rows: ${arch.malformedRows}, unattributable rows: ${arch.unattributableRows})`);
  lines.push(`transcript completeness: ${transcriptComplete ? 'complete' : 'incomplete'} (malformed rows: ${scan.malformedRows}, undated events: ${undated}, invalid-ts events: ${invalidTsEvents})`);
  if (!evidenceComplete) {
    lines.push(`Gate 2 verdict: n/a (incomplete evidence - a numerator input (arch:search telemetry, a transcript Read, or a historical read of a now-deleted doc) could not be parsed, sized, or assigned to the window; the metric would be understated)`);
  }
  lines.push(`Active sessions (denominator): ${activeSessions}`);
  if (evidenceComplete) {
    lines.push(`referenceContextTokensPerActiveSession = (requested-Read ${fmt(totalRequestedReadTokens)} + arch:search ${fmt(arch.agentTokens)}) / ${activeSessions} = ${perSession}`);
  } else {
    lines.push(`referenceContextTokensPerActiveSession = ${perSession}`);
  }
  lines.push('');
  const headlineTail = evidenceComplete ? ' Raw totals are workload-sensitive context only.' : '';
  lines.push(`Headline comparison metric: referenceContextTokensPerActiveSession = ${perSession}.${headlineTail}`);

  const report = lines.join('\n');
  console.log(report);

  // Window-identified + timestamped: two same-day runs (the documented
  // baseline/post comparison workflow) must never overwrite each other.
  const outPath = join(REPO_ROOT, 'references', auditReportFileName(nowIso, window));
  try {
    writeFileSync(outPath, report + '\n');
    console.log(`\nWrote ${outPath}`);
  } catch (err) {
    console.error(`Could not write report file: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
