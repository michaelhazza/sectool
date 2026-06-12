#!/usr/bin/env bash
set -euo pipefail

# g5-scoped.sh — diff-scoped pre-merge verification (finalisation-coordinator Step 8c, G5-scoped mode)
#
# FRAMEWORK TEMPLATE (adopt-only). On adoption this file becomes consumer-owned:
# pin your project's escape-hatch list and gate-mapping table in the CONFIG
# section below. The engine below the CONFIG section is generic — keep edits
# inside CONFIG so future framework template improvements stay easy to diff in.
#
# What it does:
#   1. Computes the changed-file set vs the base ref (branch commits + uncommitted).
#   2. REFUSES and demands full G5 (exit 3) when the diff touches aggregate/global
#      surfaces where subset runs are blind (escape hatch), or when a merge commit
#      from main brought such changes into the branch.
#   3. Otherwise runs: full lint + typecheck (always), the test runner's
#      related-files selection per suite, and only the gates whose trigger
#      surface the diff touches (declarative path-glob mapping table).
#   4. Prints (and, when G5_SLUG is set, appends to tasks/builds/$G5_SLUG/progress.md)
#      the mode-recording line required by Step 8c.2.
#
# The labeled CI run remains the system of record. This script only decides what
# is worth running locally BEFORE the ready-to-merge label.
#
# Env:
#   G5_BASE_REF   base ref for the diff (default: origin/main)
#   G5_SLUG       build slug; when set, the mode line is appended to
#                 tasks/builds/$G5_SLUG/progress.md
#
# Exit codes:
#   0  scoped run green
#   1  a selected check failed
#   3  escape hatch tripped — run full G5 instead (this script did not verify anything)

# ──────────────────────────────────────────────────────────────────────────────
# CONFIG — pin your project's lists here (consumer-owned after adoption)
# ──────────────────────────────────────────────────────────────────────────────

# File extensions the test runner can trace through its import graph.
SOURCE_EXT_REGEX='\.(ts|tsx|js|jsx|mjs|cjs)$'

# Escape hatch: bash regexes (matched against repo-relative paths). A diff that
# touches ANY of these falls back to full G5. Keep the generic entries; add your
# project's shared registry files (single-source-of-truth files whose
# consistency is checked repo-wide, e.g. an RLS-protected-tables registry, an
# error-code union, a schema barrel index, an orphan allowlist).
ESCAPE_PATTERNS=(
  '^migrations/'
  '(^|/)package\.json$'
  '(^|/)package-lock\.json$'
  'baseline'
  '(^|/)vitest\.config\.'
  '^\.github/workflows/'
  # '^path/to/your/registry\.ts$'
)

# Gate mapping: "path-glob|command" entries. The glob is a bash [[ == ]] pattern
# matched against repo-relative paths (* crosses directory separators). Every
# command whose glob matches at least one changed file runs exactly once.
# Lint and typecheck are NOT listed here — they always run in full.
GATE_MAP=(
  # self-check: this script must at least parse when it changes
  "scripts/g5-scoped.sh|bash -n scripts/g5-scoped.sh"
  # "server/db/schema/*|bash scripts/verify-rls.sh"
  # "server/jobs/*|bash scripts/verify-job-payload-schema.sh"
  # "client/src/*|bash scripts/verify-no-orphan-react-component.sh"
)

# DB-backed gates: same format, but these run only when DATABASE_URL is set
# (point it at a throwaway test DB, never at a dev database). `npm run migrate`
# runs once before the first DB-backed command. When DATABASE_URL is unset,
# matched entries are reported as G5-residual and skipped.
DB_GATE_MAP=(
  # "server/routes/*|npx tsx scripts/verify-workspace-actor-coverage.ts"
)

# Shard manifest (optional): if your CI runs part of the gate battery through a
# shard runner that sets a baseline env and treats exit 2 as WARNING / exit 3 as
# INFO (non-blocking), point this at the manifest file listing those gates and
# set the env the shard runner exports. Gates listed there get the same
# semantics here; gates NOT listed run strictly (any non-zero fails), mirroring
# direct CI job steps. Leave SHARD_MANIFEST empty to treat every gate strictly.
SHARD_MANIFEST=""
SHARD_GATE_ENV=""

