const hubspot = require('@hubspot/api-client');

// ---------- CONFIG ----------
// Portal 46928821 (the developer portal — also where the app runs because
// UIE-callable app functions require static auth, which can't cross portals).
//   - Pipeline: 749816423 (Products and Services)
//   - Stage:    1358630195 (Triage / Scott)
// (Test portal 51454166 IDs kept for reference — pipeline 0, stage 1358818716.)
const TARGET_PIPELINE_ID = process.env.TARGET_PIPELINE_ID || '749816423';
const TARGET_STAGE_ID = process.env.TARGET_STAGE_ID || '1358630195';
// TODO: replace with Scott's actual HubSpot owner ID.
const SCOTT_OWNER_ID = process.env.SCOTT_OWNER_ID || '';

// Incident (SIT) destination. Per SOP, incidents should land in a dedicated
// "Suspected / Triage" stage, but for now we fall back to the same triage
// stage as the TET so creation works without portal-side reconfiguration.
const INCIDENT_PIPELINE_ID = process.env.INCIDENT_PIPELINE_ID || TARGET_PIPELINE_ID;
const INCIDENT_STAGE_ID = process.env.INCIDENT_STAGE_ID || TARGET_STAGE_ID;
const INCIDENT_OWNER_ID = process.env.INCIDENT_OWNER_ID || '';

// Custom properties created on the ticket object to track the link + scores.
// NOTE: bugscore, incident_score, severity_score, and incident_severity are
// HubSpot CALCULATED properties — read-only from the API. We do not write
// them; we write the underlying inputs so HubSpot's calculations fire.
const PROP_LINKED_TICKET_ID = 'linked_escalation_ticket_id';
const PROP_PARENT_TICKET_ID = 'parent_ticket_id';
const PROP_ADJUSTED_PRIORITY = 'adjusted_priority'; // dropdown: "P0 - Critical" etc.
const PROP_SEVERITY_LEVEL = 'severity_level';       // writable dropdown for SOP-computed severity
const PROP_ESCALATE_TO_INCIDENT = 'escalate_to_incident'; // single checkbox bool
const PROP_IS_ESCALATED = 'is_escalated'; // bool — flag on both source and triage ticket

// Maps the SOP priority codes to the dropdown labels configured on the
// adjusted_priority property in HubSpot.
const PRIORITY_LABELS = {
  P0: 'P0 - Critical',
  P1: 'P1 - High',
  P2: 'P2 - Medium',
  P3: 'P3 - Low',
};

// Mirror to HubSpot's built-in hs_ticket_priority so the sidebar badge pill
// reflects priority (LOW/MEDIUM/HIGH/URGENT are the only accepted values).
const HS_TICKET_PRIORITY = {
  P0: 'URGENT',
  P1: 'HIGH',
  P2: 'MEDIUM',
  P3: 'LOW',
};

// SOP severity bucket → dropdown internal value on severity_level.
// (Display label for S3 is "Moderate" but the internal value is "Medium" —
// we send the internal value.)
const SEVERITY_LABELS = {
  S1: 'S1 - Critical',
  S2: 'S2 - High',
  S3: 'S3 - Medium',
  S4: 'S4 - Low',
};

// Flip to true once these three properties have been created in the portal:
//   linked_escalation_ticket_id, defect_priority, incident_triggered
const INCLUDE_OPTIONAL_PROPS = false;

// Fields to hide from the escalate modal (still set by the function itself).
// Ticket Name (subject) is intentionally shown so the user can name the triage ticket.
const HIDDEN_FORM_FIELD_LABELS = ['parent ticket id'];
const HIDDEN_FORM_FIELD_NAMES = ['parent_ticket_id'];

// Map of canonical scoring inputs (per SOP) → form field internal names.
// Dropdown values arrive as labels like "3 - Regular (weekly)" — the leading
// integer is parsed out by num().
const SCORE_INPUT_MAP = {
  Impact: 'impact_on_workflow',
  Reach: 'reach',
  Frequency: 'frequency',
  Workaround: 'workaround_availability',
  TimeCriticality: 'time_criticality',
  CustomerImportance: 'customer_importance__revenue_at_risk',
  Sentiment: 'sentiment__escalation_level',
  ProductionImpact: 'current_production_impact',
  ImminentRisk: 'imminent_production_risk',
  // The six impact-dimension booleans below are not separate form fields —
  // they're synthesized from the key_impact_dimensions multi-select via
  // expandImpactDimensions() before scoring.
  Availability: 'availability',
  Performance: 'performance',
  DataIntegrity: 'data_integrity',
  SecurityPrivacy: 'security_privacy',
  BillingFinancial: 'billing_financial',
  Operational: 'operational',
};

