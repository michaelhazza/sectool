---
name: db-concurrency
description: Use BEFORE writing upserts, idempotency keys, state-machine transitions, queue/webhook handlers, retry logic, locks, or any code where two writers, workers, or retries can race. Also use when designing "check then act" flows, dedupe keys, or crash-recovery sweeps.
---

# Database concurrency and idempotency

Check-then-act races, wrong conflict keys, and retry re-fires are the second-largest real-defect class in review history. Postgres/TypeScript specifics labeled.

## Upserts and idempotency keys

- SELECT-then-INSERT is never concurrency-safe; use `INSERT ... ON CONFLICT`. Two racing writers both observe "no prior row".
- Never catch a unique-violation (23505) and recovery-SELECT inside the same Postgres transaction — the raised error aborts the tx and the recovery query fails. Use `ON CONFLICT DO NOTHING RETURNING id` (SQL-level no-op) then re-select the winner. Invisible in DB-mocked tests.
- A bare untargeted `onConflictDoNothing()` swallows ANY unique violation, including unrelated ones. Always name the exact conflict column set. A targeted ON CONFLICT does not observe OTHER unique constraints, so still catch 23505 — matching the specific constraint via `err.constraint`, never "any 23505 = expected conflict" (regression test: an UNRELATED 23505 rethrows). The recovery re-select must mirror a partial arbiter index's WHERE predicate (e.g. `deleted_at IS NULL`) or a soft-deleted row returns as "active".
- The idempotency key captures "what makes two CALLS the same call", not "two CALLERS the same caller". If a caller can make multiple legitimate distinct calls, add a per-call discriminator (natural id or content hash).
- Exclude any per-attempt value (sequence, timestamp) from the conflict key — a conflict target that never collides is worse than none.
- Canonicalise free-text key components (trim, fixed-locale lowercase, NFC); never hash truncated inputs; keep key columns NOT NULL or COALESCEd (unique indexes treat NULLs as distinct).
- Test BOTH failure directions: distinct items collapsing to one key, and retries minting distinct keys (epoch seconds vs ms).
- The enqueue/dedup key encodes the same granularity as the storage constraint.
- Derive created-vs-updated from the upsert's return (`RETURNING`, `xmax = 0`), never a preflight existence SELECT. Ask the database what happened; don't ask twice.
- Webhook idempotency keys on the provider's per-delivery EVENT id (plus type), never the resource id — providers send multiple events per resource.
- Time-bucketed default idempotency keys protect double-clicks but coalesce intentional rapid triggers: document that programmatic callers must supply explicit keys. Don't "fix" with per-request UUIDs — that trades silent-drop for duplicate execution.
- The exactly-once guard PRECEDES the irreversible side effect: acquire a durable claim/slot BEFORE the external send (or push idempotency into the effect via a key the downstream enforces). A post-hoc 0-row UPDATE or bare `onConflictDoNothing` after the send makes only the bookkeeping exactly-once — two racers both fire.
- Same discipline for ACKs: never return 200/202 or ACK a webhook before the promised effect is durable (the provider won't retry), and inspect failure-shaped results (`{success:false}`) on every dispatch path.
- Exactly-once test shape: `Promise.all([op, op])` against a counting fake — the external-effect counter must equal exactly 1.
- MVCC snapshot isolation protects the first run only: rows committed after the first tx's snapshot ARE visible to a retry's fresh snapshot, and a query-side timestamp cutoff can't close it. Guard write-side: refuse to create the row once the one-time event fired. Pending-only dedupe is likewise not replay-safe — record the triggering id in the row (same trigger = replay = suppress; new trigger = legitimate re-propose).
- A per-row flag on an upsert appears in BOTH `.values()` AND every `onConflictDoUpdate` SET clause at every write site — on the hot path only SET runs, silently reverting a values-only flag to the column default. Test the conflict path, not just the insert.

## State transitions

- Every state-changing UPDATE carries the full guard predicate — expected-from status, version/claim fence, tenant — and asserts affected-row count via RETURNING/rowCount. Id-only UPDATE after a read check is a TOCTOU bug. Emit the success log only in the confirmed branch; a lost race surfaces as 409/no-op, never success.
- A `version` increment in SET without `AND version = <prior>` in WHERE looks like optimistic concurrency but never closes the window.
- When a guarded UPDATE affects 0 rows, enumerate ALL legal row states in the response mapping — a two-branch "completed vs everything else" hides timing-window states.
- The terminal-state write is the LAST write in a multi-write success path; a catch block only ever writes the failure transition.
- Verify code performs only transitions the state machine declares; grep for status strings that don't exist in the machine (client filters on phantom statuses recur).
- Single-writer coordination losers return `{ success: true, suppressed: true, reason }` — "another writer beat me" is a healthy outcome; returning failure triggers retry storms and false incidents. This never applies to genuine breakage (connection lost, malformed payload, permission denied).
- Apply the same fence to every OR-arm of a multi-branch UPDATE predicate — "this arm can't need it under current invariants" is a caller-side assumption a future call site silently bypasses.
- Settle/cleanup workers dedupe on the ROW being updated, never its parent — per-parent dedupe short-circuits all sibling rows after the first. Shape: conditional per-row `UPDATE ... WHERE status = 'x' RETURNING id` (empty = already settled, non-empty = this run owns the transition).

## Locks and critical sections

- `SELECT FOR UPDATE` only holds inside an enclosing transaction; outside one it serialises nothing. It also cannot lock ABSENT rows — "only one active X" and aggregate-cap checks (SUM-then-INSERT, MAX+1 counters) need `pg_advisory_xact_lock`, a partial unique index, or serializable isolation. Re-verify ALL validity predicates inside the lock, not just the one that motivated it.
- Never hold a row lock or open transaction across an LLM call or any I/O with >~100ms tail. Classify-before-lock: read and validate unlocked, do the slow work, then open a fresh transaction for a compare-and-set write.
- Multi-item slow-work loops: batch-claim tx → per item {single-row claim (SKIP LOCKED + stale TTL) → slow call outside any tx → guarded write, cost billed only on the winning write} → finalize tx. LLM-specific budget re-read rules for this shape: see the llm-integration skill.
- External side effects run AFTER commit, never inside the transaction callback (a later throw rolls back the DB but not the world). Queue sends inside a tx do not enlist in it: rollback leaves jobs pointing at nonexistent rows, and a job enqueued before commit references rows the worker can't see. Conversely "commit, then throw" inside a tx callback is a trap — the helper rolls back on any throw; return a sentinel and throw after.
- Cross-connection effects cannot see the ambient tx's uncommitted rows — a service opening its OWN tx/pool connection fails FK inserts or claims 0 rows deterministically, and wrapping it in a fresh tx does NOT fix it. Defer via a post-commit store flushed strictly after commit (reset on rollback); make the deferred create retry-idempotent (23505 → return the existing row) and return a RETRYABLE error, not 500, on enqueue failure. Services accept the caller's tx handle (tx-first signature); inner queries on the outer handle make the wrapper decorative.
- Pin single-use token ordering per flow: consume-and-commit dispatch tokens BEFORE the external call; consume OAuth state only AFTER the exchange succeeds.
- Dual writes (DB row + provider resource + object store) specify source of truth, write order, idempotency key, and orphan-cleanup owner.
- Object-store idempotency gates the storage write on DB claim ownership: commit-fence UPDATE `WHERE id=? AND claim_token=? AND state='uploading'` first, then one unconditional PUT — never delete-then-put.
- A retry that re-reads a stored artifact re-verifies bytes against the committed content hash before re-delivering (mismatch → rethrow for retry).
- Type-green SQL that fails at runtime: `pool.query('BEGIN')`/`COMMIT` hit different pooled connections and create no transaction — lease one client. Know the driver's result shape (postgres-js `execute()` returns the row array; node-postgres returns `{rows}`); normalise via one helper. Postgres can't parameterize interval literals; `''` into a uuid column throws 22P02; `RETURNING id` fails on composite-PK tables.
- Advisory locks: `hashtext(uuid)::bigint` gives 32-bit entropy (sign extension); use the two-arg int4 form from the UUID hex. Session-level locks: check the boolean unlock return (false = invariant violation), attempt unlock-all recovery, and let a release failure outrank the primary error — a stuck lock on a pooled connection blocks all future callers.
- Singleton-per-scope install flows: transaction-scoped advisory lock for the clean error path PLUS a partial unique index as the race net, mapping unique-violation to 409.
- Lazy single-acquisition over shared async state: publish the pending promise to the slot synchronously BEFORE any await; `if (slot === null) slot = await open()` has a microtask race.
- One transaction handle = one connection: never `Promise.all` concurrent queries on a single tx handle (driver interleaving, busy errors). Sequential is correct.

## Queues, retries, recovery

- Every re-enqueue/manual-retry site passes the queue's configured retry/backoff/expiry policy — relying on defaults silently downgrades reliability. Retry counters carry through BOTH returned-error and thrown-error paths.
- Classify provider failures before retrying: permanent (auth, invalid recipient) → mark failed + dead-letter + ack immediately; only transient rethrows to the retry policy. Collapsing all to one class either burns the retry budget on the unfixable or suppresses the retry machinery.
- Structurally invalid payloads from external/version-skewed producers: `safeParse` + log + ack (they never succeed on retry); reserve throwing `.parse()` for producers you control. Never migrate a defensive handler to throwing without policy approval.
- A handler re-enqueueing a deferred job for its own entity must not reuse the entity's singleton key verbatim — the active job owns it and the enqueue silently no-ops; namespace by attempt. Resumable multi-page jobs make the queue payload the durable state (optional phase/cursor fields, one page per execution, worker enqueues the continuation) — and the continuation's singleton key must differ from the operator-trigger dedupe key (incorporate phase+cursor) or the trigger dedupe deadlocks the job's own chain.
- Stuck-row reclaim thresholds strictly greater than the worker's expiry timeout (rule of thumb 2×); the real overlap protection is the per-row status predicate on the reclaim UPDATE.
- Reclaim admit + ownership stamp are atomic in ONE UPDATE — the queue is not a lock manager (expiry releases the job lock but doesn't cancel the running handler); the application row is the ownership source of truth.
- The reclaim predicate admits EVERY state a retry path can leave the row in (crash-mid-flight leaves `running`, soft-failure rollback leaves `pending`) and re-asserts the converged invariant in SET.
- When reclaim rides the job's own retry budget (no sweeper), the LAST retry must land after the stale-claim timeout or the row strands — assert the cumulative schedule in a test.
- Cross-check every status a writer SETS against every consumer's FILTER set — rows written outside it are invisible or stuck forever (persisting 'failed' while pickup claims only 'pending' means retries never happen). FOR UPDATE SKIP LOCKED breaks per-entity ordering; cursors advance only over contiguous prefixes.
- "Committed" (idempotency arbiter) ≠ "delivered" (customer durability): post-commit delivery is a separate failable effect — explicit `delivered_at` set only on success, rethrow on delivery failure, re-deliver idempotently on committed-but-undelivered retries. Verify any claimed "reconciliation backstop" actually exists before accepting a swallow.
- Retry loops never mutate their canonical input: snapshot before the loop, restore at the TOP of every attempt body — reassigning the loop variable on success feeds the transformed value into the next attempt, skipping guards keyed on the transformation. Invisible to single-attempt tests; test with retries > 0.
- Process-local NEGATIVE caches silently drop work in multi-instance runtimes: a per-process "absent" marker with same-process-only invalidation makes a side-effecting miss permanent. Precedence: don't cache negatives; else shared store with transactional version bump; else cross-instance invalidation (LISTEN/NOTIFY).
- Producer/consumer payload contracts are decided at the producer: a nullable source column vs a non-null payload schema means either the schema admits null or the emission predicate excludes it — never let the worker's parse failure be the filter (burns retries, pollutes dead-letter). When an emission needs an FK target the caller hasn't inserted yet, decouple: return a prepared-emission payload and let the caller emit after its own insert.
- Pre-attempt guard hooks inside retry helpers are in-process only — cross-process dedup needs a queue singleton key, advisory lock, or unique-constraint write. Ask in review: "what if two workers race here?"
- "Row committed then enqueue fails" and "external send then crash before commit" both need an explicit answer: outbox pattern, reconciliation sweep, or a claim column with claimed-at TTL (claim via conditional UPDATE → do work → stamp done-at; sweep retries unstamped terminal rows).
- Rate limiters counting rows in a sliding window: if the in-flight row is inserted before the check, exclude it from the count — otherwise the effective limit is N-1.
- Cap/budget predicates count settled + reserved + current estimate; failed external actions write a real failed ledger row (pending-claim plus terminal-outcome).
- Never key cost attribution off a column overwritten mid-run; cached paid results don't inherit the original expiry.
- "Purge N days after state X" keys on a state-entry timestamp set by the transition, never `created_at`; sweeps keyed on nullable FKs silently never clean; authoritative expiry is (status, expires_at) together.
- Before any throw/early-return, release everything acquired (reservations, registry entries, terminal-status stamps); release closures are idempotent because independent cleanup paths race.

## Ordering and determinism

- Every sort, pagination cursor, "latest row" pick, cap eviction, and dequeue order needs a total order ending in a unique immutable tiebreaker (id) — Postgres row order without ORDER BY is undefined and second-precision timestamps collide. Keyset cursors tuple-compare the FULL ordering tuple (`(ts, id)`, never ts alone), with every UNION arm projecting every ordering column; push all filters into SQL before ORDER BY/LIMIT.
- Any `ORDER BY ts DESC` feeding an idempotency hash carries a secondary unique-key sort — equal-timestamp rows reorder between retries → different serialisation → different hash → a second paid side effect instead of a dedupe hit.
- Functions declared pure take time as a parameter (`asOf`, never internal `Date.now()`), own no caches or emits, and hash canonical serialisations (sorted keys, NFC). Persist `*_at_dispatch` snapshots when downstream logic needs start-time values; cron registrations carry the IANA timezone explicitly.
- Set-based rewrites of per-row loops pin what the loop guaranteed implicitly (sort RETURNING rows back to input ordinals; in-batch duplicate ownership). Supersedes-pointer tables: `WHERE pointer IS NULL` returns originals, not replacements (anti-join or canonical flag); latest-status reads order by createdAt DESC (plus id) BEFORE inspecting status.

## Time

- Values feeding dedupe keys, cursors, or predicates compared against DB columns come from DB time (`transaction_timestamp()`) in the same transaction — never `Date.now()`, and never an app-clock fallback when the DB query fails (fail closed; skip the tick). Elapsed-time for timeouts/billing computes both endpoints in SQL.
- In per-row → batched-INSERT refactors, never collapse per-row timestamps into one batch-build-time `new Date()` — ordering and sequencing consumers observably diverge. Drive post-batch reconciliation from the source-ordered input array, and wrap the bulk INSERT in its own try/catch so in-memory-resolved entries survive a write failure ("if the bulk INSERT throws, what survives?").
