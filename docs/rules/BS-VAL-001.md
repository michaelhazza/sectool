# BS-VAL-001 — Route handler reading body/query/params without Zod validation

**Engine:** ts-morph
**Base severity:** medium
**vulnClass:** misconfiguration

## What it flags

Express route handlers (inline arrow functions or function expressions registered
via `router.get/post/put/patch/delete`) that:

1. Read `req.body`, `req.query`, or `req.params` (directly or via local variable), AND
2. Do NOT call `.parse()` or `.safeParse()` on any schema in the same function body.

## Why it matters

Unvalidated request input is a root cause of injection vulnerabilities, data
corruption, and unexpected runtime errors. The Breakout stack uses Zod for
schema validation; skipping it at the route boundary means type coercions,
unexpected nulls, and oversized payloads can reach business logic unfiltered.

## Fix pattern

Parse and validate request input with a Zod schema at the top of the handler:

```ts
import { z } from 'zod';

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

// Vulnerable
router.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  // name / email are unvalidated
  await createUser({ name, email });
});

// Safe: parse at the boundary
router.post('/api/users', async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { name, email } = parsed.data;
  await createUser({ name, email });
});
```

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId: BS-VAL-001` with the same
fingerprint must be absent from the next `audit run` output.

## Fixture

- Vulnerable: `benchmark/corpus/static/BS-VAL-001/vulnerable/`
- Clean: `benchmark/corpus/static/BS-VAL-001/clean/`