// Form field internal name → ticket property internal name.
// Only entries where the names differ; same-named fields pass through directly.
// (The bug-scoring inputs on the form lack the `bug_` prefix that the HubSpot
// calculated `bugscore` property reads from.)
const FORM_TO_TICKET_PROP = {
  impact_on_workflow: 'bug_impact',
  reach: 'bug_reach',
  frequency: 'bug_frequency',
  workaround_availability: 'bug_workaround',
  time_criticality: 'bug_time_criticality',
  customer_importance__revenue_at_risk: 'customer_importance',
  sentiment__escalation_level: 'sentiment_level',
};

// Form fields whose values must land on the new TET/SIT so HubSpot's
// calculated properties (bugscore, incident_score, severity_score,
// incident_severity) have inputs to fire on.
const TICKET_INPUT_FORM_FIELDS = [
  'current_production_impact',
  'imminent_production_risk',
  'impact_on_workflow',
  'reach',
  'frequency',
  'workaround_availability',
  'time_criticality',
  'customer_importance__revenue_at_risk',
  'sentiment__escalation_level',
];

// Ticket properties typed as Number. Dropdown labels like "3 - High" must
// be reduced to the leading integer before writing.
const NUMERIC_TICKET_PROPS = new Set([
  'bug_impact',
  'bug_reach',
  'bug_frequency',
  'bug_workaround',
  'bug_time_criticality',
  'customer_importance',
  'sentiment_level',
]);

// Multi-select form field carrying selected impact dimensions
// ("Availability;Data Integrity;..."). Stored on the triage ticket and also
// expanded into the six booleans above so they feed Incident/Severity scoring.
const PROP_KEY_IMPACT_DIMENSIONS = 'key_impact_dimensions';

// Normalized token (lowercase, alnum-only) → canonical scoring name.
// Covers the option values currently rendered by the form
// (e.g. "Security / Privacy" → "securityprivacy").
const DIMENSION_TOKEN_TO_CANONICAL = {
  availability: 'Availability',
  performance: 'Performance',
  dataintegrity: 'DataIntegrity',
  securityprivacy: 'SecurityPrivacy',
  billingfinancial: 'BillingFinancial',
  operational: 'Operational',
};

// ---------- SCORING (per product-and-service-support-sop.pdf) ----------

function pick(answers, canonicalName) {
  const formKey = SCORE_INPUT_MAP[canonicalName];
  return answers[formKey] ?? answers[canonicalName] ?? answers[canonicalName.toLowerCase()];
}

// Parses the leading integer from values like "3 - Regular (weekly)".
// Also handles plain numbers and numeric strings.
function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// The MultiSelect on the form serializes selections as a ';'-joined string
// (HubSpot's multi-checkbox convention). Expand it into the six boolean
// answers that calculateScores reads. Pure: returns a new object only if
// expansion adds something; leaves explicit per-field answers untouched.
function expandImpactDimensions(answers) {
  const raw = answers[PROP_KEY_IMPACT_DIMENSIONS];
  if (raw == null || raw === '') return answers;

  const parts = Array.isArray(raw) ? raw : String(raw).split(';');
  const selected = new Set(
    parts
      .map((p) => String(p).toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean),
  );
  if (selected.size === 0) return answers;

  const synth = {};
  for (const [token, canonical] of Object.entries(DIMENSION_TOKEN_TO_CANONICAL)) {
    const formKey = SCORE_INPUT_MAP[canonical];
    if (!formKey) continue;
    if (answers[formKey] != null && answers[formKey] !== '') continue;
    if (selected.has(token)) synth[formKey] = 'Yes';
  }
  return Object.keys(synth).length ? { ...answers, ...synth } : answers;
}