# Strictest-runner-wins override: a gate that appears as a DIRECT step in any
# workflow file under this directory is strict on CI (the CI runner fails the
# step on any non-zero exit), even if the gate is also listed in the shard
# manifest. Prevents a dual-listed gate from silently inheriting warning
# semantics. Leave empty to disable the check.
CI_WORKFLOW_DIR=".github/workflows"

# Always-run commands for the scoped set (cheap, cross-file).
ALWAYS_CMDS=(
  "npm run lint"
  "npm run typecheck"
)

# Test suites. Each runs
#   <env-prefix> npx vitest related --run --passWithNoTests <changed source files> <suite-args>
# *_SUITE_ARGS are extra runner args appended to the related-run (word-split),
# e.g. "--hookTimeout=60000" for slow machines. When DATABASE_URL is set,
# `npm run migrate` runs once (ensure_migrated) before the first DB-backed leg —
# do NOT also list it in INTEGRATION_SETUP_CMDS.
UNIT_SUITE_ENV=""                 # e.g. "" — runner config defaults apply
UNIT_SUITE_ARGS=""
INTEGRATION_SUITE_ENV=""          # e.g. "NODE_ENV=integration" — leave empty to disable the leg
INTEGRATION_SUITE_ARGS=""
INTEGRATION_NEEDS_DB=1            # 1 = skip with a G5-residual line when DATABASE_URL is unset
INTEGRATION_SETUP_CMDS=()         # e.g. ("npx tsx scripts/seed-integration-fixtures.ts")

# ──────────────────────────────────────────────────────────────────────────────
# ENGINE — generic; avoid project-specific edits below this line
# ──────────────────────────────────────────────────────────────────────────────

BASE_REF="${G5_BASE_REF:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

say() { printf '%s\n' "$*"; }
hr()  { say "── $* ──"; }

record_mode() {
  local line="$1"
  say ""
  say "$line"
  if [ -n "${G5_SLUG:-}" ] && [ -f "tasks/builds/${G5_SLUG}/progress.md" ]; then
    printf '%s\n' "$line" >> "tasks/builds/${G5_SLUG}/progress.md"
    say "(recorded in tasks/builds/${G5_SLUG}/progress.md)"
  fi
}

# Residual contract (Step 8c.3): checks that cannot run locally are recorded in
# progress.md, not just printed — they are the only checks allowed to run first on CI.
record_residual() {
  local line="G5-residual: $1 — $2"
  say "$line"
  if [ -n "${G5_SLUG:-}" ] && [ -f "tasks/builds/${G5_SLUG}/progress.md" ]; then
    printf '%s\n' "$line" >> "tasks/builds/${G5_SLUG}/progress.md"
  fi
}

# 1. Changed-file set: branch commits since merge-base + uncommitted (tracked) + untracked.
CHANGED=()
while IFS= read -r f; do [ -n "$f" ] && CHANGED+=("$f"); done < <(
  {
    git diff --name-only --no-renames --diff-filter=ACMRD "${BASE_REF}...HEAD" --
    git diff --name-only --no-renames --diff-filter=ACMRD HEAD --
    git ls-files --others --exclude-standard
  } | sort -u
)
# Deletions are deliberately included (--diff-filter=...D, --no-renames): deleting
# a migration, baseline, workflow, or registry file must trip the escape hatch,
# and deleting a mapped source path must still trigger its surface gates. The
# [ -f ] guard below keeps deleted paths out of the related-test set only.

if [ "${#CHANGED[@]}" -eq 0 ]; then
  say "No changed files vs ${BASE_REF} — nothing to scope. Run lint/typecheck directly if needed."
  record_mode "G5 mode: scoped (0 test files, 0 gates)"
  exit 0
fi

say "Changed files vs ${BASE_REF} (${#CHANGED[@]}):"
printf '  %s\n' "${CHANGED[@]}"

# 2. Escape hatch — direct diff.
for f in "${CHANGED[@]}"; do
  for pat in "${ESCAPE_PATTERNS[@]}"; do
    if [[ "$f" =~ $pat ]]; then
      record_mode "G5 mode: full (reason: escape-hatch — ${f} matches '${pat}')"
      say "REFUSING scoped mode: subset runs are blind to aggregate-state failures on this surface."
      say "Run the FULL G5 parity set (finalisation-coordinator Step 8c.3, full mode)."
      exit 3
    fi
  done
done

