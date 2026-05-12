# QA Test Plan — ServiceBox Escalate Button CRM App

End-to-end test plan for the **Escalate** button on Support Tickets. Each test case below specifies exact form values and expected outcomes. Run them in order.

## Pre-flight setup (do this once before testing)

### 1. HubSpot portal — confirm these properties exist on the Ticket object
The escalation will fail or partially populate if any of these are missing or named differently.

**Writable properties used by the app:**

| Property internal name | Type | Notes |
|---|---|---|
| `adjusted_priority` | Dropdown | Options: `P0 - Critical`, `P1 - High`, `P2 - Medium`, `P3 - Low` |
| `severity_level` | Dropdown | Options (internal names): `S1 - Critical`, `S2 - High`, `S3 - Medium`, `S4 - Low` |
| `escalate_to_incident` | Single checkbox | yes/no |
| `is_escalated` | Single checkbox | yes/no |
| `parent_ticket_id` | Single-line text | |
| `key_impact_dimensions` | Multiple checkboxes | Availability, Performance, Data Integrity, Security / Privacy, Billing / Financial, Operational |
| `bug_impact`, `bug_reach`, `bug_frequency`, `bug_workaround`, `bug_time_criticality` | Number | |
| `customer_importance`, `sentiment_level` | Number | |
| `current_production_impact` | Dropdown | Yes / No |
| `imminent_production_risk` | Dropdown | `1 - Likely/Certain`, `2 - Maybe/Possible`, etc. |

**Calculated (read-only) properties — leave as-is, don't write to them:**
- `bugscore`, `incident_score`, `severity_score`, `incident_severity`

### 2. Confirm the escalation card is loaded
Open any Support Ticket in HubSpot. In the right sidebar, you should see the **Escalate** card with a red **Escalate** button. If you see a "Developing locally" tag, that's expected during dev.

### 3. Have `hs project logs` running in a terminal
Run `hs project logs servicebox_escalation_app_function` while testing so you can catch any backend warnings (missing properties, validation errors, etc.).

---

## Test Cases

For each case: open a Support Ticket → click **Escalate** → fill the form with the values below → click **Submit escalation** → open the resulting TET in HubSpot and verify.

### Case 1 — P3 / S4 / no incident (baseline minimum)

| Form field | Value |
|---|---|
| Ticket name | `QA-1 minimum` |
| Ticket description | `Baseline minimum impact` |
| Current Production Impact | **No** |
| Imminent Production Risk | Unlikely / No chance |
| Key Impact Dimensions | (none) |
| Impact On Workflow | `1 - Cosmetic` |
| Reach | `1 - Just one user` (or lowest) |
| Frequency | `1 - Rare` (or lowest) |
| Workaround Availability | lowest option (0) |
| Time Criticality | `0 - None` |
| Customer Importance | `0 - Low` |
| Sentiment | `0 - Neutral` |

**Expected on the new TET:**
- Sidebar pill: **LOW** (green)
- `adjusted_priority` = `P3 - Low`
- `severity_level` = `S4 - Low`
- `escalate_to_incident` = unchecked
- `is_escalated` = checked
- **No SIT created** — only the TET appears in the linked tickets sidebar
- Card shows **blue** "Escalation Ticket Created" alert only

---

### Case 2 — P2 / S3 / no incident

| Form field | Value |
|---|---|
| Ticket name | `QA-2 moderate` |
| Impact On Workflow | `3 - Slows work` |
| Reach | `3 - A team / dept` |
| Frequency | `2 - Occasional` |
| Workaround Availability | `1` |
| Time Criticality | `1 - Low` |
| Customer Importance | `1` |
| Sentiment | `1` |
| Key Impact Dimensions | **Performance** only |
| Current Production Impact | No |
| Imminent Production Risk | Unlikely |

**Expected:**
- Sidebar pill: **MEDIUM** (yellow/orange)
- `adjusted_priority` = `P2 - Medium`
- `severity_level` = `S3 - Medium`
- `escalate_to_incident` = unchecked
- No SIT created

---

### Case 3 — Incident auto-triggered by Production Impact (low scores otherwise)

| Form field | Value |
|---|---|
| Ticket name | `QA-3 prod impact` |
| Current Production Impact | **Yes** ← the key field |
| Imminent Production Risk | Unlikely |
| Key Impact Dimensions | (none) |
| Impact On Workflow | `1 - Cosmetic` |
| Reach | lowest |
| Frequency | lowest |
| Workaround Availability | 0 |
| Time Criticality | 0 |
| Customer Importance | 0 |
| Sentiment | 0 |

