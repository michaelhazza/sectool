---
name: spec-hygiene
description: Use when authoring or editing a spec or implementation plan, when applying review findings to one, and when verifying an implementation against its spec. Covers grounding claims in the real codebase, keeping multi-section documents self-consistent, and the conformance checks that catch the recurring implementation-vs-spec gaps.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## spec-hygiene` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Spec and plan hygiene

Spec/plan/doc integrity is the single largest defect theme in review corpora — bigger than any code-level class, and review loops on specs/plans find more defects than code review does. The two dominant failure modes, in corpus order: documents that contradict themselves after edits (cross-section drift — the biggest single class), and specs that describe a codebase that doesn't exist. Both mislead builders more than no spec would.

## Ground every claim in the real tree

- Before referencing any file, column, route, tab, or helper: grep the live codebase and quote the verified identifier verbatim. Specs are routinely authored aspirationally, and plausible near-miss names recur constantly (`run_id` vs `iee_run_id`, invented helpers, phantom columns); if a referenced field doesn't exist, add it, route around it with a real fallback, or defer the feature — never hardcode null "to match the spec".
- Never hand-write counts, caller lists, or line ranges — regenerate from an anchored grep (`^import ... from`) at authoring time and state the command used. Substring greps inflate counts with comments and strings; a "25 call sites" claim that is really 16 misleads every downstream reader.
- Name paths/identifiers verified against the tree, or mark them proposed-new. At build time, grep every spec-named identifier: create it at the named location or record the rename as an explicit deviation — never silently relocate.
- Verify tooling assumptions (module system, npm scripts, test runner) rather than presuming; match the repo's existing harness patterns rather than inventing new ones. Treat embedded snippets and verification commands as production code: confirm scripts exist in package.json, guards are not always-truthy (`x === 'a' || 'b'`), the shell matches the actual environment. Verbal "tests are green" claims are not evidence — require pasted command output at final HEAD.
- Cite wire-truth (live code, actual schema), not the brief's citations — brief references drift between brief-lock and spec-authoring; live source wins.
- A new route over an existing integration is specced against that provider's ACTUAL auth/token persistence path — read the OAuth-callback write site, not a sibling connector's convention. A self-consistent spec built on the wrong premise passes every conformance check while the endpoint cannot work.

## Keep the document self-consistent

- After ANY edit changing a load-bearing value (count, enum list, migration number, section cross-reference, contract shape), immediately grep the whole document for the old value — such values always appear in goals, acceptance criteria, invariants, and inventories, and each missed copy costs a review round. Roughly a third of iteration-N review findings are ripples introduced by iteration N-1 fixes: the fix-application pass is the highest-drift moment. Re-derive numeric counts from the enumerated lists after every edit; never carry them forward.
- After a mid-review directional decision (semantics flip, contract change), run a propagation pass over every section describing the same semantic from a different angle (goals, success criteria, non-goals, audit checks).
- Each repeated topic (file lists, state machines, testing posture) appears once authoritatively with pointers, or the copies are verified to agree. Every state transition mentioned in prose must be legal in the state-machine section.
- Headline/summary claims must be exactly as strong as the body rule that implements them, and inline example payloads are read as normative — audit both against the invariants they restate.
- Resolved open questions are replaced with pointers to the resolution, not left verbatim — builders reopen them otherwise. Never hand off while an unresolved decision controls schema shape, an authorization key, or a mid-chunk branch: resolve it, pin a provisional default with a re-confirmation gate, or ledger it explicitly.
- Keep one authoritative files-to-change inventory; diff every path-like token in prose against it in both directions and Glob-verify each listed path exists (marking genuinely new ones NEW vs MODIFIED). Registration surfaces (route mounts, schema barrels, job-registration modules, permission registries, CI workflows) are the most-omitted entries — unregistered code ships dead while compiling green.
- Chunk plans: no chunk consumes a file, type, or primitive introduced by a later chunk; no two chunks edit the same shared file without an explicit ordering edge; "do X first" is meaningless unless encoded in the dependency structure. Simulate repo state if the build stopped after each chunk: every intermediate commit typechecks and leaves the app navigable; migrations never FK-reference later tables; order side-effecting steps for mid-sequence recoverability (exchange the OAuth code before deleting the single-use state row; cutover flags last).
- Chunk declared-files include the whole value-threading path: for every value a chunk produces that another file consumes, declare the producer, the carrier types, every signature it passes through, and the consumer — a surgically-scoped builder cannot wire an undeclared carrier, and the result typechecks while the feature is inert.
- Mechanical integrity: closed code fences (one unclosed fence swallowed nine sections), valid UTF-8, every relative href verified from the file's actual directory.

## Contract-level rules that prevent build drift

