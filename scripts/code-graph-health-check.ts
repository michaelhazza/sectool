/**
 * code-graph-health-check.ts
 *
 * On-demand health check for the code-intelligence cache built by
 * scripts/build-code-graph.ts. Deterministic — no LLM, no network. Produces a
 * one-page markdown report:
 *   - to stdout
 *   - to references/.code-graph-health-YYYY-MM-DD.md (reports accumulate)
 *
 * Signals collected:
 *   - Operational: watcher liveness (PID file), watcher log presence / size /
 *     error patterns, cache staleness vs newest source mtime, shard integrity
 *     (exists, non-empty, parseable JSON).
 *   - Coverage: source files on disk vs files present in shards; extraction
 *     skip rate from import-graph/.skipped.txt.
 *   - Churn: git-log hotspot table over the last 90 days (advisory banner;
 *     failure to read git history never fails the run).
 *
 * Verdict: GREEN / YELLOW / RED, rule-based and reproducible across runs.
 *
 * Genericisation note (framework port): the consumer original additionally
 * scanned local Claude Code transcripts for adoption/correction telemetry,
 * called an LLM to narrate the report, and emitted a KEEP/TUNE/ESCALATE/KILL
 * lifecycle recommendation tied to that repo's phase-trigger doc. Those layers
 * are deliberately omitted here: the telemetry heuristics were tuned to one
 * repo's usage study, the narration required a pinned provider model + API
 * key, and the lifecycle verdict referenced repo-local trigger thresholds.
 * The deterministic operational/coverage core below is the portable part.
 *
 * Configuration (matches build-code-graph.ts):
 *   CODE_GRAPH_ROOT            — project root. Default: process.cwd().
 *   CODE_GRAPH_SCAN_DIRS       — comma-separated scan roots.
 *   CODE_GRAPH_REFERENCES_DIR  — references dir override.
 *
 * Usage:
 *   npx tsx scripts/code-graph-health-check.ts            # report, exit 0
 *   npx tsx scripts/code-graph-health-check.ts --strict   # exit 1 when RED
 *
 * Dependencies: Node stdlib only (plus git on PATH for the churn section).
 */

import { promises as fs, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Paths + configuration
// ---------------------------------------------------------------------------

const ROOT = process.env.CODE_GRAPH_ROOT
  ? path.resolve(process.env.CODE_GRAPH_ROOT)
  : process.cwd();

const REFERENCES_DIR = process.env.CODE_GRAPH_REFERENCES_DIR
  ? path.resolve(process.env.CODE_GRAPH_REFERENCES_DIR)
  : path.join(ROOT, 'references');

const SHARD_DIR = path.join(REFERENCES_DIR, 'import-graph');
const CACHE_PATH = path.join(REFERENCES_DIR, '.code-graph-cache.json');
const PROJECT_MAP_PATH = path.join(REFERENCES_DIR, 'project-map.md');
const WATCHER_LOG_PATH = path.join(REFERENCES_DIR, '.code-graph-watcher.log');
const WATCHER_PID_PATH = path.join(REFERENCES_DIR, '.watcher.pid');
const SKIPPED_PATH = path.join(SHARD_DIR, '.skipped.txt');

const DEFAULT_SCAN_DIRS = ['server', 'client', 'shared', 'scripts'];

// Thresholds
const COVERAGE_GREEN_PCT = 95;
const SKIP_RATE_FAIL_PCT = 5;
const LOG_SIZE_FLAG_BYTES = 5 * 1024 * 1024;
const STALE_CACHE_MIN = 60;

// Churn
const CHURN_WINDOW_DAYS = 90;
const CHURN_WARM_THRESHOLD = 15;
const CHURN_HOT_SINGLE_THRESHOLD = 30;
const CHURN_TOP_N = 10;
const CHURN_GIT_TIMEOUT_MS = 20_000;
const CHURN_GIT_MAX_BUFFER = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Scan roots (same derivation as build-code-graph.ts — kept file-local so
// both scripts stay independently syncable)
// ---------------------------------------------------------------------------

function deriveScanDirs(): string[] {
  let candidates: string[] = [];
  const envDirs = (process.env.CODE_GRAPH_SCAN_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (envDirs.length > 0) {
    candidates = envDirs;
  } else {
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const ws: unknown = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws) && ws.length > 0) {
        for (const entry of ws) {
          if (typeof entry !== 'string') continue;
          if (entry.endsWith('/*')) {
            const base = path.join(ROOT, entry.slice(0, -2));
            try {
              for (const e of readdirSync(base, { withFileTypes: true })) {
                if (e.isDirectory()) candidates.push(path.posix.join(entry.slice(0, -2), e.name));
              }
            } catch { /* base missing */ }
          } else {
            candidates.push(entry);
          }
        }
      }
    } catch { /* fall through */ }
    if (candidates.length === 0) candidates = [...DEFAULT_SCAN_DIRS];
  }
  return candidates.filter((d) => existsSync(path.join(ROOT, d)));
}

