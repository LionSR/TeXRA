// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'storageFS';
logger.initialize(CHANNEL);

/**
 * StorageFS provides a unified interface for VS Code extension storage operations.
 * Supports both workspace storage (per-workspace) and global storage (shared across workspaces).
 */
export class StorageFS {
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

  /**
   * Get the full path for a relative storage path
   */
  public static fullPath(relativePath: string): string {
    return path.join(this.getPath(), relativePath);
  }

  /**
   * Check if a file or directory exists
   */
  public static async exists(relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.fullPath(relativePath);
      const uri = vscode.Uri.file(fullPath);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file as UTF-8 text
   */
  public static async read(relativePath: string): Promise<string> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8');
  }

  /**
   * Write content to a file (text or binary)
   */
  public static async write(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(uri, data);
  }

  /**
   * Delete a file or directory
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.delete(uri, options);
    logger.debug(CHANNEL, `Deleted: ${relativePath}`);
  }

  /**
   * Create a directory
   */
  public static async createDir(relativePath: string): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.createDirectory(uri);
    logger.debug(CHANNEL, `Created directory: ${relativePath}`);
  }

  /**
   * Ensure a directory exists, creating it if necessary
   */
  public static async ensureDir(relativePath: string): Promise<void> {
    try {
      const exists = await this.exists(relativePath);
      if (!exists) {
        await this.createDir(relativePath);
      }
    } catch (err) {
      // If error is because directory already exists, ignore it
      if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
        return;
      }
      // Directory might already exist, which is fine
      logger.debug(
        CHANNEL,
        `Directory already exists or error creating: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read directory contents
   */
  public static async readDir(
    relativePath: string,
  ): Promise<[string, vscode.FileType][]> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    return await vscode.workspace.fs.readDirectory(uri);
  }

  /**
   * Get file stats
   */
  public static async stat(relativePath: string): Promise<vscode.FileStat> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    return await vscode.workspace.fs.stat(uri);
  }

  /**
   * Copy a file or directory
   */
  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const sourceUri = vscode.Uri.file(this.fullPath(source));
    const destUri = vscode.Uri.file(this.fullPath(destination));
    await vscode.workspace.fs.copy(sourceUri, destUri, options);
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
    const oldUri = vscode.Uri.file(this.fullPath(oldPath));
    const newUri = vscode.Uri.file(this.fullPath(newPath));
    await vscode.workspace.fs.rename(oldUri, newUri, options);
    logger.debug(CHANNEL, `Renamed: ${oldPath} to ${newPath}`);
  }

  /**
   * Clean up old files in a directory based on age
   */
  public static async cleanupOldFiles(
    relativePath: string,
    maxAgeMs: number,
  ): Promise<void> {
    try {
      const entries = await this.readDir(relativePath);
      const now = Date.now();

      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) {
          continue;
        }

        const filePath = path.join(relativePath, name);
        try {
          const stats = await this.stat(filePath);
          if (now - stats.mtime > maxAgeMs) {
            await this.delete(filePath);
            logger.debug(CHANNEL, `Deleted old file: ${filePath}`);
          }
        } catch (err) {
          logger.warn(
            CHANNEL,
            `Error checking file age ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      logger.warn(
        CHANNEL,
        `Error cleaning directory ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Check if path is a directory
   */
  public static async isDir(relativePath: string): Promise<boolean> {
    try {
      const stats = await this.stat(relativePath);
      return stats.type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  /**
   * Check if path is a file
   */
  public static async isFile(relativePath: string): Promise<boolean> {
    try {
      const stats = await this.stat(relativePath);
      return stats.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }
}

/**
 * GlobalStorageFS provides operations for global storage (shared across workspaces).
 * Extends StorageFS but uses global storage paths instead of workspace storage.
 */
export class GlobalStorageFS {
  /**
   * Get the full path for a relative global storage path
   */
  public static fullPath(relativePath: string): string {
    return path.join(StorageFS.getGlobalPath(), relativePath);
  }

  /**
   * Check if a file or directory exists in global storage
   */
  public static async exists(relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.fullPath(relativePath);
      const uri = vscode.Uri.file(fullPath);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file from global storage as UTF-8 text
   */
  public static async read(relativePath: string): Promise<string> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8');
  }

  /**
   * Write content to a file in global storage (text or binary)
   */
  public static async write(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(uri, data);
  }

  /**
   * Delete a file or directory from global storage
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.delete(uri, options);
    logger.debug(CHANNEL, `Deleted from global storage: ${relativePath}`);
  }

  /**
   * Create a directory in global storage
   */
  public static async createDir(relativePath: string): Promise<void> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.createDirectory(uri);
    logger.debug(
      CHANNEL,
      `Created directory in global storage: ${relativePath}`,
    );
  }

  /**
   * Ensure a directory exists in global storage, creating it if necessary
   */
  public static async ensureDir(relativePath: string): Promise<void> {
    try {
      const exists = await this.exists(relativePath);
      if (!exists) {
        await this.createDir(relativePath);
      }
    } catch (err) {
      // If error is because directory already exists, ignore it
      if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
        return;
      }
      // Directory might already exist, which is fine
      logger.debug(
        CHANNEL,
        `Directory already exists in global storage or error creating: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read directory contents from global storage
   */
  public static async readDir(
    relativePath: string,
  ): Promise<[string, vscode.FileType][]> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    return await vscode.workspace.fs.readDirectory(uri);
  }

  /**
   * Get file stats from global storage
   */
  public static async stat(relativePath: string): Promise<vscode.FileStat> {
    const fullPath = this.fullPath(relativePath);
    const uri = vscode.Uri.file(fullPath);
    return await vscode.workspace.fs.stat(uri);
  }

  /**
   * Copy a file or directory in global storage
   */
  public static async copy(
    source: string,
    destination: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const sourceUri = vscode.Uri.file(this.fullPath(source));
    const destUri = vscode.Uri.file(this.fullPath(destination));
    await vscode.workspace.fs.copy(sourceUri, destUri, options);
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
    const oldUri = vscode.Uri.file(this.fullPath(oldPath));
    const newUri = vscode.Uri.file(this.fullPath(newPath));
    await vscode.workspace.fs.rename(oldUri, newUri, options);
    logger.debug(
      CHANNEL,
      `Renamed in global storage: ${oldPath} to ${newPath}`,
    );
  }
}

export default StorageFS;
