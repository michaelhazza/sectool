---
name: dependency-upgrades
description: Use when bumping, adding, or removing packages — lockfile changes, npm audit findings, security advisories, install-script policy, peer-dependency conflicts, version overrides, or major-version migrations. Install success proves nothing; the failure arrives at build, test, or runtime.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## dependency-upgrades` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Dependency upgrades

A dependency bump is a contract change you didn't author. The install succeeding is the weakest possible signal — verify the contract, not the download.

## Before bumping

- Read the changelog/breaking-changes list before any major bump — never bump a major on version number alone. Enumerate which breaking items touch code this repo actually calls; "we don't use that API" is a grep, not a guess.
- Multi-major jumps (v2 → v5) go one major at a time, verifying at each step — each major's migration guide assumes you start from the previous one, and a combined jump makes the failing layer unattributable.
- Before adding a new package, check whether an existing dependency (or the platform) already covers it — every addition is a supply-chain and upgrade-treadmill cost.

## Install scripts and supply chain

- Dependency install scripts (postinstall etc.) are arbitrary code execution at install time — the primary supply-chain payload channel. Default them OFF and fail closed: bootstrap with scripts disabled, list which pending packages want to run scripts, read those scripts' source, approve the minimum set, and commit the policy so CI and every machine enforce the same allowlist.
- The per-manager enforcement mechanism is version-specific (npm `strict-allow-scripts`, pnpm `approve-builds`/`strictDepBuilds`, Yarn `enableScripts: false` + `dependenciesMeta.built`) — verify against the installed manager's docs before relying on it; a policy the manager silently ignores is worse than none.
- Determine the installation boundary first: the workspace root that owns the lockfile is where policy lives. Competing lockfiles in one tree (npm + pnpm, nested roots) = stop and resolve ownership before installing anything.
- New-dependency review includes the name itself: typosquats ride one-keystroke variants of popular packages; verify publisher, repo link, and download history before first install, and prefer provenance/signature-verified registries where available.

> Install-script gate adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `security-and-hardening` at commit `98967c4` (MIT licensed).

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
