---
name: dependency-upgrades
description: Use when bumping, adding, or removing packages — lockfile changes, npm audit findings, security advisories, peer-dependency conflicts, version overrides, or major-version migrations. Install success proves nothing; the failure arrives at build, test, or runtime.
---

# Dependency upgrades

A dependency bump is a contract change you didn't author. The install succeeding is the weakest possible signal — verify the contract, not the download.

## Before bumping

- Read the changelog/breaking-changes list before any major bump — never bump a major on version number alone. Enumerate which breaking items touch code this repo actually calls; "we don't use that API" is a grep, not a guess.
- Multi-major jumps (v2 → v5) go one major at a time, verifying at each step — each major's migration guide assumes you start from the previous one, and a combined jump makes the failing layer unattributable.
- Before adding a new package, check whether an existing dependency (or the platform) already covers it — every addition is a supply-chain and upgrade-treadmill cost.

## Overrides, pins, and peer ranges

- An override/resolution must stay inside every dependent's declared peer/semver range — forcing a version outside a dependent's range breaks that package's contract silently; the dependent was never tested against it. Check each affected dependent's declared range before overriding.
- Security overrides pin EXACT versions, not ranges — a range override re-floats on the next install and the advisory re-opens.
- Transitive-pin hygiene: every override carries a comment naming the advisory/bug and a removal condition (upstream release that makes it obsolete); sweep overrides on every direct-dependency bump — stale pins hold back fixed transitive versions indefinitely.

## Lockfile discipline

- One logical change per lockfile diff: never mix a security bump with a feature-dependency addition — an unreviewable 5,000-line lockfile diff hides the one malicious or breaking entry.
- Never hand-edit a lockfile. Regenerate via the package manager; a hand-edited integrity hash or resolved URL survives until the next full install, then breaks someone else's machine.
- Lockfile and manifest move in the same commit — a manifest bump without the regenerated lockfile means CI installs the old version while local runs the new one.
- CI caches key on the lockfile hash, not the manifest — a manifest-keyed cache serves stale transitive trees after a lockfile-only change (see the ci-gate-integrity skill for cache-key rules).

## Verify after

- "Installs cleanly" is not done: run the app's BUILD and its TEST SUITE after every bump — type errors, ESM/CJS boundary breaks, and runtime API removals all pass `npm install`.
- Codemod-after-bump for API renames: when the changelog names a renamed/removed API, grep the OLD API repo-wide (including tests, scripts, config files) and migrate every hit in the same commit — a partial migration compiles when the old name still exists as a deprecated alias, then breaks on the next major.
- After a bump that changes emitted output shape (serialisation, error classes, default options), re-run the tests that pin those shapes — and if none exist, that's the missing test to write first.

## Audits and advisories

- Never run `npm audit fix --force` blind — it applies MAJOR bumps to make the audit green, trading a known advisory for unknown breaking changes. Triage each advisory: is the vulnerable path reachable from this codebase, and what is the minimal version move that clears it?
- An advisory in a dev-only or unreachable transitive path is triaged and documented, not force-fixed — record the reasoning where the next audit run will find it.
- Peer-dep conflict resolution order: prefer moving the direct dependency to a compatible version; overrides are the last resort, never the first (`--legacy-peer-deps` in CI institutionalises the conflict instead of resolving it).
