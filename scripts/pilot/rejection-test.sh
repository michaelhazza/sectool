#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rejection-test.sh — LIVE disposable-repo rejection test (spec
# `framework-runtime-neutral-v3` §12.B Chunk B1, the Phase-B security gate).
#
# Runs the six probes from spec §13.4/§13.5/§14 against a real GitHub
# disposable pilot repository, AS the dedicated OpenClaw builder identity,
# and proves GitHub — not prompt text — enforces the pilot's core guarantee:
# no PR becomes mergeable by the builder identity without Michael's prior
# code-owner approval.
#
#   1. positive control  — builder can push a feature branch and open/update
#                           a PR                              (expect allowed)
#   2. direct push        — builder pushes straight to default (expect rejected)
#   3. force push          — builder force-pushes to default   (expect rejected)
#   4. branch deletion     — builder deletes the default branch (expect rejected)
#   5. unapproved merge    — builder merges an open PR with NO code-owner
#                             approval                          (expect rejected)
#   6. agent approval      — an agent-identity approval (builder token) does
#                             NOT satisfy the code-owner requirement, tested
#                             against BOTH an OpenClaw-authored PR and a
#                             Claude-authored PR                (expect rejected)
#
# This script contains NO classification logic and NO token literal. It only
# runs the probes, emits a structured JSON-lines probe-result list, and
# delegates the pass/fail/INCONCLUSIVE verdict to the pure, offline-testable
# classify-rejection.mjs (F5 seam — see that file and its .test.mjs).
#
# PREREQUISITES (spec §9, Decision 8 — assumed already configured, not
# created by this script):
#   - the dedicated `myatdevelopment`-style OpenClaw builder identity/token:
#     branch-write, no Admin, no ruleset bypass;
#   - a disposable pilot GitHub repository with the default-branch ruleset
#     and CODEOWNERS installed (templates: templates/CODEOWNERS.template,
#     templates/default-branch-ruleset.json — B4);
#   - the `gh` CLI and `git` on PATH, both usable non-interactively.
#
# REQUIRED ENVIRONMENT VARIABLES (no literal token ever appears in this
# file — check-secrets.cjs sweeps tracked files for exactly this):
#   OPENCLAW_BUILDER_TOKEN   GitHub token for the builder identity. Accepts
#                            the alias MYATDEVELOPMENT_TOKEN for the
#                            per-consumer identity name in spec §9.
#   OPENCLAW_PILOT_REPO      "owner/repo" of the disposable pilot repository.
#
# OPTIONAL ENVIRONMENT VARIABLES:
#   OPENCLAW_REJECTION_LOG_FILE   Path to write the JSON-lines probe-result
#                                 log. Default: a fresh file under the
#                                 system temp dir, printed on completion.
#   OPENCLAW_DEFAULT_BRANCH       Default branch name to probe against.
#                                 Default: main.
#
# FAIL-CLOSED PREREQUISITE CHECK: if OPENCLAW_BUILDER_TOKEN (or the
# MYATDEVELOPMENT_TOKEN alias) or OPENCLAW_PILOT_REPO is unset, this script
# prints "prerequisites missing — cannot run; INCONCLUSIVE" and exits
# non-zero WITHOUT making any gh/git call against GitHub.
#
# Usage:
#   OPENCLAW_BUILDER_TOKEN=*** OPENCLAW_PILOT_REPO=owner/repo \
#     bash scripts/pilot/rejection-test.sh
#
# See docs/pilots/openclaw-rejection-test-runbook.md for the full operator
# walkthrough, including how to read the verdict and where evidence is
# recorded for the acceptance map (spec §13 rows 4/5).
# ---------------------------------------------------------------------------
set -uo pipefail

# F4 (security hardening, adversarial review): refuse to run under xtrace —
# `set -x` would echo BUILDER_PUSH_URL (which embeds the raw token) to the
# terminal/log on every command.
case $- in
  *x*) echo "rejection-test: refusing to run under set -x (token exposure risk)" >&2; exit 1 ;;
esac

