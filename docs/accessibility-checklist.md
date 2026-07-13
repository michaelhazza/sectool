# Accessibility checklist

Quick reference for WCAG 2.1 AA on operator-facing UI. Consumed by the `frontend-design-check` skill (direct UI edits) and mockup-reviewer Axis 3.5 (prototype audits). Items marked **[proto]** are checkable in a static HTML prototype; the rest apply at implementation time.

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `references/accessibility-checklist.md` at commit `98967c4` (MIT licensed).

## Keyboard

- [ ] All interactive elements reachable via Tab; focus order follows visual order **[proto]**
- [ ] Focus is visible — style outlines, never remove them **[proto]**
- [ ] Custom widgets: Enter/Space activates, Escape closes; no keyboard traps (can always Tab away)
- [ ] Modals trap focus while open and return focus to the trigger on close
- [ ] Skip-to-content link at top of page, visible on keyboard focus

## Screen readers

- [ ] Every image has `alt` text (`alt=""` for decorative) **[proto]**
- [ ] Every form input has an associated label (`<label for>` or `aria-label`) **[proto]**
- [ ] Icon-only buttons carry `aria-label` **[proto]**
- [ ] Buttons/links have descriptive text, not "Click here" **[proto]**
- [ ] One `<h1>` per page; heading levels don't skip **[proto]**
- [ ] Dynamic changes announced: `role="status"`/`aria-live="polite"` for confirmations, `role="alert"`/`assertive` for errors
- [ ] Tables use `<th>` headers with scope **[proto]**

## Visual

- [ ] Text contrast >= 4.5:1 (>= 3:1 for 18px+); UI components >= 3:1 against background **[proto]**
- [ ] Colour is never the only carrier of information — pair with icon, text, or pattern **[proto]**
- [ ] Layout survives 200% text zoom; nothing flashes more than 3 times per second

## Forms

- [ ] Required fields indicated by more than colour **[proto]**
- [ ] Error messages are specific, associated with the field, and visible by more than colour (icon/text/border) **[proto]**
- [ ] Submission errors summarised and focusable
- [ ] Known fields use native types + autocomplete (`type="email" autocomplete="email"`)

## Structure

- [ ] `<html lang>` declared; page has a descriptive `<title>` **[proto]**
- [ ] `<button>` for actions, `<a href>` for navigation — never a `div`/`span` with an onClick **[proto]**
- [ ] `tabindex` only ever `0` or `-1`; positive values break natural tab order **[proto]**
- [ ] Touch targets >= 44x44px (see `docs/mobile-capability-principles.md`, which owns the mobile ruleset)

## Anti-patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| `div` as button | Not focusable, no keyboard support | Use `<button>` |
| Missing `alt` text | Image invisible to screen readers | Descriptive `alt`, or `alt=""` if decorative |
| Colour-only states | Invisible to colour-blind users | Add icon, text, or pattern |
| Custom dropdown without ARIA | Unusable by keyboard/screen reader | Native `<select>` or a proper ARIA listbox |
| Removed focus outlines | Keyboard users can't see where they are | Style the outline instead |
| Empty links/buttons | Announced as "link" with no description | Text content or `aria-label` |
| Autoplaying media | Disorienting, can't be stopped | Controls, no autoplay |

## aria-live quick reference

| Value | Behaviour | Use for |
|---|---|---|
| `aria-live="polite"` / `role="status"` | Announced at next pause | Saved confirmations, status updates |
| `aria-live="assertive"` / `role="alert"` | Announced immediately | Errors, time-sensitive alerts |

## Verification

Automated: Lighthouse accessibility audit or `npx pa11y` on changed pages. Manual spot-check: Tab through the changed flow end-to-end; confirm every state change is perceivable without colour vision.
