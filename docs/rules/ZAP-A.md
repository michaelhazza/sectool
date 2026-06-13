# ZAP-A — OWASP ZAP active scan findings

**Engine:** OWASP ZAP (automation framework, active scan mode)
**Scanner family:** zap
**checkId pattern:** `ZAP-A-<pluginId>` (e.g. `ZAP-A-40012`, `ZAP-A-40016`)
**vulnClass:** varies by alert (injection, xss, csrf, open-redirect, etc.)
**Base severity:** varies by ZAP alert risk level (typically high or critical for active findings)

## What it flags

Active alerts produced by OWASP ZAP's active scan engine when `activeScan: true`
is set on the staging target. Active scanning sends crafted attack payloads to
the target to detect exploitable vulnerabilities. Active checks run ONLY for
targets with `activeScan: true`.

Common active alert categories:

- **Reflected XSS** — user input reflected in HTTP responses without escaping;
  payloads injected into query parameters, form fields, and headers
- **Stored XSS** — injected payloads stored server-side and reflected to
  subsequent requests
- **SQL injection** — payloads injected into database query parameters causing
  error-based or blind SQLi signals
- **Command injection** — OS command injection via application parameters
- **CSRF** — state-changing requests that lack CSRF tokens and can be triggered
  cross-origin
- **Open redirect** — redirect parameters that forward users to arbitrary external
  URLs
- **Server-side request forgery (SSRF)** — probe responses that suggest server-side
  fetching of attacker-controlled URLs

Each finding carries the ZAP plugin id as part of the `checkId` (e.g.
`ZAP-A-40012` for the "Cross Site Scripting (Reflected)" plugin). The full list
of ZAP active plugins is in the
[ZAP Alerts documentation](https://www.zaproxy.org/docs/alerts/).

## Why it matters

Active ZAP findings are confirmed-exploitable vulnerabilities: ZAP received a
response indicating successful exploitation (error messages, XSS reflection
confirmation, redirect to a controlled URL). These represent immediate remediation
priorities. Because active scanning requires `activeScan: true` and valid
credentials, findings here are in paths that actually exist and were reachable
during the scan — they are not theoretical.

## Fix pattern

Remediation is specific to the ZAP alert. Read the ZAP alert description in the
finding for the exact vulnerability type. The `checkId` (e.g. `ZAP-A-40012`)
maps to a specific ZAP active plugin described in the
[ZAP Alerts index](https://www.zaproxy.org/docs/alerts/).

**Example — Reflected XSS (ZAP-A-40012):**

```ts
// Escape user input before reflecting it in HTML responses
import { escape } from 'he';

router.get('/search', (req, res) => {
  const query = escape(req.query.q as string ?? '');
  res.send(`<h1>Results for: ${query}</h1>`);
});

// Or use a templating engine that escapes by default
```

**Example — CSRF (ZAP-A-20012):**

```ts
import csrf from 'csurf';

app.use(csrf({ cookie: true }));
app.get('/form', (req, res) => {
  res.render('form', { csrfToken: req.csrfToken() });
});
```

**Example — Open redirect (ZAP-A-30001):**

```ts
// Validate redirect targets against an allowlist
const ALLOWED_REDIRECT_HOSTS = new Set(['app.breakout.dev', 'staging.breakout.dev']);

router.get('/redirect', (req, res) => {
  const url = new URL(req.query.to as string, `https://${req.hostname}`);
  if (!ALLOWED_REDIRECT_HOSTS.has(url.hostname)) {
    return res.status(400).json({ error: 'Invalid redirect target' });
  }
  res.redirect(url.toString());
});
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: ZAP-A-<pluginId>` with
the same fingerprint must be absent from the next `audit run` output. The
acceptance scan requires `activeScan: true` with valid credentials on the
staging target.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entries beginning with `ZAP-A-*`)
