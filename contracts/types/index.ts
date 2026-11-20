export type { AutonomyLevel, TaskStatus, TaskError, Task } from './task.ts';
export type {
  AgentStatus,
  AgentPermittedAutonomyLevel,
  Agent,
} from './agent.ts';
export type { ToolCategory, ToolRiskLevel, Tool } from './tool.ts';
export type { ApprovalStatus, ApprovalScope, Approval } from './approval.ts';
export type {
  AuditActorType,
  AuditResourceType,
  AuditOutcome,
  AuditEvent,
} from './audit-event.ts';

export type ContractKind =
  | 'task'
  | 'agent'
  | 'tool'
  | 'approval'
  | 'audit_event';
