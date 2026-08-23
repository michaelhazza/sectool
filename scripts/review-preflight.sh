#!/usr/bin/env bash
# review-preflight.sh — review-tier transport preflight (spec §6 C3).
#
# Answers ONE question before a coordinator commits to a review path: are the
# transports the review will need actually reachable RIGHT NOW? Without this, a
# missing Codex binary or a capped OpenAI org surfaces halfway through a
# pipeline, after the work that assumed it.
#
# COMPOSES the existing helpers rather than reimplementing them, so the probe
# exercises the same code the real reviewers use:
#   - scripts/codex/resolve-codex-bin.sh   (the version-selection rule)
#   - scripts/verify-chatgpt-model.ts      (the real Responses API path)
# The only new probe logic is the Codex auth/exec check.
#
# CAPABILITIES ARE TRANSPORTS, NOT REVIEW TIERS (round-4 finding 1):
#   codex       — the Codex CLI (spec-reviewer, plan-reviewer, dual-reviewer, verify-phase)
#   openai-api  — the OpenAI Responses API (chatgpt-* reviews in automated/parallel
#                 mode ONLY; a manual ChatGPT-web review never touches it)
# So `--require` is built by the CALLER after it resolves task class AND review
# mode. Requiring openai-api in manual mode would manufacture a gap.
#
# OUTPUT (stdout, machine-readable, one line):
#   REVIEW TIER PREFLIGHT: codex=PASS|FAIL|UNAVAILABLE|SKIPPED openai-api=...
# Deliberately NOT the literal string REVIEW_GAP — that is a reserved artifact
# and must never be parseable out of a preflight as an actual skipped review.
#
# EXIT CODE: 0 whenever the preflight RAN and produced a well-formed block —
# including when probes fail. Non-zero only on internal error. Callers treat a
# non-zero exit and an exit-0-with-unparseable-block IDENTICALLY: UNAVAILABLE
# for every required tier (a crashed preflight must not be softer than a failed
# probe). Mapping + actions: scripts/review-preflightPure.ts.
#
# Usage:
#   bash scripts/review-preflight.sh --require codex
#   bash scripts/review-preflight.sh --require codex,openai-api
#
# Guarantees are TIME-BOUNDED, not token-claimed: callResponsesApi sets no
# max_output_tokens, so a "~1 token" promise would be unenforceable. Each probe
# gets a wall-clock ceiling instead.
#
# Test seams (all optional, documented):
#   REVIEW_PREFLIGHT_CODEX_RESOLVER  path to the resolver script
#   REVIEW_PREFLIGHT_CODEX_BIN       skip resolution, use this binary
#   REVIEW_PREFLIGHT_OPENAI_CMD      executable replacing the OpenAI probe
#   REVIEW_PREFLIGHT_TIMEOUT         per-probe seconds (default 45)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_RESOLVER="${REVIEW_PREFLIGHT_CODEX_RESOLVER:-$HERE/codex/resolve-codex-bin.sh}"
OPENAI_PROBE_TS="$HERE/verify-chatgpt-model.ts"
PROBE_TIMEOUT="${REVIEW_PREFLIGHT_TIMEOUT:-45}"

REQUIRED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --require) REQUIRED="${2:-}"; shift 2;;
    --require=*) REQUIRED="${1#*=}"; shift;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0;;
    *) printf 'review-preflight: unknown argument %s\n' "$1" >&2; exit 2;;
  esac
done

is_required() {
  case ",${REQUIRED}," in *",$1,"*) return 0;; *) return 1;; esac
}

# Run a command under a wall-clock ceiling when `timeout` exists; plain otherwise.
bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout "$PROBE_TIMEOUT" "$@"; else "$@"; fi
}

# Remediation goes STRAIGHT to stderr: the probes below run inside command
# substitution, so anything accumulated in a variable would die with the
# subshell. stdout stays reserved for the single machine-readable block.
note_remediation() { printf 'review-preflight: %s\n' "$1" >&2; }

