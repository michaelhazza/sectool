#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-no-raw-console.sh
#
# Invariant: files under the configured directories must not call raw
# console.log/warn/error/debug/info — use the project's structured logger.
#
# Configuration (env vars, all optional):
#   RAW_CONSOLE_DIRS       Space-separated scan roots. Default: "server".
#                          Roots that do not exist are skipped silently, but
#                          if NONE exist the gate fails (a gate that never
#                          scans anything cannot fail and must say so).
#   RAW_CONSOLE_ALLOWLIST  Path to an allowlist file: one repo-relative path
#                          per line, `#` comments allowed. Use it for logger
#                          internals, bootstrap files, and grandfathered
#                          legacy files. Default:
#                          scripts/gates/.baselines/raw-console-allowlist.txt
#   RAW_CONSOLE_METHODS    Pipe-separated method set.
#                          Default: "log|warn|error|debug|info"
#
# Per-file opt-out: a file containing the literal marker
#   // allowed-raw-console: <reason>
# anywhere is exempt (use for legitimate low-level bootstrap code).
#
# Always exempt: test files (*.test.ts, *.spec.ts, __tests__/), *.d.ts.
#
# Detection is grep-based (pattern `console.<method>(`). Unlike the AST-based
# origin implementation this can rarely false-positive inside string literals
# or comments; use the opt-out marker for those cases.
#
# Exit codes: 0 = clean, 1 = violations found (all listed) or no scan roots
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${RAW_CONSOLE_ROOT:-$(pwd)}"
DIRS="${RAW_CONSOLE_DIRS:-server}"
ALLOWLIST_FILE="${RAW_CONSOLE_ALLOWLIST:-$ROOT_DIR/scripts/gates/.baselines/raw-console-allowlist.txt}"
METHODS="${RAW_CONSOLE_METHODS:-log|warn|error|debug|info}"

echo "--- verify-no-raw-console ---"

in_allowlist() {
  local rel="$1"
  [ -f "$ALLOWLIST_FILE" ] || return 1
  grep -v '^\s*#' "$ALLOWLIST_FILE" 2>/dev/null | grep -qxF "$rel"
}

EXISTING_DIRS=()
for d in $DIRS; do
  [ -d "$ROOT_DIR/$d" ] && EXISTING_DIRS+=("$ROOT_DIR/$d")
done

if [ "${#EXISTING_DIRS[@]}" -eq 0 ]; then
  echo "[GATE] no-raw-console: none of the configured scan roots ($DIRS) exist — misconfigured gate" >&2
  exit 1
fi

VIOLATIONS=0

while IFS= read -r file; do
  [ -z "$file" ] && continue
  rel="${file#"$ROOT_DIR"/}"
  rel="${rel//\\//}"
  case "$rel" in
    *node_modules*|*/__tests__/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*.d.ts) continue ;;
  esac
  in_allowlist "$rel" && continue
  if grep -q "// allowed-raw-console:" "$file" 2>/dev/null; then
    continue
  fi
  hits=$(grep -nE "(^|[^.A-Za-z0-9_])console\.(${METHODS})\s*\(" "$file" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while IFS= read -r hit; do
      lineno="${hit%%:*}"
      echo "  [FAIL] ${rel}:${lineno}: raw console call — use the project's structured logger"
      VIOLATIONS=$((VIOLATIONS + 1))
    done <<< "$hits"
  fi
done < <(find "${EXISTING_DIRS[@]}" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)

echo "[GATE] no-raw-console: violations=$VIOLATIONS"

if [ "$VIOLATIONS" -gt 0 ]; then
  exit 1
fi
exit 0
