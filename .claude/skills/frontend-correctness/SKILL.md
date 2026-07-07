---
name: frontend-correctness
description: Use when writing or modifying React component logic — state lifecycle (modals, drawers, forms, hooks), async races (fetches, polling, SSE/WebSocket consumers), permission gating, client API adapters, or data-handling bugs. Engineering correctness, not visual design. Sibling: invoke frontend-design-check alongside when the change alters what the user sees — layout, copy, controls, or a new UI surface.
---

# Frontend correctness (React)

The recurring client-side bug classes from review history. All React/TypeScript.

## Component state lifecycle

- A component gating on `if (!open) return null` stays MOUNTED — useState persists across close/reopen, so stale errors and fields reappear next open. Extracted modals need a `useEffect` on `open` that resets owned state (the original host unmounted via conditional JSX; extraction created the bug). Alternatively `key={item.id}` to force remount — pick one pattern and apply it consistently. Reset on open/close/success only — never discard user input on a FAILED submit.
- A drawer/modal reused across selections retains async-fetched state from the prior item until the new fetch resolves — or forever if it fails. Reset all async-derived state at the start of the effect.
- Form builders hydrating from a loaded entity must fully rebuild state on entity switch (absent items explicitly disabled) and re-serialise the complete config on save — patching over previous state leaks the prior entity's config.
- Seeding state from external identity without clobbering user edits: track last-seeded values in a ref and compare in the functional setState form (non-functional setState reads a stale closure).
- A presentational component that normalises a value for display must emit the normalised value in every `onChange({...value})` spread — otherwise it launders the raw value back to the parent on every unrelated edit.
- A URL query param is a modal TRIGGER, not modal state: deriving `open` from the param and stripping it on mount closes the modal on the next render — decide once into `useState` at first render, strip the param in the close handler.
- Edited output rides the action callback as an explicit parameter, never side-channel state the parent must remember. A modal that fires a non-idempotent action (send/approve) then calls a record endpoint needs a `finalised` flag so retrying the record step never re-fires the action.
- A component cannot consume a context it itself provides — split into an outer provider and inner consumer.

## Async races

