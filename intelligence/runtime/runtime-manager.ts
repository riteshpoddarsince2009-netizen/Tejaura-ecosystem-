import type { Approval, ExecutionEnvironment } from '../../contracts/types/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import {
  evaluatePolicyWithAudit,
  type PolicyActor,
  type PolicyEvaluationResult,
} from '../../core/policy/index.ts';
import {
  AIRLLM_WORKER_TOKEN_HEADER,
  AirLlmRuntimeAdapter,
} from './adapters/airllm-adapter.ts';
import { LlamaCppRuntimeAdapter } from './adapters/llama-cpp-adapter.ts';
import { OllamaRuntimeAdapter } from './adapters/ollama-adapter.ts';
import { OpenAiCompatibleLocalAdapter } from './adapters/openai-compatible-adapter.ts';
import { SglangRuntimeAdapter } from './adapters/sglang-adapter.ts';
import { VllmRuntimeAdapter } from './adapters/vllm-adapter.ts';
import {
  resolveTrustedEndpoint,
  validateControlledEndpointUrl,
} from './endpoint-guard.ts';
import type {
  LoadModelMetadata,
  LocalRuntimeType,
  RuntimeAdapter,
  RuntimeDiscoveryResult,
  RuntimeHealthResult,
  RuntimeInferenceRequest,
  RuntimeInferenceResponse,
  RuntimeLoadUnloadResult,
  RuntimeSupportFlags,
  TrustedRuntimeEndpoint,
} from './runtime-types.ts';

export interface RuntimeGovernanceContext {
  actor: PolicyActor;
  declared_scopes: readonly string[];
  environment: ExecutionEnvironment;
  system_config: unknown;
  audit_logger: AuditLogger;
  correlation_id: string;
  approval?: Approval | null;
  now?: Date | string;
}

export interface RuntimeRegistrationResult {
  ok: boolean;
  code: string;
  error?: string;
  endpoint?: TrustedRuntimeEndpoint;
  policy?: PolicyEvaluationResult;
}

