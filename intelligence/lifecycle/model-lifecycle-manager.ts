import { evaluatePolicyWithAudit } from '../../core/policy/index.ts';
import type { HardwareManager } from '../hardware/index.ts';
import type {
  LocalModelEntry,
  LocalModelRegistry,
} from '../model-registry/local-model-registry.ts';
import type { RuntimeManager } from '../runtime/index.ts';
import type {
  AvailabilityCheckResult,
  CircuitBreakerState,
  LifecycleManagerOptions,
  LifecycleOperationResult,
  LifecyclePolicyContext,
  LifecycleStats,
  SlotAcquisitionResult,
  TaskPriority,
} from './lifecycle-types.ts';

interface QueuedWaiter {
  id: number;
  model_id: string;
  priority: TaskPriority;
  enqueued_at: number;
  resolve: (result: SlotAcquisitionResult) => void;
  cleanup: () => void;
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

export class ModelLifecycleManager {
  private readonly registry: LocalModelRegistry;
  private readonly hardware: HardwareManager;
  private readonly runtime: RuntimeManager;
  private readonly maxConcurrentGlobal: number;
  private readonly maxConcurrentPerModel: number;
  private readonly maxQueueSize: number;
  private readonly failureThreshold: number;
  private readonly defaultQueueTimeoutMs: number;

  private activeGlobal = 0;
  private readonly activeByModel = new Map<string, number>();
  private readonly queue: QueuedWaiter[] = [];
  private readonly breakers = new Map<string, CircuitBreakerState>();
  private nextWaiterId = 1;

  constructor(deps: {
    registry: LocalModelRegistry;
    hardware: HardwareManager;
    runtime: RuntimeManager;
    options?: LifecycleManagerOptions;
  }) {
    this.registry = deps.registry;
    this.hardware = deps.hardware;
    this.runtime = deps.runtime;
    this.maxConcurrentGlobal = deps.options?.maxConcurrentGlobal ?? 4;
    this.maxConcurrentPerModel = deps.options?.maxConcurrentPerModel ?? 2;
    this.maxQueueSize = deps.options?.maxQueueSize ?? 20;
    this.failureThreshold = deps.options?.failureThreshold ?? 3;
    this.defaultQueueTimeoutMs = deps.options?.defaultQueueTimeoutMs ?? 10_000;
  }

  getBreakerState(modelId: string): CircuitBreakerState {
    return (
      this.breakers.get(modelId) ?? {
        model_id: modelId,
        consecutive_failures: 0,
        circuit_open: false,
      }
    );
  }

  getStats(): LifecycleStats {
    const activeByModel: Record<string, number> = {};
    for (const [id, count] of this.activeByModel.entries()) {
      if (count > 0) {
        activeByModel[id] = count;
      }
    }
    const openCircuits = [...this.breakers.values()]
      .filter((b) => b.circuit_open)
      .map((b) => b.model_id);

    return {
      active_global: this.activeGlobal,
      max_concurrent_global: this.maxConcurrentGlobal,
      max_concurrent_per_model: this.maxConcurrentPerModel,
      queued_count: this.queue.length,
      max_queue_size: this.maxQueueSize,
      active_by_model: activeByModel,
      open_circuits: openCircuits,
    };
  }

  hasCapacity(modelId: string): boolean {
    const modelActive = this.activeByModel.get(modelId) ?? 0;
    return (
      this.activeGlobal < this.maxConcurrentGlobal &&
      modelActive < this.maxConcurrentPerModel
    );
  }

