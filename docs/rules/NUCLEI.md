# NUCLEI — Nuclei template scan findings

**Engine:** Nuclei (version-pinned in Dockerfile)
**Scanner family:** nuclei
**checkId pattern:** `NUCLEI-<template-id>` (e.g. `NUCLEI-cve-2021-44228`, `NUCLEI-exposed-panels`)
**vulnClass:** varies by template (info-disclosure, dependency-cve, misconfiguration, injection, etc.)
**Base severity:** varies by template severity tag

## What it flags

Findings from Nuclei templates run against the staging target. Nuclei uses a
YAML-based template language to check for specific known-vulnerability signatures,
exposed service panels, and technology fingerprints. Both passive (read-only)
and active (fuzzing) templates are run depending on the `activeScan` flag.

Template categories used by this tool:

- **Exposed service panels** — admin consoles, database management UIs, CI/CD
  dashboards, container management interfaces exposed on the staging host
- **Technology detection** — framework, server, and library version fingerprinting
  used to identify potentially vulnerable software versions
- **Known CVE templates** — Nuclei community templates for high-profile CVEs
  with reliable network-level detection (e.g. Log4Shell, Spring4Shell, critical
  Node.js module CVEs)
- **Exposed endpoints + version leakage** — Nuclei templates for known
  diagnostic or version-disclosure endpoints specific to common Node/Express
  stacks (complements `LIVE-EXPOSE-001`)
- **Fuzzing templates** (active-only, `activeScan: true`) — parameter fuzzing,
  SSRF, template injection payloads for common server-side template engines

Each finding carries the Nuclei template id as part of the `checkId`
(e.g. `NUCLEI-generic-tokens`). The full template library is at
[github.com/projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates).

## Why it matters

Nuclei provides fast, reliable detection of known-vulnerability signatures that
are difficult to cover with custom rules — particularly CVE-based checks and
exposed-panel detection across a wide technology surface. The template
community is actively maintained, so new high-profile CVE templates are
typically available within days of public disclosure.

## Fix pattern

Remediation is specific to the Nuclei template. Read the template description
in the finding for the exact vulnerability. The `checkId` (e.g.
`NUCLEI-cve-2021-44228`) identifies the specific Nuclei template; the template's
YAML `description` and `remediation` fields describe the fix.

**General patterns:**

**Exposed admin panels** — restrict to internal network or require authentication:

```ts
// Only mount admin UI behind auth + network restriction
router.use('/admin-panel', requireAuth, requireRole('admin'), adminPanelRouter);
```

**Outdated dependencies with known CVEs** — update to the patched version (see
also `osv.md`):

```bash
npm update <affected-package>
```

**SSRF via redirect or fetch** — validate URLs before server-side fetching:

```ts
const ALLOWED_HOSTS = new Set(['api.trusted.com']);

async function safeFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Forbidden: ${parsed.hostname}`);
  }
  return fetch(url);
}
```

## Acceptance criteria

The finding must no longer fire on re-scan: `checkId: NUCLEI-<template-id>`
with the same fingerprint must be absent from the next `audit run` output.
Active-only findings (fuzzing templates) require `activeScan: true` on the
acceptance scan.

## Fixture

Live fixture: `benchmark/live-fixture/EXPECTED.json` (entries beginning with `NUCLEI-*`)
