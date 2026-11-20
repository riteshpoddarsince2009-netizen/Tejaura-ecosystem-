import { evaluatePolicyWithAudit } from '../../core/policy/index.ts';
import type { ComputeNode, HardwareManager } from '../hardware/index.ts';
import type {
  LifecyclePolicyContext,
  ModelLifecycleManager,
} from '../lifecycle/index.ts';
import type {
  LocalModelEntry,
  LocalModelRegistry,
} from '../model-registry/local-model-registry.ts';
import type {
  RuntimeInferenceRequest,
  RuntimeManager,
} from '../runtime/index.ts';
import type {
  RejectedCandidate,
  RoutedInferenceResult,
  RoutingDecision,
  RoutingRequest,
} from './router-types.ts';

interface ScoredCandidate {
  model: LocalModelEntry;
  node: ComputeNode;
  score: number;
  hasImmediateCapacity: boolean;
}

export class ModelRouter {
  private readonly registry: LocalModelRegistry;
  private readonly hardware: HardwareManager;
  private readonly lifecycle: ModelLifecycleManager;
  private readonly runtime: RuntimeManager;

  constructor(deps: {
    registry: LocalModelRegistry;
    hardware: HardwareManager;
    lifecycle: ModelLifecycleManager;
    runtime: RuntimeManager;
  }) {
    this.registry = deps.registry;
    this.hardware = deps.hardware;
    this.lifecycle = deps.lifecycle;
    this.runtime = deps.runtime;
  }

  /**
   * Deterministically selects a self-hosted local model.
   * Never falls back to paid third-party AI APIs.
   */
  route(request: RoutingRequest): RoutingDecision {
    const models = this.registry.listModels();
    if (models.length === 0) {
      return {
        decision: 'unavailable',
        code: 'NO_MODELS_REGISTERED',
        reason:
          'No self-hosted local models are registered in LocalModelRegistry. Paid third-party API fallback is disabled.',
        paid_api_fallback_used: false,
        selected_model: null,
        selected_node: null,
        rejected_candidates: [],
      };
    }

    const rejected: RejectedCandidate[] = [];
    const eligible: ScoredCandidate[] = [];

    for (const model of models) {
      if (!model.enabled) {
        rejected.push({
          model_id: model.model_id,
          code: 'MODEL_DISABLED',
          reason: 'Model is disabled.',
        });
        continue;
      }

      if (!model.controlled_runtime_endpoint) {
        rejected.push({
          model_id: model.model_id,
          code: 'NO_RUNTIME_ENDPOINT',
          reason: 'Model has no controlled_runtime_endpoint configured.',
        });
        continue;
      }

      const breaker = this.lifecycle.getBreakerState(model.model_id);
      if (breaker.circuit_open) {
        rejected.push({
          model_id: model.model_id,
          code: 'CIRCUIT_OPEN',
          reason: `Circuit breaker is open (${breaker.last_error ?? 'runtime failure'}).`,
        });
        continue;
      }

      if (model.availability !== 'available') {
        rejected.push({
          model_id: model.model_id,
          code: 'MODEL_UNAVAILABLE',
          reason: `Model availability is "${model.availability}".`,
        });
        continue;
      }

      const missingCaps = request.required_capabilities.filter(
        (cap) => !model.capabilities.includes(cap),
      );
      if (missingCaps.length > 0) {
        rejected.push({
          model_id: model.model_id,
          code: 'CAPABILITY_MISMATCH',
          reason: `Missing required capabilities: ${missingCaps.join(', ')}.`,
        });
        continue;
      }

      if (model.context_length < request.min_context_length) {
        rejected.push({
          model_id: model.model_id,
          code: 'CONTEXT_LENGTH_INSUFFICIENT',
          reason: `Model context_length (${model.context_length}) is below required ${request.min_context_length}.`,
        });
        continue;
      }

      if (
        request.max_ram_mb !== undefined &&
        model.hardware_requirements.min_ram_mb > request.max_ram_mb
      ) {
        rejected.push({
          model_id: model.model_id,
          code: 'MEMORY_BUDGET_EXCEEDED',
          reason: `Model requires ${model.hardware_requirements.min_ram_mb} MB RAM (budget max ${request.max_ram_mb} MB).`,
        });
        continue;
      }

      if (
        request.max_vram_mb !== undefined &&
        model.hardware_requirements.min_vram_mb > request.max_vram_mb
      ) {
        rejected.push({
          model_id: model.model_id,
          code: 'VRAM_BUDGET_EXCEEDED',
          reason: `Model requires ${model.hardware_requirements.min_vram_mb} MB VRAM (budget max ${request.max_vram_mb} MB).`,
        });
        continue;
      }

      const hwCheck = this.hardware.findBestCompatibleNode(model);
      if (!hwCheck.fit.fits || !hwCheck.node) {
        rejected.push({
          model_id: model.model_id,
          code: hwCheck.fit.code,
          reason: hwCheck.fit.reason,
        });
        continue;
      }

      const hasImmediateCapacity = this.lifecycle.hasCapacity(model.model_id);

      let score = 0;
      if (request.preferred_model_id === model.model_id) {
        score += 10_000;
      }
      if (request.preferred_runtime_type === model.runtime_type) {
        score += 2_000;
      }
      if (hasImmediateCapacity) {
        score += 5_000;
      }
      if (hwCheck.node.location === 'local') {
        score += 1_000;
      }
      if (request.priority === 'low') {
        score -= model.hardware_requirements.min_vram_mb * 0.05;
      } else {
        score += Math.min(model.context_length, 131_072) * 0.005;
      }

      eligible.push({
        model,
        node: hwCheck.node,
        score,
        hasImmediateCapacity,
      });
    }

    if (eligible.length === 0) {
      return {
        decision: 'unavailable',
        code: 'NO_ELIGIBLE_LOCAL_MODEL',
        reason:
          'No registered local model satisfied capability, context, availability, and hardware requirements. Paid API fallback is prohibited.',
        paid_api_fallback_used: false,
        selected_model: null,
        selected_node: null,
        rejected_candidates: rejected,
      };
    }

    eligible.sort((a, b) => b.score - a.score);
    const best = eligible[0];

    if (!best.hasImmediateCapacity) {
      if (request.allow_queue !== false) {
        return {
          decision: 'queued',
          code: 'ELIGIBLE_MODEL_QUEUED',
          reason: `Eligible local model "${best.model.model_id}" on node "${best.node.node_id}" is at concurrency capacity; task should queue.`,
          paid_api_fallback_used: false,
          selected_model: best.model,
          selected_node: best.node,
          rejected_candidates: rejected,
        };
      }
      return {
        decision: 'unavailable',
        code: 'CONCURRENCY_CAPACITY_EXHAUSTED',
        reason: `Eligible local model "${best.model.model_id}" is at concurrency capacity and allow_queue is false.`,
        paid_api_fallback_used: false,
        selected_model: null,
        selected_node: null,
        rejected_candidates: rejected,
      };
    }

    return {
      decision: 'routed',
      code: 'MODEL_ROUTED',
      reason: `Routed task "${request.task_id}" to local model "${best.model.model_id}" (${best.model.runtime_type}) on node "${best.node.node_id}".`,
      paid_api_fallback_used: false,
      selected_model: best.model,
      selected_node: best.node,
      rejected_candidates: rejected,
    };
  }

