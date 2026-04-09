/**
 * Storage facade — convenience wrapper over platform().storage.
 */
import { platform } from '@platform/platform';

export function getStorageProvider() {
  return platform().storage;
}
