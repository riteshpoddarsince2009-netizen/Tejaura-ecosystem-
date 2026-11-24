# Stage 4.6 — Real Isolated Execution, Department Agents & Multi-Agent Orchestration

> **Status:** Implemented and automated-test verified in this repository.
> **Scope:** Real container-isolated engineering execution, ten department agents,
> owner-gated delegation, AirLLM worker integration, and a mobile-first AI Workforce UI.
> **Security posture:** Agents remain limited to autonomy `L0`–`L3`. `L4` is
> owner-exclusive. Publishing, production deployment, privilege changes, and other
> high-impact actions always require a separate human-owner approval.

---

## 1. What Stage 4.6 Adds

| Capability | Implementation |
| --- | --- |
| Real OS isolation | `execution/container-sandbox-adapter.ts` + `execution/container-runner.mjs` |
| Department agents | `agents/agent-definitions.ts`, `agents/department-tools.ts` |
| Multi-agent delegation | `agents/delegation-engine.ts`, `agents/delegation-store.ts` |
| Durable delegation state | SQLite tables in `control-plane/db/migrations.ts` |
| Model worker integration | `agents/model-worker/*` using the existing `RuntimeManager` AirLLM contract |
| Policy, approval, audit | Existing `core/policy`, `core/approvals`, `core/audit` extended with `agent:plan` and sandbox/model actions |
| Owner API | `/api/stage46/*` in `control-plane/server/create-control-plane-app.ts` |
| Owner UI | `src/components/AIWorkforceView.tsx` (“AI Workforce” tab) |
| Tests | `agents/tests/stage46-*.test.ts`, `execution/tests/stage46-sandbox.test.ts`, `control-plane/tests/stage46-api.test.ts` |

Stage 4.6 does **not** introduce autonomous external actions. A content approval
authorizes a package for manual release; it does not auto-publish. There is no paid
third-party AI API fallback.

---

## 2. Architecture

```text
Owner (L4, authenticated session)
  |
  | POST /api/stage46/projects
  v
DelegationEngine
  |-- CEO Strategy Agent (executive, L2)
  |     plans objective -> validated delegation DAG
  |-- Engineering Agent
  |     -> AgentSandboxExecutor
  |        -> AgentExecutionEngine (persistent job, policy, approval, audit)
  |           -> ContainerSandboxAdapter
  |              -> Docker: node:22-alpine, non-root, no network, read-only rootfs
  |-- Design / SEO / Content / Analytics / Security / QA / Support / Research
  |     scoped tools, no shell, no privilege escalation
  |-- CEO consolidation task after all children are terminal
  v
SQLite delegation tables + task events + approvals + audit JSONL
```

### Delegation lifecycle

```text
CREATED -> VALIDATING -> QUEUED -> ASSIGNED -> RUNNING
                                   |            |
                                   |            +-> RETRYING -> RUNNING
                                   |            +-> WAITING_FOR_APPROVAL -> QUEUED
                                   |            +-> COMPLETED
                                   |            +-> FAILED
                                   +-> CANCELLED (owner, cascades to descendants)
```

The engine persists every transition. Startup recovery requeues interrupted
`ASSIGNED`/`RUNNING`/`RETRYING` tasks and fails tasks that exceed retry or recovery
limits. The watchdog creates alerts for stale work; it never marks a stale task as
successful.

---

## 3. Department Agents

Ten definitions live in `agents/agent-definitions.ts`. Each agent has a distinct
capability set, a closed action list, a scoped tool list, JSON input/output schemas
(shared task/result schemas plus specialized review and research schemas), autonomy
ceiling, retry and depth limits, and an explicit delegate allowlist.

| Agent | Department | Autonomy | Primary actions |
| --- | --- | --- | --- |
| CEO Strategy | executive | L2 | plan, delegate, consolidate |
| Engineering | engineering | L2 | sandboxed write/test, implement |
| Design | design | L1 | UI/UX specification |
| SEO | seo | L1 | keyword and metadata strategy |
| Content & Social | content | L1 | draft package, approval-gated publishing |
| Analytics | analytics | L1 | baseline report |
| Security | security | L1 | independent security review |
| QA Reviewer | quality_assurance | L1 | independent acceptance review |
| Customer Support | customer_support | L1 | support triage draft |
| Research | research | L1 | supplied-source research synthesis, gap analysis |

Security invariants enforced by validation:

- An agent cannot delegate to itself.
- An agent cannot delegate to an agent outside its allowlist.
- An agent cannot delegate an action outside the target agent's closed action list.
- Delegation input may not contain privilege fields such as `permissions`,
  `scopes`, `approval`, `autonomy`, or `role`.