BUILDER_TOKEN="${OPENCLAW_BUILDER_TOKEN:-${MYATDEVELOPMENT_TOKEN:-}}"
PILOT_REPO="${OPENCLAW_PILOT_REPO:-}"
DEFAULT_BRANCH="${OPENCLAW_DEFAULT_BRANCH:-main}"
LOG_FILE="${OPENCLAW_REJECTION_LOG_FILE:-$(mktemp -t openclaw-rejection-test-XXXXXX.jsonl 2>/dev/null || echo "/tmp/openclaw-rejection-test-$$.jsonl")}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$BUILDER_TOKEN" ] || [ -z "$PILOT_REPO" ]; then
  echo "rejection-test: prerequisites missing — cannot run; INCONCLUSIVE" >&2
  echo "  OPENCLAW_BUILDER_TOKEN (or MYATDEVELOPMENT_TOKEN): $([ -n "$BUILDER_TOKEN" ] && echo set || echo MISSING)" >&2
  echo "  OPENCLAW_PILOT_REPO:                                $([ -n "$PILOT_REPO" ] && echo "$PILOT_REPO" || echo MISSING)" >&2
  echo "  No gh/git call was made against GitHub." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "rejection-test: 'gh' CLI not found on PATH — cannot run; INCONCLUSIVE" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "rejection-test: 'git' not found on PATH — cannot run; INCONCLUSIVE" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "rejection-test: 'node' not found on PATH — cannot classify results; INCONCLUSIVE" >&2
  exit 1
fi

: > "$LOG_FILE"

# Appends one JSON-lines probe result. $1=name $2=action $3=expected
# $4=observed $5=detail (optional, may contain spaces; empty string omits it).
emit_probe() {
  local name="$1" action="$2" expected="$3" observed="$4" detail="${5:-}"
  node -e '
    const [name, action, expected, observed, detail] = process.argv.slice(1);
    const probe = { name, action, expected, observed };
    if (detail) probe.detail = detail;
    process.stdout.write(JSON.stringify(probe) + "\n");
  ' "$name" "$action" "$expected" "$observed" "$detail" >> "$LOG_FILE"
  echo "rejection-test: probe '$name' -> expected=$expected observed=$observed" >&2
}

# F1 (security hardening, adversarial review): a forbidden probe (direct
# push, force-push, delete-default, unapproved merge) that merely NON-ZERO
# EXITS is not proof GitHub's ruleset rejected it — a wrong
# OPENCLAW_DEFAULT_BRANCH, a transient 5xx, or an expired token all exit
# non-zero too, and previously that was recorded as "rejected" (a false
# PASS). This classifies the captured stderr against known branch-
# protection/ruleset signals before calling it "rejected"; anything else on
# a non-zero exit is "error" (-> INCONCLUSIVE downstream), never a silent
# false PASS. Sets PROBE_OBSERVED and PROBE_DETAIL; the token is scrubbed
# from PROBE_DETAIL before it is ever stored or emitted.
# $1=exit-code $2=captured-stderr
classify_forbidden_probe() {
  local exit_code="$1" stderr_output="$2" scrubbed
  scrubbed="${stderr_output//$BUILDER_TOKEN/***}"
  if [ "$exit_code" -eq 0 ]; then
    PROBE_OBSERVED="allowed"
    PROBE_DETAIL=""
    return
  fi
  if printf '%s' "$scrubbed" | grep -qiE 'protected branch|GH006|Changes must be made through a pull request|Review required|required status check|refusing to allow|not mergeable|required approving review|at least 1 approving review|(status: *)?422'; then
    PROBE_OBSERVED="rejected"
    PROBE_DETAIL=""
  else
    PROBE_OBSERVED="error"
    PROBE_DETAIL="$scrubbed"
  fi
}

# OAI-PR-001 (security-gate soundness): runs "$@", capturing stdout into
# GH_CAP_STDOUT, token-scrubbed stderr into GH_CAP_STDERR, and exit code into
# GH_CAP_EXIT. Used by the merge/approval probes (5, 6a, 6b) so their
# classification can tell "the gh command itself failed" apart from "GitHub's
# ruleset rejected the action" — see classify_action_probe below.
gh_capture() {
  local stderr_file
  stderr_file="$(mktemp)"
  GH_CAP_STDOUT="$("$@" 2>"$stderr_file")"
  GH_CAP_EXIT="$?"
  GH_CAP_STDERR="$(cat "$stderr_file" 2>/dev/null)"
  rm -f "$stderr_file"
  GH_CAP_STDERR="${GH_CAP_STDERR//$BUILDER_TOKEN/***}"
}

