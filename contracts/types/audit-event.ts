export type AuditActorType =
  | 'owner'
  | 'agent'
  | 'system'
  | 'policy_engine'
  | 'adapter';

export type AuditResourceType =
  | 'task'
  | 'agent'
  | 'tool'
  | 'approval'
  | 'model'
  | 'configuration'
  | 'governance'
  | 'system';

export type AuditOutcome =
  | 'success'
  | 'failure'
  | 'denied'
  | 'pending'
  | 'cancelled';

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor_type: AuditActorType;
  actor_id: string;
  event_type: string;
  resource_type: AuditResourceType;
  resource_id: string;
  action: string;
  outcome: AuditOutcome;
  approval_id: string | null;
  metadata: Record<string, unknown>;
  schema_version?: string;
}
