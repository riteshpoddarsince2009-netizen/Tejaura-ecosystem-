import type { LocalRuntimeType } from '../runtime/runtime-types.ts';

export type ComputeNodeLocation = 'local' | 'lan' | 'owner_remote';

export interface ComputeNode {
  node_id: string;
  name: string;
  location: ComputeNodeLocation;
  total_ram_mb: number;
  available_ram_mb: number;
  total_vram_mb: number;
  available_vram_mb: number;
  total_storage_mb: number;
  available_storage_mb: number;
  has_gpu: boolean;
  gpu_name?: string | null;
  supported_runtimes: LocalRuntimeType[];
  installed_model_ids: string[];
  online: boolean;
  last_seen_at: string;
}

export type HardwareFitReasonCode =
  | 'FIT_OK'
  | 'NODE_NOT_FOUND'
  | 'NODE_OFFLINE'
  | 'INVALID_NODE_TELEMETRY'
  | 'UNSUPPORTED_RUNTIME'
  | 'GPU_REQUIRED'
  | 'INSUFFICIENT_VRAM'
  | 'INSUFFICIENT_RAM'
  | 'INSUFFICIENT_STORAGE';

export interface HardwareFitResult {
  fits: boolean;
  code: HardwareFitReasonCode;
  reason: string;
  node_id?: string;
  headroom?: {
    ram_mb: number;
    vram_mb: number;
    storage_mb: number;
  };
}
