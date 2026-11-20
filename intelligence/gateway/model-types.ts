import type {
  AgentPermittedAutonomyLevel,
  Approval,
  ExecutionEnvironment,
} from '../../contracts/types/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import type { PolicyActor } from '../../core/policy/index.ts';
import type {
  ModelCostTier,
  ModelEntry,
  ModelProviderType,
} from '../model-registry/validate-model-registry.ts';

export interface ModelCapabilities {
  text_generation: boolean;
  streaming: boolean;
  system_prompt?: boolean;
  json_mode?: boolean;
  tool_calling?: boolean;
  reasoning?: boolean;
  max_context_tokens?: number;
}

export interface ModelMetadata {
  id: string;
  display_name: string;
  provider_type: ModelProviderType;
  adapter: string;
  cost_tier: ModelCostTier;
  capabilities: ModelCapabilities;
  max_autonomy_allowed: AgentPermittedAutonomyLevel;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  request_id: string;
  correlation_id: string;
  model_id: string;
  messages: readonly ModelMessage[];
  required_capabilities?: readonly string[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type ModelErrorCode =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'STREAMING_NOT_IMPLEMENTED'
  | 'BROWSER_EXECUTION_FORBIDDEN'
  | 'ENDPOINT_NOT_ALLOWLISTED'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'POLICY_CONTEXT_MISSING'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_HTTP_ERROR'
  | 'MALFORMED_PROVIDER_RESPONSE'
  | 'INTERNAL_ERROR';

export interface ModelError {
  code: ModelErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
  status_code?: number;
}

export type ModelResponse =
  | {
      ok: true;
      request_id: string;
      model_id: string;
      adapter: string;
      output_text: string;
      finish_reason: 'stop' | 'length';
      usage: ModelUsage;
      latency_ms: number;
    }
  | {
      ok: false;
      request_id: string;
      model_id: string;
      adapter: string;
      error: ModelError;
      latency_ms: number;
    };

export interface SecretResolver {
  resolveSecret: (envVarName: string) => Promise<string | null> | string | null;
}

export interface AdapterExecutionContext {
  model: ModelEntry;
  secretResolver?: SecretResolver;
  now?: () => Date;
}

export interface GatewayPolicyContext {
  actor: PolicyActor;
  environment: ExecutionEnvironment;
  declared_scopes: readonly string[];
  approval?: Approval | null;
  approval_consumed?: boolean;
  system_config: unknown;
  now?: Date | string;
}

export interface GatewayInvokeInput {
  request: ModelRequest;
  model: ModelEntry;
  adapter: import('./model-adapter.ts').ModelAdapter;
  policy_context: GatewayPolicyContext | null | undefined;
  secret_resolver?: SecretResolver;
  audit_logger?: AuditLogger;
  now?: () => Date;
}
