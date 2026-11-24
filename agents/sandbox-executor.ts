import type { Agent, Tool } from '../contracts/types/index.ts';
import type { AgentExecutionEngine } from '../execution/index.ts';
import { getDepartmentAgentDefinition } from './agent-definitions.ts';
import { toContractAgent } from './agent-types.ts';
import { getAgentTools } from './department-tools.ts';
import type {
  DelegationSandboxExecutor,
  DelegationTaskRecord,
} from './delegation-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AgentSandboxExecutorOptions {
  executionEngine: AgentExecutionEngine;
  providerId: string;
  allowSimulatedProvider?: boolean;
  correlationId?: string;
}

export class AgentSandboxExecutor implements DelegationSandboxExecutor {
  private readonly executionEngine: AgentExecutionEngine;
  private readonly providerId: string;
  private readonly allowSimulatedProvider: boolean;
  private readonly correlationId: string;

  constructor(options: AgentSandboxExecutorOptions) {
    this.executionEngine = options.executionEngine;
    this.providerId = options.providerId;
    this.allowSimulatedProvider = options.allowSimulatedProvider === true;
    this.correlationId = options.correlationId ?? 'corr_stage46_sandbox';
  }

  private buildAgentAndTools(task: DelegationTaskRecord): {
    agent: Agent;
    tools: Tool[];
  } {
    const definition = getDepartmentAgentDefinition(task.agent_id);
    if (!definition) {
      throw new Error(`Unknown engineering agent "${task.agent_id}".`);
    }
    return {
      agent: toContractAgent(definition, task.created_at),
      tools: getAgentTools(definition.id, definition.allowed_tool_ids),
    };
  }

