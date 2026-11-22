import type { AgentExecutionError } from '../control-plane/db/index.ts';

const SECRET_KEY_PATTERN =
  /(^|[_.-])(password|passphrase|secret|secret_?key|api_?key|apikey|access_?token|refresh_?token|bearer_?token|auth_?token|id_?token|session_?token|worker_?token|private_?key|client_?secret|credentials?|authorization|jwt|ssh_?key|encryption_?key|signing_?key|master_?key|recovery_?code)$/i;

const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END\s+[A-Z0-9 ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\b(?:TEJAURA_SECRETS_MASTER_KEY|TEJAURA_AIRLLM_WORKER_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*[^\s,'";]+/gi,
  /\b(?:password|passphrase|secret|api_key|apikey|access_token|refresh_token|auth_token|private_key|client_secret)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi,
];

export interface RedactionResult<T> {
  value: T;
  redactedCount: number;
}

export function redactSensitiveText(
  input: string,
  knownSecrets: readonly string[] = [],
): RedactionResult<string> {
  let output = input;
  let redactedCount = 0;

  for (const pattern of INLINE_SECRET_PATTERNS) {
    const flags = pattern.flags.includes('g')
      ? pattern.flags
      : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    output = output.replace(re, () => {
      redactedCount += 1;
      return '[REDACTED_SECRET]';
    });
  }

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < 8) {
      continue;
    }
    if (output.includes(secret)) {
      const parts = output.split(secret);
      redactedCount += parts.length - 1;
      output = parts.join('[REDACTED_SECRET]');
    }
  }

  return { value: output, redactedCount };
}

export function redactSensitiveValue(
  input: unknown,
  knownSecrets: readonly string[] = [],
  visited = new Set<object>(),
  depth = 0,
): RedactionResult<unknown> {
  if (depth > 24) {
    return { value: '[TRUNCATED_DEPTH]', redactedCount: 0 };
  }

  if (typeof input === 'string') {
    return redactSensitiveText(input, knownSecrets);
  }

  if (input === null || typeof input !== 'object') {
    return { value: input, redactedCount: 0 };
  }

  if (visited.has(input)) {
    return { value: '[CIRCULAR_REFERENCE]', redactedCount: 0 };
  }
  visited.add(input);

  let totalRedacted = 0;

  if (Array.isArray(input)) {
    const mapped = input.map((item) => {
      const itemRes = redactSensitiveValue(
        item,
        knownSecrets,
        visited,
        depth + 1,
      );
      totalRedacted += itemRes.redactedCount;
      return itemRes.value;
    });
    return { value: mapped, redactedCount: totalRedacted };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (
      SECRET_KEY_PATTERN.test(key) ||
      key.toUpperCase() === 'TEJAURA_SECRETS_MASTER_KEY' ||
      key.toUpperCase() === 'TEJAURA_AIRLLM_WORKER_TOKEN'
    ) {
      totalRedacted += 1;
      out[key] = '[REDACTED_SECRET]';
      continue;
    }
    const nested = redactSensitiveValue(val, knownSecrets, visited, depth + 1);
    totalRedacted += nested.redactedCount;
    out[key] = nested.value;
  }

  return { value: out, redactedCount: totalRedacted };
}

export function redactAgentError(
  error: AgentExecutionError,
  knownSecrets: readonly string[] = [],
): RedactionResult<AgentExecutionError> {
  const msgRes = redactSensitiveText(error.message, knownSecrets);
  return {
    value: {
      code: error.code,
      message: msgRes.value,
      retryable: error.retryable,
    },
    redactedCount: msgRes.redactedCount,
  };
}
