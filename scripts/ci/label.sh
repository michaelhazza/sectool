#!/usr/bin/env bash
# label.sh — ready-to-merge label state machine (framework primitive, spec §5 B1).
#
# The `ready-to-merge` label is the merge lock: the expensive CI suites are gated
# on it and re-run on every push while it is present. The label-pull discipline
# is "label off → push → label back on when green". This helper mechanises the
# audit + parity + crash-recovery around that discipline so the coordinator prose
# does not have to.
#
# Subcommands:
#   apply   --pr N [--slug S]              (initial ready-to-merge add; runs the
#           authoritative-check resolver fence first; fails closed without a
#           configured ci_workflow — see resolve_ci_workflow)
#   pull    --pr N --reason <pre-push|failed-check> [--slug S]
#           [--run-id ID --check NAME --class <integration|static>]
#   restore --pr N [--slug S]
#   parity  --pr N --class <integration|static|pre-push> --status <green|red>
#           [--cmd "..."]                 (producers record parity evidence)
#   refile  --pr N --slug S               (stamp a SLUG_UNRESOLVED record)
#   reconcile --pr N                      (finish any crashed intent/mutated op)
#
# Journal + lock live under $(git rev-parse --git-dir)/ci-label/ — untracked and
# per-worktree by construction. Records are versioned (v:1), JSONL, one line each.
# Restore fails CLOSED without three-way SHA agreement (local HEAD == PR head ==
# journal parity sha) AND a class match, unless HITL-overridden.
#
# Repo-agnostic by design (spec cross-repo contract): keys ONLY on the label
# state via `gh`, never on a repo-specific workflow filename or command. The
# add-path resolver fence needs a workflow identity and the trigger a push is
# expected to fire, but BOTH are READ FROM CONSUMER CONFIG
# (`.claude/project-registries.json` -> `ci_workflow_files.ci_workflow` and
# `.ci_workflow_trigger`) and passed as explicit parameters — never hardcoded
# here, never guessed, and never inferred from how long a fence has waited.
#
# EVERY label ADD runs the fence, or does not happen: `apply` and `restore` both
# fail closed when either key is missing. restore's parity + three-way-SHA gate
# answers a different question ("is this the expected code?") and is not a
# substitute for "is a run about to be raced by this add?".
#
# Test seam: GH_BIN overrides the `gh` binary (the fake-gh Vitest suite sets it);
# LABEL_HITL_OVERRIDE=<token> supplies the HITL restore override.

set -uo pipefail

READY_LABEL="ready-to-merge"
GH="${GH_BIN:-gh}"
STATE_VERSION=1

# The authoritative-check resolver owns CI run-identity (W4). Every label ADD
# (apply + restore) runs it as a read-only registration/quiet fence FIRST, so a
# label add never lands over a phantom cancelled run or a still-live newer run.
# RESOLVER_BIN overrides the module (the fake-gh Vitest suite sets it).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLVER="${RESOLVER_BIN:-$SCRIPT_DIR/resolve-authoritative-checks.mjs}"
# Consumer registry that carries the CI workflow identity (same home as
# runner_live). NEVER defaulted — a shared primitive must not bake in `ci.yml`.
PROJECT_REGISTRIES="${PROJECT_REGISTRIES_FILE:-.claude/project-registries.json}"

