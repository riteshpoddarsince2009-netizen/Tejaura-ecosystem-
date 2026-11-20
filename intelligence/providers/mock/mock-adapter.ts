import {
  normalizeModelError,
  type ModelAdapter,
} from '../../gateway/model-adapter.ts';
import type {
  AdapterExecutionContext,
  ModelMetadata,
  ModelRequest,
  ModelResponse,
} from '../../gateway/model-types.ts';
import type { ModelEntry } from '../../model-registry/validate-model-registry.ts';

export type MockResponder = (
  request: ModelRequest,
  context: AdapterExecutionContext,
) => Promise<ModelResponse> | ModelResponse;

export interface MockModelAdapterOptions {
  adapterId?: string;
  responder?: MockResponder;
}

/**
 * Deterministic, network-free mock model adapter for unit and router tests.
 */
export class MockModelAdapter implements ModelAdapter {
  readonly adapterId: string;
  readonly declaredCapabilities = {
    text_generation: true,
    streaming: false,
  };
  private readonly responder?: MockResponder;

  constructor(options: MockModelAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? 'mock';
    this.responder = options.responder;
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

    if (request.signal?.aborted) {
      return {
        ok: false,
        request_id: request.request_id,
        model_id: context.model.id,
        adapter: this.adapterId,
        error: normalizeModelError(
          'CANCELLED',
          'Mock model request was cancelled before execution.',
          false,
          this.adapterId,
        ),
        latency_ms: elapsed(),
      };
    }

    if (this.responder) {
      return await this.responder(request, context);
    }

    const lastUserMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const promptSummary = lastUserMessage?.content ?? request.messages[0]!.content;
    const outputText = `[mock:${context.model.id}] ${promptSummary}`;
    const inputTokens = request.messages.reduce(
      (sum, msg) => sum + Math.max(1, Math.ceil(msg.content.length / 4)),
      0,
    );
    const outputTokens = Math.max(1, Math.ceil(outputText.length / 4));

    return {
      ok: true,
      request_id: request.request_id,
      model_id: context.model.id,
      adapter: this.adapterId,
      output_text: outputText,
      finish_reason: 'stop',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      latency_ms: elapsed(),
    };
  }
}
