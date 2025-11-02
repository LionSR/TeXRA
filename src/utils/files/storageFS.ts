// Third-party imports
import * as vscode from 'vscode';

// Local imports - fs
import { RelativeFS } from './relativeFS';

/**
 * StorageFS provides a unified interface for VS Code extension storage operations.
 * Supports both workspace storage (per-workspace) and global storage (shared across workspaces).
 */
export class StorageFS extends RelativeFS {
  private static context: vscode.ExtensionContext | null = null;

  /**
   * Initialize StorageFS with the extension context
   */
  public static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Return the workspace storage base path (per-workspace)
   */
  protected static override getBasePath(): string {
    if (!this.context?.storageUri) {
      throw new Error(
        'StorageFS not initialized. Call StorageFS.initialize(context) first.',
      );
    }
    return this.context.storageUri.fsPath;
  }

  /**
   * Get the global storage base path (shared across workspaces)
   */
  public static getGlobalPath(): string {
    if (!this.context?.globalStorageUri) {
      throw new Error(
        'StorageFS not initialized. Call StorageFS.initialize(context) first.',
      );
    }
    return this.context.globalStorageUri.fsPath;
  }

  // Inherit file operations from RelativeFS
}

/**
 * GlobalStorageFS provides operations for global storage (shared across workspaces).
 * Extends StorageFS but uses global storage paths instead of workspace storage.
 */
export class GlobalStorageFS extends RelativeFS {
  protected static override getBasePath(): string {
    return StorageFS.getGlobalPath();
  }
}

export default StorageFS;
