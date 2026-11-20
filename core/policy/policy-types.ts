import type {
  Agent,
  Approval,
  AutonomyLevel,
  ExecutionEnvironment,
} from '../../contracts/types/index.ts';
import type { AuditLogger } from '../audit/index.ts';

export type PolicyActorType = 'owner' | 'agent' | 'system' | 'adapter';

export type PolicyDecisionKind = 'allow' | 'deny' | 'require_approval';

export interface PolicyActor {
  id: string;
  type: PolicyActorType;
  trusted_autonomy_level: AutonomyLevel;
  trusted_authenticated?: boolean;
  trusted_agent_record?: Agent;
}

export interface PolicyResource {
  id: string;
  type: string;
  path?: string;
}

export interface PolicyActionDefinition {
  action: string;
  required_autonomy: AutonomyLevel;
  required_scope: string;
  owner_exclusive: boolean;
  allowed_environments: readonly ExecutionEnvironment[];
  description: string;
}

export interface PolicyEvaluationInput {
  actor: PolicyActor;
  action: string;
  resource: PolicyResource;
  environment: ExecutionEnvironment;
  declared_scopes: readonly string[];
  approval?: Approval | null;
  approval_consumed?: boolean;
  owner_confirmed_l4?: boolean;
  system_config: unknown;
  now?: Date | string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  decision: PolicyDecisionKind;
  reason_code: string;
  reason: string;
  required_approval_level: AutonomyLevel;
  policy_version: string;
}

export interface AuditedPolicyEvaluationInput extends PolicyEvaluationInput {
  audit_logger: AuditLogger;
  correlation_id: string;
}