# ── typed outcomes (printed as `OUTCOME: <name>`; exit 0 unless GH/usage error) ─
emit() { printf 'OUTCOME: %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2"; }
die_usage() { printf 'ERROR: %s\n' "$1" >&2; exit 2; }

# ── git-dir-scoped journal + lock ──────────────────────────────────────────────
gitdir() { git rev-parse --absolute-git-dir 2>/dev/null || { printf '%s/.git' "$(pwd)"; }; }
CI_LABEL_DIR="$(gitdir)/ci-label"
JOURNAL="$CI_LABEL_DIR/journal.jsonl"
LOCK="$CI_LABEL_DIR/lock"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

ensure_dir() { mkdir -p "$CI_LABEL_DIR"; }

# ── op.lock (pid + iso; stale iff holder pid dead) ─────────────────────────────
acquire_lock() {
  ensure_dir
  local waited=0
  while ! ( set -o noclobber; printf '{"pid":%s,"at":"%s"}' "$$" "$(now_iso)" > "$LOCK" ) 2>/dev/null; do
    local holder_pid
    holder_pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$LOCK" 2>/dev/null)"
    if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -f "$LOCK"; printf 'reclaimed stale lock (dead pid %s)\n' "$holder_pid" >&2; continue
    fi
    waited=$((waited+1)); [ "$waited" -gt 50 ] && { printf 'ERROR: lock busy\n' >&2; return 1; }
    sleep 0.1
  done
  return 0
}
release_lock() { rm -f "$LOCK"; }

# ── journal helpers ────────────────────────────────────────────────────────────
next_seq() {
  [ -f "$JOURNAL" ] || { printf '1'; return; }
  local max; max="$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$JOURNAL" | sort -n | tail -1)"
  printf '%s' "$(( ${max:-0} + 1 ))"
}
append_journal() { ensure_dir; printf '%s\n' "$1" >> "$JOURNAL"; sync 2>/dev/null || true; }

# JSON string escaper (bounded, single-line values only — input is validated).
jstr() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# ── input validation ───────────────────────────────────────────────────────────
validate_numeric() { case "$1" in ''|*[!0-9]*) die_usage "$2 must be numeric: '$1'";; esac; }
validate_singleline() {
  case "$1" in *$'\n'*) die_usage "$2 must be single-line";; esac
  [ "${#1}" -le 200 ] || die_usage "$2 too long"
}
validate_slug() {
  # path-containment: resolved tasks/builds/<slug> must stay under tasks/builds/
  case "$1" in */*|*..*) die_usage "slug must be a bare directory name: '$1'";; esac
  validate_singleline "$1" "slug"
}

# ── shared slug resolver (ONE rule; helper + hook both rely on it) ─────────────
# (1) unique tasks/builds/*/status.json whose branch/PR matches; (2) exact
# tasks/builds/<branch-name>/ match; (3) SLUG_UNRESOLVED (mutation still proceeds).
resolve_slug() {
  local pr="$1" branch matches n
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -d tasks/builds ]; then
    matches="$(grep -l "\"pr\": *$pr\b\|\"branch\": *\"$branch\"" tasks/builds/*/status.json 2>/dev/null || true)"
    n="$(printf '%s\n' "$matches" | grep -c . || true)"
    if [ "$n" = "1" ]; then basename "$(dirname "$matches")"; return 0; fi
    if [ -n "$branch" ] && [ -d "tasks/builds/$branch" ]; then printf '%s' "$branch"; return 0; fi
  fi
  return 1
}

# ── gh wrappers (redact output; fail-soft classification) ─────────────────────
pr_head_sha() { "$GH" pr view "$1" --json headRefOid --jq .headRefOid 2>/dev/null; }
pr_has_label() {
  local out; out="$("$GH" pr view "$1" --json labels --jq '.labels[].name' 2>/dev/null)" || return 2
  printf '%s\n' "$out" | grep -qx "$READY_LABEL"
}
label_remove() { "$GH" pr edit "$1" --remove-label "$READY_LABEL" >/dev/null 2>&1; }
label_add() { "$GH" pr edit "$1" --add-label "$READY_LABEL" >/dev/null 2>&1; }
pr_exists() { "$GH" pr view "$1" --json number >/dev/null 2>&1; }

# ── fence configuration (ONE owner: the resolver) ──────────────────────────────
# Validates the declared fence config and echoes it, WITHOUT contacting GitHub,
# so a caller can fail closed before taking a lock or mutating anything. The
# reading and the declared-trigger → behaviour mapping live in the resolver
# (`--print-config` / `--configured`); this script never re-derives them.
#
# WHY (external review rounds 3-5): every round produced the same defect class —
# each caller reconstructing event identity slightly differently (a hardcoded
# class, a raw event name compared against a normalised one, a `none` narrowed to
# `push` that hid live dispatch runs). One owner, many callers.
#
# Sets FENCE_WORKFLOW for journaling. Returns non-zero with the resolver's own
# remediation on stdout when either key is missing.
FENCE_WORKFLOW=""
fence_config() {
  local out
  # Diagnostics go to STDERR: the caller's stdout carries the OUTCOME contract,
  # and a config remediation is an error report, not an outcome.
  out="$(node "$RESOLVER" --print-config 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
  FENCE_WORKFLOW="$(printf '%s' "$out" | sed -n 's/.*workflow=\([^ ]*\).*/\1/p' | head -1)"
  [ -n "$FENCE_WORKFLOW" ] || { printf '%s\n' "$out" >&2; return 1; }
  return 0
}

