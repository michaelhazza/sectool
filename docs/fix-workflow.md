# Fix Workflow — Target-Repo Onboarding

This document describes how to connect a target repo to the audit tool's
remediation workflow so that security findings become tracked fix requests
automatically. Complete the one-time setup steps below; after that the loop
runs on its own.

---

## Required GitHub Label: `audit-fix`

Every fix-request issue filed by `audit fix` (or the dashboard's "Send for
fixing" button) is labelled **`audit-fix`**. The label must exist in the target
repo before fix requests can be filed.

Create it once:

1. Go to the target repo on GitHub → **Issues** → **Labels** → **New label**.
2. Name: `audit-fix`  
   Color: any (suggested `#e11d48`)  
   Description: `Security finding from audit-tool — implement the fix in this branch`
3. Click **Create label**.

The idempotency logic in `src/fix/github.ts` searches for open `audit-fix`
issues bearing the fingerprint marker before creating a new one, so a missing
label causes issue creation to fail with an API error. Create the label first.

---

## Claude Code Action Setup

The recommended automation path is the standard **Claude Code GitHub Action**
already present in every Breakout Solutions repo (`automation-v1`, etc.). When
the action is configured correctly it picks up `audit-fix`-labelled issues
automatically and implements the fix on a branch.

### One-Time Per Repo

1. Confirm the Claude Code action workflow exists (`.github/workflows/claude-code.yml`
   or equivalent). If it does not exist, follow the Claude Code Action quick-start
   in the repo's `CLAUDE.md`.

2. Ensure the action's trigger includes the `audit-fix` label. Example addition
   to the workflow's `on:` block:

   ```yaml
   on:
     issues:
       types: [labeled]
   ```

   And in the job `if:` condition:

   ```yaml
   if: github.event.label.name == 'audit-fix'
   ```

3. The action must have read access to the issue body (default for
   `issues: read`). No `contents: write` from the audit tool is required — the
   action uses its own token for branch/commit operations.

4. Verify the action runs in the target repo's test environment: merge a test
   `audit-fix` issue and confirm CI gates pass on the resulting PR.

That is the entire one-time setup. Subsequent fix requests file automatically
via `audit fix` or the dashboard.

---

## Token and Scope Requirements: `AUDIT_GITHUB_FIX_TOKEN`

The audit tool uses a single token — `AUDIT_GITHUB_FIX_TOKEN` — for all GitHub
operations related to fix requests.

| Property | Value |
|---|---|
| Token name | `AUDIT_GITHUB_FIX_TOKEN` |
| Token type | GitHub fine-grained personal access token (PAT) |
| Required scopes | `issues:write` (includes `issues:read`), `pull_requests:read` |
| Forbidden scopes | **Never** `contents:write`. The tool does not write code. |
| Repo access | Breakout-owned target repos only (scoped to specific repos) |
| Where to set it | As an environment variable before running `audit fix` or `audit ui` |

**Why `issues:write` only?** The tool files issues and comments on them; it
reads PR state to derive fix status. It never creates branches, pushes commits,
or modifies repo contents. `contents:write` is intentionally absent — adding it
would make the audit tool a single point of compromise against every target
repo.

**Missing token behaviour:** `audit fix` fails immediately with
`MissingFixTokenError` and prints instructions. The dashboard's "Send for
fixing" button shows a plain-English "fix-sending is not configured" message.

**Token rotation:** revoke and regenerate the PAT; update the environment
variable. No config file change required.

---

## Issue Marker Format (Fingerprint Marker)

Every fix-request issue body contains an HTML comment marker that the audit
tool uses for idempotency. The marker format is:

```
<!-- audit-fix:<fingerprint>:initial -->
```

Where `<fingerprint>` is the full 64-hex SHA-256 fingerprint of the finding
(e.g. `3f9a1c2b8d4e0a17…` — 64 hex characters). The `:initial` suffix
identifies this as the first-filing marker embedded in the issue body at
creation time.

**Issue-level idempotency (search-before-create):** before filing a new issue
the tool searches existing open `audit-fix` issues in the repo for a body that
contains this exact marker. If found, the existing issue is reused — no
duplicate is created. A label-only match without the marker is not treated as
the canonical issue.

**Comment-level idempotency (search-before-comment):** comments posted to an
existing issue (e.g. on a `reopened` transition) carry a similar marker:

```
<!-- audit-fix:<fingerprint>:<reason> -->
```

Where `<reason>` is a string such as `refiled` or `reopened`. Before posting,
the tool scans existing comments for the exact marker and skips posting if it
is already present. This closes the duplicate-comment window on retries.

**Do not edit the marker.** Removing or modifying the HTML comment in an issue
body prevents the audit tool from recognising the issue and will cause a
duplicate issue on the next `audit fix` invocation.

---

## Expected PR-Reference Format

After the Claude Code action implements a fix it opens a PR. For the audit tool
to advance the fix state from `in-progress` to `awaiting-review`, the PR must
reference the `audit-fix` issue using GitHub's standard closing/referencing
syntax in the PR body or a commit message:

```
Closes #<issue-number>
```

Or any of GitHub's recognised keywords (`Fixes #N`, `Resolves #N`, etc.).

The audit tool detects the PR via `pull_requests:read` scope: it searches for
open and merged PRs whose body or commit messages reference the issue number.
No special audit-tool-specific syntax is needed beyond the standard GitHub
issue reference.

**Draft PRs** move the state to `in-progress` (work started, not yet ready for
review). A non-draft open PR moves the state to `awaiting-review`. A merged PR
moves the state to `merged-awaiting-verification`, pending the next `audit run`.

---

## The 6 Remediation States

The fix-request state machine has exactly six states (closed set — adding a
state requires a spec amendment). States are derived from GitHub issue/PR state
and scan results on every `audit run`; they are never set manually.

| State | Meaning |
|---|---|
| `requested` | Fix-request issue filed and open; no assignee and no PR references it yet. The Claude Code action has not yet started. |
| `in-progress` | Work has started: the issue is assigned, OR a **draft** PR references the issue. The fix branch exists but is not ready for review. |
| `awaiting-review` | A non-draft PR referencing the issue is open and awaiting human merge. The fix is implemented; the repo's CI gates should be green. |
| `merged-awaiting-verification` | The PR has been merged. The next `audit run` will verify whether the fingerprint still fires. |
| `verified-fixed` | A subsequent `audit run` no longer produces the finding's fingerprint **and** the originating scanner family ran to full completion in that run. The fix is confirmed. |
| `reopened` | The PR was merged but the fingerprint still fires in a subsequent run where the originating scanner family completed. The issue is reopened with a comment; the loop restarts. |

**Family-completion fence on `verified-fixed`:** a scanner family that failed,
timed out, or was skipped in a run cannot graduate a fix to `verified-fixed`.
The absence of a finding from an incomplete family is not evidence that the fix
worked — it may simply mean the scanner did not run. The request stays at
`merged-awaiting-verification` until a run in which the responsible family
completes and the fingerprint is absent.

**`reopened` is non-terminal:** recovery uses the same six states. A new
non-draft PR referencing the issue moves the state back to `awaiting-review`.

---

## Manual Fallback: Paste-Prompt Flow

If a target repo does not have the Claude Code action installed, or for ad-hoc
local fixing, every remediation pack includes a ready-to-paste Claude Code
prompt.

### From the Dashboard

1. Open `audit ui` (run `audit ui` in the audit-tool directory).
2. Navigate to **What Needs Fixing** (the run report screen) or **Fix Progress**.
3. Click the finding you want to fix to open the finding detail screen.
4. Click **"Copy fix instructions"** (available regardless of whether
   fix-sending is configured). This copies the full paste-prompt to your
   clipboard.
5. Open Claude Code in the **target repo** and paste the prompt.

### From the CLI

```bash
audit fix <fingerprint> --dry-run
```

`--dry-run` prints the remediation pack (including the paste-prompt) to stdout
without filing a GitHub issue. You can then copy the prompt and paste it into
Claude Code in the target repo.

### What the Paste-Prompt Contains

The prompt is a self-contained instruction set for Claude Code:

- The security finding description (plain English, from the rule doc)
- The affected file, symbol, or route
- The recommended fix pattern with a code example
- The acceptance criteria: the `ruleId` and full `fingerprint` that must no
  longer fire on `audit run` after the fix is applied

Paste it into Claude Code at the root of the target repo. Claude Code will
implement the fix on a branch following the repo's own conventions and test
suite. Open a PR normally; human review and merge are unchanged.

**Note:** live findings (findings from the staging scan surface) cannot be
filed for fixing via the UI or `audit fix` in v1 — only static findings
(source-code findings) have a target repo `gitUrl` for issue filing. For live
findings, use the paste-prompt flow and manually create the issue in the
relevant repo.
