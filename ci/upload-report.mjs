/**
 * ci/upload-report.mjs — Upload a completed audit report to the fly.io dashboard.
 *
 * Usage:
 *   node ci/upload-report.mjs <trigger> [jobId]
 *
 *   trigger  : "on-demand" | "scheduled" | "replay"
 *   jobId    : required when trigger=on-demand; the 32-hex nonce from /api/scan
 *
 * Environment variables read:
 *   FLY_UPLOAD_URL          — dashboard /api/upload endpoint (required)
 *   AUDIT_UPLOAD_TOKEN      — bearer token (required)
 *   REPORTS_DIR             — override for reports base dir (default: <repo-root>/reports)
 *   HISTORY_DIR             — override for history base dir (default: <repo-root>/history)
 *   GITHUB_RUN_ID           — Actions run id  (set by Actions automatically)
 *   GITHUB_WORKFLOW_REF     — workflow file path (set by Actions automatically)
 *   GITHUB_SHA              — commit sha (set by Actions automatically)
 *   SOURCE_RUN_ID           — original runId being replayed (replay only)
 *
 * The script locates the most recent run under REPORTS_DIR by finding the only
 * subdirectory that contains report.json; in practice CI creates exactly one run
 * per workflow execution so there is no ambiguity.  The canonical runId is read
 * from report.json's runId field — it is NEVER taken from the directory name or
 * a CLI argument (contract C4: envelope.runId === report.runId, verified server-side).
 *
 * Exit codes:
 *   0 — upload succeeded (2xx response)
 *   1 — upload failed (non-2xx) or missing required env
 *
 * The workflow step should be isolated (either in its own step or with
 * continue-on-error: true) so a failed upload does not abort the scan job.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function die(msg) {
  process.stderr.write(`[upload-report] ERROR: ${msg}\n`);
  process.exit(1);
}

function warn(msg) {
  process.stderr.write(`[upload-report] WARN: ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`[upload-report] ${msg}\n`);
}

// --- CLI args ---
const [,, triggerArg, jobIdArg] = process.argv;

const VALID_TRIGGERS = new Set(['on-demand', 'scheduled', 'replay']);
if (!triggerArg || !VALID_TRIGGERS.has(triggerArg)) {
  die(`First argument must be one of: on-demand, scheduled, replay. Got: ${String(triggerArg)}`);
}
const trigger = triggerArg;

if (trigger === 'on-demand' && !jobIdArg) {
  die('jobId argument is required when trigger=on-demand');
}
const jobId = jobIdArg ?? undefined;

// --- Env ---
const uploadUrl = process.env.FLY_UPLOAD_URL;
const uploadToken = process.env.AUDIT_UPLOAD_TOKEN;

if (!uploadUrl || !uploadToken) {
  warn('FLY_UPLOAD_URL or AUDIT_UPLOAD_TOKEN is not set — skipping upload.');
  // Non-fatal skip: the weekly scan must still archive artifacts even without upload creds.
  process.exit(0);
}

const reportsBase = process.env.REPORTS_DIR ?? resolve(REPO_ROOT, 'reports');
const historyBase = process.env.HISTORY_DIR ?? resolve(REPO_ROOT, 'history');
const trendPath = resolve(historyBase, 'trend.jsonl');

// --- Locate the run directory ---
// CI produces one run per execution. Find the single subdirectory with report.json.
let runDir;
try {
  const entries = readdirSync(reportsBase, { withFileTypes: true });
  const runDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => resolve(reportsBase, e.name))
    .filter((d) => existsSync(resolve(d, 'report.json')));

  if (runDirs.length === 0) {
    die(`No run directory with report.json found under ${reportsBase}`);
  }
  if (runDirs.length > 1) {
    // Multiple runs in one workspace is unusual; pick the latest. runIds are
    // timestamp-prefixed (YYYY-MM-DDTHH-MM-SSZ-<hex>), so a descending sort by
    // basename yields the most recent run.
    warn(`Multiple run directories found; using the latest by runId.`);
    runDirs.sort((a, b) => (basename(b) > basename(a) ? 1 : -1));
  }
  runDir = runDirs[0];
} catch (err) {
  die(`Failed to read reports directory: ${String(err)}`);
}

// --- Read report files ---
let reportJson;
let reportMd = '';
let reportSarif = '';

try {
  reportJson = JSON.parse(readFileSync(resolve(runDir, 'report.json'), 'utf8'));
} catch (err) {
  die(`Failed to read report.json: ${String(err)}`);
}

// Canonical runId comes from the report — NEVER from dir name or CLI arg (C4/H1/H2)
const runId = reportJson.runId;
if (typeof runId !== 'string' || runId.length === 0) {
  die('report.json missing or empty runId field');
}

try {
  reportMd = readFileSync(resolve(runDir, 'report.md'), 'utf8');
} catch {
  warn('report.md not found — omitting markdown from envelope');
}

try {
  reportSarif = readFileSync(resolve(runDir, 'report.sarif'), 'utf8');
} catch {
  warn('report.sarif not found — omitting sarif from envelope');
}

// --- Load trend line for this runId ---
let trendLine = null;
try {
  const raw = readFileSync(trendPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.runId === runId) {
        trendLine = parsed;
      }
    } catch {
      // skip malformed lines
    }
  }
} catch {
  warn('history/trend.jsonl not found or unreadable — trendLine will be null');
}

// --- Build C4 envelope ---
const envelope = {
  trigger,
  runId,
  report: reportJson,
  markdown: reportMd,
  sarif: reportSarif,
  trendLine,
};

// targetRepo and stagingUrl are on the report's meta if present (set by the CLI scan)
// The server records these from the C2 scan-jobs event for on-demand; pass them for
// informational correlation on scheduled/replay if available.
if (reportJson.meta?.targetRepo) {
  envelope.targetRepo = reportJson.meta.targetRepo;
}
if (reportJson.meta?.stagingUrl) {
  envelope.stagingUrl = reportJson.meta.stagingUrl;
}

if (trigger === 'on-demand') {
  envelope.jobId = jobId;
}

// GitHub provenance fields (required for scheduled and replay; included for on-demand too)
const githubRunId = process.env.GITHUB_RUN_ID;
const githubWorkflow = process.env.GITHUB_WORKFLOW_REF;
const githubSha = process.env.GITHUB_SHA;

if (githubRunId) envelope.githubRunId = githubRunId;
if (githubWorkflow) envelope.githubWorkflow = githubWorkflow;
if (githubSha) envelope.githubSha = githubSha;

if (trigger === 'replay') {
  const sourceRunId = process.env.SOURCE_RUN_ID;
  if (sourceRunId) {
    envelope.sourceRunId = sourceRunId;
  }
}

// --- POST to fly.io dashboard ---
info(`Uploading run ${runId} (trigger=${trigger}) to ${uploadUrl}`);

let response;
try {
  response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${uploadToken}`,
    },
    body: JSON.stringify(envelope),
  });
} catch (err) {
  process.stderr.write(`[upload-report] ERROR: fetch failed: ${String(err)}\n`);
  process.exit(1);
}

if (!response.ok) {
  const body = await response.text().catch(() => '');
  process.stderr.write(
    `[upload-report] ERROR: upload failed — HTTP ${response.status}: ${body}\n`,
  );
  process.exit(1);
}

const respBody = await response.json().catch(() => ({}));
info(`Upload succeeded — runId=${String(respBody.runId ?? runId)}`);