// Build the input-property block to write onto the new ticket so HubSpot's
// calculated properties have something to compute from. Renames the form
// fields to their corresponding ticket property names (bug_* prefix) and
// parses Number-typed props out of "N - Label" dropdown values.
function buildInputProperties(answers) {
  const out = {};
  for (const formField of TICKET_INPUT_FORM_FIELDS) {
    const raw = answers[formField];
    if (raw == null || raw === '') continue;
    const ticketProp = FORM_TO_TICKET_PROP[formField] || formField;
    out[ticketProp] = NUMERIC_TICKET_PROPS.has(ticketProp) ? num(raw) : raw;
  }
  return out;
}

function bool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1' || s === 'y';
}

function calculateScores(answers) {
  const Impact = num(pick(answers, 'Impact'));
  const Reach = num(pick(answers, 'Reach'));
  const Frequency = num(pick(answers, 'Frequency'));
  const Workaround = num(pick(answers, 'Workaround'));
  const TimeCriticality = num(pick(answers, 'TimeCriticality'));
  const CustomerImportance = num(pick(answers, 'CustomerImportance'));
  const Sentiment = num(pick(answers, 'Sentiment'));

  const ProductionImpact = bool(pick(answers, 'ProductionImpact'));
  const ImminentRisk = num(pick(answers, 'ImminentRisk'));
  const Availability = bool(pick(answers, 'Availability'));
  const Performance = bool(pick(answers, 'Performance'));
  const DataIntegrity = bool(pick(answers, 'DataIntegrity'));
  const SecurityPrivacy = bool(pick(answers, 'SecurityPrivacy'));
  const BillingFinancial = bool(pick(answers, 'BillingFinancial'));
  const Operational = bool(pick(answers, 'Operational'));

  // BugScore → Priority
  const bugScore =
    Impact * 2 +
    Reach +
    Frequency +
    Workaround +
    TimeCriticality +
    CustomerImportance +
    Sentiment;

  let priority;
  if (bugScore >= 26 || (Impact === 5 && Reach >= 3)) priority = 'P0';
  else if (bugScore >= 20) priority = 'P1';
  else if (bugScore >= 14) priority = 'P2';
  else priority = 'P3';

  // IncidentScore → Incident trigger
  const incidentScore =
    (ProductionImpact ? 10 : 0) +
    ImminentRisk +
    (SecurityPrivacy ? 10 : 0) +
    (DataIntegrity ? 6 : 0) +
    (BillingFinancial ? 6 : 0) +
    (Impact >= 4 ? 3 : 0) +
    (Reach >= 3 ? 3 : 0) +
    Workaround;

  const shouldCreateIncident = incidentScore >= 10;

  // SeverityScore → Severity
  const severityScore =
    (ProductionImpact ? 12 : 0) +
    ImminentRisk +
    (Availability ? 8 : 0) +
    (Performance ? 5 : 0) +
    (DataIntegrity ? 8 : 0) +
    (SecurityPrivacy ? 12 : 0) +
    (BillingFinancial ? 8 : 0) +
    (Operational ? 4 : 0) +
    Impact * 3 +
    Reach * 2 +
    Workaround;

  let severity;
  if (severityScore >= 40) severity = 'S1';
  else if (severityScore >= 30) severity = 'S2';
  else if (severityScore >= 20) severity = 'S3';
  else severity = 'S4';

  return {
    bugScore,
    incidentScore,
    severityScore,
    priority,
    severity,
    shouldCreateIncident,
  };
}

