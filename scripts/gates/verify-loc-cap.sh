#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-loc-cap.sh
#
# Invariant: per-layer lines-of-code caps must not grow past a hard cap
# without a deliberate, recorded decision (baseline entry or ADR reference
# in the commit body).
#
# Configuration (env vars, all optional):
#   LOC_CAP_RULES     Semicolon-separated rules: "<dir>:<soft>:<hard>".
#                     Default:
#                       server/services:1500:2500;server/routes:800:1500;
#                       client/src/pages:600:1200;client/src/components:400:800;
#                       shared:500:1000
#                     Rules whose <dir> does not exist are skipped silently.
#   LOC_CAP_BASELINE  Path to a baseline file listing grandfathered paths
#                     (one repo-relative path per line, `#` comments allowed).
#                     Default: scripts/gates/.baselines/loc-cap.txt
#   LOC_CAP_ADR_OVERRIDE  Set to "0" to disable the commit-body "ADR-" escape
#                     hatch (default enabled: a hard violation is downgraded
#                     to a warning when the HEAD commit body references an ADR).
#
# Exclusions (always): *.test.* files, __tests__/ dirs, node_modules,
#   *.generated.* files, files whose first line contains AUTO-GENERATED.
#
# Counting method: wc -l.
#
# Exit codes:
#   0 = pass
#   1 = hard-cap violation not covered by baseline (or by ADR override)
#   2 = soft-cap warnings only, or hard violations covered by baseline/ADR
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${LOC_CAP_ROOT:-$(pwd)}"
BASELINE_FILE="${LOC_CAP_BASELINE:-$ROOT_DIR/scripts/gates/.baselines/loc-cap.txt}"
RULES="${LOC_CAP_RULES:-server/services:1500:2500;server/routes:800:1500;client/src/pages:600:1200;client/src/components:400:800;shared:500:1000}"
ADR_OVERRIDE="${LOC_CAP_ADR_OVERRIDE:-1}"

echo "--- verify-loc-cap ---"

in_baseline() {
  local rel="$1"
  [ -f "$BASELINE_FILE" ] || return 1
  grep -v '^\s*#' "$BASELINE_FILE" 2>/dev/null | grep -qxF "$rel"
}

HARD_VIOLATIONS=0
HARD_BASELINED=0
SOFT_WARNINGS=0
FILES_SCANNED=0

IFS=';' read -ra RULE_ARR <<< "$RULES"
for rule in "${RULE_ARR[@]}"; do
  rule="$(echo "$rule" | tr -d '[:space:]')"
  [ -z "$rule" ] && continue
  dir="${rule%%:*}"
  rest="${rule#*:}"
  soft="${rest%%:*}"
  hard="${rest#*:}"
  abs_dir="$ROOT_DIR/$dir"
  [ -d "$abs_dir" ] || continue

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    rel="${file#"$ROOT_DIR"/}"
    rel="${rel//\\//}"
    case "$rel" in
      *.test.*|*/__tests__/*|*node_modules*|*.generated.*) continue ;;
    esac
    first_line="$(head -n 1 "$file" 2>/dev/null || true)"
    case "$first_line" in
      *AUTO-GENERATED*) continue ;;
    esac
    FILES_SCANNED=$((FILES_SCANNED + 1))
    lines=$(wc -l < "$file" | tr -d '[:space:]')
    if [ "$lines" -gt "$hard" ]; then
      if in_baseline "$rel"; then
        echo "  [warn] $rel: $lines lines exceeds hard cap $hard (baselined)"
        HARD_BASELINED=$((HARD_BASELINED + 1))
      else
        echo "  [FAIL] $rel: $lines lines exceeds hard cap $hard"
        echo "         Extract a helper or split by domain; add to baseline ($BASELINE_FILE) only with a recorded decision."
        HARD_VIOLATIONS=$((HARD_VIOLATIONS + 1))
      fi
    elif [ "$lines" -gt "$soft" ]; then
      echo "  [warn] $rel: $lines lines exceeds soft cap $soft (watch this file)"
      SOFT_WARNINGS=$((SOFT_WARNINGS + 1))
    fi
  done < <(find "$abs_dir" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)
done

echo "[GATE] loc-cap: scanned=$FILES_SCANNED hard=$HARD_VIOLATIONS baselined=$HARD_BASELINED soft=$SOFT_WARNINGS"

if [ "$HARD_VIOLATIONS" -gt 0 ]; then
  # ADR escape hatch: a deliberate architectural decision recorded in the
  # HEAD commit body downgrades new hard violations to a warning.
  if [ "$ADR_OVERRIDE" = "1" ]; then
    COMMIT_BODY="$(git -C "$ROOT_DIR" log -1 --pretty=%B 2>/dev/null || true)"
    if echo "$COMMIT_BODY" | grep -q "ADR-"; then
      echo "[GATE] loc-cap: ADR reference found in commit body — hard violations accepted as warning" >&2
      exit 2
    fi
  fi
  exit 1
fi
if [ "$SOFT_WARNINGS" -gt 0 ] || [ "$HARD_BASELINED" -gt 0 ]; then
  exit 2
fi
exit 0
