export interface ModelWorkerMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelWorkerRequest {
  request_id?: string;
  model_name: string;
  messages: ModelWorkerMessage[];
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface ModelWorkerResponse {
  ok: boolean;
  worker_id: string;
  runtime_type: string;
  model_name: string;
  output_text: string;
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

export interface ModelWorkerHealth {
  healthy: boolean;
  worker_id: string;
  runtime_type: string;
  endpoint: string;
  latency_ms: number;
  models: string[];
  error?: string;
  checked_at: string;
}

export interface ModelWorkerCapabilities {
  supports_chat: boolean;
  supports_completion: boolean;
  supports_streaming: boolean;
  supports_cancellation: boolean;
  supports_tool_calling: boolean;
  supports_structured_output: boolean;
  max_context_length: number | null;
}

export interface ModelWorkerStreamChunk {
  delta: string;
  done: boolean;
}

export interface ModelWorkerClient {
  readonly worker_id: string;
  readonly runtime_type: string;
  health(timeoutMs?: number, signal?: AbortSignal): Promise<ModelWorkerHealth>;
  capabilities(): Promise<ModelWorkerCapabilities>;
  infer(request: ModelWorkerRequest): Promise<ModelWorkerResponse>;
  stream?(request: ModelWorkerRequest): AsyncIterable<ModelWorkerStreamChunk>;
}
