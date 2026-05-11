// Checks that all ticket properties the escalate function writes to actually
// exist in the target portal. Reports which are missing.
//
// Usage:
//   $env:HUBSPOT_TOKEN = "pat-na1-xxxx..."     # private app access token
//   node scripts/check-properties.mjs

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('Missing HUBSPOT_TOKEN env var.');
  console.error('Create a private app in Settings → Integrations → Private');
  console.error('Apps with scope `tickets`, copy the access token, then:');
  console.error('  $env:HUBSPOT_TOKEN = "pat-na1-..."');
  process.exit(1);
}

const REQUIRED = [
  { name: 'linked_escalation_ticket_id', type: 'string' },
  { name: 'parent_ticket_id', type: 'string' },
  { name: 'bug_score', type: 'number' },
  { name: 'incident_score', type: 'number' },
  { name: 'severity_score', type: 'number' },
  { name: 'defect_priority', type: 'enumeration (P0,P1,P2,P3)' },
  { name: 'incident_severity', type: 'enumeration (S1,S2,S3,S4)' },
  { name: 'incident_triggered', type: 'bool / enumeration' },
];

const resp = await fetch('https://api.hubapi.com/crm/v3/properties/tickets', {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

if (!resp.ok) {
  console.error(`API error ${resp.status}: ${await resp.text()}`);
  process.exit(1);
}

const { results } = await resp.json();
const existing = new Map(results.map((p) => [p.name, p]));

let missing = 0;
console.log('\nProperty check (portal accessed by the supplied token):\n');
for (const req of REQUIRED) {
  const got = existing.get(req.name);
  if (got) {
    console.log(`  ✓ ${req.name}  →  type=${got.type}, fieldType=${got.fieldType}`);
  } else {
    missing++;
    console.log(`  ✗ ${req.name}  MISSING  (expected: ${req.type})`);
  }
}

console.log('');
if (missing === 0) {
  console.log('All required properties exist.');
  process.exit(0);
} else {
  console.log(`${missing} missing. Create them in Settings → Properties → Tickets.`);
  process.exit(2);
}
