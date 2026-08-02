#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-portable-paths.sh
#
# Invariant: every tracked path must be checkout-able on Windows, macOS, and
# Linux. A single bad filename breaks `git pull` for every Windows clone of
# the repo — this happened on 2026-08-01 when a review log was committed from
# a Linux session with colons in its timestamp
# (dual-review-log-...-2026-08-01T21:14:58Z.md), blocking all Windows pulls
# until it was renamed via index plumbing.
#
# Checks, per tracked path:
#   1. invalid-character  — any of  < > : " \ | ? *  or control chars anywhere
#   2. trailing-dot-space — any path component ending in "." or " "
#   3. reserved-name      — any component whose extension-stripped name is a
#                           Windows reserved device (CON PRN AUX NUL COM1-9
#                           LPT1-9), case-insensitive
#   4. case-collision     — two tracked paths equal case-insensitively
#                           (breaks checkout on case-insensitive filesystems)
#
# Timestamps in filenames use hyphens between time fields (2026-08-01T21-14-58Z),
# never colons — see tasks/review-logs/README.md § Filename convention.
#
# Enumerates via `git ls-files -z` (NUL-delimited) so a path containing a
# newline cannot split into two innocent-looking lines. Proof-of-life: a scan
# that sees zero paths is itself a failure — an empty enumeration is a broken
# gate, not a clean tree.
#
# Fixture test: scripts/gates/verify-portable-paths.fixture-test.sh
#   (drives the --paths-file override with known-bad and known-good lists)
#
# Exit codes: 0 = clean, 1 = violations found or zero paths scanned
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PATHS_FILE=""
if [ "${1:-}" = "--paths-file" ]; then
  PATHS_FILE="${2:?--paths-file requires an argument}"
fi

check() {
  awk '
    BEGIN { RS = "\0"; bad = 0; total = 0 }
    length($0) == 0 { next }
    {
      total++
      path = $0
      if (path ~ /[<>:"\\|?*]/ || path ~ /[[:cntrl:]]/) {
        printf "  invalid-character:  %s\n", path; bad++
      }
      n = split(path, comp, "/")
      for (i = 1; i <= n; i++) {
        c = comp[i]
        if (c ~ /[. ]$/) {
          printf "  trailing-dot-space: %s  (component: \"%s\")\n", path, c; bad++
        }
        lc = tolower(c)
        sub(/\..*$/, "", lc)
        if (lc ~ /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/) {
          printf "  reserved-name:      %s  (component: \"%s\")\n", path, c; bad++
        }
      }
      lower = tolower(path)
      if (lower in first) {
        printf "  case-collision:     %s  <->  %s\n", path, first[lower]; bad++
      } else {
        first[lower] = path
      }
    }
    END {
      if (total == 0) {
        print "  gate-error: scanned zero paths — enumeration is broken, refusing to pass"
        exit 1
      }
      printf "[verify-portable-paths] scanned %d paths, %d violation(s)\n", total, bad
      exit bad > 0 ? 1 : 0
    }
  '
}

if [ -n "$PATHS_FILE" ]; then
  # Fixture mode: newline-delimited list converted to NUL-delimited.
  tr '\n' '\0' < "$PATHS_FILE" | check
else
  cd "$ROOT_DIR"
  git -c core.quotepath=off ls-files -z | check
fi