  async checkAvailability(
    modelId: string,
    options?: { probeRuntime?: boolean; timeoutMs?: number },
  ): Promise<AvailabilityCheckResult> {
    const model = this.registry.getModel(modelId);
    if (!model) {
      return {
        available: false,
        model_id: modelId,
        status: 'unavailable',
        code: 'MODEL_NOT_FOUND',
        reason: `Model "${modelId}" is not registered in LocalModelRegistry.`,
      };
    }

    if (!model.enabled) {
      return {
        available: false,
        model_id: modelId,
        status: 'unavailable',
        code: 'MODEL_DISABLED',
        reason: `Model "${modelId}" is disabled by the owner.`,
      };
    }

    const breaker = this.getBreakerState(modelId);
    if (breaker.circuit_open) {
      return {
        available: false,
        model_id: modelId,
        status: 'error',
        code: 'CIRCUIT_OPEN',
        reason: `Circuit breaker is open for "${modelId}" after ${breaker.consecutive_failures} consecutive failures (${breaker.last_error ?? 'runtime failure'}).`,
        circuit_open: true,
      };
    }

    const hwCheck = this.hardware.findBestCompatibleNode(model);
    if (!hwCheck.fit.fits) {
      return {
        available: false,
        model_id: modelId,
        status: 'unavailable',
        code: hwCheck.fit.code,
        reason: hwCheck.fit.reason,
        hardware_fit: hwCheck.fit,
      };
    }

    if (
      model.availability !== 'available' &&
      options?.probeRuntime !== true
    ) {
      return {
        available: false,
        model_id: modelId,
        status: model.availability,
        code: 'MODEL_NOT_AVAILABLE',
        reason: `Model "${modelId}" status is "${model.availability}".`,
        hardware_fit: hwCheck.fit,
      };
    }

    if (options?.probeRuntime && model.controlled_runtime_endpoint) {
      const health = await this.runtime.healthCheck(
        model.runtime_type,
        model.controlled_runtime_endpoint,
        options.timeoutMs,
      );
      if (!health.healthy) {
        this.registry.updateAvailability(modelId, 'offline');
        return {
          available: false,
          model_id: modelId,
          status: 'offline',
          code: 'RUNTIME_UNHEALTHY',
          reason: health.error ?? `Runtime for "${modelId}" is unhealthy.`,
          hardware_fit: hwCheck.fit,
          runtime_healthy: false,
        };
      }

      const discovery = await this.runtime.discoverModels(
        model.runtime_type,
        model.controlled_runtime_endpoint,
        { timeoutMs: options.timeoutMs },
      );
      const discovered = discovery.ok
        ? discovery.models.some(
            (m) =>
              m.model_name === model.model_name || m.model_name === model.model_id,
          )
        : undefined;

      if (discovery.ok && discovered === false) {
        this.registry.updateAvailability(modelId, 'unavailable');
        return {
          available: false,
          model_id: modelId,
          status: 'unavailable',
          code: 'MODEL_NOT_ON_RUNTIME',
          reason: `Runtime "${model.runtime_type}" is healthy, but model "${model.model_name}" was not reported in discovery.`,
          hardware_fit: hwCheck.fit,
          runtime_healthy: true,
          discovered_on_runtime: false,
        };
      }

      this.registry.updateAvailability(modelId, 'available');
      return {
        available: true,
        model_id: modelId,
        status: 'available',
        code: 'MODEL_AVAILABLE',
        reason: `Model "${modelId}" passed hardware and runtime availability checks.`,
        hardware_fit: hwCheck.fit,
        runtime_healthy: true,
        discovered_on_runtime: discovered,
      };
    }

    return {
      available: true,
      model_id: modelId,
      status: 'available',
      code: 'MODEL_AVAILABLE',
      reason: `Model "${modelId}" is enabled, healthy, and fits hardware.`,
      hardware_fit: hwCheck.fit,
    };
  }

