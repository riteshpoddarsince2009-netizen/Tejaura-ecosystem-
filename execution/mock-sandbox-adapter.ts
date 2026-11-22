import type { ModelRouter } from '../intelligence/router/index.ts';
import type {
  SandboxAdapter,
  SandboxAdapterOutcome,
  SandboxExecutionContext,
} from './execution-types.ts';
import { redactAgentError, redactSensitiveValue } from './secret-redactor.ts';

export type MockSandboxStepHandler = (
  context: SandboxExecutionContext,
  signal: AbortSignal,
) => Promise<SandboxAdapterOutcome>;

export interface MockSandboxAdapterOptions {
  router?: ModelRouter;
  systemConfig?: unknown;
  stepHandlers?: Record<string, MockSandboxStepHandler>;
  knownSecretValues?: readonly string[];
}

/**
 * Development & Automated-Test Mock Sandbox Adapter.
 *
 * SECURITY BOUNDARY NOTICE:
 * This adapter executes simulated agent workflows IN-PROCESS without OS-level
 * container, cgroup, chroot, seccomp, or network namespace isolation.
 * It NEVER invokes `child_process` (`exec`/`spawn`) or evaluates untrusted
 * dynamic code (`eval`/`Function`).
 *
 * Production deployments requiring isolated code or filesystem execution MUST
 * pair this interface with an `isolated_container` SandboxAdapter implementation.
 */
export class MockSandboxAdapter implements SandboxAdapter {
  readonly providerId = 'mock_sandbox_v1';
  readonly isolationLevel = 'mock_in_process' as const;
  readonly supportsOsIsolation = false;
  readonly isolationDisclaimer =
    'Mock sandbox executes bounded simulations in-process for dev/test only and does NOT provide OS-level container isolation.';

  private readonly handlers = new Map<string, MockSandboxStepHandler>();
  private readonly router?: ModelRouter;
  private readonly knownSecrets: readonly string[];

  constructor(options: MockSandboxAdapterOptions = {}) {
    this.router = options.router;
    this.knownSecrets = options.knownSecretValues ?? [];
    if (options.stepHandlers) {
      for (const [key, fn] of Object.entries(options.stepHandlers)) {
        this.handlers.set(key, fn);
      }
    }
  }

  registerStepHandler(key: string, handler: MockSandboxStepHandler): void {
    this.handlers.set(key, handler);
  }

  async execute(
    context: SandboxExecutionContext,
    signal: AbortSignal,
  ): Promise<SandboxAdapterOutcome> {
    if (signal.aborted) {
      return {
        ok: false,
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Sandbox job was aborted before execution started.',
          retryable: false,
        },
      };
    }

    const customHandler =
      this.handlers.get(`${context.agent.department}:${context.job.requested_action}`) ??
      this.handlers.get(context.job.requested_action) ??
      this.handlers.get(context.agent.id);

    try {
      let outcome: SandboxAdapterOutcome;

      if (customHandler) {
        outcome = await customHandler(context, signal);
      } else if (
        this.router &&
        context.job.input.use_local_model === true &&
        typeof context.job.input.prompt === 'string'
      ) {
        const routingCheck = this.router.route({
          task_id: context.job.task_id,
          required_capabilities: ['chat'],
          min_context_length: 512,
          preferred_model_id: context.agent.preferred_model_ids[0],
          priority: 'normal',
          allow_queue: true,
        });

        if (
          (routingCheck.decision !== 'routed' &&
            routingCheck.decision !== 'queued') ||
          !routingCheck.selected_model
        ) {
          outcome = {
            ok: false,
            error: {
              code: routingCheck.code ?? 'LOCAL_MODEL_ROUTING_FAILED',
              message: routingCheck.reason,
              retryable: false,
            },
          };
        } else {
          outcome = {
            ok: true,
            result: {
              sandbox_provider: this.providerId,
              os_isolated: false,
              isolation_disclaimer: this.isolationDisclaimer,
              agent_id: context.agent.id,
              department: context.agent.department,
              action: context.job.requested_action,
              tools_invoked: context.tools.map((t) => t.id),
              routed_model_id: routingCheck.selected_model.model_id,
              routed_runtime: routingCheck.selected_model.runtime_type,
              paid_api_fallback_used: false,
              untrusted_model_output: true,
              simulated: true,
              summary: `Simulated ${context.agent.department} execution routed via ${routingCheck.selected_model.runtime_type}.`,
            },
          };
        }
      } else {
        outcome = {
          ok: true,
          result: {
            sandbox_provider: this.providerId,
            os_isolated: false,
            isolation_disclaimer: this.isolationDisclaimer,
            agent_id: context.agent.id,
            department: context.agent.department,
            role: context.agent.role,
            action: context.job.requested_action,
            resource_id: context.job.resource_id,
            environment: context.job.environment,
            tools_invoked: context.tools.map((t) => t.id),
            allowed_paths: context.allowed_paths,
            network_mode: context.network_mode,
            browser_mode: context.browser_mode,
            paid_api_fallback_used: false,
            simulated: true,
            output: {
              status: 'completed',
              note: `Simulated bounded ${context.agent.department} execution for "${context.job.requested_action}".`,
              echo_input: context.job.input,
            },
          },
        };
      }

      if (signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'EXECUTION_ABORTED',
            message:
              signal.reason instanceof Error
                ? signal.reason.message
                : 'Sandbox execution was aborted or timed out.',
            retryable: false,
          },
        };
      }

      if (outcome.ok) {
        const redacted = redactSensitiveValue(outcome.result, this.knownSecrets);
        const wasRedacted =
          outcome.secrets_redacted === true || redacted.redactedCount > 0;
        return {
          ok: true,
          result: {
            ...(redacted.value as Record<string, unknown>),
            secrets_redacted: wasRedacted,
          },
          secrets_redacted: wasRedacted,
        };
      }

      const redactedErr = redactAgentError(outcome.error, this.knownSecrets);
      return {
        ok: false,
        error: redactedErr.value,
        secrets_redacted:
          outcome.secrets_redacted === true || redactedErr.redactedCount > 0,
      };
    } catch (err) {
      const rawMessage =
        err instanceof Error ? err.message : 'Mock sandbox execution threw an unexpected error.';
      const redactedErr = redactAgentError(
        {
          code: signal.aborted ? 'EXECUTION_TIMEOUT' : 'SANDBOX_RUNTIME_ERROR',
          message: rawMessage,
          retryable: !signal.aborted,
        },
        this.knownSecrets,
      );
      return {
        ok: false,
        error: redactedErr.value,
        secrets_redacted: redactedErr.redactedCount > 0,
      };
    }
  }
}
