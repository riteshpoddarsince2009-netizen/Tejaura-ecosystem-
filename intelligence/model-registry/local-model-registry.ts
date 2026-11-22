import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

import type {
  ContractValidationError,
  ValidationResult,
} from '../../contracts/validation/index.ts';
import type { AuditLogger } from '../../core/audit/index.ts';
import {
  evaluatePolicyWithAudit,
  type PolicyActor,
  type PolicyEvaluationResult,
} from '../../core/policy/index.ts';
import { validateControlledEndpointUrl } from '../runtime/endpoint-guard.ts';
import type {
  LocalRuntimeType,
  ModelAvailabilityStatus,
  ModelCapability,
  ModelCompatibilityStatus,
  ModelModality,
} from '../runtime/runtime-types.ts';
import localModelSchema from './local-model.schema.json' with { type: 'json' };

type Ajv2020Constructor = typeof Ajv2020Module;
type AddFormatsFn = typeof addFormatsModule;

const Ajv2020 =
  (Ajv2020Module as unknown as { default?: Ajv2020Constructor }).default ??
  Ajv2020Module;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  addFormatsModule;

export interface HardwareRequirements {
  min_ram_mb: number;
  min_vram_mb: number;
  min_storage_mb: number;
  requires_gpu: boolean;
  recommended_ram_mb?: number;
  recommended_vram_mb?: number;
}

export interface ModelRepositoryInfo {
  repo_id: string;
  revision: string;
  source: 'modelscope' | 'huggingface' | 'local_mirror' | 'owner_archive';
}

export interface ModelLicenseInfo {
  name: string;
  spdx_id?: string;
  open_weight: true;
  commercial_use_allowed?: boolean;
  source_url?: string;
}

export interface LocalModelEntry {
  model_id: string;
  model_name: string;
  model_family: string;
  model_version: string;
  model_repository: ModelRepositoryInfo;
  local_model_path: string | null;
  controlled_runtime_endpoint: string | null;
  runtime_type: LocalRuntimeType;
  compatibility_status: ModelCompatibilityStatus;
  modality: ModelModality;
  capabilities: ModelCapability[];
  hardware_requirements: HardwareRequirements;
  quantization: string;
  context_length: number;
  enabled: boolean;
  availability: ModelAvailabilityStatus;
  license: ModelLicenseInfo;
  size_mb?: number;
  format?: 'safetensors' | 'gguf' | 'airllm-sharded' | 'mlx' | 'onnx' | 'custom';
  node_id?: string;
}

export interface LocalModelRegistryDocument {
  schema_version: string;
  registry_version: string;
  last_updated: string;
  preferred_runtime?: 'airllm';
  local_first_only: true;
  allow_paid_third_party_apis: false;
  allow_secrets: false;
  models: LocalModelEntry[];
}

export interface RegistryMutationContext {
  actor: PolicyActor;
  declared_scopes: readonly string[];
  system_config: unknown;
  audit_logger: AuditLogger;
  correlation_id: string;
}

export type RegistryMutationResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      code: string;
      error: string;
      policy?: PolicyEvaluationResult;
    };

const SECRET_KEY_PATTERN =
  /^(password|passphrase|secret|secret_?key|api_?key|access_?token|refresh_?token|bearer_?token|auth_?token|id_?token|session_?token|private_?key|client_?secret|credentials?|authorization|jwt)$/i;

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
  compiledValidator = ajv.compile(localModelSchema);
} catch (err) {
  compileError =
    err instanceof Error
      ? `Failed to compile local model registry schema: ${err.message}`
      : 'Failed to compile local model registry schema.';
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
        message: 'Local model registry validation failed.',
      },
    ];
  }
  return errors.map((err) => ({
    path: err.instancePath ? `$${err.instancePath}` : '$',
    keyword: err.keyword,
    message: err.message ?? 'Invalid local model registry field',
    schema_path: err.schemaPath,
  }));
}

