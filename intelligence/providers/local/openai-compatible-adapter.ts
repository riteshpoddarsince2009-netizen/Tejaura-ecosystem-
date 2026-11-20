import {
  normalizeModelError,
  redactPotentialSecrets,
  type ModelAdapter,
} from '../../gateway/model-adapter.ts';
import type {
  AdapterExecutionContext,
  ModelMetadata,
  ModelRequest,
  ModelResponse,
} from '../../gateway/model-types.ts';
import type { ModelEntry } from '../../model-registry/validate-model-registry.ts';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleAdapterOptions {
  adapterId?: string;
  allowedEndpoints: readonly string[];
  defaultTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

function normalizeEndpointUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
}

function isAllowlistedEndpoint(
  endpoint: string,
  allowedEndpoints: readonly string[],
): boolean {
  const target = normalizeEndpointUrl(endpoint);
  if (!target) {
    return false;
  }
  const targetPath = stripTrailingSlash(target.pathname);

  return allowedEndpoints.some((allowedRaw) => {
    const allowed = normalizeEndpointUrl(allowedRaw);
    if (!allowed) {
      return false;
    }
    return (
      allowed.origin === target.origin &&
      stripTrailingSlash(allowed.pathname) === targetPath
    );
  });
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Server-side adapter for local OpenAI-compatible inference servers
 * (e.g., Ollama, llama.cpp server, vLLM).
 *
 * SECURITY:
 * - Refuses execution inside browser runtimes.
 * - Requires explicit endpoint allowlist matching origin and base path.
 * - Resolves credentials strictly via injected server-side SecretResolver.
 * - Never logs or returns raw credentials in normalized errors.
 */
export class OpenAICompatibleLocalAdapter implements ModelAdapter {
  readonly adapterId: string;
  readonly declaredCapabilities = {
    text_generation: true,
    streaming: false,
  };
  private readonly allowedEndpoints: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl?: FetchLike;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.adapterId = options.adapterId ?? 'openai-compatible';
    this.allowedEndpoints = [...options.allowedEndpoints];
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl;
  }

  supportsModel(model: ModelEntry): boolean {
    return model.enabled === true && model.adapter === this.adapterId;
  }

  getModelMetadata(model: ModelEntry): ModelMetadata {
    return {
      id: model.id,
      display_name: model.displayName,
      provider_type: model.providerType,
      adapter: this.adapterId,
      cost_tier: model.costTier,
      capabilities: {
        text_generation: model.capabilities.includes('text-generation'),
        streaming: model.capabilities.includes('streaming'),
        reasoning: model.capabilities.includes('reasoning'),
        max_context_tokens: model.contextWindow,
      },
      max_autonomy_allowed: model.maxAutonomyAllowed,
    };
  }

  async generateText(
    request: ModelRequest,
    context: AdapterExecutionContext,
  ): Promise<ModelResponse> {
    const nowFn = context.now ?? (() => new Date());
    const startMs = nowFn().getTime();
    const elapsed = (): number => Math.max(0, nowFn().getTime() - startMs);

    if (isBrowserRuntime()) {
      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'BROWSER_EXECUTION_FORBIDDEN',
          'OpenAICompatibleLocalAdapter is server-side only and cannot execute in browser code.',
          false,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    }

    if (request.signal?.aborted) {
      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'CANCELLED',
          'Model request was cancelled before execution.',
          false,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    }

    if (!isAllowlistedEndpoint(context.model.endpoint, this.allowedEndpoints)) {
      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'ENDPOINT_NOT_ALLOWLISTED',
          `Model endpoint "${context.model.endpoint}" is not in the adapter allowlist.`,
          false,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    }

    let apiKey: string | null = null;
    if (context.model.apiKeyEnvVar !== null) {
      if (!context.secretResolver) {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'CREDENTIAL_UNAVAILABLE',
            `Credential resolver is required for env var "${context.model.apiKeyEnvVar}".`,
            false,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }

      const resolved = await context.secretResolver.resolveSecret(
        context.model.apiKeyEnvVar,
      );
      if (typeof resolved !== 'string' || resolved.trim().length === 0) {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'CREDENTIAL_UNAVAILABLE',
            `Credential "${context.model.apiKeyEnvVar}" is not configured.`,
            false,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }
      apiKey = resolved;
    }

    const fetchFn: FetchLike | undefined =
      this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchFn) {
      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'PROVIDER_UNAVAILABLE',
          'No fetch implementation is available in this runtime.',
          false,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    }

    const baseUrl = normalizeEndpointUrl(context.model.endpoint)!;
    const basePath = stripTrailingSlash(baseUrl.pathname);
    const targetUrl = `${baseUrl.origin}${basePath}/chat/completions`;

    const timeoutMs = request.timeout_ms ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (request.signal) {
      request.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey !== null) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const payload: Record<string, unknown> = {
        model: context.model.id,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      };
      if (request.max_output_tokens !== undefined) {
        payload.max_tokens = request.max_output_tokens;
      }
      if (request.temperature !== undefined) {
        payload.temperature = request.temperature;
      }

      const response = await fetchFn(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorSnippet = '';
        try {
          errorSnippet = redactPotentialSecrets(await response.text()).slice(
            0,
            240,
          );
        } catch {
          errorSnippet = '';
        }

        const retryable = response.status === 429 || response.status >= 500;
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'PROVIDER_HTTP_ERROR',
            `Provider returned HTTP ${response.status}${errorSnippet ? `: ${errorSnippet}` : ''}`,
            retryable,
            this.adapterId,
            response.status,
          ),
          latency_ms: elapsed(),
        };
      }

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'MALFORMED_PROVIDER_RESPONSE',
            'Provider returned invalid JSON response.',
            false,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }

      const bodyObj = parsedBody as {
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        };
      };

      const content = bodyObj?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'MALFORMED_PROVIDER_RESPONSE',
            'Provider response is missing string choices[0].message.content.',
            false,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }

      const rawFinish = bodyObj?.choices?.[0]?.finish_reason;
      const finishReason: 'stop' | 'length' =
        rawFinish === 'length' ? 'length' : 'stop';

      const inputTokens =
        typeof bodyObj?.usage?.prompt_tokens === 'number'
          ? bodyObj.usage.prompt_tokens
          : 0;
      const outputTokens =
        typeof bodyObj?.usage?.completion_tokens === 'number'
          ? bodyObj.usage.completion_tokens
          : 0;
      const totalTokens =
        typeof bodyObj?.usage?.total_tokens === 'number'
          ? bodyObj.usage.total_tokens
          : inputTokens + outputTokens;

      return {
        ok: true,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        output_text: content,
        finish_reason: finishReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        },
        latency_ms: elapsed(),
      };
    } catch (err) {
      if (timedOut) {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'TIMEOUT',
            `Model request timed out after ${timeoutMs}ms.`,
            true,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }

      if (
        request.signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        return {
          ok: false,
          request_id: request.request_id,
          model_id: context.model.id,
          adapter: this.adapterId,
          error: normalizeModelError(
            'CANCELLED',
            'Model request was cancelled.',
            false,
            this.adapterId,
          ),
          latency_ms: elapsed(),
        };
      }

      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'PROVIDER_UNAVAILABLE',
          err instanceof Error
            ? `Provider request failed: ${err.message}`
            : 'Provider request failed.',
          true,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (request.signal) {
        request.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
}
