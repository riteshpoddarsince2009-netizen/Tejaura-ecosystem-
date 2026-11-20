# TEJAURA Model Registry

**Registry Schema Version:** 1.0.0  
**Current State:**
- **Stage 1 Baseline (`models.json` / `model-registry.schema.json`):** Validated empty baseline (`0` registered models).
- **Stage 2 Local-First Registry (`local-models.json` / `local-model.schema.json` / `local-model-registry.ts`):** Implemented & tested strict schema and L4 owner-gated runtime registry for self-hosted open-weight models (`local_first_only: true`, `allow_paid_third_party_apis: false`, `allow_secrets: false`).

The TEJAURA Model Registry provides a single, versioned, provider-agnostic catalog of AI models approved by the human owner for use within the system. See `docs/LOCAL_MODELS.md` for Stage 2 runtime, hardware, and routing details.

---

## Core Rules

1. **Provider-Agnostic Contract:** Models from any source—local runtimes (e.g., Ollama, llama.cpp), open-source hosted endpoints, or commercial APIs—must conform to a uniform metadata schema. No system module may couple directly to a single vendor.
2. **Open-Source-First & Free-First:** When selecting or prioritizing defaults, open-weights and zero-cost/local models take precedence over paid proprietary APIs unless explicitly overridden by the human owner.
3. **Zero Secrets in Registry:** `models.json` must **never** contain API keys, bearer tokens, passwords, or private endpoint secrets. Only reference the *name* of an environment variable (e.g., `"apiKeyEnvVar": "OPENAI_API_KEY"`) when authentication is required.
4. **Explicit Owner Registration:** Future runtime engines may only invoke models explicitly registered and marked `"enabled": true` in `models.json`. Agents cannot self-register paid or external models.
5. **Versioned Schema & Auditability:** Every structural change to `models.json` must preserve `schemaVersion` and update `registryVersion` and `lastUpdated`.

---

## Model Entry Schema (For Future Registrations)

When models are added in future stages, each item in the `"models"` array of `models.json` must follow this structure:

```json
{
  "id": "local-llama-example",
  "displayName": "Local Llama Example",
  "providerType": "local-open-source",
  "adapter": "openai-compatible",
  "endpoint": "http://localhost:11434/v1",
  "apiKeyEnvVar": null,
  "license": "open-weights",
  "costTier": "free",
  "capabilities": ["text-generation", "reasoning"],
  "contextWindow": 8192,
  "maxAutonomyAllowed": "L2",
  "enabled": false,
  "addedAt": "2026-11-20T00:00:00Z"
}
```

### Field Guidelines
- `providerType`: One of `"local-open-source"`, `"self-hosted"`, `"free-cloud-tier"`, or `"paid-api"`.
- `costTier`: `"free"`, `"metered-low"`, or `"metered-high"`. Paid tiers require explicit owner budget confirmation before enabling.
- `apiKeyEnvVar`: Must be `null` for unauthenticated local models or the environment variable identifier string—never the actual secret value.
- `maxAutonomyAllowed`: Cannot exceed `system.json`'s `governance.maxAutonomousLevel` without explicit owner approval workflows.