# ── codex probe ─────────────────────────────────────────────────────────────
# UNAVAILABLE = no usable binary at all. FAIL = binary present but the
# transport is not usable (not logged in, sandboxed exec fails).
probe_codex() {
  if ! is_required codex; then printf 'SKIPPED'; return; fi

  local bin=""
  if [ -n "${REVIEW_PREFLIGHT_CODEX_BIN:-}" ]; then
    bin="$REVIEW_PREFLIGHT_CODEX_BIN"
  elif [ -x "$CODEX_RESOLVER" ] || [ -f "$CODEX_RESOLVER" ]; then
    bin="$(bash "$CODEX_RESOLVER" 2>/dev/null)" || bin=""
  fi
  if [ -z "$bin" ]; then
    note_remediation "codex: no usable Codex binary. Install/repair the CLI, then re-check with: bash scripts/codex/resolve-codex-bin.sh --verbose"
    printf 'UNAVAILABLE'; return
  fi
  if ! command -v "$bin" >/dev/null 2>&1 && [ ! -x "$bin" ] && [ ! -f "$bin" ]; then
    note_remediation "codex: resolved binary '$bin' is not executable."
    printf 'UNAVAILABLE'; return
  fi

  # Auth: `codex login status` is cheap and does not consume model budget.
  if ! bounded "$bin" login status >/dev/null 2>&1; then
    note_remediation "codex: not authenticated. Run: $bin login"
    printf 'FAIL'; return
  fi

  # Exec: a harmless bounded prompt through the SAME sandbox every Codex path
  # uses. references/codex-invocation-contract.md makes `-s read-only`
  # mandatory and forbids any unsandboxed fallback — a health probe has no
  # authority to write to the checkout, so there is no fallback here either.
  if ! bounded "$bin" exec -s read-only "reply with the single word: ok" >/dev/null 2>&1; then
    note_remediation "codex: sandboxed exec probe failed (model/quota/sandbox). Re-check with: $bin exec -s read-only 'reply with the single word: ok'"
    printf 'FAIL'; return
  fi
  printf 'PASS'
}

# ── openai-api probe ────────────────────────────────────────────────────────
# Required ONLY when the resolved review mode is automated|parallel.
probe_openai() {
  if ! is_required openai-api; then printf 'SKIPPED'; return; fi

  if [ -z "${OPENAI_API_KEY:-}" ]; then
    note_remediation "openai-api: OPENAI_API_KEY is not set (load .env: set -a; . ./.env; set +a). Manual ChatGPT-web review does not need it."
    printf 'UNAVAILABLE'; return
  fi

  local out rc
  if [ -n "${REVIEW_PREFLIGHT_OPENAI_CMD:-}" ]; then
    out="$(bounded "$REVIEW_PREFLIGHT_OPENAI_CMD" 2>&1)"; rc=$?
  elif [ -f "$OPENAI_PROBE_TS" ]; then
    out="$(bounded npx tsx "$OPENAI_PROBE_TS" 2>&1)"; rc=$?
  else
    note_remediation "openai-api: probe script missing at $OPENAI_PROBE_TS"
    printf 'UNAVAILABLE'; return
  fi

  if [ "$rc" -eq 0 ]; then printf 'PASS'; return; fi

  # A capped organisation is the case that must never pass silently (S5).
  if printf '%s' "$out" | grep -qi 'organization_spend_limit_exceeded\|spend limit'; then
    note_remediation "openai-api: organisation spend limit exceeded — automated/parallel review cannot run until the cap is raised; the manual ChatGPT-web path is unaffected."
  elif printf '%s' "$out" | grep -qi 'invalid_api_key\|incorrect api key\|401'; then
    note_remediation "openai-api: key rejected (401). Rotate OPENAI_API_KEY."
  else
    note_remediation "openai-api: probe failed (exit $rc). Re-check with: npx tsx scripts/verify-chatgpt-model.ts"
  fi
  printf 'FAIL'
}

CODEX_STATUS="$(probe_codex)"
OPENAI_STATUS="$(probe_openai)"

printf 'REVIEW TIER PREFLIGHT: codex=%s openai-api=%s\n' "$CODEX_STATUS" "$OPENAI_STATUS"

# The preflight ran and produced a well-formed block: exit 0 even when probes
# failed. Probe results are DATA for the caller, not this script's verdict.
exit 0
