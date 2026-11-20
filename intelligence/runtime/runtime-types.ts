export type LocalRuntimeType =
  | 'airllm'
  | 'ollama'
  | 'llama_cpp'
  | 'vllm'
  | 'sglang'
  | 'openai_compatible_local';

export const PRIMARY_LOCAL_RUNTIME: LocalRuntimeType = 'airllm';

export type ModelCompatibilityStatus =
  | 'verified'
  | 'untested'
  | 'unsupported';

export type ModelModality =
  | 'text'
  | 'multimodal_vision'
  | 'image_generation'
  | 'audio';

export type ModelCapability =
  | 'text_generation'
  | 'chat'
  | 'code'
  | 'reasoning'
  | 'embeddings'
  | 'vision'
  | 'tool_calling'
  | 'structured_output';

export type ModelAvailabilityStatus =
  | 'available'
  | 'loading'
  | 'unavailable'
  | 'offline'
  | 'error';

export interface TrustedRuntimeEndpoint {
  endpoint_id: string;
  runtime_type: LocalRuntimeType;
  base_url: string;
  node_id: string;
  enabled: boolean;
  /**
   * Name of the environment variable containing the internal worker auth token
   * (never the secret token value itself).
   */
  auth_token_env_var?: string;
  requires_auth?: boolean;
}

export interface RuntimeSupportFlags {
  supports_discovery: boolean;
  supports_health_check: boolean;
  supports_chat_inference: boolean;
  supports_completion_inference: boolean;
  supports_load_unload: boolean;
  supports_cancellation: boolean;
}

export interface RuntimeHealthResult {
  healthy: boolean;
  runtime_type: LocalRuntimeType;
  endpoint: string;
  latency_ms: number;
  status_code?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface DiscoveredModelInfo {
  model_name: string;
  runtime_type: LocalRuntimeType;
  size_bytes?: number;
  details?: Record<string, unknown>;
}

export interface RuntimeDiscoveryResult {
  ok: boolean;
  supported: boolean;
  runtime_type: LocalRuntimeType;
  endpoint: string;
  models: DiscoveredModelInfo[];
  error?: string;
}

export interface LoadModelMetadata {
  model_id?: string;
  repo_id?: string;
  revision?: string;
  local_model_path?: string | null;
  compatibility_status?: ModelCompatibilityStatus;
  modality?: ModelModality;
  compression?: '4bit' | '8bit' | null;
  layer_shards_saving_path?: string | null;
}

export interface RuntimeLoadUnloadResult {
  ok: boolean;
  supported: boolean;
  runtime_type: LocalRuntimeType;
  model_name: string;
  action: 'load' | 'unload';
  message: string;
  code?: string;
}

export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RuntimeInferenceRequest {
  request_id?: string;
  model_name: string;
  messages: InferenceMessage[];
  compatibility_status?: ModelCompatibilityStatus;
  modality?: ModelModality;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface RuntimeInferenceResponse {
  ok: boolean;
  runtime_type: LocalRuntimeType;
  model_name: string;
  output_text: string;
  /**
   * Explicit security marker: model output is untrusted data and must never
   * alter permissions, registry entries, or system configuration.
   */
  untrusted_model_output: true;
  finish_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  latency_ms: number;
  cancelled?: boolean;
  timed_out?: boolean;
  error_code?: string;
  error?: string;
}

export interface RuntimeAdapter {
  readonly runtime_type: LocalRuntimeType;
  readonly support: RuntimeSupportFlags;
  healthCheck: (
    endpoint: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ) => Promise<RuntimeHealthResult>;
  discoverModels: (
    endpoint: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ) => Promise<RuntimeDiscoveryResult>;
  loadModel: (
    endpoint: string,
    modelName: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
    metadata?: LoadModelMetadata,
  ) => Promise<RuntimeLoadUnloadResult>;
  unloadModel: (
    endpoint: string,
    modelName: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    authHeaders?: Record<string, string>,
  ) => Promise<RuntimeLoadUnloadResult>;
  infer: (
    endpoint: string,
    request: RuntimeInferenceRequest,
    authHeaders?: Record<string, string>,
  ) => Promise<RuntimeInferenceResponse>;
}