**Expected:**
- TET created, sidebar pill: **LOW**
- `escalate_to_incident` = **checked**
- A second ticket with subject **`[INCIDENT] QA-3 prod impact`** is created
- Both tickets appear in the Triage column and are **linked to each other** (visible in the right sidebar of the original ST)
- Card shows two alerts:
  - Blue "Escalation Ticket Created"
  - **Yellow "Incident Triggered"** with the incident ticket id and severity

This case proves: production impact alone (10 points) triggers an incident even with minimal everything else.

---

### Case 4 — P0 / S1 / Incident (worst case)

| Form field | Value |
|---|---|
| Ticket name | `QA-4 worst case` |
| Impact On Workflow | `5 - Blocker` |
| Reach | `5 - Everyone` (highest) |
| Frequency | `5 - Constant` |
| Workaround Availability | `3` (no workaround) |
| Time Criticality | `3 - High` |
| Customer Importance | `3` |
| Sentiment | `2` |
| Current Production Impact | **Yes** |
| Imminent Production Risk | `1 - Likely/Certain` |
| Key Impact Dimensions | **Select all six**: Availability, Performance, Data Integrity, Security / Privacy, Billing / Financial, Operational |

**Expected:**
- Sidebar pill: **URGENT** (red)
- `adjusted_priority` = `P0 - Critical`
- `severity_level` = `S1 - Critical`
- `escalate_to_incident` = checked
- `[INCIDENT] QA-4 worst case` SIT created and linked
- Card shows both blue + yellow alerts

---

### Case 5 — P0 fast-path (Impact=5 and Reach≥3, low BugScore)

| Form field | Value |
|---|---|
| Ticket name | `QA-5 P0 fast path` |
| Impact On Workflow | `5 - Blocker` |
| Reach | `3 - A team / dept` |
| Frequency | lowest |
| Workaround Availability | 0 |
| Time Criticality | 0 |
| Customer Importance | 0 |
| Sentiment | 0 |
| Current Production Impact | No |
| Imminent Production Risk | Unlikely |
| Key Impact Dimensions | (none) |

**Expected:**
- Sidebar pill: **URGENT** (red)
- `adjusted_priority` = `P0 - Critical` — even though raw BugScore would be only ~13
- `severity_level` = `S3 - Medium`
- `escalate_to_incident` = unchecked, no SIT

This case proves the SOP rule "P0 if Impact = 5 AND Reach >= 3" overrides the BugScore threshold.

---

## On every TET — checklist

For each case above, after the form submits, **open the new TET in HubSpot** and confirm:

- [ ] The ticket landed in the **Triage** column of the P&S pipeline
- [ ] **Property mirror** — open the TET's "About this ticket" section and verify these are all populated with the values you submitted:
  - `bug_impact`, `bug_reach`, `bug_frequency`, `bug_workaround`, `bug_time_criticality`
  - `customer_importance`, `sentiment_level`
  - `current_production_impact`, `imminent_production_risk`
  - `key_impact_dimensions`
- [ ] HubSpot's calculated `bugscore` shows a sensible number
- [ ] **Our writes**: `adjusted_priority`, `severity_level`, `escalate_to_incident`, `is_escalated`, `hs_ticket_priority` (drives the sidebar pill color)
- [ ] **Associations**: The new TET is linked back to the original Support Ticket in the right sidebar
- [ ] For Cases 3 & 4: The SIT is linked to **both** the ST and the TET

## Negative / edge cases to also check

- [ ] **Cancel the form** — click Cancel mid-fill. Should return to the intro view, no ticket created.
- [ ] **Re-escalate same ticket** — click Escalate again after Case 1 succeeded. The form should reopen and submitting again creates a second TET (no idempotency required today).
- [ ] **Backend logs are clean** — check `hs project logs`. Flag any of these:
  - `PROPERTY_DOESNT_EXIST` warnings — flag the property name
  - `Association failed (continuing)` — flag it
  - Any 500-level errors

## Known limitations (informational — not bugs)

- The HubSpot calculated `incident_score`, `severity_score`, and `incident_severity` properties show numbers from formulas that diverge from the SOP. The app **ignores them** — `escalate_to_incident` and `severity_level` (both written by the app) are the source of truth.
- The SIT lands in the same Triage stage as the TET today; this is by design until a dedicated "Suspected / Triage" stage is added.
- SLA timers (`Next Update By`, `New` / `Ready for Dev` max times) from the SOP are **not enforced in code** — those belong in HubSpot workflows.

## Sign-off

Tester: ______________________

Date: ______________________

Build / commit: ______________________

All 5 cases pass + all checklist items confirmed + logs clean → ready to ship.
