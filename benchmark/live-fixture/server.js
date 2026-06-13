/**
 * benchmark/live-fixture/server.js
 *
 * Purpose-built hit-recording server for the §4.7 safety-abort test.
 * Built with Node built-in `http` only — no external dependencies.
 *
 * Intentional vulnerabilities (for P6-1 live recall integration):
 *   - Reflected XSS: GET /reflect?q=<value> echoes value without escaping
 *   - Simple stored XSS placeholder: POST /store + GET /stored echoes stored value
 *   - No security headers (no X-Frame-Options, no CSP, etc.)
 *   - No HttpOnly/Secure cookie flags on session cookie
 *   - Exposed debug endpoint at /debug
 *
 * Hit-recording contract (for §4.7 abort test):
 *   - GET /hits returns JSON { count: N } — the number of requests received
 *   - GET /reset resets the count to 0
 *
 * Start: node server.js [port] [host]
 * Defaults: port=0 (OS-assigned), host=127.0.0.1
 *
 * On startup prints: LISTENING <host>:<port>
 * This allows the test runner to read the actual port from stdout.
 */

import http from 'node:http';

// Simple in-memory hit counter (excludes /hits and /reset management routes).
let hitCount = 0;

// Simple stored value for the stored-XSS fixture.
let storedValue = '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? '127.0.0.1'}`);
  const path = url.pathname;

  // Management routes — not counted as hits (used by the abort test).
  if (path === '/hits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: hitCount }));
    return;
  }
  if (path === '/reset') {
    hitCount = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true }));
    return;
  }

  // All other routes count as hits.
  hitCount += 1;

  // --- Intentionally vulnerable endpoints ---

  if (path === '/reflect') {
    // Reflected XSS: echoes ?q= without HTML-encoding.
    const q = url.searchParams.get('q') ?? '';
    // INTENTIONALLY VULNERABLE: no escaping — seeded for LIVE-XSS recall.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><p>${q}</p></body></html>`);
    return;
  }

  if (path === '/store' && req.method === 'POST') {
    // Simple stored XSS: accepts body and stores it.
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      storedValue = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stored: true }));
    });
    return;
  }

  if (path === '/stored') {
    // INTENTIONALLY VULNERABLE: echoes stored value without escaping.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body><p>${storedValue}</p></body></html>`);
    return;
  }

  if (path === '/debug') {
    // Exposed debug endpoint — seeded for LIVE-EXPOSE-001 recall.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ env: 'staging', version: '0.1.0', debug: true }));
    return;
  }

  if (path === '/api/login' && req.method === 'POST') {
    // Login endpoint — no rate limiting (seeded for BS-AUTH-002 / LIVE-SESSION).
    // INTENTIONALLY VULNERABLE: no rate limit middleware.
    // Sets a cookie WITHOUT HttpOnly or Secure flags (seeded for LIVE-COOKIE-001).
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=fixture-session-token; Path=/',
    });
    res.end(JSON.stringify({ token: 'fixture-jwt-placeholder' }));
    return;
  }

  // Default: 404 with no security headers (seeded for LIVE-HDR-001 recall).
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const port = parseInt(process.argv[2] ?? '0', 10);
const host = process.argv[3] ?? '127.0.0.1';

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`LISTENING ${host}:${actualPort}\n`);
});
