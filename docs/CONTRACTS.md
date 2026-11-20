# TEJAURA Contracts Specification & Guide

**Document Version:** 1.0.0  
**Milestone:** Milestone 1 — Core Contracts (`Implemented & Tested`)

TEJAURA Core Contracts define the strict data boundaries between governance policies, future runtime engines, model/tool adapters, and phone-first interfaces. Every contract uses **JSON Schema Draft 2020-12**, matching **strict TypeScript types**, and a **fail-closed Ajv validator** (`ajv/dist/2020` + `ajv-formats`).

---

## 1. Design Guarantees

1. **Fail-Closed Validation:** Malformed JSON, non-object inputs, missing required properties, invalid timestamps, unknown properties, or schema compilation failures always return `{ valid: false, data: null, errors: [...] }`. Validation is never bypassed on parse errors.
2. **Governance Enforcement at Schema Level:**
   - Agents (`agent.schema.json`) may only be assigned `permitted_autonomy_level` values `"L0"` through `"L3"`. `"L4"` (`owner_exclusive`) is disallowed at the schema level.
   - `approval.schema.json` enforces explicit bounded `scope` (`resources`, `permissions`, `single_use`) and tracks `requested_by` separately from `reviewed_by`.
3. **Zero Credentials in Contracts:** No contract defines password, secret, or API key fields, and free-form payload maps (`task.input`, `task.result`, `audit_event.metadata`) reject secret-carrying property names such as `api_key`, `password`, `secret`, and `access_token`.
4. **Consistent `snake_case` Naming:** All JSON properties and TypeScript fields use `snake_case`.

---

## 2. Contract Catalog & Required Fields

### 2.1 Task (`contracts/schemas/task.schema.json`, `contracts/types/task.ts`)
- **Purpose:** Tracks a single requested unit of work across its lifecycle (`queued`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`).
- **Required fields:**
  - `id`, `type`, `title`, `description`
  - `status`, `autonomy_level` (`L0`–`L4`)
  - `created_at`, `updated_at` (RFC 3339 `date-time`)
  - `requested_by`, `assigned_agent_id` (`string | null`)
  - `input` (object), `result` (`object | null`), `error` (`TaskError | null`)
  - `approval_ids` (unique array of approval IDs)

### 2.2 Agent (`contracts/schemas/agent.schema.json`, `contracts/types/agent.ts`)
- **Purpose:** Declares a modular agent identity, operational state, tool allowlist, and preferred registered models.
- **Required fields:**
  - `id`, `name`, `department`, `role`, `description`
  - `status` (`active | paused | disabled | retired`), `enabled` (boolean)
  - `permitted_autonomy_level` (`L0 | L1 | L2 | L3`)
  - `allowed_tool_ids`, `preferred_model_ids`
  - `created_at` (RFC 3339 `date-time`)

### 2.3 Tool (`contracts/schemas/tool.schema.json`, `contracts/types/tool.ts`)
- **Purpose:** Defines an inspectable tool capability, its input/output contract references, least-privilege scope, and risk level.
- **Required fields:**
  - `id`, `name`, `description`, `category`
  - `input_schema_ref`, `output_schema_ref`
  - `permission_scope` (domain:action format, e.g. `fs:read:workspace`)
  - `risk_level` (`low | medium | high | critical`)
  - `enabled` (boolean)

### 2.4 Approval (`contracts/schemas/approval.schema.json`, `contracts/types/approval.ts`)
- **Purpose:** Represents an explicit human-owner authorization gate for `L3`/`L4` actions.
- **Required fields:**
  - `id`, `task_id`, `action`
  - `requested_by`, `requested_at`
  - `status` (`pending | approved | rejected | expired`)
  - `reviewed_by` (`string | null`), `reviewed_at` (`string | null`)
  - `reason`
  - `scope` (`{ resources, permissions, single_use, expires_at? }`)

### 2.5 Audit Event (`contracts/schemas/audit-event.schema.json`, `contracts/types/audit-event.ts`)
- **Purpose:** Provides a structured, inspectable audit record of actor actions, policy decisions, approvals, and outcomes.
- **Required fields:**
  - `id`, `timestamp`
  - `actor_type` (`owner | agent | system | policy_engine | adapter`), `actor_id`
  - `event_type`, `resource_type`, `resource_id`
  - `action`, `outcome` (`success | failure | denied | pending | cancelled`)
  - `approval_id` (`string | null`)
  - `metadata` (object, secret keys rejected)

---

## 3. How to Validate an Object

Use the exported validation functions from `contracts/validation/index.ts`:

```ts
import {
  validateTask,
  validateAgent,
  validateTool,
  validateApproval,
  validateAuditEvent,
  validateContract,
  parseAndValidateContract,
} from '../contracts/validation/index.ts';

// 1. Validate an in-memory object
const taskCheck = validateTask(payload);
if (!taskCheck.valid) {
  // Structured errors: [{ path, keyword, message, schema_path }]
  console.error(taskCheck.errors);
}

// 2. Parse + validate raw JSON safely (fails closed on syntax errors)
const approvalCheck = parseAndValidateContract('approval', rawJsonText);
```

Run the automated contract tests and checks:

```bash
npm test          # Executes contracts/tests/*.test.ts via tsx --test
npm run lint      # Runs tsc --noEmit across schemas, types, validator, and tests
npm run build     # Verifies Vite production build
```

---

## 4. How to Add a Future Contract Safely

1. **Check Governance Alignment:** Ensure the new contract obeys `TEJAURA_CONSTITUTION.md` and `PERMISSION_POLICY.md` (no credential fields, no agent self-approval or `L4` assignment).
2. **Author JSON Schema (`contracts/schemas/<name>.schema.json`):**
   - Use JSON Schema Draft 2020-12 (`$schema` + unique `$id`).
   - Use `snake_case` properties, explicit `required` arrays, `additionalProperties: false`, `date-time` formats, and identifier regex patterns.
3. **Create TypeScript Types (`contracts/types/<name>.ts`):**
   - Mirror the schema 1:1 and export from `contracts/types/index.ts` (including updating `ContractKind`).
4. **Register in Validator (`contracts/validation/validator.ts`):**
   - Import the schema, add it to `DEFAULT_SCHEMAS` and `ContractMap`, and expose a dedicated `validate<Name>` function in `validator.ts` and `validation/index.ts`.
5. **Add Tests (`contracts/tests/`):**
   - Cover valid fixtures, missing fields, invalid enums, invalid timestamps, unexpected properties, secret rejection, and fail-closed inputs.
6. **Document:** Update `contracts/README.md` and `docs/CONTRACTS.md`.

---

## 5. Versioning & Backward Compatibility

- **Schema `$id` Namespace:** All Milestone 1 schemas live under `https://tejaura.org/schemas/v1/<name>.schema.json`.
- **Optional `schema_version` Field:** Contracts support an optional semantic version string (`MAJOR.MINOR.PATCH`, e.g., `"1.0.0"`).
- **Non-Breaking (`MINOR` / `PATCH`) Changes:** Adding *optional* properties or tightening descriptions/documentation without breaking existing valid `v1` payloads.
- **Breaking (`MAJOR`) Changes:** Adding new `required` properties, removing/renaming fields, or narrowing existing enums requires a major version bump (e.g., `/schemas/v2/`) and explicit migration tooling before modifying runtime consumers.
