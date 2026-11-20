import type { Approval, ExecutionEnvironment } from '../../contracts/types/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import type { PolicyActor, PolicyEvaluationResult } from '../../core/policy/index.ts';
import type { HardwareFitResult } from '../hardware/index.ts';
import type { ModelAvailabilityStatus } from '../runtime/index.ts';

export type TaskPriority = 'high' | 'normal' | 'low';

export interface LifecyclePolicyContext {
  actor: PolicyActor;
  declared_scopes: readonly string[];
  environment: ExecutionEnvironment;
  system_config: unknown;
  audit_logger: AuditLogger;
  correlation_id: string;
  approval?: Approval | null;
  now?: Date | string;
}

export interface LifecycleManagerOptions {
  maxConcurrentGlobal?: number;
  maxConcurrentPerModel?: number;
  maxQueueSize?: number;
  failureThreshold?: number;
  defaultQueueTimeoutMs?: number;
}

export interface CircuitBreakerState {
  model_id: string;
  consecutive_failures: number;
  circuit_open: boolean;
  last_error?: string;
  opened_at?: string;
}

export interface AvailabilityCheckResult {
  available: boolean;
  model_id: string;
  status: ModelAvailabilityStatus;
  code: string;
  reason: string;
  hardware_fit?: HardwareFitResult;
  runtime_healthy?: boolean;
  discovered_on_runtime?: boolean;
  circuit_open?: boolean;
}

export interface LifecycleOperationResult {
  ok: boolean;
  supported?: boolean;
  model_id: string;
  code: string;
  message: string;
  policy?: PolicyEvaluationResult;
  hardware_fit?: HardwareFitResult;
}

export interface SlotAcquisitionResult {
  acquired: boolean;
  queued: boolean;
  queue_position?: number;
  code: string;
  reason: string;
  release?: () => void;
}

export interface LifecycleStats {
  active_global: number;
  max_concurrent_global: number;
  max_concurrent_per_model: number;
  queued_count: number;
  max_queue_size: number;
  active_by_model: Record<string, number>;
  open_circuits: string[];
}
