# Generic verify-gates library

Portable CI gate scripts, generalised from a consuming repo's gate suite. Each gate is self-contained bash (plus Node stdlib where noted), configured via env vars with sensible defaults, and preserves a strict exit-code contract — every gate here CAN fail, and fails closed on tool errors or misconfiguration.

Before adding or modifying a gate, load the `ci-gate-integrity` skill (`.claude/skills/ci-gate-integrity/`): gates that cannot fail are the norm, not the exception, and that skill catalogues the ways a green gate lies.

## Gates

### verify-loc-cap.sh

Per-layer lines-of-code caps. Soft cap warns; hard cap fails unless the file is baselined or the HEAD commit body references an `ADR-` (deliberate decision escape hatch).

| Knob | Default | Meaning |
|---|---|---|
| `LOC_CAP_RULES` | `server/services:1500:2500;server/routes:800:1500;client/src/pages:600:1200;client/src/components:400:800;shared:500:1000` | Semicolon-separated `<dir>:<soft>:<hard>` rules; non-existent dirs skipped silently |
| `LOC_CAP_BASELINE` | `scripts/gates/.baselines/loc-cap.txt` | One repo-relative path per line; grandfathered hard-cap files |
| `LOC_CAP_ADR_OVERRIDE` | `1` | Set `0` to disable the commit-body ADR escape hatch |

Exit: `0` pass, `1` new hard violation, `2` soft warnings / baselined hard violations.

### verify-no-raw-console.sh

No raw `console.log/warn/error/debug/info` under the configured roots — use the project's structured logger. Grep-based (the origin used an AST helper; the trade-off is a rare false positive inside strings/comments, escaped via the per-file marker `// allowed-raw-console: <reason>`).

| Knob | Default | Meaning |
|---|---|---|
| `RAW_CONSOLE_DIRS` | `server` | Space-separated scan roots; if NONE exist the gate fails (misconfiguration) |
| `RAW_CONSOLE_ALLOWLIST` | `scripts/gates/.baselines/raw-console-allowlist.txt` | One repo-relative path per line (logger internals, bootstrap, legacy) |
| `RAW_CONSOLE_METHODS` | `log\|warn\|error\|debug\|info` | Pipe-separated method set |

Exit: `0` clean, `1` violations or no scan roots.

### verify-duplicate-blocks.sh

