# LIVE-HDR-001 — Missing or misconfigured security headers

**Engine:** direct probe (`src/live/probes/headers.ts`)
**Scanner family:** probe
**checkId:** LIVE-HDR-001
**vulnClass:** misconfiguration
**Base severity:** medium

## What it flags

Absent or incorrectly configured HTTP security response headers on the staging
target:

- **`Strict-Transport-Security` (HSTS)** — absent or `max-age` below 31536000
  (1 year); `includeSubDomains` absent
- **`Content-Security-Policy` (CSP)** — absent, or `unsafe-inline` / `unsafe-eval`
  present without a nonce/hash, or `default-src *` wildcard
- **`X-Frame-Options`** — absent (clickjacking protection); accept `DENY` or
  `SAMEORIGIN`
- **`X-Content-Type-Options`** — absent or not set to `nosniff`
- **`Referrer-Policy`** — absent or set to a leaky value (`unsafe-url`,
  `no-referrer-when-downgrade`)
- **`Permissions-Policy`** — absent (formerly Feature-Policy); absence of
  camera/microphone/geolocation restrictions
- **`Cross-Origin-Opener-Policy` (COOP)** — absent on apps serving sensitive
  data in cross-origin contexts

## Why it matters

Security headers are the browser's last line of defense against a range of
client-side attacks. Missing HSTS enables protocol downgrade; missing or
misconfigured CSP enables XSS by allowing inline script execution; missing
`X-Frame-Options` enables clickjacking; missing `X-Content-Type-Options`
enables MIME-type sniffing attacks. These are low-effort, high-value controls
that staging environments routinely lack.

## Fix pattern

Set security headers in the Express application (apply globally via middleware
before routes):

```ts
import helmet from 'helmet';
import { type RequestHandler } from 'express';

// Option A — use helmet (recommended)
app.use(helmet({
  // HSTS — 1 year, includeSubDomains
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // CSP — restrict sources; use nonces for inline scripts
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],   // add nonce for inline scripts
      styleSrc: ["'self'", "'unsafe-inline'"],  // tighten further if possible
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Option B — manual header middleware
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
};
app.use(securityHeaders);
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-HDR-001` with the
same fingerprint must be absent from the next `audit run` output. Verify all
missing headers are present in the response with correct values using `curl -I`.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-HDR-001`)
