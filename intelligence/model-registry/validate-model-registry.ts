import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type { AgentPermittedAutonomyLevel } from '../../contracts/types/index.ts';
import type {
  ContractValidationError,
  ValidationResult,
} from '../../contracts/validation/index.ts';
import modelRegistrySchema from './model-registry.schema.json' with { type: 'json' };

type Ajv2020Constructor = typeof Ajv2020Module;
type AddFormatsFn = typeof addFormatsModule;

const Ajv2020 =
  (Ajv2020Module as unknown as { default?: Ajv2020Constructor }).default ??
  Ajv2020Module;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  addFormatsModule;

export type ModelProviderType =
  | 'local-open-source'
  | 'self-hosted'
  | 'free-cloud-tier'
  | 'paid-api';

export type ModelCostTier = 'free' | 'metered-low' | 'metered-high';

export interface ModelProviderEntry {
  id: string;
  name: string;
  providerType: ModelProviderType;
  adapter: string;
  endpoint?: string;
  apiKeyEnvVar?: string | null;
  enabled: boolean;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  providerType: ModelProviderType;
  adapter: string;
  endpoint: string;
  apiKeyEnvVar: string | null;
  license: string;
  costTier: ModelCostTier;
  capabilities: string[];
  contextWindow: number;
  maxAutonomyAllowed: AgentPermittedAutonomyLevel;
  enabled: boolean;
  addedAt: string;
}

export interface ModelRegistry {
  schemaVersion: string;
  registryVersion: string;
  lastUpdated: string;
  policy: {
    providerAgnostic: true;
    openSourceFirst: boolean;
    freeFirst: boolean;
    allowSecretsInRegistry: false;
    requireExplicitOwnerRegistration: true;
  };
  defaultModelId: string | null;
  providers: ModelProviderEntry[];
  models: ModelEntry[];
}

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
  compiledValidator = ajv.compile(modelRegistrySchema);
} catch (err) {
  compileError =
    err instanceof Error
      ? `Failed to compile model registry schema: ${err.message}`
      : 'Failed to compile model registry schema.';
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
        message: 'Model registry validation failed.',
      },
    ];
  }

  return errors.map((err) => ({
    path: err.instancePath ? `$${err.instancePath}` : '$',
    keyword: err.keyword,
    message: err.message ?? 'Invalid model registry value',
    schema_path: err.schemaPath,
  }));
}

function endpointContainsCredentials(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return true;
  }
}

export function validateModelRegistry(
  input: unknown,
): ValidationResult<ModelRegistry> {
  if (compileError || !compiledValidator) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$schema',
          keyword: 'schema_compilation',
          message: compileError ?? 'Model registry schema unavailable.',
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
          message: 'Model registry must be a non-null JSON object.',
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

  const registry = input as ModelRegistry;
  const errors: ContractValidationError[] = [];

  const providerIds = new Set<string>();
  registry.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      errors.push({
        path: `$/providers/${index}/id`,
        keyword: 'duplicate_id',
        message: `Duplicate provider id "${provider.id}".`,
      });
    }
    providerIds.add(provider.id);

    if (provider.endpoint && endpointContainsCredentials(provider.endpoint)) {
      errors.push({
        path: `$/providers/${index}/endpoint`,
        keyword: 'endpoint_credentials_forbidden',
        message:
          'Provider endpoint URL must be valid and must not embed credentials.',
      });
    }
  });

  const modelIds = new Set<string>();
  const enabledModelIds = new Set<string>();
  registry.models.forEach((model, index) => {
    if (modelIds.has(model.id)) {
      errors.push({
        path: `$/models/${index}/id`,
        keyword: 'duplicate_id',
        message: `Duplicate model id "${model.id}".`,
      });
    }
    modelIds.add(model.id);
    if (model.enabled) {
      enabledModelIds.add(model.id);
    }

    if (endpointContainsCredentials(model.endpoint)) {
      errors.push({
        path: `$/models/${index}/endpoint`,
        keyword: 'endpoint_credentials_forbidden',
        message:
          'Model endpoint URL must be valid and must not embed credentials.',
      });
    }
  });

  if (
    registry.defaultModelId !== null &&
    !enabledModelIds.has(registry.defaultModelId)
  ) {
    errors.push({
      path: '$/defaultModelId',
      keyword: 'invalid_default_model',
      message: `defaultModelId "${registry.defaultModelId}" must reference an enabled model in the registry.`,
    });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      data: null,
      errors,
    };
  }

  return {
    valid: true,
    data: registry,
    errors: [],
  };
}

export function parseAndValidateModelRegistry(
  rawJson: string,
): ValidationResult<ModelRegistry> {
  if (typeof rawJson !== 'string') {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'json_parse',
          message: 'Model registry JSON input must be a string.',
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
              ? `Malformed model registry JSON: ${err.message}`
              : 'Malformed model registry JSON.',
        },
      ],
    };
  }

  return validateModelRegistry(parsed);
}
