# Brief: AI-surface rule pack + shared evasion corpus + first full scan of automation-v1

**Date:** 2026-08-07
**Source:** External audit of NVIDIA SkillSpector (`NVIDIA/SkillSpector`, v2.5.3) commissioned 2026-08-06, cross-checked against both this repo and automation-v1. Verdict there: do not adopt SkillSpector; borrow its threat catalogue and patterns.
**Suggested classification:** Significant (new rule category, cross-repo corpus contract).

## Problem

sectool's rule set covers classic web security (auth, SQL, CORS, JWT, RLS, XSS, uploads, websockets) but has **zero AI-surface rules**. Breakout's products are AI agent platforms: they assemble LLM prompts from tenant content, execute model-directed actions, host an MCP server (`server/services/hostedMcpServer/` in automation-v1), and store agent skills. None of the risks specific to that surface — prompt injection sinks, unsafe model-output handling, tool poisoning, encoded-payload evasion — are scanned today, by this tool or any other in the stack.

The SkillSpector audit demonstrated the stakes concretely: that scanner (14k stars, NVIDIA-backed) rated a Base64 "decode and execute" payload `SAFE` in static mode. Evasion-resistant rules and a paired adversarial corpus are what separate a useful scanner from a false-confidence generator.

## Why sectool (and not a new tool or SkillSpector adoption)

- sectool already has the chassis SkillSpector was praised for: SARIF output (`src/report/sarif.ts`), expiring suppressions with justification/approver (`src/report/baseline.ts`), per-family skipped-state accounting (`src/static/orchestrator.ts`), and a paired vulnerable/clean benchmark measuring recall/precision (`benchmark/run.ts`).
- Adding a rule is the designed extension path: Semgrep YAML in `rules/semgrep/` or AST rule in `src/static/rules/`, doc in `docs/rules/`, paired fixtures in `benchmark/corpus/static/<RULE-ID>/{vulnerable,clean}/`.
- SkillSpector's strengths are Python-focused; our stack is TypeScript, which sectool's ts-morph engine already parses.
- Adopting SkillSpector itself was assessed and deferred: 151-package Python sidecar, alpha status, defends artifact types (bundled executable skill code) our products do not ship yet.

## Goal A — AI-surface rule pack

Candidate rules, derived from the SkillSpector threat catalogue and grounded in what our apps actually do. Spec decides the final set and per-rule severity; candidates ordered by expected value:

1. **BS-AI-001 Prompt injection sink.** Tenant/user-controlled text concatenated or interpolated into an LLM prompt/system message without passing a recognised boundary/sanitisation helper. AST rule (template literals and string concat flowing into LLM client calls).
2. **BS-AI-002 Unsafe model-output handling.** LLM response text flowing into an execution or injection sink: `eval`/`Function`, `child_process`, SQL builders, `dangerouslySetInnerHTML`, `fs` path arguments, dynamic `fetch` URLs. Taint-style AST rule; this is the highest-severity class in the catalogue.
3. **BS-AI-003 Decode-then-execute.** Base64/hex/URL-decode of untrusted content whose result reaches an execution or interpretation sink. This is the exact pattern SkillSpector missed (`SAFE`, score 0).
4. **BS-AI-004 Invisible/confusable text.** Zero-width characters, bidi overrides, and homoglyph runs inside prompts, skill/tool definitions, or source string literals. Pattern rule; cheap and high-signal.
5. **BS-AI-005 Tool poisoning.** MCP/agent tool *descriptions* containing imperative model-directed instructions (instruction-in-description heuristic) or descriptions materially exceeding the declared input schema.
6. **BS-AI-006 Secrets/PII into prompts.** Env vars, config secrets, or credential-shaped values interpolated into prompt payloads or prompt logging.
7. **BS-AI-007 Unallowlisted model-directed egress.** Model-influenced dynamic URL passed to HTTP clients without an allowlist/validation call in the path. (Mirrors sectool's own live-scan allowlist invariant, applied to product code.)
8. **BS-AI-008 MCP invocation posture.** Hosted-MCP invocation routes missing auth/rate-limit/admission middleware (extends BS-AUTH-001/002 semantics to the MCP surface).

Each rule lands with the standard contract: rule + `docs/rules/BS-AI-*.md` (what/why/fix/acceptance/fixture) + paired benchmark fixtures + benchmark thresholds green.

## Goal B — shared evasion corpus (cross-repo contract)

A versioned corpus of **inert attack strings and paired benign twins** covering: literal, multilingual, homoglyph, zero-width, split-field, and Base64/hex-encoded prompt injection; credential-solicitation phrasing; decode-then-execute snippets; tool-poisoning descriptions. Stable IDs per case.

- **In sectool:** consumed as benchmark fixtures for the BS-AI rules.
- **In automation-v1:** vendored as a pinned copy consumed by the SynthetOS content-scan kernel's corpus tests (`server/services/contentScan/__tests__/corpus.test.ts`) to prove the *runtime* tenant-content gate blocks or flags every case, with false-positive rate measured on the benign twins.
- No cross-repo runtime dependency; a versioned fixture directory with a pinned-copy convention is sufficient. Spec decides layout and sync mechanics.
- Safety: every case is inert text; nothing executable, no routable hosts (use reserved/`.invalid` domains), consistent with the existing corpus conventions.

## Goal C — point sectool at automation-v1

1. `config/targets.json` lists automation-v1 with `gitUrl: https://github.com/breakoutsolutions/automation-v1.git`; the repo actually lives at `michaelhazza/automation-v1`. Verify and fix the registry entry (schema-validated edit path).
2. Run a full static scan (existing rules + new BS-AI pack) against automation-v1; triage findings into that repo's backlog with sectool's prioritised report as evidence.
3. Live/DAST scanning: `config/allowed-staging-hosts.json` is empty. Adding a staging host is an operator action through the 2FA-gated dashboard flow — out of scope for this build, listed for sequencing only.

## Non-goals

- Adopting or wrapping SkillSpector (deferred; revisit trigger recorded in the audit: skills carrying executable code, third-party skill/bundle imports, or external MCP server vetting).
- Replacing or coupling to SynthetOS's runtime content-scan kernel — sectool audits our source pre-ship; the kernel gates tenant content at runtime. The corpus is shared; the enforcement paths stay independent.
- YARA/binary malware signatures, Python AST analysis, dynamic execution of scanned content.

## Acceptance sketch (spec refines)

- Each shipped BS-AI rule meets the benchmark's recall/precision thresholds on its paired fixtures.
- Corpus cases carry stable IDs; the benign-twin false-positive rate is reported by the benchmark run.
- Full-scan report for automation-v1 produced and persisted; registry entry corrected.
- All four base gates green (`lint`, `typecheck`, `test:unit`, `build`) plus `benchmark`.

## References

- SkillSpector repo: https://github.com/NVIDIA/SkillSpector (pin a commit if any pattern is ported; Apache-2.0 — retain notices on copied source).
- Audit deliverable (report, synthetic corpus, scan results, fail-closed adapter POC): held by operator, produced 2026-08-06.
- automation-v1 kernel entry points: `server/services/contentScan/` (rulesPure, profiles/skillsProfile, corpus tests), `server/services/hostedMcpServer/`.