# Bounded registration fence for a pushed head SHA on the configured workflow.
#
# Two DIFFERENT questions, answered by DECLARED configuration, never by a clock:
#
#  trigger=none  -> a push fires no run of this workflow, so there is nothing to
#                   race: an empty run list is a real NO_RUN (safe). A run that
#                   exists ANYWAY (a re-run, a workflow_dispatch) still blocks —
#                   the resolver uses its wildcard class for `none`, so no live
#                   or failed run is filtered out by event. (Round 5: this
#                   property was CLAIMED here while the code narrowed `none` to
#                   the push class, which silently hid exactly those runs.)
#  trigger=push| -> a run IS expected for this SHA, so an empty list is
#  pull_request     WAIT/registration=pending (never NO_RUN), and the fence
#                   POLLS with backoff until the run registers and decides.
#
# The declared trigger is translated by the RESOLVER (--configured), never here.
#
# FAIL CLOSED AT THE DEADLINE (external review round 3). A registration timeout
# is NOT proof that no run is coming — the earlier version returned "safe" on a
# persistent registration=pending, which is exactly the slow-registration tail of
# the race this fence exists to close. When a run is expected and none has
# registered before the window expires, the answer is BLOCKED, never APPLIED.
#   PASS (exit 0)                  -> safe to add
#   FAILURE/CANCELLED (21/22)      -> a real run gates it; do NOT add
#   WAIT at the deadline           -> BLOCKED (live run, or never registered)
# Attempts/sleep are env-configurable (CI_LABEL_FENCE_ATTEMPTS / _SLEEP) so tests
# run instantly and operators can tune the real registration window.
CI_LABEL_FENCE_ATTEMPTS="${CI_LABEL_FENCE_ATTEMPTS:-12}"
CI_LABEL_FENCE_SLEEP="${CI_LABEL_FENCE_SLEEP:-5}"

run_resolver() {
  local pr="$1" head="$2" attempt=1 out code
  while : ; do
    # --configured: the RESOLVER reads ci_workflow + ci_workflow_trigger and
    # derives the class and whether a run is expected. This script does not
    # translate the declared trigger at all — every round of caller-side
    # reconstruction produced a defect (a hardcoded class, a raw event name, a
    # `none` narrowed to `push` that hid live dispatch runs).
    out="$(node "$RESOLVER" --pr "$pr" --commit "$head" --configured 2>&1)"
    code=$?
    printf '%s\n' "$out"
    case "$code" in
      0) return 0 ;;            # PASS / NO_RUN(when none expected) — safe
      21|22) return 1 ;;        # FAILURE / CANCELLED — a real run gates it
      20)                       # WAIT — registration pending, or a run in flight
        if [ "$attempt" -ge "$CI_LABEL_FENCE_ATTEMPTS" ]; then
          # NB: the declared trigger is reported by the resolver's own `config`
          # line above — this script holds no copy of it (round 5: it must not
          # re-derive event identity, and under `set -u` referencing a variable
          # it no longer owns killed the fence mid-report).
          printf 'fence deadline reached after %s attempt(s) — a run was expected and has not resolved; refusing the add\n' "$attempt"
          return 1              # FAIL CLOSED — a timeout proves nothing
        fi
        attempt=$((attempt + 1)); sleep "$CI_LABEL_FENCE_SLEEP" ;;
      *) return 1 ;;            # unexpected -> fail safe (do NOT add)
    esac
  done
}