- Depth and child counts are bounded per agent and per task.
- Every task is authorized by the policy evaluator and every outcome is audited.
- Only an authenticated human owner may create an objective, decide an approval,
  or cancel a task tree.

---

## 4. Real Container Isolation

`ContainerSandboxAdapter` invokes a small, fixed Node runner
(`execution/container-runner.mjs`) inside a Docker container. The runner is the only
code that touches the mounted workspace. It has no shell execution path.

### Container controls

| Control | Value |
| --- | --- |
| Runtime | Docker, image `node:22-alpine` by default |
| User | host service UID when non-root, otherwise `10001:10001` |
| Root filesystem | read-only |
| Capabilities | all dropped (`--cap-drop=ALL`) |
| Privilege escalation | `--security-opt=no-new-privileges` |
| Network | `--network=none` by default |
| Egress | fail closed; every container runs with `--network=none` |
| Memory | `256m` default |
| CPU | `0.5` default |
| PIDs | `64` default |
| Workspace | per-task host directory, absolute path, `0700`, removed after execution |
| File writes | confined to workspace; path traversal and absolute paths rejected |
| Shell | arbitrary commands rejected (`SHELL_EXECUTION_FORBIDDEN`) |
| Test command | exact allowlist (`node --test`, `python -m unittest`, `pytest`) |
| Output | bounded stdout/stderr and structured test evidence |
| Secrets | known secret values redacted from output and errors |

The adapter reports capabilities honestly. If Docker is unavailable it returns
`CONTAINER_RUNTIME_UNAVAILABLE`; it does not silently fall back to simulation.
In production, selecting `mock_sandbox_v1` throws at startup. There is no override.

### Docker access

The service account needs access to the Docker socket. Preferred options:

1. Add the service account to the `docker` group and restart the service.
2. Use a rootless Docker socket.
3. If neither is possible in a controlled development host, set
   `TEJAURA_CONTAINER_COMMAND="sudo -n docker"` with a narrowly scoped sudoers rule.

Do not mount the Docker socket into a container that also runs untrusted code.

### Verified behavior

Automated tests execute a real container and assert:

- The container hostname differs from the host.
- The process UID is non-zero.
- Network access is blocked.
- The root filesystem is read-only.
- Capabilities are dropped and `no-new-privileges` is set.
- `node --test` produces real test evidence with exit code `0`.
- Path traversal, arbitrary shell, and every network-egress request fail closed.

If Docker is unavailable, the container tests skip with an explicit reason; the
remaining suite still runs.

---

## 5. Approval and Audit Enforcement

Delegation tasks reuse the Stage 1 approval service. Sensitive actions create a
real approval record with `task_id = dtask_...`. The existing owner endpoint
`POST /api/approvals/:id/decide` routes those decisions to the delegation engine.

Enforced rules:

- Only a designated owner reviewer can approve or reject.
- Agents cannot approve their own or any other task.
- A reason is mandatory.
- Approval records are single-use.
- The approval decision is audited.
- Task execution is audited with actor, action, resource, outcome, and correlation ID.
- Approval-gated tasks resume only after a separate owner decision.
- A content approval sets `publication_status = approved_for_manual_publish` and
  keeps `external_publish_executed = false`.

The policy evaluator adds:

- `agent:plan` at `L1` with scope `agent:plan`
- `agent:research` at `L1` with scope `research:read`
- sandbox actions (`sandbox:execute`, `sandbox:write`)
- model actions (`model:invoke:local`, `model:discover:local`)

Agents remain capped at `L3`. `L4` actions are rejected for agent actors.

---

## 6. AirLLM Model Worker

`AirLlmModelWorker` wraps the existing `RuntimeManager` AirLLM adapter. It does not
invent a second protocol.

Configuration:

```bash
TEJAURA_AIRLLM_WORKER_URL="http://127.0.0.1:8010"
TEJAURA_AIRLLM_WORKER_TOKEN="<random internal token, >= 8 chars>"
```

Behavior:

- Health probes call `GET /internal/health` with the internal worker token.
- Inference calls `POST /internal/infer`.
- Output is marked `untrusted_model_output: true`.
- Worker output and errors are redacted against known secret values.
- If no AirLLM endpoint is configured, the model worker is `null` and the
  deterministic CEO planner is used. Planning still works; no paid API is called.
- Worker health is persisted as a heartbeat and surfaced in the UI.
- Unhealthy workers create a `WORKER_UNAVAILABLE` alert.

