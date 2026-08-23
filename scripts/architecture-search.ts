#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// arch:search — ranked section retrieval over architecture.md for the dev fleet.
//
// architecture.md is ~6,300 lines / ~246K tokens; a full read is the single
// biggest per-session token pool. This CLI parses the file into its ~78 `## `
// sections (via their `<a id>` anchors) and prints the top-N most relevant to a
// query, each with an `architecture.md:LINE #anchor` pointer so an agent can
// Read only the matching sections instead of the whole file. Mirrors
// knowledge-search's arg style and telemetry-free purity split.
//
// Usage:
//   npx tsx scripts/architecture-search.ts "rls tenant isolation"
//   npx tsx scripts/architecture-search.ts --limit 3 "route conventions"
//   npx tsx scripts/architecture-search.ts --full "idempotency keys"
//   npx tsx scripts/architecture-search.ts --toc
//   (consumers may alias this as an npm script, e.g. automation-v1's `npm run arch:search`)
//
// Flags:
//   --limit N   max results (default 5)
//   --full      print whole section bodies instead of excerpts
//   --toc       ignore the query; print every section as start-end #anchor title
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArchitectureSections, rankSections } from './lib/architectureSearchPure.js';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ARCH_PATH = join(REPO_ROOT, 'architecture.md');
const LOG_PATH = join(REPO_ROOT, 'references', '.arch-search-log.jsonl');
// Durable marker: written the FIRST time telemetry is dropped (size cap hit or a
// write failed). docs:read-audit reads it and refuses a decision-grade Gate 2
// metric when the loss intersects the measurement window — silent telemetry loss
// would understate the treated-arm numerator and flatter the intervention.
const TELEMETRY_GAP_MARKER = join(REPO_ROOT, 'references', '.arch-search-telemetry-incomplete');
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const EXCERPT_CHARS = 240;

interface Args {
  query: string;
  limit: number;
  full: boolean;
  toc: boolean;
}

function parseArgs(argv: string[]): Args {
  let limit = 5;
  let full = false;
  let toc = false;
  const queryParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      limit = Math.max(1, parseInt(argv[++i] ?? '5', 10) || 5);
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--toc') {
      toc = true;
    } else {
      queryParts.push(arg);
    }
  }
  return { query: queryParts.join(' '), limit, full, toc };
}

// Record the first telemetry-loss event durably (write-once) so the audit can
// see that the telemetry population is incomplete. Returns whether the loss is
// now durably recorded (marker already present counts as recorded).
//
// MUST be atomic create-if-absent (flag 'wx'), never check-then-write: two
// concurrent losing processes racing an existsSync gate could let the later
// one overwrite firstGapTs with a LATER timestamp, and the audit's
// gapIntersectsWindow() would then call a window complete that already
// contained the earlier loss — a falsely authoritative Gate 2 metric. EEXIST
// is success: another process durably preserved an equal-or-earlier first
// loss, and the existing marker is never modified.
function writeGapMarkerIfAbsent(reason: string): boolean {
  try {
    writeFileSync(
      TELEMETRY_GAP_MARKER,
      JSON.stringify({ firstGapTs: new Date().toISOString(), reason }) + '\n',
      { flag: 'wx' },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return true;
    return false;
  }
}

// Returns true when this search is accountable: either the event was appended,
// or the loss was durably marked (size cap). Returns false ONLY in the
// catastrophic case where neither the log nor the marker can be written — the
// loss would then be undetectable, so the caller must fail closed rather than
// deliver unaccountable context. Manual operator runs (CLAUDECODE unset) are
// tagged so the audit can exclude terminal-only output from the estimate.
function recordTelemetry(query: string, chars: number): boolean {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      // Expected loss (log full): detectable via the marker, so delivery is fine.
      return writeGapMarkerIfAbsent('size-cap');
    }
    const origin = process.env.CLAUDECODE ? 'agent' : 'manual';
    const line = JSON.stringify({ ts: new Date().toISOString(), query, chars, origin });
    appendFileSync(LOG_PATH, line + '\n');
    return true;
  } catch {
    // Log append failed: the loss is only detectable if we can mark it durably.
    return writeGapMarkerIfAbsent('write-error');
  }
}

function main(): void {
  const { query, limit, full, toc } = parseArgs(process.argv.slice(2));

  if (!query.trim() && !toc) {
    console.error('Usage: npx tsx scripts/architecture-search.ts [--limit N] [--full] [--toc] "<query>"');
    process.exit(1);
  }

  if (!existsSync(ARCH_PATH)) {
    console.error(`arch:search: architecture.md not found at ${ARCH_PATH}. Set CLAUDE_PROJECT_DIR or run from the repo root.`);
    process.exit(1);
  }

  const sections = parseArchitectureSections(readFileSync(ARCH_PATH, 'utf8'));
  const lines: string[] = [];

  if (toc) {
    for (const s of sections) {
      lines.push(`${s.startLine}-${s.endLine} #${s.anchor} ${s.title}`);
    }
  } else {
    const results = rankSections(sections, query, limit);
    if (results.length === 0) {
      lines.push(`No architecture.md sections matched: "${query}"`);
    } else {
      lines.push(`Top ${results.length} architecture.md sections for: "${query}"`);
      lines.push('');
      for (const s of results) {
        lines.push(`architecture.md:${s.startLine} #${s.anchor} - ${s.title} (score ${s.score})`);
        const body = full ? s.body : s.body.trim().slice(0, EXCERPT_CHARS);
        if (body) {
          lines.push(body.split('\n').map((l) => `   ${l}`).join('\n'));
        }
        lines.push('');
      }
    }
  }

  const out = lines.join('\n');
  // Account for the delivery BEFORE emitting it. If telemetry cannot be recorded
  // anywhere durable (log AND marker writes both fail), refuse to deliver context
  // we cannot account for: for a decision-grade experiment a silent, undetectable
  // measurement hole is worse than a failed search. The agent falls back to a
  // tracked Read, so nothing goes unmeasured.
  if (!recordTelemetry(toc ? '--toc' : query, out.length)) {
    console.error('arch:search: cannot record telemetry (log and gap-marker writes both failed); refusing to deliver unaccountable context. Read the section directly instead.');
    process.exit(1);
  }
  console.log(out);
}

main();
