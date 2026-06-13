# BS-JWT-001 — JWT misconfiguration (algorithm, expiry, or literal secret)

**Engine:** semgrep (pattern match)
**Base severity:** high
**vulnClass:** auth-access-control (algorithm/expiry sub-rules), secrets (literal-secret sub-rule)

## What it flags

Three distinct JWT misconfiguration patterns, each a separate semgrep rule
in `BS-JWT-001.yaml`:

| Sub-rule | Pattern | Risk |
|---|---|---|
| BS-JWT-001-algorithm | `jwt.sign(...)` or `jwt.verify(...)` without an explicit `algorithm`/`algorithms` option | Algorithm confusion attack (`none` alg, RS256→HS256 confusion) |
| BS-JWT-001-expiry | `jwt.sign(...)` without `expiresIn` (or inline `exp` claim) | Non-expiring tokens cannot be invalidated after a breach |
| BS-JWT-001-literal-secret | `jwt.sign(...)` or `jwt.verify(...)` with a string literal as the secret | Hard-coded secrets are trivially leaked via source and cannot be rotated |

## Why it matters

JWT misconfigurations are a leading cause of authentication bypass.
The algorithm confusion attack allows forging tokens by exploiting libraries
that accept `alg: "none"` or that confuse symmetric/asymmetric keys. Missing
expiry means stolen tokens are permanently valid. A hard-coded secret is as
good as no secret.

## Fix pattern

```ts
import jwt from 'jsonwebtoken';

const secret = process.env['JWT_SECRET'];
if (!secret) throw new Error('JWT_SECRET env var not set');

// Safe: algorithm pinned, expiry set, secret from environment
const token = jwt.sign(
  { sub: userId },
  secret,
  { algorithm: 'HS256', expiresIn: '15m' },
);

// Safe: verify with algorithms array
const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-JWT-001` with the
same fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-JWT-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-JWT-001/clean/`
