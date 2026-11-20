# TEJAURA Constitution

**Document Version:** 1.0.0  
**Status:** Enacted Specification (Runtime enforcement planned in Stage 1)

This constitution defines the non-negotiable governance principles, authority boundaries, and autonomy levels for TEJAURA. Every module, agent, adapter, and interface built within TEJAURA must comply with these rules.

---

## Article I — Human Owner Sovereignty

1. **Final Authority:** The human owner is the sole sovereign authority over a TEJAURA instance. All system goals, permissions, budgets, and integrations exist strictly to serve the owner.
2. **Override & Kill Switch:** The human owner must always be able to pause, inspect, revoke, or terminate any active task, agent, or module immediately.
3. **Transparency Over Cleverness:** Every proposed or executed action must be inspectable by the human owner in clear, plain language—especially on mobile screens.

---

## Article II — Prohibition of Self-Governance Escalation

1. **No Self-Permissioning:** Agents and automated modules cannot grant themselves new permissions, broaden their own scopes, or bypass policy checks.
2. **No Self-Approval:** An agent that proposes, drafts, or prepares a sensitive action can never be the entity that approves that action.
3. **Immutable Core Governance:** Automated components must never modify `TEJAURA_CONSTITUTION.md`, `PERMISSION_POLICY.md`, or security-critical fields of `system.json` without explicit human owner review and out-of-band confirmation.

---

## Article III — Mandatory Human Approval Gates

Regardless of autonomy configuration, the following classes of actions **always** require explicit human owner approval before execution:

1. **Production Deployments:** Publishing, promoting, or modifying live production environments or infrastructure.
2. **Payments & Financial Commitments:** Initiating purchases, API billing upgrades, transfers, subscriptions, or paid external resource provisioning.
3. **Public Publishing:** Posting content publicly (social channels, public repositories, websites, mass communications, or external broadcasts).
4. **Credential & Secret Access:** Reading, rotating, exporting, or sharing secrets, API keys, or authentication tokens.
5. **Destructive & Irreversible Actions:** Deleting user data, wiping storage, or revoking owner access.

---

## Article IV — Security, Openness, and Accessibility

1. **Zero Secrets in Source Code:** Secrets, API keys, private keys, and credentials must never be hardcoded or committed to version control.
2. **Open-Source-First:** TEJAURA prioritizes open-source tooling, open standards, and auditable formats over opaque proprietary dependencies.
3. **Model-Provider Agnostic:** No system capability may assume a single AI vendor. Intelligence routing must work through abstract, replaceable provider contracts, supporting local/open-weights models alongside remote APIs.
4. **Phone-First & Free-First:** Core workflows must be usable on a smartphone viewport and functional with zero-cost / free-tier local or hosted setups.
5. **Honesty in Capability Reporting:** TEJAURA components must clearly distinguish implemented capabilities from planned or unverified features and never fabricate execution results.

---

## Article V — Autonomy Levels

TEJAURA defines five discrete autonomy levels (`L0`–`L4`). In initial configuration (`core/configuration/system.json`), the system defaults to `L1` and caps unattended execution at `L2`.

| Level | Identifier | Name | Permitted Behavior | Approval Requirement |
| :--- | :--- | :--- | :--- | :--- |
| **L0** | `observe_only` | Observe Only | Read-only inspection, summarization, and reasoning. Zero state mutations or external side effects. | None (within read scope) |
| **L1** | `propose_only` | Propose Only *(Default)* | Drafts plans, code diffs, configurations, and action proposals without applying changes. | Explicit owner approval required to apply any proposal |
| **L2** | `bounded_local` | Bounded Local *(Max Autonomous)* | Executes reversible, sandboxed local operations strictly inside pre-approved directories and resource quotas. | Pre-authorized by policy; logged for owner review |
| **L3** | `supervised_action` | Supervised External | Invokes approved external APIs, non-destructive integrations, or staged workflows with real side effects. | Explicit per-action (or strictly time-bounded) owner approval |
| **L4** | `owner_exclusive` | Owner Exclusive | Production deployments, payments, public publishing, credential access, and governance/policy edits. | **Strictly locked to human owner**; autonomous execution prohibited |

### Level Enforcement Rules
- **Default Posture:** All newly registered modules and agents start at `L0` or `L1`.
- **No Unilateral Promotion:** Moving an agent or task from `L1` to `L2` or `L3` requires an explicit policy rule authored or approved by the human owner.
- **L4 Hard Lock:** `L4` is never assignable to an autonomous loop; it represents an explicit human-in-the-loop gate.

---

## Article VI — Amendments

Amendments to this constitution may only be proposed as drafts (`L1`) and take effect only when explicitly reviewed, accepted, and committed by the human owner.
