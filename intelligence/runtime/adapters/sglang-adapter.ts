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
import {
  parseOpenAiCompatibleModels,
  runOpenAiCompatibleChatInference,
} from './openai-compatible-adapter.ts';

export class SglangRuntimeAdapter implements RuntimeAdapter {
  readonly runtime_type = 'sglang' as const;
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
    const v1Res = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/v1/models`,
      timeoutMs,
      signal,
    });

    if (v1Res.ok) {
      const models = parseOpenAiCompatibleModels(v1Res.json, this.runtime_type);
      if (models.length > 0) {
        return {
          ok: true,
          supported: true,
          runtime_type: this.runtime_type,
          endpoint: base,
          models,
        };
      }
    }

    const infoRes = await performSafeRuntimeHttpCall({
      method: 'GET',
      url: `${base}/get_model_info`,
      timeoutMs,
      signal,
    });

    if (!infoRes.ok) {
      return {
        ok: false,
        supported: true,
        runtime_type: this.runtime_type,
        endpoint: base,
        models: [],
        error:
          infoRes.error ??
          v1Res.error ??
          'Failed to discover models from SGLang runtime.',
      };
    }

    const info = infoRes.json as { model_path?: unknown } | null;
    const models: DiscoveredModelInfo[] =
      typeof info?.model_path === 'string' && info.model_path.length > 0
        ? [
            {
              model_name: info.model_path,
              runtime_type: this.runtime_type,
              details: info as Record<string, unknown>,
            },
          ]
        : [];

    return {
      ok: true,
      supported: true,
      runtime_type: this.runtime_type,
      endpoint: base,
      models,
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
        'SGLang HTTP server serves its launch model and does not support runtime HTTP model swapping.',
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
        'SGLang HTTP server does not support runtime HTTP model unloading.',
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