  async requestLoad(
    modelId: string,
    governance: LifecyclePolicyContext,
    timeoutMs?: number,
  ): Promise<LifecycleOperationResult> {
    const policy = evaluatePolicyWithAudit({
      actor: governance.actor,
      action: 'model:load',
      resource: { id: `model:${modelId}`, type: 'model' },
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
        model_id: modelId,
        code: policy.reason_code,
        message: policy.reason,
        policy,
      };
    }

    const model = this.registry.getModel(modelId);
    if (!model || !model.enabled) {
      return {
        ok: false,
        model_id: modelId,
        code: !model ? 'MODEL_NOT_FOUND' : 'MODEL_DISABLED',
        message: !model
          ? `Model "${modelId}" is not registered.`
          : `Model "${modelId}" is disabled.`,
        policy,
      };
    }

    const hwCheck = this.hardware.findBestCompatibleNode(model);
    if (!hwCheck.fit.fits) {
      return {
        ok: false,
        model_id: modelId,
        code: hwCheck.fit.code,
        message: hwCheck.fit.reason,
        policy,
        hardware_fit: hwCheck.fit,
      };
    }

    if (!model.controlled_runtime_endpoint) {
      return {
        ok: false,
        supported: false,
        model_id: modelId,
        code: 'NO_RUNTIME_ENDPOINT_CONFIGURED',
        message: `Model "${modelId}" has no controlled_runtime_endpoint configured for remote/local HTTP load.`,
        policy,
        hardware_fit: hwCheck.fit,
      };
    }

    this.registry.updateAvailability(modelId, 'loading');
    const result = await this.runtime.loadModel(
      model.runtime_type,
      model.controlled_runtime_endpoint,
      model.model_name,
      { timeoutMs },
    );

    if (!result.supported) {
      this.registry.updateAvailability(modelId, model.availability);
      return {
        ok: false,
        supported: false,
        model_id: modelId,
        code: result.code ?? 'UNSUPPORTED_RUNTIME_OPERATION',
        message: result.message,
        policy,
        hardware_fit: hwCheck.fit,
      };
    }

    this.registry.updateAvailability(
      modelId,
      result.ok ? 'available' : 'error',
    );
    return {
      ok: result.ok,
      supported: true,
      model_id: modelId,
      code: result.code ?? (result.ok ? 'MODEL_LOADED' : 'LOAD_FAILED'),
      message: result.message,
      policy,
      hardware_fit: hwCheck.fit,
    };
  }

  async requestUnload(
    modelId: string,
    governance: LifecyclePolicyContext,
    timeoutMs?: number,
  ): Promise<LifecycleOperationResult> {
    const policy = evaluatePolicyWithAudit({
      actor: governance.actor,
      action: 'model:unload',
      resource: { id: `model:${modelId}`, type: 'model' },
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
        model_id: modelId,
        code: policy.reason_code,
        message: policy.reason,
        policy,
      };
    }

    const model = this.registry.getModel(modelId);
    if (!model) {
      return {
        ok: false,
        model_id: modelId,
        code: 'MODEL_NOT_FOUND',
        message: `Model "${modelId}" is not registered.`,
        policy,
      };
    }

    if (!model.controlled_runtime_endpoint) {
      return {
        ok: false,
        supported: false,
        model_id: modelId,
        code: 'NO_RUNTIME_ENDPOINT_CONFIGURED',
        message: `Model "${modelId}" has no controlled_runtime_endpoint configured.`,
        policy,
      };
    }

    const result = await this.runtime.unloadModel(
      model.runtime_type,
      model.controlled_runtime_endpoint,
      model.model_name,
      { timeoutMs },
    );

    if (!result.supported) {
      return {
        ok: false,
        supported: false,
        model_id: modelId,
        code: result.code ?? 'UNSUPPORTED_RUNTIME_OPERATION',
        message: result.message,
        policy,
      };
    }

    if (result.ok) {
      this.registry.updateAvailability(modelId, 'unavailable');
    }
    return {
      ok: result.ok,
      supported: true,
      model_id: modelId,
      code: result.code ?? (result.ok ? 'MODEL_UNLOADED' : 'UNLOAD_FAILED'),
      message: result.message,
      policy,
    };
  }