# 2b. Escape hatch — merge commits from main that themselves touched escape surfaces.
while IFS= read -r merge; do
  [ -n "$merge" ] || continue
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    for pat in "${ESCAPE_PATTERNS[@]}"; do
      if [[ "$f" =~ $pat ]]; then
        record_mode "G5 mode: full (reason: escape-hatch — merge commit ${merge:0:9} brought in ${f} matching '${pat}')"
        say "REFUSING scoped mode: a merge from main changed aggregate state under this branch."
        say "Run the FULL G5 parity set (finalisation-coordinator Step 8c.3, full mode)."
        exit 3
      fi
    done
  done < <(git diff --name-only "${merge}^1" "${merge}" -- 2>/dev/null)
done < <(git rev-list --merges "${BASE_REF}..HEAD" 2>/dev/null)

# 3. Source files for related-test selection.
SOURCES=()
for f in "${CHANGED[@]}"; do
  [[ "$f" =~ $SOURCE_EXT_REGEX ]] && [ -f "$f" ] && SOURCES+=("$f")
done

FAILURES=0
WARNINGS=0
MIGRATED=0
run_cmd() {
  local label="$1"; shift
  hr "$label"
  say "\$ $*"
  if bash -c "$*"; then
    say "[PASS] $label"
  else
    say "[FAIL] $label"
    FAILURES=$((FAILURES + 1))
  fi
}

# Gate runner with CI-parity exit semantics: gates listed in SHARD_MANIFEST run
# with SHARD_GATE_ENV and treat exit 2 as WARNING / exit 3 as INFO (mirrors a
# shard-style CI runner); all other gates are strict (any non-zero fails,
# mirrors direct CI job steps).
run_gate_cmd() {
  local cmd="$1" gate_path="" w shard=0 code=0
  for w in $cmd; do case "$w" in scripts/*) gate_path="$w"; break ;; esac; done
  if [ -n "$SHARD_MANIFEST" ] && [ -n "$gate_path" ] && [ -f "$SHARD_MANIFEST" ] \
     && grep -q "\"$gate_path\"" "$SHARD_MANIFEST"; then
    shard=1
  fi
  # Strictest wins: direct workflow steps are strict on CI even if shard-listed.
  if [ "$shard" -eq 1 ] && [ -n "${CI_WORKFLOW_DIR:-}" ] && [ -d "$CI_WORKFLOW_DIR" ] \
     && grep -rq "$gate_path" "$CI_WORKFLOW_DIR"; then
    shard=0
  fi
  hr "gate: $cmd"
  if [ "$shard" -eq 1 ]; then
    say "\$ ${SHARD_GATE_ENV} $cmd   (shard gate: exit 2 = warning, exit 3 = info)"
    bash -c "${SHARD_GATE_ENV} $cmd" || code=$?
  else
    say "\$ $cmd"
    bash -c "$cmd" || code=$?
  fi
  if [ "$code" -eq 0 ]; then
    say "[PASS] gate: $cmd"
  elif [ "$shard" -eq 1 ] && [ "$code" -eq 2 ]; then
    say "[WARN] gate: $cmd (non-blocking — CI shard semantics)"
    WARNINGS=$((WARNINGS + 1))
  elif [ "$shard" -eq 1 ] && [ "$code" -eq 3 ]; then
    say "[INFO] gate: $cmd (informational)"
  else
    say "[FAIL] gate: $cmd"
    FAILURES=$((FAILURES + 1))
  fi
}

# 4. Always-run commands (full lint + typecheck).
for cmd in "${ALWAYS_CMDS[@]}"; do
  run_cmd "$cmd" "$cmd"
done

# CI-parity DB setup: every DB-backed CI job (unit, integration, DB gates) runs
# `npm run migrate` first. Mirror that exactly once, and only when a test DB is
# actually configured.
ensure_migrated() {
  if [ -n "${DATABASE_URL:-}" ] && [ "$MIGRATED" -eq 0 ]; then
    run_cmd "npm run migrate (CI-parity DB setup)" "npm run migrate"
    MIGRATED=1
  fi
}

# 5. Related tests per suite.
TEST_FILE_COUNT=0
run_related_suite() {
  local label="$1" env_prefix="$2" suite_args="${3:-}"
  if [ "${#SOURCES[@]}" -eq 0 ]; then
    say "[SKIP] $label — no traceable source files in the diff"
    return 0
  fi
  hr "$label (vitest related, ${#SOURCES[@]} changed source files)"
  local out code=0
  local cmd=(npx vitest related --run --passWithNoTests "${SOURCES[@]}")
  if [ -n "$suite_args" ]; then
    # shellcheck disable=SC2206 — deliberate word-splitting of operator-pinned args
    cmd+=($suite_args)
  fi
  say "\$ ${env_prefix:+$env_prefix }${cmd[*]}"
  if [ -n "$env_prefix" ]; then
    out="$(env $env_prefix "${cmd[@]}" 2>&1)" || code=$?
  else
    out="$("${cmd[@]}" 2>&1)" || code=$?
  fi
  printf '%s\n' "$out"
  local n
  # Prefer the parenthesised total ("Test Files 1 failed | 2 passed (3)" → 3);
  # fall back to the first integer for older reporter formats.
  n="$(printf '%s\n' "$out" | sed -n 's/.*Test Files.*(\([0-9][0-9]*\)).*/\1/p' | tail -1)"
  [ -n "$n" ] || n="$(printf '%s\n' "$out" | sed -n 's/.*Test Files[^0-9]*\([0-9][0-9]*\).*/\1/p' | tail -1)"
  TEST_FILE_COUNT=$((TEST_FILE_COUNT + ${n:-0}))
  if [ "$code" -eq 0 ]; then say "[PASS] $label"; else say "[FAIL] $label"; FAILURES=$((FAILURES + 1)); fi
}

