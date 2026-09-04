// Platform imports
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';

// Local imports - fs
import { RelativeFS } from './relativeFS';

/**
 * StorageFS provides a unified interface for extension storage operations.
 * Supports both workspace storage (per-workspace) and global storage (shared across workspaces).
 *
 * The workspace storage path is the current session's (`WorkspaceRoots`),
 * resolved per call so a run writes under its own paper's root; the global
 * path is the process platform's. Default: ~/.texra/ paths.
 */
export class StorageFS extends RelativeFS {
  /**
   * Return the workspace storage base path (per-workspace)
   */
  protected static override getBasePath(): string {
    return workspaceRoots().storage;
  }
}

/**
 * GlobalStorageFS provides operations for global storage (shared across workspaces).
 * Uses the platform's global storage path instead of the workspace storage path.
 */
export class GlobalStorageFS extends RelativeFS {
  protected static override getBasePath(): string {
    return platform().storage.getGlobalStoragePath();
  }
}
