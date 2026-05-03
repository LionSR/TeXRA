import { safeStorage } from 'electron';

import type { PlatformSecrets } from '@platform/secrets';

import { JsonStore } from './jsonStore.js';

type StoredSecret = { encrypted: true; value: string };

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as StoredSecret).value === 'string' &&
    (value as StoredSecret).encrypted === true
  );
}

export class ElectronSecrets implements PlatformSecrets {
  constructor(private readonly store: JsonStore) {}

  /** Environment variables override persisted Electron secrets. */
  async get(key: string): Promise<string | undefined> {
    const envValue = process.env[key];
    if (envValue !== undefined) return envValue;

    const stored = this.store.get<unknown>(key);
    if (!isStoredSecret(stored)) return undefined;
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
  }

  async set(key: string, value: string): Promise<void> {
    if (!isSafeStorageUsable()) {
      throw new Error('Electron safeStorage is unavailable for secret writes.');
    }
    const stored: StoredSecret = {
      encrypted: true,
      value: safeStorage.encryptString(value).toString('base64'),
    };
    await this.store.set(key, stored);
  }

  async delete(key: string): Promise<void> {
    await this.store.set(key, undefined);
  }
}

function isSafeStorageUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return (
    process.platform !== 'linux' ||
    safeStorage.getSelectedStorageBackend() !== 'basic_text'
  );
}
