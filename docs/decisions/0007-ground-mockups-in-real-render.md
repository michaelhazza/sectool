# ADR-0007: Mockups ground in real rendered output, not source inference

**Status:** accepted
**Date:** 2026-06-19
**Domain:** framework / mockup pipeline
**Supersedes:** —
**Superseded by:** —

## Context

The mockup pipeline (`mockup-designer` → `mockup-reviewer`, driven by `mockup-coordinator` / `spec-coordinator` Step 5) is the design source of truth for UI-touching builds. Products built primarily off mockups — before any validation, usability, or UAT pass has run against them — make the mockup load-bearing: any inaccuracy in a mockup propagates straight into shipped code as drift.

Two weaknesses amplified that risk:

1. **Grounding was inferred, not observed.** `mockup-designer` Step 0a grounded a new mockup by *reading the source `.tsx` files* of the pages it extended and inferring their rendered shape. The designer never saw the actual rendered page — real spacing, fonts, colours, component composition, current-state copy. `mockup-reviewer` then verified grounding by re-reading the same source, so a wrong inference by the designer could be confirmed as "grounded" by the reviewer. The mockup was an approximation of an approximation.

2. **Behaviour was unspecified.** The pipeline pinned layout (the five hard rules, mobile shape) but said almost nothing about interaction behaviour: reveal model, hover/press states, async loading/empty/error states, transitions, primary-action feedback, input behaviour. Unwritten behaviour is guessed at build time — "looks right but feels wrong" rework that surfaces late.

The "AI Website Cloner" pattern that motivated this change drives a real browser, reads the live DOM and computed CSS off every element (it observes, it does not guess), and explicitly captures behaviour. We adopt the *principle*, not the tool.

## Decision

**Mockups ground in the real rendered output of the surface they extend, not in a reading of its source — and interaction behaviour is a first-class, written deliverable.**

1. **Render-grounding (default-on when renderable).** A capture script (`scripts/mockup/capture-surface.ts`) drives the consuming repo's existing UI-test server + Playwright storageState auth to capture, per extended surface, a real screenshot at 375/768/1280, a de-duplicated page-wide token sheet, and a structured DOM outline (real nav, tabs, headings, column headers, status pills). The designer grounds in the capture; the reviewer (Axis 1) verifies the mockup against the capture, closing the "both trust the same wrong inference" loop. The capture manifest (`prototypes/{slug}/_captures/manifest.json`) is the contract, validated by `capture-manifestPure.ts`.

2. **Always degradable, never a hard gate.** When the surface cannot be rendered (server down, route gated, data absent, brand-new surface), the pipeline falls back to source-read grounding with an explicit, logged reason (`fallback_source_read` + reason, or `failed` + reason for an unrecoverable error). A failed capture never blocks a design round.

3. **Behaviour manifest.** `mockup-designer` Step 3c authors `tasks/builds/{slug}/behaviour-manifest.md` against a fixed checklist (`docs/behaviour-manifest-template.md`); `mockup-reviewer` Axis 4 gates its completeness (not its taste); `spec-coordinator` Step 6 pulls it into the spec under `## Interaction behaviour` so the contract survives into the build.

## Consequences

- **Positive:**
  - Grounding is verifiable against observed reality, not a re-read of the same source the designer used.
  - The reviewer can check the mockup's vocabulary against the page's real tab labels / column headers / status pills.
  - Interaction behaviour is specified before code, killing a class of "feels wrong" late rework.
  - Reuses the consuming repo's existing Playwright UI-test harness; no new browser-automation infrastructure.
- **Negative:**
  - The capture script depends on the consuming repo running a UI-test server with storageState auth at the conventional paths; repos without that harness only ever get the source-read fallback.
  - One more authored artifact per UI build (the behaviour manifest).
- **Neutral:**
  - Pure extractors + the manifest validator are unit-tested in the framework's Pure-split convention; the live capture is exercised in the consuming repo (the framework repo has no browser).

## Alternatives considered

- **Source-read grounding only (status quo).** Rejected — it is the inference-of-an-inference this ADR exists to fix; the reviewer cannot independently verify a wrong inference.
- **Generate the mockup from the capture (screenshot-to-React).** Rejected — out of scope; the capture grounds the designer, the designer still designs.
- **A multimodal model reads a screenshot and emits the tokens/vocabulary in one call.** Rejected — that reintroduces the guess (a vision model's transcription is not the page's real `textContent`) and is not deterministic enough for the reviewer to grep and trust. Mechanical Playwright extraction stays the source of observed truth.

## When to revisit

- If page-wide token-sheet fidelity proves insufficient, reconsider richer per-region or per-element extraction (deferred increment, §9 decision 1).
- If a consuming repo's UI-test harness changes shape such that the conventional server/auth paths no longer hold, update the capture script's reuse points (not this decision).

## References

- Spec: `tasks/builds/grounded-mockups-render-and-behaviour/spec.md`
- Capture contract + validator: `scripts/mockup/capture-manifestPure.ts`
- Capture script + extractors: `scripts/mockup/capture-surface.ts`, `scripts/mockup/capture-surfacePure.ts`
- Behaviour checklist: `docs/behaviour-manifest-template.md`
- Pillar agents: `.claude/agents/mockup-designer.md`, `.claude/agents/mockup-reviewer.md`, `.claude/agents/spec-coordinator.md`, `.claude/agents/mockup-coordinator.md`
