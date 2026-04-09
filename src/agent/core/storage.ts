/**
 * Platform-agnostic storage path provider for the agent core.
 *
 * Delegates to a settable backend. Default: uses ~/.texra/ paths.
 * VS Code calls `setStorageProvider()` at activation to use
 * context.storageUri and context.globalStorageUri.
 */
import * as os from 'os';
import * as path from 'path';

export interface StorageProvider {
  /** Per-workspace storage root path. */
  getStoragePath(): string;

  /** Cross-workspace global storage root path. */
  getGlobalStoragePath(): string;
}

// ---------------------------------------------------------------------------
// Default backend – ~/.texra/ (for CLI / Electron / tests)
// ---------------------------------------------------------------------------

const defaultBackend: StorageProvider = {
  getStoragePath(): string {
    return path.join(os.homedir(), '.texra', 'workspace-storage');
  },

  getGlobalStoragePath(): string {
    return path.join(os.homedir(), '.texra', 'global-storage');
  },
};

// ---------------------------------------------------------------------------
// Settable backend
// ---------------------------------------------------------------------------

let backend: StorageProvider = defaultBackend;

/** Replace the storage provider. Called once at platform init. */
export function setStorageProvider(provider: StorageProvider): void {
  backend = provider;
}

/** Get the active storage provider. */
export function getStorageProvider(): StorageProvider {
  return backend;
}
