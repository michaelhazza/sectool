# Chunk learnings — ui-live-config

## C1 — TOTP verify module + `audit totp-init` CLI helper (2026-06-14)

**What was implemented.**
`src/ui/totp.ts` — RFC-6238 TOTP in ~80 lines using `node:crypto` only (no new deps).
`src/ui/totp.test.ts` — 18 pure-function tests including RFC-6238 Appendix B vectors.
`src/cli.ts` — `totp-init` added to `COMMANDS`, with `TOTP_INIT_USAGE`, `parseTotpInit`, `doTotpInit` (dynamic import pattern matching `doUi`), and a dispatch `case`.

**ASCII QR decision.** A real QR renderer needs Reed-Solomon polynomial arithmetic and mask-pattern logic (~400 lines). Per the plan's "use your judgment" note, `asciiQr()` prints the `otpauth://` URI prominently with enrollment instructions instead. This is the correct trade-off — no new dependency, no broken renderer, operator can paste the URI into any authenticator app.

**Watch-out for future chunks.**
- `src/cli.ts` uses ESM (`type: module`). Any dynamic module load in new CLI commands must use `import('…').then(…)` (not `require()`), matching the `doUi` / `doTotpInit` pattern.
- The round-trip test for `generateSecret` uses a local `computeHotp` helper in the test file (mirrors the totp.ts algorithm). If `hotp` is ever exported from `totp.ts`, prefer importing it in the test rather than keeping two copies of the algorithm.
- RFC-6238 test vectors: secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` (base32 of ASCII "12345678901234567890"), T=59s → counter=1 → code `287082`; T=1111111109s → counter=37037036 → code `081804`.
- C2 (`stepup.ts`) calls `verifyTotp` from `./totp.js` — the import path is `src/ui/totp.js` (ESM `.js` extension required). No changes needed to `totp.ts` for C2 to consume it.