if [ -z "${DATABASE_URL:-}" ]; then
  say "note: DATABASE_URL unset — if the related selection includes DB-backed unit tests, they will fail to connect. Set DATABASE_URL to the throwaway test DB, or record such failures as G5-residual."
fi
ensure_migrated   # CI's unit job migrates before the unit suite; mirror when a DB is configured
run_related_suite "unit tests (related)" "$UNIT_SUITE_ENV" "$UNIT_SUITE_ARGS"

if [ -n "$INTEGRATION_SUITE_ENV" ]; then
  if [ "$INTEGRATION_NEEDS_DB" -eq 1 ] && [ -z "${DATABASE_URL:-}" ]; then
    record_residual "integration tests (related)" "no DATABASE_URL (no local test DB)"
  else
    ensure_migrated
    for setup in "${INTEGRATION_SETUP_CMDS[@]}"; do
      run_cmd "integration setup: $setup" "$setup"
    done
    run_related_suite "integration tests (related)" "$INTEGRATION_SUITE_ENV" "$INTEGRATION_SUITE_ARGS"
  fi
fi

# 6. Mapped gates (dedup by command, first-match order).
GATES_TO_RUN=()
collect_gates() {
  local entry glob cmd f seen
  for entry in "$@"; do
    glob="${entry%%|*}"; cmd="${entry#*|}"
    for f in "${CHANGED[@]}"; do
      # shellcheck disable=SC2053
      if [[ "$f" == $glob ]]; then
        seen=0
        local g
        for g in "${GATES_TO_RUN[@]:-}"; do [ "$g" = "$cmd" ] && seen=1 && break; done
        [ "$seen" -eq 0 ] && GATES_TO_RUN+=("$cmd")
        break
      fi
    done
  done
}
collect_gates "${GATE_MAP[@]:-}"

GATE_COUNT=0
for cmd in "${GATES_TO_RUN[@]:-}"; do
  [ -n "$cmd" ] || continue
  GATE_COUNT=$((GATE_COUNT + 1))
  run_gate_cmd "$cmd"
done

# 6b. DB-backed gates.
GATES_TO_RUN=()
collect_gates "${DB_GATE_MAP[@]:-}"
MIGRATED=0
for cmd in "${GATES_TO_RUN[@]:-}"; do
  [ -n "$cmd" ] || continue
  if [ -z "${DATABASE_URL:-}" ]; then
    record_residual "${cmd}" "no DATABASE_URL (no local test DB)"
    continue
  fi
  ensure_migrated
  GATE_COUNT=$((GATE_COUNT + 1))
  run_gate_cmd "$cmd"
done

# 7. Verdict + mode recording.
record_mode "G5 mode: scoped (${TEST_FILE_COUNT} test files, ${GATE_COUNT} gates)"
if [ "$WARNINGS" -gt 0 ]; then
  say "G5-scoped: ${WARNINGS} gate warning(s) (non-blocking — same as CI shard semantics)."
fi
if [ "$FAILURES" -gt 0 ]; then
  say "G5-scoped: ${FAILURES} check(s) FAILED."
  exit 1
fi
say "G5-scoped: green."
exit 0
