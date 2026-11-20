# TEJAURA Core Contracts

This directory contains TEJAURA's canonical data contracts (Milestone 1):

- `schemas/` — JSON Schema Draft 2020-12 definitions with strict property checks (`additionalProperties: false`) and format validation.
- `types/` — Strict TypeScript types aligned 1:1 with the JSON Schemas.
- `validation/` — Fail-closed Ajv Draft 2020-12 validation engine (`ajv` + `ajv-formats`).
- `tests/` — Automated unit tests verifying valid payloads, missing fields, invalid enums, bad timestamps, extra properties, secret-key rejection, and fail-closed error handling.

---

## Contract Overview

| Contract | Schema | TypeScript Type | Purpose |
| :--- | :--- | :--- | :--- |
| **Task** | `schemas/task.schema.json` | `Task` | Represents a governed unit of work, autonomy level (`L0`–`L4`), input/result/error state, and linked approvals. |
| **Agent** | `schemas/agent.schema.json` | `Agent` | Defines an agent's role, status, tool allowlist, model preferences, and ceiling (`L0`–`L3` only; `L4` excluded). |
| **Tool** | `schemas/tool.schema.json` | `Tool` | Declares a modular capability, input/output schema refs, permission scope, and risk level. |
| **Approval** | `schemas/approval.schema.json` | `Approval` | Captures human-owner authorization requests and decisions with bounded least-privilege `scope`. |
| **Audit Event** | `schemas/audit-event.schema.json` | `AuditEvent` | Records immutable governance, approval, and execution events for owner inspection. |

---

## Quick Usage

```ts
import { validateTask, parseAndValidateContract } from './validation/index.ts';

const result = validateTask(candidateObject);
if (!result.valid) {
  console.error(result.errors);
}

const parsed = parseAndValidateContract('approval', rawJsonString);
if (!parsed.valid) {
  // Always fail closed when JSON parsing or schema validation fails
  throw new Error(parsed.errors.map((e) => e.message).join('; '));
}
```

For full details on required fields, validation rules, versioning, and adding future contracts safely, see [`docs/CONTRACTS.md`](../docs/CONTRACTS.md).
