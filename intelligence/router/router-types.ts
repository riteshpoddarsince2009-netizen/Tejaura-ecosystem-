import type { ComputeNode } from '../hardware/index.ts';
import type { TaskPriority } from '../lifecycle/index.ts';
import type { LocalModelEntry } from '../model-registry/local-model-registry.ts';
import type {
  LocalRuntimeType,
  ModelCapability,
  RuntimeInferenceResponse,
} from '../runtime/index.ts';

export interface RoutingRequest {
  task_id: string;
  required_capabilities: ModelCapability[];
  min_context_length: number;
  priority: TaskPriority;
  preferred_model_id?: string;
  preferred_runtime_type?: LocalRuntimeType;
  max_ram_mb?: number;
  max_vram_mb?: number;
  allow_queue?: boolean;
}

export interface RejectedCandidate {
  model_id: string;
  code: string;
  reason: string;
}

export interface RoutingDecision {
  decision: 'routed' | 'queued' | 'unavailable';
  code: string;
  reason: string;
  paid_api_fallback_used: false;
  selected_model: LocalModelEntry | null;
  selected_node: ComputeNode | null;
  rejected_candidates: RejectedCandidate[];
}

export interface RoutedInferenceResult {
  ok: boolean;
  routing: RoutingDecision;
  response?: RuntimeInferenceResponse;
  error_code?: string;
  error?: string;
}
