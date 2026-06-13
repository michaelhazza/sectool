# osv — Known-CVE dependency vulnerability family

**Engine:** osv-scanner (wrapped scanner)
**Scanner family:** osv
**vulnClass:** dependency-cve
**Base severity:** varies by upstream CVSS (critical / high / medium / low)

## What it flags

Known vulnerabilities in project dependencies declared in `package.json` /
`package-lock.json` (and lockfile transitive graph), cross-referenced against
the [Open Source Vulnerabilities (OSV)](https://osv.dev) database. Covers:

- Direct dependencies with known CVEs or OSV advisories
- Transitive (indirect) dependencies with known vulnerabilities
- Packages with multiple published vulnerabilities (advisory bundles)
- npm ecosystem advisories, including GitHub Security Advisories (GHSA)

Each finding carries an OSV advisory ID (`GHSA-*` or `CVE-*`) as the `ruleId`,
the affected package name and version range, and the CVSS score when available.

## Why it matters

A dependency vulnerability grants an attacker the same exploitability as the
upstream flaw. High/critical CVEs in transitive dependencies (e.g. a known
prototype-pollution or path-traversal in a deeply-nested package) are as
exploitable as direct dependencies and are commonly overlooked.

## Fix pattern

1. **Update the affected package** to a version that resolves the advisory:

```bash
# Check which packages have known vulnerabilities
npx osv-scanner --lockfile package-lock.json

# Update a specific vulnerable package
npm update <package-name>

# Or update all packages to latest compatible versions
npm update

# Force a resolution for a transitive dependency (package.json overrides)
```

2. **For transitive vulnerabilities** where no direct update is available, add
   a `"overrides"` entry in `package.json` to force the patched version:

```json
{
  "overrides": {
    "vulnerable-transitive-package": ">=patched.version"
  }
}
```

3. **For vulnerabilities with no available fix**, document the risk in the
   baseline (`config/baseline.json`) with a justification and expiry date,
   and track the upstream advisory for a patch release.

4. **Verify the fix** — run `npx osv-scanner --lockfile package-lock.json`
   and confirm the advisory is resolved.

## Acceptance criteria

The finding must no longer fire on re-scan: the advisory `ruleId` with the same
fingerprint must be absent from the next `audit run` output. Typically this
means updating the dependency so the installed version no longer falls in the
vulnerable range, and committing the updated `package-lock.json`.

## Fixture

- Vulnerable: `benchmark/corpus/static/osv/vulnerable/`
- Clean: `benchmark/corpus/static/osv/clean/`
