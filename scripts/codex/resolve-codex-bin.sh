#!/usr/bin/env bash
# resolve-codex-bin.sh — single implementation of the Codex binary-resolution
# rule in references/codex-invocation-contract.md § Binary resolution.
#
# WHY THIS EXISTS
# The contract has said "resolve the newer of PATH vs the npm global shim" since
# it was written, but every calling agent implemented
#   CODEX_BIN=$(command -v codex 2>/dev/null || echo "${CODEX_FALLBACK_PATH:-codex}")
# which is PATH-first with no version comparison at all. On the operator's
# reference machine that selects 0.138.0, which HARD-ERRORS against the
# account's provisioned model, while a working 0.144.3 sits in the npm global
# prefix. The rule was documented and unenforced: six agent files each carried
# the PATH-first snippet, so the prose was contradicted by every executable
# path that mattered. A rule that lives only in prose is not a rule.
#
# Prints the absolute path of the chosen binary on stdout and exits 0.
# Prints diagnostics on stderr. Fails closed (exit 1, no stdout) when no
# runnable Codex binary is found — never falls back to a bare `codex` that a
# caller would then invoke blindly.
#
# Usage:
#   CODEX_BIN=$(bash scripts/codex/resolve-codex-bin.sh) || { echo "no codex"; exit 1; }
#   CODEX_BIN=$(bash scripts/codex/resolve-codex-bin.sh --verbose)   # explain the choice
#
# Candidates considered, in no priority order (version decides, not order):
#   1. `command -v codex`                     — whatever PATH resolves
#   2. `npm prefix -g`/bin/codex              — the npm global shim
#   3. $CODEX_FALLBACK_PATH                   — an explicitly pinned second binary
#      (agent-context.md may pin this per project)
set -uo pipefail

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

log() { [ "$VERBOSE" -eq 1 ] && printf '%s\n' "$*" >&2 || true; }
note() { printf '%s\n' "$*" >&2; }

# Extracts a comparable version from `<bin> --version`. Codex prints e.g.
# "codex-cli 0.144.3"; take the first dotted-numeric token so the parse does
# not depend on the surrounding wording.
codex_version() {
  local bin="$1" out
  out=$("$bin" --version 2>/dev/null) || return 1
  printf '%s\n' "$out" | grep -oE '[0-9]+(\.[0-9]+)+' | head -1
}

# Pure integer comparison of dotted versions. Returns 0 if $1 > $2.
# Avoids `sort -V`, which is absent on some minimal images.
version_gt() {
  local a="$1" b="$2" ia ib i
  IFS='.' read -ra ia <<< "$a"
  IFS='.' read -ra ib <<< "$b"
  for ((i = 0; i < 4; i++)); do
    local x="${ia[i]:-0}" y="${ib[i]:-0}"
    x=$((10#${x:-0})); y=$((10#${y:-0}))
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 1
}

candidates=()

if path_bin=$(command -v codex 2>/dev/null); then
  candidates+=("$path_bin")
  log "candidate (PATH):            $path_bin"
fi

if npm_prefix=$(npm prefix -g 2>/dev/null); then
  for shim in "$npm_prefix/codex" "$npm_prefix/bin/codex"; do
    if [ -x "$shim" ] || [ -f "$shim" ]; then
      candidates+=("$shim")
      log "candidate (npm global shim): $shim"
    fi
  done
fi

if [ -n "${CODEX_FALLBACK_PATH:-}" ] && { [ -x "$CODEX_FALLBACK_PATH" ] || [ -f "$CODEX_FALLBACK_PATH" ]; }; then
  candidates+=("$CODEX_FALLBACK_PATH")
  log "candidate (CODEX_FALLBACK_PATH): $CODEX_FALLBACK_PATH"
fi

if [ "${#candidates[@]}" -eq 0 ]; then
  note "resolve-codex-bin: no Codex binary found (PATH, npm global prefix, CODEX_FALLBACK_PATH all empty)."
  note "                   Fail-closed: emitting nothing rather than a bare 'codex' a caller would invoke blindly."
  exit 1
fi

best_bin=""
best_ver=""
seen=""

for bin in "${candidates[@]}"; do
  # De-duplicate: PATH and the shim are frequently the same file.
  case ":$seen:" in *":$bin:"*) continue ;; esac
  seen="$seen:$bin"

  if ! ver=$(codex_version "$bin") || [ -z "$ver" ]; then
    note "resolve-codex-bin: '$bin' did not report a parseable version — skipping."
    continue
  fi
  log "  $bin -> $ver"

  if [ -z "$best_bin" ] || version_gt "$ver" "$best_ver"; then
    best_bin="$bin"
    best_ver="$ver"
  fi
done

if [ -z "$best_bin" ]; then
  note "resolve-codex-bin: found ${#candidates[@]} candidate(s) but none reported a runnable version."
  note "                   Fail-closed rather than guessing which is usable."
  exit 1
fi

# Surface the discarded-older case unconditionally: silently preferring a
# different binary than the caller's PATH is exactly the kind of invisible
# behaviour that made the original defect survive.
if [ "${#candidates[@]}" -gt 1 ] && [ "$best_bin" != "${candidates[0]}" ]; then
  note "resolve-codex-bin: using $best_bin ($best_ver) — NEWER than the PATH-resolved binary."
fi

log "chosen: $best_bin ($best_ver)"
printf '%s\n' "$best_bin"
