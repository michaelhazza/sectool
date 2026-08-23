# Scenario matrix (Codex run-final-uat)

Shared substrate with the framework `acceptance-testing` skill. The single editing home is `scripts/uat/risk-to-scenario-policy.json` (synced into consumer repos); this document and the framework skill's `scenario-matrix.md` are human-facing views of that ONE policy — never a divergent copy. The evidence validator's coverage cross-check reads the JSON, not this prose.

## Risk tags and mandatory families

For every domain-risk tag on the change, cover ALL listed families (a `pass` is impossible otherwise) except those marked "when relevant":

- **`ui-browser`** — real navigation; loading (distinct from empty/zero); populated success; genuinely empty; real zero; failure/fallback; responsive/interaction-critical (when relevant); no unexpected console/network errors.
- **`database-route-migration`** — apply every migration to an empty disposable DB; upgrade a realistic prior state; a real route against stored rows; constraints/RLS/ON-CONFLICT; backup/restore (when relevant).
- **`async-state-retry`** — lease/lock/state transitions; failure; retry; timeout; duplicate request; stale-job recovery; honest API status.
- **`money-precision`** — exact zero; dust; exponent forms; negative values; **values above `2^53`**; zero-decimal currencies; FX fallback; display/execution separation; **aggregate → route → screen exact-value identity**.
- **`auth-tenant`** — authenticated success; unauthenticated/unauthorized denial; cross-tenant negative control; credential isolation; session behaviour.
- **`export-email-artifact`** — machine-usable content types; display values; screen-to-export identity; locale/currency metadata; generated content and attachments.
- **`external-provider`** — recorded/sandbox contract; outage/timeout/rate-limit/fallback; no real financial action; no secret leakage.

## Composition

Risk tags compose. A money route rendered in a browser and exported must exercise the SAME seeded identity across the database, the API response, the rendered screen, and the exported artifact — one canonical value flowing end to end, not four unrelated toy fixtures. That identity chain is what exposed the calibration defect.

## Anti-vacuity proofs

Prove the intended branch ran with a STRUCTURED proof, not prose: an observed record count (>0 for a data-requiring path), a seeded id/value (e.g. an exact total of `9007199254820993`), a branch marker (the fallback/error/retry branch specifically executed), or a response field the oracle checked. A 200 with an empty collection, zero trades, or an unseeded page proves nothing about a path that requires data.

## Exact-value and boundary selection

Choose fixtures that would break a plausible wrong implementation, not round friendly numbers. For `money-precision`: values above the IEEE-754 safe-integer boundary (`> 2^53`), zero-decimal currencies (JPY), sub-minor-unit dust, negative and exponent forms, and an aggregate whose exact total is preserved from storage through the route to the screen. For state machines: interleaved/out-of-order arrivals. The boundary case is the point of the lane.
