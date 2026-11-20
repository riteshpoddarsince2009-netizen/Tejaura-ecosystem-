import type {
  RuntimeAdapter,
  RuntimeDiscoveryResult,
  RuntimeHealthResult,
  RuntimeInferenceRequest,
  RuntimeInferenceResponse,
  RuntimeLoadUnloadResult,
} from '../runtime-types.ts';
import { normalizeBaseUrl, performSafeRuntimeHttpCall } from './http-helper.ts';
import {
  parseOpenAiCompatibleModels,
  runOpenAiCompatibleChatInference,
} from './openai-compatible-adapter.ts';

export class VllmRuntimeAdapter implements RuntimeAdapter {
  readonly runtime_type = 'vllm' as const;
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
      url: `${base}/health`,
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
        error: res.error ?? 'Failed to query vLLM /v1/models.',
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
        'vLLM OpenAI server serves its configured engine model and does not support arbitrary base-model loading via HTTP.',
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
        'vLLM OpenAI server does not support unloading the active engine model via HTTP.',
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