# restore's fence FAILS CLOSED, exactly like apply's (external review round 3).
# It previously skipped the resolver entirely when ci_workflow was unconfigured
# ("best-effort on config"), which left one label-ADD path outside the mechanism
# this build exists to install. The parity + three-way-SHA gate answers a
# DIFFERENT question ("am I restoring the label onto the expected code?"); it
# says nothing about whether a registering or live run is about to be raced by
# this add. Every label ADD runs the fence, or does not happen.
restore_fence() {
  local pr="$1" head="$2"
  fence_config || return 1
  run_resolver "$pr" "$head" || return 1
  return 0
}

# ── pull ───────────────────────────────────────────────────────────────────────
cmd_pull() {
  local pr="" reason="" slug="" run_id="" check="" class=""
  while [ $# -gt 0 ]; do case "$1" in
    --pr) pr="$2"; shift 2;; --reason) reason="$2"; shift 2;; --slug) slug="$2"; shift 2;;
    --run-id) run_id="$2"; shift 2;; --check) check="$2"; shift 2;; --class) class="$2"; shift 2;;
    *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"
  case "$reason" in pre-push|failed-check) ;; *) die_usage "--reason must be pre-push|failed-check";; esac
  if [ "$reason" = "failed-check" ]; then
    [ -n "$run_id" ] && [ -n "$check" ] && [ -n "$class" ] || die_usage "--run-id --check --class required with --reason failed-check"
    validate_numeric "$run_id" "--run-id"; validate_singleline "$check" "--check"
    case "$class" in integration|static) ;; *) die_usage "--class must be integration|static (caller maps check→class via its KNOWN-CHECK table; unknown → CLASS_UNRESOLVED, not passed here)";; esac
  fi
  [ -n "$slug" ] && validate_slug "$slug"

  acquire_lock || { emit GH_ERROR "lock busy"; return 0; }
  trap release_lock EXIT

  pr_exists "$pr" || { emit NO_OPEN_PR; return 0; }
  reconcile_crashed "$pr"

  # slug resolution (helper owns it; SLUG_UNRESOLVED still mutates)
  local slug_val="null" slug_out=""
  if [ -n "$slug" ]; then slug_val="\"$(jstr "$slug")\""
  elif slug_out="$(resolve_slug "$pr")"; then slug_val="\"$(jstr "$slug_out")\""; fi

  local head; head="$(pr_head_sha "$pr")" || { emit GH_ERROR; return 0; }
  if ! pr_has_label "$pr"; then
    local rc=$?; [ "$rc" = "2" ] && { emit GH_ERROR; return 0; }
    emit ALREADY_ABSENT; return 0
  fi

  local seq; seq="$(next_seq)"
  # durable intent BEFORE the mutation (crash recovery reconciles against live label)
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"intent","op":"pull","pr":%s,"reason":"%s","class":"%s","check":"%s","runId":"%s","headSha":"%s","slug":%s,"at":"%s"}' \
    "$STATE_VERSION" "$seq" "$pr" "$reason" "${class:-}" "$(jstr "${check:-}")" "${run_id:-}" "$head" "$slug_val" "$(now_iso)")"

  label_remove "$pr" || { emit GH_ERROR "label remove failed"; return 0; }
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"mutated","op":"pull","pr":%s,"headSha":"%s","at":"%s"}' "$STATE_VERSION" "$seq" "$pr" "$head" "$(now_iso)")"
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"audited","op":"pull","pr":%s,"reason":"%s","class":"%s","headSha":"%s","slug":%s,"at":"%s"}' \
    "$STATE_VERSION" "$seq" "$pr" "$reason" "${class:-}" "$head" "$slug_val" "$(now_iso)")"

  [ "$slug_val" = "null" ] && emit SLUG_UNRESOLVED "label pulled; journal seq $seq carries slug:null — run: bash scripts/ci/label.sh refile --pr $pr --slug <slug>" || emit PULLED "seq $seq (reason=$reason class=${class:-n/a})"
}

