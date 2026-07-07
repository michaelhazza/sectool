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
```

Notes:

- Exit code `2` is a warning contract (loc-cap). Bash treats any non-zero exit as failure, so either accept warnings as CI failures, or wrap: `bash scripts/gates/verify-loc-cap.sh || [ $? -eq 2 ]`.
- Set env knobs per repo in the workflow step's `env:` block rather than editing the scripts — the scripts are framework-synced and local edits are overwritten (`references/local-override-convention.md`).
- Baselines and the protected-invariants config live in the consuming repo (they are repo state, not framework files). Create `scripts/gates/.baselines/` in the consumer as needed.
- Whenever a gate or its baseline changes, verify it can still fail: seed a bad fixture, run the gate, confirm exit 1 — per the `ci-gate-integrity` skill.
