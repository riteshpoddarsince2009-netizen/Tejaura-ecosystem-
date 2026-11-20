import {
  evaluatePolicy,
  evaluatePolicyWithAudit,
  type PolicyEvaluationResult,
} from '../../core/policy/index.ts';
import type { ModelEntry } from '../model-registry/validate-model-registry.ts';
import type {
  AdapterExecutionContext,
  GatewayInvokeInput,
  GatewayPolicyContext,
  ModelError,
  ModelErrorCode,
  ModelMetadata,
  ModelRequest,
  ModelResponse,
} from './model-types.ts';

export interface ModelAdapter {
  readonly adapterId: string;
  readonly declaredCapabilities: {
    text_generation: boolean;
    streaming: boolean;
  };
  supportsModel: (model: ModelEntry) => boolean;
  getModelMetadata: (model: ModelEntry) => ModelMetadata;
  generateText: (
    request: ModelRequest,
    context: AdapterExecutionContext,
  ) => Promise<ModelResponse>;
}

const SECRET_SNIPPET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /AIza[0-9A-Za-z_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{12,}/g,
];

export function redactPotentialSecrets(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_SNIPPET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED_SECRET]');
  }
  return sanitized;
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export function resolvePolicyActionForModel(
  model: ModelEntry,
): 'model:invoke_local' | 'model:invoke_remote' {
  if (
    (model.providerType === 'local-open-source' ||
      model.providerType === 'self-hosted') &&
    isLoopbackEndpoint(model.endpoint)
  ) {
    return 'model:invoke_local';
  }
  return 'model:invoke_remote';
}

export function normalizeModelError(
  code: ModelErrorCode,
  message: string,
  retryable: boolean,
  provider?: string,
  statusCode?: number,
): ModelError {
  return {
    code,
    message: redactPotentialSecrets(message),
    retryable,
    ...(provider ? { provider } : {}),
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
  };
}

export function validateModelRequestShape(
  request: ModelRequest,
): ModelError | null {
  if (!request || typeof request !== 'object') {
    return normalizeModelError(
      'INVALID_REQUEST',
      'Model request must be an object.',
      false,
    );
  }

  if (
    typeof request.request_id !== 'string' ||
    request.request_id.trim().length < 2
  ) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'Model request requires a valid request_id.',
      false,
    );
  }

  if (
    typeof request.correlation_id !== 'string' ||
    request.correlation_id.trim().length < 2
  ) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'Model request requires a valid correlation_id.',
      false,
    );
  }

  if (
    typeof request.model_id !== 'string' ||
    request.model_id.trim().length < 2
  ) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'Model request requires a valid model_id.',
      false,
    );
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'Model request requires at least one message.',
      false,
    );
  }

  for (const msg of request.messages) {
    if (
      !msg ||
      !['system', 'user', 'assistant'].includes(msg.role) ||
      typeof msg.content !== 'string' ||
      msg.content.trim().length === 0
    ) {
      return normalizeModelError(
        'INVALID_REQUEST',
        'Each message must have a valid role and non-empty string content.',
        false,
      );
    }
  }

  if (
    request.timeout_ms !== undefined &&
    (!Number.isFinite(request.timeout_ms) || request.timeout_ms <= 0)
  ) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'timeout_ms must be a positive finite number.',
      false,
    );
  }

  if (
    request.max_output_tokens !== undefined &&
    (!Number.isInteger(request.max_output_tokens) ||
      request.max_output_tokens <= 0)
  ) {
    return normalizeModelError(
      'INVALID_REQUEST',
      'max_output_tokens must be a positive integer.',
      false,
    );
  }

  return null;
}

