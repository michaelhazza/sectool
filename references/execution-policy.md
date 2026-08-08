# Execution policy (work-packet `execution_policy`)

Normative semantics for the optional `execution_policy` object on `work-packet.v1` and its `effective_policy` echo on `completion-packet.v1`. Schema: `schemas/work-packet.schema.json`. Computation: `scripts/packet-contract/execution-policyPure.mjs`. Enforcement: **not in this contract** — see § Boundary.

## What it is

Capability-REMOVING metadata attached to a dispatch. Every field narrows what the executing role may do. No field can grant an authority the role did not already have; `deploy_authority` is a `const false` for exactly this reason. Absence of the object means **no policy was declared** — never "unrestricted".

## Composition: a conjunction, not a merge

The effective policy is a set of constraint lists evaluated together per path. It is NOT a merged pattern list.

```
path P is writable iff
      P matches allowed_files      (when allowed_files present)
  AND P matches write_scope        (when write_scope present)
  AND P matches no protected_paths entry
```

Glob intersection is not computable over pattern strings — intersecting `server/**` with `**/*.test.ts` means "test files under `server/`", which no string operation on the two patterns yields. Carrying both lists and evaluating the conjunction per path keeps composition pure, checkout-independent, and unambiguous across producers.

`effective_policy` on a completion packet therefore folds in the work packet's top-level `allowed_files`, so the echoed object is self-contained: a reader needs no access to the original packet to evaluate it.

## Field semantics

| Field | Meaning |
|---|---|
| `allowed_files` | (work packet, top level) Conjunctive allow list. Folded into `effective_policy`. |
| `write_scope` | Further narrowing of `allowed_files`. |
| `protected_paths` | Never writable. Overrides both lists above. |
| `destructive_actions` | `forbidden` \| `require_approval`. |
| `credential_access` | `none` \| `read`. Never `write`. |
| `network_egress` | `none` \| `allowlist`. `allowlist` requires a non-empty `egress_allowlist`; an allowlist without that mode is invalid. |
| `deploy_authority` | `false` only. |
| `expires_at` | RFC 3339. After this instant the policy must not be honoured. Evaluated by the dispatching coordinator, not by the schema. |

## Omission, emptiness, and normalization

- **Field omitted** — that constraint is unspecified; any restriction already carried by the packet (e.g. top-level `allowed_files`) still applies. Omission never widens authority.
- **Empty array** — "nothing allowed". Semantically distinct from omission, and preserved through normalization.
- **Empty object `{}`** — invalid. It cannot be distinguished from an authoring mistake, so the schema sets `minProperties: 1`.
- **Paths** are repo-relative, forward-slash, case-sensitive. Absolute paths, drive letters, backslashes, and any `..` traversal are normalization ERRORS. Leading `./`, redundant `.` segments and duplicate slashes are collapsed.
- **Patterns match files, not directories.** Symlink-escape prevention is enforcement-side; this contract is lexical only.
- **Glob dialect** is pinned to picomatch semantics with `dot: true`. The framework takes **no** glob dependency for this contract because nothing here matches a pattern against a path; the enforcement build takes the matcher and full parsing with it. This contract validates only the unbalanced-delimiter class (`[]`, `{}`, `()`).
- **Zero-match patterns are NOT errors.** `write_scope` routinely authorizes files that do not exist yet — creating them is most of what a builder does. Only syntactically invalid patterns fail. Reporting patterns that matched nothing against a real checkout is an enforcement-side diagnostic.

## Hashing

`normalizeExecutionPolicy(workPacket)` returns `{normalized_policy, effective_policy_hash, errors}`. The hash is a lowercase SHA-256 over the canonical serialization: sorted keys, sorted and de-duplicated arrays, normalized paths, whitespace-free UTF-8 JSON. Key order and array order in the source never change it.

The hash covers the normalized **declarations**, never a resolved file set. Two reasons, both load-bearing:

1. A coordinator must be able to recompute it from the work packet alone to detect policy mutation between dispatch and return. A resolved-set hash depends on checkout state and cannot be recomputed later.
2. A resolved set cannot express authority over files that do not exist yet.

When a packet declares neither `allowed_files` nor `execution_policy`, both `normalized_policy` and `effective_policy_hash` are `null` — "unspecified".

## Reporting compliance

`policy_evaluation` (`passed` \| `violated` \| `not_evaluated`) is how a completion packet says whether compliance was actually assessed. An empty `policy_violations` array cannot distinguish "checked, clean" from "never checked", which is why the enum exists. Absence of `policy_evaluation` must be read as `not_evaluated`.

## Boundary: this contract declares, it does not enforce

Shipped here: the shape, the composition semantics, normalization, the canonical hash, and validation that rejects internally contradictory policies in both validator modes.

Owned by the later enforcement build: recompute-and-compare of `effective_policy_hash`, `expires_at` evaluation at dispatch, matching patterns against a real checkout (`resolveEffectivePolicy(packet, repositoryPaths)`), symlink handling, cross-field reconciliation against `allowed_resources` (e.g. `credential_access: none` alongside a resource naming a secret), and any refusal behaviour.

Declaring a policy grants nothing and blocks nothing on its own. Treat a packet carrying `execution_policy` as documented intent until the enforcement build lands.
