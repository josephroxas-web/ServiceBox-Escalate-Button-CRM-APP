// Creates the 3 missing ticket properties via the HubSpot API.
//
// Usage:
//   $env:HUBSPOT_TOKEN = "pat-na1-..."     # token needs crm.schemas.tickets.write
//   node scripts/create-properties.mjs

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('Missing HUBSPOT_TOKEN env var. Token needs scope crm.schemas.tickets.write.');
  process.exit(1);
}

const GROUP = 'ticketinformation'; // default ticket property group

const PROPERTIES = [
  {
    name: 'linked_escalation_ticket_id',
    label: 'Linked escalation ticket',
    description: 'ID of the paired escalated ticket (TET).',
    groupName: GROUP,
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'defect_priority',
    label: 'Defect priority',
    description: 'P0–P3 priority calculated from BugScore per the SOP.',
    groupName: GROUP,
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'P0', value: 'P0', displayOrder: 0 },
      { label: 'P1', value: 'P1', displayOrder: 1 },
      { label: 'P2', value: 'P2', displayOrder: 2 },
      { label: 'P3', value: 'P3', displayOrder: 3 },
    ],
  },
  {
    name: 'incident_triggered',
    label: 'Incident triggered',
    description: 'Whether the escalation crossed the IncidentScore ≥ 10 threshold.',
    groupName: GROUP,
    type: 'enumeration',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No',  value: 'false', displayOrder: 1 },
    ],
  },
];

let failed = 0;
for (const prop of PROPERTIES) {
  process.stdout.write(`Creating ${prop.name} ... `);
  const resp = await fetch('https://api.hubapi.com/crm/v3/properties/tickets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prop),
  });

  if (resp.ok) {
    console.log('✓');
  } else {
    failed++;
    const body = await resp.text();
    console.log(`✗ ${resp.status}`);
    console.log(`    ${body}`);
  }
}

console.log('');
process.exit(failed === 0 ? 0 : 2);
