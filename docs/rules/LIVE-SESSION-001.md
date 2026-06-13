# LIVE-SESSION-001 — Session management weakness

**Engine:** ZAP active scan + auth session checks
**Scanner family:** probe (finding emitted with `source: "probe"`, `checkId: "LIVE-SESSION-001"`)
**checkId:** LIVE-SESSION-001
**vulnClass:** session-management
**Base severity:** high

## What it flags

Session lifecycle and token management weaknesses detected through active
probing of the authenticated session:

- **Session fixation** — the session token is not rotated after a successful
  login (an attacker who knows the pre-login session token can use it post-login)
- **Lack of session invalidation on logout** — the server-side session remains
  valid after a `POST /logout` response (the client's token continues to
  authenticate)
- **Predictable session tokens** — low-entropy session identifiers that can be
  guessed or brute-forced (short token, PRNG-based, sequential)
- **Excessively long session lifetime** — no server-side expiry or an expiry
  measured in days/weeks for a sensitive application
- **JWT without expiry or with overly long `exp`** — a JWT that never expires
  or expires after an unreasonable period (typically > 24h for a session token)
- **Token reuse after logout** — a JWT or opaque token returned by a logout
  endpoint can still be used to authenticate (no server-side revocation or
  blocklist)

## Why it matters

Session management failures are a direct path to account takeover. Session
fixation allows an attacker to pre-set a known token before the victim logs in.
Lack of server-side invalidation means stolen tokens remain usable indefinitely.
Predictable tokens can be guessed at scale. JWT-specific issues (`none` algorithm,
missing `exp`) are particularly dangerous because the token is self-contained
and cannot be revoked without a blocklist.

## Fix pattern

**Session rotation on login** (express-session):

```ts
app.post('/api/auth/login', async (req, res) => {
  const user = await validateCredentials(req.body);
  // Rotate the session ID immediately after successful auth
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = user.id;
  res.json({ ok: true });
});
```

**Invalidate session on logout:**

```ts
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
  res.clearCookie('connect.sid');
  res.json({ ok: true });
});
```

**JWT expiry and minimal lifetime:**

```ts
import jwt from 'jsonwebtoken';

const token = jwt.sign(
  { userId: user.id },
  process.env['JWT_SECRET'] ?? '',
  {
    expiresIn: '1h',    // short-lived; refresh via a separate refresh token flow
    algorithm: 'HS256', // pin the algorithm (see also BS-JWT-001)
  },
);
```

**Enforce short session TTL in express-session:**

```ts
app.use(session({
  cookie: {
    maxAge: 60 * 60 * 1000, // 1 hour
  },
  rolling: true, // reset expiry on activity
}));
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: LIVE-SESSION-001` with
the same fingerprint must be absent from the next `audit run` output. The
acceptance scan requires `activeScan: true` to exercise the full session
lifecycle probe.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entry: `LIVE-SESSION-001`)
