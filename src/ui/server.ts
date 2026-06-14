import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadAllowlist, loadTargets, ConfigError } from '../config/load.js';
import type { RunReport } from '../schemas/report.js';
import { RunReportSchema } from '../schemas/report.js';
import { buildPack } from '../fix/pack.js';
import { fileFixRequest, MissingFixTokenError, defaultGitHubClient } from '../fix/github.js';
import type { GitHubHttpClient, EnvReader } from '../fix/github.js';
import { upsertFix } from '../fix/status.js';
import { resolveEnv, assertProductionConfig, type ResolvedEnv } from './env.js';
import { handleStepUpExchange } from './stepup.js';
import { basicAuthGate, isAuthEnabled } from './auth.js';
import { foldJobs, appendEvent } from './scan-jobs.js';
import { preflight } from '../live/preflight.js';
import { dispatchScan } from './dispatch.js';
import { verifyOnDemand, verifyGithubRun, runIdExistsOnVolume } from './provenance.js';
import type { Clock } from './provenance.js';
import { RUN_ID_RE } from '../schemas/run-id.js';
import { writeReport } from '../report/json.js';
import { writeTrend } from '../report/trend.js';
import { withWorkspaceLock } from '../report/lock.js';
import type { TrendLine } from '../schemas/trend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');

// SPA static assets: built output lives in ui/dist (relative to repo root)
const SPA_DIR = resolve(REPO_ROOT, 'ui', 'dist');

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// ---------------------------------------------------------------------------
// Per-process CSRF nonce (minted once at module load; never emitted with
// Access-Control-Allow-Origin: * per §5.2 hardening contract)
// ---------------------------------------------------------------------------

export const CSRF_NONCE: string = (() => {
  const raw = randomBytes(32);
  return createHash('sha256').update(raw).digest('hex');
})();

// ---------------------------------------------------------------------------
// Injectable fix handler (for testability — production calls fix modules directly)
// ---------------------------------------------------------------------------

/**
 * Injectable fix handler type.
 * The real implementation calls buildPack + fileFixRequest + upsertFix.
 * Tests inject a spy to assert the 403-before-github short-circuit.
 */
export type FixHandler = (fingerprint: string) => Promise<{ issueUrl: string }>;

// Per-fingerprint promise chain — serializes concurrent fix requests for the
// same fingerprint so fileFixRequest + upsertFix never race on the same issue.
const fixLocks = new Map<string, Promise<unknown>>();

/**
 * Run fn() serially per fingerprint key. If a request for the same fingerprint
 * is already in-flight, the new call waits for the prior one to settle before
 * starting its own execution (not reusing the prior result).
 */
function withFixLock(key: string, fn: () => Promise<{ issueUrl: string }>): Promise<{ issueUrl: string }> {
  const prior = fixLocks.get(key) ?? Promise.resolve();
  const next: Promise<{ issueUrl: string }> = prior.then(() => fn(), () => fn());
  // Store the settling chain (void) so the next waiter sees this one complete.
  fixLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // Never emit Access-Control-Allow-Origin: * (§5.2)
  });
  res.end(payload);
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as unknown;
}

/** Default maximum accepted request body size (64 KiB). Fix/scan-request bodies are tiny. */
const MAX_BODY_BYTES = 64 * 1024;

/** Maximum body size for /api/upload (25 MiB — reports can be large). */
const UPLOAD_MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Read the full request body as a UTF-8 string, capped at maxBytes (default MAX_BODY_BYTES).
 *  Rejects with a {tooLarge: true} error if the cap is exceeded. */
function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((res, rej) => {
    let data = '';
    let byteCount = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buf.byteLength;
      if (byteCount > maxBytes) {
        aborted = true;
        // Drain remaining data silently so the socket stays open long enough
        // for the caller to write the 413 response before destroying.
        req.resume();
        const err = Object.assign(new Error('Request body too large'), { tooLarge: true });
        rej(err);
        return;
      }
      data += buf.toString('utf8');
    });
    req.on('end', () => { if (!aborted) res(data); });
    req.on('error', (e) => { if (!aborted) rej(e); });
  });
}

/**
 * Production fix handler: builds the remediation pack and files the GitHub
 * fix-request issue for the given fingerprint.
 * Loads the latest report from disk to locate the finding.
 */
