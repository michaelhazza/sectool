#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-protected-block-names.sh
#
# Generic "guard wiring" gate: asserts that named guard patterns are present
# in named files. Use it to pin any invariant of the form "handler X must
# import/check/return Y" — the failure mode it catches is a guard that was
# refactored away, or a handler added without the guard, while everything
# still compiles.
#
# (The origin implementation asserted one project's protected-memory-block
# guards; the file/pattern pairs were project-specific, so here they live in
# a config file the consuming repo owns.)
#
# Configuration:
#   PROTECTED_INVARIANTS_CONFIG  Path to the invariants config file.
#                                Default: scripts/gates/protected-invariants.conf
#
# Config file format — one assertion per line, pipe-separated:
#   <description>|<repo-relative-file>|<grep -E pattern>
# Blank lines and lines starting with '#' are ignored. Example:
#
#   POST create guards protected names|server/routes/blocks.ts|PROTECTED_NAMES\.has\(name\)
#   shared allowlist is exported|server/lib/protected.ts|export const PROTECTED_NAMES
#
# Behaviour:
#   - Config file missing entirely  -> "not configured" note, exit 0
#     (the gate is opt-in; wire it by creating the config).
#   - Config file present but empty / no valid lines -> exit 1 (a configured
#     gate that checks nothing is a misconfiguration, fail closed).
#   - Referenced file missing OR pattern absent -> exit 1.
#
# Exit codes: 0 = all assertions pass (or gate not configured),
#             1 = any assertion fails or config is present-but-empty
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${PROTECTED_INVARIANTS_ROOT:-$(pwd)}"
CONFIG_FILE="${PROTECTED_INVARIANTS_CONFIG:-$ROOT_DIR/scripts/gates/protected-invariants.conf}"

echo "--- verify-protected-block-names ---"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[GATE] protected-block-names: not configured (no $CONFIG_FILE) — skipping"
  exit 0
fi

FAIL=0
CHECKS=0

while IFS='|' read -r description file pattern; do
  # Skip comments and blank lines
  case "$description" in
    ''|'#'*) continue ;;
  esac
  if [ -z "${file:-}" ] || [ -z "${pattern:-}" ]; then
    echo "  [FAIL] malformed config line (need description|file|pattern): $description"
    FAIL=1
    continue
  fi
  CHECKS=$((CHECKS + 1))
  if [ ! -f "$ROOT_DIR/$file" ]; then
    echo "  [FAIL] $description"
    echo "         File missing: $file"
    FAIL=1
    continue
  fi
  if grep -qE "$pattern" "$ROOT_DIR/$file" 2>/dev/null; then
    echo "  [pass] $description"
  else
    echo "  [FAIL] $description"
    echo "         Expected pattern: $pattern"
    echo "         In file:          $file"
    FAIL=1
  fi
done < "$CONFIG_FILE"

if [ "$CHECKS" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
  echo "[GATE] protected-block-names: config present but contains no assertions — misconfigured gate" >&2
  exit 1
fi

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo "[BLOCKING FAIL] One or more protected-invariant assertions failed."
  echo "[GATE] protected-block-names: violations=1"
  exit 1
fi

echo "[PASS] All $CHECKS protected-invariant assertions passed."
echo "[GATE] protected-block-names: violations=0"
exit 0
