# Priority / Incident / Severity Scoring

How the escalation form should drive priority, incident creation, and severity in this app — distilled from `product-and-service-support-sop.pdf` pages 7–10 and mapped to the current implementation in [src/app/functions/escalateTicket.js](servicebox-escalation/src/app/functions/escalateTicket.js).

## The three independent outputs

The form produces three separate scores from the same set of inputs:

| Output | Drives | Range |
|---|---|---|
| **BugScore** | Defect priority `P0–P3` (non-incident execution + update SLAs) | ~0–35 |
| **IncidentScore** | Whether a HubSpot/ADO Incident ticket must be created | ≥10 ⇒ create |
| **SeverityScore** | Incident severity `S1–S4` (incident response handling) | ~0–60 |

Priority and severity are related but **not** substitutes — a low-priority defect can still escalate to an incident if production/security factors are present.

## Scoring inputs

### Bug/Defect inputs (numeric labels parsed by `num()`)
- `Impact` — 1–5 (`impact_on_workflow`)
- `Reach` — 1–5 (`reach`)
- `Frequency` — 1–5 (`frequency`)
- `Workaround` — 0, 1, or 3 (`workaround_availability`)
- `TimeCriticality` — 0–3 (`time_criticality`)
- `CustomerImportance` — 0–3 (`customer_importance__revenue_at_risk`)
- `Sentiment` — 0–2 (`sentiment__escalation_level`)

### Incident inputs
- `ProductionImpact` — Yes/No (`production_impact`)
- `ImminentRisk` — 0 / 2 / 6 (`imminent_risk`; Unlikely / Maybe / Likely)
- Impact dimensions (Yes/No each): `Availability`, `Performance`, `DataIntegrity`, `SecurityPrivacy`, `BillingFinancial`, `Operational`

> All numeric dropdown options must have internal values that **start with the integer** (e.g. `1 - Cosmetic…`). `num()` parses the leading digit, so labels are free-form after that.

## BugScore → Priority

```
BugScore = (Impact * 2)
         + Reach + Frequency + Workaround
         + TimeCriticality + CustomerImportance + Sentiment
```

Weighting rationale: `Impact` is doubled (workflow disruption matters most); `Reach`+`Frequency` capture spread/repeatability; `Workaround`+`TimeCriticality` capture urgency; `CustomerImportance`+`Sentiment` capture commercial/relationship risk.

| Priority | Rule |
|---|---|
| **P0** | `BugScore >= 26` **or** `Impact == 5 && Reach >= 3` |
| **P1** | `BugScore` 20–25 |
| **P2** | `BugScore` 14–19 |
| **P3** | `BugScore <= 13` |

### Priority SLA timers (business hours)

| Priority | Max in `New` | Max in `Ready for Dev` | Max until `Next Update By` |
|---|---|---|---|
| P0 | 4 h | 4 h | 24 h |
| P1 | 8 h | 1 day | 48 h |
| P2 | 2 days | 5 days | 5 days |
| P3 | 3 days | 10 days | 5 days |

`Next Update By` resets on every update until the ticket is closed; reminders/nags should be driven by these timers, not manual chasing.

## IncidentScore → Incident Trigger

```
IncidentScore = (ProductionImpact ? 10 : 0)
              + ImminentRisk
              + (SecurityPrivacy ? 10 : 0)
              + (DataIntegrity   ? 6  : 0)
              + (BillingFinancial? 6  : 0)
              + (Impact >= 4 ? 3 : 0)
              + (Reach  >= 3 ? 3 : 0)
              + Workaround
```

**Create an incident ticket when `IncidentScore >= 10`.**

Operationally this means:
- Current production impact alone → always an incident (10).
- Security/privacy impact alone → always an incident (10).
- Otherwise, enough combined risk + customer-impact factors can still trigger it.

Incident creation is **forward-only**: once created, it is never silently uncreated. If the incident was wrong, close it; the TET stays.

## SeverityScore → Severity

```
SeverityScore = (ProductionImpact ? 12 : 0)
              + ImminentRisk
              + (Availability    ? 8  : 0)
              + (Performance     ? 5  : 0)
              + (DataIntegrity   ? 8  : 0)
              + (SecurityPrivacy ? 12 : 0)
              + (BillingFinancial? 8  : 0)
              + (Operational     ? 4  : 0)
              + (Impact * 3)
              + (Reach  * 2)
              + Workaround
```

| Severity | Rule | Max time until `Next Update By` (elapsed, not business hours) |
|---|---|---|
| **S1** | `>= 40` — widespread outage / security / major data or billing impact | 1 hour |
| **S2** | 30–39 — major workflow broken; no workaround | 2 hours |
| **S3** | 20–29 — limited segment; workaround exists | 4 hours |
| **S4** | `< 20` — minimal/informational | 1 business day |

## End-to-end flow in this app