# ── apply (initial ready-to-merge add; there is no pull to restore against) ────
# Flow: verify PR/head identity -> resolver registration/quiet fence -> durable
# journal intent -> add the label -> durable mutation/audit record. Workflow
# identity is REQUIRED consumer config (ci_workflow_files.ci_workflow): apply
# fails CLOSED when it is absent (never defaulting a shared primitive to ci.yml).
#
# EXIT CODE (fail-loud, so Step 10.3's "failure pauses finalisation" is mechanical
# and does not depend on the caller parsing stdout): 0 ONLY for APPLIED or the
# idempotent ALREADY_PRESENT; NON-ZERO for every non-progress outcome
# (RESOLVER_BLOCKED, NO_OPEN_PR, GH_ERROR). die_usage already exits non-zero for
# missing config / bad flags. The OUTCOME line still names the specific state.
cmd_apply() {
  local pr="" slug=""
  while [ $# -gt 0 ]; do case "$1" in --pr) pr="$2"; shift 2;; --slug) slug="$2"; shift 2;; *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"
  [ -n "$slug" ] && validate_slug "$slug"

  # Fail CLOSED on missing/invalid fence config BEFORE any lock/mutation/network.
  local workflow
  fence_config || die_usage "fence config invalid in $PROJECT_REGISTRIES (see the remediation above); the label-add fence is never run against a defaulted or guessed workflow/trigger"
  workflow="$FENCE_WORKFLOW"

  acquire_lock || { emit GH_ERROR "lock busy"; return 2; }
  trap release_lock EXIT

  pr_exists "$pr" || { emit NO_OPEN_PR; return 3; }
  reconcile_crashed "$pr"

  local head; head="$(pr_head_sha "$pr")" || { emit GH_ERROR; return 2; }

  # Resolver fence runs BEFORE the idempotent-success shortcut, so
  # ALREADY_PRESENT means "the label is present AND this head is fenced clean",
  # not merely "a label exists" (external review round 3). ci-push-guard is
  # deliberately fail-open, so an external push or a skipped hook can leave the
  # label sitting over a NEW SHA; reporting success there without looking at the
  # new SHA's runs is the same blind spot in a different place.
  run_resolver "$pr" "$head" || { emit RESOLVER_BLOCKED "resolver fence declined the add for pr $pr at head $head (see OUTCOME above)"; return 4; }

  if pr_has_label "$pr"; then emit ALREADY_PRESENT "label already on pr $pr; head $head fenced clean"; return 0; fi

  # slug resolution (helper owns it; SLUG_UNRESOLVED still mutates)
  local slug_val="null" slug_out=""
  if [ -n "$slug" ]; then slug_val="\"$(jstr "$slug")\""
  elif slug_out="$(resolve_slug "$pr")"; then slug_val="\"$(jstr "$slug_out")\""; fi

  local seq; seq="$(next_seq)"
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"intent","op":"apply","pr":%s,"workflow":"%s","headSha":"%s","slug":%s,"at":"%s"}' \
    "$STATE_VERSION" "$seq" "$pr" "$(jstr "$workflow")" "$head" "$slug_val" "$(now_iso)")"

  label_add "$pr" || { emit GH_ERROR "label add failed"; return 2; }
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"mutated","op":"apply","pr":%s,"headSha":"%s","at":"%s"}' "$STATE_VERSION" "$seq" "$pr" "$head" "$(now_iso)")"
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"audited","op":"apply","pr":%s,"workflow":"%s","headSha":"%s","slug":%s,"at":"%s"}' \
    "$STATE_VERSION" "$seq" "$pr" "$(jstr "$workflow")" "$head" "$slug_val" "$(now_iso)")"

  emit APPLIED "seq $seq (workflow=$workflow)"
}

