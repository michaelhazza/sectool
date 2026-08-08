# Review lenses

Four perspectives every plan review must sweep. Applies to `claude-plan-review`, `plan-reviewer` (Codex) and `chatgpt-plan-review` (OpenAI). Optional `lens` field on `review-finding.schema.json`.

## Why

Without named perspectives, a reviewer with finite attention converges on whichever failure class is easiest to see — usually engineering feasibility, because it is the most concrete. Value, design and operability failures then reach the operator unexamined, and a plan that is cleanly chunked but builds the wrong thing passes review. Naming the four makes an unreviewed perspective visible as an omission rather than invisible as a non-finding.

## Coverage and tagging are different obligations

- **Coverage is mandatory.** Every plan review considers all four lenses. A lens that produced no findings is stated as reviewed clean, not silently dropped. Silence is indistinguishable from "did not look".
- **Tagging is conditional.** A finding carries `lens` only when ONE lens is clearly dominant. Cross-cutting findings omit the field. Forcing a lens onto a finding that spans three degrades the signal — an unclassified finding is fine, a miscategorised one is not.

## The lenses

### `product_value`

Does the plan deliver what the spec promised, to the person the spec named? Hunts: work that no user outcome depends on; a chunk sequence where the valuable part lands last and gets cut; scope that quietly widened past the spec; success measured by "shipped" rather than by an observable change.

Examples — a plan whose first four chunks build infrastructure with no user-visible result; a plan implementing a generic engine when the spec asked for one profile.

### `engineering_feasibility`

Will this actually build in this order, in this codebase? Hunts: prerequisites that do not exist when a chunk needs them; fictional dependencies; contracts referenced but never defined; primitives reinvented where an accepted one exists; acceptance evidence too weak to prove the chunk landed.

Examples — chunk 6 imports a helper first written in chunk 9; a plan asserting a table has a column it does not have.

### `design_quality`

For plans touching a user surface: does the result belong to the product a person already uses? Hunts: a new page where an existing surface would do; internals leaking into operator-facing copy; a flow needing explanation before it can be used; hand-rolled components where house ones exist.

Skip with a one-line note when the plan touches no user surface — the lens is inapplicable, not clean.

### `developer_experience`

What is it like to operate, debug and hand off this thing after it ships? Hunts: failures that surface with no diagnosable signal; state a second session cannot reconstruct; manual steps with no runbook; work that leaves the next agent guessing what "done" means; a contract nobody is instructed to produce.

Examples — a job that swallows errors and reports success; a new packet field with no producer told to emit it.

## Reporting

**Claude and Codex tiers** (prose report): close with a bounded decision brief, five lines maximum — the recommendation, the strongest surviving objection per unsatisfied lens, and which lenses reviewed clean. This is prose, not JSON: the review-result schema is closed and `claude-plan-review` forbids inventing fields.

**OpenAI tier** (JSON only): record lens coverage inside the existing `integrity_check` string, e.g. `"product_value and design_quality clean; findings under engineering_feasibility and developer_experience"`. Set the optional per-finding `lens` under the same dominant-lens rule.

Lenses change WHAT a reviewer looks for. They do not change how many rounds run — iteration caps in `references/iteration-caps.md` are unaffected — and they grant no reviewer write authority.
