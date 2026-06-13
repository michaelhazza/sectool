# LIVE-EXPOSE-001 — Exposed debug, admin, or source-map endpoints

**Engine:** direct probe (`src/live/probes/exposure.ts`) + Nuclei templates
**Scanner family:** probe
**checkId:** LIVE-EXPOSE-001
**vulnClass:** info-disclosure
**Base severity:** high

## What it flags

Publicly accessible endpoints that should not be reachable on a production-like
staging environment:

- **Debug/diagnostic endpoints** — `/debug`, `/__debug`, `/actuator`, `/actuator/*`,
  `/_ah/*` (App Engine), `/status`, `/healthz` (when returning internal details)
- **Admin interfaces** — `/admin`, `/admin/*`, `/wp-admin`, `/_admin`, `/console`,
  `/management`
- **Source maps** — `.js.map`, `.ts` source files served directly, stack traces
  with file paths exposed in error responses
- **Development endpoints** — `/api-docs`, `/swagger`, `/swagger-ui*`,
  `/graphql` playground when introspection is enabled without auth, `/__webpack_hmr`
- **Framework diagnostics** — Express error handler stack traces, unhandled
  rejection stack traces in response bodies

The probe uses an HTTP curated path list for the bulk of checks, complemented
by Nuclei exposure templates. Only the staging target host is probed (scope
confinement per §4.4).

## Why it matters

Exposed debug and admin endpoints allow an unauthenticated attacker to:
- Access internal state, configuration, and health metrics
- Enumerate internal routes, APIs, and data structures
- In severe cases, execute administrative operations (e.g. exposed actuator
  `/env`, `/heapdump`, `/restart`)

Source maps expose original TypeScript source code, enabling attackers to audit
the application for vulnerabilities without access to the repository.

## Fix pattern

**Disable debug endpoints in non-development environments:**

```ts
// Only register debug/diagnostic routes in development
if (process.env['NODE_ENV'] === 'development') {
  app.use('/debug', debugRouter);
}

// Express error handler — don't expose stack traces in production
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const isDev = process.env['NODE_ENV'] === 'development';
  res.status(500).json({
    message: isDev ? err.message : 'Internal server error',
    stack: isDev ? err.stack : undefined,
  });
});
```

**Restrict admin interfaces to internal networks or authenticated users:**

```ts
// Admin routes require auth + admin role
router.use('/admin', requireAuth, requireRole('admin'), adminRouter);
```

**Disable source map serving in production:**

```ts
// vite.config.ts / webpack config — no source maps in production builds
export default defineConfig({
  build: {
    sourcemap: false, // or 'hidden' to keep maps without serving them
  },
});
```

**Restrict Swagger/API docs to non-production:**

```ts
if (process.env['NODE_ENV'] !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-EXPOSE-001` with the
same fingerprint must be absent from the next `audit run` output. Verify that
the exposed endpoints return 401/403/404 (not 200) after the fix is deployed.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-EXPOSE-001`)
