// Platform imports
import { platform } from '@platform/platform';

// Local imports - fs
import { RelativeFS } from './relativeFS';

/**
 * StorageFS provides a unified interface for extension storage operations.
 * Supports both workspace storage (per-workspace) and global storage (shared across workspaces).
 *
 * Storage paths are provided by the platform's StorageProvider, which is set
 * via initPlatform() at startup. Default: ~/.texra/ paths.
 */
export class StorageFS extends RelativeFS {
  /**
   * Return the workspace storage base path (per-workspace)
   */
  protected static override getBasePath(): string {
    return platform().storage.getStoragePath();
  }

  // Inherit file operations from RelativeFS
}

/**
 * GlobalStorageFS provides operations for global storage (shared across workspaces).
 * Extends StorageFS but uses global storage paths instead of workspace storage.
 */
export class GlobalStorageFS extends RelativeFS {
  protected static override getBasePath(): string {
    return platform().storage.getGlobalStoragePath();
  }
}
