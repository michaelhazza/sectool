# semgrep — Semgrep static analysis family

**Engine:** Semgrep (wrapped scanner)
**Scanner family:** semgrep
**vulnClass:** injection, misconfiguration, xss (varies by rule)

## What it flags

Findings from two Semgrep rule sets run in combination:

1. **`p/owasp-top-ten` curated subset** — Semgrep's curated OWASP Top 10 patterns
   covering injection, broken access control, security misconfigurations, XSS,
   and other high-value classes applicable to Node/TypeScript stacks.
2. **Custom YAML rules** (`rules/semgrep/*.yaml`) — project-specific patterns
   for the Breakout Solutions stack, including:
   - `BS-AUTH-002` — auth endpoints without rate-limit middleware
   - `BS-JWT-001` — JWT algorithm not pinned / no expiry / secret literal
   - `BS-UPLOAD-001` — multer route without size limit or type filter
   - `BS-CORS-001` — CORS wildcard or reflected-origin

Both rule sets produce findings normalized to `Finding.source: "semgrep"`.
Individual custom rules have their own docs pages (see `BS-AUTH-002.md`,
`BS-JWT-001.md`, etc.). This page covers the family as a whole — scanner
configuration, scope, and remediation approach for all semgrep-family findings.

## Why it matters

Semgrep's pattern-matching is fast and syntax-aware, making it effective for
local, syntactic vulnerability classes (configuration errors, unsafe API usage,
input validation gaps) that do not require cross-file taint analysis. The OWASP
curated subset provides breadth; the custom rules provide depth on stack-specific
patterns that general rule packs miss.

## Fix pattern

Remediation is rule-specific. Each `Finding.ruleId` maps to a Semgrep rule; look
up the rule's message for the exact pattern detected. For custom rules, consult
the individual rule doc. General principles:

```ts
// OWASP injection pattern — avoid building queries from user input
// Vulnerable
const query = `SELECT * FROM users WHERE name = '${req.body.name}'`;

// Safe — parameterized
const result = await db.execute(
  sql`SELECT * FROM users WHERE name = ${req.body.name}`
);

// OWASP XSS pattern — avoid unsanitized rendering
// Vulnerable
res.send(`<div>${req.query.message}</div>`);

// Safe — encode or sanitize before output
import { escape } from 'he';
res.send(`<div>${escape(req.query.message ?? '')}</div>`);
```

For OWASP misconfiguration findings (exposed debug endpoints, insecure defaults),
follow the rule message to disable or restrict the flagged behavior.

## Acceptance criteria

The finding must no longer fire on re-scan: the `ruleId` matching the Semgrep
check id with the same fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/semgrep/vulnerable/`
- Clean: `benchmark/corpus/static/semgrep/clean/`
