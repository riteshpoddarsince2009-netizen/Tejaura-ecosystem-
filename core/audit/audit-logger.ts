import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AuditEvent } from '../../contracts/types/index.ts';
import { validateAuditEvent } from '../../contracts/validation/index.ts';
import type {
  AuditLogInput,
  AuditLoggerOptions,
  AuditLogResult,
  AuditStorage,
  AuditStorageWriteResult,
} from './audit-types.ts';

const SECRET_KEY_PATTERN =
  /^(password|passphrase|secret|secret_?key|api_?key|access_?token|refresh_?token|bearer_?token|auth_?token|id_?token|session_?token|private_?key|client_?secret|credentials?|authorization|jwt|ssh_?key|encryption_?key|signing_?key)$/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^Bearer\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
];

const FORBIDDEN_PUBLIC_DIR_NAMES = new Set([
  'public',
  'dist',
  'build',
  'src',
  'static',
  'www',
]);

function containsRawSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeValue(
  value: unknown,
  redactedTracker: { count: number },
  visited = new Set<object>(),
  depth = 0,
): unknown {
  if (depth > 24) {
    return '[TRUNCATED_DEPTH]';
  }

  if (typeof value === 'string') {
    if (containsRawSecretValue(value)) {
      redactedTracker.count += 1;
      return '[REDACTED_SECRET]';
    }
    return value;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (visited.has(value)) {
    return '[CIRCULAR_REFERENCE]';
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeValue(item, redactedTracker, visited, depth + 1),
    );
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      redactedTracker.count += 1;
      continue;
    }
    sanitized[key] = sanitizeValue(nested, redactedTracker, visited, depth + 1);
  }

  return sanitized;
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
  correlationId: string,
): Record<string, unknown> {
  const tracker = { count: 0 };
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (sanitizeValue(metadata, tracker) as Record<string, unknown>)
      : {};

  const result: Record<string, unknown> = {
    ...base,
    correlation_id: correlationId,
  };

  if (tracker.count > 0) {
    result.secrets_redacted = true;
  }

  return result;
}

export class InMemoryAuditStorage implements AuditStorage {
  private readonly lines: string[] = [];

  appendLine(jsonLine: string): AuditStorageWriteResult {
    if (typeof jsonLine !== 'string' || jsonLine.trim().length === 0) {
      return { ok: false, error: 'Audit line must be a non-empty string.' };
    }
    this.lines.push(jsonLine);
    return { ok: true };
  }

  getLines(): readonly string[] {
    return [...this.lines];
  }

  getEvents(): AuditEvent[] {
    return this.lines.map((line) => JSON.parse(line) as AuditEvent);
  }
}

export interface JsonlAuditStorageOptions {
  auditDir: string;
  fileName?: string;
}

/**
 * Local append-only JSONL audit storage.
 *
 * SECURITY LIMITATION: Local JSONL files are append-only by application
 * convention (`O_APPEND` / flag `'a'`) and restricted permissions (`0600`),
 * NOT cryptographically tamper-proof against a privileged local host user.
 */
export class JsonlAuditStorage implements AuditStorage {
  private readonly resolvedDir: string;
  private readonly resolvedFilePath: string;
  private readonly initError: string | null;

  constructor(options: JsonlAuditStorageOptions) {
    const fileName = options.fileName ?? 'audit.jsonl';

    if (
      typeof options.auditDir !== 'string' ||
      options.auditDir.trim().length === 0
    ) {
      this.resolvedDir = '';
      this.resolvedFilePath = '';
      this.initError = 'Audit directory path must be a non-empty string.';
      return;
    }

    if (
      typeof fileName !== 'string' ||
      fileName.includes('\0') ||
      fileName.includes('..') ||
      path.basename(fileName) !== fileName ||
      !fileName.endsWith('.jsonl')
    ) {
      this.resolvedDir = '';
      this.resolvedFilePath = '';
      this.initError =
        'Audit file name must be a plain .jsonl filename without directory segments.';
      return;
    }

    const resolvedDir = path.resolve(options.auditDir);
    const segments = resolvedDir
      .split(path.sep)
      .map((segment) => segment.toLowerCase())
      .filter(Boolean);

    if (
      segments.some((segment) => FORBIDDEN_PUBLIC_DIR_NAMES.has(segment)) ||
      fs.existsSync(path.join(resolvedDir, 'index.html'))
    ) {
      this.resolvedDir = '';
      this.resolvedFilePath = '';
      this.initError =
        'Refusing to store audit logs inside a public or web-served directory.';
      return;
    }

    const resolvedFilePath = path.resolve(resolvedDir, fileName);
    const relative = path.relative(resolvedDir, resolvedFilePath);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative !== fileName
    ) {
      this.resolvedDir = '';
      this.resolvedFilePath = '';
      this.initError = 'Audit file path escaped the configured audit directory.';
      return;
    }

