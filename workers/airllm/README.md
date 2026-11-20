# TEJAURA AirLLM Python Worker Service

The **AirLLM Python Worker** (`workers/airllm/`) runs separately from the TypeScript governance/control-plane core on **owner-controlled local or remote compute** (workstation, home GPU server, or owner-managed Linux machine).

> **Control vs. Compute Separation:** The user's Android phone is the **control device**, not the large-model inference machine. AirLLM runs inside this isolated Python worker on owner-controlled compute and exposes a small, token-authenticated internal HTTP interface to TEJAURA's `AirLlmRuntimeAdapter`.

---

## Verified AirLLM Requirements & Architecture Notes

Based on the official `lyogavin/airllm` library:

- **Core Python API:** `from airllm import AutoModel` -> `AutoModel.from_pretrained(model_path_or_repo, compression="4bit" | "8bit" | None, layer_shards_saving_path=...)` -> `model.generate(...)` + `model.tokenizer`.
- **Dependencies (`requirements.txt`):** `airllm`, `torch`, `transformers`, `accelerate`, `safetensors`, and optional `bitsandbytes` for 4-bit/8-bit block-wise compression.
- **How Layer-Wise Streaming Works:** AirLLM shards models per layer on disk and streams one layer at a time through VRAM, allowing large dense or MoE open-weight LLMs (e.g., Llama, Qwen, DeepSeek, Mistral/Mixtral, Phi, Gemma) to execute in 4GB–12GB VRAM.
- **Real Operational Limitations (Do Not Ignore):**
  1. **Disk I/O & Latency:** Generating each token streams weights from storage to GPU, which is significantly slower than full-VRAM engines like vLLM when NVMe throughput or RAM disk caching is limited.
  2. **Disk Space Overhead:** Initial layer sharding requires extra disk space comparable to or exceeding the checkpoint size.
  3. **Model & Modality Boundaries:** Not every Hugging Face repository or modality works reliably with AirLLM. Only models explicitly marked `"compatibility_status": "verified"` and `"modality": "text"` are permitted for inference in TEJAURA. Image-generation and unverified multimodal models remain disabled.
  4. **No Automatic Model Downloads:** By default, `RealAirLlmEngine` sets `allow_remote_hub_download=False` and requires weights to be pre-staged by the owner at `local_model_path`.

---

## Internal Authenticated HTTP Protocol

Every endpoint requires header `X-TEJAURA-Worker-Token` matching environment variable `TEJAURA_AIRLLM_WORKER_TOKEN` (verified with constant-time `hmac.compare_digest`).

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/internal/health` | `GET` | Worker readiness, AirLLM package availability, device, loaded model ID |
| `/internal/models` | `GET` | Currently loaded model metadata |
| `/internal/models/load` | `POST` | Load a `verified` `text` model (`repo_id`, `revision`, `local_model_path`, `compression`, `layer_shards_saving_path`) |
| `/internal/models/unload` | `POST` | Unload active model and release CUDA/RAM references (`gc.collect()`, `torch.cuda.empty_cache()`) |
| `/internal/infer` | `POST` | Run text/chat inference with `request_id`, `timeout_ms`, and cancellation checks (`untrusted_model_output: true`) |
| `/internal/requests/cancel` | `POST` | Signal cooperative cancellation (`threading.Event`) for an active `request_id` |

---

## Running & Testing Locally

### Run Python Protocol Tests (No GPU / No Weights Required)
```bash
python3 workers/airllm/test_worker.py
```

### Start Worker in Mock Mode (Protocol Integration)
```bash
TEJAURA_AIRLLM_WORKER_TOKEN="replace-with-random-local-token" \
  python3 workers/airllm/server.py --host 127.0.0.1 --port 8765 --mode mock
```

### Start Real AirLLM Worker (On Owner Compute with Installed `requirements.txt`)
```bash
TEJAURA_AIRLLM_WORKER_TOKEN="replace-with-random-local-token" \
  python3 workers/airllm/server.py --host 127.0.0.1 --port 8765 --mode airllm
```
