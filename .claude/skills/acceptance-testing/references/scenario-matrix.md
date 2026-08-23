# Scenario matrix

The risk-to-scenario matrix, its composition rule, anti-vacuity proofs, and exact-value selection. This is a human-facing view of the machine-readable policy at `scripts/uat/risk-to-scenario-policy.json` — that JSON is the single editing home; this document never diverges from it, and the Codex `run-final-uat` skill renders the same source. The evidence validator's coverage cross-check reads the JSON, not this prose.

## Risk tags and mandatory families

For every domain-risk tag on a change, the listed families are mandatory unless marked "when relevant". A tester covers *all* required families or the verdict cannot be `pass`.

- **`ui-browser`** — real navigation; loading (distinct from empty/zero); populated success; genuinely empty; real zero; failure/fallback; responsive or interaction-critical states (when relevant); no unexpected console/network errors.
- **`database-route-migration`** — apply every migration to an empty disposable DB; upgrade a realistic prior state; a real route against stored rows; constraints/RLS/ON-CONFLICT behaviour; backup/restore (when relevant).
- **`async-state-retry`** — lease/lock/state transitions; failure; retry; timeout; duplicate request; stale-job recovery; honest API status.
- **`money-precision`** — exact zero; dust; exponent forms; negative values; **values above `2^53`**; zero-decimal currencies; FX fallback; display/execution separation; **aggregate → route → screen exact-value identity**.
- **`auth-tenant`** — authenticated success; unauthenticated/unauthorized denial; cross-tenant negative control; credential isolation; session behaviour.
- **`export-email-artifact`** — machine-usable content types; display values; screen-to-export identity; locale/currency metadata; generated content and attachments.
- **`external-provider`** — recorded/sandbox contract; outage/timeout/rate-limit/fallback; no real financial action; no secret leakage.

## Composition

Risk tags compose; do not test them as separate toys. A money route rendered in a browser and exported must exercise the SAME seeded identity across the database, the API response, the rendered screen, and the exported artifact — one canonical value flowing end to end. That identity chain is exactly what exposed the calibration defect: the money machinery was correct in isolation but the aggregation path supplied it inexact input.

## Anti-vacuity proofs

A test must prove its intended branch ran. Record a structured proof, never free text:

- **observed record count** — the route returned N stored rows (N>0 for a path that requires stored data).
- **seeded id / value** — the exact seeded identifier or value the assertion targeted (e.g. an exact total of `9007199254820993`).
- **branch marker** — a signal that the fallback / error / retry branch specifically executed.
- **response field** — the concrete field whose value the oracle checked.

A 200 with an empty collection, zero trades, or an unseeded page proves nothing about a path that requires data — the validator rejects a passing scenario over a data-requiring family whose proof shows no seeded/stored data.

## Exact-value and boundary selection

Choose fixtures that would break a plausible wrong implementation, not round friendly numbers. For `money-precision` this means values above the IEEE-754 safe-integer boundary (`> 2^53`), zero-decimal currencies (JPY), dust below one minor unit, negative and exponent forms, and an aggregate whose exact total is preserved from storage through the route to the screen. For state machines, choose interleaved/out-of-order arrivals. The boundary case is the point of the lane; a lane that only exercises the happy middle is vacuous coverage.
