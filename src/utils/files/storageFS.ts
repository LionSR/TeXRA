// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - fs
import { RelativeFS } from './relativeFS';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'storageFS';
logger.initialize(CHANNEL);

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
   * Get the workspace storage base path (per-workspace)
   */
  public static getPath(): string {
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

  protected static override getBasePath(): string {
    return this.getPath();
  }

  /**
   * Delete a file or directory
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await super.delete(relativePath, options);
    logger.debug(CHANNEL, `Deleted: ${relativePath}`);
  }

  /**
   * Create a directory
   */
  public static async createDir(relativePath: string): Promise<void> {
    await super.createDir(relativePath);
    logger.debug(CHANNEL, `Created directory: ${relativePath}`);
  }

  /**
   * Copy a file or directory
   */
  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await super.copy(source, destination, options);
    logger.debug(
      CHANNEL,
      `Copied: source=${source} to destination=${destination}`,
    );
  }

  /**
   * Move/rename a file or directory
   */
  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await super.rename(oldPath, newPath, options);
    logger.debug(CHANNEL, `Renamed: ${oldPath} to ${newPath}`);
  }

  // Inherit cleanupOldFiles, isDir and isFile from RelativeFS
}

/**
 * GlobalStorageFS provides operations for global storage (shared across workspaces).
 * Extends StorageFS but uses global storage paths instead of workspace storage.
 */
export class GlobalStorageFS extends RelativeFS {
  protected static override getBasePath(): string {
    return StorageFS.getGlobalPath();
  }
  // Inherit path helpers and basic operations from RelativeFS

  /**
   * Delete a file or directory from global storage
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    await super.delete(relativePath, options);
    logger.debug(CHANNEL, `Deleted from global storage: ${relativePath}`);
  }

  /**
   * Create a directory in global storage
   */
  public static async createDir(relativePath: string): Promise<void> {
    await super.createDir(relativePath);
    logger.debug(
      CHANNEL,
      `Created directory in global storage: ${relativePath}`,
    );
  }

  // Inherit ensureDir, readDir and stat from RelativeFS

  /**
   * Copy a file or directory in global storage
   */
  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await super.copy(source, destination, options);
    logger.debug(
      CHANNEL,
      `Copied in global storage: source=${source} to destination=${destination}`,
    );
  }

  /**
   * Move/rename a file or directory in global storage
   */
  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    await super.rename(oldPath, newPath, options);
    logger.debug(
      CHANNEL,
      `Renamed in global storage: ${oldPath} to ${newPath}`,
    );
  }
}

export default StorageFS;
