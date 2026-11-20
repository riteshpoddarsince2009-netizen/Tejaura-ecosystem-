import type {
  DiscoveredModelInfo,
  LocalRuntimeType,
  RuntimeAdapter,
  RuntimeDiscoveryResult,
  RuntimeHealthResult,
  RuntimeInferenceRequest,
  RuntimeInferenceResponse,
  RuntimeLoadUnloadResult,
} from '../runtime-types.ts';
import { normalizeBaseUrl, performSafeRuntimeHttpCall } from './http-helper.ts';

export function parseOpenAiCompatibleModels(
  json: unknown,
  runtimeType: LocalRuntimeType,
): DiscoveredModelInfo[] {
  if (!json || typeof json !== 'object') {
    return [];
  }
  const record = json as { data?: unknown[]; models?: unknown[] };
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  const discovered: DiscoveredModelInfo[] = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const item = entry as Record<string, unknown>;
      const id =
        typeof item.id === 'string'
          ? item.id
          : typeof item.name === 'string'
            ? item.name
            : null;
      if (id) {
        discovered.push({
          model_name: id,
          runtime_type: runtimeType,
          details: item,
        });
      }
    }
  }
  return discovered;
}

export async function runOpenAiCompatibleChatInference(
  runtimeType: LocalRuntimeType,
  endpoint: string,
  request: RuntimeInferenceRequest,
): Promise<RuntimeInferenceResponse> {
  const base = normalizeBaseUrl(endpoint);
  const res = await performSafeRuntimeHttpCall({
    method: 'POST',
    url: `${base}/v1/chat/completions`,
    body: {
      model: request.model_name,
      messages: request.messages,
      stream: false,
      ...(request.max_tokens !== undefined
        ? { max_tokens: request.max_tokens }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    },
    timeoutMs: request.timeout_ms ?? 30_000,
    signal: request.signal,
  });

  if (!res.ok) {
    return {
      ok: false,
      runtime_type: runtimeType,
      model_name: request.model_name,
      output_text: '',
      untrusted_model_output: true,
      latency_ms: res.latency_ms,
      cancelled: res.cancelled,
      timed_out: res.timed_out,
      error_code: res.error_code ?? 'INFERENCE_FAILED',
      error: res.error ?? `${runtimeType} inference failed.`,
    };
  }

  const payload = res.json as {
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
      finish_reason?: unknown;
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  } | null;

  const firstChoice = Array.isArray(payload?.choices)
    ? payload.choices[0]
    : undefined;
  const outputText =
    typeof firstChoice?.message?.content === 'string'
      ? firstChoice.message.content
      : typeof firstChoice?.text === 'string'
        ? firstChoice.text
        : '';

  return {
    ok: true,
    runtime_type: runtimeType,
    model_name: request.model_name,
    output_text: outputText,
    untrusted_model_output: true,
    finish_reason:
      typeof firstChoice?.finish_reason === 'string'
        ? firstChoice.finish_reason
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
}

export class OpenAiCompatibleLocalAdapter implements RuntimeAdapter {
  readonly runtime_type = 'openai_compatible_local' as const;
  readonly support = {
    supports_discovery: true,
    supports_health_check: true,
    supports_chat_inference: true,
    supports_completion_inference: false,
    supports_load_unload: false,
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
      url: `${base}/v1/models`,
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
      url: `${base}/v1/models`,
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
        error: res.error ?? 'Failed to query /v1/models.',
      };
    }

    return {
      ok: true,
      supported: true,
      runtime_type: this.runtime_type,
      endpoint: base,
      models: parseOpenAiCompatibleModels(res.json, this.runtime_type),
    };
  }

  async loadModel(
    _endpoint: string,
    modelName: string,
  ): Promise<RuntimeLoadUnloadResult> {
    return {
      ok: false,
      supported: false,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'load',
      code: 'UNSUPPORTED_RUNTIME_OPERATION',
      message:
        'Generic OpenAI-compatible self-hosted servers do not standardize dynamic model loading over HTTP.',
    };
  }

  async unloadModel(
    _endpoint: string,
    modelName: string,
  ): Promise<RuntimeLoadUnloadResult> {
    return {
      ok: false,
      supported: false,
      runtime_type: this.runtime_type,
      model_name: modelName,
      action: 'unload',
      code: 'UNSUPPORTED_RUNTIME_OPERATION',
      message:
        'Generic OpenAI-compatible self-hosted servers do not standardize dynamic model unloading over HTTP.',
    };
  }

  async infer(
    endpoint: string,
    request: RuntimeInferenceRequest,
  ): Promise<RuntimeInferenceResponse> {
    return runOpenAiCompatibleChatInference(
      this.runtime_type,
      endpoint,
      request,
    );
  }
}