const SCAN_DIRS = deriveScanDirs();
const SHARDS = SCAN_DIRS.map((d) => path.join(SHARD_DIR, `${d.replace(/[\\/]+/g, '-')}.json`));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Status = 'GREEN' | 'YELLOW' | 'RED';

interface OperationalSignals {
  watcherRunning: boolean | null;
  watcherPid: number | null;
  watcherLogExists: boolean;
  watcherLogSize: number;
  watcherLogLargeFlag: boolean;
  errorPatternCounts: Record<string, number>;
  errorExamples: string[];
  cacheMtime: string | null;
  projectMapMtime: string | null;
  newestSourceMtime: string | null;
  cacheStaleByMin: number | null;
  shardSizes: Record<string, number>;
  shardOk: boolean;
  shardErrors: string[];
}

interface CoverageSignals {
  totalFiles: number;
  filesByDir: Record<string, number>;
  shardFileCounts: Record<string, number>;
  coveragePct: number;
  belowThreshold: boolean;
  skippedCount: number;
  skipRateByDir: Record<string, number>;
  anyDirOverSkipFail: boolean;
}

type ChurnVerdict = 'HEALTHY' | 'WATCH' | 'HOTSPOT';

interface ChurnHotspot {
  path: string;
  commitCount: number;
  lastTouchedISO: string;
}

interface ChurnSignals {
  windowDays: number;
  totalFilesTouched: number;
  filesOverWarmThreshold: number;
  maxCommitCount: number;
  hotspots: ChurnHotspot[];
  verdict: ChurnVerdict;
  collectionError: string | null;
}

// ---------------------------------------------------------------------------
// Operational collection
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'error', re: /\berror\b/i },
  { name: 'failed', re: /\bfail(ed|ure)?\b/i },
  { name: 'ENOSPC', re: /ENOSPC/ },
  { name: 'EMFILE', re: /EMFILE/ },
];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === 'EPERM';
  }
}

async function collectOperational(): Promise<OperationalSignals> {
  const out: OperationalSignals = {
    watcherRunning: null,
    watcherPid: null,
    watcherLogExists: false,
    watcherLogSize: 0,
    watcherLogLargeFlag: false,
    errorPatternCounts: {},
    errorExamples: [],
    cacheMtime: null,
    projectMapMtime: null,
    newestSourceMtime: null,
    cacheStaleByMin: null,
    shardSizes: {},
    shardOk: true,
    shardErrors: [],
  };

  if (existsSync(WATCHER_LOG_PATH)) {
    const st = await fs.stat(WATCHER_LOG_PATH);
    out.watcherLogExists = true;
    out.watcherLogSize = st.size;
    out.watcherLogLargeFlag = st.size > LOG_SIZE_FLAG_BYTES;
    const content = await fs.readFile(WATCHER_LOG_PATH, 'utf8');
    const tail = content.split(/\r?\n/).slice(-1000);
    for (const { name } of ERROR_PATTERNS) out.errorPatternCounts[name] = 0;
    for (const line of tail) {
      for (const { name, re } of ERROR_PATTERNS) {
        if (re.test(line)) {
          out.errorPatternCounts[name]++;
          if (out.errorExamples.length < 5) out.errorExamples.push(line.slice(0, 240));
        }
      }
    }
  }

  if (existsSync(WATCHER_PID_PATH)) {
    try {
      const pid = Number.parseInt((await fs.readFile(WATCHER_PID_PATH, 'utf8')).trim(), 10);
      if (Number.isFinite(pid)) {
        out.watcherPid = pid;
        out.watcherRunning = isPidAlive(pid);
      }
    } catch { /* ignore */ }
  } else {
    out.watcherRunning = false;
  }

  if (existsSync(CACHE_PATH)) out.cacheMtime = (await fs.stat(CACHE_PATH)).mtime.toISOString();
  if (existsSync(PROJECT_MAP_PATH)) out.projectMapMtime = (await fs.stat(PROJECT_MAP_PATH)).mtime.toISOString();

  // Newest source mtime under scan roots
  let newestMs = 0;
  async function walk(dir: string): Promise<void> {
    let dirents;
    try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name === 'node_modules' || d.name === 'dist' || d.name === 'build' || d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile() && /\.(ts|tsx)$/.test(d.name)) {
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        } catch { /* ignore */ }
      }
    }
  }
  for (const top of SCAN_DIRS) await walk(path.join(ROOT, top));
  if (newestMs > 0) {
    out.newestSourceMtime = new Date(newestMs).toISOString();
    if (out.cacheMtime) {
      out.cacheStaleByMin = Math.round((newestMs - Date.parse(out.cacheMtime)) / 60_000);
    }
  }

  for (const shard of SHARDS) {
    const name = path.basename(shard);
    if (!existsSync(shard)) {
      out.shardOk = false;
      out.shardErrors.push(`${name}: missing`);
      out.shardSizes[name] = 0;
      continue;
    }
    const st = await fs.stat(shard);
    out.shardSizes[name] = st.size;
    if (st.size === 0) {
      out.shardOk = false;
      out.shardErrors.push(`${name}: zero-byte`);
      continue;
    }
    try {
      JSON.parse(await fs.readFile(shard, 'utf8'));
    } catch (err) {
      out.shardOk = false;
      out.shardErrors.push(`${name}: invalid JSON (${(err as Error)?.message ?? 'unknown'})`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Coverage collection
// ---------------------------------------------------------------------------

async function collectCoverage(): Promise<CoverageSignals> {
  const filesByDir: Record<string, number> = {};
  let total = 0;
  async function walk(dir: string, top: string): Promise<void> {
    let dirents;
    try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name === 'node_modules' || d.name === 'dist' || d.name === 'build' || d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full, top);
      else if (d.isFile() && /\.(ts|tsx)$/.test(d.name) && !/\.d\.ts$/.test(d.name) && !/\.generated\.ts$/.test(d.name)) {
        filesByDir[top] = (filesByDir[top] || 0) + 1;
        total++;
      }
    }
  }
  for (const top of SCAN_DIRS) await walk(path.join(ROOT, top), top);

  const shardFileCounts: Record<string, number> = {};
  let inShards = 0;
  for (const top of SCAN_DIRS) {
    const shard = path.join(SHARD_DIR, `${top.replace(/[\\/]+/g, '-')}.json`);
    if (!existsSync(shard)) { shardFileCounts[top] = 0; continue; }
    try {
      const j = JSON.parse(await fs.readFile(shard, 'utf8'));
      const n = j?.files ? Object.keys(j.files).length : 0;
      shardFileCounts[top] = n;
      inShards += n;
    } catch {
      shardFileCounts[top] = 0;
    }
  }

  let skippedCount = 0;
  const skipsByDir: Record<string, number> = {};
  if (existsSync(SKIPPED_PATH)) {
    const raw = await fs.readFile(SKIPPED_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    skippedCount = lines.length;
    for (const line of lines) {
      const filePart = line.split('\t')[0]?.trim() ?? '';
      const top = SCAN_DIRS.find((d) => filePart.startsWith(d.toLowerCase() + '/') || filePart.startsWith(d + '/'));
      if (top) skipsByDir[top] = (skipsByDir[top] || 0) + 1;
    }
  }
  const skipRateByDir: Record<string, number> = {};
  let anyOver = false;
  for (const top of SCAN_DIRS) {
    const denom = filesByDir[top] || 0;
    const skips = skipsByDir[top] || 0;
    const pct = denom === 0 ? 0 : Math.round((skips / denom) * 1000) / 10;
    skipRateByDir[top] = pct;
    if (pct > SKIP_RATE_FAIL_PCT) anyOver = true;
  }

  const rawCoverage = total === 0 ? 0 : Math.round((inShards / total) * 1000) / 10;
  const coveragePct = Math.min(rawCoverage, 100);
  return {
    totalFiles: total,
    filesByDir,
    shardFileCounts,
    coveragePct,
    belowThreshold: coveragePct < COVERAGE_GREEN_PCT,
    skippedCount,
    skipRateByDir,
    anyDirOverSkipFail: anyOver,
  };
}

// ---------------------------------------------------------------------------
// Churn collection (git, advisory)
// ---------------------------------------------------------------------------

function shouldExcludeChurnPath(p: string): boolean {
  if (!p) return true;
  if (p.startsWith('tasks/') || p.startsWith('docs/') || p.startsWith('references/')) return true;
  const segments = p.split('/');
  if (segments.some((s) => s === 'node_modules' || s === 'dist' || s === 'build')) return true;
  const base = path.posix.basename(p);
  if (['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].includes(base)) return true;
  if (p.endsWith('.min.js') || p.endsWith('.map')) return true;
  return false;
}

function computeChurnVerdict(maxCount: number, filesOverWarm: number): ChurnVerdict {
  if (maxCount > CHURN_HOT_SINGLE_THRESHOLD || filesOverWarm >= 3) return 'HOTSPOT';
  if (filesOverWarm >= 1) return 'WATCH';
  return 'HEALTHY';
}

function collectChurn(): ChurnSignals {
  const empty = (error: string | null): ChurnSignals => ({
    windowDays: CHURN_WINDOW_DAYS,
    totalFilesTouched: 0,
    filesOverWarmThreshold: 0,
    maxCommitCount: 0,
    hotspots: [],
    verdict: 'HEALTHY',
    collectionError: error,
  });

  let stdout: string;
  try {
    const res = spawnSync(
      'git',
      ['log', `--since=${CHURN_WINDOW_DAYS} days ago`, '--name-only', '--pretty=format:__COMMIT__ %cI'],
      { cwd: ROOT, encoding: 'utf8', timeout: CHURN_GIT_TIMEOUT_MS, maxBuffer: CHURN_GIT_MAX_BUFFER },
    );
    if (res.error) return empty(`git spawn failed: ${res.error.message}`);
    if (res.status !== 0) return empty(`git exited ${res.status}: ${(res.stderr ?? '').slice(0, 200)}`);
    stdout = res.stdout ?? '';
  } catch (err) {
    return empty(`git threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fileMap = new Map<string, { commits: number; lastISO: string }>();
  let currentDate = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('__COMMIT__ ')) {
      currentDate = line.slice('__COMMIT__ '.length).trim();
      continue;
    }
    if (!line.trim()) continue;
    if (shouldExcludeChurnPath(line)) continue;
    const existing = fileMap.get(line);
    if (existing) {
      existing.commits++;
      if (currentDate && currentDate > existing.lastISO) existing.lastISO = currentDate;
    } else {
      fileMap.set(line, { commits: 1, lastISO: currentDate });
    }
  }

  let filesOverWarm = 0;
  let maxCount = 0;
  for (const v of fileMap.values()) {
    if (v.commits > maxCount) maxCount = v.commits;
    if (v.commits > CHURN_WARM_THRESHOLD) filesOverWarm++;
  }

  const hotspots: ChurnHotspot[] = [...fileMap.entries()]
    .sort((a, b) => (b[1].commits - a[1].commits) || (b[1].lastISO || '').localeCompare(a[1].lastISO || ''))
    .slice(0, CHURN_TOP_N)
    .map(([p, info]) => ({ path: p, commitCount: info.commits, lastTouchedISO: info.lastISO }));

  return {
    windowDays: CHURN_WINDOW_DAYS,
    totalFilesTouched: fileMap.size,
    filesOverWarmThreshold: filesOverWarm,
    maxCommitCount: maxCount,
    hotspots,
    verdict: computeChurnVerdict(maxCount, filesOverWarm),
    collectionError: null,
  };
}

// ---------------------------------------------------------------------------
// Verdict (deterministic)
// ---------------------------------------------------------------------------

function computeVerdict(op: OperationalSignals, cov: CoverageSignals): { status: Status; reasons: string[] } {
  const reasons: string[] = [];
  let status: Status = 'GREEN';

  const hasOperationalFailure =
    !op.shardOk ||
    cov.anyDirOverSkipFail ||
    (op.errorPatternCounts['ENOSPC'] ?? 0) > 0 ||
    (op.errorPatternCounts['EMFILE'] ?? 0) > 0;

  if (hasOperationalFailure) {
    status = 'RED';
    if (!op.shardOk) reasons.push(`Shard integrity broken: ${op.shardErrors.join('; ')}`);
    if (cov.anyDirOverSkipFail) reasons.push(`Skip rate exceeds ${SKIP_RATE_FAIL_PCT}% in at least one directory`);
    if ((op.errorPatternCounts['ENOSPC'] ?? 0) > 0) reasons.push('Watcher log shows ENOSPC');
    if ((op.errorPatternCounts['EMFILE'] ?? 0) > 0) reasons.push('Watcher log shows EMFILE');
  } else {
    const yellow: string[] = [];
    if (cov.belowThreshold) yellow.push(`Shard coverage at ${cov.coveragePct}% (target ≥${COVERAGE_GREEN_PCT}%)`);
    if ((op.cacheStaleByMin ?? 0) > STALE_CACHE_MIN) yellow.push(`Cache is ${op.cacheStaleByMin} min behind newest source file`);
    if (op.watcherLogLargeFlag) yellow.push(`Watcher log >${LOG_SIZE_FLAG_BYTES / 1024 / 1024}MB (${(op.watcherLogSize / 1024 / 1024).toFixed(1)}MB)`);
    if (op.watcherRunning === false) {
      yellow.push('Watcher process is not running (cache refreshes only at session start)');
    } else if (op.watcherRunning === null) {
      yellow.push('Watcher state unknown — PID file unreadable; investigate');
    }
    const totalErrors = Object.values(op.errorPatternCounts).reduce((a, b) => a + b, 0);
    if (totalErrors > 20) yellow.push(`${totalErrors} error/failure lines in last 1000 watcher log entries`);
    if (yellow.length > 0) {
      status = 'YELLOW';
      reasons.push(...yellow);
    }
  }

  if (status === 'GREEN') reasons.push('No concerns detected.');
  return { status, reasons };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/`/g, 'ˋ');
}

function renderReport(
  generatedAt: string,
  status: Status,
  reasons: string[],
  op: OperationalSignals,
  cov: CoverageSignals,
  churn: ChurnSignals,
): string {
  const lines: string[] = [];
  lines.push('# Code Intelligence Cache Health Check');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push('');
  lines.push(`**Status: ${status}**`);
  lines.push('');
  for (const r of reasons) lines.push(`- ${r}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 1. Is the watcher healthy?');
  lines.push('');
  lines.push(`- Watcher running: ${op.watcherRunning === null ? 'unknown' : op.watcherRunning}${op.watcherPid ? ` (pid ${op.watcherPid})` : ''}`);
  lines.push(`- Watcher log: ${op.watcherLogExists ? `${(op.watcherLogSize / 1024).toFixed(1)} KB` : 'missing'}`);
  lines.push(`- Cache mtime: ${op.cacheMtime ?? 'missing'}`);
  lines.push(`- Newest source mtime: ${op.newestSourceMtime ?? 'n/a'}`);
  lines.push(`- Cache staleness: ${op.cacheStaleByMin === null ? 'n/a' : `${op.cacheStaleByMin} min`}`);
  lines.push(`- Shards: ${op.shardOk ? 'all present and parseable' : op.shardErrors.join('; ')}`);
  if (op.errorExamples.length > 0) {
    lines.push(`- Recent log error examples:`);
    for (const e of op.errorExamples) lines.push(`  - \`${escapeTableCell(e)}\``);
  }
  lines.push('');

  lines.push('## 2. Coverage');
  lines.push('');
  lines.push(`- Source files on disk: ${cov.totalFiles}`);
  lines.push(`- Coverage: ${cov.coveragePct}% (target ≥${COVERAGE_GREEN_PCT}%)`);
  lines.push(`- Extraction skips: ${cov.skippedCount}`);
  lines.push('');
  lines.push('| Directory | Files on disk | In shard | Skip rate |');
  lines.push('|-----------|---------------|----------|-----------|');
  for (const dir of SCAN_DIRS) {
    lines.push(`| \`${dir}\` | ${cov.filesByDir[dir] ?? 0} | ${cov.shardFileCounts[dir] ?? 0} | ${cov.skipRateByDir[dir] ?? 0}% |`);
  }
  lines.push('');

  lines.push('## 3. Churn Hotspots');
  lines.push('');
  if (churn.collectionError) {
    lines.push(`**Churn verdict: HEALTHY** (could not read git history: ${churn.collectionError}).`);
  } else if (churn.verdict === 'HEALTHY') {
    lines.push(`**Churn verdict: HEALTHY** — no file exceeded ${CHURN_WARM_THRESHOLD} commits in the last ${churn.windowDays} days.`);
  } else if (churn.verdict === 'WATCH') {
    lines.push(`**Churn verdict: WATCH** — ${churn.filesOverWarmThreshold} file(s) crossed ${CHURN_WARM_THRESHOLD} commits in ${churn.windowDays} days. Monitor for runaway complexity.`);
  } else {
    lines.push(`**Churn verdict: HOTSPOT** — ${churn.filesOverWarmThreshold} file(s) above ${CHURN_WARM_THRESHOLD} commits${churn.maxCommitCount > CHURN_HOT_SINGLE_THRESHOLD ? `, top file at ${churn.maxCommitCount}` : ''}. Refactor candidates.`);
  }
  lines.push('');
  if (churn.hotspots.length > 0) {
    lines.push(`| File | Commits (${churn.windowDays}d) | Last touched |`);
    lines.push('|------|------|--------------|');
    for (const h of churn.hotspots) {
      lines.push(`| \`${escapeTableCell(h.path)}\` | ${h.commitCount} | ${h.lastTouchedISO ? h.lastTouchedISO.slice(0, 10) : 'unknown'} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const now = new Date();
  const generatedAt = now.toISOString();

  if (SCAN_DIRS.length === 0) {
    console.log('code-graph-health-check: no scan roots exist — nothing to check.');
    return;
  }

  const [op, cov] = await Promise.all([collectOperational(), collectCoverage()]);
  const churn = collectChurn();
  const { status, reasons } = computeVerdict(op, cov);
  const report = renderReport(generatedAt, status, reasons, op, cov, churn);

  process.stdout.write(report);

  const dateKey = generatedAt.slice(0, 10);
  const reportPath = path.join(REFERENCES_DIR, `.code-graph-health-${dateKey}.md`);
  try {
    await fs.mkdir(REFERENCES_DIR, { recursive: true });
    await fs.writeFile(reportPath, report, 'utf8');
    console.log(`\n(report saved to ${path.relative(ROOT, reportPath).replace(/\\/g, '/')})`);
  } catch (err) {
    console.warn(`could not persist report: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (strict && status === 'RED') process.exit(1);
}

main().catch((err) => {
  console.error('code-graph-health-check: fatal:', err);
  process.exit(1);
});
