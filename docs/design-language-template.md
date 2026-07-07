# Design Language — audit-tool

> **TEMPLATE.** Copy to `docs/design-language.md` in the consuming repo and fill
> every `<...>` slot. This doc is the **how it looks** half of the two-doc
> contract; `docs/frontend-design-principles.md` is the **what goes on screen**
> half. `mockup-designer` reads this file every round; `mockup-reviewer` grades
> Axis 5 (visual craft) against § Craft bar. Keep it short enough to re-read
> per round — under ~200 lines.

## 1. Brand personality

Three adjectives and one sentence. Everything below must be derivable from
this line. Example: "Calm, precise, quietly confident — an expert tool that
never shouts."

- Adjectives: `<a> · <b> · <c>`
- One-liner: `<sentence>`

## 2. Type system

| Role | Family | Weight | Size / line | Usage rule |
|---|---|---|---|---|
| Display / page title | `<family>` | `<weight>` | `<size/line>` | `<when>` |
| Section heading | `<family>` | `<weight>` | `<size/line>` | `<when>` |
| Body | `<family>` | `<weight>` | `<size/line>` | default text |
| Small / meta | `<family>` | `<weight>` | `<size/line>` | timestamps, captions |
| Mono / data | `<family>` | `<weight>` | `<size/line>` | ids, code, tabular numerals |

Max two families. Name the pairing rationale in one sentence.

## 3. Colour tokens

Tokens live in the canonical token sheet (`prototypes/_tokens.css` by
default) — THIS table is their meaning; the sheet is their value. Never
hard-code a hex in a prototype; reference the token.

| Token | Value | Role |
|---|---|---|
| `--bg` | `<hex>` | page background |
| `--surface` | `<hex>` | cards, panels |
| `--border` | `<hex>` | hairlines, dividers |
| `--text` | `<hex>` | primary text (≥ 4.5:1 on `--bg` and `--surface`) |
| `--text-muted` | `<hex>` | secondary text (≥ 4.5:1 where must-read) |
| `--accent` | `<hex>` | THE accent. One per product. Links, primary buttons, active states |
| `--accent-contrast` | `<hex>` | text on accent |
| `--ok` / `--warn` / `--danger` | `<hex>` ×3 | state colours — semantic ONLY, never decorative |

Dark-mode variants: `<same table or "not yet — light only">`.

## 4. Spacing, radii, elevation

- Spacing scale: `<e.g. 4 / 8 / 12 / 16 / 24 / 32 / 48>` — no off-scale values.
- Radii: `<e.g. 6px controls, 10px cards, 999px pills>`.
- Elevation: `<levels and their shadow values — prefer 2 levels max; borders over shadows for structure>`.

## 5. Motion

- Durations: `<e.g. 120ms micro / 200ms panel>`; easing `<curve>`.
- What animates: `<hover, expand, toast>`; what never animates: `<layout shifts, data refresh>`.
- Respect `prefers-reduced-motion`.

## 6. Component recipes

One line each — the house way to build the recurring pieces. Add rows as
recipes stabilise; prototypes copy these, never improvise.

| Component | Recipe |
|---|---|
| Primary button | `<bg / size / state spec>` |
| Secondary button | `<spec>` |
| Card | `<spec>` |
| Table | `<row height, header style, zebra?, hover>` |
| Form field | `<label position, focus ring, error state>` |
| Modal | `<max-width, backdrop, mobile behaviour>` |
| Toast / inline alert | `<spec>` |
| Empty state | `<illustration? copy pattern? CTA?>` |
| Status pill | `<spec — semantic colours only>` |

## 7. Shell

App chrome: `<sidebar width / topbar height / content max-width / nav item
anatomy / where page titles live>`. Mockups must reuse the real shell — never
invent a parallel one.

## 8. Iconography

`<set (e.g. Lucide), stroke width, size scale, when icons are allowed vs
text-only>`.

## 9. Data visuals

`<chart palette derived from tokens, axis/gridline treatment, number
formatting (tabular figures, thousands separators), sparkline rules>`.

## 10. Craft bar (Axis 5 grades against this)

The ten-point bar. `mockup-reviewer` cites items by number.

1. Every colour on screen is a token from § 3 — zero rogue hexes.
2. Must-read text contrast ≥ 4.5:1 (🔴 when violated).
3. Every interactive element has visible hover AND focus states (🔴 when missing).
4. State colours (`--ok`/`--warn`/`--danger`) appear ONLY with semantic meaning (🔴 when decorative).
5. All async states the behaviour manifest names are styled — loading, empty, error (🔴 when unstyled).
6. Spacing values are on-scale; alignment is grid-true (no optical drift).
7. Type roles from § 2 used as specified — no ad-hoc sizes/weights.
8. Component recipes from § 6 followed — no re-invented buttons/cards/tables.
9. One accent: `--accent` is the only attention colour; hierarchy comes from weight/size/space, not extra colours.
10. Density matches the product's personality (§ 1) — no cramped tables in a calm product, no airy dashboards in a dense ops tool.

Items 2, 3, 4, 5 are the named 🔴 escalations; the rest default 🟡.

## 11. Prototype usage rules

- Link the canonical token sheet first: `<link rel="stylesheet" href="<path to _tokens.css>">`.
- Slug-level stylesheets may ADD (component-specific rules) but never FORK
  (override token values, redefine recipes).
- The newest merged prototype set is the visual precedent; when this doc and
  an old prototype disagree, this doc wins.
