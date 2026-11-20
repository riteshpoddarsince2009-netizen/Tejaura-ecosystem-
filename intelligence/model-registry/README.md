# TEJAURA Model Registry

**Registry Schema Version:** 1.0.0  
**Current State:**
- **Stage 1 Baseline (`models.json` / `model-registry.schema.json`):** Validated empty baseline (`0` registered models).
- **Stage 2A Local-First Registry (`local-models.json` / `local-model.schema.json` / `local-model-registry.ts`):** Implemented & tested strict schema (`preferred_runtime: "airllm"`, `local_first_only: true`, `allow_paid_third_party_apis: false`, `allow_secrets: false`) with `L4` owner-gated mutations and fail-closed compatibility/modality checks.

See `docs/LOCAL_MODELS.md` and `workers/airllm/README.md` for runtime details.

---

## Core Rules

1. **AirLLM Primary Runtime & Self-Hosted Only:** `airllm` is TEJAURA's primary model inference engine (`ollama`, `llama_cpp`, `vllm`, `sglang`, and `openai_compatible_local` are supported as secondary runtimes). Paid third-party AI APIs are forbidden.
2. **Verified-Only Enablement:** Every local model entry must declare `compatibility_status` (`"verified"`, `"untested"`, or `"unsupported"`). Only `"verified"` models with `"modality": "text"` may have `"enabled": true`.
3. **Unsupported Modalities Disabled:** `image_generation`, `audio`, and unverified `multimodal_vision` / `vision` capabilities fail closed until a separately verified execution path exists.
4. **Zero Secrets in Registry:** Registry files must **never** store API keys, Hugging Face tokens, worker tokens, or embedded URL credentials. Internal worker auth tokens are referenced strictly by environment variable name on `TrustedRuntimeEndpoint.auth_token_env_var`.
5. **Explicit Owner Registration:** Registering or enabling models requires `L4` owner-exclusive `model:registry_write` authorization. Agents and model output cannot mutate the registry.

---

## Stage 2A Local Model Entry Schema (`local-models.json`)

```json
{
  "model_id": "llama-3.1-70b-airllm-q4",
  "model_name": "Meta-Llama-3.1-70B-Instruct",
  "model_family": "llama3.1",
  "model_version": "70b-instruct",
  "model_repository": {
    "repo_id": "meta-llama/Llama-3.1-70B-Instruct",
    "revision": "main",
    "source": "local_mirror"
  },
  "local_model_path": "models/llama-3.1-70b-instruct",
  "controlled_runtime_endpoint": "http://127.0.0.1:8765",
  "runtime_type": "airllm",
  "compatibility_status": "verified",
  "modality": "text",
  "capabilities": ["chat", "text_generation", "reasoning"],
  "hardware_requirements": {
    "min_ram_mb": 16384,
    "min_vram_mb": 4096,
    "min_storage_mb": 45000,
    "requires_gpu": true
  },
  "quantization": "4bit",
  "context_length": 32768,
  "enabled": false,
  "availability": "unavailable",
  "license": {
    "name": "Llama 3.1 Community License",
    "open_weight": true,
    "commercial_use_allowed": true
  }
}
```
