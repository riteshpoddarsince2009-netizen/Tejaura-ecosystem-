# TEJAURA Permission Policy

**Policy Version:** 1.0.0  
**Alignment:** `core/constitution/TEJAURA_CONSTITUTION.md` & `core/configuration/system.json`  
**Status:** Policy Specification (Automated runtime policy engine planned in Stage 1)

This document defines TEJAURA's least-privilege access control model, capability scopes, and mandatory human approval rules.

---

## 1. Core Security Principles

1. **Default Deny:** No agent, plugin, or module has any capability unless explicitly granted by owner-approved policy.
2. **Least Privilege:** Every module receives only the minimum read, write, or execution scope required for its specific task—never wildcard access.
3. **Zero Self-Escalation:** No agent or automated workflow may grant permissions to itself, create privileged sub-agents with broader scopes, or modify permission policies.
4. **No Self-Approval:** The entity requesting or preparing a sensitive action cannot satisfy the approval requirement for that action.
5. **Fail-Closed Behavior:** If policy evaluation fails, configuration is malformed, or an approval state is ambiguous, the action must be blocked.

---

## 2. Autonomy Level Alignment

All permission checks enforce the five constitutional autonomy levels defined in `TEJAURA_CONSTITUTION.md` and `system.json`:

| Level | Identifier | Permission Ceiling |
| :--- | :--- | :--- |
| **L0** | `observe_only` | Read-only inspection; zero mutations or external side effects. |
| **L1** | `propose_only` | Drafts plans and proposals only *(system default)*. |
| **L2** | `bounded_local` | Reversible, sandboxed local actions within approved scopes *(max unattended level)*. |
| **L3** | `supervised_action` | Approved external or side-effecting actions requiring explicit owner approval. |
| **L4** | `owner_exclusive` | Permanently owner-locked; agents cannot hold `L4` or execute `L4` actions autonomously. |

---

## 3. Capability Scopes

Future runtime modules must request capabilities using explicit, narrow scopes:

| Scope Category | Example Scopes | Default State |
| :--- | :--- | :--- |
| **Filesystem** | `fs:read:<path>`, `fs:write:workspace-temp` | Denied unless scoped |
| **Configuration & Governance** | `governance:read` (allowed), `governance:write` (**Owner Only**) | Read-only for agents |
| **Model Inference** | `model:invoke:<registered-model-id>` | Denied until registered & enabled |
| **Network / External APIs** | `net:egress:<domain>` | Denied by default |
| **Deployment & Infrastructure** | `deploy:staging`, `deploy:production` | **Owner Approval Required** |
| **Financial & Billing** | `billing:read`, `billing:transact` | **Owner Approval Required** |
| **Publishing & Communications** | `publish:draft`, `publish:public` | Public publishing **Owner Approval Required** |
| **Secrets & Credentials** | `secrets:reference` (via env), `secrets:export` (**Prohibited**) | Never exposed in source or prompts |

---

## 4. Mandatory Owner Approval Gates (`L4` / Critical Actions)

The following actions **cannot** be auto-approved under any runtime profile and require explicit, recorded confirmation from the human owner:

1. **Production Deployments:** Any action affecting live environments, DNS, production databases, or release channels.
2. **Payments & Financial Actions:** Any monetary transfer, paid API tier activation, cloud resource purchase, or subscription change.
3. **Public Publishing:** Publishing packages, posts, emails, web pages, or repository commits to public destinations.
4. **Credential & Secret Access:** Reading, rotating, exporting, or referencing privileged authentication credentials or secrets.
5. **Policy & Constitution Changes:** Editing `TEJAURA_CONSTITUTION.md`, `PERMISSION_POLICY.md`, or governance locks in `system.json`.
6. **Privilege Grants:** Adding new scopes, raising an agent's autonomy level, or registering elevated external connectors.
7. **Destructive Operations:** Recursive deletion, overwriting non-draft data, or clearing audit history.

---

## 5. Approval Workflow Contract (Planned Runtime Behavior)

When a future runtime component encounters a gated action (`L3` or `L4`), it must execute the following sequence:

1. **Halt Execution:** Pause the workflow before any side effect occurs.
2. **Construct Approval Request:** Present a structured summary containing:
   - Requesting module/agent identifier
   - Exact action and target resource
   - Autonomy level (`L3` or `L4`)
   - Expected impact and reversibility
   - Scope duration (single-use by default)
3. **Present to Human Owner:** Deliver the request to the owner's mobile-first approval interface.
4. **Verify Non-Self-Approval:** Confirm the approval signature/token originates from an authenticated human owner session, distinct from the requesting agent context.
5. **Record Decision:** Log approval or rejection (with timestamp and reason) before proceeding or aborting.

---

## 6. Secrets & Credentials Handling

- Secrets and API keys must **never** appear in source code, `system.json`, `models.json`, logs, or Markdown docs.
- Credentials may only be referenced by environment variable name (e.g., `PROVIDER_API_KEY`) or local OS secret store key at runtime.
- Agents must never be granted raw read access to `.env` files or secret vaults for arbitrary inspection.
