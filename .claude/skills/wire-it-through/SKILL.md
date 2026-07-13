---
name: wire-it-through
description: Use whenever adding a new capability (table, service, route, job, event, component, field, enum value) to verify it is wired end-to-end before calling it done, and when adding fields that cross serialization or client-server boundaries. The single most common build failure across all review history is a component that exists, compiles, and is tested — but is never called.
---

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## wire-it-through` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

# Wire it through

"Shipped but unwired" is the #1 conformance gap across hundreds of builds: the migration lands, the service exists, tests pass — and the hot path never touches any of it. Existence is not integration.

## The done-check

For every new artifact, name and verify its CONSUMING call site on the production execution path:

- **Table** → at least one production read AND write (every column read somewhere must be written somewhere; a `started_at` no path writes makes the recovery sweep blind).
- **Service method** → the route/job actually calls it (routes writing the table directly while the service sits unused is the classic shape).
- **Route** → mounted in the app registry; client actually calls it; navigation points at routes that exist. The mount path is part of the contract: if middleware reads `req.params.X`, the mount contains `:X` (a global mount makes every read silently empty); Express child routers under a `:param` mount need `Router({ mergeParams: true })`; routers declaring full paths mount bare — grep a sibling's mount line first, because a double-prefixed mount 404s everything and no static gate sees it. Register more-specific paths before broader parameterised matchers, and enumerate the status map the middleware chain implies (401, 403-vs-404 rule, 400 mechanism, unique violations → 409).
- **Job/worker/handler** → a producer enqueues it AND the startup wiring registers it. `register()`/`schedule()` exports are inert until the boot loop calls them. Registration of domain primitives at boot is unconditional (not nested in an env conditional one consumer needs), and registration-validation failures log-then-RETHROW — a half-booted process that 500s on every dispatch is worse than a clean crash. Registering a worker does NOT schedule its cron: the boot-time schedule call is separate, and it must pass the job's declared singleton key.
- **Event** → emitted name matches consumed name byte-for-byte; at least one producer exists for every consumer (a UI subscribing to an event nothing emits renders permanently empty). Verify a NON-TEST production caller (grep excluding `__tests__`) — an emitter "used" only by its own tests keeps every gate green while live updates silently degrade to poll-only; prefer emitting at the state-transition choke-point so every path emits without per-caller wiring.
- **React component** → imported and rendered from its entry point in the SAME commit as the definition. "Component done" means visible, not compiled.
- **Pure helper** → the production path calls it; a green test on an unwired helper is a dead test. A pure helper called as a bare statement with its return value discarded is a no-op bug.
- **Callback/seam on a shared wrapper** → fulfils an "everywhere" requirement only when every in-scope caller wires it; grep all call sites, each passes it or carries a marked exemption.

Before classifying an uncalled handler as dead code: if the services it imports are live, it is almost certainly a missing WIRE, not a DELETE.

## Fields crossing boundaries

- Trace a new field end-to-end in ONE pass: request schema → handler destructuring → service input type → persistence write. A field missing from the service type means the handler silently derives or drops it and TypeScript can't tell you.
- When fields are added to a type that crosses a serialization boundary (JSON envelope, queue payload, RPC), update the envelope constructor in the same commit — each layer's isolated check passes while the end-to-end path is dead at the boundary. Layer-by-layer review structurally cannot catch this; only cross-file grep does.
- Never accept-then-silently-drop a request field; never let the UI mark editable what the service rejects.
- `JSON.stringify` drops `undefined` fields — a struct stripped for storage cannot be reconstructed downstream; rebuild from local state at the consumption point. Conversely, when a contract reserves `undefined` for "leave untouched", adapters must EMIT `undefined` for non-authoritative payloads — routing through a `string | null` normaliser collapses absent to null (= clear), making the preserve state unreachable.
- Payload completeness: walk the consumer's immediate NEXT action — a retry UI needs per-delivery IDs, not aggregate state; an event emitted before the action executes cannot carry duration or outcome; asynchronously produced values are nullable in the synchronous response with a stated population path. Never write an external provider's identifier into an internal UUID FK column.

## Client ↔ server contract

Build client hooks against the server route's actual validation schema, not from memory:

- Strict schemas reject extra fields (one injected extra field 400s every request); field names must match exactly; response wrappers (`{ thing: row }`) must be unwrapped.
- Compile-green is not contract conformance when shapes are stringly/JSON typed — several "Save" buttons shipped as silent no-ops. Exercise the full request path once, or share types both sides import.
- Enum values shipped by the server must all be mapped by the client (and vice versa); a client branch on a status the DB enum doesn't contain is dead code that will lock someone out.
- Producer and consumer import ONE shared contract type; enum/event-name literals come from the canonical constants module, never hand-typed — camelCase JSONB writes vs snake_case reads compile cleanly and fail silently. Read the actual producer before writing the consumer, and walk each consumer read back to storage (a "flips from pass to fail" predicate needs a persisted baseline column). Hand-rolled `res.status().json()` envelopes diverge from the central error middleware.
- Assemblers/projectors with a published contract need a three-way match: emitter write-shape ↔ reader read-shape ↔ contract doc. Two-of-three is drift — doc+emitter agreeing against the reader is the silent-fallback bug; ship a parity test driving each documented field through the real read path.

