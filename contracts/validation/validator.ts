import Ajv2020Module from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

import agentSchema from '../schemas/agent.schema.json' with { type: 'json' };
import approvalSchema from '../schemas/approval.schema.json' with { type: 'json' };
import auditEventSchema from '../schemas/audit-event.schema.json' with { type: 'json' };
import taskSchema from '../schemas/task.schema.json' with { type: 'json' };
import toolSchema from '../schemas/tool.schema.json' with { type: 'json' };

import type {
  Agent,
  Approval,
  AuditEvent,
  ContractKind,
  Task,
  Tool,
} from '../types/index.ts';

type Ajv2020Constructor = typeof Ajv2020Module;
type AddFormatsFn = typeof addFormatsModule;

const Ajv2020 =
  (Ajv2020Module as unknown as { default?: Ajv2020Constructor }).default ??
  Ajv2020Module;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  addFormatsModule;

export interface ContractMap {
  task: Task;
  agent: Agent;
  tool: Tool;
  approval: Approval;
  audit_event: AuditEvent;
}

export interface ContractValidationError {
  path: string;
  keyword: string;
  message: string;
  schema_path?: string;
}

export type ValidationResult<T> =
  | {
      valid: true;
      data: T;
      errors: [];
    }
  | {
      valid: false;
      data: null;
      errors: ContractValidationError[];
    };

export type ContractSchemas = Record<ContractKind, AnySchema>;

export interface ContractValidator {
  validateTask: (input: unknown) => ValidationResult<Task>;
  validateAgent: (input: unknown) => ValidationResult<Agent>;
  validateTool: (input: unknown) => ValidationResult<Tool>;
  validateApproval: (input: unknown) => ValidationResult<Approval>;
  validateAuditEvent: (input: unknown) => ValidationResult<AuditEvent>;
  validateContract: <K extends ContractKind>(
    kind: K,
    input: unknown,
  ) => ValidationResult<ContractMap[K]>;
  parseAndValidateContract: <K extends ContractKind>(
    kind: K,
    rawJson: string,
  ) => ValidationResult<ContractMap[K]>;
}

const DEFAULT_SCHEMAS: ContractSchemas = {
  task: taskSchema,
  agent: agentSchema,
  tool: toolSchema,
  approval: approvalSchema,
  audit_event: auditEventSchema,
};

function formatAjvErrors(
  errors: ErrorObject[] | null | undefined,
): ContractValidationError[] {
  if (!errors || errors.length === 0) {
    return [
      {
        path: '$',
        keyword: 'validation_failed',
        message: 'Contract validation failed.',
      },
    ];
  }

  return errors.map((err) => {
    const instancePath = err.instancePath ? `$${err.instancePath}` : '$';
    let message = err.message ?? 'Invalid value';

    if (
      err.keyword === 'additionalProperties' &&
      typeof err.params?.additionalProperty === 'string'
    ) {
      message = `Unexpected property "${err.params.additionalProperty}" is not allowed`;
    } else if (
      err.keyword === 'required' &&
      typeof err.params?.missingProperty === 'string'
    ) {
      message = `Missing required property "${err.params.missingProperty}"`;
    }

    return {
      path: instancePath,
      keyword: err.keyword,
      message,
      schema_path: err.schemaPath,
    };
  });
}

