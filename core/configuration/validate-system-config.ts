import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AutonomyLevel } from '../../contracts/types/index.ts';
import type {
  ContractValidationError,
  ValidationResult,
} from '../../contracts/validation/index.ts';
import systemSchema from './system.schema.json' with { type: 'json' };

type Ajv2020Constructor = typeof Ajv2020Module;
type AddFormatsFn = typeof addFormatsModule;

const Ajv2020 =
  (Ajv2020Module as unknown as { default?: Ajv2020Constructor }).default ??
  Ajv2020Module;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  addFormatsModule;

export type AutonomousConfigLevel = 'L0' | 'L1' | 'L2';

export interface AutonomyLevelSpec {
  id: string;
  description: string;
}

export interface ApprovalGateSpec {
  required: true;
  autonomyLevel: 'L4';
  allowAutoApprove: false;
}

export interface SystemConfig {
  $schema?: string;
  schemaVersion: string;
  system: {
    name: 'TEJAURA';
    version: string;
    stage: string;
    status: string;
    description: string;
  };
  principles: {
    openSourceFirst: boolean;
    modelProviderAgnostic: boolean;
    phoneFirst: boolean;
    freeFirst: boolean;
    modularAndTestable: boolean;
  };
  governance: {
    humanOwnerControl: true;
    allowAgentSelfPermission: false;
    allowAgentSelfApproval: false;
    failClosedOnPolicyError: true;
    defaultAutonomyLevel: AutonomousConfigLevel;
    maxAutonomousLevel: AutonomousConfigLevel;
    autonomyLevels: Record<AutonomyLevel, AutonomyLevelSpec>;
    documents: {
      constitution: string;
      identity: string;
      permissionPolicy: string;
    };
  };
  approvalGates: {
    productionDeployments: ApprovalGateSpec;
    paymentsAndBilling: ApprovalGateSpec;
    publicPublishing: ApprovalGateSpec;
    governanceModification: ApprovalGateSpec;
    credentialAccess: ApprovalGateSpec;
    destructiveActions: ApprovalGateSpec;
  };
  security: {
    allowSecretsInSource: false;
    allowSecretsInConfig: false;
    credentialSource: 'environment-variables-only' | 'local-os-secret-store';
    defaultNetworkEgress: 'deny' | 'allowlist-only';
    auditTrail: {
      enabled: boolean;
      status: 'planned' | 'implemented' | 'active';
      directory?: string;
    };
  };
  intelligence: {
    modelRegistryPath: string;
    modelRegistryRulesPath: string;
    requireRegisteredModelsOnly: boolean;
    preferLocalOrFreeModels: boolean;
  };
  modules: Record<
    string,
    {
      status: 'implemented-spec' | 'implemented' | 'planned';
      description: string;
    }
  >;
}

const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

let compiledValidator: ValidateFunction<unknown> | null = null;
let compileError: string | null = null;

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
  compiledValidator = ajv.compile(systemSchema);
} catch (err) {
  compileError =
    err instanceof Error
      ? `Failed to compile system configuration schema: ${err.message}`
      : 'Failed to compile system configuration schema.';
  compiledValidator = null;
}

function formatErrors(
  errors: ErrorObject[] | null | undefined,
): ContractValidationError[] {
  if (!errors || errors.length === 0) {
    return [
      {
        path: '$',
        keyword: 'validation_failed',
        message: 'System configuration validation failed.',
      },
    ];
  }

  return errors.map((err) => ({
    path: err.instancePath ? `$${err.instancePath}` : '$',
    keyword: err.keyword,
    message: err.message ?? 'Invalid system configuration value',
    schema_path: err.schemaPath,
  }));
}

export function validateSystemConfig(
  input: unknown,
): ValidationResult<SystemConfig> {
  if (compileError || !compiledValidator) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$schema',
          keyword: 'schema_compilation',
          message: compileError ?? 'System configuration schema unavailable.',
        },
      ],
    };
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'type',
          message: 'System configuration must be a non-null JSON object.',
        },
      ],
    };
  }

  if (!compiledValidator(input)) {
    return {
      valid: false,
      data: null,
      errors: formatErrors(compiledValidator.errors),
    };
  }

  const config = input as SystemConfig;
  const defaultRank = AUTONOMY_RANK[config.governance.defaultAutonomyLevel];
  const maxRank = AUTONOMY_RANK[config.governance.maxAutonomousLevel];
  if (defaultRank > maxRank) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$/governance/defaultAutonomyLevel',
          keyword: 'autonomy_ceiling_exceeded',
          message: `defaultAutonomyLevel (${config.governance.defaultAutonomyLevel}) cannot exceed maxAutonomousLevel (${config.governance.maxAutonomousLevel}).`,
        },
      ],
    };
  }

  return {
    valid: true,
    data: config,
    errors: [],
  };
}

export function parseAndValidateSystemConfig(
  rawJson: string,
): ValidationResult<SystemConfig> {
  if (typeof rawJson !== 'string') {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'json_parse',
          message: 'System configuration JSON input must be a string.',
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'json_parse',
          message:
            err instanceof Error
              ? `Malformed system configuration JSON: ${err.message}`
              : 'Malformed system configuration JSON.',
        },
      ],
    };
  }

  return validateSystemConfig(parsed);
}
