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

// Custom properties created on the ticket object to track the link + scores.
const PROP_LINKED_TICKET_ID = 'linked_escalation_ticket_id';
const PROP_PARENT_TICKET_ID = 'parent_ticket_id';
const PROP_BUG_SCORE = 'bug_score';
const PROP_INCIDENT_SCORE = 'incident_score';
const PROP_SEVERITY_SCORE = 'severity_score';
const PROP_PRIORITY = 'defect_priority';      // P0-P3
const PROP_SEVERITY = 'incident_severity';    // S1-S4
const PROP_INCIDENT_TRIGGERED = 'incident_triggered'; // bool

// Flip to true once these three properties have been created in the portal:
//   linked_escalation_ticket_id, defect_priority, incident_triggered
const INCLUDE_OPTIONAL_PROPS = false;

// Fields to hide from the escalate modal (still set by the function itself).
const HIDDEN_FORM_FIELD_LABELS = ['ticket name', 'parent ticket id'];
const HIDDEN_FORM_FIELD_NAMES = ['ticket_name', 'parent_ticket_id'];

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
  // Incident/Severity Yes-No inputs are not in the current form. If they get
  // added later, add the internal names here. For now they evaluate to 0/false
  // and only Impact/Reach/Workaround drive Incident + Severity scores.
  ProductionImpact: 'production_impact',
  ImminentRisk: 'imminent_risk',
  Availability: 'availability',
  Performance: 'performance',
  DataIntegrity: 'data_integrity',
  SecurityPrivacy: 'security_privacy',
  BillingFinancial: 'billing_financial',
  Operational: 'operational',
};

// Multi-select form field whose options describe impact dimensions
// (Availability, Performance, DataIntegrity, etc.). Stored on the triage
// ticket as a property for reference — not used in scoring.
const PROP_KEY_IMPACT_DIMENSIONS = 'key_impact_dimensions';

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
      return 'select';
    case 'number':
      return 'number';
    default:
      return 'single_line_text';
  }
}

async function escalate(client, params) {
  const { ticketId, answers = {} } = params;
  if (!ticketId) return respond(400, { error: 'ticketId is required.' });

  const scores = calculateScores(answers);

  const subject =
    answers.subject ||
    answers.ticket_name ||
    answers.description ||
    `Escalated ticket ${ticketId}`;

  // Only the score outputs + built-in fields. The raw form answers are
  // embedded in `content` instead of being copied verbatim as properties —
  // that avoids "property doesn't exist" rejections when form field names
  // don't match ticket property internal names.
  const properties = {
    subject: String(subject).slice(0, 255),
    content: buildContentSummary(answers, scores),
    hs_pipeline: TARGET_PIPELINE_ID,
    hs_pipeline_stage: TARGET_STAGE_ID,
    [PROP_PARENT_TICKET_ID]: ticketId,
    [PROP_BUG_SCORE]: scores.bugScore,
    // incident_score, severity_score, and incident_severity are READ_ONLY
    // calculated properties in HubSpot — they're auto-derived from other
    // field values and rejected if sent via API.
    ...(INCLUDE_OPTIONAL_PROPS && {
      [PROP_PRIORITY]: scores.priority,
      [PROP_INCIDENT_TRIGGERED]: scores.shouldCreateIncident ? 'true' : 'false',
    }),
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

  // Write linked id back onto the source so the card knows it's been escalated.
  if (INCLUDE_OPTIONAL_PROPS) {
    await client.crm.tickets.basicApi.update(ticketId, {
      properties: { [PROP_LINKED_TICKET_ID]: newTicketId },
    });
  }

  return respond(200, {
    escalatedTicketId: newTicketId,
    ...scores,
  });
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

function buildContentSummary(answers, scores) {
  const lines = [
    `Defect priority: ${scores.priority}  (BugScore ${scores.bugScore})`,
    `Severity:        ${scores.severity}  (SeverityScore ${scores.severityScore})`,
    `Incident:        ${scores.shouldCreateIncident ? 'TRIGGERED' : 'not triggered'}  (IncidentScore ${scores.incidentScore})`,
    '',
    '--- Escalation answers ---',
    ...Object.entries(answers).map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join('\n');
}

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