# ── restore (fails closed on three-way SHA agreement + class match) ────────────
cmd_restore() {
  local pr="" slug=""
  while [ $# -gt 0 ]; do case "$1" in --pr) pr="$2"; shift 2;; --slug) slug="$2"; shift 2;; *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"

  acquire_lock || { emit GH_ERROR "lock busy"; return 0; }
  trap release_lock EXIT

  pr_exists "$pr" || { emit NO_OPEN_PR; return 0; }
  reconcile_crashed "$pr"

  if pr_has_label "$pr"; then emit ALREADY_PRESENT; return 0; fi

  # The most recent pull (audited, not yet restored) sets the class to satisfy.
  local pull_rec pull_seq pull_class
  pull_rec="$(grep '"type":"audited","op":"pull"' "$JOURNAL" 2>/dev/null | grep "\"pr\":$pr," | tail -1)"
  [ -n "$pull_rec" ] || { emit NO_PARITY_EVIDENCE "no recorded pull to restore"; return 0; }
  pull_seq="$(printf '%s' "$pull_rec" | sed -n 's/.*"seq":\([0-9]*\).*/\1/p')"
  pull_class="$(printf '%s' "$pull_rec" | sed -n 's/.*"class":"\([^"]*\)".*/\1/p')"
  # a pre-push pull carries no class; its restore requires pre-push-class parity.
  local reason; reason="$(printf '%s' "$pull_rec" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')"
  [ "$reason" = "pre-push" ] && pull_class="pre-push"

  local local_head remote_head
  local_head="$(git rev-parse HEAD 2>/dev/null)"

  # HITL override short-circuits the ENTIRE fail-closed gate (missing parity AND
  # SHA mismatch) — a human is vouching for parity the machine could not prove.
  if [ -n "${LABEL_HITL_OVERRIDE:-}" ]; then
    restore_fence "$pr" "$local_head" || { emit RESOLVER_BLOCKED "resolver fence declined the add for pr $pr (see OUTCOME above)"; return 4; }
    append_journal "$(printf '{"v":%s,"seq":%s,"type":"restored","op":"restore","pr":%s,"headSha":"%s","hitl":"%s","at":"%s"}' "$STATE_VERSION" "$pull_seq" "$pr" "$local_head" "$(jstr "$LABEL_HITL_OVERRIDE")" "$(now_iso)")"
    label_add "$pr" || { emit GH_ERROR; return 2; }
    emit RESTORED "HITL override"; return 0
  fi

  # newest parity record with the matching class for the current head SHA
  local parity_rec parity_sha parity_status
  remote_head="$(pr_head_sha "$pr")" || { emit GH_ERROR; return 0; }
  parity_rec="$(grep '"type":"parity"' "$JOURNAL" 2>/dev/null | grep "\"pr\":$pr," | grep "\"class\":\"$pull_class\"" | tail -1)"
  if [ -z "$parity_rec" ]; then emit NO_PARITY_EVIDENCE "no $pull_class parity record for pr $pr"; return 0; fi
  parity_sha="$(printf '%s' "$parity_rec" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"
  parity_status="$(printf '%s' "$parity_rec" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
  [ "$parity_status" = "green" ] || { emit NO_PARITY_EVIDENCE "latest $pull_class parity is not green"; return 0; }
  if [ "$local_head" != "$remote_head" ] || [ "$local_head" != "$parity_sha" ]; then
    emit SHA_MISMATCH "local=$local_head remote=$remote_head parity=$parity_sha (need all three equal; HITL override via LABEL_HITL_OVERRIDE)"; return 0
  fi

  restore_fence "$pr" "$local_head" || { emit RESOLVER_BLOCKED "resolver fence declined the add for pr $pr (see OUTCOME above)"; return 4; }
  label_add "$pr" || { emit GH_ERROR; return 2; }
  append_journal "$(printf '{"v":%s,"seq":%s,"type":"restored","op":"restore","pr":%s,"headSha":"%s","class":"%s","at":"%s"}' "$STATE_VERSION" "$pull_seq" "$pr" "$local_head" "$pull_class" "$(now_iso)")"
  emit RESTORED "class=$pull_class sha=$local_head"
}

# ── parity (producers record evidence for the current head SHA) ────────────────
cmd_parity() {
  local pr="" class="" status="" cmd=""
  while [ $# -gt 0 ]; do case "$1" in --pr) pr="$2"; shift 2;; --class) class="$2"; shift 2;; --status) status="$2"; shift 2;; --cmd) cmd="$2"; shift 2;; *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"
  case "$class" in integration|static|pre-push) ;; *) die_usage "--class must be integration|static|pre-push";; esac
  case "$status" in green|red) ;; *) die_usage "--status must be green|red";; esac
  [ -n "$cmd" ] && validate_singleline "$cmd" "--cmd"
  local sha; sha="$(git rev-parse HEAD 2>/dev/null)"
  acquire_lock || { emit GH_ERROR "lock busy"; return 0; }
  trap release_lock EXIT
  append_journal "$(printf '{"v":%s,"type":"parity","pr":%s,"sha":"%s","class":"%s","status":"%s","cmd":"%s","at":"%s"}' "$STATE_VERSION" "$pr" "$sha" "$class" "$status" "$(jstr "${cmd:-}")" "$(now_iso)")"
  emit PARITY_RECORDED "class=$class status=$status sha=$sha"
}

