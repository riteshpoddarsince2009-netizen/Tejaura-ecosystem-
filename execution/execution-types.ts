import type {
  Agent,
  Approval,
  ExecutionEnvironment,
  Tool,
} from '../contracts/types/index.ts';
import type { ApprovalRecord } from '../core/approvals/index.ts';
import type { PolicyActor } from '../core/policy/index.ts';
import type {
  AgentExecutionError,
  AgentExecutionJobRecord,
  AgentExecutionLogRecord,
  AgentPermissionDecision,
  OrchestratedTaskRecord,
  SandboxBrowserMode,
  SandboxIsolationLevel,
  SandboxNetworkMode,
} from '../control-plane/db/index.ts';

export const SUPPORTED_AGENT_DEPARTMENTS = [
  'research',
  'engineering',
  'seo',
  'design',
  'content',
  'analytics',
  'customer_support',
] as const;

export type SupportedAgentDepartment =
  (typeof SUPPORTED_AGENT_DEPARTMENTS)[number];

export interface SandboxPolicyConfig {
  workspaceRoot: string;
  allowedRelativePaths?: string[];
  defaultNetworkMode?: SandboxNetworkMode;
  defaultBrowserMode?: SandboxBrowserMode;
  knownSecretValues?: string[];
}

export interface SubmitAgentExecutionInput {
  task_id?: string;
  task?: OrchestratedTaskRecord;
  attempt_id?: string | null;
  title: string;
  description: string;
  agent: Agent;
  tools: Tool[];
  requested_action: string;
  resource_id: string;
  environment: ExecutionEnvironment;
  declared_scopes: string[];
  requested_paths?: string[];
  requested_network_mode?: SandboxNetworkMode | 'unrestricted';
  requested_network_urls?: string[];
  requested_browser_mode?: SandboxBrowserMode | 'unrestricted';
  requested_browser_urls?: string[];
  requested_shell_command?: string;
  approval_id?: string | null;
  approval?: Approval | ApprovalRecord | null;
  owner_confirmed_l4?: boolean;
  sandbox_provider?: string;
  idempotency_key?: string;
  idempotent_action?: boolean;
  max_retries?: number;
  timeout_ms?: number;
  preferred_model_id?: string;
  input: Record<string, unknown>;
}

export interface AgentExecutionContext {
  initiator: PolicyActor;
  correlation_id: string;
}

export interface SandboxValidationResult {
  allowed: boolean;
  decision: AgentPermissionDecision;
  reason_code: string;
  reason: string;
  normalized_allowed_paths: string[];
  network_mode: SandboxNetworkMode;
  network_allowlist: string[];
  browser_mode: SandboxBrowserMode;
  browser_allowlist: string[];
  resolved_approval: ApprovalRecord | Approval | null;
}

export interface SandboxExecutionContext {
  job: AgentExecutionJobRecord;
  agent: Agent;
  tools: Tool[];
  workspace_root: string;
  allowed_paths: string[];
  network_mode: SandboxNetworkMode;
  network_allowlist: string[];
  browser_mode: SandboxBrowserMode;
  browser_allowlist: string[];
  correlation_id: string;
}

export type SandboxAdapterOutcome =
  | {
      ok: true;
      result: Record<string, unknown>;
      secrets_redacted?: boolean;
    }
  | {
      ok: false;
      error: AgentExecutionError;
      secrets_redacted?: boolean;
    };

export interface SandboxAdapter {
  readonly providerId: string;
  readonly isolationLevel: SandboxIsolationLevel;
  readonly supportsOsIsolation: boolean;
  readonly isolationDisclaimer: string;
  execute(
    context: SandboxExecutionContext,
    signal: AbortSignal,
  ): Promise<SandboxAdapterOutcome>;
}

export type SubmitAgentExecutionResult =
  | {
      ok: true;
      duplicate: boolean;
      job: AgentExecutionJobRecord;
      log: AgentExecutionLogRecord;
    }
  | {
      ok: false;
      decision: 'deny' | 'require_approval';
      code: string;
      error: string;
      task_id?: string;
      approval_id?: string;
      log: AgentExecutionLogRecord;
    };

export interface ExecuteAgentJobOutcome {
  executed: boolean;
  job: AgentExecutionJobRecord | null;
  log?: AgentExecutionLogRecord;
  retried?: boolean;
}
