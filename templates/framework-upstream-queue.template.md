# Framework upstream queue

Tracking ledger for candidate promotions from this repo into the
`claude-code-framework` repo. This is the PENDING-work queue.

> Bootstrap: this file is created from the framework-canonical template
> `templates/framework-upstream-queue.template.md` the first time a finalisation routes an
> `Upstream queue? = yes` effect (finalisation-coordinator Step 7a, Rule 1), or during
> adoption. Once created it is consumer-owned: edit the rows here. The template keeps
> syncing but never overwrites this derived file.

It is DISTINCT from `tasks/knowledge-to-framework-skills-map.md`, which is the
COMPLETED-promotions map (schema `| Date | Skill | Overlay entry | Promoted in |
Framework PR |`, created by `/cleanfiles` on the first accepted overlay-to-skill
promotion). Do not merge the two contracts.

## What belongs here

A framework-canonical defect or improvement whose fix must land in the framework repo:
an agent-contract change, a hook, a command, a shipped template or schema, a manifest
registration, or any other non-skill canonical artifact. Repo-specific facts stay in
`KNOWLEDGE.md`; skill-shaped lessons mirror to `.claude/context/skill-context.md` (the
overlay) and promote to a canonical skill through the `/cleanfiles` overlay-drain path,
which records them in the completed-promotions MAP, not in this queue. Only when a queue
row's `Source` is itself an overlay entry does the promotion produce BOTH a queue close
and a map row (see Close semantics below).

## Ledger rules

This is a NON-BINDING, STATEFUL tracking ledger, not an append-only event log. Rows are
updated in place through their lifecycle.

- **ID** is a stable `FUQ-<n>`, assigned in order and NEVER reused. Cross-references cite
  the ID.
- **Status** is one of: `queued`; `pr-opened <link>`; `promoted in vX.Y.Z`;
  `rejected <reason>`.
- **Queued** and **Last reviewed** are ISO dates (`YYYY-MM-DD`). `Last reviewed` is
  updated ONLY by an operator-approved FULL sweep. `/cleanfiles audit` and any other
  read-only inspection REPORT staleness and write nothing.
- **One open row per candidate.** Re-raising an existing candidate updates that row's
  `Status` and `Evidence` only, NEVER `Last reviewed`, and never adds a duplicate row. A
  CLOSED candidate (`promoted`/`rejected`) that genuinely recurs gets a NEW `FUQ-<n>` with
  a `supersedes FUQ-<n>` note in `Evidence`.
- **Staleness** is measurable: an open row is stale when `Last reviewed` is older than
  180 days (approximately two quarterly sweeps). Stale rows are surfaced by whoever runs
  the sweep; the `/cleanfiles` queue-staleness target reports them read-only in both audit
  and apply modes.
- **Close semantics.** A row whose `Source` is an overlay entry (a
  skill-overlay-to-canonical-skill promotion) gets the DUAL record on close: this row moves
  to `promoted in vX.Y.Z`, a row is appended to
  `tasks/knowledge-to-framework-skills-map.md`, and the overlay entry gets its
  `> promoted in vX.Y.Z` marker. A row for any non-skill canonical artifact (an
  agent-contract change, a hook, a command, a shipped template or schema, a manifest
  registration, or other non-skill canonical content) closes in THIS queue alone and
  never writes a map row.

## Queue

| ID | Candidate | Source | Target (framework) | Status | Queued | Last reviewed | Evidence |
|----|-----------|--------|--------------------|--------|--------|---------------|----------|
| (no open candidates yet) | | | | | | | |
