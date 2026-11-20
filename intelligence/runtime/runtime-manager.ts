import type { Approval, ExecutionEnvironment } from '../../contracts/types/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import {
  evaluatePolicyWithAudit,
  type PolicyActor,
  type PolicyEvaluationResult,
} from '../../core/policy/index.ts';
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

export class RuntimeManager {
  private readonly adapters = new Map<LocalRuntimeType, RuntimeAdapter>();
  private readonly trustedEndpoints = new Map<string, TrustedRuntimeEndpoint>();

  constructor(options?: {
    adapters?: RuntimeAdapter[];
    trustedEndpoints?: TrustedRuntimeEndpoint[];
  }) {
    const defaults: RuntimeAdapter[] = [
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
      const check = validateControlledEndpointUrl(endpoint.base_url);
      if (!check.valid || !check.normalized_url) {
        throw new Error(
          `Invalid trusted runtime endpoint "${endpoint.endpoint_id}": ${check.error}`,
        );
      }
      this.trustedEndpoints.set(endpoint.endpoint_id, {
        ...endpoint,
        base_url: check.normalized_url,
      });
    }
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

    const urlCheck = validateControlledEndpointUrl(endpoint.base_url);
    if (!urlCheck.valid || !urlCheck.normalized_url) {
      return {
        ok: false,
        code: urlCheck.code ?? 'INVALID_ENDPOINT_URL',
        error: urlCheck.error ?? 'Invalid runtime endpoint URL.',
      };
    }

    const stored: TrustedRuntimeEndpoint = {
      ...endpoint,
      base_url: urlCheck.normalized_url,
    };
    this.trustedEndpoints.set(stored.endpoint_id, stored);

    return {
      ok: true,
      code: 'ENDPOINT_REGISTERED',
      endpoint: { ...stored },
      policy,
    };
  }

  private resolveAdapterAndEndpoint(
    runtimeType: LocalRuntimeType,
    requestedEndpoint: string,
  ):
    | { ok: true; adapter: RuntimeAdapter; baseUrl: string; trusted: TrustedRuntimeEndpoint }
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

    return resolved.adapter.healthCheck(resolved.baseUrl, timeoutMs, signal);
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

    return resolved.adapter.infer(resolved.baseUrl, request);
  }
}
