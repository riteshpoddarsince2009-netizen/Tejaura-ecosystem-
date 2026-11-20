import type {
  DiscoveredModelInfo,
  RuntimeAdapter,
  RuntimeDiscoveryResult,
  RuntimeHealthResult,
  RuntimeInferenceRequest,
  RuntimeInferenceResponse,
  RuntimeLoadUnloadResult,
} from '../runtime-types.ts';
import { normalizeBaseUrl, performSafeRuntimeHttpCall } from './http-helper.ts';

export class OllamaRuntimeAdapter implements RuntimeAdapter {
  readonly runtime_type = 'ollama' as const;
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
  ): Promise<RuntimeHealthResult> {
    const base = normalizeBaseUrl(endpoint);
    const res = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/api/tags`,
      timeoutMs,
      signal,
    });

    return {
      healthy: res.ok,
      runtime_type: this.runtime_type,
      endpoint: base,
      latency_ms: res.latency_ms,
      status_code: res.status || undefined,
      error: res.ok ? undefined : res.error,
    };
  }

  async discoverModels(
    endpoint: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<RuntimeDiscoveryResult> {
    const base = normalizeBaseUrl(endpoint);
    const res = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/api/tags`,
      timeoutMs,
      signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        endpoint: base,
        models: [],
        error: res.error ?? 'Failed to query Ollama /api/tags.',
      };
    }

    const payload = res.json as { models?: unknown[] } | null;
    const rawModels = Array.isArray(payload?.models) ? payload.models : [];
    const models: DiscoveredModelInfo[] = [];

    for (const item of rawModels) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const name =
          typeof record.name === 'string'
            ? record.name
            : typeof record.model === 'string'
              ? record.model
              : null;
        if (name) {
          models.push({
            model_name: name,
            runtime_type: this.runtime_type,
            size_bytes: typeof record.size === 'number' ? record.size : undefined,
            details:
              record.details && typeof record.details === 'object'
                ? (record.details as Record<string, unknown>)
                : undefined,
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
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<RuntimeLoadUnloadResult> {
    const base = normalizeBaseUrl(endpoint);
    const res = await performSafeRuntimeHttpCall({
      method: 'POST',
      url: `${base}/api/generate`,
      body: {
        model: modelName,
        prompt: '',
        keep_alive: '5m',
        stream: false,
      },
      timeoutMs,
      signal,
    });

    return {
      ok: res.ok,
      supported: true,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'load',
      code: res.ok ? 'MODEL_LOADED' : res.error_code ?? 'LOAD_FAILED',
      message: res.ok
        ? `Ollama preloaded model "${modelName}".`
        : res.error ?? `Failed to load Ollama model "${modelName}".`,
    };
  }

  async unloadModel(
    endpoint: string,
    modelName: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<RuntimeLoadUnloadResult> {
    const base = normalizeBaseUrl(endpoint);
    const res = await performSafeRuntimeHttpCall({
      method: 'POST',
      url: `${base}/api/generate`,
      body: {
        model: modelName,
        keep_alive: 0,
        stream: false,
      },
      timeoutMs,
      signal,
    });

    return {
      ok: res.ok,
      supported: true,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'unload',
      code: res.ok ? 'MODEL_UNLOADED' : res.error_code ?? 'UNLOAD_FAILED',
      message: res.ok
        ? `Ollama unloaded model "${modelName}".`
        : res.error ?? `Failed to unload Ollama model "${modelName}".`,
    };
  }

  async infer(
    endpoint: string,
    request: RuntimeInferenceRequest,
  ): Promise<RuntimeInferenceResponse> {
    const base = normalizeBaseUrl(endpoint);
    const res = await performSafeRuntimeHttpCall({
      method: 'POST',
      url: `${base}/api/chat`,
      body: {
        model: request.model_name,
        messages: request.messages,
        stream: false,
        options: {
          ...(request.max_tokens !== undefined
            ? { num_predict: request.max_tokens }
            : {}),
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
        },
      },
      timeoutMs: request.timeout_ms ?? 30_000,
      signal: request.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        runtime_type: this.runtime_type,
        model_name: request.model_name,
        output_text: '',
        untrusted_model_output: true,
        latency_ms: res.latency_ms,
        cancelled: res.cancelled,
        timed_out: res.timed_out,
        error_code: res.error_code ?? 'INFERENCE_FAILED',
        error: res.error ?? 'Ollama inference failed.',
      };
    }

    const payload = res.json as {
      message?: { content?: unknown };
      done_reason?: unknown;
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    } | null;

    const outputText =
      typeof payload?.message?.content === 'string'
        ? payload.message.content
        : '';
    const promptTokens =
      typeof payload?.prompt_eval_count === 'number'
        ? payload.prompt_eval_count
        : undefined;
    const completionTokens =
      typeof payload?.eval_count === 'number' ? payload.eval_count : undefined;

    return {
      ok: true,
      runtime_type: this.runtime_type,
      model_name: request.model_name,
      output_text: outputText,
      untrusted_model_output: true,
      finish_reason:
        typeof payload?.done_reason === 'string'
          ? payload.done_reason
          : 'stop',
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens:
                promptTokens !== undefined && completionTokens !== undefined
                  ? promptTokens + completionTokens
                  : undefined,
            }
          : undefined,
      latency_ms: res.latency_ms,
    };
  }
}
