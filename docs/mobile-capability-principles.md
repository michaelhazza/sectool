# Mobile Capability Principles

Durable rules ensuring every UI artifact built in any repo using this framework is fully usable on a phone, not just a laptop. This is the long-form companion to [`frontend-design-principles.md`](./frontend-design-principles.md). Both apply simultaneously.

---

## Why this document exists

Most users of consumer-simple SaaS products access them from a phone. Many of these products are also distributed through the Apple App Store and Google Play Store via a native wrapper (commonly Capacitor). When a UI artifact is built without an explicit mobile pass, the app ships as desktop-first with phone-as-afterthought. Fixing that retroactively costs an order of magnitude more than building it right the first time.

This doc exists to prevent that. It sits beside `frontend-design-principles.md` in every consuming repo. Every UI design decision, mockup, and component review must satisfy both docs simultaneously.

**Mobile capability is non-negotiable.** This is not mobile-first dogma. Desktop remains a first-class target. The rule is simpler: both work.

---

## Contents

- [The primary rule](#the-primary-rule)
- [Mobile capability tiers](#mobile-capability-tiers)
- [Viewport widths to design against](#viewport-widths-to-design-against)
- [Mobile navigation pattern](#mobile-navigation-pattern)
- [Mobile-native idioms vs desktop modals](#mobile-native-idioms-vs-desktop-modals)
- [Tables on phones](#tables-on-phones)
- [Forms on phones](#forms-on-phones)
- [Touch target requirements](#touch-target-requirements)
- [Hover does not equal tap](#hover-does-not-equal-tap)
- [Keyboard handling](#keyboard-handling)
- [Safe-area handling](#safe-area-handling)
- [Network and offline behaviour](#network-and-offline-behaviour)
- [Performance budget](#performance-budget)
- [Pre-design checklist (mobile)](#pre-design-checklist-mobile)
- [Re-check before delivery (mobile)](#re-check-before-delivery-mobile)
- [When to break these rules](#when-to-break-these-rules)
- [How this interacts with the mockup loop](#how-this-interacts-with-the-mockup-loop)

---

## The primary rule

**Every UI ships with a working mobile shape, validated at the same time as the desktop shape.** No "we'll handle mobile later." No "desktop is the priority, mobile is acceptable if it works." Both work, or the artifact is not ready to ship.

The rule applies to every UI artifact: mockups, components, pages, modals, empty states, error states, dashboards, forms, tables, lists, navigation. If it renders pixels, it has a mobile shape.

## Mobile capability tiers

Not every screen needs the same level of mobile polish. Use this tier model to set expectations explicitly per screen, so reviewers and authors agree on the bar before the work starts.

| Tier | Scope | Mobile requirement |
|---|---|---|
| **Tier 1** | Primary user journeys (the workflows most users hit daily) | Native-feeling mobile UX. Bottom sheets, card layouts, gesture-friendly, polished. The user should never realise they are using a web app inside a wrapper. |
| **Tier 2** | Admin and operator workflows used regularly but not daily | Fully usable on mobile, responsive, no broken layout, no horizontal overflow. Card or stacked-row layouts where tables would clip. Visual polish is not required to the Tier 1 standard. |
| **Tier 3** | Rare, internal, or edge routes | Acceptable mobile fallback. No clipping, no unreadable text. Visual polish is not required. Horizontal scroll is acceptable **only inside the table or card region itself**, never as page-level horizontal overflow. |

Specs that touch UI must assign a tier to each new or modified screen. Mockup-designer and mockup-reviewer use the assigned tier to set expectations.

## Viewport widths to design against

Design and review against these widths explicitly. No page may horizontally overflow at any of these widths.

| Width | Device class | Notes |
|---|---|---|
| 375px | iPhone SE / small phones | Hardest target. If it works here, it works everywhere. |
| 390px | Modern iPhone (12/13/14/15 standard) | Most common phone width as of 2026. |
| 412px | Pixel and most modern Android phones | Wider than iPhone but still phone-shaped. |
| 430px | iPhone Pro Max class | Largest phone, still phone-shaped. |
| 768px | iPad portrait / small tablet | Transition zone between phone and desktop layouts. |
| 1024px+ | Desktop | The legacy default. Still a first-class target. |

**Hard rule.** Page-level horizontal overflow is forbidden at every width above. If horizontal scroll exists, it must be constrained to a specific table, card, or chart region, never the page body.

## Mobile navigation pattern

The default mobile navigation pattern is **bottom-tab bar plus a "More" sheet**.

- **Bottom-tab bar.** Four to five primary destinations, always visible at the bottom of the viewport. These are the workflows the user hits most often.
- **More sheet.** Everything else is reachable from a tab in the bar (commonly labelled "More" or "Menu"). The sheet opens from the bottom and contains role-aware groupings (admin items, operator items, settings).
- **Role-aware visibility.** Admin and operator routes are hidden from the bottom-tab bar and the top of the More sheet for end users. Surfaced for admins.
- **No global floating action button** unless the product has one dominant cross-route action. Do not add one speculatively.

A pure hamburger menu is permitted but **not preferred**. It is easier to build but feels worse for daily-use mobile products. Default to bottom-tab unless a specific reason argues otherwise.

**Web-only desktop sidebars do not satisfy this rule.** A 220px-wide fixed sidebar that collapses to icon-only at narrow widths is still desktop-shaped. Mobile needs its own shell.

## Mobile-native idioms vs desktop modals

On phones, replace desktop-centred modals with mobile-native idioms.

| Desktop pattern | Mobile equivalent |
|---|---|
| Centred fixed-width modal (e.g. 520px) | Bottom sheet slide-up, full-width with padding |
| Right-side drawer (e.g. 480px) | Full-screen overlay or bottom sheet |
| Confirmation dialog | Action sheet from the bottom |
| Multi-step wizard in a modal | Full-screen flow with native back button behaviour |
| Tooltip on hover | Tap to reveal, or inline secondary text |
| Popover anchored to a button | Bottom sheet anchored to the screen, not the button |

Fixed-pixel modal widths exceeding the smallest target viewport (375px minus padding) are forbidden. Modals on mobile use percentage or viewport-unit widths, or transform into bottom sheets at narrow widths.

## Tables on phones

Multi-column tables are the single most common mobile failure mode. Pick one of these treatments per table:

1. **Card layout (preferred for Tier 1 and Tier 2).** Below the medium breakpoint (768px), the table reflows into cards. Each card represents one row, with the primary identifier as the card title and the most important secondary fields as inline metadata. Actions move to a tap-anywhere or trailing chevron.
2. **Sticky-first-column horizontal scroll (Tier 2 and Tier 3 only).** The first column (typically the row identifier) is sticky-left. The remaining columns scroll horizontally **inside the table region**. Page-level horizontal scroll is forbidden.
3. **Column hiding (any tier).** Non-essential columns are hidden below the medium breakpoint. The mobile view shows the row identifier plus one or two key state columns. The hidden columns are accessible via a row-tap detail view.

Hard rules:

- **No page-level horizontal overflow under any tier.** A table that forces the whole viewport to scroll sideways fails its acceptance bar.
- **Tables wider than 4 columns must pick one of the three treatments above.** A 9-column desktop table rendered as-is on a phone is never acceptable.
- **The primary action on a row must remain reachable in one tap on mobile.** Hidden behind a row-tap detail is fine; hidden behind a desktop hover state is not.

## Forms on phones

- **Multi-column grids reflow to single column below md.** A two-column form grid (commonly `grid-cols-2`) becomes single-column below 768px without exception.
- **Labels stack above fields**, not beside. Inline left-aligned labels do not fit on phone widths.
- **Submit buttons remain reachable when the on-screen keyboard is open.** Either the button scrolls into view when the keyboard appears, or the layout includes safe bottom spacing.
- **Inputs scroll into view on focus.** The currently focused field must be visible above the keyboard.
- **Use native input types.** `type="email"` triggers the email keyboard. `type="tel"` triggers the numeric keypad. `type="date"` triggers the native date picker. Generic `type="text"` for these is a mobile UX failure.
- **One field per row.** Side-by-side "first name / last name" patterns reflow to stacked.

## Touch target requirements

- **Primary actions on touch-capable viewports: minimum 44px** in the dominant dimension. This matches the iOS Human Interface Guideline and the WCAG mobile touch-target recommendation.
- **Secondary actions: minimum 36px**, only when space is constrained and the action is non-critical.
- **Icon-only buttons are the most-violated category.** A 16px icon with `p-1` padding ends up at 24px, which is below the minimum. Either increase the padding to reach 44px on touch viewports, or pair the icon with a tappable label.
- **Stacking density.** Rows of small action icons crammed into table cells (commonly seen as "row actions") fail this rule when transposed to mobile. Either expand to chevron-tap-to-reveal, or move to a row-tap detail.
- **Spacing between tap targets.** Adjacent tap targets need at least 8px of dead space between them to prevent mis-taps.

## Hover does not equal tap

Touch devices have no hover state. Any UI behaviour that only fires on hover is invisible to mobile users.

Forbidden as the sole interaction:

- Tooltips that only appear on hover
- Dropdown menus that only open on hover
- Action menus that only reveal on row hover
- Hidden controls that only appear when the parent is hovered

Required: every hover-triggered behaviour must also fire on tap, focus, or be permanently visible. The hover state remains a useful enhancement for desktop users; it is never the only way to reach the behaviour.

**The test.** Imagine using the UI with no mouse, only a finger. Every action must be reachable.

This rule is also enforced at design time through the behaviour manifest: the **Interactive states** row of [`behaviour-manifest-template.md`](./behaviour-manifest-template.md) requires every hover state to declare its tap equivalent. Pin it there, do not re-document it per screen.

## Keyboard handling

When the on-screen keyboard opens on a mobile device, it consumes roughly the bottom half of the viewport. Layouts that did not plan for this break visibly.

Required behaviour:

- **Focused input stays visible.** The input the user is typing into must remain above the keyboard. Scroll the page or shift the layout to keep it visible.
- **Submit buttons remain reachable.** A "Save" button at the bottom of a form must either stay visible above the keyboard or be reachable by scrolling without dismissing the keyboard.
- **Bottom sheets handle keyboard appropriately.** A bottom sheet form should grow or scroll when the keyboard opens, not get pushed off-screen.
- **No fixed-position elements over the keyboard.** A fixed bottom navigation bar that floats above the keyboard is a UX failure on most platforms; hide it when the keyboard is open.

Test explicitly on every form-bearing screen: login, search, comment, modal, bottom-sheet.

Keyboard-open behaviour is also pinned at design time: the **Input behaviour** row of [`behaviour-manifest-template.md`](./behaviour-manifest-template.md) requires each form screen to state its keyboard-open handling (focused input stays visible, submit reachable). Pin it there, do not re-document it per screen.

## Safe-area handling

Modern phones have notches, dynamic islands, and home indicators. Content placed without safe-area handling collides with these hardware features.

Required:

- **`env(safe-area-inset-*)` applied to fixed bottom navigation, fixed top headers, and floating action buttons.** Use `env(safe-area-inset-bottom)` for the bottom nav padding so it sits above the iPhone home indicator. Use `env(safe-area-inset-top)` for fixed headers so they sit below the notch.
- **No content under the iPhone notch or home indicator.** The standard PWA `viewport-fit=cover` declaration plus safe-area padding is the canonical solution.
- **Bottom sheets respect the bottom inset.** A bottom sheet's primary action button sits above the home indicator, not under it.

This is a small amount of CSS that prevents an entire class of "looks broken on iPhone" reports.

## Network and offline behaviour

Mobile networks drop. Apps that assume reliable connectivity feel broken on phones in ways they do not feel broken on desktop ethernet.

Required, even if true offline mode is out of scope:

- **Every page has distinct loading, empty, and error states.** A skeleton shimmer is loading. A "no items yet" with a primary action is empty. A "couldn't reach the server, retry?" is error. These are visually distinct.
- **API calls retry on transient failure** with a defined backoff. The retry library and policy are documented in the spec.
- **The app reconnects cleanly on network restore** without requiring a manual page refresh.
- **Long-running operations show progress** rather than appearing frozen. A spinner without progress text after 5 seconds reads as broken on mobile.

True offline mode (queued writes, sync on reconnect, conflict resolution) is out of scope unless a specific user journey requires it. The spec author confirms or escalates.

## Performance budget

Mobile WebViews are fast but still slower than desktop browsers on the same code. Set explicit budgets.

| Metric | Tier 1 target |
|---|---|
| Initial load on Pixel 7a class device, throttled 4G, cold cache | Under 4 seconds to interactive |
| Route transition | Under 300ms |
| Large list rendering (100+ rows) | Virtualised or paginated; no jank during scroll |
| Image and asset payload per route | Under 500KB on Tier 1 routes |

A specific spec may relax these for Tier 2 or Tier 3, but defaults are these.

## Pre-design checklist (mobile)

Work through these before sketching the artifact. An unchecked box is a design finding.

- [ ] **What tier is this screen?** Per the tier model above. Sets the polish bar.
- [ ] **How does the primary task complete on a 375px phone?** Walk through it mentally or in a mockup. If it does not complete, the design is not ready.
- [ ] **Where does navigation go on mobile?** Bottom-tab, More sheet, both. Identify before drafting.
- [ ] **Are all primary tap targets at least 44px on touch viewports?** Including icon-only buttons.
- [ ] **What is the keyboard-open behaviour for any forms?** Inputs scroll into view, submit reachable.
- [ ] **Does any horizontal scroll exist?** If yes, is it constrained to a table or card region, never page-level.
- [ ] **What is the safe-area treatment for fixed bottom or top elements?** `env(safe-area-inset-*)` applied.
- [ ] **What is the network failure behaviour?** Loading, empty, error states distinct.

## Re-check before delivery (mobile)

Before committing any UI artifact, run through this quickly:

- [ ] Tested or mentally simulated at 375px viewport. No horizontal overflow.
- [ ] Tested with on-screen keyboard open if the screen has form inputs.
- [ ] All hover behaviours have tap equivalents.
- [ ] All primary tap targets at least 44px.
- [ ] Safe-area handled if the screen has fixed top or bottom elements.
- [ ] Loading, empty, and error states distinct.
- [ ] If the screen has navigation, the mobile shell is intentional (bottom-tab, More sheet, hamburger, full-screen).
- [ ] If the screen has a table with more than 4 columns, one of the three table treatments is applied (cards, sticky-first-column, column hiding).

If any answer is "no" or "not sure", revise before shipping.

## When to break these rules

Almost never. The legitimate exceptions:

1. **Explicitly desktop-only internal admin tools.** A tool used exclusively by internal staff at desks, never by end users on phones, may legitimately skip mobile treatment. The spec must state this and the navigation must hide the surface from non-desktop users.
2. **Workflows that physically cannot work on a phone.** Examples are rare and obvious: side-by-side comparison of two large datasets, multi-monitor inspection panels, sample editors that require precise pointer accuracy.

**Not valid exceptions:**

- "We are starting with desktop and adding mobile later." This is the failure mode this document exists to prevent.
- "Mobile is just nice-to-have for this screen." Every screen has a tier; even Tier 3 has a baseline requirement.
- "The data is too dense to fit on a phone." Pick one of the three table treatments above instead.

If you find yourself arguing for a third exception, you are almost certainly justifying a desktop-first oversight. Go back to the pre-design checklist.

## How this interacts with the mockup loop

The mockup-designer and mockup-reviewer agents enforce this document at the design step, before any code is written.

- **`mockup-designer`** reads this doc as part of context loading every round (alongside `frontend-design-principles.md`). Every prototype produced must include a mobile shape: either a single responsive HTML file that works at 375px and desktop widths, or separate mobile and desktop variants when the layouts diverge significantly. The round summary in `mockup-log.md` records the mobile shape check.
- **`mockup-reviewer`** audits every prototype against a third review axis (mobile capability), independent of the existing grounding and simplicity axes. Blocking findings include: page-level horizontal overflow at 375px, fixed-width modals exceeding the smallest target viewport, hover-only interactions with no tap equivalent, missing mobile shape entirely, and complete absence of mobile navigation when the feature adds routes.

A prototype that fails the mobile capability axis is `NEEDS_REWORK` regardless of how clean its desktop shape is. Mobile is not an afterthought; it is a peer to desktop and reviewed as such.

<!-- LOCAL-OVERRIDE:start name="project-mobile-overrides" -->
<!-- Replace this comment with project-specific mobile guidance: device matrix overrides,
     project-specific safe-area exceptions, custom touch-target requirements, etc.
     Sync.js preserves your content here on framework updates. -->
<!-- LOCAL-OVERRIDE:end name="project-mobile-overrides" -->
