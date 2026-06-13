import { parseArgs } from 'node:util';
import process from 'node:process';
import { loadAllowlist, loadTargets, ConfigError } from './config/load.js';

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

function validateConfig(): void {
  const allowlist = loadAllowlist();
  loadTargets(allowlist);
}

function validateConfigOrExit(): void {
  try {
    validateConfig();
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

// Stub implementations — scan bodies filled by later phases (P2/P4/P5).
// The args parameters are intentionally unused at P1; later phases replace
// these stubs with real implementations (P2/P4/P5).

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runScanSource(_args: ScanSourceArgs): void {
  process.stdout.write('[scan-source] not yet implemented (P2)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runScanLive(_args: ScanLiveArgs): void {
  process.stdout.write('[scan-live] not yet implemented (P4)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runRun(_args: RunArgs): void {
  process.stdout.write('[run] not yet implemented (P5)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runReport(_args: ReportArgs): void {
  process.stdout.write('[report] not yet implemented (P5)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runUi(_args: UiArgs): void {
  process.stdout.write('[ui] not yet implemented (P7)\n');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runFix(_args: FixArgs): void {
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

  // Parse subcommand args first: --help exits before config validation so
  // help text is accessible even when config is broken.
  switch (command) {
    case 'scan-source': {
      const args = parseScanSource(rest);
      validateConfigOrExit();
      runScanSource(args);
      break;
    }
    case 'scan-live': {
      const args = parseScanLive(rest);
      validateConfigOrExit();
      runScanLive(args);
      break;
    }
    case 'run': {
      const args = parseRun(rest);
      validateConfigOrExit();
      runRun(args);
      break;
    }
    case 'report': {
      const args = parseReport(rest);
      validateConfigOrExit();
      runReport(args);
      break;
    }
    case 'ui': {
      const args = parseUi(rest);
      validateConfigOrExit();
      runUi(args);
      break;
    }
    case 'fix': {
      const args = parseFix(rest);
      validateConfigOrExit();
      runFix(args);
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
