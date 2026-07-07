# {{PROJECT_NAME}} — Capabilities Registry

> **TEMPLATE.** Scaffold your repo's `docs/capabilities.md` from this file, replace every `{{...}}` placeholder and `[EXAMPLE]` row with your own content, then delete this banner. The pipeline depends on this doc: `spec-coordinator` Step 3a reads the Asset Register for the duplication/strategy gate, and `finalisation-coordinator` Step 6 (Capability Registration) writes a row before `MERGE_READY`.

> **Last updated:** {{DATE}} ({{build-slug}}: one-line summary of what changed in the register and the verdict — `create new capability record` or `update existing capability record, no new Asset Register row`. PR #NNN.)
>
> This is the external-ready narrative source of truth for everything {{PROJECT_NAME}} can do.
> Update it in the same commit as any feature or skill change.

---

## How to use this document

| Audience | Start here |
|----------|-----------|
| **Marketing / Sales** | [Product Capabilities](#product-capabilities) |
| **Support** | Skills / Integrations reference sections (if your product has them) |
| **Engineering** | Your architecture doc remains the technical reference; this doc covers *what*, not *how* |
| **Claude Code (capability analysis)** | [Asset Register](#asset-register) |

---

## Editorial Rules

This document is written for external-ready, marketing- and sales-appropriate language. Every edit must follow these rules — violations block the edit:

1. **Vendor-neutral.** No specific LLM / AI provider or product names in customer-facing sections. Use generic category language — *"LLM providers," "foundation model vendors," "hosted agent platforms."* Named providers are permitted only in factual reference sections (integrations lists, supported connectors), never in marketing prose.
2. **Marketing-ready.** Customer-facing sections are written for end users and buyers, not engineers. No internal service names, library names, table names, or codenames.
3. **Model-agnostic.** Never imply a preferred AI provider in customer-facing copy. Frame {{PROJECT_NAME}} as working across providers where that is true.
4. Vendor-neutral positioning holds even under objection — generic category language in all written collateral regardless of which provider a prospect names.
5. Always-OK industry terms (pass editorial review): OAuth, HTTP, REST, GraphQL, SSO, JWT, JSON, CSV, webhook, container, SMTP, CRM, and similar vendor-neutral standards. When a partner-name mention is borderline (factual vs marketing), route to a human editor; the default is vendor-neutral.

---

## Cluster list (closed)

Capability clusters group Asset Register rows. The list is **closed** — adding a cluster requires an ADR under `docs/decisions/` and an update to `docs/spec-authoring-checklist.md` in the same PR.

1. {{CLUSTER_1 — e.g. Core Workflow}}
2. {{CLUSTER_2 — e.g. Identity & Auth}}
3. {{CLUSTER_3 — e.g. Reporting}}
4. {{CLUSTER_4 — e.g. Integrations}}
5. {{CLUSTER_5 — e.g. Admin & Ops}}

---

## Lifecycle states

Every Asset Register row carries exactly one lifecycle state. `spec-coordinator`'s strategy gate keys on these values, so use the enum verbatim:

| State | Meaning |
|-------|---------|
| `Inception` | Registered, no production traffic yet |
| `Growth` | Live and actively iterating |
| `Mature` | Live, stable, maintenance-only — building against it is normal |
| `Declining` | Usage falling; new work against it is `questionable` |
| `Sunset Candidate` | Marked for decommission review |
| `Sunset` | Being decommissioned; no new work |

New capabilities launch as `Inception` or `Growth` only (the spec's Lifecycle Declaration enforces this); later states are applied on the register row across subsequent builds.

---

## Asset Register

One row per capability. This table is the machine-read surface of the doc — keep the column set intact.

| Capability ID / slug | Name | Description | Owner | Cluster | Lifecycle state | Launch source | Risk surface | Last review date | Carry notes | Decommission notes | Related docs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [EXAMPLE] user-onboarding | User Onboarding | Guided first-run setup that takes a new account from signup to first successful {{PRIMARY_ACTION}} without support intervention. | {{TEAM_OR_HANDLE}} | {{CLUSTER_1}} | Mature | unknown — historical | None. | {{DATE}} | Ongoing maintenance: onboarding steps re-verified when signup flow changes. Review cadence: on-incident-only. Operational cost: low. | None planned | spec: not applicable — historical capability |
| [EXAMPLE] audit-export | Audit Export | Lets an administrator export a complete, filterable activity history for compliance review. | {{TEAM_OR_HANDLE}} | {{CLUSTER_5}} | Growth | audit-export — PR #NNN ({{DATE}}) | auth/permission surfaces | {{DATE}} | Acquire S; Build M; Carry S; Decommission S. Review cadence: quarterly. | Remove the export route and scheduled job; underlying activity store predates this build and stays. | spec: tasks/builds/audit-export/spec.md |
| [EXAMPLE] smart-suggestions | Smart Suggestions | Context-aware next-step suggestions surfaced inline after key user actions. | {{TEAM_OR_HANDLE}} | {{CLUSTER_1}} | Inception | smart-suggestions — PR #NNN ({{DATE}}) | AI-output surfaces | {{DATE}} | Acquire M (no off-the-shelf equivalent for our context shape); Build M; Carry S; Decommission S. Review cadence: quarterly. | Suggestions are a leaf UI element; removing the component and endpoint restores prior behaviour. | spec: tasks/builds/smart-suggestions/spec.md |

Column notes:

- **Capability ID / slug** — stable, kebab-case; matches the build slug that launched it where applicable.
- **Launch source** — build slug + PR + date, or `unknown — historical` for pre-registry capabilities.
- **Risk surface** — `None.` or the sensitive surfaces the capability touches (auth, tenant data, payments, AI output, external egress); copied from the spec's Lifecycle Declaration.
- **Carry notes** — ABCd sizing (Acquire/Build/Carry/Decommission, S/M/L only), ongoing-maintenance facts, and review cadence.
- **Decommission notes** — what removing this capability actually entails; `None planned` is valid.

---

## Product Capabilities

Narrative, customer-facing sections — one `###` heading per capability, in the cluster order above. Format: heading, one-sentence value statement, then benefit-oriented bullets. Editorial rules apply in full here.

### [EXAMPLE] User Onboarding

Guided first-run setup that takes a new account from signup to first success — without a support ticket.

- **Step-by-step setup** — each step verifies itself before the next unlocks
- **Sensible defaults** — a working configuration out of the box; customise later
- Progress is resumable; abandoning mid-way never leaves a broken half-configured account

### {{NEXT_CAPABILITY}}

{{One-sentence value statement.}}

- {{Benefit bullet}}
- {{Benefit bullet}}

---

## Update triggers

Update this document — **in the same commit** as the change that triggers it — when any of the following happens:

| Trigger | Required update |
|---------|-----------------|
| New capability ships | New Asset Register row (state `Inception` or `Growth`) + a Product Capabilities section + a `Last updated` header line with the verdict |
| Existing capability materially extended | Update the row's Description/Carry notes + the narrative section + a `Last updated` line (`no new Asset Register row`) |
| Capability retired or absorbed | Move the row's state toward `Sunset`, fill Decommission notes, prune the narrative section |
| Lifecycle state changes | Update the row's state + Last review date |
| New skill / integration ships | Update the relevant reference section (if present) |
| Quarterly / on-incident review | Refresh Last review date + Carry notes for the reviewed rows |

The `finalisation-coordinator` blocks `MERGE_READY` until Capability Registration is done, and `spec-coordinator` Step 3a will flag any new intent against this register — a stale register produces false duplication verdicts, so treat drift here as a build failure, not a docs chore.