# ── refile (stamp slug onto a SLUG_UNRESOLVED pull for close-out routing) ──────
cmd_refile() {
  local pr="" slug=""
  while [ $# -gt 0 ]; do case "$1" in --pr) pr="$2"; shift 2;; --slug) slug="$2"; shift 2;; *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"
  [ -n "$slug" ] || die_usage "--slug required"; validate_slug "$slug"
  acquire_lock || { emit GH_ERROR "lock busy"; return 0; }
  trap release_lock EXIT
  append_journal "$(printf '{"v":%s,"type":"refile","pr":%s,"slug":"%s","at":"%s"}' "$STATE_VERSION" "$pr" "$(jstr "$slug")" "$(now_iso)")"
  emit REFILED "slug=$slug"
}

# ── crash recovery: finish an unfinished intent/mutated for this PR ─────────────
reconcile_crashed() {
  local pr="$1"
  [ -f "$JOURNAL" ] || return 0
  # An intent/mutated whose seq has no matching audited is a crashed op.
  local last_intent seq
  last_intent="$(grep '"type":"intent"' "$JOURNAL" | grep "\"pr\":$pr," | tail -1)"
  [ -n "$last_intent" ] || return 0
  seq="$(printf '%s' "$last_intent" | sed -n 's/.*"seq":\([0-9]*\).*/\1/p')"
  if ! grep -q "\"seq\":$seq,\"type\":\"audited\"" "$JOURNAL" && ! grep -q "\"type\":\"audited\".*\"seq\":$seq" "$JOURNAL"; then
    # complete the audit exactly once, reconciling against the live label state.
    local head; head="$(pr_head_sha "$pr")"
    append_journal "$(printf '{"v":%s,"seq":%s,"type":"audited","op":"pull","pr":%s,"headSha":"%s","recovered":true,"at":"%s"}' "$STATE_VERSION" "$seq" "$pr" "${head:-unknown}" "$(now_iso)")"
    printf 'OUTCOME: RECOVERED_AUDIT\nreconciled crashed op seq %s\n' "$seq"
  fi
}
cmd_reconcile() {
  local pr=""
  while [ $# -gt 0 ]; do case "$1" in --pr) pr="$2"; shift 2;; *) die_usage "unknown flag $1";; esac; done
  [ -n "$pr" ] || die_usage "--pr required"; validate_numeric "$pr" "--pr"
  acquire_lock || { emit GH_ERROR "lock busy"; return 0; }
  trap release_lock EXIT
  reconcile_crashed "$pr" || true
  emit RECONCILED
}

# ── dispatch ───────────────────────────────────────────────────────────────────
main() {
  [ $# -ge 1 ] || die_usage "usage: label.sh <apply|pull|restore|parity|refile|reconcile> ..."
  local sub="$1"; shift
  case "$sub" in
    apply) cmd_apply "$@";;
    pull) cmd_pull "$@";;
    restore) cmd_restore "$@";;
    parity) cmd_parity "$@";;
    refile) cmd_refile "$@";;
    reconcile) cmd_reconcile "$@";;
    *) die_usage "unknown subcommand '$sub'";;
  esac
}
main "$@"