- Every "must / guaranteed / idempotent / exactly-once / immutable / single source of truth" claim names its concrete enforcer — convert to "MUST X, enforced by Y, verified by Z" and negative-test Z. Verify the mechanism can observe what it claims: a validator over active rows cannot guarantee an all-rows invariant, a CHECK constrains values not transition direction, a TypeScript union is erased at runtime. If no mechanism can be named, downgrade the claim or move it to open questions.
- State uniqueness invariants first-class (invariant → enforcing constraint → downstream ON CONFLICT consumers), never introduced only as backing for upsert wording.
- Every closed enum gets a single source-of-truth; conformance diffs the spec's member list against code value-by-value (count and names). Never reference a state without defining it in the enum table. Copy spec-locked literals verbatim from the source-of-truth file, never from memory — internally consistent renames still typecheck while silently breaking the spec as source of truth.
- Every "fall back to default X" rule pins: storage location of the default, lookup interface with null semantics, behaviour when absent/invalid/cross-tenant, and the configuration UX — unpinned defaults make sibling builders invent divergent implementations. Pin every derivation likewise (hash canonicalisation, closed error-code enums, UTC windows, retry tie-breaks) and each distinct zero-row cause of an optimistic UPDATE (already-done vs expired vs not-found map to different responses) — each missing rule is a fork where two implementers produce incompatible behaviour.
- Every acceptance criterion is deterministically checkable at landing time by its owner with the repo's actual harness — no wrong-framework idioms, no nonexistent npm scripts, no local runs of CI-only gates. Dry-run each check against the planned end state: diff pathspecs exclude the build's own new files, time budgets exceed measured wall time, grep gates are tested against every existing valid code shape. No OR where enforcement is mandatory; thresholds locked before implementation.
- Doc-only acceptance criteria name a concrete artifact, a row shape, and a terminal zero-counter — never "spot-check". Claims over item sets get per-item build/defer/closed verdicts in one table, not blanket assertions.
- When RLS enforces only the coarse tenancy boundary and a finer boundary is "service-layer", the spec names the equality predicate and the fail-closed drop in the consumer contract — a claim that "no signal crosses the finer boundary" can otherwise be satisfied while leaking.
- Enumerate guards/preflight checks as numbered, individually-verifiable items with typed rejection reasons; at build time verify each check has a code path that can fire (grep the reason strings). An override flag whose underlying check doesn't exist is an automatic red flag.
- Spec-named events, audit rows, and log codes are first-class requirements with named emit sites; verification greps each literal and requires a producer.
- Migration chunks: separate "build the script" from "run the script" — readers accept both formats first, writers switch + script runs in the same chunk. Ask of every chunk boundary: "do persisted artifacts and live writers agree on format here?"
- Data mirrored from a polled external provider: absence from an incremental poll is NOT deletion; tombstoning requires a full-reconciliation pass or webhook semantics. A false tombstone hides live records.
- Multiple ingest paths into one canonical table (poll, webhook, manual, import) must each satisfy the same FK/CHECK contracts; a fix in one path is incomplete until symmetric paths are patched in the same commit.
- Two-concern columns stay separate: "can this be used" (gate) and "has it been verified" (audit signal) as one merged state creates dead-ends with no exit.
- Kill-switched migrations need agreeing fallback at BOTH the suppression layer and the dispatch layer, or there's a valley of failure between flag-on and fully-rolled-out, invisible in single-tenant dev.
- Diagnostic/test-send paths are a separate contract from production dispatch: map each production gate (approval, safety checks, rate limits, audit) to applies/bypassed/discriminated explicitly.
- Route via declarative capability rules, not hardcoded per-target if-statements in the orchestrator; platform-wide invariants live in the architecture doc, and any spec special-casing one agent/mode against a universal primitive is suspect.

## Conformance verification (implementation vs spec)

Checks that catch the recurring gap classes, in order of yield:

1. **Unwired artifact**: for every spec-named artifact, verify a production consumer on the execution path (see the wire-it-through skill) — the #1 gap across all builds.
2. **Absent/relocated artifact**: grep every spec-named identifier.
3. **Enum drift**: member-by-member diff.
4. **Pinned-literal drift**: extract every literal the spec pins (intervals, caps, defaults, precision) into a checklist and diff verbatim — fully mechanical.
5. **Missing guards/emissions**: grep the numbered checks' reason strings and event names.
6. **Doc-sync**: a reference-doc section added in the build must use the same vocabulary as the spec and code it describes.
7. Verify literal value-class conformance, not just type conformance: a `string[]` of titles where the spec pins run-ids typechecks and is wrong; expect doc drift to accompany implementation drift.
8. A conformance log outlives its spec: re-read the spec (including remediation notes) for each item before drafting fixes from an old log. The spec after build-time amendment is the single source of truth over plans and stale logs.
9. **Parity-by-prose**: every "same shape as X" clause is verified by structurally diffing the two implementations (tx open, lock acquisition, optimistic predicate, terminal idempotent path, conflict response) — not by confirming the sentence exists. It is the cheapest spec construct and the easiest conformance miss.