# OAI-PR-001: classifies a merge/approval probe outcome. A prior fix (F6,
# below) made probe 5 trust the post-action STATE read over the merge
# command's own exit status/stderr, because GitHub's block-message wording
# for merges doesn't reliably match classify_forbidden_probe's signal list.
# That is still correct — but taken alone it let a merge/approve command that
# failed for an UNRELATED reason (auth, transient API, bad flag) be recorded
# as "rejected" just because the PR wasn't merged/approved, without ever
# proving the ruleset was what stopped it. This requires the state read to
# have genuinely succeeded AND the paired action command to have failed
# before calling it "rejected"; an action command that reports success (exit
# 0) while the state disagrees is ambiguous, not a clean pass, and is
# reported as "error" (-> INCONCLUSIVE) instead.
# $1=action_exit $2=action_stderr(scrubbed) $3=view_exit $4=view_stdout
# $5=success_value (e.g. "MERGED" / "APPROVED"). Sets PROBE_OBSERVED and
# PROBE_DETAIL.
classify_action_probe() {
  local action_exit="$1" action_stderr="$2" view_exit="$3" view_stdout="$4" success_value="$5"
  if [ "$view_exit" -eq 0 ] && [ "$view_stdout" = "$success_value" ]; then
    PROBE_OBSERVED="allowed"
    PROBE_DETAIL=""
    return
  fi
  if [ "$view_exit" -eq 0 ] && [ -n "$view_stdout" ] && [ "$action_exit" -ne 0 ]; then
    PROBE_OBSERVED="rejected"
    PROBE_DETAIL="state=$view_stdout${action_stderr:+; action-stderr=$action_stderr}"
    return
  fi
  if [ "$action_exit" -ne 0 ]; then
    classify_forbidden_probe "$action_exit" "$action_stderr"
    return
  fi
  PROBE_OBSERVED="error"
  PROBE_DETAIL="could not confirm outcome (action-exit=$action_exit view-exit=$view_exit view-stdout=${view_stdout:-<empty>}${action_stderr:+; action-stderr=$action_stderr})"
}

WORKDIR="$(mktemp -d -t openclaw-rejection-test-workdir-XXXXXX 2>/dev/null || mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

CLONE_DIR="$WORKDIR/repo"
PROBE_BRANCH="openclaw-rejection-probe-$$"
# Two distinct push URLs, deliberately kept separate: BUILDER_PUSH_URL embeds
# the builder token and is used for every probe that must run AS the builder
# identity (probes 1-6a). AMBIENT_PUSH_URL carries no embedded credential and
# relies on the operator's own git/gh credential helper, so probe 6b's
# "Claude-authored PR" is genuinely non-builder-authored — pushing it to
# "origin" (whose URL embeds the builder token) would silently defeat the
# probe.
BUILDER_PUSH_URL="https://x-access-token:${BUILDER_TOKEN}@github.com/${PILOT_REPO}.git"
AMBIENT_PUSH_URL="https://github.com/${PILOT_REPO}.git"

echo "rejection-test: cloning $PILOT_REPO as the builder identity..." >&2
git clone --quiet "$BUILDER_PUSH_URL" "$CLONE_DIR" 2>/dev/null
if [ ! -d "$CLONE_DIR" ]; then
  emit_probe "clone" "clone-repo" "allowed" "error" "unable to clone $PILOT_REPO with the builder identity"