function scanForSecretKeys(
  value: unknown,
  basePath: string,
): ContractValidationError[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const errors: ContractValidationError[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      errors.push(...scanForSecretKeys(item, `${basePath}/${idx}`));
    });
    return errors;
  }
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = `${basePath}/${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      errors.push({
        path: keyPath,
        keyword: 'secret_field_forbidden',
        message: `Secret-like field "${key}" is forbidden in the model registry.`,
      });
    }
    errors.push(...scanForSecretKeys(nested, keyPath));
  }
  return errors;
}

export function validateLocalModelRegistry(
  input: unknown,
): ValidationResult<LocalModelRegistryDocument> {
  if (compileError || !compiledValidator) {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$schema',
          keyword: 'schema_compilation',
          message: compileError ?? 'Local model registry schema unavailable.',
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
          message: 'Local model registry must be a non-null JSON object.',
        },
      ],
    };
  }

  const secretErrors = scanForSecretKeys(input, '$');
  if (secretErrors.length > 0) {
    return {
      valid: false,
      data: null,
      errors: secretErrors,
    };
  }

  if (!compiledValidator(input)) {
    return {
      valid: false,
      data: null,
      errors: formatErrors(compiledValidator.errors),
    };
  }

  const doc = input as LocalModelRegistryDocument;
  const errors: ContractValidationError[] = [];
  const seenIds = new Set<string>();

  doc.models.forEach((model, index) => {
    if (seenIds.has(model.model_id)) {
      errors.push({
        path: `$/models/${index}/model_id`,
        keyword: 'duplicate_model_id',
        message: `Duplicate model_id "${model.model_id}".`,
      });
    }
    seenIds.add(model.model_id);

    if (model.enabled && model.compatibility_status !== 'verified') {
      errors.push({
        path: `$/models/${index}/compatibility_status`,
        keyword: 'unverified_model_enable_forbidden',
        message: `Model "${model.model_id}" has compatibility_status "${model.compatibility_status}" and cannot be enabled.`,
      });
    }

    if (model.enabled && model.modality !== 'text') {
      errors.push({
        path: `$/models/${index}/modality`,
        keyword: 'unsupported_modality_enable_forbidden',
        message: `Model "${model.model_id}" has modality "${model.modality}" which is disabled until a verified execution path exists.`,
      });
    }

    if (
      model.enabled &&
      model.runtime_type === 'airllm' &&
      model.capabilities.includes('vision')
    ) {
      errors.push({
        path: `$/models/${index}/capabilities`,
        keyword: 'unsupported_airllm_capability',
        message: `AirLLM model "${model.model_id}" cannot enable unverified "vision" capability.`,
      });
    }

    if (model.controlled_runtime_endpoint !== null) {
      const endpointCheck = validateControlledEndpointUrl(
        model.controlled_runtime_endpoint,
      );
      if (!endpointCheck.valid) {
        errors.push({
          path: `$/models/${index}/controlled_runtime_endpoint`,
          keyword: endpointCheck.code ?? 'invalid_endpoint',
          message: endpointCheck.error ?? 'Invalid controlled runtime endpoint.',
        });
      }
    }
  });

  if (errors.length > 0) {
    return { valid: false, data: null, errors };
  }

  return { valid: true, data: doc, errors: [] };
}

export function parseAndValidateLocalModelRegistry(
  rawJson: string,
): ValidationResult<LocalModelRegistryDocument> {
  if (typeof rawJson !== 'string') {
    return {
      valid: false,
      data: null,
      errors: [
        {
          path: '$',
          keyword: 'json_parse',
          message: 'Registry JSON input must be a string.',
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
              ? `Malformed registry JSON: ${err.message}`
              : 'Malformed registry JSON.',
        },
      ],
    };
  }

  return validateLocalModelRegistry(parsed);
}

function cloneEntry(entry: LocalModelEntry): LocalModelEntry {
  return {
    ...entry,
    model_repository: { ...entry.model_repository },
    capabilities: [...entry.capabilities],
    hardware_requirements: { ...entry.hardware_requirements },
    license: { ...entry.license },
  };
}

export class LocalModelRegistry {
  private readonly models = new Map<string, LocalModelEntry>();

  constructor(initialDocument?: LocalModelRegistryDocument) {
    if (initialDocument) {
      const check = validateLocalModelRegistry(initialDocument);
      if (!check.valid) {
        throw new Error(
          `Invalid initial LocalModelRegistry document: ${check.errors.map((e) => e.message).join('; ')}`,
        );
      }
      for (const model of check.data.models) {
        this.models.set(model.model_id, cloneEntry(model));
      }
    }
  }

  listModels(): LocalModelEntry[] {
    return [...this.models.values()].map(cloneEntry);
  }

  getModel(modelId: string): LocalModelEntry | null {
    const found = this.models.get(modelId);
    return found ? cloneEntry(found) : null;
  }

  /**
   * Owner-exclusive (L4) registry mutation gated through PolicyEvaluator + AuditLogger.
   * Agents or model output can never register, enable, or alter models.
   */
  registerModel(
    entry: LocalModelEntry,
    ctx: RegistryMutationContext,
  ): RegistryMutationResult<LocalModelEntry> {
    const policy = evaluatePolicyWithAudit({
      actor: ctx.actor,
      action: 'model:registry_write',
      resource: { id: `model:${entry?.model_id ?? 'unknown'}`, type: 'model' },
      environment: 'local',
      declared_scopes: ctx.declared_scopes,
      owner_confirmed_l4: true,
      system_config: ctx.system_config,
      audit_logger: ctx.audit_logger,
      correlation_id: ctx.correlation_id,
    });

    if (!policy.allowed) {
      return {
        ok: false,
        code: policy.reason_code,
        error: policy.reason,
        policy,
      };
    }

    if (entry.enabled && entry.compatibility_status !== 'verified') {
      return {
        ok: false,
        code:
          entry.compatibility_status === 'unsupported'
            ? 'MODEL_COMPATIBILITY_UNSUPPORTED'
            : 'MODEL_COMPATIBILITY_UNTESTED',
        error: `Model "${entry.model_id}" has compatibility_status "${entry.compatibility_status}" and cannot be enabled.`,
      };
    }

    if (entry.enabled && entry.modality !== 'text') {
      return {
        ok: false,
        code: 'UNSUPPORTED_MODALITY',
        error: `Model "${entry.model_id}" has modality "${entry.modality}" which cannot be enabled without a verified execution path.`,
      };
    }

    const candidateDoc: LocalModelRegistryDocument = {
      schema_version: '1.0.0',
      registry_version: '0.3.0',
      last_updated: new Date().toISOString(),
      preferred_runtime: 'airllm',
      local_first_only: true,
      allow_paid_third_party_apis: false,
      allow_secrets: false,
      models: [
        ...[...this.models.values()].filter(
          (m) => m.model_id !== entry.model_id,
        ),
        entry,
      ],
    };

    const validation = validateLocalModelRegistry(candidateDoc);
    if (!validation.valid) {
      return {
        ok: false,
        code: 'INVALID_MODEL_ENTRY',
        error: validation.errors.map((e) => e.message).join('; '),
      };
    }

    const stored = cloneEntry(entry);
    this.models.set(stored.model_id, stored);
    return { ok: true, data: cloneEntry(stored) };
  }

  setEnabled(
    modelId: string,
    enabled: boolean,
    ctx: RegistryMutationContext,
  ): RegistryMutationResult<LocalModelEntry> {
    const policy = evaluatePolicyWithAudit({
      actor: ctx.actor,
      action: 'model:registry_write',
      resource: { id: `model:${modelId}`, type: 'model' },
      environment: 'local',
      declared_scopes: ctx.declared_scopes,
      owner_confirmed_l4: true,
      system_config: ctx.system_config,
      audit_logger: ctx.audit_logger,
      correlation_id: ctx.correlation_id,
    });

    if (!policy.allowed) {
      return {
        ok: false,
        code: policy.reason_code,
        error: policy.reason,
        policy,
      };
    }

    const existing = this.models.get(modelId);
    if (!existing) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" is not registered.`,
      };
    }

    if (enabled && existing.compatibility_status !== 'verified') {
      return {
        ok: false,
        code:
          existing.compatibility_status === 'unsupported'
            ? 'MODEL_COMPATIBILITY_UNSUPPORTED'
            : 'MODEL_COMPATIBILITY_UNTESTED',
        error: `Cannot enable "${modelId}": compatibility_status is "${existing.compatibility_status}" (only "verified" models may be enabled).`,
      };
    }

    if (
      enabled &&
      (existing.modality !== 'text' ||
        (existing.runtime_type === 'airllm' &&
          existing.capabilities.includes('vision')))
    ) {
      return {
        ok: false,
        code: 'UNSUPPORTED_AIRLLM_MODALITY',
        error: `Cannot enable "${modelId}": modality "${existing.modality}" lacks a verified execution path.`,
      };
    }

    const updated: LocalModelEntry = { ...cloneEntry(existing), enabled };
    this.models.set(modelId, updated);
    return { ok: true, data: cloneEntry(updated) };
  }

  updateAvailability(
    modelId: string,
    availability: ModelAvailabilityStatus,
  ): boolean {
    const existing = this.models.get(modelId);
    if (!existing) {
      return false;
    }
    this.models.set(modelId, { ...cloneEntry(existing), availability });
    return true;
  }

  removeModel(
    modelId: string,
    ctx: RegistryMutationContext,
  ): RegistryMutationResult<{ model_id: string }> {
    const policy = evaluatePolicyWithAudit({
      actor: ctx.actor,
      action: 'model:registry_write',
      resource: { id: `model:${modelId}`, type: 'model' },
      environment: 'local',
      declared_scopes: ctx.declared_scopes,
      owner_confirmed_l4: true,
      system_config: ctx.system_config,
      audit_logger: ctx.audit_logger,
      correlation_id: ctx.correlation_id,
    });

    if (!policy.allowed) {
      return {
        ok: false,
        code: policy.reason_code,
        error: policy.reason,
        policy,
      };
    }

    if (!this.models.has(modelId)) {
      return {
        ok: false,
        code: 'MODEL_NOT_FOUND',
        error: `Model "${modelId}" is not registered.`,
      };
    }

    this.models.delete(modelId);
    return { ok: true, data: { model_id: modelId } };
  }
}