`ModelWorkerPool` bounds concurrent model calls. It is available for future
multi-worker routing and is covered by tests.

---

## 7. API

All routes require an authenticated owner session and CSRF protection.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/stage46/overview` | Agents, projects, metrics, tasks, events, alerts, workers, sandbox |
| `GET` | `/api/stage46/agents` | Ten definitions and persisted agent state |
| `GET` | `/api/stage46/metrics` | Queue metrics, alerts, worker heartbeats |
| `GET` | `/api/stage46/projects` | Recent objectives |
| `POST` | `/api/stage46/projects` | Create an owner objective |
| `GET` | `/api/stage46/projects/:id` | Project and its tasks |
| `GET` | `/api/stage46/tasks` | Filter tasks by project, agent, status |
| `GET` | `/api/stage46/tasks/:id` | Task, project, events, children |
| `POST` | `/api/stage46/tasks/:id/cancel` | Owner cancellation with reason, cascades |
| `POST` | `/api/stage46/queue/process` | Process ready tasks, refresh workers, run watchdog |
| `POST` | `/api/stage46/alerts/:id/ack` | Acknowledge an execution alert |
| `GET` | `/api/stage46/sandbox` | Selected provider and isolation capabilities |
| `POST` | `/api/approvals/:id/decide` | Existing owner approval endpoint; routes `dtask_` approvals |

`POST /api/stage46/projects` accepts `name`, `objective`, optional `context`,
`environment` (`sandbox`, `local`, `staging`), and optional `idempotency_key`.
`context.files` may supply up to 50 bounded workspace files and
`context.test_command` may select an allowlisted test command for engineering.
The HTTP JSON body limit is 64KB. Production objectives are rejected: production
actions require a separate approval-gated flow.

---

## 8. Database Tables

Stage 4.6 adds:

- `department_agent_state`
- `delegation_projects`
- `delegation_tasks` (includes the unique `idempotency_key` column)
- `delegation_task_events`
- `model_worker_heartbeats`
- `execution_alerts`

`system_config_kv` and `system_backups` come from Stage 4.5. All migrations are
additive and idempotent.

---

## 9. Tests

```bash
npm run lint
npm test
npm run build
```

Stage 4.6 tests:

- `agents/tests/stage46-delegation.test.ts`
  - ten distinct agents
  - end-to-end objective
  - approval gating and owner-only decision
  - self-approval rejection
  - idempotency
  - supplied-source research synthesis with no external collection
  - self-delegation, unknown action, and privilege-field rejection
  - system watchdog and recovery
- `agents/tests/stage46-model-worker.test.ts`
  - real `RuntimeManager` AirLLM contract against a mock worker
  - secret redaction
  - bounded worker pool concurrency
  - offline worker reporting
- `execution/tests/stage46-sandbox.test.ts`
  - real Docker probe and `node --test`
  - non-root, read-only, no-network, capability-dropped assertions
  - path traversal, shell, and egress fail-closed cases
- `execution/tests/stage46-executor-integration.test.ts`
  - delegation -> policy/audit -> execution engine -> real container, with real test evidence
- `control-plane/tests/stage46-api.test.ts`
  - production rejects simulated sandbox
  - owner APIs
  - objective creation
  - queue processing
  - approval decision routing
  - task detail events
  - cancellation
  - unauthenticated and CSRF rejection

---

## 10. Operational Notes and Limits

- Docker is a hard runtime dependency for real isolation. Without it, engineering
  tasks fail closed with `CONTAINER_RUNTIME_UNAVAILABLE`.
- The container image must contain the allowlisted test runner. `node:22-alpine`
  supports `node --test` but not `npm test` unless dependencies are installed in the
  mounted workspace.
- Allowlisted egress is not implemented. A Docker bridge with `HTTP_PROXY` is not an
  enforcement boundary, so requests for `allowlisted_endpoints` return
  `CONTAINER_NETWORK_ALLOWLIST_UNSUPPORTED` and containers always use `--network=none`.
- Engineering tasks may use owner-supplied `context.files` (maximum 50 files, subject
  to the 64KB request body limit) and `context.test_command` from the allowlist. The
  sandbox is for bounded test execution, not arbitrary long-running builds. Timeouts
  are capped.
- GPU inference remains dependent on the existing AirLLM worker and physical
  hardware verification. Stage 4.6 tests the worker contract, not GPU throughput.
- Stage 5 external integrations (real publishing, payments, production deploys)
  remain out of scope.