  /**
   * Authorizes a manual or owner-approved model download gate.
   * Never automatically triggers large file downloads.
   */
  authorizeModelDownload(
    model: LocalModelEntry,
    governance: LifecyclePolicyContext,
  ): LifecycleOperationResult {
    const policy = evaluatePolicyWithAudit({
      actor: governance.actor,
      action: 'model:download',
      resource: { id: `model:${model.model_id}`, type: 'model' },
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
        model_id: model.model_id,
        code: policy.reason_code,
        message: policy.reason,
        policy,
      };
    }

    const hwCheck = this.hardware.findBestCompatibleNode(model);
    if (!hwCheck.fit.fits) {
      return {
        ok: false,
        model_id: model.model_id,
        code: hwCheck.fit.code,
        message: hwCheck.fit.reason,
        policy,
        hardware_fit: hwCheck.fit,
      };
    }

    return {
      ok: true,
      model_id: model.model_id,
      code: 'DOWNLOAD_AUTHORIZED_MANUAL_EXECUTION_REQUIRED',
      message: `Owner-approved download gate passed for "${model.model_id}"; automatic background download is disabled by policy.`,
      policy,
      hardware_fit: hwCheck.fit,
    };
  }

  private allocateSlot(modelId: string): () => void {
    this.activeGlobal += 1;
    this.activeByModel.set(modelId, (this.activeByModel.get(modelId) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const current = this.activeByModel.get(modelId) ?? 0;
      if (current <= 1) {
        this.activeByModel.delete(modelId);
      } else {
        this.activeByModel.set(modelId, current - 1);
      }
      this.pumpQueue();
    };
  }

  private pumpQueue(): void {
    if (this.queue.length === 0) {
      return;
    }

    this.queue.sort((a, b) => {
      const weightDiff =
        PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      if (weightDiff !== 0) {
        return weightDiff;
      }
      return a.enqueued_at - b.enqueued_at;
    });

    for (let i = 0; i < this.queue.length; i += 1) {
      if (this.activeGlobal >= this.maxConcurrentGlobal) {
        break;
      }
      const waiter = this.queue[i];
      if (this.hasCapacity(waiter.model_id)) {
        this.queue.splice(i, 1);
        waiter.cleanup();
        const release = this.allocateSlot(waiter.model_id);
        waiter.resolve({
          acquired: true,
          queued: true,
          code: 'SLOT_ACQUIRED_FROM_QUEUE',
          reason: `Execution slot granted from queue for "${waiter.model_id}".`,
          release,
        });
        i -= 1;
      }
    }
  }

  async acquireExecutionSlot(
    modelId: string,
    options?: {
      priority?: TaskPriority;
      allowQueue?: boolean;
      queueTimeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<SlotAcquisitionResult> {
    if (options?.signal?.aborted) {
      return {
        acquired: false,
        queued: false,
        code: 'QUEUE_CANCELLED',
        reason: 'Execution slot request aborted before queuing.',
      };
    }

    if (this.hasCapacity(modelId)) {
      const release = this.allocateSlot(modelId);
      return {
        acquired: true,
        queued: false,
        code: 'SLOT_ACQUIRED',
        reason: `Immediate execution slot acquired for "${modelId}".`,
        release,
      };
    }

    if (options?.allowQueue === false) {
      return {
        acquired: false,
        queued: false,
        code: 'CONCURRENCY_LIMIT_REACHED',
        reason: `Model "${modelId}" or global runtime is at concurrency capacity and queueing is disabled.`,
      };
    }

    if (this.queue.length >= this.maxQueueSize) {
      return {
        acquired: false,
        queued: false,
        code: 'QUEUE_FULL',
        reason: `Lifecycle queue is full (${this.queue.length}/${this.maxQueueSize}).`,
      };
    }

    const priority = options?.priority ?? 'normal';
    const queueTimeoutMs =
      options?.queueTimeoutMs ?? this.defaultQueueTimeoutMs;

    return new Promise<SlotAcquisitionResult>((resolve) => {
      const id = this.nextWaiterId++;
      let settled = false;

      const removeFromQueue = () => {
        const idx = this.queue.findIndex((w) => w.id === id);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        removeFromQueue();
        cleanup();
        resolve({
          acquired: false,
          queued: true,
          code: 'QUEUE_CANCELLED',
          reason: `Queued request for "${modelId}" was cancelled.`,
        });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeFromQueue();
        cleanup();
        resolve({
          acquired: false,
          queued: true,
          code: 'QUEUE_TIMEOUT',
          reason: `Timed out waiting in queue for "${modelId}" after ${queueTimeoutMs}ms.`,
        });
      }, queueTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push({
        id,
        model_id: modelId,
        priority,
        enqueued_at: Date.now(),
        resolve: (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        },
        cleanup,
      });
    });
  }

  recordSuccess(modelId: string): void {
    this.breakers.set(modelId, {
      model_id: modelId,
      consecutive_failures: 0,
      circuit_open: false,
    });
    if (this.registry.getModel(modelId)) {
      this.registry.updateAvailability(modelId, 'available');
    }
  }

  recordFailure(modelId: string, errorMessage: string): CircuitBreakerState {
    const prev = this.getBreakerState(modelId);
    const consecutiveFailures = prev.consecutive_failures + 1;
    const circuitOpen = consecutiveFailures >= this.failureThreshold;
    const next: CircuitBreakerState = {
      model_id: modelId,
      consecutive_failures: consecutiveFailures,
      circuit_open: circuitOpen,
      last_error: errorMessage,
      opened_at: circuitOpen
        ? prev.opened_at ?? new Date().toISOString()
        : undefined,
    };
    this.breakers.set(modelId, next);

    if (circuitOpen && this.registry.getModel(modelId)) {
      this.registry.updateAvailability(modelId, 'error');
    }
    return { ...next };
  }

  async recoverModel(
    modelId: string,
    timeoutMs?: number,
  ): Promise<AvailabilityCheckResult> {
    const model = this.registry.getModel(modelId);
    if (!model) {
      return {
        available: false,
        model_id: modelId,
        status: 'unavailable',
        code: 'MODEL_NOT_FOUND',
        reason: `Cannot recover unknown model "${modelId}".`,
      };
    }

    const hwCheck = this.hardware.findBestCompatibleNode(model);
    if (!hwCheck.fit.fits) {
      return {
        available: false,
        model_id: modelId,
        status: 'error',
        code: hwCheck.fit.code,
        reason: hwCheck.fit.reason,
        hardware_fit: hwCheck.fit,
        circuit_open: true,
      };
    }

    if (!model.controlled_runtime_endpoint) {
      return {
        available: false,
        model_id: modelId,
        status: 'error',
        code: 'NO_RUNTIME_ENDPOINT_CONFIGURED',
        reason: `Model "${modelId}" has no controlled_runtime_endpoint to probe for recovery.`,
        hardware_fit: hwCheck.fit,
        circuit_open: true,
      };
    }

    const health = await this.runtime.healthCheck(
      model.runtime_type,
      model.controlled_runtime_endpoint,
      timeoutMs,
    );

    if (!health.healthy) {
      return {
        available: false,
        model_id: modelId,
        status: 'offline',
        code: 'RECOVERY_HEALTH_CHECK_FAILED',
        reason:
          health.error ?? `Runtime health probe failed for "${modelId}".`,
        hardware_fit: hwCheck.fit,
        runtime_healthy: false,
        circuit_open: true,
      };
    }

    this.recordSuccess(modelId);
    return {
      available: true,
      model_id: modelId,
      status: 'available',
      code: 'RUNTIME_RECOVERED',
      reason: `Model "${modelId}" recovered after successful runtime health check.`,
      hardware_fit: hwCheck.fit,
      runtime_healthy: true,
      circuit_open: false,
    };
  }
}