- When a keying prop (entity id, period) changes, reset dependent async state AND guard in-flight fetches with a request token/cancellation so a late response can't overwrite the new context — a late response for entity A must not populate state a save then PUTs to entity B. Guard catch/finally on request currency too; error paths clear previous data. Routers reuse component instances on param change — reset per-entity state or `key` the component.
- Async fetchers clear loading flags on EVERY path — an early return before the try/finally hangs the spinner forever.
- Effects with async fetches need a cancellation/staleness guard (set-state-after-unmount, stale-response races).
- Polling hooks: mutable gates (isRunning) live in a ref, not useCallback deps, so callback identity stays stable; timers in a second ref so they're cancellable on unmount.
- SSE/WebSocket `onError` handlers clear ALL connection-derived state themselves — internal callback ordering (onReconnecting first) is not a contract. Native EventSource cannot set custom headers — auth must ride cookies/query or a polyfill.
- A manual socket `connect()` does not fire the library's reconnect event (Socket.IO emits `'reconnect'` only on automatic reconnection) — call the resync explicitly beside the manual connect, or every foreground-after-background keeps stale state.
- Event-observing waits are armed BEFORE the triggering action (`Promise.all([waitForX(), act()])`) — armed-after misses fast completions; presents as flakiness that worsens on fast backends. Event sources initialising pre-mount (SW registration, analytics) keep a module-level already-fired flag; `subscribe(cb)` invokes immediately when it's set, so late `useEffect` subscribers don't miss the event.
- Service workers: declare API paths NetworkOnly explicitly (caching defaults don't inspect the Authorization header), set navigateFallback to the SPA shell (`/index.html`, not a static offline page — that breaks every post-install page transition), and denylist API paths from the fallback so API 404s aren't masked by the shell.
- iOS Safari fires window `focus` before the input `change` on return from the file picker — focus-as-cancel cleanup on programmatically-mounted file inputs defers (~300ms), gates on `input.files.length === 0`, and carries an idempotency flag against double-removal.
- `window.open()` must be called synchronously in the user-gesture handler — any `await` before it severs the gesture link and popup blockers silently kill it. Check the return value to surface the blocked case.
- Sibling components sharing state through a parent: derive in-flight display state from a parent-owned counter (increment before POST, decrement on the authoritative signal), never from a child's cleared local state.
- Self-contained data-fetching components fire a duplicate fetch when nested under a parent that owns the same hook — accept an optional `data` prop; the internal hook is the standalone fallback.

## Gating, permissions, errors

- Permission-gated UI fails closed during async load: `permissions === null` = denied; hold page loading until both resource and permission fetches resolve — the flicker window fires protected requests that 403.
- Client adapters never swallow errors into empty results (`catch { return [] }`) — log and return a fail-closed shape so auth failures don't masquerade as zero data.
- UI calling an adapter that returns a success flag must branch on it — a toast on `emitted: false` is a false-success defect even against a stub.
- A context/provider whose null-default is shape-identical to a failure state makes consumers render error UI where none exists — add an explicit `hasScope`-style flag and gate failure indicators on it.
- Persisted client identity (localStorage workspace/account ids) is validated against the URL and server before use — stale values silently point the UI at the wrong tenant.
- Compare against stored enum values, not derived display labels — `role === 'derived_label'` where that string is never stored is dead code that locks out the users it meant to admit.
- No outer layer redirects on a boolean collapse of a tri-state an inner guard owns — a shell flattening `loading → false` bounces validly-configured users on hard refresh/direct URL (the least-tested paths). Same rule for props: `string|null` cannot distinguish loading from resolved-to-none; carry a status discriminant.
- Pass raw nullables to derivation helpers; the helper owns both the null-check and the fallback label — a caller pre-mapping `value ?? 'Unknown'` hands it a truthy string, so "missing" classifies as a healthy state.
- Cross-check every status-conditional action button against the state machine's valid-from states for the row's current status — button mapping and transition table are authored separately, drift silently, and surface as runtime 409s on the most common path.

## Data handling

- Hierarchical lists: group → filter → sort, never filter → group (filtered-out children leave parents with dead affordances; filter controls top-level visibility only).
- Percentage fields: establish `*Pct` (display as-is) vs `*Rate`/`*Fraction` (×100) naming and verify the stored unit at the producer before writing any formatter — a generic pct() on a 0-5 score renders 400%; ×100 on an already-percentage renders 5% as +500%. Different scales on one page get separately-named formatters. Define rounding for numerics interpolated into copy.
- Structured config through a textarea: parse on change into local draft state, emit the parsed object only on successful parse with inline errors — binding the raw string silently disables downstream checks.
- Reusable form components derive every HTML `id`, `htmlFor`, and radio `name` from a per-instance prop — hardcoded values collapse multiple instances into one browser-level group, invisible on the first instance.
- JS-side sorts that must preserve a DB ORDER BY replicate the full comparator chain with tiebreakers, ending in a stable id as the determinism anchor. Derived sorts live in `useMemo`.
- Never merge semantically distinct states ("check failed" vs "couldn't determine") at the data layer — collapse only at the UI summary level; they carry different operator actions. Every server-emitted state value reaches an explicit client branch — values handled only by a `default` arm are dead ends.
- Per-row supplemental metadata: one batched fetch + client-side Map join, never per-row GETs — the N+1 shape works in dev and degrades to a render storm in production.
- `type="button"` on every non-submit button (HTML defaults to submit); the list key goes on the outermost mapped element (`<Fragment key=…>`, not `<>`); never nest buttons — a clickable row containing buttons is `div role="button"` with key handling (browsers reparent nested buttons); recursive tree renders carry a visited-set guard. When lint lacks React rules these are review-only checks — verify the plugin actually loads before trusting green.
- Components that can recursively open themselves (embedded editors) take an `embedded` prop suppressing recursive-open affordances.
- No dead-end affordances (links/buttons to deferred pages). Once-per-lifetime dismiss flags need the read path to create the row the dismiss path UPDATEs.
- Tenant-facing copy never exposes internal hierarchy/tier vocabulary — "inherited" without saying from where; provenance belongs in admin surfaces. Grep user-visible strings against locked copy invariants (banned vendor/protocol vocabulary, punctuation rules).