else
  cd "$CLONE_DIR" || exit 1
  git config user.email "openclaw-builder@pilot.local"
  git config user.name "OpenClaw Builder (pilot)"

  # --- Probe 1: positive control — feature branch push + PR open/update ---
  git checkout -b "$PROBE_BRANCH" --quiet
  echo "openclaw rejection-test probe $(date -u +%FT%TZ)" >> "openclaw-rejection-probe.txt"
  git add "openclaw-rejection-probe.txt"
  git commit --quiet -m "openclaw rejection-test: positive-control probe"
  if git push --quiet origin "$PROBE_BRANCH" 2>/dev/null \
      && PR_URL=$(GH_TOKEN="$BUILDER_TOKEN" gh pr create --repo "$PILOT_REPO" --head "$PROBE_BRANCH" \
          --title "openclaw rejection-test probe" --body "Automated probe — safe to close/delete." 2>/dev/null); then
    emit_probe "positive-control" "push-feature-branch-open-pr" "allowed" "allowed" "$PR_URL"
  else
    emit_probe "positive-control" "push-feature-branch-open-pr" "allowed" "error" "push or PR-open failed unexpectedly"
    PR_URL=""
  fi

  # --- Probe 2: direct push to default ---
  git checkout "$DEFAULT_BRANCH" --quiet 2>/dev/null || git checkout -b "$DEFAULT_BRANCH" --quiet "origin/$DEFAULT_BRANCH" 2>/dev/null
  echo "openclaw rejection-test direct-push probe" >> "openclaw-rejection-direct.txt"
  git add "openclaw-rejection-direct.txt"
  git commit --quiet -m "openclaw rejection-test: direct-push probe (must be rejected)"
  DIRECT_PUSH_STDERR="$(git push --quiet origin "$DEFAULT_BRANCH" 2>&1 >/dev/null)"
  classify_forbidden_probe "$?" "$DIRECT_PUSH_STDERR"
  if [ "$PROBE_OBSERVED" = "allowed" ]; then
    emit_probe "direct-push-default" "direct-push" "rejected" "allowed" "push to $DEFAULT_BRANCH SUCCEEDED — should have been rejected"
  elif [ "$PROBE_OBSERVED" = "rejected" ]; then
    emit_probe "direct-push-default" "direct-push" "rejected" "rejected"
  else
    emit_probe "direct-push-default" "direct-push" "rejected" "error" "$PROBE_DETAIL"
  fi
  git reset --hard --quiet "origin/$DEFAULT_BRANCH" 2>/dev/null || true

  # --- Probe 3: force-push to default ---
  git commit --quiet --allow-empty -m "openclaw rejection-test: force-push probe (must be rejected)"
  FORCE_PUSH_STDERR="$(git push --force --quiet origin "$DEFAULT_BRANCH" 2>&1 >/dev/null)"
  classify_forbidden_probe "$?" "$FORCE_PUSH_STDERR"
  if [ "$PROBE_OBSERVED" = "allowed" ]; then
    emit_probe "force-push-default" "force-push" "rejected" "allowed" "force-push to $DEFAULT_BRANCH SUCCEEDED — should have been rejected"
  elif [ "$PROBE_OBSERVED" = "rejected" ]; then
    emit_probe "force-push-default" "force-push" "rejected" "rejected"
  else
    emit_probe "force-push-default" "force-push" "rejected" "error" "$PROBE_DETAIL"
  fi
  git reset --hard --quiet "origin/$DEFAULT_BRANCH" 2>/dev/null || true

  # --- Probe 4: delete the default branch ---
  DELETE_BRANCH_STDERR="$(git push --quiet origin --delete "$DEFAULT_BRANCH" 2>&1 >/dev/null)"
  classify_forbidden_probe "$?" "$DELETE_BRANCH_STDERR"
  if [ "$PROBE_OBSERVED" = "allowed" ]; then
    emit_probe "delete-default-branch" "delete-branch" "rejected" "allowed" "deletion of $DEFAULT_BRANCH SUCCEEDED — should have been rejected"
  elif [ "$PROBE_OBSERVED" = "rejected" ]; then
    emit_probe "delete-default-branch" "delete-branch" "rejected" "rejected"
  else
    emit_probe "delete-default-branch" "delete-branch" "rejected" "error" "$PROBE_DETAIL"
  fi

  if [ -n "$PR_URL" ]; then
    # --- Probe 5: merge the open PR with no code-owner approval ---
    # F6: `gh pr merge`'s block message ("not mergeable", "required
    # approving review") differs from the git-push protected-branch signals
    # classify_forbidden_probe was originally tuned for, so a correctly-
    # blocked merge risked misclassifying as "error" -> INCONCLUSIVE (an
    # un-passable gate). Prefer a STATE check over stderr parsing, mirroring
    # probe 6a's reviewDecision approach: attempt the merge, then read the
    # PR's own `state` afterwards. OAI-PR-001: that state read alone is not
    # sufficient proof — classify_action_probe additionally requires the
    # merge command itself to have failed before trusting a non-MERGED state
    # as "rejected", so a merge command that failed for an unrelated reason
    # (auth, transient API, bad flag) can no longer be recorded as a false
    # "rejected" pass.
    gh_capture env GH_TOKEN="$BUILDER_TOKEN" gh pr merge --repo "$PILOT_REPO" "$PR_URL" --squash --auto=false
    MERGE_EXIT="$GH_CAP_EXIT"
    MERGE_STDERR="$GH_CAP_STDERR"
    gh_capture env GH_TOKEN="$BUILDER_TOKEN" gh pr view --repo "$PILOT_REPO" "$PR_URL" --json state --jq .state
    VIEW_EXIT="$GH_CAP_EXIT"
    POST_MERGE_STATE="$GH_CAP_STDOUT"
    classify_action_probe "$MERGE_EXIT" "$MERGE_STDERR" "$VIEW_EXIT" "$POST_MERGE_STATE" "MERGED"
    case "$PROBE_OBSERVED" in
      allowed) emit_probe "merge-without-approval" "merge-pr" "rejected" "allowed" "builder merged $PR_URL with no code-owner approval — should have been rejected" ;;
      rejected) emit_probe "merge-without-approval" "merge-pr" "rejected" "rejected" "$PROBE_DETAIL" ;;
      *) emit_probe "merge-without-approval" "merge-pr" "rejected" "error" "could not confirm post-merge PR state for $PR_URL: $PROBE_DETAIL" ;;
    esac

    # --- Probe 6a: an agent-identity approval does not satisfy code-owner
    # review on the OpenClaw-authored PR opened in probe 1 ---
    # OAI-PR-001: capture the approve command's own exit/stderr — previously
    # discarded entirely — so a failed approval attempt (auth, transient
    # API, bad flag) can't be misread as a successful "agent approval didn't
    # satisfy code-owner review" test via classify_action_probe below.
    gh_capture env GH_TOKEN="$BUILDER_TOKEN" gh pr review --repo "$PILOT_REPO" "$PR_URL" --approve --body "agent approval (should not satisfy code-owner review)"
    REVIEW_EXIT="$GH_CAP_EXIT"
    REVIEW_STDERR="$GH_CAP_STDERR"
    gh_capture env GH_TOKEN="$BUILDER_TOKEN" gh pr view --repo "$PILOT_REPO" "$PR_URL" --json reviewDecision --jq .reviewDecision
    VIEW_EXIT="$GH_CAP_EXIT"
    DECISION="$GH_CAP_STDOUT"
    classify_action_probe "$REVIEW_EXIT" "$REVIEW_STDERR" "$VIEW_EXIT" "$DECISION" "APPROVED"
    case "$PROBE_OBSERVED" in
      allowed) emit_probe "agent-approval-openclaw-pr" "approve-pr" "rejected" "allowed" "agent approval satisfied review decision on an OpenClaw-authored PR — should not have" ;;
      rejected) emit_probe "agent-approval-openclaw-pr" "approve-pr" "rejected" "rejected" "reviewDecision=$DECISION" ;;
      *) emit_probe "agent-approval-openclaw-pr" "approve-pr" "rejected" "error" "could not confirm reviewDecision for $PR_URL: $PROBE_DETAIL" ;;
    esac
  else
    emit_probe "merge-without-approval" "merge-pr" "rejected" "error" "no PR from the positive-control probe to test against"
    emit_probe "agent-approval-openclaw-pr" "approve-pr" "rejected" "error" "no PR from the positive-control probe to test against"
  fi

  # --- Probe 6b: same agent-approval check against a Claude-authored PR.
  # Opened under the CALLER's ambient `gh` auth (Michael/Claude
  # administrator credential), never the builder token, so the PR's
  # authorship is genuinely non-builder.
  #
  # F3 (security hardening, adversarial review): if the ambient credential
  # resolves to the SAME login as the builder identity (or is unauthenticated
  # entirely), the "Claude-authored" PR below would in fact be builder-
  # authored, silently defeating the probe. Verify the two identities differ
  # BEFORE creating anything; neither token is ever printed.
  AMBIENT_LOGIN="$(gh api user --jq .login 2>/dev/null)"
  BUILDER_LOGIN="$(GH_TOKEN="$BUILDER_TOKEN" gh api user --jq .login 2>/dev/null)"
  if [ -z "$AMBIENT_LOGIN" ] || [ "$AMBIENT_LOGIN" = "$BUILDER_LOGIN" ]; then
    emit_probe "agent-approval-claude-pr" "approve-pr" "rejected" "error" "could not obtain a non-builder authoring identity"
  else
    CLAUDE_BRANCH="claude-rejection-probe-$$"
    git checkout "$DEFAULT_BRANCH" --quiet 2>/dev/null
    git checkout -b "$CLAUDE_BRANCH" --quiet
    echo "claude-authored rejection-test probe $(date -u +%FT%TZ)" >> "claude-rejection-probe.txt"
    git add "claude-rejection-probe.txt"
    git commit --quiet -m "openclaw rejection-test: claude-authored PR for agent-approval probe"
    if git push --quiet "$AMBIENT_PUSH_URL" "HEAD:refs/heads/$CLAUDE_BRANCH" 2>/dev/null \
        && CLAUDE_PR_URL=$(gh pr create --repo "$PILOT_REPO" --head "$CLAUDE_BRANCH" \
            --title "openclaw rejection-test: claude-authored probe" --body "Automated probe — safe to close/delete." 2>/dev/null); then
      # OAI-PR-001: same capture-then-classify treatment as probe 6a.
      gh_capture env GH_TOKEN="$BUILDER_TOKEN" gh pr review --repo "$PILOT_REPO" "$CLAUDE_PR_URL" --approve --body "agent approval (should not satisfy code-owner review)"
      CLAUDE_REVIEW_EXIT="$GH_CAP_EXIT"
      CLAUDE_REVIEW_STDERR="$GH_CAP_STDERR"
      gh_capture gh pr view --repo "$PILOT_REPO" "$CLAUDE_PR_URL" --json reviewDecision --jq .reviewDecision
      CLAUDE_VIEW_EXIT="$GH_CAP_EXIT"
      CLAUDE_DECISION="$GH_CAP_STDOUT"
      classify_action_probe "$CLAUDE_REVIEW_EXIT" "$CLAUDE_REVIEW_STDERR" "$CLAUDE_VIEW_EXIT" "$CLAUDE_DECISION" "APPROVED"
      case "$PROBE_OBSERVED" in
        allowed) emit_probe "agent-approval-claude-pr" "approve-pr" "rejected" "allowed" "agent approval satisfied review decision on a Claude-authored PR — should not have" ;;
        rejected) emit_probe "agent-approval-claude-pr" "approve-pr" "rejected" "rejected" "reviewDecision=$CLAUDE_DECISION" ;;
        *) emit_probe "agent-approval-claude-pr" "approve-pr" "rejected" "error" "could not confirm reviewDecision for $CLAUDE_PR_URL: $PROBE_DETAIL" ;;
      esac
    else
      emit_probe "agent-approval-claude-pr" "approve-pr" "rejected" "error" "could not open the claude-authored probe PR under the ambient credential"
    fi
  fi
fi

echo "rejection-test: probe log written to $LOG_FILE" >&2
echo "rejection-test: classifying via classify-rejection.mjs..." >&2

VERDICT_JSON=$(node "$SCRIPT_DIR/classify-rejection.mjs" < "$LOG_FILE")
VERDICT_EXIT=$?

echo "$VERDICT_JSON"
echo "rejection-test: probe log preserved at $LOG_FILE" >&2

exit "$VERDICT_EXIT"
