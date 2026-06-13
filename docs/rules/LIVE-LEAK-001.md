# LIVE-LEAK-001 — Server/framework version leakage

**Engine:** direct probe (`src/live/probes/exposure.ts`) + Nuclei templates
**Scanner family:** probe
**checkId:** LIVE-LEAK-001
**vulnClass:** info-disclosure
**Base severity:** low

## What it flags

HTTP response headers and error pages that disclose the server software and
framework versions, allowing an attacker to fingerprint the stack and look up
known CVEs for the exact version:

- **`Server` header** — e.g. `Server: Express`, `Server: nginx/1.18.0`
- **`X-Powered-By` header** — e.g. `X-Powered-By: Express` (set by Express by
  default)
- **`X-AspNet-Version`, `X-AspNetMvc-Version`** — .NET version disclosure
- **Error pages** — stack traces or default error pages that include framework
  name and version
- **`via` header** — proxy version disclosure in reverse proxy setups
- **npm package versions in JavaScript bundles** — `package.json` served as a
  static asset, or version strings embedded in bundle comments

## Why it matters

Version information reduces the attacker's reconnaissance effort. Knowing the
exact Express, Node, or database version allows targeted exploit lookup against
known CVEs. While version leakage alone is low severity, it is often the first
step in a targeted attack chain, and suppressing it is zero-cost.

## Fix pattern

**Disable `X-Powered-By` header** (Express default):

```ts
// Disable the X-Powered-By header (or use helmet which does this by default)
app.disable('x-powered-by');

// Or via helmet
import helmet from 'helmet';
app.use(helmet()); // removes X-Powered-By and sets other security headers
```

**Override the `Server` header** in the reverse proxy (nginx example):

```nginx
# nginx.conf — hide version from Server header
server_tokens off;

# Or set a generic value
more_set_headers 'Server: unknown';
```

**Remove version from error pages** — ensure the production error handler
(see `LIVE-EXPOSE-001.md`) returns generic messages without framework details.

**Exclude `package.json` from static assets:**

```ts
// Express static middleware — exclude sensitive files
app.use('/static', express.static('public', {
  // package.json should not be in the public/ directory
}));
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-LEAK-001` with the
same fingerprint must be absent from the next `audit run` output. Verify with
`curl -I <staging-url>` that `X-Powered-By` and version-bearing `Server` headers
are absent from responses.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-LEAK-001`)
