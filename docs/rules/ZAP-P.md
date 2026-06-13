# ZAP-P — OWASP ZAP passive scan findings

**Engine:** OWASP ZAP (automation framework, passive scan mode)
**Scanner family:** zap
**checkId pattern:** `ZAP-P-<pluginId>` (e.g. `ZAP-P-10020`, `ZAP-P-10038`)
**vulnClass:** varies by alert (misconfiguration, info-disclosure, xss, etc.)
**Base severity:** varies by ZAP alert risk level

## What it flags

Passive alerts produced by OWASP ZAP's passive scan engine while crawling the
staging target. Passive scanning observes HTTP traffic without sending additional
attack requests — it never modifies data or induces server-side state changes.
Passive checks run for all enabled staging targets regardless of the `activeScan`
flag.

Common passive alert categories:

- **Information disclosure** — server version headers, debug information in
  responses, internal IP addresses in responses (`X-Backend-Server`)
- **Missing security headers** — CSP, HSTS, X-Frame-Options, etc.
  (complements `LIVE-HDR-001`)
- **Cookie issues** — missing `HttpOnly`/`Secure`/`SameSite` flags
  (complements `LIVE-COOKIE-001`)
- **Application error disclosure** — stack traces or detailed error messages
  in HTTP responses
- **Cross-domain script inclusion** — scripts loaded from third-party domains
  without SRI (Subresource Integrity)
- **Timestamp disclosure** — `Last-Modified` or other headers revealing internal
  timestamps

Each finding carries the ZAP plugin id as part of the `checkId` (e.g.
`ZAP-P-10020` for the "Anti-clickjacking Header" plugin). The full list of ZAP
passive plugins is documented in the
[ZAP Alerts documentation](https://www.zaproxy.org/docs/alerts/).

## Why it matters

Passive ZAP findings represent configuration and information-hygiene gaps that
are detectable without active probing. They are particularly valuable on staging
environments where active scanning is disabled (`activeScan: false`) — passive
alerts provide meaningful security signal with zero risk of unintended side
effects.

## Fix pattern

Remediation is specific to the ZAP alert. Read the ZAP alert description in the
finding for the specific header, configuration value, or code change required.
The `checkId` (e.g. `ZAP-P-10038`) maps to a specific ZAP passive plugin whose
description and fix guidance is in the [ZAP Alerts index](https://www.zaproxy.org/docs/alerts/).

**Example — Anti-clickjacking header missing (ZAP-P-10020):**

```ts
// Add X-Frame-Options or CSP frame-ancestors directive
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  // or via CSP: res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
```

**Example — Application error disclosure (ZAP-P-90022):**

```ts
// Don't expose stack traces in production
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
  // log internally: logger.error(err);
});
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: ZAP-P-<pluginId>` with
the same fingerprint must be absent from the next `audit run` output. The
acceptance scan runs the same passive ZAP crawl after the fix is deployed.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entries beginning with `ZAP-P-*`)
