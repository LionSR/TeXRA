/**
 * Platform-agnostic storage path provider facade for the agent core.
 *
 * Thin wrapper over `platform().storage`. Consumer code imports this
 * module for convenience; the canonical definition lives in
 * `@platform/interfaces`.
 */
import { platform } from '@platform/platform';

export interface StorageProvider {
  /** Per-workspace storage root path. */
  getStoragePath(): string;

  /** Cross-workspace global storage root path. */
  getGlobalStoragePath(): string;
}

/** Get the active storage provider. */
export function getStorageProvider(): StorageProvider {
  return platform().storage;
}
