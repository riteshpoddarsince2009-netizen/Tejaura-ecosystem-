# TEJAURA Local Model & AirLLM Infrastructure (Stage 2A)

**Status:**
- **Implemented & Tested (Offline / Mock Worker):** Local Model Registry (`verified`-only enablement), Hardware Abstraction, `AirLlmRuntimeAdapter` + `RuntimeManager`, isolated Python AirLLM Worker Protocol (`MockAirLlmEngine`), `ModelLifecycleManager`, `ModelRouter` (`airllm` primary), and secondary adapters (Ollama, llama.cpp, vLLM, SGLang, OpenAI-compatible local).
- **Implemented, Not Yet Live-GPU Verified:** `RealAirLlmEngine` (`workers/airllm/airllm_engine.py`) wrapping `airllm.AutoModel.from_pretrained(...)` and `model.generate(...)` — verified against official `lyogavin/airllm` documentation, but not executed against physical GPU/weights in CI.
- **Disabled / Not Supported:** Image-generation models, audio models, and unverified multimodal vision paths remain disabled until separately verified execution paths exist.

---

## 1. Architecture: Phone Control + Owner Compute + AirLLM Primary

- **Control Device (Android Phone):** Dispatches tasks, inspects system status, and grants `L3`/`L4` owner approvals. Never hosts large-model weights or heavy LLM inference.
- **Primary Inference Engine (`airllm`):** Runs inside an isolated Python worker service (`workers/airllm/`) on owner-controlled local or remote compute (`localhost`, LAN GPU box, or owner HTTPS node).
- **TypeScript Core Isolation:** `intelligence/` communicates with the Python worker strictly over an authenticated internal HTTP protocol (`X-TEJAURA-Worker-Token`), keeping `torch`, `transformers`, `accelerate`, `safetensors`, `bitsandbytes`, and `airllm` completely out of the Node/Bun/Vite runtime.
- **No Paid Third-Party AI API Fallback:** If no verified local model fits hardware and capabilities, `ModelRouter` returns `unavailable` (or `queued` if busy) and never falls back to paid cloud APIs.

---

## 2. Official AirLLM Verification & Operational Realities

Based on the official `lyogavin/airllm` repository and documentation:

- **Dependencies:** `airllm`, `torch`, `transformers`, `accelerate`, `safetensors` (plus optional `bitsandbytes` for `compression="4bit"` / `"8bit"`).
- **API Interface:** `from airllm import AutoModel` -> `AutoModel.from_pretrained(path_or_repo, compression=..., layer_shards_saving_path=...)` -> `model.tokenizer` + `model.generate(...)`.
- **Supported Architectures (Upstream Claims):** Dense and MoE transformer LLMs with standard safetensors layouts (e.g., Llama 2/3/3.1/3.3, Qwen 1.5/2/2.5/3, DeepSeek-V2/V3/R1, Mistral/Mixtral, Phi, Gemma). **Important:** TEJAURA does **not** assume every model in these families works on your node—each registered model must carry an explicit `compatibility_status` (`verified` | `untested` | `unsupported`).
- **Critical Limitations:**
  1. **Sequential Layer Streaming Latency:** Reading layers from SSD/NVMe per generated token makes inference markedly slower than full-VRAM serving (seconds to minutes per token for massive 70B+ models on slower disks).
  2. **Disk Overhead:** AirLLM splits and stores per-layer shards on disk (`layer_shards_saving_path` / HF cache), requiring free storage equal to or exceeding model size.
  3. **No Automatic Downloads:** `RealAirLlmEngine` disables automatic hub downloads (`allow_remote_hub_download=False`) and expects pre-staged weights at `local_model_path`. Model downloads remain gated behind `L3` `model:download` owner approval.

---

## 3. Registry & Compatibility Enforcement

Every model entry in `intelligence/model-registry/local-model.schema.json` requires:
- `model_repository`: `{ repo_id, revision, source }`
- `runtime_type`: `"airllm"` (primary) or secondary local runtime
- `compatibility_status`: `"verified"` | `"untested"` | `"unsupported"`
- `modality`: `"text"` (enabled) | `"multimodal_vision"` | `"image_generation"` | `"audio"` (disabled)
- `capabilities`, `quantization`, `hardware_requirements` (`min_ram_mb`, `min_vram_mb`, `min_storage_mb`, `requires_gpu`), `license` (`open_weight: true`), `local_model_path`, `controlled_runtime_endpoint`, `enabled`, `availability`.

**Fail-Closed Rules:**
1. Only `compatibility_status: "verified"` and `modality: "text"` models may be set `enabled: true` in `LocalModelRegistry`.
2. `ModelLifecycleManager`, `ModelRouter`, `AirLlmRuntimeAdapter`, and the Python worker each independently reject `untested`, `unsupported`, and non-`text` requests.

---

## 4. Runtime Feature Matrix

| Runtime (`runtime_type`) | Role | Health | Discovery | Chat/Text Infer | Load / Unload | Cancellation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `airllm` | **Primary** | `/internal/health` | `/internal/models` | `/internal/infer` | **Yes** (`AutoModel` load & GC/CUDA release) | Cooperative token/deadline + `/internal/requests/cancel` |
| `ollama` | Secondary | `/api/tags` | `/api/tags` | `/api/chat` | **Yes** (`keep_alive`) | HTTP `AbortSignal` |
| `llama_cpp` | Secondary | `/health` | `/v1/models` | `/v1/chat/completions` | **No** (`UNSUPPORTED_RUNTIME_OPERATION`) | HTTP `AbortSignal` |
| `vllm` | Secondary | `/health` | `/v1/models` | `/v1/chat/completions` | **No** (`UNSUPPORTED_RUNTIME_OPERATION`) | HTTP `AbortSignal` |
| `sglang` | Secondary | `/health` | `/v1/models` + `/get_model_info` | `/v1/chat/completions` | **No** (`UNSUPPORTED_RUNTIME_OPERATION`) | HTTP `AbortSignal` |
| `openai_compatible_local` | Secondary | `/v1/models` | `/v1/models` | `/v1/chat/completions` | **No** (`UNSUPPORTED_RUNTIME_OPERATION`) | HTTP `AbortSignal` |

---

## 5. Security Boundaries

- **Authenticated Internal Worker Interface:** `TEJAURA_AIRLLM_WORKER_TOKEN` (referenced only by env var name `auth_token_env_var`, never stored in config) is sent in `X-TEJAURA-Worker-Token` and checked with constant-time `hmac.compare_digest`.
- **Trusted Endpoints Only:** `endpoint-guard.ts` rejects arbitrary URLs, embedded URL credentials, plaintext non-local HTTP, redirects, and commercial AI API hosts.
- **Policy & Audit Integration:** `runtime:manage` (`L3`), `model:download` (`L3`), `model:registry_write` (`L4`), `model:load`/`unload` (`L2`), and `model:invoke_local` (`L2`) all pass through `PolicyEvaluator` + `AuditLogger`.
