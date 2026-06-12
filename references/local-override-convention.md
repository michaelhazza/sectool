# LOCAL-OVERRIDE convention (framework v2.10.0+)

Framework files can declare named slots where the consumer can insert app-specific content. `sync.js` extracts the consumer's content from those slots before deploying a framework update, then re-injects it. The consumer's customisations survive across framework updates without manual merging.

## Syntax

```markdown
<!-- LOCAL-OVERRIDE:start name="some-slot" -->
... consumer content here ...
<!-- LOCAL-OVERRIDE:end name="some-slot" -->
```

- HTML comments — invisible in rendered markdown, ignored by agent loaders that parse the file as a system prompt.
- `name` attribute identifies the slot. Names must match `^[a-z0-9][a-z0-9_-]*$` (lowercase alphanumeric + dash/underscore, must start with alphanumeric).
- Names must be unique within a file.
- Nested blocks are NOT supported.
- Markers must be balanced (every start has a matching end).

## How it works during `sync.js`

When `sync.js` updates a file:

1. Read framework canonical content; apply substitutions.
2. Scan for `LOCAL-OVERRIDE` markers in the framework version.
3. Read the consumer's existing copy (if any); extract whatever's between the consumer's matching markers.
4. For each slot the framework declares, inject the consumer's content into the framework version (replacing the framework's default content for that slot).
5. Hash the result and write to disk; record the hash in `.framework-state.json`.

The hash recorded in state is the **post-injection** content hash. So:

- Consumer edits **inside** a slot → next sync sees diverged hash, recognises the divergence is within slot boundaries, re-injects, updates hash. **No `.framework-new` written.**
- Consumer edits **outside** a slot → next sync sees diverged hash, divergence is not absorbable, writes `.framework-new` for manual merge. **The `.framework-new` still has the consumer's in-slot content preserved**, so the diff against the consumer's file shows only the out-of-slot drift.

## Authoring a slot in the framework

1. Pick a clear name (`project-notes`, `examples`, `custom-rules`, etc.).
2. Place the start/end markers around a section the consumer might want to extend.
3. Put a sensible default between the markers — used by any consumer that hasn't filled the slot. Often an HTML comment explaining the slot's purpose:

```markdown
<!-- LOCAL-OVERRIDE:start name="project-notes" -->
<!-- Consuming projects: add project-specific guidance here. -->
<!-- LOCAL-OVERRIDE:end name="project-notes" -->
```

4. Document the slot in any reference doc that lists framework extension points.

## Using a slot as a consuming project

1. Open the deployed file in `.claude/`, `docs/`, etc.
2. Find the slot you want to fill. Replace the framework default content between the start/end markers with your project's content.
3. **Do not edit outside the markers.** Out-of-slot edits trigger a `.framework-new` diff on the next sync, blocking the update flow.
4. Re-run `sync.js` — your in-slot content is preserved; the file's hash in `.framework-state.json` updates.

## Removing a slot

If the framework removes a slot (the start/end markers no longer appear in the framework version), any consumer content that was inside that slot is dropped on the next sync. The runner logs `WARN: consumer has LOCAL-OVERRIDE block(s) not declared by framework: <names>` so the operator notices.

Before removing a slot in the framework, consider whether to:
- Migrate consumers off the slot first (via a migration script in `migrations/`)
- Rename it (delete the old slot in one release, add the new slot in the same release — operators see the warning and re-paste)

## What slots are NOT for

- **Mechanical configuration values** — use substitution variables (`{{PROJECT_NAME}}`) instead. Faster, no per-file authoring needed.
- **Wholesale file rewrites** — if the consumer's customisation rewrites most of the file, that file probably doesn't belong in the framework canonical at all. Consider moving it to a `template` mode entry (deployed once, then consumer-owned).
- **Cross-file structural changes** — slots are within-file extension points. If the consumer needs to add a whole new file or restructure a directory, that's a different mechanism (manifest entries, ADRs, custom hooks).

## Reference implementation

`sync.js` exposes the parsing and injection helpers as exports:

- `parseOverrideBlocks(content)` — returns `{ blocks: Map, errors: string[] }`
- `extractOverrideContents(content)` — returns `Map<name, string> | null`
- `injectOverrides(framework, consumerOverrides)` — returns `{ result, frameworkBlockNames, orphanedConsumerNames, errors }`
- `injectConsumerOverrides(framework, consumerPath)` — convenience: reads consumer from disk

Unit smoke tests live in `scripts/__tests__/local-override-smoke.js`. End-to-end smoke tests in `scripts/__tests__/local-override-e2e.js`. Both run standalone via `node <path>`.
