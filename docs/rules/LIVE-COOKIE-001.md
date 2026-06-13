# LIVE-COOKIE-001 — Cookie security flags missing

**Engine:** direct probe (`src/live/probes/cookies.ts`)
**Scanner family:** probe
**checkId:** LIVE-COOKIE-001
**vulnClass:** session-management
**Base severity:** medium

## What it flags

Session and authentication cookies issued by the staging target that are missing
one or more security flags:

- **`HttpOnly`** — absent: JavaScript can read the cookie via `document.cookie`,
  enabling cookie theft via XSS
- **`Secure`** — absent: cookie transmitted over plain HTTP, exposing it to
  network interception
- **`SameSite`** — absent or set to `None` without `Secure`: cross-site request
  forgery risk; `Lax` is the minimum; `Strict` is preferred for session tokens

The probe inspects `Set-Cookie` headers on login and key application responses.
It specifically looks for cookies whose names match common session/auth patterns
(`session`, `sid`, `token`, `auth`, `connect.sid`, and common framework session
cookie names).

## Why it matters

A session cookie without `HttpOnly` can be exfiltrated by any XSS finding in
the application — even a low-severity reflected XSS becomes a full session
hijack. Without `Secure`, the cookie travels in plaintext over HTTP (e.g. on a
captive portal or redirected HTTP request). Without `SameSite`, any origin can
trigger authenticated requests using the victim's session (CSRF).

## Fix pattern

Set all three flags on session cookies in the Express session/cookie configuration:

```ts
import session from 'express-session';

app.use(session({
  secret: process.env['SESSION_SECRET'] ?? '',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,     // prevent JS access
    secure: true,       // HTTPS only
    sameSite: 'strict', // or 'lax' for cross-site GET navigation
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  },
}));

// For JWT bearer + cookie hybrid, set the cookie directly:
res.cookie('token', jwtToken, {
  httpOnly: true,
  secure: process.env['NODE_ENV'] === 'production',
  sameSite: 'strict',
  maxAge: 3600000,
});
```

For `SameSite: None` (required for cross-site embeds), pair it with `Secure`
and ensure the application has an explicit CSRF defense:

```ts
res.cookie('session', value, {
  httpOnly: true,
  secure: true,
  sameSite: 'none', // only when cross-site access is required
});
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-COOKIE-001` with the
same fingerprint must be absent from the next `audit run` output. Verify the
`Set-Cookie` headers in the login response include all three flags.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-COOKIE-001`)
