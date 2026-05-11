# ServiceBox Escalation — Setup

The code handles the **Escalate** card and the serverless function that
creates the linked TET ticket, runs the SOP scoring model, and writes scores
back as ticket properties. The pieces below must be configured in the HubSpot
portal before the app works end-to-end.

## Already wired in code

| Thing | Value |
|---|---|
| Portal | 46928821 |
| Form GUID (P&S Support Form) | `cdd5930c-5f3e-46e7-8a1d-a1916a2c1b02` |
| Target pipeline | `749816423` (Products and Services) |
| Target stage | `1358630195` (Triage / Scott) |
| Scoring | BugScore / IncidentScore / SeverityScore per `product-and-service-support-sop.pdf` |
| Hidden form fields | `Ticket Name`, `Parent Ticket ID` (set by the function, not asked in the modal) |

## 1. HubSpot portal config (Scott / admin)

### Custom ticket properties
Create these on the Tickets object (Settings → Properties → Tickets) so the
function can write to them:

| Internal name | Label | Type |
|---|---|---|
| `linked_escalation_ticket_id` | Linked escalation ticket | Single-line text |
| `parent_ticket_id` | Parent ticket ID | Single-line text |
| `bug_score` | Bug score | Number |
| `incident_score` | Incident score | Number |
| `severity_score` | Severity score | Number |
| `defect_priority` | Defect priority | Dropdown (P0, P1, P2, P3) |
| `incident_severity` | Incident severity | Dropdown (S1, S2, S3, S4) |
| `incident_triggered` | Incident triggered | Single checkbox / Yes-No |

Plus: every form field internal name listed in `SCORE_INPUT_MAP` at the top of
`escalateTicket.js`. The function copies answers verbatim onto the new
ticket; if a property doesn't exist HubSpot will reject the write. The
defaults assume snake_case names matching the SOP terminology
(`impact`, `reach`, `frequency`, `workaround`, `time_criticality`,
`customer_importance`, `sentiment`, `production_impact`, `imminent_risk`,
`availability`, `performance`, `data_integrity`, `security_privacy`,
`billing_financial`, `operational`). If your form fields use different
internal names, edit `SCORE_INPUT_MAP`.

### Scott's owner ID
Settings → Users & Teams → find Scott → copy his Owner ID, then set:

```
SCOTT_OWNER_ID=<id>
```

…either as an environment variable or by editing
`src/app/functions/escalateTicket.js`. Without this, escalated tickets are
created unassigned (still works, just no auto-assignment).

## 2. Status sync (close one → close the other)

Not yet built. Two paths depending on tier:

**Workflows (Service Hub Pro+):** two ticket-based workflows triggered on
`hs_pipeline_stage` change, using `parent_ticket_id` /
`linked_escalation_ticket_id` to find the paired ticket and close it.

**Webhooks (any tier):** add a `syncStatus.js` function that subscribes to
`ticket.propertyChange` for `hs_pipeline_stage`, reads the paired ticket id,
and closes the partner. Guard against loops by checking if the partner is
already closed.

## 3. Owner-clear when Scott reassigns

> "When he changes the status and he is the owner of, we just clear the
> owner so everyone can see it."

Workflow: trigger when `hubspot_owner_id` = Scott AND `hs_pipeline_stage`
changes to "Waiting on Us" or "New". Action: clear `hubspot_owner_id`.

Webhook fallback: same logic in a function.

## 4. Permission set — dev team sees only their / unassociated tickets

HubSpot doesn't natively support "associated to me or unassociated" filters.
Options:

- **Service Hub Enterprise:** permission set restricted to
  "Tickets owned by user or unassigned".
- **Lower tiers:** saved view "My / Unassigned triage tickets" with
  `Owner = Me OR Owner is unknown`, plus basic ticket-view permission.

## 5. Dev + deploy

```powershell
cd E:\Hubspot_work\ServiceBox-Escalate-Button-CRM-APP\servicebox-escalation
hs project dev      # local dev against the test portal
hs project upload   # deploy
hs project upload --account=servicebox-escalation && hs project dev --project-account=servicebox-escalation --testing-account=51454166  #for uploading and deploy
```

## 6. Open items

- [ ] Create the ticket properties listed above in portal 46928821.
- [ ] Confirm the P&S Support Form field internal names match
      `SCORE_INPUT_MAP`. If not, update the map.
- [ ] Set `SCOTT_OWNER_ID`.
- [ ] Verify ticket-to-ticket association `typeId` 452 is valid in this
      portal (`GET /crm/v4/associations/tickets/tickets/labels`). The
      function logs a warning and continues if the association fails.
- [ ] Decide workflow vs webhook for status sync + owner clear (depends on
      Service Hub tier).
- [ ] Implement the chosen status-sync path.