  async runEngineeringTask(params: {
    task: DelegationTaskRecord;
    agentId: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean };
  }> {
    const adapters = this.executionEngine.listAdapters();
    const adapter = adapters.find((item) => item.providerId === this.providerId);
    if (!adapter) {
      return {
        ok: false,
        error: {
          code: 'SANDBOX_PROVIDER_NOT_REGISTERED',
          message: `Sandbox provider "${this.providerId}" is not registered.`,
          retryable: false,
        },
      };
    }
    if (adapter.isolationLevel === 'mock_in_process' && !this.allowSimulatedProvider) {
      return {
        ok: false,
        error: {
          code: 'ISOLATED_SANDBOX_REQUIRED',
          message:
            'Engineering execution requires an OS-isolated container provider. The mock provider is disabled for this executor.',
          retryable: false,
        },
      };
    }

    const { agent, tools } = this.buildAgentAndTools(params.task);
    const files = Array.isArray(params.input.files)
      ? params.input.files
      : [];
    const testCommand =
      typeof params.input.test_command === 'string'
        ? params.input.test_command
        : 'node --test';
    const requestedAction = 'agent:test';

    const submit = this.executionEngine.submitExecution(
      {
        task_id: params.task.task_id,
        title: params.task.title,
        description: params.task.description,
        agent,
        tools,
        requested_action: requestedAction,
        resource_id: params.task.resource_id,
        environment: 'sandbox',
        declared_scopes: ['fs:read:workspace', 'fs:write:sandbox', 'exec:run:sandbox'],
        requested_paths: [],
        requested_network_mode: 'none',
        requested_browser_mode: 'disabled',
        sandbox_provider: this.providerId,
        idempotency_key: `${params.task.task_id}:engineering:${params.task.retry_count}`,
        idempotent_action: true,
        max_retries: 0,
        timeout_ms: params.task.timeout_ms,
        input: {
          sandbox_operation: 'run_tests',
          files,
          test_command: testCommand,
          code_workspace:
            typeof params.input.code_workspace === 'string'
              ? params.input.code_workspace
              : '',
        },
      },
      {
        initiator: {
          id: agent.id,
          type: 'agent',
          trusted_autonomy_level: agent.permitted_autonomy_level,
          trusted_authenticated: true,
          trusted_agent_record: agent,
        },
        correlation_id: params.task.correlation_id,
      },
    );

    if (!submit.ok) {
      return {
        ok: false,
        error: {
          code: submit.code,
          message: submit.error,
          retryable: false,
        },
      };
    }

    const outcome = await this.executionEngine.runJob(submit.job.job_id, {
      agent,
      tools,
      correlation_id: params.task.correlation_id,
    });
    if (!outcome.job) {
      return {
        ok: false,
        error: {
          code: 'SANDBOX_JOB_NOT_FOUND',
          message: 'Sandbox execution job was not found after submission.',
          retryable: true,
        },
      };
    }
    if (outcome.job.status !== 'completed') {
      return {
        ok: false,
        error: {
          code: outcome.job.error?.code ?? 'SANDBOX_JOB_FAILED',
          message: outcome.job.error?.message ?? 'Sandbox execution did not complete.',
          retryable: outcome.job.error?.retryable ?? true,
        },
      };
    }

    const result = outcome.job.result ?? {};
    const simulated = result.simulated === true || adapter.isolationLevel === 'mock_in_process';
    const rawTestEvidence = isRecord(result.test_evidence) ? result.test_evidence : null;
    if (rawTestEvidence?.executed === true && rawTestEvidence.test_failed === true) {
      return {
        ok: false,
        error: {
          code: 'SANDBOX_TEST_FAILED',
          message: `Allowlisted tests failed inside the sandbox (exit code ${String(rawTestEvidence.exit_code ?? 'unknown')}).`,
          retryable: true,
        },
      };
    }
    const testOutput = typeof rawTestEvidence?.output === 'string' ? rawTestEvidence.output : '';
    const noTestsRan =
      rawTestEvidence?.executed === true &&
      (/# tests 0\b/.test(testOutput) ||
        /# pass 0\b/.test(testOutput) ||
        /Ran 0 tests\b/.test(testOutput));
    if (noTestsRan) {
      return {
        ok: false,
        error: {
          code: 'SANDBOX_NO_TESTS_RAN',
          message: 'The allowlisted test command completed without running any tests.',
          retryable: true,
        },
      };
    }
    const testEvidence = {
      executed: simulated ? false : result.test_evidence !== undefined,
      simulated,
      command: testCommand,
      ...(typeof result.test_evidence === 'object' && result.test_evidence !== null
        ? result.test_evidence
        : {}),
      ...(simulated
        ? {
            reason:
              'Mock sandbox does not execute tests. QA must reject this as unverified.',
          }
        : {}),
    };
    return {
      ok: true,
      result: {
        ...result,
        sandbox_provider: this.providerId,
        isolation_level: adapter.isolationLevel,
        os_isolated: adapter.supportsOsIsolation,
        simulated,
        test_evidence: testEvidence,
        changed_files: Array.isArray(result.changed_files) ? result.changed_files : [],
      },
    };
  }

  async getCapabilities(): Promise<Record<string, unknown>> {
    const adapters = this.executionEngine.listAdapters();
    const selected = adapters.find((item) => item.providerId === this.providerId);
    const probe = selected as unknown as {
      getCapabilities?: () => Promise<Record<string, unknown>>;
    };
    const runtimeCapabilities =
      typeof probe.getCapabilities === 'function'
        ? await probe.getCapabilities()
        : null;
    return {
      selected_provider: this.providerId,
      selected_isolation_level: selected?.isolationLevel ?? null,
      os_isolated: selected?.supportsOsIsolation ?? false,
      available:
        selected?.isolationLevel === 'mock_in_process' ||
        runtimeCapabilities?.available === true,
      isolation_disclaimer: selected?.isolationDisclaimer ?? null,
      allow_simulated_provider: this.allowSimulatedProvider,
      runtime_capabilities: runtimeCapabilities,
      adapters,
    };
  }
}
