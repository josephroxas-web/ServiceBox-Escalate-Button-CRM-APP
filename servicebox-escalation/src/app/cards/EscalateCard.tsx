import { useState, useEffect } from 'react';
import {
  hubspot,
  Button,
  ButtonRow,
  Divider,
  Flex,
  Text,
  Alert,
  LoadingSpinner,
  Input,
  Select,
  MultiSelect,
  TextArea,
} from '@hubspot/ui-extensions';

type FormField = {
  name: string;
  label: string;
  fieldType:
    | 'single_line_text'
    | 'multi_line_text'
    | 'select'
    | 'number'
    | 'multiple_checkboxes';
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
};

type EscalationInfo = {
  escalatedTicketId?: string;
  incidentTicketId?: string | null;
  escalatedAt?: string;
  priority?: string;
  severity?: string;
  bugScore?: number;
  incidentScore?: number;
  severityScore?: number;
  shouldCreateIncident?: boolean;
};

type FunctionResult<T> = {
  statusCode: number;
  body: T & { error?: string };
};

type CardActions = {
  refreshObjectProperties?: () => void;
};

// Portal 46928821 — P&S Support Form.
//   (Test portal 51454166 form GUID kept for reference:
//    e6e06bdf-d4f5-41aa-81c2-c30269029d76)
const ESCALATION_FORM_GUID = 'cdd5930c-5f3e-46e7-8a1d-a1916a2c1b02';

hubspot.extend<'crm.record.sidebar'>(({ context, actions }) => (
  <EscalateCard
    context={context}
    actions={actions as unknown as CardActions}
  />
));

type EscalateCardProps = {
  context: { crm?: { objectId?: string | number } };
  actions: CardActions;
};

async function callFn<T>(parameters: Record<string, any>): Promise<FunctionResult<T>> {
  return hubspot.serverless<FunctionResult<T>>('servicebox_escalation_app_function', { parameters });
}

