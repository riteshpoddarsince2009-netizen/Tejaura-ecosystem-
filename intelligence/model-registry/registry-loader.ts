import type { ContractValidationError } from '../../contracts/validation/index.ts';
import {
  parseAndValidateModelRegistry,
  validateModelRegistry,
  type ModelEntry,
  type ModelRegistry,
} from './validate-model-registry.ts';

export interface LoadedModelRegistry {
  readonly registry: ModelRegistry;
  readonly enabledModels: readonly ModelEntry[];
  getModelById: (id: string) => ModelEntry | null;
  getEnabledModelById: (id: string) => ModelEntry | null;
}

export type RegistryLoadResult =
  | {
      ok: true;
      data: LoadedModelRegistry;
    }
  | {
      ok: false;
      code:
        | 'INVALID_REGISTRY'
        | 'DISABLED_MODEL'
        | 'MODEL_NOT_FOUND'
        | 'READ_ERROR';
      errors: ContractValidationError[];
    };

function cloneModelEntry(entry: ModelEntry): ModelEntry {
  return {
    ...entry,
    capabilities: [...entry.capabilities],
  };
}

function cloneRegistry(registry: ModelRegistry): ModelRegistry {
  return {
    ...registry,
    policy: { ...registry.policy },
    providers: registry.providers.map((p) => ({ ...p })),
    models: registry.models.map(cloneModelEntry),
  };
}

export function loadModelRegistry(input: unknown): RegistryLoadResult {
  const validation =
    typeof input === 'string'
      ? parseAndValidateModelRegistry(input)
      : validateModelRegistry(input);

  if (!validation.valid) {
    return {
      ok: false,
      code: 'INVALID_REGISTRY',
      errors: validation.errors,
    };
  }

  const frozenRegistry = cloneRegistry(validation.data);
  const allById = new Map<string, ModelEntry>();
  const enabledList: ModelEntry[] = [];
  const enabledById = new Map<string, ModelEntry>();

  for (const model of frozenRegistry.models) {
    const copy = cloneModelEntry(model);
    allById.set(copy.id, copy);
    if (copy.enabled === true) {
      enabledList.push(copy);
      enabledById.set(copy.id, copy);
    }
  }

  return {
    ok: true,
    data: {
      registry: frozenRegistry,
      enabledModels: enabledList.map(cloneModelEntry),
      getModelById: (id: string) => {
        const found = allById.get(id);
        return found ? cloneModelEntry(found) : null;
      },
      getEnabledModelById: (id: string) => {
        const found = enabledById.get(id);
        return found ? cloneModelEntry(found) : null;
      },
    },
  };
}

export function loadModelRegistryFromSource(
  sourcePath: string,
  readFile: (filePath: string) => string,
): RegistryLoadResult {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    return {
      ok: false,
      code: 'READ_ERROR',
      errors: [
        {
          path: '$',
          keyword: 'invalid_path',
          message: 'Model registry source path must be a non-empty string.',
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = readFile(sourcePath);
  } catch (err) {
    return {
      ok: false,
      code: 'READ_ERROR',
      errors: [
        {
          path: '$',
          keyword: 'read_error',
          message:
            err instanceof Error
              ? `Failed to read model registry: ${err.message}`
              : 'Failed to read model registry.',
        },
      ],
    };
  }

  return loadModelRegistry(raw);
}
