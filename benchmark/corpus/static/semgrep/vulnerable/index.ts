// Semgrep vulnerable fixture — CORS wildcard triggers BS-CORS-001 local YAML rule.
// INTENTIONALLY VULNERABLE: reflects the request Origin or uses wildcard CORS.

export function setupCors(app: { use: (mw: unknown) => void }) {
  // INTENTIONALLY VULNERABLE: wildcard CORS allows any origin
  app.use((_req: unknown, res: { header: (k: string, v: string) => void }, next: () => void) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    next();
  });
}
