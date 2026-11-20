# TEJAURA Local Model Infrastructure (Stage 2)

**Status:** Implemented & Tested (`intelligence/`)  
**Architectural Principle:** Local-model-first, self-hosted open-weight models only. TEJAURA does **not** fall back to paid third-party AI APIs.

---

## 1. Local-Model-First Architecture

Stage 2 implements a direct, provider-independent inference layer connecting strictly to owner-controlled local or owner-hosted compute runtimes:

1. **Local Model Registry (`intelligence/model-registry/`):**
   - `local-model.schema.json` (JSON Schema Draft 2020-12) and `local-model-registry.ts` enforce `local_first_only: true`, `allow_paid_third_party_apis: false`, `allow_secrets: false`, and `open_weight: true`.
   - Every model declares `model_id`, `model_name`, `model_family`, `model_version`, `local_model_path` and/or `controlled_runtime_endpoint`, `runtime_type`, `capabilities`, `hardware_requirements`, `quantization`, `context_length`, `enabled`, `availability`, and `license`.
   - Registry mutations (`registerModel`, `setEnabled`) require `L4` owner-exclusive authorization via `PolicyEvaluator` + `AuditLogger`.

2. **Hardware Abstraction (`intelligence/hardware/`):**
   - `HardwareManager` models owner-controlled `ComputeNode` instances (`local`, `lan`, `owner_remote`) with explicit RAM, VRAM, storage, GPU presence, supported runtimes, and installed model IDs.
   - `checkHardwareFit` fails closed: a model never routes or loads unless the target node is online, supports the model's `runtime_type`, meets `requires_gpu`, and has sufficient free VRAM, RAM, and storage headroom.

3. **Runtime Manager & Direct Adapters (`intelligence/runtime/`):**
   - Connects directly via HTTP without external SDK dependencies to self-hosted inference servers.
   - Enforces `endpoint-guard.ts` (`resolveTrustedEndpoint`, `validateControlledEndpointUrl`) on every request:
     - Only owner-registered trusted endpoints are allowed.
     - Arbitrary URLs (including URLs produced inside model output) are rejected.
     - Known commercial AI API hosts (OpenAI, Anthropic, Google Gemini, Groq, etc.) and embedded URL credentials are blocked.
     - Non-loopback/non-private remote endpoints require `https://`.
     - HTTP redirects are rejected (`redirect: 'error'`).
   - All inference calls enforce request timeouts and caller `AbortSignal` cancellation, and tag all returned completions with `untrusted_model_output: true`.

4. **Model Lifecycle Manager (`intelligence/lifecycle/`):**
   - Performs availability checks combining registry status, circuit-breaker state, hardware fit, and optional live runtime health/discovery probes.
   - Manages global and per-model concurrency limits with a bounded priority queue (`high`, `normal`, `low`).
   - Tracks consecutive runtime failures per model, opens a circuit breaker upon reaching the failure threshold, and recovers only after a passing runtime health check and hardware check.
   - Authorizes model load/unload (`L2`) and model download gates (`L3` with explicit owner approval) without ever initiating unapproved automatic large downloads.

5. **Model Router (`intelligence/router/`):**
   - Deterministically scores enabled, available, circuit-healthy models against required `capabilities`, `min_context_length`, memory budgets, `checkHardwareFit`, priority, and concurrency capacity.
   - If no eligible local model qualifies, returns `decision: 'unavailable'` with detailed per-model rejection codes (`CAPABILITY_MISMATCH`, `CONTEXT_LENGTH_INSUFFICIENT`, `INSUFFICIENT_VRAM`, `NODE_OFFLINE`, etc.) or `decision: 'queued'` when at concurrency capacity. **Never falls back to paid third-party AI APIs.**

---

## 2. Supported Runtimes & Feature Matrix

TEJAURA does not assume every self-hosted inference server exposes identical HTTP management endpoints:

| Runtime (`runtime_type`) | Health Check | Model Discovery | Chat Inference | HTTP Load / Unload | Cancellation & Timeout |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ollama` | Yes (`GET /api/tags`) | Yes (`GET /api/tags`) | Yes (`POST /api/chat`) | **Yes** (`POST /api/generate` `keep_alive`) | Yes (`AbortSignal`) |
| `llama_cpp` | Yes (`GET /health`) | Yes (`GET /v1/models`) | Yes (`POST /v1/chat/completions`) | **No** (returns `UNSUPPORTED_RUNTIME_OPERATION`) | Yes (`AbortSignal`) |
| `vllm` | Yes (`GET /health`) | Yes (`GET /v1/models`) | Yes (`POST /v1/chat/completions`) | **No** (returns `UNSUPPORTED_RUNTIME_OPERATION`) | Yes (`AbortSignal`) |
| `sglang` | Yes (`GET /health`) | Yes (`GET /v1/models` + `/get_model_info`) | Yes (`POST /v1/chat/completions`) | **No** (returns `UNSUPPORTED_RUNTIME_OPERATION`) | Yes (`AbortSignal`) |
| `openai_compatible_local` | Yes (`GET /v1/models`) | Yes (`GET /v1/models`) | Yes (`POST /v1/chat/completions`) | **No** (returns `UNSUPPORTED_RUNTIME_OPERATION`) | Yes (`AbortSignal`) |

For runtimes that bind a single model at process launch (`llama_cpp`, `vllm`, `sglang`, `openai_compatible_local`), TEJAURA never fakes HTTP model loading; process lifecycle changes must go through an owner-approved `runtime:manage` (`L3`) workflow.

---

## 3. Security Boundaries

- **Prompt-Injection Containment:** Model responses are returned strictly as untrusted data (`untrusted_model_output: true`). Model output cannot register models, add runtime endpoints, grant permissions, approve requests, or modify `core/configuration/system.json`.
- **Policy Integration:**
  - `model:discover` (`L0`), `model:load` (`L2`), `model:unload` (`L2`), `model:invoke_local` (`L2`)
  - `runtime:manage` (`L3`, requires explicit human owner approval via `ApprovalService`)
  - `model:download` (`L3`, requires explicit human owner approval via `ApprovalService`)
  - `model:registry_write` (`L4`, owner-exclusive)
- **Zero Secrets:** `local-model-registry.ts` recursively rejects secret-like property names and embedded URL credentials.

---

## 4. Local Setup Summary

1. Install and start a self-hosted inference server on hardware you control, for example:
   - **Ollama:** `ollama serve` on `http://127.0.0.1:11434`
   - **llama.cpp:** `llama-server -m ./models/model.gguf --host 127.0.0.1 --port 8080`
   - **vLLM:** `vllm serve <open-weight-model> --host 127.0.0.1 --port 8000`
   - **SGLang:** `python -m sglang.launch_server --model-path <open-weight-model> --host 127.0.0.1 --port 30000`
2. Register the node in `HardwareManager` with verified RAM, VRAM, and disk headroom.
3. Register the trusted endpoint in `RuntimeManager` (`runtime:manage` approval) and the model metadata in `LocalModelRegistry` (`L4` owner action).
4. Route tasks through `ModelRouter` and `ModelLifecycleManager`.
