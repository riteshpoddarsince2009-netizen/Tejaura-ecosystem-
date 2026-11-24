import crypto from 'node:crypto';

import type { Agent } from '../../contracts/types/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import type { PolicyActor } from '../../core/policy/index.ts';
import type {
  RuntimeManager,
  TrustedRuntimeEndpoint,
} from '../../intelligence/runtime/index.ts';
import { redactSensitiveText } from '../../execution/secret-redactor.ts';
import type {
  ModelWorkerCapabilities,
  ModelWorkerClient,
  ModelWorkerHealth,
  ModelWorkerRequest,
  ModelWorkerResponse,
} from './model-worker-types.ts';

export interface AirLlmModelWorkerOptions {
  worker_id: string;
  runtime: RuntimeManager;
  endpoint: TrustedRuntimeEndpoint;
  modelName: string;
  agent: Agent;
  auditLogger: AuditLogger;
  systemConfig: unknown;
  correlationId: string;
  maxContextLength?: number | null;
  knownSecretValues?: readonly string[];
}

/**
 * Provider-independent adapter for a separately hosted AirLLM worker.
 *
 * This class contains no model weights and never downloads model files. It
 * refuses to report inference success unless the RuntimeManager receives a
 * valid response from a registered, authenticated AirLLM worker.
 */
export class AirLlmModelWorker implements ModelWorkerClient {
  readonly worker_id: string;
  readonly runtime_type = 'airllm';

  private readonly runtime: RuntimeManager;
  private readonly endpoint: TrustedRuntimeEndpoint;
  private readonly modelName: string;
  private readonly agent: Agent;
  private readonly auditLogger: AuditLogger;
  private readonly systemConfig: unknown;
  private readonly correlationId: string;
  private readonly maxContextLength: number | null;
  private readonly knownSecretValues: readonly string[];

  constructor(options: AirLlmModelWorkerOptions) {
    this.worker_id = options.worker_id;
    this.runtime = options.runtime;
    this.endpoint = options.endpoint;
    this.modelName = options.modelName;
    this.agent = options.agent;
    this.auditLogger = options.auditLogger;
    this.systemConfig = options.systemConfig;
    this.correlationId = options.correlationId;
    this.maxContextLength = options.maxContextLength ?? null;
    this.knownSecretValues = options.knownSecretValues ?? [];
  }

  private actor(): PolicyActor {
    return {
      id: this.agent.id,
      type: 'agent',
      trusted_autonomy_level: this.agent.permitted_autonomy_level,
      trusted_authenticated: true,
      trusted_agent_record: this.agent,
    };
  }

  async health(timeoutMs = 5_000, signal?: AbortSignal): Promise<ModelWorkerHealth> {
    const result = await this.runtime.healthCheck(
      this.endpoint.runtime_type,
      this.endpoint.base_url,
      timeoutMs,
      signal,
    );
    const detailModels = result.details?.models;
    const models = Array.isArray(detailModels)
      ? detailModels
          .map((item) =>
            typeof item === 'string'
              ? item
              : item && typeof item === 'object' && 'model_name' in item
                ? String((item as { model_name?: unknown }).model_name ?? '')
                : '',
          )
          .filter((item) => item.length > 0)
      : result.healthy
        ? [this.modelName]
        : [];

    return {
      healthy: result.healthy,
      worker_id: this.worker_id,
      runtime_type: this.runtime_type,
      endpoint: this.endpoint.base_url,
      latency_ms: result.latency_ms,
      models,
      error: result.error,
      checked_at: new Date().toISOString(),
    };
  }

  async capabilities(): Promise<ModelWorkerCapabilities> {
    const support = this.runtime.getAdapterSupport('airllm');
    return {
      supports_chat: support?.supports_chat_inference ?? false,
      supports_completion: support?.supports_completion_inference ?? false,
      supports_streaming: false,
      supports_cancellation: support?.supports_cancellation ?? false,
      supports_tool_calling: false,
      supports_structured_output: false,
      max_context_length: this.maxContextLength,
    };
  }

  async infer(request: ModelWorkerRequest): Promise<ModelWorkerResponse> {
    const timeoutMs = request.timeout_ms ?? 60_000;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    const requestId = request.request_id ?? `mreq_${crypto.randomUUID()}`;
    try {
      const result = await this.runtime.infer(
        this.endpoint.runtime_type,
        this.endpoint.base_url,
        {
          request_id: requestId,
          model_name: request.model_name || this.modelName,
          messages: request.messages,
          max_tokens: request.max_tokens ?? 512,
          temperature: request.temperature,
          timeout_ms: timeoutMs,
          signal,
        },
        {
          actor: this.actor(),
          declared_scopes: ['model:invoke:local'],
          environment: 'local',
          system_config: this.systemConfig,
          audit_logger: this.auditLogger,
          correlation_id: this.correlationId,
        },
      );

      const redacted = redactSensitiveText(result.output_text, this.knownSecretValues);
      return {
        ok: result.ok,
        worker_id: this.worker_id,
        runtime_type: this.runtime_type,
        model_name: result.model_name,
        output_text: redacted.value,
        untrusted_model_output: true,
        finish_reason: result.finish_reason,
        usage: result.usage,
        latency_ms: result.latency_ms,
        cancelled: result.cancelled,
        timed_out:
          result.timed_out ||
          (timeoutController.signal.aborted && !request.signal?.aborted),
        error_code: result.error_code,
        error: result.error
          ? redactSensitiveText(result.error, this.knownSecretValues).value
          : result.error,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
