import crypto from 'node:crypto';

import type {
  DiscoveredModelInfo,
  LoadModelMetadata,
  RuntimeAdapter,
  RuntimeDiscoveryResult,
  RuntimeHealthResult,
  RuntimeInferenceRequest,
  RuntimeInferenceResponse,
  RuntimeLoadUnloadResult,
} from '../runtime-types.ts';
import { normalizeBaseUrl, performSafeRuntimeHttpCall } from './http-helper.ts';

export const AIRLLM_WORKER_TOKEN_HEADER = 'X-TEJAURA-Worker-Token';

interface WorkerStructuredError {
  code?: string;
  message?: string;
}

function extractWorkerError(json: unknown, fallbackCode: string, fallbackMessage: string): {
  code: string;
  message: string;
} {
  if (json && typeof json === 'object') {
    const record = json as { error?: WorkerStructuredError | string; code?: string };
    if (record.error && typeof record.error === 'object') {
      return {
        code:
          typeof record.error.code === 'string' && record.error.code.length > 0
            ? record.error.code
            : fallbackCode,
        message:
          typeof record.error.message === 'string' && record.error.message.length > 0
            ? record.error.message
            : fallbackMessage,
      };
    }
    if (typeof record.error === 'string' && record.error.length > 0) {
      return {
        code: typeof record.code === 'string' ? record.code : fallbackCode,
        message: record.error,
      };
    }
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function resolveWorkerHeaders(
  authHeaders?: Record<string, string>,
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (authHeaders && Object.keys(authHeaders).length > 0) {
    return { ok: true, headers: authHeaders };
  }

  const envToken = process.env.TEJAURA_AIRLLM_WORKER_TOKEN;
  if (typeof envToken === 'string' && envToken.trim().length > 0) {
    return {
      ok: true,
      headers: { [AIRLLM_WORKER_TOKEN_HEADER]: envToken.trim() },
    };
  }

  return {
    ok: false,
    error:
      'Missing internal AirLLM worker authentication token (configure auth_token_env_var or TEJAURA_AIRLLM_WORKER_TOKEN).',
  };
}

export class AirLlmRuntimeAdapter implements RuntimeAdapter {
  readonly runtime_type = 'airllm' as const;
  readonly support = {
    supports_discovery: true,
    supports_health_check: true,
    supports_chat_inference: true,
    supports_completion_inference: true,
    supports_load_unload: true,
    supports_cancellation: true,
  } as const;

  async healthCheck(
    endpoint: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ): Promise<RuntimeHealthResult> {
    const base = normalizeBaseUrl(endpoint);
    const auth = resolveWorkerHeaders(authHeaders);
    if (!auth.ok) {
      return {
        healthy: false,
        runtime_type: this.runtime_type,
        endpoint: base,
        latency_ms: 0,
        error: `MISSING_WORKER_AUTH_TOKEN: ${auth.error}`,
      };
    }

    const res = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/internal/health`,
      headers: auth.headers,
      timeoutMs,
      signal,
    });

    const payload =
      res.json && typeof res.json === 'object'
        ? (res.json as Record<string, unknown>)
        : null;
    const healthy = res.ok && payload?.ok === true;
    const workerErr = extractWorkerError(
      res.json,
      res.error_code ?? 'WORKER_UNHEALTHY',
      res.error ?? 'AirLLM worker health check failed.',
    );

    return {
      healthy,
      runtime_type: this.runtime_type,
      endpoint: base,
      latency_ms: res.latency_ms,
      status_code: res.status || undefined,
      details: payload ?? undefined,
      error: healthy ? undefined : `${workerErr.code}: ${workerErr.message}`,
    };
  }

  async discoverModels(
    endpoint: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ): Promise<RuntimeDiscoveryResult> {
    const base = normalizeBaseUrl(endpoint);
    const auth = resolveWorkerHeaders(authHeaders);
    if (!auth.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        endpoint: base,
        models: [],
        error: `MISSING_WORKER_AUTH_TOKEN: ${auth.error}`,
      };
    }

    const res = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/internal/models`,
      headers: auth.headers,
      timeoutMs,
      signal,
    });

    if (!res.ok) {
      const workerErr = extractWorkerError(
        res.json,
        res.error_code ?? 'DISCOVERY_FAILED',
        res.error ?? 'Failed to query AirLLM worker /internal/models.',
      );
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        endpoint: base,
        models: [],
        error: `${workerErr.code}: ${workerErr.message}`,
      };
    }

    const payload = res.json as { models?: unknown[] } | null;
    const rawModels = Array.isArray(payload?.models) ? payload.models : [];
    const models: DiscoveredModelInfo[] = [];

    for (const item of rawModels) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const name =
          typeof record.model_name === 'string'
            ? record.model_name
            : typeof record.model_id === 'string'
              ? record.model_id
              : null;
        if (name) {
          models.push({
            model_name: name,
            runtime_type: this.runtime_type,
            size_bytes:
              typeof record.size_bytes === 'number'
                ? record.size_bytes
                : undefined,
            details: record,
          });
        }
      }
    }

    return {
      ok: true,
      supported: true,
      runtime_type: this.runtime_type,
      endpoint: base,
      models,
    };
  }

  async loadModel(
    endpoint: string,
    modelName: string,
    timeoutMs = 60_000,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
    metadata?: LoadModelMetadata,
  ): Promise<RuntimeLoadUnloadResult> {
    const base = normalizeBaseUrl(endpoint);
    if (
      metadata?.compatibility_status !== undefined &&
      metadata.compatibility_status !== 'verified'
    ) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'load',
        code:
          metadata.compatibility_status === 'unsupported'
            ? 'MODEL_COMPATIBILITY_UNSUPPORTED'
            : 'MODEL_COMPATIBILITY_UNTESTED',
        message: `Refusing to load "${modelName}" on AirLLM: compatibility_status is "${metadata.compatibility_status}" (only "verified" models are permitted).`,
      };
    }

    if (metadata?.modality !== undefined && metadata.modality !== 'text') {
      return {
        ok: false,
        supported: false,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'load',
        code: 'UNSUPPORTED_AIRLLM_MODALITY',
        message: `Refusing to load "${modelName}" on AirLLM: modality "${metadata.modality}" has no verified AirLLM execution path.`,
      };
    }

    const auth = resolveWorkerHeaders(authHeaders);
    if (!auth.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'load',
        code: 'MISSING_WORKER_AUTH_TOKEN',
        message: auth.error,
      };
    }

    const res = await performSafeRuntimeHttpCall({
      method: 'POST',
      url: `${base}/internal/models/load`,
      headers: auth.headers,
      body: {
        model_id: metadata?.model_id ?? modelName,
        model_name: modelName,
        repo_id: metadata?.repo_id,
        revision: metadata?.revision,
        local_model_path: metadata?.local_model_path ?? null,
        compatibility_status: metadata?.compatibility_status ?? 'verified',
        modality: metadata?.modality ?? 'text',
        compression: metadata?.compression ?? null,
        layer_shards_saving_path: metadata?.layer_shards_saving_path ?? null,
      },
      timeoutMs,
      signal,
    });

    if (!res.ok) {
      const workerErr = extractWorkerError(
        res.json,
        res.error_code ?? 'AIRLLM_LOAD_FAILED',
        res.error ?? `Failed to load "${modelName}" on AirLLM worker.`,
      );
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'load',
        code: workerErr.code,
        message: workerErr.message,
      };
    }

    return {
      ok: true,
      supported: true,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'load',
      code: 'MODEL_LOADED',
      message: `AirLLM worker loaded "${modelName}".`,
    };
  }

  async unloadModel(
    endpoint: string,
    modelName: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ): Promise<RuntimeLoadUnloadResult> {
    const base = normalizeBaseUrl(endpoint);
    const auth = resolveWorkerHeaders(authHeaders);
    if (!auth.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'unload',
        code: 'MISSING_WORKER_AUTH_TOKEN',
        message: auth.error,
      };
    }

    const res = await performSafeRuntimeHttpCall({
      method: 'POST',
      url: `${base}/internal/models/unload`,
      headers: auth.headers,
      body: { model_name: modelName },
      timeoutMs,
      signal,
    });

    if (!res.ok) {
      const workerErr = extractWorkerError(
        res.json,
        res.error_code ?? 'AIRLLM_UNLOAD_FAILED',
        res.error ?? `Failed to unload "${modelName}" from AirLLM worker.`,
      );
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        model_name: modelName,
        action: 'unload',
        code: workerErr.code,
        message: workerErr.message,
      };
    }

    return {
      ok: true,
      supported: true,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'unload',
      code: 'MODEL_UNLOADED',
      message: `AirLLM worker unloaded "${modelName}".`,
    };
  }

  async infer(
    endpoint: string,
    request: RuntimeInferenceRequest,
    authHeaders?: Record<string, string>,
  ): Promise<RuntimeInferenceResponse> {
    const base = normalizeBaseUrl(endpoint);

    if (
      request.compatibility_status !== undefined &&
      request.compatibility_status !== 'verified'
    ) {
      return {
        ok: false,
        runtime_type: this.runtime_type,
        model_name: request.model_name,
        output_text: '',
        untrusted_model_output: true,
        latency_ms: 0,
        error_code:
          request.compatibility_status === 'unsupported'
            ? 'MODEL_COMPATIBILITY_UNSUPPORTED'
            : 'MODEL_COMPATIBILITY_UNTESTED',
        error: `Model "${request.model_name}" has compatibility_status "${request.compatibility_status}" and cannot execute inference on AirLLM.`,
      };
    }

    if (request.modality !== undefined && request.modality !== 'text') {
      return {
        ok: false,
        runtime_type: this.runtime_type,
        model_name: request.model_name,
        output_text: '',
        untrusted_model_output: true,
        latency_ms: 0,
        error_code: 'UNSUPPORTED_AIRLLM_MODALITY',
        error: `Modality "${request.modality}" is not enabled for AirLLM text inference.`,
      };
    }

    const auth = resolveWorkerHeaders(authHeaders);
    if (!auth.ok) {
      return {
        ok: false,
        runtime_type: this.runtime_type,
        model_name: request.model_name,
        output_text: '',
        untrusted_model_output: true,
        latency_ms: 0,
        error_code: 'MISSING_WORKER_AUTH_TOKEN',
        error: auth.error,
      };
    }

    const requestId = request.request_id ?? crypto.randomUUID();
    const onAbort = () => {
      void performSafeRuntimeHttpCall({
        method: 'POST',
        url: `${base}/internal/requests/cancel`,
        headers: auth.headers,
        body: { request_id: requestId },
        timeoutMs: 2_000,
      });
    };

    if (request.signal && !request.signal.aborted) {
      request.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await performSafeRuntimeHttpCall({
        method: 'POST',
        url: `${base}/internal/infer`,
        headers: auth.headers,
        body: {
          request_id: requestId,
          model_name: request.model_name,
          messages: request.messages,
          compatibility_status: request.compatibility_status ?? 'verified',
          modality: request.modality ?? 'text',
          max_new_tokens: request.max_tokens ?? 256,
          temperature: request.temperature,
          timeout_ms: request.timeout_ms ?? 60_000,
        },
        timeoutMs: request.timeout_ms ?? 60_000,
        signal: request.signal,
      });

      if (!res.ok) {
        const workerErr = extractWorkerError(
          res.json,
          res.error_code ?? 'AIRLLM_INFERENCE_FAILED',
          res.error ?? 'AirLLM inference failed.',
        );
        return {
          ok: false,
          runtime_type: this.runtime_type,
          model_name: request.model_name,
          output_text: '',
          untrusted_model_output: true,
          latency_ms: res.latency_ms,
          cancelled: res.cancelled || workerErr.code === 'REQUEST_CANCELLED',
          timed_out: res.timed_out || workerErr.code === 'REQUEST_TIMEOUT',
          error_code: workerErr.code,
          error: workerErr.message,
        };
      }

      const payload = res.json as {
        output_text?: unknown;
        finish_reason?: unknown;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        };
      } | null;

      return {
        ok: true,
        runtime_type: this.runtime_type,
        model_name: request.model_name,
        output_text:
          typeof payload?.output_text === 'string' ? payload.output_text : '',
        untrusted_model_output: true,
        finish_reason:
          typeof payload?.finish_reason === 'string'
            ? payload.finish_reason
            : 'stop',
        usage: payload?.usage
          ? {
              prompt_tokens:
                typeof payload.usage.prompt_tokens === 'number'
                  ? payload.usage.prompt_tokens
                  : undefined,
              completion_tokens:
                typeof payload.usage.completion_tokens === 'number'
                  ? payload.usage.completion_tokens
                  : undefined,
              total_tokens:
                typeof payload.usage.total_tokens === 'number'
                  ? payload.usage.total_tokens
                  : undefined,
            }
          : undefined,
        latency_ms: res.latency_ms,
      };
    } finally {
      if (request.signal) {
        request.signal.removeEventListener('abort', onAbort);
      }
    }
  }
}
