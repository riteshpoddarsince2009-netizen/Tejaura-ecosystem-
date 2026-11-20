# TEJAURA Approval Gatekeeper

Implements the human-owner approval state machine (`core/approvals/approval-service.ts`) with strict non-self-approval, environment binding, expiration, and single-use enforcement.

---

## State Machine

```text
pending ──▶ approved  (authenticated designated human owner only)
pending ──▶ rejected  (authenticated designated human owner only)
pending ──▶ expired   (deadline elapsed or explicit expiration)
```

All terminal states (`approved`, `rejected`, `expired`) are immutable. Any transition out of a terminal state fails closed with `INVALID_STATE_TRANSITION`.

---

## Trust Boundary & Authentication

- TEJAURA Stage 1 does **not** implement a login or identity provider.
- `decideApproval` requires an externally authenticated `TrustedReviewerContext` (`authenticated: true`, `actor_type: 'owner'`, `actor_id === designatedOwnerId`, non-empty `auth_source`).
- An `ApprovalRecord` is **never** proof of identity; callers must verify caller authentication externally before trusting a reviewer context.
- Agents, unauthenticated callers, non-designated actors, and the original `requested_by` actor can **never** approve or reject a request (`SELF_APPROVAL_FORBIDDEN`, `AGENT_APPROVAL_FORBIDDEN`).

---

## Binding & Single-Use Guarantees

- Every approval binds to exact `task_id`, `action`, `environment`, `scope.resources`, `scope.permissions`, `scope.single_use`, and `scope.expires_at`.
- `verifyAndConsumeApproval` rejects mismatched tasks, actions, environments, resources, or scopes, rejects expired approvals using the injected clock, and marks `single_use: true` records with `consumed_at` so replay attempts fail with `SINGLE_USE_ALREADY_CONSUMED`.