## Value sets and renames

- A value set (status enum, kind, reason code) is typically enumerated in 4+ places: SQL CHECK, ORM schema, validation schema, state-machine table, query filters — plus prompts, agent configs, and docs. When adding or renaming a member, grep every enumeration INCLUDING non-code files; fixing only schema/types leaves stale copies silently enforcing old behaviour. `WHERE type = 'old'` whitelists silently ignore the new value; exhaustive switches take no `default`; sweep sweepers, display mappers, fixtures, and `vi.mock` registrations too. Discriminator columns downstream logic branches on are closed unions with an explicit unknown-value policy, never free text.
- Every state needs a named owning writer (a worker claiming `status='ready'` while rows insert as `'pending'` no-ops forever), and a column tied to a status transition is honoured by EVERY writer that flips that status — grep every `SET status = '<target>'` site, ORM and raw; updating only the first writer found makes the column's NULL ambiguous.
- New literals land in every canonical registry in the same commit: permission constants missing from the seed array leave routes silently ungrantable; DB-validated components must exist in the catalogue table, verified against a clean database. String-identifier renames and file moves/renames (repo-wide sweep, zero-match post-rename grep): see the refactor-safely skill.

## Canonical sources and stores

- Read paths invoke the SAME parser the write boundary uses — canonicalisation is not validation; a canonicaliser-only read silently accepts malformed legacy/drifted rows. For every `parse*` function, grep stored-field consumers for canonicaliser-only reads.
- Before adding a table/column/endpoint/flag, check whether an existing primitive covers it. When two stores can hold the same data, write down which is canonical per read path and the precedence rule; each mutable field gets exactly one named writer at one lifecycle point; derive enumerations from the canonical registry at load time, never parallel hardcoded arrays.
- Reusing a primitive means satisfying its validated contract: required payload fields, enum membership, options carried over, exact engine semantics ("max attempts" vs pg-boss `retryLimit` is an off-by-one). Call sites reaching around an established wrapper lose its guarantees (direct token decrypt skips expiry refresh; direct db imports bypass the service tier and its gate).
- Never emit placeholders (`''`, `new Date()`, `'UTC'`, template text) for fields the schema or runtime supplies — thread the real value or make the type nullable. "Configurable via ENV_X" or "derived from column Y" means grep the actual read: a hardcoded literal with the right default still fails the contract.
- Capability-eligibility registries are consulted BEFORE stored per-user preference rows — eligibility wins over presence; a stale enabled-row must not trigger delivery after a tier/registry change.
- Server-stored/frozen contract state is derived and persisted server-side when not explicitly posted — never implied by a UI default — and mirrored back into the UI on load.
- Shared create/update normalisers inject environment-derived defaults (browser timezone etc.) only on CREATE; update paths send exactly the fields the user changed, or the default silently overwrites the stored value on every partial update.
- Reconcile-against-set (resolve-on-absence) helpers must receive the COMPLETE currently-derived set — passing only the item being added resolves every absent-but-still-valid standing item as a side effect; seed a standing item in the test and assert it survives.
- Entity counts exactly equal to a provider's page-size cap indicate first-page-only ingestion, not completion — page to exhaustion or an explicit caller cap.
- Depend on an unmerged sibling contract via a narrow-mirror type + a no-op emission port, never a direct import or full re-declaration; the eventual binding is a mandatory field-for-field diff of the live contract.
- Pure-layer helpers never import DB-bound services and server schema modules never reach client code — typecheck passes while the client bundle breaks, so run the client build in the chunk that introduces the boundary.

## Paired surfaces

- When one path writes a value a second path must handle later (token expiry ↔ refresh-on-expiry; provider added ↔ every switch dispatching on provider), extend both in the same change — the failure arrives one token-lifetime later.
- Two adjacent sites recording the same logical value (telemetry attr + audit row) share the identical conditional expression — never hardcode one side on a happy-path assumption.
- Two UI surfaces over the same timeline data share the same send path and projection renderer, or messages exist in storage but never appear.
- When adding an emission/log/audit call to a multi-return function, grep for ALL return statements and catch branches and decide per-path — the natural "wire the obvious return" misses exactly the failure paths that matter. A diff adding an emission to one return of a multi-return function is a review smell.
- A recipient-set ("who") override must not bypass the channel-enablement ("whether") gate: when layering an override beside an existing gate, the new branch forgets the gate the original applied — resolve the shared gate ONCE above the branch point and diff the branches' preconditions side by side.
- A flag routing traffic to a new transport is ANDed with a runtime readiness check (with fallback to legacy) and accounts for rows the legacy path still owns until drained; boot-time completeness validation breaks intermediate states when adapters land across chunks — make it lazy or gate behind final cutover.