export function checkModelPolicy(
  model: ModelEntry,
  policyContext: GatewayPolicyContext | null | undefined,
  auditLogger?: GatewayInvokeInput['audit_logger'],
  correlationId = 'corr_gateway',
): { allowed: boolean; policyResult: PolicyEvaluationResult | null; error?: ModelError } {
  if (!policyContext || typeof policyContext !== 'object') {
    return {
      allowed: false,
      policyResult: null,
      error: normalizeModelError(
        'POLICY_CONTEXT_MISSING',
        'Missing policy context: model invocation denied fail-closed.',
        false,
        model.adapter,
      ),
    };
  }

  const action = resolvePolicyActionForModel(model);
  const policyInput = {
    actor: policyContext.actor,
    action,
    resource: {
      id: `model:${model.id}`,
      type: 'model',
    },
    environment: policyContext.environment,
    declared_scopes: policyContext.declared_scopes,
    approval: policyContext.approval ?? null,
    approval_consumed: policyContext.approval_consumed,
    system_config: policyContext.system_config,
    now: policyContext.now,
  };

  const policyResult = auditLogger
    ? evaluatePolicyWithAudit({
        ...policyInput,
        audit_logger: auditLogger,
        correlation_id: correlationId,
      })
    : evaluatePolicy(policyInput);

  if (!policyResult.allowed) {
    const code: ModelErrorCode =
      policyResult.decision === 'require_approval'
        ? 'APPROVAL_REQUIRED'
        : 'POLICY_DENIED';
    return {
      allowed: false,
      policyResult,
      error: normalizeModelError(
        code,
        `${policyResult.reason_code}: ${policyResult.reason}`,
        false,
        model.adapter,
      ),
    };
  }

  return { allowed: true, policyResult };
}

/**
 * Policy-gated model gateway execution.
 * Enforces enabled-only models, request validation, Core Policy Evaluator
 * checks, capability checks, and fail-closed error normalization.
 */
export async function invokeModelThroughGateway(
  input: GatewayInvokeInput,
): Promise<ModelResponse> {
  const nowFn = input.now ?? (() => new Date());
  const startedMs = nowFn().getTime();
  const requestId = input.request?.request_id || 'req_unknown';
  const modelId = input.model?.id || input.request?.model_id || 'unknown_model';
  const adapterId = input.adapter?.adapterId || 'unknown_adapter';

  const elapsed = (): number => Math.max(0, nowFn().getTime() - startedMs);

  const requestError = validateModelRequestShape(input.request);
  if (requestError) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: requestError,
      latency_ms: elapsed(),
    };
  }

  if (!input.model || input.model.enabled !== true) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: normalizeModelError(
        'POLICY_DENIED',
        `Model "${modelId}" is disabled or missing and cannot be invoked.`,
        false,
        adapterId,
      ),
      latency_ms: elapsed(),
    };
  }

  if (input.request.stream === true) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: normalizeModelError(
        'STREAMING_NOT_IMPLEMENTED',
        'Streaming capability is declared in the contract, but streaming transport is not yet implemented in Stage 2.',
        false,
        adapterId,
      ),
      latency_ms: elapsed(),
    };
  }

  const requiredCaps = input.request.required_capabilities ?? ['text-generation'];
  const missingCaps = requiredCaps.filter(
    (cap) => !input.model.capabilities.includes(cap),
  );
  if (missingCaps.length > 0) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: normalizeModelError(
        'CAPABILITY_NOT_SUPPORTED',
        `Model "${modelId}" lacks required capabilities: ${missingCaps.join(', ')}.`,
        false,
        adapterId,
      ),
      latency_ms: elapsed(),
    };
  }

  const policyCheck = checkModelPolicy(
    input.model,
    input.policy_context,
    input.audit_logger,
    input.request.correlation_id,
  );
  if (!policyCheck.allowed) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error:
        policyCheck.error ??
        normalizeModelError('POLICY_DENIED', 'Model invocation denied.', false),
      latency_ms: elapsed(),
    };
  }

  if (!input.adapter || !input.adapter.supportsModel(input.model)) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: normalizeModelError(
        'CAPABILITY_NOT_SUPPORTED',
        `Adapter "${adapterId}" does not support model "${modelId}".`,
        false,
        adapterId,
      ),
      latency_ms: elapsed(),
    };
  }

  try {
    return await input.adapter.generateText(input.request, {
      model: input.model,
      secretResolver: input.secret_resolver,
      now: nowFn,
    });
  } catch (err) {
    return {
      ok: false,
      request_id: requestId,
      model_id: modelId,
      adapter: adapterId,
      error: normalizeModelError(
        'INTERNAL_ERROR',
        err instanceof Error
          ? `Adapter threw an unexpected error: ${err.message}`
          : 'Adapter threw an unexpected error.',
        false,
        adapterId,
      ),
      latency_ms: elapsed(),
    };
  }
}