Duplicate-code-block ratchet via [jscpd](https://github.com/kucherenko/jscpd) (invoked with `npx jscpd` — add jscpd to the consuming repo's devDependencies). Current clone count must not exceed the recorded baseline; tool failures are fail-closed.

| Knob | Default | Meaning |
|---|---|---|
| `DUPLICATE_BLOCKS_DIRS` | whichever of `server client shared src` exist | Space-separated scan roots; none existing = fail |
| `DUPLICATE_BLOCKS_BASELINE` | `scripts/gates/.baselines/duplicate-blocks.txt` | File containing `clone-count:<N>`; missing file = baseline 0 |
| `DUPLICATE_BLOCKS_MIN_TOKENS` | `15` | jscpd `--min-tokens` |

Seed the baseline deliberately: run the gate once, then write `clone-count:<current>` to the baseline file. Re-seed downward as debt is paid.

Exit: `0` at/below baseline, `1` regression or tool failure.

### verify-no-orphan-react-component.sh

Flags React component files with zero ingress — not reachable through static or dynamic (`React.lazy`) imports from the routing entry file. Resolution is regex + tsconfig-paths based (Node stdlib; no ts-morph).

| Knob | Default | Meaning |
|---|---|---|
| `ORPHAN_ENTRY_FILE` | `client/src/App.tsx`, else `src/App.tsx` | Routing entry. Defaults missing = skip (exit 0); explicitly set but missing = fail |
| `ORPHAN_SOURCE_ROOT` | entry file's directory | Root walked for import resolution |
| `ORPHAN_COMPONENT_DIRS` | `<source-root>/pages <source-root>/components` | Dirs whose files must be reachable |
| `ORPHAN_ALLOWLIST` | `client/.orphan-allowlist.json` | `{ "files": [{ "path": "...", "reason": "..." }] }` |

The origin implementation also carried a git-history 7-day grace window for newly added files; that depended on repo-specific CI clone topology and is not ported — new orphans fail immediately (allowlist them while wiring is in flight).

Exit: `0` pass or not applicable, `1` orphans found / misconfigured.

### verify-protected-block-names.sh

Generic guard-wiring assertions: named grep patterns must be present in named files. Catches the "guard refactored away but everything still compiles" failure mode. Opt-in via config file.

| Knob | Default | Meaning |
|---|---|---|
| `PROTECTED_INVARIANTS_CONFIG` | `scripts/gates/protected-invariants.conf` | One assertion per line: `<description>\|<file>\|<grep -E pattern>` |

Config missing entirely = skip (exit 0, opt-in gate). Config present but empty, referenced file missing, or pattern absent = fail (exit 1).

### verify-no-secrets.sh

Provider-shaped secret sweep over tracked files (AWS, GitHub classic + fine-grained, OpenAI/Anthropic, Stripe secret/restricted, Slack, Google, private-key blocks). Thin wrapper over the framework-synced `scripts/check-secrets.cjs` (Node stdlib, unit-tested upstream in `scripts/__tests__/check-secrets.test.ts`); fails closed when Node or the scanner is missing. Deliberately provider-patterned rather than entropy-based — entropy scanners drown the signal in kebab-case-heavy repos. Findings print a redacted preview plus the sha256 fingerprint (never the token); copy the fingerprint into an allowlist entry to exempt a genuine placeholder.

| Knob | Default | Meaning |
|---|---|---|
| `SECRETS_ROOT` | `$(pwd)` | Repo root; must contain `scripts/check-secrets.cjs` |
| `SECRETS_ALLOWLIST` | `scripts/gates/.baselines/secrets-allowlist.json` | Exact-instance entries `[{path, sha256, reason}]`. Glob paths / missing reasons / missing fingerprints are config errors; an entry that suppresses nothing FAILS the gate (stale); missing file = empty allowlist (scanning always runs) |

Pair with the hosting provider's secret scanning + push protection (git history + future pushes); this gate covers the working tree on every run.

Exit: `0` clean, `1` findings or stale allowlist entries, `2` misconfiguration (fail closed — treat any non-zero as red).

### verify-factory-invocation.mjs

Flags FACTORY functions (functions that return a handler, e.g. `requireOrgPermission(key)`) registered without invocation — an Express-shaped router calls the bare factory itself as the handler at runtime, discards whatever handler it would have built, and `next()` is never reached. AST-based via the TypeScript compiler API (not a substring scan); the factory set is derived from source, never hand-maintained.

| Knob | Default | Meaning |
|---|---|---|
| `GATE_SOURCE_DIR` | `server/middleware` | Dir to derive factories from. Missing dir (default or override) is a misconfiguration — fail closed |
| `GATE_SCAN_DIR` | `server/routes` (+ `server/index.ts` when the default is in effect) | Dir to scan for bare-factory registrations. An explicit override scans only that dir, recursively, no extra file |
| `GATE_METHOD_SET` | `get,post,put,patch,delete,all,use,options,head` | Comma-separated registration method names |
| `VERIFY_FACTORY_INVOCATION_EXIT` | `2` (warning) | Set `1` to promote findings from warning to blocking — the soak-window promotion knob |

`typescript` is resolved dynamically from the consuming repo's node_modules at runtime; an unresolvable dependency fails closed with a named-dependency message rather than a raw module-not-found stack trace.

Exit: `0` clean, `2` violations (warning-first default — set `VERIFY_FACTORY_INVOCATION_EXIT=1` to promote to blocking), `1` internal/tool error, misconfiguration, or unresolvable `typescript` (fail closed).

### verify-duplicate-registrations.mjs

Flags duplicate registrations on the same method + path key in a downstream registry (an Express-shaped router is the common case) — the first mounted match serves the request and every later one becomes dead code that still looks live in source. AST-based via the TypeScript compiler API; paths are normalized (`:anyParamName` -> `:param`, trailing slash stripped) before grouping.

| Knob | Default | Meaning |
|---|---|---|
| `GATE_SCAN_DIR` | `server/routes` (+ `server/index.ts` when the default is in effect) | Dir to scan for registrations. An explicit override scans only that dir, recursively, no extra file |
| `GATE_METHOD_SET` | `get,post,put,patch,delete,all` | Comma-separated registration method names |
| `VERIFY_DUPLICATE_REGISTRATIONS_EXIT` | `2` (warning) | Set `1` to promote findings from warning to blocking — the soak-window promotion knob |

`typescript` is resolved dynamically from the consuming repo's node_modules at runtime, same as `verify-factory-invocation.mjs`; an unresolvable dependency fails closed with a named-dependency message. Suppress a specific finding with the house guard-ignore grammar, guard-id `duplicate-registrations`: `// guard-ignore: duplicate-registrations reason="..."` (same-line), `// guard-ignore-next-line: duplicate-registrations reason="..."` (next-line), or `// guard-ignore-file: duplicate-registrations reason="..."` (first line, file-wide).

Exit: `0` clean, `2` violations (warning-first default — set `VERIFY_DUPLICATE_REGISTRATIONS_EXIT=1` to promote to blocking), `1` internal/tool error, misconfiguration, or unresolvable `typescript` (fail closed).

### verify-portable-paths.sh

Every tracked path must be checkout-able on Windows, macOS, and Linux. One bad filename breaks `git pull` for every Windows clone (2026-08-01 incident: a review log with colons in its ISO timestamp blocked all Windows pulls until renamed via index plumbing). Checks per tracked path: invalid characters (`< > : " \ | ? *`, control chars), trailing dot/space components, reserved Windows device names (`CON PRN AUX NUL COM1-9 LPT1-9`), and case-collisions. Enumerates via `git ls-files -z` (newline-proof); a zero-path scan fails (proof-of-life). Runtime prevention lives in the `path-portability-guard.js` PreToolUse hook; this gate is the CI backstop for files created outside `Write` (bash redirects, generators).

| Knob | Default | Meaning |
|---|---|---|
| `--paths-file <file>` | unset | Newline-delimited path list override — fixture-test mode (`verify-portable-paths.fixture-test.sh`) |

Exit: `0` clean, `1` violations or zero paths scanned (fail closed).

## Guards for the guards

The directory holds **9 gates + 1 gate fixture test + 1 meta-validator + README**. The meta-validator and the fixture test are not counted gates.

### verify-gate-syntax.sh

Syntax-parses every script in `scripts/gates/` so a gate with a broken syntax cannot silently no-op in CI. Routing is a closed, enumerated set — the failure branch is reached only by a file that falls through this list, never by a file the author simply did not anticipate being non-script:

| Extension | Action |
|---|---|
| `.sh` | `bash -n` |
| `.mjs`, `.js`, `.cjs` | `node --check` |
| `.ts` | skipped, with a named reason printed (no TS parse path in a bash meta-validator without a toolchain dependency; the framework's own test run covers `.ts`) |
| `.md`, `.json`, `.txt`, extensionless | skipped via an explicit allowlist — non-script assets, never routed to the failure branch |
| anything else | fails — a genuinely unknown script-shaped file must not pass silently |

`scripts/gates/fixtures/` and `scripts/gates/.baselines/` are excluded by path inside the script's own walk (deliberately-malformed sample sources and repo-owned baseline data — neither is gate code).

| Knob | Default | Meaning |
|---|---|---|
| `GATE_SYNTAX_ROOT` | `$(pwd)` | Repo root; `scripts/gates/` is resolved beneath it |

Exit: `0` every parsed file is clean, `1` a parse failure, an unrecognised script-shaped extension, or a tool/config error (fail closed).

**Scope:** ships framework-side only. No `run-all-gates.sh` entry, shard-manifest registration, or CI step exists in any consumer repo yet — that wiring is a recorded open item, not part of this chunk.

## Wiring into consumer CI

Gates are **CI-only** — never run locally as a "quick sanity check" (see `references/test-gate-policy.md`; the finalisation G5 gate is the single sanctioned local exception). Typical GitHub Actions step:

```yaml
- name: Verify gates
  run: |
    bash scripts/gates/verify-loc-cap.sh
    bash scripts/gates/verify-no-raw-console.sh
    bash scripts/gates/verify-duplicate-blocks.sh
    bash scripts/gates/verify-no-orphan-react-component.sh
    bash scripts/gates/verify-protected-block-names.sh
    bash scripts/gates/verify-no-secrets.sh
```

Notes:

- Exit code `2` is a warning contract (loc-cap). Bash treats any non-zero exit as failure, so either accept warnings as CI failures, or wrap: `bash scripts/gates/verify-loc-cap.sh || [ $? -eq 2 ]`.
- Set env knobs per repo in the workflow step's `env:` block rather than editing the scripts — the scripts are framework-synced and local edits are overwritten (`references/local-override-convention.md`).
- Baselines and the protected-invariants config live in the consuming repo (they are repo state, not framework files). Create `scripts/gates/.baselines/` in the consumer as needed.
- Whenever a gate or its baseline changes, verify it can still fail: seed a bad fixture, run the gate, confirm exit 1 — per the `ci-gate-integrity` skill.
