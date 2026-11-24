import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { EncryptedVaultBackend, StoredSecretEntry } from './secret-types.ts';

const FORBIDDEN_PUBLIC_DIR_NAMES = new Set([
  'public',
  'dist',
  'build',
  'src',
  'static',
  'www',
]);

function assertNotWebServedPath(dirPath: string): void {
  const segments = path.resolve(dirPath).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_PUBLIC_DIR_NAMES.has(segment.toLowerCase())) {
      throw new Error(
        `Refusing to store encrypted secrets inside web-served directory "${segment}".`,
      );
    }
  }
}

interface VaultFileDocument {
  version: '1.0.0';
  entries: Record<string, StoredSecretEntry>;
}

export class FileEncryptedVaultBackend implements EncryptedVaultBackend {
  private readonly filePath: string;

  constructor(stateDir: string, fileName = 'secrets.vault.json') {
    assertNotWebServedPath(stateDir);
    if (path.basename(fileName) !== fileName || !fileName.endsWith('.json')) {
      throw new Error('Vault file name must be a plain .json file name.');
    }
    this.filePath = path.join(path.resolve(stateDir), fileName);
  }

  load(): Record<string, StoredSecretEntry> {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (raw.trim().length === 0) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<VaultFileDocument>;
    if (!parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error('Encrypted vault file is malformed.');
    }
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        entry.key !== key ||
        typeof entry.scope !== 'string' ||
        !entry.envelope ||
        typeof entry.envelope !== 'object'
      ) {
        throw new Error(`Encrypted vault entry "${key}" is malformed.`);
      }
    }
    return { ...parsed.entries };
  }

  save(entries: Record<string, StoredSecretEntry>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const document: VaultFileDocument = {
      version: '1.0.0',
      entries,
    };
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(document, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  }
}

export class InMemoryEncryptedVaultBackend implements EncryptedVaultBackend {
  private entries: Record<string, StoredSecretEntry> = {};

  load(): Record<string, StoredSecretEntry> {
    return { ...this.entries };
  }

  save(entries: Record<string, StoredSecretEntry>): void {
    this.entries = { ...entries };
  }
}