function failClosed<T>(
  path: string,
  keyword: string,
  message: string,
): ValidationResult<T> {
  return {
    valid: false,
    data: null,
    errors: [{ path, keyword, message }],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SECRET_KEY_PATTERN =
  /^(password|passphrase|secret|secret_?key|api_?key|access_?token|refresh_?token|bearer_?token|auth_?token|id_?token|session_?token|private_?key|client_?secret|credentials?|authorization|jwt|ssh_?key|encryption_?key|signing_?key)$/i;

function findSecretLikeKeyPaths(
  value: unknown,
  basePath: string,
  visited = new Set<object>(),
  depth = 0,
): ContractValidationError[] {
  if (depth > 32 || value === null || typeof value !== 'object') {
    return [];
  }

  if (visited.has(value)) {
    return [
      {
        path: basePath,
        keyword: 'circular_reference',
        message: 'Circular references are not permitted in contract payloads.',
      },
    ];
  }
  visited.add(value);

  const errors: ContractValidationError[] = [];

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(
        ...findSecretLikeKeyPaths(
          value[i],
          `${basePath}/${i}`,
          visited,
          depth + 1,
        ),
      );
    }
    return errors;
  }

  for (const [key, nested] of Object.entries(value)) {
    const keyPath = `${basePath}/${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      errors.push({
        path: keyPath,
        keyword: 'secret_field_forbidden',
        message: `Secret-like property "${key}" is not allowed in contract payloads.`,
      });
    }
    errors.push(
      ...findSecretLikeKeyPaths(nested, keyPath, visited, depth + 1),
    );
  }

  return errors;
}

function validateGovernanceInvariants<K extends ContractKind>(
  kind: K,
  value: ContractMap[K],
): ContractValidationError[] {
  const errors: ContractValidationError[] = [];

  if (kind === 'task') {
    const task = value as Task;
    errors.push(...findSecretLikeKeyPaths(task.input, '$/input'));
    if (task.result !== null) {
      errors.push(...findSecretLikeKeyPaths(task.result, '$/result'));
    }
  } else if (kind === 'audit_event') {
    const event = value as AuditEvent;
    errors.push(...findSecretLikeKeyPaths(event.metadata, '$/metadata'));
  } else if (kind === 'approval') {
    const approval = value as Approval;
    if (
      approval.reviewed_by !== null &&
      approval.reviewed_by === approval.requested_by
    ) {
      errors.push({
        path: '$/reviewed_by',
        keyword: 'self_approval_forbidden',
        message:
          'Self-approval is forbidden: reviewed_by cannot match requested_by.',
      });
    }
  }

  return errors;
}

export function createContractValidator(
  schemas: ContractSchemas = DEFAULT_SCHEMAS,
): ContractValidator {
  let compiledValidators:
    | Record<ContractKind, ValidateFunction<unknown>>
    | null = null;
  let initializationError: string | null = null;

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
      validateFormats: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false,
    });

    addFormats(ajv);

    compiledValidators = {
      task: ajv.compile(schemas.task),
      agent: ajv.compile(schemas.agent),
      tool: ajv.compile(schemas.tool),
      approval: ajv.compile(schemas.approval),
      audit_event: ajv.compile(schemas.audit_event),
    };
  } catch (err) {
    initializationError =
      err instanceof Error
        ? `Failed to compile contract schemas: ${err.message}`
        : 'Failed to compile contract schemas due to an unknown error.';
    compiledValidators = null;
  }

  function validateContract<K extends ContractKind>(
    kind: K,
    input: unknown,
  ): ValidationResult<ContractMap[K]> {
    if (initializationError || !compiledValidators) {
      return failClosed(
        '$schema',
        'schema_compilation',
        initializationError ?? 'Contract validator is not initialized.',
      );
    }

    const validator = compiledValidators[kind];
    if (!validator) {
      return failClosed(
        '$',
        'unknown_contract_kind',
        `Unsupported contract kind "${String(kind)}".`,
      );
    }

    if (!isPlainObject(input)) {
      return failClosed(
        '$',
        'type',
        'Contract input must be a non-null JSON object.',
      );
    }

    try {
      const valid = validator(input);
      if (!valid) {
        return {
          valid: false,
          data: null,
          errors: formatAjvErrors(validator.errors),
        };
      }

      const typedInput = input as unknown as ContractMap[K];
      const invariantErrors = validateGovernanceInvariants(kind, typedInput);
      if (invariantErrors.length > 0) {
        return {
          valid: false,
          data: null,
          errors: invariantErrors,
        };
      }

      return {
        valid: true,
        data: typedInput,
        errors: [],
      };
    } catch (err) {
      return failClosed(
        '$',
        'validation_exception',
        err instanceof Error
          ? `Validation failed unexpectedly: ${err.message}`
          : 'Validation failed unexpectedly.',
      );
    }
  }

  function parseAndValidateContract<K extends ContractKind>(
    kind: K,
    rawJson: string,
  ): ValidationResult<ContractMap[K]> {
    if (typeof rawJson !== 'string') {
      return failClosed('$', 'json_parse', 'Raw JSON input must be a string.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      return failClosed(
        '$',
        'json_parse',
        err instanceof Error
          ? `Malformed JSON input: ${err.message}`
          : 'Malformed JSON input.',
      );
    }

    return validateContract(kind, parsed);
  }

  return {
    validateTask: (input: unknown) => validateContract('task', input),
    validateAgent: (input: unknown) => validateContract('agent', input),
    validateTool: (input: unknown) => validateContract('tool', input),
    validateApproval: (input: unknown) => validateContract('approval', input),
    validateAuditEvent: (input: unknown) =>
      validateContract('audit_event', input),
    validateContract,
    parseAndValidateContract,
  };
}

const defaultValidator = createContractValidator();

export const validateTask = defaultValidator.validateTask;
export const validateAgent = defaultValidator.validateAgent;
export const validateTool = defaultValidator.validateTool;
export const validateApproval = defaultValidator.validateApproval;
export const validateAuditEvent = defaultValidator.validateAuditEvent;
export const validateContract = defaultValidator.validateContract;
export const parseAndValidateContract =
  defaultValidator.parseAndValidateContract;
