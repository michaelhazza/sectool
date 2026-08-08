# Learning-routing fixture (Step 7a destination effects)

The saved input/output pair for the finalisation-coordinator Step 7a routing contract
(`.claude/agents/finalisation-coordinator.md`, Rules 1 to 4). It shows the
destination-effect columns routing correctly and is the acceptance fixture for a dry-run
of the routing rules against a synthetic lesson list. Every lesson here is CONSTRUCTED to
exercise the routing; none is a real defect.

## 1. Three-effect example (all destinations fire, correctly routed)

A single lesson with TWO INDEPENDENT facets so each destination is routed legitimately,
which is also a recurrence (so a mechanism proposal is mandatory under Rule 2):

- Facet (a): a repo-specific refinement to how the `wire-it-through` skill is applied in
  this repo (a skill-shaped lesson) routes to the overlay mirror.
- Facet (b): a gap in the framework-canonical `finalisation-coordinator` AGENT CONTRACT
  that should have caught it (a NON-skill canonical defect) routes to an upstream queue row.

| Pattern | Target | Overlay mirror? | Upstream queue? | Rationale | Operator decision |
|---------|--------|-----------------|-----------------|-----------|-------------------|
| (constructed) a recurring build defect (index grep matches an earlier same-class entry) with two facets: (a) a repo-specific refinement to how `wire-it-through` is applied here, and (b) a gap in the framework-canonical finalisation-coordinator agent contract that should have caught it | `regression-test` | yes to `.claude/context/skill-context.md` `## wire-it-through` (facet a) | yes to `tasks/framework-upstream-queue.md` (facet b: a NON-skill canonical agent-contract defect; Source is the contract, not the overlay) | Index recurrence makes the mechanism proposal mandatory (Rule 2). Facet (a) changes how `wire-it-through` applies here (overlay); facet (b) is a non-skill agent-contract defect (upstream queue). A pure skill-content gap would instead be overlay-only plus a `/cleanfiles` drain, never a fresh queue row (Rule 1 carve-out) | attended: approve the overlay write in-cycle; unattended: emit `### compound-learning-mirror: wire-it-through refinement (SLUG)` and drain at the next attended Step 7a |

Carve-out: a lesson that is ONLY a skill-content gap (no separate non-skill canonical
defect) leaves `Upstream queue?` = no and routes overlay-only, then promotes through the
`/cleanfiles` overlay-drain path.

## 2. Two-cycle unattended-produce then attended-drain

Cycle 1 (UNATTENDED). A skill-shaped lesson with no operator present. Per Rule 1, no
overlay write happens; instead a pending-mirror todo item is produced in `tasks/todo.md`:

```
### compound-learning-mirror: webhook idempotency on resource id (SLUG)
```

carrying (a) the exact proposed overlay entry text and (b) the stable source identity: the
canonical KNOWLEDGE heading `### [2026-08-05] [Pattern] -- webhook idempotency on resource id`.

Cycle 2 (ATTENDED). The Rule 4 drain runs BEFORE any new business:

- Ratify path: the drain verifies the source identity is ABSENT from the target overlay
  section (`## db-concurrency`), appends the stored entry text EXACTLY ONCE, and closes the
  todo item.
- Reject path (alternative): the operator rejects; the drain closes the todo item with the
  reason recorded in place, and no overlay write occurs.

## 3. Duplicate production (must NOT double-append)

An unattended cycle rediscovers the SAME lesson as an already-open pending-mirror item
(identical source identity). Before creating a new item, the search over open AND closed
pending-mirror items PLUS the target overlay section finds the open item. Result: the
existing item is referenced or updated, NOT duplicated. No second todo item is created, and
at the next drain the entry is appended exactly once. If the identity is already present in
the overlay (for example a concurrent build mirrored it), the drain closes as
already-applied WITHOUT appending. The exactly-once guarantee holds.

## 4. Same-day / same-title / different-category identity pair

Two lessons extracted the same day with the same title but different categories:

```
### [2026-08-05] [Correction] -- persist unless explicitly provided
### [2026-08-05] [Pattern] -- persist unless explicitly provided
```

Because the stable identity is the EXACT canonical heading (date AND category AND title),
these are TWO distinct identities and produce TWO distinct pending-mirror items. Date plus
title alone would have collapsed them into one and silently lost a lesson.
