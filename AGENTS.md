# AGENTS.md — Repository Knowledge

## Project

TEJAURA is a human-governed, modular AI operating system. The owner retains `L4`
authority; agents are capped at `L3`; sensitive actions require explicit owner
approval. No paid third-party AI APIs are allowed.

## Commands

- Install: `npm install`
- Typecheck: `npx tsc --noEmit`
- Full tests: `npm test` (Node test runner via `tsx --test`; includes `agents/tests/*.test.ts`, `control-plane/tests/*.test.ts`, `execution/tests/*.test.ts`)
- Single test: `npx tsx --test path/to/file.test.ts`
- Build: `npm run build`
- Lint: `npm run lint`

Full tests take ~18–20s when Docker is available. Container tests add ~6s each.

## Layout

- `core/` — policy, approvals, audit, RBAC, identity, secrets
- `contracts/` — JSON Schemas and TypeScript contracts
- `intelligence/` — local model registry, runtime adapters, AirLLM worker protocol
- `execution/` — agent execution engine, sandbox policy, mock and container sandbox adapters
- `agents/` — Stage 4.6 department agents, delegation engine/store, sandbox executor, model worker
- `control-plane/` — SQLite store, orchestrator, Express API, management services
- `src/` — mobile-first React control plane UI
- `workers/airllm/` — Python AirLLM worker

## Conventions

- TypeScript ESM with explicit `.ts` import extensions.
- Fail closed: unknown providers, missing approvals, invalid input, or audit failures must deny.
- Never add a paid API fallback. AirLLM is the primary local runtime.
- All owner-facing mutations require authenticated owner session plus `X-TEJAURA-CSRF: 1`.
- Use prepared SQL statements; migrations are additive and idempotent.
- Tests use real code paths. Avoid mocks except for external model workers/protocol fixtures.
- UI uses Tailwind classes and the dark slate/indigo palette in `src/components/`.

## Stage 4.6 Notes

- Real isolation: `execution/container-sandbox-adapter.ts` + `execution/container-runner.mjs`.
  Container runs non-root (host UID, or `10001` if the service is root), read-only rootfs,
  all caps dropped, `no-new-privileges`, `--network=none`, PID/memory/CPU limits.
- Docker access: `docker` if the service user is in the `docker` group, otherwise
  `TEJAURA_CONTAINER_COMMAND="sudo -n docker"` in controlled dev hosts. In the
  current workspace the service user is not in the `docker` group, so container
  tests use the `sudo -n docker` fallback.
- Engineering tasks accept owner-supplied `context.files` (max 50 files, within the
  64KB JSON body limit) and `context.test_command` from the allowlist. Empty test
  runs (`# tests 0`, `# pass 0`, `Ran 0 tests`) are rejected as insufficient evidence.
- Production rejects `mock_sandbox_v1` at app startup. Development defaults to mock.
- Delegation tasks persist in `delegation_*` SQLite tables. Approval records use
  `task_id = dtask_...`; `/api/approvals/:id/decide` routes them back to the engine.
- Agents cannot delegate to themselves, outside their allowlist, outside the target's
  action list, or inject privilege fields. Delegation dependency cycles are rejected.
- Content approval only marks a package `approved_for_manual_publish`; it never
  auto-publishes. Agent-generated approval requests are checked against the policy
  catalog, environment, required scope, and a per-agent approval action allowlist.
- The ten department agents include a bounded `research` agent that uses only
  supplied sources and reports evidence gaps; it performs no external collection.
- UI entry point: `src/components/AIWorkforceView.tsx` under the `workforce` tab.

## Verification Checklist

1. `npx tsc --noEmit`
2. `npm test`
3. `npm run build`
4. If Docker is available, confirm `execution/tests/stage46-sandbox.test.ts` and
   `execution/tests/stage46-executor-integration.test.ts` actually ran (not skipped).