const VALID_ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export class RuntimeManager {
  private readonly adapters = new Map<LocalRuntimeType, RuntimeAdapter>();
  private readonly trustedEndpoints = new Map<string, TrustedRuntimeEndpoint>();
  private readonly authTokenResolver?: (
    endpoint: TrustedRuntimeEndpoint,
  ) => string | null | undefined;

  constructor(options?: {
    adapters?: RuntimeAdapter[];
    trustedEndpoints?: TrustedRuntimeEndpoint[];
    authTokenResolver?: (
      endpoint: TrustedRuntimeEndpoint,
    ) => string | null | undefined;
  }) {
    this.authTokenResolver = options?.authTokenResolver;

    const defaults: RuntimeAdapter[] = [
      new AirLlmRuntimeAdapter(),
      new OllamaRuntimeAdapter(),
      new LlamaCppRuntimeAdapter(),
      new VllmRuntimeAdapter(),
      new SglangRuntimeAdapter(),
      new OpenAiCompatibleLocalAdapter(),
    ];

    for (const adapter of options?.adapters ?? defaults) {
      this.adapters.set(adapter.runtime_type, adapter);
    }

    for (const endpoint of options?.trustedEndpoints ?? []) {
      const validated = this.validateEndpointRecord(endpoint);
      if (!validated.ok || !validated.normalized) {
        throw new Error(
          `Invalid trusted runtime endpoint "${endpoint.endpoint_id}": ${validated.error}`,
        );
      }
      this.trustedEndpoints.set(endpoint.endpoint_id, validated.normalized);
    }
  }

  private validateEndpointRecord(endpoint: TrustedRuntimeEndpoint): {
    ok: boolean;
    code?: string;
    error?: string;
    normalized?: TrustedRuntimeEndpoint;
  } {
    const check = validateControlledEndpointUrl(endpoint.base_url);
    if (!check.valid || !check.normalized_url) {
      return {
        ok: false,
        code: check.code ?? 'INVALID_ENDPOINT_URL',
        error: check.error ?? 'Invalid runtime endpoint URL.',
      };
    }

    if (
      endpoint.auth_token_env_var !== undefined &&
      !VALID_ENV_VAR_NAME.test(endpoint.auth_token_env_var)
    ) {
      return {
        ok: false,
        code: 'INVALID_AUTH_TOKEN_ENV_VAR',
        error:
          'auth_token_env_var must be an uppercase environment variable identifier (never a secret value).',
      };
    }

    return {
      ok: true,
      normalized: {
        ...endpoint,
        base_url: check.normalized_url,
      },
    };
  }

  getAdapterSupport(runtimeType: LocalRuntimeType): RuntimeSupportFlags | null {
    return this.adapters.get(runtimeType)?.support ?? null;
  }

  listTrustedEndpoints(): TrustedRuntimeEndpoint[] {
    return [...this.trustedEndpoints.values()].map((e) => ({ ...e }));
  }

  /**
   * Registers or updates a trusted runtime endpoint under strict L3 `runtime:manage` policy + owner approval.
   */
  registerTrustedEndpoint(
    endpoint: TrustedRuntimeEndpoint,
    governance: RuntimeGovernanceContext,
  ): RuntimeRegistrationResult {
    const policy = evaluatePolicyWithAudit({
      actor: governance.actor,
      action: 'runtime:manage',
      resource: {
        id: `runtime:${endpoint.endpoint_id}`,
        type: 'system',
      },
      environment: governance.environment,
      declared_scopes: governance.declared_scopes,
      approval: governance.approval,
      system_config: governance.system_config,
      audit_logger: governance.audit_logger,
      correlation_id: governance.correlation_id,
      now: governance.now,
    });

    if (!policy.allowed) {
      return {
        ok: false,
        code: policy.reason_code,
        error: policy.reason,
        policy,
      };
    }

    const validated = this.validateEndpointRecord(endpoint);
    if (!validated.ok || !validated.normalized) {
      return {
        ok: false,
        code: validated.code ?? 'INVALID_ENDPOINT_URL',
        error: validated.error ?? 'Invalid runtime endpoint URL.',
      };
    }

    this.trustedEndpoints.set(validated.normalized.endpoint_id, validated.normalized);

    return {
      ok: true,
      code: 'ENDPOINT_REGISTERED',
      endpoint: { ...validated.normalized },
      policy,
    };
  }

  private resolveAuthHeaders(
    endpoint: TrustedRuntimeEndpoint,
  ): Record<string, string> | undefined {
    const injected = this.authTokenResolver?.(endpoint);
    if (typeof injected === 'string' && injected.trim().length > 0) {
      return { [AIRLLM_WORKER_TOKEN_HEADER]: injected.trim() };
    }
    const envVarName =
      endpoint.auth_token_env_var ??
      (endpoint.runtime_type === 'airllm'
        ? 'TEJAURA_AIRLLM_WORKER_TOKEN'
        : undefined);
    if (envVarName) {
      const value = process.env[envVarName];
      if (typeof value === 'string' && value.trim().length > 0) {
        return { [AIRLLM_WORKER_TOKEN_HEADER]: value.trim() };
      }
    }
    return undefined;
  }

  private resolveAdapterAndEndpoint(
    runtimeType: LocalRuntimeType,
    requestedEndpoint: string,
  ):
    | {
        ok: true;
        adapter: RuntimeAdapter;
        baseUrl: string;
        trusted: TrustedRuntimeEndpoint;
        authHeaders?: Record<string, string>;
      }
    | { ok: false; code: string; error: string } {
    const adapter = this.adapters.get(runtimeType);
    if (!adapter) {
      return {
        ok: false,
        code: 'UNKNOWN_RUNTIME_TYPE',
        error: `No adapter registered for runtime "${runtimeType}".`,
      };
    }

    const resolved = resolveTrustedEndpoint(
      requestedEndpoint,
      runtimeType,
      [...this.trustedEndpoints.values()],
    );
    if (!resolved.trusted || !resolved.normalized_url || !resolved.endpoint) {
      return {
        ok: false,
        code: resolved.code ?? 'UNTRUSTED_RUNTIME_ENDPOINT',
        error: resolved.error ?? 'Requested endpoint is not trusted.',
      };
    }

    return {
      ok: true,
      adapter,
      baseUrl: resolved.normalized_url,
      trusted: resolved.endpoint,
      authHeaders: this.resolveAuthHeaders(resolved.endpoint),
    };
  }

  async healthCheck(
    runtimeType: LocalRuntimeType,
    endpointUrl: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeHealthResult> {
    const resolved = this.resolveAdapterAndEndpoint(runtimeType, endpointUrl);
    if (!resolved.ok) {
      return {
        healthy: false,
        runtime_type: runtimeType,
        endpoint: endpointUrl,
        latency_ms: 0,
        error: `${resolved.code}: ${resolved.error}`,
      };
    }

    return resolved.adapter.healthCheck(
      resolved.baseUrl,
      timeoutMs,
      signal,
      resolved.authHeaders,
    );
  }

  async discoverModels(
    runtimeType: LocalRuntimeType,
    endpointUrl: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      governance?: RuntimeGovernanceContext;
    },
  ): Promise<RuntimeDiscoveryResult> {
    if (options?.governance) {
      const policy = evaluatePolicyWithAudit({
        actor: options.governance.actor,
        action: 'model:discover',
        resource: { id: `runtime:${runtimeType}`, type: 'model' },
        environment: options.governance.environment,
        declared_scopes: options.governance.declared_scopes,
        approval: options.governance.approval,
        system_config: options.governance.system_config,
        audit_logger: options.governance.audit_logger,
        correlation_id: options.governance.correlation_id,
        now: options.governance.now,
      });
      if (!policy.allowed) {
        return {
          ok: false,
          supported: true,
          runtime_type: runtimeType,
          endpoint: endpointUrl,
          models: [],
          error: `${policy.reason_code}: ${policy.reason}`,
        };
      }
    }

    const resolved = this.resolveAdapterAndEndpoint(runtimeType, endpointUrl);
    if (!resolved.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: runtimeType,
        endpoint: endpointUrl,
        models: [],
        error: `${resolved.code}: ${resolved.error}`,
      };
    }

    return resolved.adapter.discoverModels(
      resolved.baseUrl,
      options?.timeoutMs,
      options?.signal,
      resolved.authHeaders,
    );
  }

  async loadModel(
    runtimeType: LocalRuntimeType,
    endpointUrl: string,
    modelName: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      governance?: RuntimeGovernanceContext;
      metadata?: LoadModelMetadata;
    },
  ): Promise<RuntimeLoadUnloadResult> {
    if (options?.governance) {
      const policy = evaluatePolicyWithAudit({
        actor: options.governance.actor,
        action: 'model:load',
        resource: { id: `model:${modelName}`, type: 'model' },
        environment: options.governance.environment,
        declared_scopes: options.governance.declared_scopes,
        approval: options.governance.approval,
        system_config: options.governance.system_config,
        audit_logger: options.governance.audit_logger,
        correlation_id: options.governance.correlation_id,
        now: options.governance.now,
      });
      if (!policy.allowed) {
        return {
          ok: false,
          supported: true,
          runtime_type: runtimeType,
          model_name: modelName,
          action: 'load',
          code: policy.reason_code,
          message: policy.reason,
        };
      }
    }

    const resolved = this.resolveAdapterAndEndpoint(runtimeType, endpointUrl);
    if (!resolved.ok) {
      return {
        ok: false,
        supported: false,
        runtime_type: runtimeType,
        model_name: modelName,
        action: 'load',
        code: resolved.code,
        message: resolved.error,
      };
    }

    return resolved.adapter.loadModel(
      resolved.baseUrl,
      modelName,
      options?.timeoutMs,
      options?.signal,
      resolved.authHeaders,
      options?.metadata,
    );
  }

  async unloadModel(
    runtimeType: LocalRuntimeType,
    endpointUrl: string,
    modelName: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      governance?: RuntimeGovernanceContext;
    },
  ): Promise<RuntimeLoadUnloadResult> {
    if (options?.governance) {
      const policy = evaluatePolicyWithAudit({
        actor: options.governance.actor,
        action: 'model:unload',
        resource: { id: `model:${modelName}`, type: 'model' },
        environment: options.governance.environment,
        declared_scopes: options.governance.declared_scopes,
        approval: options.governance.approval,
        system_config: options.governance.system_config,
        audit_logger: options.governance.audit_logger,
        correlation_id: options.governance.correlation_id,
        now: options.governance.now,
      });
      if (!policy.allowed) {
        return {
          ok: false,
          supported: true,
          runtime_type: runtimeType,
          model_name: modelName,
          action: 'unload',
          code: policy.reason_code,
          message: policy.reason,
        };
      }
    }

    const resolved = this.resolveAdapterAndEndpoint(runtimeType, endpointUrl);
    if (!resolved.ok) {
      return {
        ok: false,
        supported: false,
        runtime_type: runtimeType,
        model_name: modelName,
        action: 'unload',
        code: resolved.code,
        message: resolved.error,
      };
    }

    return resolved.adapter.unloadModel(
      resolved.baseUrl,
      modelName,
      options?.timeoutMs,
      options?.signal,
      resolved.authHeaders,
    );
  }

  async infer(
    runtimeType: LocalRuntimeType,
    endpointUrl: string,
    request: RuntimeInferenceRequest,
    governance?: RuntimeGovernanceContext,
  ): Promise<RuntimeInferenceResponse> {
    if (governance) {
      const policy = evaluatePolicyWithAudit({
        actor: governance.actor,
        action: 'model:invoke_local',
        resource: { id: `model:${request.model_name}`, type: 'model' },
        environment: governance.environment,
        declared_scopes: governance.declared_scopes,
        approval: governance.approval,
        system_config: governance.system_config,
        audit_logger: governance.audit_logger,
        correlation_id: governance.correlation_id,
        now: governance.now,
      });
      if (!policy.allowed) {
        return {
          ok: false,
          runtime_type: runtimeType,
          model_name: request.model_name,
          output_text: '',
          untrusted_model_output: true,
          latency_ms: 0,
          error_code: policy.reason_code,
          error: policy.reason,
        };
      }
    }

    const resolved = this.resolveAdapterAndEndpoint(runtimeType, endpointUrl);
    if (!resolved.ok) {
      return {
        ok: false,
        runtime_type: runtimeType,
        model_name: request.model_name,
        output_text: '',
        untrusted_model_output: true,
        latency_ms: 0,
        error_code: resolved.code,
        error: resolved.error,
      };
    }

    return resolved.adapter.infer(
      resolved.baseUrl,
      request,
      resolved.authHeaders,
    );
  }
}
