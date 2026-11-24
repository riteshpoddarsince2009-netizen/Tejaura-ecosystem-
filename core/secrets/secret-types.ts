import type { EncryptedEnvelope } from '../security/index.ts';

export const AIRLLM_WORKER_TOKEN_ENV_VAR = 'TEJAURA_AIRLLM_WORKER_TOKEN';

export type SecretScope =
  | 'worker_runtime'
  | 'external_credential'
  | 'encryption_key'
  | 'owner_credential';

export interface StoredSecretEntry {
  key: string;
  scope: SecretScope;
  envelope: EncryptedEnvelope;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface SecretMetadata {
  key: string;
  source: 'env' | 'vault';
  scope: SecretScope;
  present: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface EncryptedVaultBackend {
  load: () => Record<string, StoredSecretEntry>;
  save: (entries: Record<string, StoredSecretEntry>) => void;
}

export type SecretOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };
