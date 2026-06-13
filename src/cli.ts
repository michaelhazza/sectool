import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadAllowlist, loadTargets, loadBaseline, ConfigError } from './config/load.js';
import { scanRepos } from './static/orchestrator.js';
import { preflight, dryRun } from './live/preflight.js';
import { loginForTarget } from './live/auth.js';
import { runZap } from './live/scanners/zap.js';
import { runNuclei } from './live/scanners/nuclei.js';
import { correlate } from './correlate/correlate.js';
import { buildReport, writeReport } from './report/json.js';
import { toMarkdown } from './report/markdown.js';
import { toSarif } from './report/sarif.js';
import {
  writeTrend,
  buildTrendLine,
  readTrendLines,
  buildPrevFingerprintMap,
} from './report/trend.js';
import { withWorkspaceLock, WorkspaceLockedError } from './report/lock.js';
import type { ScannerStatusEntry, RunTarget, FailureEntry } from './schemas/report.js';
import type { Finding } from './schemas/finding.js';
import type { AllowedTarget } from './live/gate.js';
import type { Session } from './live/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Types for injectable live-scan dependencies (enable unit testing without
// network access — callers supply fake implementations in tests)
// ---------------------------------------------------------------------------

export type LiveScanDeps = {
  runProbes: (target: AllowedTarget, rps: number) => Promise<Finding[]>;
  runZapScanner: typeof runZap;
  runNucleiScanner: typeof runNuclei;
};

const COMMANDS = ['scan-source', 'scan-live', 'run', 'report', 'ui', 'fix'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `\
Usage: audit <command> [options]

Commands:
  scan-source    Static scan of one or all registered repos
  scan-live      Live (DAST) scan of an allowlisted staging URL
  run            scan-source + scan-live + correlate + report
  report         Re-emit report from the last run (no scanning)
  ui             Serve the local report dashboard on 127.0.0.1
  fix            File fix-request issue(s) in the target repo

Run \`audit <command> --help\` for command-specific options.
`;

const SCAN_SOURCE_USAGE = `\
Usage: audit scan-source [options]

Options:
  --repo <name>               Scan a single repo (default: all enabled repos)
  --scanner-timeout <minutes> Hard timeout per scanner in minutes (default: 15)
  --max-parallel-targets <n>  Max repos scanned in parallel (default: 2)
  --help                      Show this help
`;

const SCAN_LIVE_USAGE = `\
Usage: audit scan-live --url <staging-url> [options]

Options:
  --url <staging-url>         Staging URL to scan (required)
  --dry-run                   Preflight only — validate allowlist, print check families, send zero traffic
  --scanner-timeout <minutes> Hard timeout per scanner in minutes (default: 15)
  --max-parallel-targets <n>  Max targets scanned in parallel (default: 2)
  --help                      Show this help
`;

const RUN_USAGE = `\
Usage: audit run [options]

Options:
  --repo <name>               Scan a single repo (default: all enabled)
  --url <staging-url>         Scan a single staging URL (default: all enabled)
  --fail-on <severity>        Exit 2 if any finding at or above this severity (critical|high|medium|low)
  --scanner-timeout <minutes> Hard timeout per scanner in minutes (default: 15)
  --max-parallel-targets <n>  Max targets scanned in parallel (default: 2)
  --help                      Show this help
`;

const REPORT_USAGE = `\
Usage: audit report [options]

Options:
  --format <fmt>  Output format: json | md | sarif | html (default: json)
  --help          Show this help
`;

const UI_USAGE = `\
Usage: audit ui [options]

Options:
  --port <n>  Port to bind on 127.0.0.1 (default: 4173)
  --help      Show this help
`;

const FIX_USAGE = `\
Usage: audit fix (<finding-ref> | --min-severity <s>) [options]

Options:
  --min-severity <s>  Bulk-file fix requests for all unfiled findings at or above severity s
  --dry-run           Print remediation pack(s) without filing
  --help              Show this help
`;

function usageError(msg: string): never {
  process.stderr.write(`Error: ${msg}\n\n${USAGE}`);
  process.exit(1);
}

/** Exits 1 with a subcommand-scoped usage message on parseArgs failure. */
function parseOrExit(fn: () => void, usage: string): void {
  try {
    fn();
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n\n${usage}`);
    process.exit(1);
  }
}

function loadConfig() {
  const allowlist = loadAllowlist();
  const registry = loadTargets(allowlist);
  const baseline = loadBaseline();
  return { allowlist, registry, baseline };
}

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

function parseIntFlag(value: string | undefined, name: string, defaultVal: number): number {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`Error: --${name} must be a positive integer\n`);
    process.exit(1);
  }
  return n;
}

type ScanSourceArgs = {
  repo: string | undefined;
  scannerTimeout: number;
  maxParallelTargets: number;
};

type ScanLiveArgs = {
  url: string | undefined;
  dryRun: boolean;
  scannerTimeout: number;
  maxParallelTargets: number;
};

type RunArgs = {
  repo: string | undefined;
  url: string | undefined;
  failOn: string | undefined;
  scannerTimeout: number;
  maxParallelTargets: number;
};

type ReportArgs = {
  format: string;
};

type UiArgs = {
  port: number;
};

type FixArgs = {
  findingRef: string | undefined;
  minSeverity: string | undefined;
  dryRun: boolean;
};

function parseScanSource(argv: string[]): ScanSourceArgs {
  let repo: string | undefined;
  let scannerTimeoutStr: string | undefined;
  let maxParallelTargetsStr: string | undefined;
  let help: boolean | undefined;
  parseOrExit(() => {
    const { values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        'scanner-timeout': { type: 'string' },
        'max-parallel-targets': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    repo = values.repo;
    scannerTimeoutStr = values['scanner-timeout'];
    maxParallelTargetsStr = values['max-parallel-targets'];
    help = values.help;
  }, SCAN_SOURCE_USAGE);
  if (help) {
    process.stdout.write(SCAN_SOURCE_USAGE);
    process.exit(0);
  }
  return {
    repo,
    scannerTimeout: parseIntFlag(scannerTimeoutStr, 'scanner-timeout', 15),
    maxParallelTargets: parseIntFlag(maxParallelTargetsStr, 'max-parallel-targets', 2),
  };
}

function parseScanLive(argv: string[]): ScanLiveArgs {
  let url: string | undefined;
  let dryRun: boolean | undefined;
  let scannerTimeoutStr: string | undefined;
  let maxParallelTargetsStr: string | undefined;
  let help: boolean | undefined;
  parseOrExit(() => {
    const { values } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'scanner-timeout': { type: 'string' },
        'max-parallel-targets': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    url = values.url;
    dryRun = values['dry-run'];
    scannerTimeoutStr = values['scanner-timeout'];
    maxParallelTargetsStr = values['max-parallel-targets'];
    help = values.help;
  }, SCAN_LIVE_USAGE);
  if (help) {
    process.stdout.write(SCAN_LIVE_USAGE);
    process.exit(0);
  }
  return {
    url,
    dryRun: dryRun ?? false,
    scannerTimeout: parseIntFlag(scannerTimeoutStr, 'scanner-timeout', 15),
    maxParallelTargets: parseIntFlag(maxParallelTargetsStr, 'max-parallel-targets', 2),
  };
}

function parseRun(argv: string[]): RunArgs {
  let repo: string | undefined;
  let url: string | undefined;
  let failOn: string | undefined;
  let scannerTimeoutStr: string | undefined;
  let maxParallelTargetsStr: string | undefined;
  let help: boolean | undefined;
  parseOrExit(() => {
    const { values } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        url: { type: 'string' },
        'fail-on': { type: 'string' },
        'scanner-timeout': { type: 'string' },
        'max-parallel-targets': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    repo = values.repo;
    url = values.url;
    failOn = values['fail-on'];
    scannerTimeoutStr = values['scanner-timeout'];
    maxParallelTargetsStr = values['max-parallel-targets'];
    help = values.help;
  }, RUN_USAGE);
  if (help) {
    process.stdout.write(RUN_USAGE);
    process.exit(0);
  }
  return {
    repo,
    url,
    failOn,
    scannerTimeout: parseIntFlag(scannerTimeoutStr, 'scanner-timeout', 15),
    maxParallelTargets: parseIntFlag(maxParallelTargetsStr, 'max-parallel-targets', 2),
  };
}

function parseReport(argv: string[]): ReportArgs {
  let format: string | undefined;
  let help: boolean | undefined;
  parseOrExit(() => {
    const { values } = parseArgs({
      args: argv,
      options: {
        format: { type: 'string', default: 'json' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    format = values.format;
    help = values.help;
  }, REPORT_USAGE);
  if (help) {
    process.stdout.write(REPORT_USAGE);
    process.exit(0);
  }
  const fmt = format ?? 'json';
  if (!['json', 'md', 'sarif', 'html'].includes(fmt)) {
    process.stderr.write(`Error: --format must be one of: json, md, sarif, html\n\n${REPORT_USAGE}`);
    process.exit(1);
  }
  return { format: fmt };
}

function parseUi(argv: string[]): UiArgs {
  let port: string | undefined;
  let help: boolean | undefined;
  parseOrExit(() => {
    const { values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string', default: '4173' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    port = values.port;
    help = values.help;
  }, UI_USAGE);
  if (help) {
    process.stdout.write(UI_USAGE);
    process.exit(0);
  }
  return { port: parseIntFlag(port, 'port', 4173) };
}

function parseFix(argv: string[]): FixArgs {
  let minSeverity: string | undefined;
  let dryRun: boolean | undefined;
  let help: boolean | undefined;
  let positionals: string[] = [];
  parseOrExit(() => {
    const result = parseArgs({
      args: argv,
      options: {
        'min-severity': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    minSeverity = result.values['min-severity'];
    dryRun = result.values['dry-run'];
    help = result.values.help;
    positionals = result.positionals;
  }, FIX_USAGE);
  if (help) {
    process.stdout.write(FIX_USAGE);
    process.exit(0);
  }
  const findingRef = positionals[0];
  if (findingRef === undefined && minSeverity === undefined) {
    process.stderr.write(
      `Error: audit fix requires a <finding-ref> or --min-severity\n\n${FIX_USAGE}`,
    );
    process.exit(1);
  }
  return {
    findingRef,
    minSeverity,
    dryRun: dryRun ?? false,
  };
}

// ---------------------------------------------------------------------------
// Helper: generate a unique run id
// ---------------------------------------------------------------------------

function generateRunId(): string {
  const now = new Date();
  // Format: YYYY-MM-DDTHH-MM-SSZ-<4hex>
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}Z`;
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${ts}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Helper: find the most recent report.json
// ---------------------------------------------------------------------------

function findLatestReport(): import('./schemas/report.js').RunReport | null {
  const reportsDir = resolve(REPO_ROOT, 'reports');
  let entries: string[];
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return null;
  }
  const runDirs = entries
    .filter((e) => {
      try {
        return statSync(resolve(reportsDir, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  const last = runDirs[runDirs.length - 1];
  if (last === undefined) return null;
  const reportPath = resolve(reportsDir, last, 'report.json');
  try {
    const raw = readFileSync(reportPath, 'utf8');
    return JSON.parse(raw) as import('./schemas/report.js').RunReport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live-scan helper: scan one staging target, returns findings + status
// ---------------------------------------------------------------------------

export async function scanLiveTarget(
  stagingUrl: string,
  config: ReturnType<typeof loadConfig>,
  opts: { scannerTimeoutMs: number },
  deps?: Partial<LiveScanDeps>,
): Promise<{
  findings: Finding[];
  scannerStatus: ScannerStatusEntry[];
  targets: RunTarget[];
  failures: FailureEntry[];
}> {
  // Gate + registry lookup — AllowedTarget required for all live scanners
  const { target, registryEntry } = preflight(stagingUrl, config.allowlist, config.registry);
  const rps = registryEntry.rateLimitRps ?? 10;
  const activeScan = registryEntry.activeScan;

  const allFindings: Finding[] = [];
  const scannerStatus: ScannerStatusEntry[] = [];
  const failures: FailureEntry[] = [];
  const coverageGaps: string[] = [];

  // Auth
  const loginResult = await loginForTarget(target, registryEntry.auth, activeScan);

  if (loginResult.kind === 'failure') {
    // activeScan:true + login failure → target failed (§6.2)
    failures.push({ target: registryEntry.name, family: 'probe', reason: loginResult.message });
    failures.push({ target: registryEntry.name, family: 'zap', reason: loginResult.message });
    failures.push({ target: registryEntry.name, family: 'nuclei', reason: loginResult.message });
    scannerStatus.push({ target: registryEntry.name, family: 'probe', state: 'failed' });
    scannerStatus.push({ target: registryEntry.name, family: 'zap', state: 'failed' });
    scannerStatus.push({ target: registryEntry.name, family: 'nuclei', state: 'failed' });
    const runTarget: RunTarget = { kind: 'staging', name: registryEntry.name, coverageGaps: [loginResult.message] };
    return { findings: allFindings, scannerStatus, targets: [runTarget], failures };
  }

  if (loginResult.kind === 'unauthenticated') {
    coverageGaps.push(loginResult.coverageGap);
  }

  const session: Session | undefined = loginResult.kind === 'session' ? loginResult : undefined;

  // Probes family
  const probeRunner = deps?.runProbes;
  if (probeRunner !== undefined) {
    try {
      const probeFindings = await probeRunner(target, rps);
      allFindings.push(...probeFindings);
      scannerStatus.push({ target: registryEntry.name, family: 'probe', state: 'complete' });
    } catch {
      failures.push({ target: registryEntry.name, family: 'probe', reason: 'probe family failed' });
      scannerStatus.push({ target: registryEntry.name, family: 'probe', state: 'failed' });
    }
  } else {
    // Default: probes not available without injectable clients — mark skipped
    scannerStatus.push({ target: registryEntry.name, family: 'probe', state: 'skipped' });
  }

  // ZAP
  const zapRunner = deps?.runZapScanner ?? runZap;
  try {
    const zapOpts = { rps, activeScan, sessions: undefined as [Session, Session] | undefined };
    const zapFindings = await zapRunner(target, zapOpts);
    allFindings.push(...zapFindings);
    scannerStatus.push({ target: registryEntry.name, family: 'zap', state: 'complete' });
  } catch {
    failures.push({ target: registryEntry.name, family: 'zap', reason: 'zap scanner failed' });
    scannerStatus.push({ target: registryEntry.name, family: 'zap', state: 'failed' });
  }

  // Nuclei
  const nucleiRunner = deps?.runNucleiScanner ?? runNuclei;
  try {
    const nucleiOpts = { rps, activeScan, session };
    const nucleiFindings = await nucleiRunner(target, nucleiOpts);
    allFindings.push(...nucleiFindings);
    scannerStatus.push({ target: registryEntry.name, family: 'nuclei', state: 'complete' });
  } catch {
    failures.push({ target: registryEntry.name, family: 'nuclei', reason: 'nuclei scanner failed' });
    scannerStatus.push({ target: registryEntry.name, family: 'nuclei', state: 'failed' });
  }

  const runTarget: RunTarget = { kind: 'staging', name: registryEntry.name, coverageGaps };
  return { findings: allFindings, scannerStatus, targets: [runTarget], failures };
}

// ---------------------------------------------------------------------------
// Subcommand bodies (config loaded at dispatch site, before async body)
// ---------------------------------------------------------------------------

async function doScanSource(
  args: ScanSourceArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const { registry } = config;
  const repos = args.repo !== undefined
    ? registry.repos.filter((r) => r.name === args.repo && r.enabled)
    : registry.repos.filter((r) => r.enabled);

  if (repos.length === 0) {
    process.stdout.write('No enabled repos to scan.\n');
    return;
  }

  const result = await scanRepos(repos, {}, {
    scannerTimeoutMs: args.scannerTimeout * 60_000,
    maxParallelTargets: args.maxParallelTargets,
  });
  process.stdout.write(
    `scan-source: ${result.findings.length} finding(s) from ${repos.length} repo(s).\n`,
  );
}

async function doScanLive(
  args: ScanLiveArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (args.url === undefined) {
    process.stderr.write(`Error: --url is required for scan-live\n\n${SCAN_LIVE_USAGE}`);
    process.exit(1);
  }

  if (args.dryRun) {
    // dry-run: preflight only, zero scanners, zero traffic (§4.6)
    dryRun(args.url, config.allowlist, config.registry);
    return;
  }

  // Non-dry-run: live engine — only reachable via AllowedTarget from preflight
  const result = await scanLiveTarget(args.url, config, {
    scannerTimeoutMs: args.scannerTimeout * 60_000,
  });
  process.stdout.write(`scan-live: ${result.findings.length} finding(s).\n`);
}

async function doRun(
  args: RunArgs,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const runId = generateRunId();
  const startedAt = new Date().toISOString();

  await withWorkspaceLock(async () => {
    const allFindings: Finding[] = [];
    const allScannerStatus: ScannerStatusEntry[] = [];
    const allTargets: RunTarget[] = [];
    const allFailures: FailureEntry[] = [];

    // Static scan
    const repos = args.repo !== undefined
      ? config.registry.repos.filter((r) => r.name === args.repo && r.enabled)
      : config.registry.repos.filter((r) => r.enabled);

    if (repos.length > 0) {
      const staticResult = await scanRepos(repos, {}, {
        scannerTimeoutMs: args.scannerTimeout * 60_000,
        maxParallelTargets: args.maxParallelTargets,
      });
      allFindings.push(...staticResult.findings);
      allScannerStatus.push(...staticResult.scannerStatus);

      for (const repo of repos) {
        const firstFinding = staticResult.findings.find(
          (f) => f.target.kind === 'repo' && f.target.name === repo.name,
        );
        allTargets.push({
          kind: 'repo',
          name: repo.name,
          commit: firstFinding?.target.kind === 'repo' ? firstFinding.target.commit : undefined,
          coverageGaps: [],
        });
      }
    }

    // Live scan — each enabled staging target goes through preflight (§4.6 invariant)
    const stagingTargets = args.url !== undefined
      ? config.registry.stagingTargets.filter(
          (t) => t.enabled && new URL(t.url).hostname === new URL(args.url!).hostname,
        )
      : config.registry.stagingTargets.filter((t) => t.enabled);

    for (const st of stagingTargets) {
      const liveResult = await scanLiveTarget(st.url, config, {
        scannerTimeoutMs: args.scannerTimeout * 60_000,
      });
      allFindings.push(...liveResult.findings);
      allScannerStatus.push(...liveResult.scannerStatus);
      allTargets.push(...liveResult.targets);
      allFailures.push(...liveResult.failures);
    }

    // Correlate static + live
    const correlated = correlate(allFindings, config.registry);

    // Determine run status (§14)
    const hasFailures = allFailures.length > 0;
    const hasAnyComplete = allScannerStatus.some((s) => s.state === 'complete');
    const runStatus: 'success' | 'partial' | 'failed' =
      hasFailures && hasAnyComplete ? 'partial'
        : hasFailures && !hasAnyComplete ? 'failed'
          : 'success';

    const finishedAt = new Date().toISOString();
    const report = buildReport({
      runId,
      date: runId.slice(0, 10),
      rawFindings: correlated,
      scannerStatus: allScannerStatus,
      targets: allTargets,
      baseline: config.baseline,
      meta: {
        status: runStatus,
        failures: allFailures,
        scannerStatus: allScannerStatus,
        startedAt,
        finishedAt,
        toolVersion: 'audit-tool/1.0.0',
      },
    });

    // Atomic write of report + ancillary formats
    const reportsDir = resolve(REPO_ROOT, 'reports');
    await writeReport(report, reportsDir);
    const runDir = resolve(reportsDir, runId);
    writeFileSync(resolve(runDir, 'report.md'), toMarkdown(report), 'utf8');
    writeFileSync(resolve(runDir, 'report.sarif'), toSarif(report), 'utf8');

    // Append trend line (§6.5)
    const prevLines = readTrendLines();
    const prevFpMap = buildPrevFingerprintMap(prevLines, reportsDir);
    const trendLine = buildTrendLine(report, prevFpMap);
    await writeTrend(trendLine);

    process.stdout.write(
      `Run ${runId}: ${runStatus} — ${report.findings.length} finding(s).\n`,
    );

    // --fail-on exit code (§14 exit code 2)
    if (args.failOn !== undefined) {
      const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const threshold = SEVERITY_ORDER[args.failOn] ?? 99;
      const hasAboveThreshold = report.findings.some(
        (f) => !f.suppressed && (SEVERITY_ORDER[f.severity] ?? 99) <= threshold,
      );
      if (hasAboveThreshold) {
        process.exit(2);
      }
    }

    if (runStatus === 'failed') {
      process.exit(1);
    }
  });
}

function doReport(args: ReportArgs): void {
  const report = findLatestReport();
  if (report === null) {
    process.stderr.write('No runs found. Run `audit run` first.\n');
    process.exit(1);
  }

  switch (args.format) {
    case 'json':
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      break;
    case 'md':
      process.stdout.write(toMarkdown(report) + '\n');
      break;
    case 'sarif':
      process.stdout.write(toSarif(report) + '\n');
      break;
    case 'html':
      // html stub — replaced by P7-3
      process.stdout.write('[html export] not yet implemented (P7)\n');
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doUi(_args: UiArgs): void {
  process.stdout.write('[ui] not yet implemented (P7)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function doFix(_args: FixArgs): void {
  process.stdout.write('[fix] not yet implemented (P8)\n');
}

/**
 * Main dispatch. Exported for testing; also called as the bin entry point.
 */
export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;

  if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    usageError(`Unknown command: ${cmd}`);
  }

  const command = cmd as Command;

  // Parse subcommand args first: --help exits before config load so
  // help text is accessible even when config is broken.
  switch (command) {
    case 'scan-source': {
      const args = parseScanSource(rest);
      // Config loaded synchronously here — errors exit before the async body runs
      const config = loadConfigOrExit();
      doScanSource(args, config).catch((err: unknown) => {
        if (err instanceof WorkspaceLockedError) {
          process.stderr.write(`Error: ${err.message}\n`);
          process.exit(1);
        }
        throw err;
      });
      break;
    }
    case 'scan-live': {
      const args = parseScanLive(rest);
      const config = loadConfigOrExit();
      doScanLive(args, config).catch((err: unknown) => {
        if (err instanceof WorkspaceLockedError) {
          process.stderr.write(`Error: ${err.message}\n`);
          process.exit(1);
        }
        throw err;
      });
      break;
    }
    case 'run': {
      const args = parseRun(rest);
      const config = loadConfigOrExit();
      doRun(args, config).catch((err: unknown) => {
        if (err instanceof WorkspaceLockedError) {
          process.stderr.write('Workspace is locked. Another audit run is in progress.\n');
          process.exit(1);
        }
        throw err;
      });
      break;
    }
    case 'report': {
      const args = parseReport(rest);
      doReport(args);
      break;
    }
    case 'ui': {
      const args = parseUi(rest);
      doUi(args);
      break;
    }
    case 'fix': {
      const args = parseFix(rest);
      doFix(args);
      break;
    }
  }
}

// Entry point when invoked as bin/CLI.
// NODE_ENV=test is set by Vitest — guards against running main() during
// test module import.
if (process.env['NODE_ENV'] !== 'test') {
  main(process.argv.slice(2));
}
