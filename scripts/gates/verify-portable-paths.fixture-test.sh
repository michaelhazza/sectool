#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fixture test for verify-portable-paths.sh — proves the gate CAN fail.
#
# Three assertions:
#   1. Known-bad path list  -> exit 1, and every violation class is named
#   2. Known-good path list -> exit 0
#   3. Empty path list      -> exit 1 (proof-of-life: zero-scan must not pass)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/verify-portable-paths.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BAD="$TMP_DIR/bad-paths.txt"
GOOD="$TMP_DIR/good-paths.txt"
EMPTY="$TMP_DIR/empty-paths.txt"

cat > "$BAD" <<'EOF'
tasks/review-logs/dual-review-log-slug-2026-08-01T21:14:58Z.md
docs/notes./readme.md
server/aux.ts
server/lib/Helper.ts
server/lib/helper.ts
EOF

cat > "$GOOD" <<'EOF'
tasks/review-logs/dual-review-log-slug-2026-08-01T21-14-58Z.md
server/lib/helper.ts
docs/readme.md
EOF

: > "$EMPTY"

fail() { echo "FIXTURE TEST FAILED: $1" >&2; exit 1; }

# 1. Known-bad list must fail and name every violation class.
set +e
BAD_OUT="$(bash "$GATE" --paths-file "$BAD" 2>&1)"
BAD_EXIT=$?
set -e
[ "$BAD_EXIT" -ne 0 ] || fail "known-bad list passed (exit 0) — gate cannot fail"
for class in invalid-character trailing-dot-space reserved-name case-collision; do
  echo "$BAD_OUT" | grep -q "$class:" || fail "known-bad list did not trigger '$class' (output: $BAD_OUT)"
done

# 2. Known-good list must pass.
bash "$GATE" --paths-file "$GOOD" > /dev/null \
  || fail "known-good list failed — gate is over-broad"

# 3. Empty list must fail (zero-scan proof-of-life).
set +e
bash "$GATE" --paths-file "$EMPTY" > /dev/null 2>&1
EMPTY_EXIT=$?
set -e
[ "$EMPTY_EXIT" -ne 0 ] || fail "empty path list passed — zero-scan proof-of-life is broken"

echo "[verify-portable-paths.fixture-test] all 3 assertions passed"