// ---------- ENTRYPOINT ----------
exports.main = async (context = {}) => {
  const { action } = context.parameters || {};
  const client = new hubspot.Client({
    accessToken:
      context.secrets?.PRIVATE_APP_ACCESS_TOKEN ||
      process.env.PRIVATE_APP_ACCESS_TOKEN,
  });

  try {
    switch (action) {
      case 'getFormFields':
        return await getFormFields(client, context.parameters.formGuid);
      case 'escalate':
        return await escalate(client, context.parameters);
      case 'status':
        return await status(client, context.parameters.ticketId);
      default:
        return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('escalateTicket error', err);
    return respond(500, { error: err.message || 'Unknown error' });
  }
};

// ---------- ACTIONS ----------

async function getFormFields(client, formGuid) {
  if (!formGuid) return respond(400, { error: 'Form GUID not configured.' });

  const resp = await client.apiRequest({
    method: 'GET',
    path: `/marketing/v3/forms/${formGuid}`,
  });
  const body = await resp.json();

  const fields = (body.fieldGroups || [])
    .flatMap((g) => g.fields || [])
    .filter((f) => !isHiddenField(f))
    .map((f) => ({
      name: f.name,
      label: f.label,
      fieldType: mapFieldType(f.fieldType),
      required: f.required,
      options: (f.options || []).map((o) => ({
        label: o.label,
        value: o.value,
      })),
    }));

  return respond(200, { fields });
}

function isHiddenField(f) {
  const label = (f.label || '').trim().toLowerCase();
  const name = (f.name || '').trim().toLowerCase();
  return (
    HIDDEN_FORM_FIELD_LABELS.includes(label) ||
    HIDDEN_FORM_FIELD_NAMES.includes(name)
  );
}

function mapFieldType(hubspotType) {
  switch (hubspotType) {
    case 'textarea':
      return 'multi_line_text';
    case 'select':
    case 'radio':
    case 'dropdown':
    case 'booleancheckbox':
    case 'single_checkbox':
      return 'select';
    case 'checkbox':
    case 'multiple_checkboxes':
      return 'multiple_checkboxes';
    case 'number':
      return 'number';
    default:
      return 'single_line_text';
  }
}

async function escalate(client, params) {
  const { ticketId, answers: rawAnswers = {} } = params;
  if (!ticketId) return respond(400, { error: 'ticketId is required.' });

  // Expand the key_impact_dimensions multi-select into per-dimension booleans
  // before scoring; the SOP's IncidentScore + SeverityScore depend on those.
  const answers = expandImpactDimensions(rawAnswers);
  const scores = calculateScores(answers);

  const subject =
    answers.subject ||
    answers.ticket_name ||
    answers.description ||
    `Escalated ticket ${ticketId}`;

  // Description is taken straight from what the user typed in the form —
  // no score dump. Scores still flow through as their own properties (bug_score)
  // and HubSpot's calculated properties handle incident/severity automatically.
  const description = answers.content || answers.description || '';

  const properties = {
    subject: String(subject).slice(0, 255),
    content: description,
    hs_pipeline: TARGET_PIPELINE_ID,
    hs_pipeline_stage: TARGET_STAGE_ID,
    [PROP_PARENT_TICKET_ID]: ticketId,
    // Mirror the form inputs so HubSpot's calculated properties (bugscore,
    // incident_score, severity_score, incident_severity) can fire.
    ...buildInputProperties(answers),
    [PROP_ADJUSTED_PRIORITY]: PRIORITY_LABELS[scores.priority] || scores.priority,
    hs_ticket_priority: HS_TICKET_PRIORITY[scores.priority] || 'LOW',
    [PROP_SEVERITY_LEVEL]: SEVERITY_LABELS[scores.severity] || scores.severity,
    [PROP_ESCALATE_TO_INCIDENT]: scores.shouldCreateIncident ? 'true' : 'false',
    [PROP_IS_ESCALATED]: true,
    ...(answers.key_impact_dimensions != null && {
      [PROP_KEY_IMPACT_DIMENSIONS]: normalizeMultiSelect(answers.key_impact_dimensions),
    }),
  };

  if (SCOTT_OWNER_ID) {
    properties.hubspot_owner_id = SCOTT_OWNER_ID;
  }

  let newTicketId;
  try {
    const created = await client.crm.tickets.basicApi.create({ properties });
    newTicketId = created.id;
  } catch (createErr) {
    console.error('Ticket create failed', createErr?.body || createErr?.message || createErr);
    return respond(500, {
      error: 'Ticket create failed: ' + (createErr?.message || 'unknown'),
      details: createErr?.body || null,
    });
  }

  // Associate the original ↔ new ticket (ticket-to-ticket, default type).
  // typeId 452 is the common ticket→ticket default; verify per portal via
  // GET /crm/v4/associations/tickets/tickets/labels.
  try {
    await client.crm.associations.v4.basicApi.create(
      'tickets',
      ticketId,
      'tickets',
      newTicketId,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 452 }],
    );
  } catch (assocErr) {
    console.warn('Association failed (continuing):', assocErr.message);
  }

  // Flag the source ticket as escalated, plus (optionally) the linked id.
  try {
    const sourceUpdate = { [PROP_IS_ESCALATED]: true };
    if (INCLUDE_OPTIONAL_PROPS) {
      sourceUpdate[PROP_LINKED_TICKET_ID] = newTicketId;
    }
    await client.crm.tickets.basicApi.update(ticketId, {
      properties: sourceUpdate,
    });
  } catch (updateErr) {
    console.warn('Source ticket update failed (continuing):', updateErr.message);
  }

  // SOP Incident Short-Circuit: if IncidentScore >= 10, create a linked SIT.
  // Forward-only — once created we don't auto-uncreate even if later scoring
  // changes. Lands in the triage stage today; move to a dedicated
  // "Suspected / Triage" stage by setting INCIDENT_STAGE_ID.
  let incidentTicketId = null;
  if (scores.shouldCreateIncident) {
    incidentTicketId = await createIncidentTicket(client, {
      sourceTicketId: ticketId,
      tetTicketId: newTicketId,
      subject,
      description,
      scores,
      answers,
    });
  }

  return respond(200, {
    escalatedTicketId: newTicketId,
    incidentTicketId,
    ...scores,
  });
}

