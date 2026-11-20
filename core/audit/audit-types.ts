import type {
  AuditActorType,
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
} from '../../contracts/types/index.ts';

export type AuditStorageWriteResult =
  | { ok: true }
  | { ok: false; error: string };

export interface AuditStorage {
  appendLine: (jsonLine: string) => AuditStorageWriteResult;
}

export interface AuditLogInput {
  actor_type: AuditActorType;
  actor_id: string;
  event_type: string;
  resource_type: AuditResourceType;
  resource_id: string;
  action: string;
  outcome: AuditOutcome;
  correlation_id: string;
  approval_id?: string | null;
  metadata?: Record<string, unknown>;
}

export type AuditLogResult =
  | {
      ok: true;
      event: AuditEvent;
    }
  | {
      ok: false;
      error: string;
    };

export interface AuditLoggerOptions {
  storage: AuditStorage;
  clock?: () => Date;
  idGenerator?: () => string;
}
