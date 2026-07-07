#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-duplicate-blocks.sh
#
# Invariant: the count of duplicated code blocks (via jscpd) must not grow
# above the recorded baseline. Reductions are silent — re-seed the baseline
# when debt is paid down.
#
# Configuration (env vars, all optional):
#   DUPLICATE_BLOCKS_DIRS        Space-separated scan roots.
#                                Default: whichever of "server client shared src"
#                                exist. If none exist the gate fails
#                                (misconfigured gates must not pass silently).
#   DUPLICATE_BLOCKS_BASELINE    Baseline file containing a line
#                                `clone-count:<N>`. Missing file => baseline 0
#                                (strict: any clone fails until seeded).
#                                Default: scripts/gates/.baselines/duplicate-blocks.txt
#   DUPLICATE_BLOCKS_MIN_TOKENS  jscpd --min-tokens. Default: 15.
#
# External tool: jscpd, invoked via `npx jscpd`. Add it to the consuming
# repo's devDependencies (or rely on npx fetch in CI). Any jscpd failure is
# fail-closed: the gate exits 1 rather than pretending the count is 0.
#
# Exit codes: 0 = at or below baseline, 1 = regression or tool failure
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${DUPLICATE_BLOCKS_ROOT:-$(pwd)}"
BASELINE_FILE="${DUPLICATE_BLOCKS_BASELINE:-$ROOT_DIR/scripts/gates/.baselines/duplicate-blocks.txt}"
MIN_TOKENS="${DUPLICATE_BLOCKS_MIN_TOKENS:-15}"

echo "--- verify-duplicate-blocks ---"

if [ -n "${DUPLICATE_BLOCKS_DIRS:-}" ]; then
  DIRS="$DUPLICATE_BLOCKS_DIRS"
else
  DIRS=""
  for d in server client shared src; do
    [ -d "$ROOT_DIR/$d" ] && DIRS="$DIRS $d"
  done
  DIRS="$(echo "$DIRS" | sed 's/^ *//')"
fi

if [ -z "$DIRS" ]; then
  echo "[GATE] duplicate-blocks: no scan roots exist (set DUPLICATE_BLOCKS_DIRS) — misconfigured gate" >&2
  exit 1
fi

SCAN_PATHS=()
for d in $DIRS; do
  if [ -d "$ROOT_DIR/$d" ]; then
    SCAN_PATHS+=("$d/")
  fi
done
if [ "${#SCAN_PATHS[@]}" -eq 0 ]; then
  echo "[GATE] duplicate-blocks: none of the configured scan roots ($DIRS) exist — misconfigured gate" >&2
  exit 1
fi

JSCPD_REPORT_DIR=$(mktemp -d)
JSCPD_STDERR=$(mktemp)
cleanup() { rm -rf "$JSCPD_REPORT_DIR" "$JSCPD_STDERR"; }
trap cleanup EXIT

# jscpd exits 0 on success regardless of clone count (clones live in the JSON
# report). Non-zero exit means the tool itself broke — fail closed.
cd "$ROOT_DIR"
set +e
npx jscpd --min-tokens "$MIN_TOKENS" --reporters json --output "$JSCPD_REPORT_DIR" \
  "${SCAN_PATHS[@]}" >/dev/null 2> "$JSCPD_STDERR"
JSCPD_EXIT=$?
set -e

if [ "$JSCPD_EXIT" -ne 0 ]; then
  echo "[GATE] duplicate-blocks: jscpd failed (exit $JSCPD_EXIT) — gate cannot evaluate clone count" >&2
  cat "$JSCPD_STDERR" >&2
  exit 1
fi

REPORT_FILE="$JSCPD_REPORT_DIR/jscpd-report.json"
if [ ! -f "$REPORT_FILE" ]; then
  echo "[GATE] duplicate-blocks: jscpd succeeded but produced no report at $REPORT_FILE — fail closed" >&2
  exit 1
fi

# Resolve path for Node on Windows (cygpath if available).
REPORT_FILE_NODE="$REPORT_FILE"
if command -v cygpath >/dev/null 2>&1; then
  REPORT_FILE_NODE="$(cygpath -m "$REPORT_FILE")"
fi

CURRENT_COUNT=$(JSCPD_REPORT="$REPORT_FILE_NODE" node -e '
const { readFileSync } = require("node:fs");
try {
  const report = JSON.parse(readFileSync(process.env.JSCPD_REPORT, "utf8"));
  const clones = report?.statistics?.total?.clones;
  if (typeof clones !== "number") {
    process.stderr.write("jscpd report missing statistics.total.clones\n");
    process.exit(2);
  }
  process.stdout.write(String(clones));
} catch (e) {
  process.stderr.write("Failed to parse jscpd report: " + e.message + "\n");
  process.exit(2);
}
') || {
  echo "[GATE] duplicate-blocks: failed to parse jscpd report — fail closed" >&2
  exit 1
}

BASELINE_COUNT=0
if [ -f "$BASELINE_FILE" ]; then
  RAW=$(grep -E '^clone-count:[0-9]+$' "$BASELINE_FILE" | head -1 || true)
  if [ -n "$RAW" ]; then
    BASELINE_COUNT="${RAW#clone-count:}"
  fi
fi

echo "Duplicate blocks — current: $CURRENT_COUNT, baseline: $BASELINE_COUNT"
echo "[GATE] duplicate-blocks: violations=$CURRENT_COUNT"

if [ "$CURRENT_COUNT" -gt "$BASELINE_COUNT" ]; then
  echo "[FAIL] Regression: $CURRENT_COUNT clones exceeds baseline of $BASELINE_COUNT" >&2
  echo "       Deduplicate the new clone, or (deliberately) re-seed $BASELINE_FILE" >&2
  exit 1
fi

exit 0