  async routeAndInfer(
    request: RoutingRequest,
    inference: Omit<RuntimeInferenceRequest, 'model_name'>,
    governance: LifecyclePolicyContext,
  ): Promise<RoutedInferenceResult> {
    const policy = evaluatePolicyWithAudit({
      actor: governance.actor,
      action: 'model:invoke_local',
      resource: { id: `task:${request.task_id}`, type: 'model' },
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
        routing: {
          decision: 'unavailable',
          code: policy.reason_code,
          reason: policy.reason,
          paid_api_fallback_used: false,
          selected_model: null,
          selected_node: null,
          rejected_candidates: [],
        },
        error_code: policy.reason_code,
        error: policy.reason,
      };
    }

    const decision = this.route(request);
    if (decision.decision === 'unavailable' || !decision.selected_model) {
      return {
        ok: false,
        routing: decision,
        error_code: decision.code,
        error: decision.reason,
      };
    }

    const model = decision.selected_model;
    const slot = await this.lifecycle.acquireExecutionSlot(model.model_id, {
      priority: request.priority,
      allowQueue: request.allow_queue,
      queueTimeoutMs: inference.timeout_ms,
      signal: inference.signal,
    });

    if (!slot.acquired || !slot.release) {
      return {
        ok: false,
        routing: decision,
        error_code: slot.code,
        error: slot.reason,
      };
    }

    try {
      const response = await this.runtime.infer(
        model.runtime_type,
        model.controlled_runtime_endpoint!,
        {
          ...inference,
          model_name: model.model_name,
        },
      );

      if (response.ok) {
        this.lifecycle.recordSuccess(model.model_id);
      } else if (!response.cancelled) {
        this.lifecycle.recordFailure(
          model.model_id,
          response.error ?? response.error_code ?? 'Inference failure',
        );
      }

      return {
        ok: response.ok,
        routing: decision,
        response,
        error_code: response.error_code,
        error: response.error,
      };
    } finally {
      slot.release();
    }
  }
}
