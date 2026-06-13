# BS-AUTH-002 — Auth endpoint without rate-limit middleware

**Engine:** semgrep (pattern match)
**Base severity:** medium
**vulnClass:** auth-access-control

## What it flags

Express route definitions where the path matches an authentication endpoint
(`/login`, `/register`, `/reset`, `/forgot-password`, and common
`/auth/*`/`/api/auth/*` variants) but no rate-limit middleware identifier
appears in the middleware chain before the handler.

Recognized rate-limiter middleware names include:
`rateLimit`, `rateLimiter`, `limiter`, `apiLimiter`, `authLimiter`,
`loginLimiter`, `throttle`, `slowDown`.

## Why it matters

Authentication endpoints without rate limiting are the first target for
credential-stuffing and brute-force attacks. An unthrottled `/login` allows
millions of password guesses per minute, turning any leaked email list into
a full account-takeover risk.

## Fix pattern

Apply an express-rate-limit (or equivalent) middleware before the handler:

```ts
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Before (vulnerable)
router.post('/login', async (req, res) => { ... });

// After (safe)
router.post('/login', authLimiter, async (req, res) => { ... });
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-AUTH-002` with the
same fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-AUTH-002/vulnerable/`
- Clean: `benchmark/corpus/static/BS-AUTH-002/clean/`
