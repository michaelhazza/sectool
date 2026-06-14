import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadAllowlist, loadTargets } from '../config/load.js';
import type { RunReport } from '../schemas/report.js';
import { buildPack } from '../fix/pack.js';
import { fileFixRequest, MissingFixTokenError } from '../fix/github.js';
import type { GitHubHttpClient, EnvReader } from '../fix/github.js';
import { upsertFix } from '../fix/status.js';
import { resolveEnv, assertProductionConfig, type ResolvedEnv } from './env.js';
import { basicAuthGate, isAuthEnabled } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = resolve(REPO_ROOT, 'config');

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

/** Maximum accepted request body size (64 KiB). Fix-request bodies are tiny. */
const MAX_BODY_BYTES = 64 * 1024;

/** Read the full request body as a UTF-8 string, capped at MAX_BODY_BYTES.
 *  Rejects with a {tooLarge: true} error if the cap is exceeded. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let data = '';
    let byteCount = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buf.byteLength;
      if (byteCount > MAX_BODY_BYTES) {
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
function makeProductionFixHandler(reportsDir: string, opts?: { client?: GitHubHttpClient; env?: EnvReader }): FixHandler {
  return async (fingerprint: string) => {
    // Load config to get the target registry (for repoUrl resolution)
    const allowlist = loadAllowlist();
    const registry = loadTargets(allowlist);

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

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, reportsDir: string, historyDir: string): boolean {
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
    if (runId === undefined) {
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

  // GET /api/config/targets — config/targets.json
  if (req.method === 'GET' && pathname === '/api/config/targets') {
    try {
      const data = readJsonFile(resolve(CONFIG_DIR, 'targets.json'));
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, { repos: [], stagingTargets: [] });
    }
    return true;
  }

  // GET /api/config/allowlist — config/allowed-staging-hosts.json
  if (req.method === 'GET' && pathname === '/api/config/allowlist') {
    try {
      const data = readJsonFile(resolve(CONFIG_DIR, 'allowed-staging-hosts.json'));
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, { hosts: [] });
    }
    return true;
  }

  // GET /api/config/baseline — config/baseline.json
  if (req.method === 'GET' && pathname === '/api/config/baseline') {
    try {
      const data = readJsonFile(resolve(CONFIG_DIR, 'baseline.json'));
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
): void {
  const { allowedOrigin, reportsDir, historyDir } = resolvedEnv;
  const raw = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(raw, allowedOrigin);
  } catch {
    jsonResponse(res, 400, { error: 'Bad request' });
    return;
  }

  // Basic Auth gate — applied after URL parse, BEFORE route dispatch.
  // Exemptions: /healthz (unauthenticated health probe) and /api/upload
  // (uses bearer auth in C6, bypasses Basic Auth by design).
  const isExempt = url.pathname === '/healthz' || url.pathname === '/api/upload';
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

  // Read-only API routes
  if (url.pathname.startsWith('/api/')) {
    if (!handleApi(req, res, url, reportsDir, historyDir)) {
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

  const env = envReader ?? ((name: string) => process.env[name]);
  const resolved = resolveEnv(env, port);
  const { bindHost, allowedOrigin, reportsDir } = resolved;

  const handler = fixHandlerArg ?? makeProductionFixHandler(reportsDir, {
    ...(githubClientArg !== undefined ? { client: githubClientArg } : {}),
    env,
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

    const server = createServer((req, res) => {
      handleRequest(req, res, currentResolved, handler);
    });

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
