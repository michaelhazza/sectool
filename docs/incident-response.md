# Incident Response

Reference document for production incident coordination. Companion to `.claude/agents/incident-commander.md` (coordinator playbook) and `.claude/agents/hotfix.md` (fix playbook).

---

## SEV matrix

| Level | Label | Definition | Examples | Expected response time |
|-------|-------|------------|---------|------------------------|
| SEV-1 | Critical | Production down or data loss in progress; all users affected | Auth broken for all users, database unreachable, payments failing, data corruption actively occurring | Immediate — interrupt the operator regardless of session state |
| SEV-2 | High | Core workflow broken for a significant subset of users; no data loss | A key integration failing for one tenant, agent executions failing for 20%+ of runs, billing miscalculations | Within 1 hour |
| SEV-3 | Medium | Degraded experience; workaround available; limited blast radius | UI feature broken with a workaround, slow response times on a non-critical path, one tenant's webhook failing | Within 4 hours (same business day) |
| SEV-4 | Low | Minor issue; cosmetic or edge-case; no meaningful user impact | Typo in UI copy, a rarely-used report returning stale data, logging noise | Next sprint or backlog |

**Escalation rule:** when in doubt, classify higher. Downgrading a SEV is cheaper than missing a SEV-1.

**Data integrity clause:** any incident where data may have been silently corrupted or lost is automatically SEV-1 until proved otherwise.

---

## On-call expectations

Pre-launch: the operator is the sole on-call. No rotation exists yet.

- **SEV-1:** interrupt immediately, regardless of time or active session state.
- **SEV-2:** respond within 1 hour; if outside working hours, respond at start of next shift unless SEV escalates to SEV-1.
- **SEV-3/SEV-4:** triage during normal working hours; add to backlog if outside hours.

Once a real on-call rotation exists, update this section with rotation schedule, escalation path, and pager tool. Until then, the operator is the single point of contact.

---

## Timeline-log format

Every incident gets a folder at `tasks/incidents/<YYYY-MM-DD-slug>/`. The timeline lives at `tasks/incidents/<YYYY-MM-DD-slug>/timeline.md`.

**Skeleton:**

```markdown
# Incident Timeline — <YYYY-MM-DD-slug>

SEV: <level>
Opened: <ISO 8601 UTC timestamp>
Closed: [open]

---

## Entries

[YYYY-MM-DDTHH:MM:SSZ] [agent] — Incident opened. SEV-<N> classified. Reason: <one sentence>.
```

**Entry format:**

```
[YYYY-MM-DDTHH:MM:SSZ] [actor] — [observation or action]
```

- `actor`: `operator`, `agent`, or a named team member.
- `observation`: what was detected (symptoms, metrics, user reports).
- `action`: what was done in response (command run, config changed, escalation made).
- Entries are append-only. Never edit or delete an existing entry.
- Use ISO 8601 UTC (`2026-05-12T14:32:00Z`). Do not use local time.

---

## Post-mortem template

Written to `tasks/incidents/<YYYY-MM-DD-slug>/postmortem.md` by `incident-commander` within 48 hours of resolution. Action items are also added to `tasks/todo.md`.

```markdown
# Post-Mortem — <YYYY-MM-DD-slug>

**Status:** draft | final
**SEV:** <level>
**Date of incident:** <YYYY-MM-DD>
**Author:** incident-commander (operator to review and finalise)

---

## Summary

<2–3 sentences: what broke, how it was detected, how it was fixed.>

## Impact

- **Duration:** <start time> to <end time> (<total minutes/hours>)
- **Users affected:** <all / subset / unknown — add count if known>
- **Data integrity:** <not affected / affected — describe>
- **Revenue impact:** [operator to complete]

## Timeline

See `tasks/incidents/<YYYY-MM-DD-slug>/timeline.md` for the full log. Key milestones:

- `<timestamp>` — Incident detected
- `<timestamp>` — SEV classified
- `<timestamp>` — Root cause identified
- `<timestamp>` — Fix deployed
- `<timestamp>` — Incident resolved

## Root cause (5 whys)

1. **Why did the failure occur?** <answer>
2. **Why did that happen?** <answer>
3. **Why did that happen?** <answer>
4. **Why did that happen?** <answer>
5. **Why did that happen?** <root cause — the deepest addressable cause>

## Contributing factors

- <factor 1: e.g. missing test coverage, no alerting, manual process>
- <factor 2>
- [operator to complete if additional factors exist]

## What went well

- <e.g. fast detection, clear escalation path, rollback available>
- [operator to complete]

## What didn't go well

- <e.g. slow root-cause diagnosis, unclear runbook, no monitoring>
- [operator to complete]

## Action items

| Item | Owner | Due date | Status |
|------|-------|----------|--------|
| <action item 1> | operator | <YYYY-MM-DD> | open |
| <action item 2> | operator | <YYYY-MM-DD> | open |

_Action items also added to `tasks/todo.md` under `## Action items from incident <YYYY-MM-DD-slug>`._
```

---

## Cross-reference

- **Coordinator playbook:** `.claude/agents/incident-commander.md` — SEV classification, scribe duties, post-mortem drive.
- **Fix playbook:** `.claude/agents/hotfix.md` — root-cause diagnosis, patch, targeted test, KNOWLEDGE.md gotcha entry.
- **Responsibility split:** `incident-commander` writes the post-mortem under `tasks/incidents/`; `hotfix` writes the KNOWLEDGE.md gotcha entry. These are separate artifacts and must not be duplicated.
