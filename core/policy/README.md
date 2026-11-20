# TEJAURA Core Policy Evaluator

Deterministic, fail-closed policy evaluation engine enforcing TEJAURA's constitution and permission policy (`core/constitution/TEJAURA_CONSTITUTION.md`, `core/permissions/PERMISSION_POLICY.md`, and `core/configuration/system.json`).

---

## Trust Boundary

`evaluatePolicy` **never** treats agent-supplied claims as authoritative:
- `actor.trusted_autonomy_level`, `actor.trusted_authenticated`, `actor.trusted_agent_record`, `declared_scopes`, and `approval` MUST be resolved from trusted host storage before calling the evaluator.
- If `trusted_agent_record` is supplied, the evaluator takes `min(trusted_autonomy_level, agentRecord.permitted_autonomy_level)` and denies disabled or mismatched agents.
- An agent claiming `L4` or supplying an invalid/tampered approval object is always denied (`allowed: false`, `decision: "deny"`).

---

## Evaluation Rules

1. **Invalid Configuration Fails Closed:** `system_config` is validated via `validateSystemConfig`. Any invalid configuration yields `deny` (`INVALID_SYSTEM_CONFIG`).
2. **Default Deny & Closed Action Catalog:** Unknown actions, missing actor identity, missing scopes, or wildcard scopes (`*`) are denied.
3. **Environment Isolation:** Sandbox actions (`sandbox:write`, `sandbox:execute`) are restricted to `sandbox`; sandbox scopes never authorize `production`.
4. **Autonomy Enforcement:**
   - `L0`–`L2`: Allowed only within `maxAutonomousLevel` when actor autonomy and exact scope match.
   - `L3`: Returns `require_approval` (`allowed: false`) unless a valid, non-expired, unconsumed, non-self-approved owner `Approval` matching exact `action`, `resource`, `environment`, and `scope` is supplied.
   - `L4`: Strictly owner-exclusive (`deploy:production`, `billing:transact`, `publish:public`, `governance:modify`, `permission:grant`, `approval:decide`, `credential:access`, `data:delete`). Agents are always denied (`deny`).
5. **Audit Coupling (`evaluatePolicyWithAudit`):** If writing the decision to `AuditLogger` fails, authorization is overridden to `deny` (`AUDIT_STORAGE_FAILURE`).