1. **Frontline support** clicks **Escalate** on the originating Support Ticket. The card opens the embedded P&S Support Form ([EscalateCard.tsx](servicebox-escalation/src/app/cards/EscalateCard.tsx)).
2. On submit, the serverless function ([escalateTicket.js](servicebox-escalation/src/app/functions/escalateTicket.js)) calls `calculateScores(answers)` to compute `bugScore`, `incidentScore`, `severityScore`, plus the derived `priority`, `severity`, and `shouldCreateIncident` flag.
3. A child **TET** is created, linked to the parent, with priority/severity written onto the ticket.
4. If `shouldCreateIncident === true`, a HubSpot Incident (SIT) should also be created and linked — this is the SOP's "Incident Short-Circuit". Once created, do not auto-close it based on later field changes.
5. TSTL takes the ticket out of `New`, ensures DoR is met, and moves it to `Ready for Dev` (or another working status) within the SLA window for its priority.

## Implementation notes

### ✅ Scoring matches the SOP
`calculateScores` is a 1:1 implementation of the SOP formulas.

### ✅ Impact dimensions feed scoring
The `key_impact_dimensions` multi-select is expanded into the six per-dimension booleans by `expandImpactDimensions()` before scoring, so `Availability`, `Performance`, `DataIntegrity`, `SecurityPrivacy`, `BillingFinancial`, and `Operational` all contribute to IncidentScore and SeverityScore as the SOP intends. Matching is normalized (lowercase, alnum-only), so "Security / Privacy" maps to `SecurityPrivacy` cleanly.

### ✅ Automatic incident-ticket creation
When `shouldCreateIncident` is true, `createIncidentTicket()` runs after the TET is created. Per SOP:
- New SIT is created (currently lands in the same triage stage as the TET — set `INCIDENT_STAGE_ID` once a dedicated "Suspected / Triage" stage exists).
- Linked to **both** the originating Support Ticket and the TET (ticket↔ticket associations).
- Carries the full score set (`bug_score`, `incident_score`, `severity_score`, `incident_severity`, `adjusted_priority`), the `escalate_to_incident` flag, and the `key_impact_dimensions` passthrough.
- **Forward-only**: the app never auto-deletes/unlinks the incident based on later field changes. If created in error, close the incident; the TET stays.
- Subject is prefixed `[INCIDENT]`. Card surfaces a warning Alert with the incident ID + severity.

### Configuration (env vars)
| Var | Purpose | Default |
|---|---|---|
| `TARGET_PIPELINE_ID` / `TARGET_STAGE_ID` | TET destination | `749816423` / `1358630195` |
| `INCIDENT_PIPELINE_ID` | SIT destination pipeline | falls back to `TARGET_PIPELINE_ID` |
| `INCIDENT_STAGE_ID` | SIT destination stage | falls back to `TARGET_STAGE_ID` (same triage column as the TET). Override once a dedicated "Suspected / Triage" stage exists. |
| `INCIDENT_OWNER_ID` | Optional default IC | unset |
| `SCOTT_OWNER_ID` | Default TET owner | unset |

### Properties written to the ticket
The HubSpot portal already has `bugscore`, `incident_score`, `severity_score`, and `incident_severity` configured as **calculated (read-only) properties**, so the function never writes them directly. Instead it writes the underlying inputs so HubSpot's formulas fire on the new ticket.

Inputs mirrored from the form (`buildInputProperties()` handles renames + numeric parsing):
| Form field | Ticket property | Type |
|---|---|---|
| `current_production_impact` | `current_production_impact` | enum |
| `imminent_production_risk` | `imminent_production_risk` | enum |
| `impact_on_workflow` | `bug_impact` | number |
| `reach` | `bug_reach` | number |
| `frequency` | `bug_frequency` | number |
| `workaround_availability` | `bug_workaround` | number |
| `time_criticality` | `bug_time_criticality` | number |
| `customer_importance__revenue_at_risk` | `customer_importance` | number |
| `sentiment__escalation_level` | `sentiment_level` | number |
| `key_impact_dimensions` | `key_impact_dimensions` | multi-select |

Plus the writable derived fields (computed in JS from the SOP formulas, then written directly):
- `adjusted_priority` — dropdown labels `P0 - Critical` / `P1 - High` / `P2 - Medium` / `P3 - Low`
- `hs_ticket_priority` — HubSpot's native priority enum, mirrored from `adjusted_priority` so the sidebar pill reflects severity (`P0→URGENT`, `P1→HIGH`, `P2→MEDIUM`, `P3→LOW`)
- `severity_level` — dropdown internal names `S1 - Critical` / `S2 - High` / `S3 - Medium` / `S4 - Low` (bypasses the calculated `severity_score` chain so the SOP severity formula is honored)
- `escalate_to_incident` — single checkbox `true` / `false`
- `is_escalated` — `true`
- `parent_ticket_id` — id of the originating ST (on the TET) or the TET (on the SIT)

When an incident is created, the TET's `escalate_to_incident` flag is flipped to `true`. The TET↔SIT link is held by the ticket-to-ticket association (visible in the sidebar), not by a dedicated property.
