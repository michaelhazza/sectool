# Blind-planner hermetic runtime contract

> The launch contract for the sealed blind-planning stage of the fresh-context UAT gate (plan A6, rounds 3–5). The blind planner derives the scenario plan from raw inputs BEFORE any prior conclusion is readable; this document pins the runtime that makes "blind" mechanical rather than prompt-based. The snapshot that feeds it is built by `scripts/uat/build-blind-snapshot.mjs`; the frozen plan it emits is `uat-plan-blind.json`. `acceptance-phase` cites this contract; it does not restate the flags.

## Why a sandboxed working directory is not enough

An OS command sandbox seals the working directory. It does NOT seal Codex's other context channels, each of which can leak the expected defect into a "blind" pass:

- global `AGENTS.md` loaded from `CODEX_HOME`;
- user-level and system-level skills;
- MCP servers, plugins, and connectors;
- `web_search`;
- model memory (persisted across sessions);
- session continuation (`resume`, a prior thread id);
- the coordinator's inherited environment (variables, launch credentials).

This session empirically confirmed the operator's Codex loads dozens of plugin skills regardless of `cwd`. Blindness therefore requires a hermetic runtime, not just a scoped filesystem.

## The hermetic contract

The blind planner launches with ALL of the following, and the effective configuration is hash-bound into evidence as `planner.blind_runtime_config_sha256`:

1. **Isolated instruction root.** An isolated `CODEX_HOME` (or `--ignore-user-config` plus explicit `-c` overrides — both verified on the installed binary) so no global `AGENTS.md`, user skills, MCP servers, plugins, or hooks load. The candidate source sits under `inputs/source/`, NOT as the project root, so candidate `AGENTS.md` files are inspectable data, never auto-loaded instructions. The exact hashed `.agents/skills/run-final-uat/` harness copy is injected by the snapshot builder — the historical calibration candidate predates the skill, so the harness is always explicitly provided, never resolved from an uncontrolled user-level copy.
2. **Web search off.** `web_search` explicitly disabled — a separate control from network sandboxing.
3. **Memory off.** `memories.use_memories=false` and `memories.generate_memories=false`, set explicitly, never inferred from user defaults.
4. **No session continuation.** No `resume`, no prior thread id, no session-continuation mechanism; evidence carries a fresh-context assertion (`planner.fresh_thread=true`) proving the planner thread/context id was newly created.
5. **Clean environment allowlist.** The planner launches with a clean environment allowlist rather than the coordinator's environment; launch credentials are not readable by model-executed commands; evidence records the sanitised variable NAMES/policy (`planner.sanitised_env_var_names`), never values.
6. **No approval escalation.** Approval/escalation paths that could broaden the sandbox are disabled.
7. **Filesystem + network scoped.** Filesystem scoped to the sandbox root; network off.

The planner exits after producing the frozen plan.

## Blindness is proven, not asserted

Asserting launch flags is insufficient — a flag says what was requested, not what leaked. An **adversarial isolation fixture** proves the boundary by attempting and FAILING all five escapes from inside the hermetic runtime:

1. reading a known file outside the sandbox root;
2. command-line network access;
3. Codex web search;
4. a preconfigured external MCP / plugin lookup;
5. retrieving a seeded parent-process environment canary (`UAT_BLIND_CANARY=<known diagnosis>`).

All five must fail. This fixture is part of Forward validation (plan §9) and gates enforcement; it is not a launch-time assertion.

## Threat-model boundary (stated plainly)

The gate excludes supplied, local, account, and external context. It CANNOT prove the model's weights contain no prior public knowledge. "Hermetic" means sealed inputs, not an amnesiac model. This boundary is deliberate and recorded so no one over-claims what blindness buys: it buys that the plan was not shaped by this repo's prior conclusions, diagnoses, or fix notes — not that the model has never seen a money-precision bug in its training data. The generalisation claim is carried by the §9 holdouts, not by the hermetic runtime alone.

## Handoff to execution

A Codex CLI blind planner feeding a Codex Desktop executor is a first-class flow: blindness is spent in the isolated planning stage, so Desktop need not satisfy the blind-sandbox contract — it executes the frozen-plus-augmented `uat-plan.json` under its own safety contract. The planner and executor are separately identified in evidence (`planner.*` vs `execution.*`), and the two-sided plan-digest handoff binds the frozen plan across the boundary.
