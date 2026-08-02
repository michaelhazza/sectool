#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-no-secrets.sh
#
# Invariant: no provider-shaped secret (AWS, GitHub, OpenAI/Anthropic, Stripe,
# Slack, Google, private-key blocks) appears in any tracked file. The scan
# logic lives in the framework-synced scripts/check-secrets.cjs (Node stdlib,
# unit-tested upstream in scripts/__tests__/check-secrets.test.ts); this
# wrapper adapts it to the gates contract and fails closed when the
# toolchain or the scanner is missing.
#
# Configuration (env vars, all optional):
#   SECRETS_ROOT       Repo root to scan — must contain scripts/check-secrets.cjs.
#                      Default: $(pwd).
#   SECRETS_ALLOWLIST  Exact-instance allowlist JSON: [{path, sha256, reason}].
#                      Glob paths, missing reasons, or missing fingerprints are
#                      config errors, and an entry that suppresses nothing
#                      FAILS the gate (stale). Missing file = empty allowlist
#                      (scanning always runs).
#                      Default: scripts/gates/.baselines/secrets-allowlist.json
#
# Layered posture: enable the hosting provider's secret scanning + push
# protection for git-history and future-push coverage; this gate covers the
# working tree on every CI run.
#
# Exit codes: 0 = clean, 1 = findings or stale allowlist entries,
#             2 = misconfiguration (fail closed). Treat any non-zero as red.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="${SECRETS_ROOT:-$(pwd)}"
ALLOWLIST="${SECRETS_ALLOWLIST:-scripts/gates/.baselines/secrets-allowlist.json}"

echo "--- verify-no-secrets ---"

if ! command -v node >/dev/null 2>&1; then
  echo "[GATE] no-secrets: node not found on PATH — fail closed" >&2
  exit 2
fi

SCANNER="$ROOT_DIR/scripts/check-secrets.cjs"
if [ ! -f "$SCANNER" ]; then
  echo "[GATE] no-secrets: $SCANNER missing (framework sync incomplete?) — fail closed" >&2
  exit 2
fi

cd "$ROOT_DIR"
CHECK_SECRETS_ALLOWLIST="$ALLOWLIST" node "$SCANNER"
