# gitleaks — Secret detection family

**Engine:** gitleaks (wrapped scanner)
**Scanner family:** gitleaks
**vulnClass:** secrets
**Base severity:** high (all secrets findings)

## What it flags

Hardcoded secrets and credential material committed to source code or present
in the working tree, including:

- API keys and tokens (GitHub PATs, Stripe keys, AWS access keys, etc.)
- Private keys and certificates (PEM blocks, SSH keys)
- Database connection strings with embedded passwords
- JWT secrets and signing keys stored as string literals
- Environment variable values accidentally committed (e.g. `.env` files)
- Generic high-entropy strings matching known credential patterns

gitleaks scans the full git history of the repository, not just the current
HEAD, so secrets removed from current code but still present in prior commits
are detected. Working-tree scans also catch secrets in untracked files.

## Why it matters

Committed secrets are permanently accessible to anyone with repository access
and, in the case of public or leaked repositories, to the entire internet.
Secret exposure is typically a direct path to account compromise, data
exfiltration, or lateral movement across systems. Secrets in git history cannot
be removed by simply deleting them from a later commit — they require a
history rewrite.

## Fix pattern

1. **Rotate the secret immediately** — assume it is already compromised.
2. **Remove from source** — delete the literal value from all files.
3. **Rewrite history** if the secret was ever committed (use `git filter-repo`
   or the GitHub secret-scanning push-protection revocation flow).
4. **Store secrets in environment variables** loaded at runtime, never as
   code literals:

```ts
// Vulnerable — secret literal in source
const apiKey = 'EXAMPLE_PLACEHOLDER_not_a_real_secret';

// Safe — loaded from environment, never committed
const stripeKey = process.env['STRIPE_SECRET_KEY'];
if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is required');
```

5. **Use a secrets manager** (Doppler, AWS Secrets Manager, 1Password Secrets
   Automation) for production credentials rather than `.env` files.
6. **Add `.env` to `.gitignore`** and use `.env.example` with placeholder
   values as the checked-in template.

## Acceptance criteria

The finding must no longer fire on re-scan: `ruleId` matching the gitleaks
rule id with the same fingerprint must be absent from the next `audit run`
output. Because gitleaks scans history, the acceptance criteria includes
confirming the secret is absent from ALL commits accessible in the repo,
not just the current HEAD.

Note: the audit tool redacts the actual secret value in all output
(`[redacted:<8hex>]`). The `ruleId` and rule description in the finding
describe the secret type without revealing the value.

## Fixture

- Vulnerable: `benchmark/corpus/static/gitleaks/vulnerable/`
- Clean: `benchmark/corpus/static/gitleaks/clean/`
