import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');
const HISTORY_DIR = resolve(REPO_ROOT, 'history');
const CONFIG_DIR = resolve(REPO_ROOT, 'config');
const FIXES_JSON = resolve(REPORTS_DIR, 'fixes.json');

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

// ---------------------------------------------------------------------------
// Read-only JSON endpoints
// ---------------------------------------------------------------------------

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const { pathname } = url;

  // GET /api/csrf — serves the per-process nonce to the same-origin SPA
  if (req.method === 'GET' && pathname === '/api/csrf') {
    jsonResponse(res, 200, { csrfToken: CSRF_NONCE });
    return true;
  }

  // GET /api/reports — list all run directories
  if (req.method === 'GET' && pathname === '/api/reports') {
    let entries: string[];
    try {
      entries = readdirSync(REPORTS_DIR);
    } catch {
      jsonResponse(res, 200, []);
      return true;
    }
    const runs = entries.filter((e) => {
      try {
        return statSync(resolve(REPORTS_DIR, e)).isDirectory();
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
    const reportPath = resolve(REPORTS_DIR, runId, 'report.json');
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
      raw = readFileSync(resolve(HISTORY_DIR, 'trend.jsonl'), 'utf8');
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
      const data = readJsonFile(FIXES_JSON);
      jsonResponse(res, 200, data);
    } catch {
      jsonResponse(res, 200, {});
    }
    return true;
  }

  return false;
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

function handleRequest(req: IncomingMessage, res: ServerResponse, port: number): void {
  const raw = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(raw, `http://127.0.0.1:${port}`);
  } catch {
    jsonResponse(res, 400, { error: 'Bad request' });
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    if (!handleApi(req, res, url)) {
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
  stop(): Promise<void>;
}

/**
 * Start the audit UI server, bound to 127.0.0.1 ONLY (never 0.0.0.0).
 * @param port - TCP port (0 = OS-assigned ephemeral port for tests)
 */
export function startServer(port: number): Promise<AuditServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, listenPort);
    });

    let listenPort = port;

    server.on('error', reject);

    // Bind to 127.0.0.1 ONLY — never 0.0.0.0 (§5.2 safety contract)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('Unexpected server address type'));
        return;
      }
      listenPort = addr.port;
      resolve({
        server,
        port: addr.port,
        stop(): Promise<void> {
          return new Promise((res2, rej2) => {
            server.close((err) => (err !== undefined ? rej2(err) : res2()));
          });
        },
      });
    });
  });
}
