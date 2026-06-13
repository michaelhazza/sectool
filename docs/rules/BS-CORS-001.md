# BS-CORS-001 — CORS wildcard or reflected-origin

**Engine:** semgrep (pattern match)
**Base severity:** high
**vulnClass:** misconfiguration

## What it flags

Two distinct CORS misconfiguration patterns:

| Sub-rule | Pattern | Risk |
|---|---|---|
| BS-CORS-001-wildcard | `cors({ origin: "*" })`, `cors("*")`, or `res.setHeader("Access-Control-Allow-Origin", "*")` | Any origin may read credentialed API responses |
| BS-CORS-001-reflected-origin | Origin callback that echoes back the incoming `Origin` header (`cb(null, origin)`) or direct `res.header("Access-Control-Allow-Origin", req.headers.origin)` | Functionally equivalent to a wildcard — attacker-controlled origins gain access |

## Why it matters

A CORS misconfiguration that grants all origins access to a credentialed
API allows any website the victim visits to make authenticated requests on
their behalf and read the responses. This enables cross-origin data theft
without user interaction on the attacker's page.

## Fix pattern

```ts
import cors from 'cors';

const ALLOWED = new Set([
  'https://staging.example.com',
  'https://app.example.com',
]);

// Safe: explicit origin allowlist
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.has(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-CORS-001` with the
same fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-CORS-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-CORS-001/clean/`