    this.resolvedDir = resolvedDir;
    this.resolvedFilePath = resolvedFilePath;
    this.initError = null;
  }

  getFilePath(): string {
    return this.resolvedFilePath;
  }

  appendLine(jsonLine: string): AuditStorageWriteResult {
    if (this.initError) {
      return { ok: false, error: this.initError };
    }

    if (
      typeof jsonLine !== 'string' ||
      jsonLine.trim().length === 0 ||
      jsonLine.includes('\n') ||
      jsonLine.includes('\r')
    ) {
      return {
        ok: false,
        error: 'Audit line must be a single non-empty JSON line.',
      };
    }

    try {
      fs.mkdirSync(this.resolvedDir, { recursive: true, mode: 0o700 });

      const realDir = fs.realpathSync(this.resolvedDir);
      if (realDir !== this.resolvedDir) {
        return {
          ok: false,
          error: 'Audit directory must not resolve through a symlink.',
        };
      }

      if (fs.existsSync(this.resolvedFilePath)) {
        const stat = fs.lstatSync(this.resolvedFilePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          return {
            ok: false,
            error: 'Audit target must be a regular file, not a symlink.',
          };
        }
      }

      fs.appendFileSync(this.resolvedFilePath, `${jsonLine}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600,
      });

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? `Failed to append audit event: ${err.message}`
            : 'Failed to append audit event.',
      };
    }
  }
}

export class AuditLogger {
  private readonly storage: AuditStorage;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: AuditLoggerOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator =
      options.idGenerator ?? (() => `evt_${crypto.randomUUID()}`);
  }

  logEvent(input: AuditLogInput): AuditLogResult {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: 'Audit log input must be an object.' };
    }

    if (
      typeof input.correlation_id !== 'string' ||
      input.correlation_id.trim().length < 2
    ) {
      return {
        ok: false,
        error: 'Audit log entry requires a valid correlation_id.',
      };
    }

    let timestamp: string;
    try {
      timestamp = this.clock().toISOString();
    } catch {
      return { ok: false, error: 'Audit logger clock failed.' };
    }

    const eventCandidate: AuditEvent = {
      id: this.idGenerator(),
      timestamp,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      event_type: input.event_type,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      action: input.action,
      outcome: input.outcome,
      approval_id: input.approval_id ?? null,
      metadata: sanitizeAuditMetadata(input.metadata, input.correlation_id),
      schema_version: '1.0.0',
    };

    const validation = validateAuditEvent(eventCandidate);
    if (!validation.valid) {
      return {
        ok: false,
        error: validation.errors.map((e) => e.message).join('; '),
      };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(validation.data);
    } catch {
      return { ok: false, error: 'Failed to serialize audit event.' };
    }

    const writeResult = this.storage.appendLine(serialized);
    if (!writeResult.ok) {
      return { ok: false, error: writeResult.error };
    }

    return { ok: true, event: validation.data };
  }

  logPolicyDecision(params: {
    actor_type: AuditEvent['actor_type'];
    actor_id: string;
    resource_type: AuditEvent['resource_type'];
    resource_id: string;
    action: string;
    decision: 'allow' | 'deny' | 'require_approval';
    reason_code: string;
    correlation_id: string;
    approval_id?: string | null;
    metadata?: Record<string, unknown>;
  }): AuditLogResult {
    const outcome: AuditEvent['outcome'] =
      params.decision === 'allow'
        ? 'success'
        : params.decision === 'require_approval'
          ? 'pending'
          : 'denied';

    return this.logEvent({
      actor_type: params.actor_type,
      actor_id: params.actor_id,
      event_type: `policy.${params.decision}`,
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      action: params.action,
      outcome,
      correlation_id: params.correlation_id,
      approval_id: params.approval_id ?? null,
      metadata: {
        ...params.metadata,
        reason_code: params.reason_code,
        decision: params.decision,
      },
    });
  }

  logApprovalRequest(params: {
    actor_id: string;
    approval_id: string;
    task_id: string;
    action: string;
    outcome: AuditEvent['outcome'];
    correlation_id: string;
    metadata?: Record<string, unknown>;
  }): AuditLogResult {
    return this.logEvent({
      actor_type: 'agent',
      actor_id: params.actor_id,
      event_type: 'approval.requested',
      resource_type: 'approval',
      resource_id: params.approval_id,
      action: params.action,
      outcome: params.outcome,
      correlation_id: params.correlation_id,
      approval_id: params.approval_id,
      metadata: {
        ...params.metadata,
        task_id: params.task_id,
      },
    });
  }

  logApprovalDecision(params: {
    actor_type: AuditEvent['actor_type'];
    actor_id: string;
    approval_id: string;
    action: string;
    outcome: AuditEvent['outcome'];
    correlation_id: string;
    metadata?: Record<string, unknown>;
  }): AuditLogResult {
    return this.logEvent({
      actor_type: params.actor_type,
      actor_id: params.actor_id,
      event_type: 'approval.decided',
      resource_type: 'approval',
      resource_id: params.approval_id,
      action: params.action,
      outcome: params.outcome,
      correlation_id: params.correlation_id,
      approval_id: params.approval_id,
      metadata: params.metadata,
    });
  }

  logFailure(params: {
    actor_type: AuditEvent['actor_type'];
    actor_id: string;
    resource_type: AuditEvent['resource_type'];
    resource_id: string;
    action: string;
    error_code: string;
    correlation_id: string;
    approval_id?: string | null;
    metadata?: Record<string, unknown>;
  }): AuditLogResult {
    return this.logEvent({
      actor_type: params.actor_type,
      actor_id: params.actor_id,
      event_type: 'system.failure',
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      action: params.action,
      outcome: 'failure',
      correlation_id: params.correlation_id,
      approval_id: params.approval_id ?? null,
      metadata: {
        ...params.metadata,
        error_code: params.error_code,
      },
    });
  }
}