function makeProductionFixHandler(reportsDir: string, opts?: { client?: GitHubHttpClient; env?: EnvReader; configDir?: string }): FixHandler {
  return async (fingerprint: string) => {
    // Load config to get the target registry (for repoUrl resolution)
    const loadOpts = opts?.configDir !== undefined ? { configDir: opts.configDir } : undefined;
    const allowlist = loadAllowlist(loadOpts);
    const registry = loadTargets(allowlist, loadOpts);

    // Find the finding in the latest report
    let report: RunReport | null = null;
    try {
      const entries = readdirSync(reportsDir);
      const runs = entries
        .filter((e) => { try { return statSync(resolve(reportsDir, e)).isDirectory(); } catch { return false; } })
        .sort()
        .reverse();
      for (const runId of runs) {
        try {
          const data = readJsonFile(resolve(reportsDir, runId, 'report.json'));
          report = data as RunReport;
          break;
        } catch { /* try next */ }
      }
    } catch { /* reports dir absent */ }

    if (report === null) {
      throw new Error('No runs found. Run `audit run` first.');
    }

    const finding = report.findings.find((f) => f.fingerprint === fingerprint);
    if (finding === undefined) {
      throw new Error(`Finding not found: ${fingerprint}`);
    }

    // Resolve repoUrl from the registry (static findings only)
    if (finding.surface !== 'static') {
      throw new Error(`Cannot file fix request for live finding ${fingerprint} — no repo URL available.`);
    }
    const repoEntry = registry.repos.find((r) => r.name === finding.target.name);
    if (repoEntry === undefined) {
      throw new Error(`Target repo not found in registry: ${finding.target.name}`);
    }
    const repoUrl = repoEntry.gitUrl;

    const pack = buildPack(finding);
    const result = await fileFixRequest(finding, pack, repoUrl, {
      ...(opts?.client !== undefined ? { client: opts.client } : {}),
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
    });

    await upsertFix(
      finding.fingerprint,
      (existing) => ({
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        status: 'requested',
        issueUrl: result.issueUrl,
        filedAt: existing?.filedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    return { issueUrl: result.issueUrl };
  };
}

// ---------------------------------------------------------------------------
// Read-only JSON endpoints
// ---------------------------------------------------------------------------

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, reportsDir: string, historyDir: string, dataDir: string, configDir: string): boolean {
  const { pathname } = url;
  const fixesJson = resolve(reportsDir, 'fixes.json');

  // GET /api/csrf — serves the per-process nonce to the same-origin SPA
  if (req.method === 'GET' && pathname === '/api/csrf') {
    jsonResponse(res, 200, { csrfToken: CSRF_NONCE });
    return true;
  }

  // GET /api/reports — list all run directories
  if (req.method === 'GET' && pathname === '/api/reports') {
    let entries: string[];
    try {
      entries = readdirSync(reportsDir);
    } catch {
      jsonResponse(res, 200, []);
      return true;
    }
    const runs = entries.filter((e) => {
      try {
        return statSync(resolve(reportsDir, e)).isDirectory();
      } catch {
        return false;
      }
    }).sort();
    jsonResponse(res, 200, runs);
    return true;
  }

  // GET /api/reports/:runId/report.json
  const reportMatch = /^\/api\/reports\/([^/]+)\/report\.json$/.exec(pathname);
  if (req.method === 'GET' && reportMatch !== null) {
    const runId = reportMatch[1];
    // Validate runId shape before building any path (adversarial-reviewer 6-A —
    // parity with the upload write path). The route regex allows a single
    // non-slash segment, so a `..` segment would otherwise resolve to the parent
    // of reportsDir. RUN_ID_RE rejects it before resolve() is reached.
    if (runId === undefined || !RUN_ID_RE.test(runId)) {
      jsonResponse(res, 404, { error: 'Not found' });
      return true;
    }
    const reportPath = resolve(reportsDir, runId, 'report.json');
    try {
      const data = readJsonFile(reportPath);
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 404, { error: 'Report not found', runId });
    }
    return true;
  }

  // GET /api/trend — full trend JSONL as array
  if (req.method === 'GET' && pathname === '/api/trend') {
    let raw: string;
    try {
      raw = readFileSync(resolve(historyDir, 'trend.jsonl'), 'utf8');
    } catch {
      jsonResponse(res, 200, []);
      return true;
    }
    const lines = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown);
    jsonResponse(res, 200, lines);
    return true;
  }

  // GET /api/config/targets — config/targets.json, projected to the UI's
  // TargetsConfig shape ({ repoTargets, stagingTargets } of TargetRegistryEntry).
  // The raw file uses key `repos` and carries auth/rateLimit detail the SPA never
  // needs; projecting here fixes the UI contract (RunAScan + Sites/Safety both
  // read `repoTargets`) AND drops the auth block from the response (less exposure).
  if (req.method === 'GET' && pathname === '/api/config/targets') {
    try {
      const raw = readJsonFile(resolve(configDir, 'targets.json')) as {
        repos?: Array<{ name: string; enabled: boolean }>;
        stagingTargets?: Array<{ name: string; url: string; repo?: string; activeScan?: boolean; enabled: boolean }>;
      };
      const repoTargets = (raw.repos ?? []).map((r) => ({
        name: r.name,
        kind: 'repo' as const,
        enabled: r.enabled,
      }));
      const stagingTargets = (raw.stagingTargets ?? []).map((s) => {
        let host: string | undefined;
        try { host = new URL(s.url).hostname; } catch { host = undefined; }
        return {
          name: s.name,
          kind: 'staging' as const,
          enabled: s.enabled,
          url: s.url,
          host,
          repo: s.repo,
          activeScan: s.activeScan ?? false,
        };
      });
      jsonResponse(res, 200, { repoTargets, stagingTargets });
    } catch {
      jsonResponse(res, 200, { repoTargets: [], stagingTargets: [] });
    }
    return true;
  }

  // GET /api/config/allowlist — config/allowed-staging-hosts.json
  if (req.method === 'GET' && pathname === '/api/config/allowlist') {
    try {
      const data = readJsonFile(resolve(configDir, 'allowed-staging-hosts.json'));
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, { hosts: [] });
    }
    return true;
  }

  // GET /api/config/baseline — config/baseline.json
  if (req.method === 'GET' && pathname === '/api/config/baseline') {
    try {
      const data = readJsonFile(resolve(configDir, 'baseline.json'));
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, { entries: [] });
    }
    return true;
  }

  // GET /api/fixes — reports/fixes.json
  if (req.method === 'GET' && pathname === '/api/fixes') {
    try {
      const data = readJsonFile(fixesJson);
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, {});
    }
    return true;
  }

  // GET /api/scan-jobs — folded job list, most-recent-first (§4.3, C3)
  if (req.method === 'GET' && pathname === '/api/scan-jobs') {
    let jobs;
    try {
      jobs = foldJobs(dataDir, Date.now());
    } catch {
      jsonResponse(res, 200, []);
      return true;
    }
    jobs.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
    jsonResponse(res, 200, jobs);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Mutating POST /api/fix — CSRF/origin-gated (§5.2 hardening contract)
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/fix.
 *
 * Rejects HTTP 403 — WITHOUT calling the fix handler — when:
 *   (a) X-Audit-CSRF header is missing or does not match CSRF_NONCE, OR
 *   (b) Origin header does not match the resolved allowedOrigin (§5.3)
 *
 * The server never emits Access-Control-Allow-Origin: * on this route.
 * Loopback binding alone is NOT sufficient (§5.2: a page in the operator's
 * browser can drive a cross-origin POST to 127.0.0.1).
 */
async function handleFixPost(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  fixHandler: FixHandler,
): Promise<void> {
  const csrfHeader = req.headers['x-audit-csrf'];
  const originHeader = req.headers['origin'];

  // §5.2/§5.3: reject BEFORE any fix logic when nonce or origin is wrong
  if (typeof csrfHeader !== 'string' || csrfHeader !== CSRF_NONCE) {
    jsonResponse(res, 403, { error: 'Forbidden: missing or invalid X-Audit-CSRF nonce' });
    return;
  }
  if (typeof originHeader !== 'string' || originHeader !== allowedOrigin) {
    jsonResponse(res, 403, { error: 'Forbidden: Origin not allowed' });
    return;
  }

  // Guards passed — read and parse body (capped at MAX_BODY_BYTES)
  let body: string;
  try {
    body = await readBody(req);
  } catch (bodyErr) {
    const isTooLarge = typeof bodyErr === 'object' && bodyErr !== null && (bodyErr as { tooLarge?: boolean }).tooLarge === true;
    if (isTooLarge) {
      jsonResponse(res, 413, { error: 'Request body too large' });
    } else {
      jsonResponse(res, 400, { error: 'Bad request: could not read body' });
    }
    return;
  }

  let fingerprint: string;
  try {
    const parsed = JSON.parse(body) as { fingerprint?: unknown };
    if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: fingerprint required' });
      return;
    }
    fingerprint = parsed.fingerprint;
  } catch {
    jsonResponse(res, 400, { error: 'Bad request: invalid JSON' });
    return;
  }

  try {
    const result = await withFixLock(fingerprint, () => fixHandler(fingerprint));
    jsonResponse(res, 200, { issueUrl: result.issueUrl });
  } catch (err) {
    if (err instanceof MissingFixTokenError) {
      // §5.3: plain-English "fix-sending not configured"
      jsonResponse(res, 503, { error: 'Fix-sending not configured. Set AUDIT_GITHUB_FIX_TOKEN to enable.' });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    jsonResponse(res, 500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// Mutating POST /api/scan — CSRF/origin-gated + registry safety gate
// (System invariants 1 and 2 — §4.1, §7.1, §7.2)
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/scan.
 *
 * Safety gates (in order):
 * 1. CSRF nonce + origin check → 403 BEFORE any registry access or dispatch.
 * 2. Body parse — both `repo` and `stagingUrl` required → 400.
 * 3. Registry safety gate — TWO independent checks (M2):
 *    a. Repo check: registry.repos.find(r => r.name === repo && r.enabled) → 400.
 *       preflight() checks only the staging URL/host; it does NOT validate repos.
 *    b. URL check: preflight(stagingUrl, allowlist, registry) → 400 on failure.
 *    ConfigError from the registry load → 500 (server misconfig, not caller error — M3).
 *    Any registry miss → 400, NO dispatch, NO `requested` event.
 * 4. Mint jobId, append `requested` event.
 * 5. dispatchScan() with AUDIT_WORKFLOW_REPO + AUDIT_GH_DISPATCH_TOKEN:
 *    204 → append `dispatched` → 202 { jobId }.
 *    failure → append `dispatch_failed` (reason) → 502.
 */
async function handleScanPost(
  req: IncomingMessage,
  res: ServerResponse,
  resolvedEnv: ResolvedEnv,
  envReader: EnvReader,
  githubClient: GitHubHttpClient,
): Promise<void> {
  const { allowedOrigin, dataDir } = resolvedEnv;

  // Step 1: CSRF nonce + origin — BEFORE any registry access or dispatch.
  const csrfHeader = req.headers['x-audit-csrf'];
  const originHeader = req.headers['origin'];

  if (typeof csrfHeader !== 'string' || csrfHeader !== CSRF_NONCE) {
    jsonResponse(res, 403, { error: 'Forbidden: missing or invalid X-Audit-CSRF nonce' });
    return;
  }
  if (typeof originHeader !== 'string' || originHeader !== allowedOrigin) {
    jsonResponse(res, 403, { error: 'Forbidden: Origin not allowed' });
    return;
  }

  // Step 2: Read and parse body. Both fields required and non-empty.
  let body: string;
  try {
    body = await readBody(req);
  } catch (bodyErr) {
    const isTooLarge = typeof bodyErr === 'object' && bodyErr !== null && (bodyErr as { tooLarge?: boolean }).tooLarge === true;
    if (isTooLarge) {
      jsonResponse(res, 413, { error: 'Request body too large' });
    } else {
      jsonResponse(res, 400, { error: 'Bad request: could not read body' });
    }
    return;
  }

  let repo: string;
  let stagingUrl: string;
  try {
    const parsed = JSON.parse(body) as { repo?: unknown; stagingUrl?: unknown };
    if (typeof parsed.repo !== 'string' || parsed.repo.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: repo required' });
      return;
    }
    if (typeof parsed.stagingUrl !== 'string' || parsed.stagingUrl.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: stagingUrl required' });
      return;
    }
    repo = parsed.repo;
    stagingUrl = parsed.stagingUrl;
  } catch {
    jsonResponse(res, 400, { error: 'Bad request: invalid JSON' });
    return;
  }

  // Step 3: Registry safety gate — TWO independent checks (M2).
  let allowlist: ReturnType<typeof loadAllowlist>;
  let registry: ReturnType<typeof loadTargets>;
  try {
    const configOpts = { configDir: resolvedEnv.configDir };
    allowlist = loadAllowlist(configOpts);
    registry = loadTargets(allowlist, configOpts);
  } catch (configErr) {
    // ConfigError from registry load → 500 (server misconfig — M3).
    if (configErr instanceof ConfigError) {
      jsonResponse(res, 500, { error: 'Server configuration error: registry could not be loaded' });
      return;
    }
    jsonResponse(res, 500, { error: 'Internal error loading registry' });
    return;
  }

  // Check 3a: Repo check — explicit, NOT covered by preflight.
  // preflight() validates only the staging URL/host; it never inspects repos.
  const repoEntry = registry.repos.find((r) => r.name === repo && r.enabled);
  if (repoEntry === undefined) {
    jsonResponse(res, 400, { error: 'Bad request: repo is not registered or not enabled' });
    return;
  }

  // Check 3b: URL check — reuses the exact preflight gate the CLI uses.
  let stagingRegistryEntry: ReturnType<typeof preflight>['registryEntry'];
  try {
    stagingRegistryEntry = preflight(stagingUrl, allowlist, registry).registryEntry;
  } catch {
    jsonResponse(res, 400, { error: 'Bad request: stagingUrl is not on the allowlist or not registered' });
    return;
  }

  // Check 3c: exact-URL match (adversarial-reviewer 4-C). preflight matches by
  // HOSTNAME only, so an allowlisted host with an unregistered sub-path
  // (e.g. https://staging.example.com/admin) would otherwise pass and be scanned.
  // The dropdown always submits a registered target's exact URL, so require the
  // submitted URL to equal the registered target URL (normalised via URL.href —
  // tolerates only a trailing-slash difference, never a different path).
  try {
    if (new URL(stagingUrl).href !== new URL(stagingRegistryEntry.url).href) {
      jsonResponse(res, 400, { error: 'Bad request: stagingUrl must exactly match a registered staging target URL' });
      return;
    }
  } catch {
    jsonResponse(res, 400, { error: 'Bad request: stagingUrl is not a valid URL' });
    return;
  }

  // Step 4: Mint jobId, append `requested` event BEFORE the GitHub call.
  const jobId = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  appendEvent({ event: 'requested', jobId, targetRepo: repo, stagingUrl, at: now }, dataDir);

  // Step 5: Dispatch to AUDIT_WORKFLOW_REPO (invariant #2 — never the scan target).
  const workflowRepo = envReader('AUDIT_WORKFLOW_REPO') ?? '';
  const token = envReader('AUDIT_GH_DISPATCH_TOKEN') ?? '';

  let result: Awaited<ReturnType<typeof dispatchScan>>;
  try {
    result = await dispatchScan(
      { workflowRepo, targetRepo: repo, stagingUrl, jobId, token, ref: 'main' },
      githubClient,
    );
  } catch (dispatchErr) {
    // parseOwnerRepo throws when AUDIT_WORKFLOW_REPO is missing or malformed.
    const reason = dispatchErr instanceof Error ? dispatchErr.message : 'dispatch error';
    appendEvent({ event: 'dispatch_failed', jobId, reason, at: new Date().toISOString() }, dataDir);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Scan dispatch failed: AUDIT_WORKFLOW_REPO is missing or invalid.');
    return;
  }

  if (result.ok) {
    appendEvent({ event: 'dispatched', jobId, at: new Date().toISOString() }, dataDir);
    jsonResponse(res, 202, { jobId });
  } else {
    const reason = `github ${result.status}`;
    appendEvent({ event: 'dispatch_failed', jobId, reason, at: new Date().toISOString() }, dataDir);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Scan dispatch failed: GitHub returned an error. Check AUDIT_WORKFLOW_REPO and AUDIT_GH_DISPATCH_TOKEN.');
  }
}

// ---------------------------------------------------------------------------
// Per-reportsDir in-process upload serialization (M1).
//
// writeTrend is a read-modify-write (whole file rewrite via tmp+rename).
// Concurrent uploads in the same process would interleave and silently drop
// trend lines (last-rename-wins). This per-key promise chain serializes them
// within the process. withWorkspaceLock below adds cross-process protection.
// ---------------------------------------------------------------------------

const uploadQueues = new Map<string, Promise<unknown>>();

function withUploadQueue<T>(reportsDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = uploadQueues.get(reportsDir) ?? Promise.resolve();
  const next: Promise<T> = prior.then(() => fn(), () => fn());
  uploadQueues.set(reportsDir, next.then(() => undefined, () => undefined));
  return next;
}

// ---------------------------------------------------------------------------
// POST /api/upload — bearer-authed + provenance-bound ingest
// System invariants 3 and 4. Safety-critical: H1, H2, M1 fixes.
// (§4.2, §7.3, §7.5, §10)
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/upload.
 *
 * Safety gates (in order):
 * 1. Bearer auth FIRST, before any body read: Authorization: Bearer <AUDIT_UPLOAD_TOKEN>.
 *    Uses timingSafeEqual. Missing/wrong → 401. Missing token env → 401 (runtime-checked).
 * 2. Body cap 25 MiB (parameterized readBody) → 413.
 * 3. Parse + branch on trigger:
 *    - on-demand: verifyOnDemand against foldJobs(dataDir, now). Fail → 409.
 *    - scheduled/replay: require githubRunId+githubWorkflow+githubSha; verifyGithubRun
 *      (replay relaxes freshness). Fail → 409. Also runIdExistsOnVolume → 409.
 * 4. Canonical runId guard (H1 + H2):
 *    - assert envelope.runId === report.runId (mismatch → 422).
 *    - validate canonical runId against RUN_ID_RE (fail → 400).
 * 5. RunReportSchema.safeParse(report) → 422 if invalid, nothing written.
 * 6. Serialized write (M1): withWorkspaceLock wraps writeReport + writeTrend.
 *    Append uploaded/report_ingested ONLY after BOTH succeed; any failure → 500.
 * 7. Respond: on-demand → 200 {runId, jobId}; scheduled/replay → 200 {runId, jobId:null}.
 */
async function handleUploadPost(
  req: IncomingMessage,
  res: ServerResponse,
  resolvedEnv: ResolvedEnv,
  envReader: EnvReader,
  githubClient: GitHubHttpClient,
  clock: Clock,
): Promise<void> {
  const { dataDir, reportsDir, historyDir } = resolvedEnv;

  // Step 1: Bearer auth — BEFORE any body read (runtime-checked, not startup-required).
  const uploadToken = envReader('AUDIT_UPLOAD_TOKEN') ?? '';
  const authHeader = req.headers['authorization'];

  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    jsonResponse(res, 401, { error: 'Unauthorized: Bearer token required' });
    return;
  }

  const providedToken = authHeader.slice('Bearer '.length);
  let tokenMatch = false;
  if (uploadToken.length > 0 && providedToken.length > 0) {
    const expected = Buffer.from(uploadToken, 'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    // Constant-time compare for equal-length buffers. A length mismatch is an
    // immediate reject (length is not a useful secret to protect, and the prior
    // pad + `providedToken === uploadToken` introduced a NON-constant-time
    // string comparison — removed). timingSafeEqual requires equal lengths.
    tokenMatch =
      expected.length === providedBuf.length && timingSafeEqual(expected, providedBuf);
  }

  if (!tokenMatch) {
    jsonResponse(res, 401, { error: 'Unauthorized: invalid bearer token' });
    return;
  }

  // Step 2: Body cap 25 MiB.
  let body: string;
  try {
    body = await readBody(req, UPLOAD_MAX_BODY_BYTES);
  } catch (bodyErr) {
    const isTooLarge = typeof bodyErr === 'object' && bodyErr !== null && (bodyErr as { tooLarge?: boolean }).tooLarge === true;
    if (isTooLarge) {
      jsonResponse(res, 413, { error: 'Request body too large (max 25 MiB)' });
    } else {
      jsonResponse(res, 400, { error: 'Bad request: could not read body' });
    }
    return;
  }

  // Step 3: Parse envelope.
  let envelope: {
    trigger?: unknown;
    jobId?: unknown;
    targetRepo?: unknown;
    stagingUrl?: unknown;
    runId?: unknown;
    githubRunId?: unknown;
    githubWorkflow?: unknown;
    githubSha?: unknown;
    report?: unknown;
    markdown?: unknown;
    sarif?: unknown;
    trendLine?: unknown;
  };
  try {
    envelope = JSON.parse(body) as typeof envelope;
  } catch {
    jsonResponse(res, 400, { error: 'Bad request: invalid JSON' });
    return;
  }

  const trigger = envelope.trigger;
  if (trigger !== 'on-demand' && trigger !== 'scheduled' && trigger !== 'replay') {
    jsonResponse(res, 400, { error: 'Bad request: trigger must be on-demand, scheduled, or replay' });
    return;
  }

  // Envelope runId — will be compared to report.runId in step 4.
  if (typeof envelope.runId !== 'string' || envelope.runId.length === 0) {
    jsonResponse(res, 400, { error: 'Bad request: runId required' });
    return;
  }
  const envelopeRunId = envelope.runId;

  // Branch on trigger.
  if (trigger === 'on-demand') {
    // Require jobId, targetRepo, stagingUrl for on-demand verification.
    if (typeof envelope.jobId !== 'string' || envelope.jobId.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: jobId required for on-demand trigger' });
      return;
    }
    if (typeof envelope.targetRepo !== 'string' || envelope.targetRepo.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: targetRepo required for on-demand trigger' });
      return;
    }
    if (typeof envelope.stagingUrl !== 'string' || envelope.stagingUrl.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: stagingUrl required for on-demand trigger' });
      return;
    }

    const foldedJobs = foldJobs(dataDir, clock.now());
    const provenanceResult = verifyOnDemand(
      { jobId: envelope.jobId, targetRepo: envelope.targetRepo, stagingUrl: envelope.stagingUrl },
      foldedJobs,
    );
    if (!provenanceResult.ok) {
      jsonResponse(res, 409, { error: `Provenance check failed: ${provenanceResult.reason ?? 'unknown'}` });
      return;
    }
  } else {
    // scheduled or replay: require githubRunId, githubWorkflow, githubSha.
    if (typeof envelope.githubRunId !== 'string' || envelope.githubRunId.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: githubRunId required for scheduled/replay trigger' });
      return;
    }
    if (typeof envelope.githubWorkflow !== 'string' || envelope.githubWorkflow.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: githubWorkflow required for scheduled/replay trigger' });
      return;
    }
    if (typeof envelope.githubSha !== 'string' || envelope.githubSha.length === 0) {
      jsonResponse(res, 400, { error: 'Bad request: githubSha required for scheduled/replay trigger' });
      return;
    }

    const workflowRepo = envReader('AUDIT_WORKFLOW_REPO') ?? '';
    const ghToken = envReader('AUDIT_GH_DISPATCH_TOKEN') ?? '';

    const runVerifyResult = await verifyGithubRun(
      {
        githubRunId: envelope.githubRunId,
        githubWorkflow: envelope.githubWorkflow,
        githubSha: envelope.githubSha,
        expectedRepo: workflowRepo,
        relaxFreshness: trigger === 'replay',
      },
      githubClient,
      clock,
      ghToken,
    );
    if (!runVerifyResult.ok) {
      jsonResponse(res, 409, { error: `GitHub run verification failed: ${runVerifyResult.reason ?? 'unknown'}` });
      return;
    }

    // Dedup: reject if reports/<runId>/ already exists (replay is the recovery path).
    // We check envelopeRunId here as a pre-canonical guard; the canonical check in step 4
    // will confirm it matches report.runId before any path is built.
    if (runIdExistsOnVolume(envelopeRunId, reportsDir)) {
      jsonResponse(res, 409, { error: `Duplicate runId: ${envelopeRunId} already ingested` });
      return;
    }
  }

  // Step 4: Canonical runId guard (H1 + H2 — SAFETY-CRITICAL).
  // writeReport builds the path from report.runId; RunReportSchema.runId is only
  // z.string().min(1) — it does NOT enforce RUN_ID_RE. An envelope-only guard is
  // bypassable: a body with clean envelope runId but report.runId="../../config"
  // would write outside reports/.
  //
  // We must:
  //   (a) assert envelope.runId === report.runId (mismatch → 422, H2),
  //   (b) validate the single canonical runId against RUN_ID_RE (fail → 400, H1).
  const reportRaw = envelope.report;
  if (typeof reportRaw !== 'object' || reportRaw === null) {
    jsonResponse(res, 422, { error: 'Unprocessable: report field required and must be an object' });
    return;
  }
  const reportObj = reportRaw as Record<string, unknown>;

  // (a) H2: envelope.runId must equal report.runId.
  if (reportObj['runId'] !== envelopeRunId) {
    jsonResponse(res, 422, { error: `Unprocessable: envelope runId (${envelopeRunId}) does not match report.runId (${String(reportObj['runId'])})` });
    return;
  }

  // The canonical runId is now the single agreed-upon value.
  const canonicalRunId = envelopeRunId;

  // (b) H1: validate against RUN_ID_RE before any path build.
  if (!RUN_ID_RE.test(canonicalRunId)) {
    jsonResponse(res, 400, { error: `Bad request: runId does not match required pattern: ${canonicalRunId}` });
    return;
  }

  // Step 5: Schema validation.
  const parseResult = RunReportSchema.safeParse(reportRaw);
  if (!parseResult.success) {
    jsonResponse(res, 422, { error: 'Unprocessable: report schema validation failed', details: parseResult.error.issues });
    return;
  }
  const report = parseResult.data;

  // Step 6: Serialized write (M1 — serializes the read-modify-write in writeTrend
  // so concurrent uploads don't drop trend lines via last-rename-wins).
  //
  // Two layers:
  //   1. withUploadQueue: in-process promise chain queues concurrent uploads per
  //      reportsDir so only one runs at a time within this process.
  //   2. withWorkspaceLock: cross-process file lock guards against multiple server
  //      instances (e.g. during a rolling deploy).
  const trendPath = resolve(historyDir, 'trend.jsonl');
  const lockPath = resolve(reportsDir, '.upload-lock');
  let writeError: Error | undefined;
  let duplicate = false;

  try {
    await withUploadQueue(reportsDir, async () => {
      await withWorkspaceLock(async () => {
        // TOCTOU close (adversarial-reviewer 3-A): the AUTHORITATIVE duplicate
        // check runs INSIDE the serialized critical section for ALL triggers.
        // On-demand's pre-lock verifyOnDemand reads the folded state before any
        // `uploaded` event is appended, so two concurrent same-jobId/same-runId
        // POSTs both pass it; here the second sees the first's run dir and aborts
        // rather than overwriting report.json via a last-rename-wins race.
        if (runIdExistsOnVolume(canonicalRunId, reportsDir)) {
          duplicate = true;
          return;
        }
        await writeReport(report, reportsDir);

        // Write optional markdown/sarif (if present in envelope — no signature change to writeReport).
        // These are written directly; writeReport handles report.json only.
        if (typeof envelope.markdown === 'string') {
          const runDir = resolve(reportsDir, canonicalRunId);
          writeFileSync(resolve(runDir, 'report.md'), envelope.markdown, 'utf8');
        }
        if (typeof envelope.sarif === 'string') {
          const runDir = resolve(reportsDir, canonicalRunId);
          writeFileSync(resolve(runDir, 'report.sarif'), envelope.sarif, 'utf8');
        }

        // Write trend line (read-modify-write under the lock, not an append).
        if (envelope.trendLine !== undefined && envelope.trendLine !== null) {
          await writeTrend(envelope.trendLine as TrendLine, trendPath);
        }
      }, { lockPath });
    });
  } catch (err) {
    writeError = err instanceof Error ? err : new Error(String(err));
  }

  if (duplicate) {
    jsonResponse(res, 409, { error: `Duplicate runId: ${canonicalRunId} already ingested` });
    return;
  }
  if (writeError !== undefined) {
    jsonResponse(res, 500, { error: `Write failed: ${writeError.message}` });
    return;
  }

  // Step 7: Append event + respond. Event is appended ONLY after BOTH writes succeed.
  if (trigger === 'on-demand') {
    const jobId = envelope.jobId as string;
    appendEvent({ event: 'uploaded', jobId, runId: canonicalRunId, at: new Date(clock.now()).toISOString() }, dataDir);
    jsonResponse(res, 200, { runId: canonicalRunId, jobId });
  } else {
    const githubRunId = envelope.githubRunId as string;
    appendEvent(
      {
        event: 'report_ingested',
        trigger,
        runId: canonicalRunId,
        githubRunId,
        replayed: trigger === 'replay',
        at: new Date(clock.now()).toISOString(),
      },
      dataDir,
    );
    jsonResponse(res, 200, { runId: canonicalRunId, jobId: null });
  }
}

// ---------------------------------------------------------------------------
// Static SPA asset serving (graceful when ui/dist not built yet)
// ---------------------------------------------------------------------------

function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET') return false;

  let assetPath = url.pathname;
  // Strip leading slash
  if (assetPath.startsWith('/')) assetPath = assetPath.slice(1);

  // Default to index.html for SPA navigation
  if (assetPath === '' || assetPath === '/') assetPath = 'index.html';

  const fullPath = resolve(SPA_DIR, assetPath);

  // Prevent path traversal above SPA_DIR
  if (!fullPath.startsWith(SPA_DIR)) {
    jsonResponse(res, 403, { error: 'Forbidden' });
    return true;
  }

  let content: Buffer;
  try {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Try index.html within the directory
      const indexPath = resolve(fullPath, 'index.html');
      content = readFileSync(indexPath);
    } else {
      content = readFileSync(fullPath);
    }
  } catch {
    // SPA not built yet — return a placeholder
    if (assetPath.endsWith('.html') || !assetPath.includes('.')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<html><body><p>UI not built yet. Run <code>npm run build:ui</code>.</p></body></html>');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return true;
  }

  const ext = extname(fullPath).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
  res.end(content);
  return true;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resolvedEnv: ResolvedEnv,
  fixHandler: FixHandler,
  envReader: EnvReader,
  githubClient: GitHubHttpClient,
  clock: Clock,
): void {
  const { allowedOrigin, reportsDir, historyDir, dataDir, configDir } = resolvedEnv;
  const raw = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(raw, allowedOrigin);
  } catch {
    jsonResponse(res, 400, { error: 'Bad request' });
    return;
  }

  // GET /healthz — unauthenticated health probe (§4.4). Static body, no data leak.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  // Basic Auth gate — applied after URL parse, BEFORE route dispatch.
  // Exemptions: /healthz (unauthenticated health probe) and POST /api/upload
  // (uses bearer auth in C6, bypasses Basic Auth by design). The /api/upload
  // exemption is scoped to POST (adversarial-reviewer 2-B) — a non-POST method
  // to that path is NOT exempt, so it goes through Basic Auth and then 404s
  // rather than reaching an unauthenticated code path.
  const isExempt =
    url.pathname === '/healthz' ||
    (url.pathname === '/api/upload' && req.method === 'POST');
  if (!isExempt && basicAuthGate(req.headers['authorization'], resolvedEnv) === 'reject') {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="sectool"',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Mutating POST /api/fix (CSRF/origin-gated)
  if (req.method === 'POST' && url.pathname === '/api/fix') {
    handleFixPost(req, res, allowedOrigin, fixHandler).catch(() => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal error' });
      }
    });
    return;
  }

  // Mutating POST /api/scan (CSRF/origin-gated + registry safety gate — §4.1)
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    handleScanPost(req, res, resolvedEnv, envReader, githubClient).catch(() => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal error' });
      }
    });
    return;
  }

  // Step-up exchange POST /api/config/step-up — Basic Auth already checked above
  if (req.method === 'POST' && url.pathname === '/api/config/step-up') {
    handleStepUpExchange(req, res, resolvedEnv, {
      csrfNonce: CSRF_NONCE,
      readBody,
      jsonResponse,
    }).catch(() => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal error' });
      }
    });
    return;
  }

  // Inbound trust boundary POST /api/upload (bearer-authed + provenance-bound — §4.2)
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    handleUploadPost(req, res, resolvedEnv, envReader, githubClient, clock).catch(() => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'Internal error' });
      }
    });
    return;
  }

  // Read-only API routes
  if (url.pathname.startsWith('/api/')) {
    if (!handleApi(req, res, url, reportsDir, historyDir, dataDir, configDir)) {
      jsonResponse(res, 404, { error: 'Not found' });
    }
    return;
  }

  // Static assets
  if (!handleStatic(req, res, url)) {
    jsonResponse(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// Public: start the server
// ---------------------------------------------------------------------------

export interface AuditServer {
  readonly server: Server;
  readonly port: number;
  readonly allowedOrigin: string;
  stop(): Promise<void>;
}

export interface StartServerOpts {
  env?: EnvReader;
  fixHandler?: FixHandler;
  githubClient?: GitHubHttpClient;
  clock?: Clock;
}

/**
 * Start the audit UI server.
 * @param port - TCP port (0 = OS-assigned ephemeral port for tests)
 * @param opts - Injectable deps: env reader, fix handler, GitHub client.
 *               Inject a fixHandler spy in tests to assert CSRF/origin 403 short-circuit.
 *               Inject an env reader to drive env without process.env mutation.
 */
export function startServer(port: number, opts?: FixHandler | StartServerOpts): Promise<AuditServer> {
  // Accept legacy positional fixHandler for backwards compat with existing tests
  const fixHandlerArg = typeof opts === 'function' ? opts : opts?.fixHandler;
  const envReader = typeof opts === 'function' ? undefined : opts?.env;
  const githubClientArg = typeof opts === 'function' ? undefined : opts?.githubClient;
  const clockArg = typeof opts === 'function' ? undefined : opts?.clock;

  const env = envReader ?? ((name: string) => process.env[name]);
  const resolved = resolveEnv(env, port);
  const { bindHost, allowedOrigin, reportsDir, configDir } = resolved;

  const handler = fixHandlerArg ?? makeProductionFixHandler(reportsDir, {
    ...(githubClientArg !== undefined ? { client: githubClientArg } : {}),
    env,
    configDir,
  });

  // Production fail-closed: assert all required vars before binding.
  // Throws StartupConfigError (rejects the returned promise) so the server
  // never binds when production config is incomplete.
  try {
    assertProductionConfig(resolved, env);
  } catch (configErr) {
    return Promise.reject(configErr instanceof Error ? configErr : new Error(String(configErr)));
  }

  const authState = isAuthEnabled(resolved)
    ? `enabled (${resolved.isProduction ? 'production' : 'local dev with secrets'})`
    : 'disabled (local dev)';
  console.log(`Basic Auth: ${authState}`);

  return new Promise((resolvePromise, reject) => {
    let resolvedOrigin = allowedOrigin;
    let currentResolved = resolved;

    // The dispatch/verify GitHub client is shared between dispatch and upload provenance.
    // In production both default to the fetch-based defaultGitHubClient.
    // Tests inject githubClientArg to spy on requests.
    const dispatchGithubClient = githubClientArg ?? defaultGitHubClient;

    // Injectable clock — tests inject a fake; production uses Date.now().
    const serverClock: Clock = clockArg ?? { now: () => Date.now() };

    const server = createServer((req, res) => {
      handleRequest(req, res, currentResolved, handler, env, dispatchGithubClient, serverClock);
    });

    // Connection hardening (adversarial-reviewer 5-A): bound how long a client
    // (even an authenticated one holding the upload token) may hold a connection
    // while trickling a body, so a slow-loris cannot pin sockets indefinitely.
    server.requestTimeout = 60_000; // whole request must complete within 60s
    server.headersTimeout = 15_000; // headers must arrive within 15s

    server.on('error', reject);

    server.listen(port, bindHost, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('Unexpected server address type'));
        return;
      }
      // Re-resolve allowedOrigin with the actual assigned port when port=0
      if (port === 0) {
        const reResolved = resolveEnv(env, addr.port);
        resolvedOrigin = reResolved.allowedOrigin;
        currentResolved = reResolved;
      }
      resolvePromise({
        server,
        port: addr.port,
        allowedOrigin: resolvedOrigin,
        stop(): Promise<void> {
          return new Promise((res2, rej2) => {
            server.close((err) => (err !== undefined ? rej2(err) : res2()));
          });
        },
      });
    });
  });
}
