# Freshness and applicability

When acceptance is required, when a `proceed` is legitimate, and when prior evidence goes stale. The classifier `scripts/uat/classify-change.mjs` is the deterministic authority; this document is the reasoning behind it.

## Applicability

Acceptance is REQUIRED for major changes and any UI, database, money, auth, authorization, migration, async job/state-machine, external-provider, export, email, or user-visible behaviour change; when the diff crosses two or more architectural boundaries; and when automated coverage relies materially on mocks at a changed boundary. It is USUALLY non-applicable for prose-only documentation, test-only changes that do not alter fixtures or runtime config, and internal tooling that cannot affect shipped behaviour. Tooling or configuration changes that affect build, packaging, deployment, migrations, or runtime ARE applicable. A `proceed` requires the classifier to prove non-applicability, plus a written reason and SHA-bound evidence — never a silent waiver.

## The three staleness classes

A binary runtime/non-runtime split misses a whole class of change, so the classifier emits three:

- **`application-impacting`** — rerun verify + UAT. Application source, migrations, routes, packaging.
- **`acceptance-harness-impacting`** — rerun UAT (verify only if otherwise required). The acceptance skill, `scripts/uat/**`, the evidence schema/validator, the classifier tables, fixture generators, framework-pointer bumps, and project UAT configuration. A file can be non-runtime to the application while still changing *what acceptance means*.
- **`acceptance-inert`** — evidence may remain valid. Genuinely prose-only docs and comparable non-semantic changes.

Unknown paths default to `application-impacting` (conservative — never skip UAT on a path the classifier does not understand). Across many changed paths the most severe class wins, and a rename is classified on both its old and new path. Never remove boundary coverage solely because it has been green recently.

## SHA freshness and the certification tail

Acceptance binds to an exact `code_candidate_sha`. A runtime-impacting change after acceptance invalidates the evidence and forces a rerun on the new SHA. But UAT itself produces durable reports/status/evidence committed after testing, so the remote head at merge legitimately differs from the tested SHA: the model is `code_candidate_sha = X` (what every substantive gate tested) and `certification_head_sha = Y` (the head after certification artifacts land), where the tail `X..Y` must consist entirely of permitted certification-only changes. That tail is operation-aware, not path-global: creating the expected hash-bound certification artifacts is allowed once; any later modification, deletion, or rename of binding UAT evidence is invalidating — so an edit to `uat-evidence.json` plus its recorded digest is caught, not waved through as "inert". No committed file contains its own commit SHA; `certification_head_sha` is derived from git after the commit exists.

## proceed rules

`proceed` is legitimate only when the change cannot affect shipped behaviour: truly documentation-only, test-only that alters no fixture/runtime config, or tooling that cannot reach the runtime. It always carries a written reason and current SHA, and it is validated by a refusal row like any other verdict — an unjustified `proceed` refuses the merge exactly as a `fail` does.
