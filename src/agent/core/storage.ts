/**
 * Storage facade — convenience wrapper over platform().storage.
 */
import { platform } from '@platform/platform';
import type { StorageProvider } from '@platform/interfaces/storage';

export type { StorageProvider };

export function getStorageProvider(): StorageProvider {
  return platform().storage;
}
