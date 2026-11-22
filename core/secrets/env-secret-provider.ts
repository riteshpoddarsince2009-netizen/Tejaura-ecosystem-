import { AIRLLM_WORKER_TOKEN_ENV_VAR } from './secret-types.ts';

/**
 * Reads only explicitly allowlisted environment variables. Secret values are
 * never copied into configuration files, logs, or frontend bundles.
 */
export class EnvSecretProvider {
  private readonly env: Record<string, string | undefined>;
  private readonly allowlist: ReadonlySet<string>;

  constructor(options?: {
    env?: Record<string, string | undefined>;
    allowlist?: readonly string[];
  }) {
    this.env = options?.env ?? process.env;
    this.allowlist = new Set(
      options?.allowlist ?? [AIRLLM_WORKER_TOKEN_ENV_VAR],
    );
  }

  get(key: string): string | null {
    if (!this.isAllowed(key)) {
      return null;
    }
    const value = this.env[key];
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  private isAllowed(key: string): boolean {
    if (this.allowlist.size === 0) {
      return true;
    }
    return this.allowlist.has(key);
  }
}
