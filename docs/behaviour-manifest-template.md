# Behaviour manifest — audit-tool build `{slug}`

The behaviour manifest is the interaction contract for every screen in a mockup. Layout (the mockups) says *where* things sit; this manifest says *how* they behave. `mockup-designer` Step 3c authors it; `mockup-reviewer` Axis 4 gates its completeness; `spec-coordinator` Step 6 pulls it into the spec under `## Interaction behaviour` so it survives into the build.

**How to use this template.** Copy one `## Screen: {screen-id}` block per screen the mockup produces. Answer every row, or mark it `n/a` with a one-line reason. The six row labels are fixed and grep-able — do not rename them. An unanswered required row is an incomplete manifest (Axis 4 raises 🔴); an `n/a` without a reason is 🟡.

The manifest is the contract. Demonstrating a behaviour inline in the prototype (hover styles, click-to-expand, skeleton-then-content) is encouraged where cheap but never required.

---

## Screen: {screen-id}

**Extends:** `client/src/pages/{path}.tsx` (or the surface this screen grounds against)
**Tier:** 1 | 2 | 3 (per `mobile-capability-principles.md § Mobile capability tiers`)

- **Reveal model** — scroll-driven vs click-driven vs always-visible for each major section; which content is progressive-disclosure (tab, drawer, expand-on-click) vs on first paint.
  - _Answer:_

- **Interactive states** — for every interactive control: default, hover, focus, pressed/active, disabled, loading. Every hover state declares its tap equivalent (mobile has no hover).
  - _Answer:_

- **Async states** — for every data region: loading (skeleton vs spinner vs nothing), empty, error, populated. Not just the happy path.
  - _Answer:_

- **Transitions and motion** — any animation, transition, or scroll behaviour the design depends on (smooth-scroll, sticky-on-scroll, sheet/drawer slide-in, optimistic-then-reconcile). Name the intended behaviour; a library may be named as a reference only.
  - _Answer:_

- **Primary-action feedback** — what the operator sees after the one primary action fires: inline state change (preferred), toast, navigation, or modal.
  - _Answer:_

- **Input behaviour** — validation timing (on-blur vs on-submit), coupled-field enable/disable (group fields whose any-subset-set is meaningless), mobile keyboard-open handling (focused input stays visible, submit reachable).
  - _Answer:_

---

<!-- Repeat the "## Screen: {screen-id}" block above for each screen this build produces. -->
