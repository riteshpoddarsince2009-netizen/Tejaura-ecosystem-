export {
  checkModelPolicy,
  invokeModelThroughGateway,
  isLoopbackEndpoint,
  normalizeModelError,
  redactPotentialSecrets,
  resolvePolicyActionForModel,
  validateModelRequestShape,
} from './model-adapter.ts';

export type { ModelAdapter } from './model-adapter.ts';

export type {
  AdapterExecutionContext,
  GatewayInvokeInput,
  GatewayPolicyContext,
  ModelCapabilities,
  ModelError,
  ModelErrorCode,
  ModelMessage,
  ModelMetadata,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  SecretResolver,
} from './model-types.ts';