const EscalateCard = ({ context, actions }: EscalateCardProps) => {
  const ticketId = context.crm?.objectId;

  const [view, setView] = useState<'intro' | 'form'>('intro');
  const [status, setStatus] = useState<
    'idle' | 'loading-form' | 'submitting' | 'success' | 'error'
  >('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [escalationInfo, setEscalationInfo] = useState<EscalationInfo | null>(null);

  // Load any prior escalation marker for this ticket on mount.
  useEffect(() => {
    callFn<EscalationInfo>({ action: 'status', ticketId }).then((resp) => {
      if (resp?.body?.escalatedTicketId) {
        setEscalationInfo(resp.body);
      }
    });
  }, [ticketId]);

  const openForm = async () => {
    setStatus('loading-form');
    setErrorMsg(null);

    try {
      const resp = await callFn<{ fields: FormField[] }>({
        action: 'getFormFields',
        formGuid: ESCALATION_FORM_GUID,
      });

      if (resp.statusCode !== 200) {
        throw new Error(resp.body?.error || 'Failed to load escalation form.');
      }

      setFields(resp.body.fields || []);
      setValues({});
      setView('form');
      setStatus('idle');
    } catch (e: any) {
      setErrorMsg(e?.message || 'Could not load form.');
      setStatus('error');
    }
  };

  const submitEscalation = async () => {
    setStatus('submitting');
    setErrorMsg(null);

    try {
      const resp = await callFn<EscalationInfo>({
        action: 'escalate',
        ticketId,
        formGuid: ESCALATION_FORM_GUID,
        answers: values,
      });

      if (resp.statusCode !== 200) {
        throw new Error(resp.body?.error || 'Escalation failed.');
      }

      setEscalationInfo({
        escalatedTicketId: resp.body.escalatedTicketId,
        incidentTicketId: resp.body.incidentTicketId,
        escalatedAt: new Date().toISOString(),
        priority: resp.body.priority,
        severity: resp.body.severity,
        bugScore: resp.body.bugScore,
        incidentScore: resp.body.incidentScore,
        severityScore: resp.body.severityScore,
        shouldCreateIncident: resp.body.shouldCreateIncident,
      });
      setStatus('success');
      setView('intro');
      actions.refreshObjectProperties?.();
    } catch (e: any) {
      setErrorMsg(e?.message || 'Escalation failed.');
      setStatus('error');
    }
  };

  const setValue = (name: string, v: string) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  // ----- Already-escalated view -----
  if (escalationInfo?.escalatedTicketId) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Escalation Ticket Created" variant="info">
          <Flex direction="row" align="center" gap="xs">
            <Text>Linked ticket:</Text>
            <Text format={{ fontWeight: 'bold' }}>
              #{escalationInfo.escalatedTicketId}
            </Text>
          </Flex>
        </Alert>
        {escalationInfo.incidentTicketId && (
          <Alert title="Incident Triggered" variant="warning">
            <Flex direction="column" gap="xs">
              <Flex direction="row" align="center" gap="xs">
                <Text>Incident ticket:</Text>
                <Text format={{ fontWeight: 'bold' }}>
                  #{escalationInfo.incidentTicketId}
                </Text>
                {escalationInfo.severity && (
                  <Text format={{ fontWeight: 'bold' }}>
                    ({escalationInfo.severity})
                  </Text>
                )}
              </Flex>
              <Text variant="microcopy">
                Per SOP: incident creation is forward-only — close the incident
                if it was opened in error; the escalation ticket remains.
              </Text>
            </Flex>
          </Alert>
        )}
      </Flex>
    );
  }

  // ----- Form view -----
  if (view === 'form') {
    return (
      <Flex direction="column" gap="md">
        <Text format={{ fontWeight: 'bold' }}>Technical escalation</Text>
        <Divider />

        {errorMsg && (
          <Alert title="Error" variant="error">
            {errorMsg}
          </Alert>
        )}

        {fields.map((f) => {
          const value = values[f.name] ?? '';
          if (f.fieldType === 'multi_line_text') {
            return (
              <TextArea
                key={f.name}
                name={f.name}
                label={f.label}
                required={f.required}
                value={value}
                onChange={(v) => setValue(f.name, v ?? '')}
              />
            );
          }
          if (f.fieldType === 'select') {
            return (
              <Select
                key={f.name}
                name={f.name}
                label={f.label}
                required={f.required}
                value={value}
                options={f.options || []}
                onChange={(v) => setValue(f.name, String(v ?? ''))}
              />
            );
          }
          if (f.fieldType === 'multiple_checkboxes') {
            const selected = value ? value.split(';').filter(Boolean) : [];
            const cleanedOptions = (f.options || []).map((o) => ({
              label: o.label.replace(/\s*\(.*?\)\s*/g, '').trim() || o.label,
              value: o.value,
            }));
            return (
              <MultiSelect
                key={f.name}
                name={f.name}
                label={f.label}
                required={f.required}
                value={selected}
                options={cleanedOptions}
                onChange={(vals) =>
                  setValue(
                    f.name,
                    (Array.isArray(vals) ? vals : []).map(String).join(';')
                  )
                }
              />
            );
          }
          return (
            <Input
              key={f.name}
              name={f.name}
              label={f.label}
              required={f.required}
              value={value}
              onChange={(v) => setValue(f.name, v ?? '')}
            />
          );
        })}

        <ButtonRow>
          <Button
            variant="primary"
            onClick={submitEscalation}
            disabled={status === 'submitting'}
          >
            {status === 'submitting' ? 'Escalating…' : 'Submit escalation'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setView('intro');
              setErrorMsg(null);
            }}
            disabled={status === 'submitting'}
          >
            Cancel
          </Button>
        </ButtonRow>
      </Flex>
    );
  }

  // ----- Intro view -----
  return (
    <Flex direction="column" gap="sm">
      <Text variant="microcopy">
        Send this ticket to the technical triage queue. A linked TET will be
        created; closing either side closes the other.
      </Text>

      {errorMsg && (
        <Alert title="Error" variant="error">
          {errorMsg}
        </Alert>
      )}

      {status === 'success' && (
        <Alert title="Escalated" variant="success">
          Linked ticket created and associated.
        </Alert>
      )}

      {status === 'loading-form' && <LoadingSpinner label="Loading form" />}
      <Button
        variant="destructive"
        onClick={openForm}
        disabled={status === 'loading-form' || status === 'submitting'}
      >
        {status === 'loading-form' ? 'Loading form…' : 'Escalate'}
      </Button>
    </Flex>
  );
};