async function createIncidentTicket(client, ctx) {
  const incidentSubject = `[INCIDENT] ${ctx.subject}`.slice(0, 255);
  const properties = {
    subject: incidentSubject,
    content: ctx.description,
    hs_pipeline: INCIDENT_PIPELINE_ID,
    hs_pipeline_stage: INCIDENT_STAGE_ID,
    [PROP_PARENT_TICKET_ID]: ctx.tetTicketId,
    ...buildInputProperties(ctx.answers),
    [PROP_ADJUSTED_PRIORITY]:
      PRIORITY_LABELS[ctx.scores.priority] || ctx.scores.priority,
    hs_ticket_priority: HS_TICKET_PRIORITY[ctx.scores.priority] || 'LOW',
    [PROP_SEVERITY_LEVEL]:
      SEVERITY_LABELS[ctx.scores.severity] || ctx.scores.severity,
    [PROP_ESCALATE_TO_INCIDENT]: 'true',
    [PROP_IS_ESCALATED]: true,
    ...(ctx.answers[PROP_KEY_IMPACT_DIMENSIONS] != null && {
      [PROP_KEY_IMPACT_DIMENSIONS]: normalizeMultiSelect(
        ctx.answers[PROP_KEY_IMPACT_DIMENSIONS],
      ),
    }),
  };
  if (INCIDENT_OWNER_ID) properties.hubspot_owner_id = INCIDENT_OWNER_ID;

  let incidentId;
  try {
    const created = await client.crm.tickets.basicApi.create({ properties });
    incidentId = created.id;
  } catch (e) {
    console.error(
      'Incident ticket create failed',
      e?.body || e?.message || e,
    );
    return null;
  }

  // Per SOP: link the incident to both the originating Support Ticket and the
  // TET so it's discoverable from either side.
  for (const fromId of [ctx.sourceTicketId, ctx.tetTicketId]) {
    try {
      await client.crm.associations.v4.basicApi.create(
        'tickets',
        fromId,
        'tickets',
        incidentId,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 452 }],
      );
    } catch (assocErr) {
      console.warn(
        `Incident association ${fromId} → ${incidentId} failed (continuing):`,
        assocErr.message,
      );
    }
  }

  // Flip the TET's escalate_to_incident flag now that the SIT exists.
  // The TET ↔ SIT link is held by the ticket-to-ticket association above.
  try {
    await client.crm.tickets.basicApi.update(ctx.tetTicketId, {
      properties: { [PROP_ESCALATE_TO_INCIDENT]: 'true' },
    });
  } catch (e) {
    console.warn(
      'TET escalate_to_incident flip failed (continuing):',
      e.message,
    );
  }

  return incidentId;
}

async function status(client, ticketId) {
  if (!ticketId) return respond(400, { error: 'ticketId is required.' });

  if (!INCLUDE_OPTIONAL_PROPS) {
    // linked_escalation_ticket_id doesn't exist yet — skip lookup.
    return respond(200, { escalatedTicketId: null });
  }

  const t = await client.crm.tickets.basicApi.getById(ticketId, [
    PROP_LINKED_TICKET_ID,
  ]);

  return respond(200, {
    escalatedTicketId: t.properties?.[PROP_LINKED_TICKET_ID] || null,
  });
}

// ---------- HELPERS ----------

// HubSpot multi-select properties expect values joined by ';'.
function normalizeMultiSelect(v) {
  if (Array.isArray(v)) return v.join(';');
  return String(v);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}
