// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'relativeFS';
logger.initialize(CHANNEL);

export abstract class RelativeFS {
  /**
   * Return the base path for this filesystem. Implemented by subclasses.
   */
  protected static getBasePath(): string {
    throw new Error('getBasePath not implemented');
  }

  /**
   * Return the log channel for this filesystem. Subclasses can override.
   */
  protected static getChannel(): string {
    return CHANNEL;
  }

  /**
   * Resolve a relative path against the base path.
   */
  public static fullPath(relativePath: string): string {
    return path.join(this.getBasePath(), relativePath);
  }

  /**
   * Check if a file or directory exists.
   */
  public static async exists(relativePath: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(this.fullPath(relativePath));
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file as UTF-8 text.
   */
  public static async read(relativePath: string): Promise<string> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8');
  }

  /**
   * Write content to a file.
   */
  public static async write(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    const data =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(uri, data);
  }

  /**
   * Delete a file or directory.
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    await vscode.workspace.fs.delete(uri, options);
    logger.debug(this.getChannel(), `Deleted: ${relativePath}`);
  }

  /**
   * Create a directory.
   */
  public static async createDir(relativePath: string): Promise<void> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    await vscode.workspace.fs.createDirectory(uri);
    logger.debug(this.getChannel(), `Created directory: ${relativePath}`);
  }

  /**
   * Ensure a directory exists, creating it if necessary.
   */
  public static async ensureDir(relativePath: string): Promise<void> {
    try {
      const exists = await this.exists(relativePath);
      if (!exists) {
        await this.createDir(relativePath);
      }
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
        return;
      }
      throw err;
    }
  }

  /**
   * Read directory contents.
   */
  public static async readDir(
    relativePath: string,
  ): Promise<[string, vscode.FileType][]> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    return await vscode.workspace.fs.readDirectory(uri);
  }

  /**
   * Get file stats.
   */
  public static async stat(relativePath: string): Promise<vscode.FileStat> {
    const uri = vscode.Uri.file(this.fullPath(relativePath));
    return await vscode.workspace.fs.stat(uri);
  }

  /**
   * Copy a file or directory.
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
      this.getChannel(),
      `Copied: source=${source} to destination=${destination}`,
    );
  }

  /**
   * Move/rename a file or directory.
   */
  public static async rename(
    oldPath: string,
    newPath: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const oldUri = vscode.Uri.file(this.fullPath(oldPath));
    const newUri = vscode.Uri.file(this.fullPath(newPath));
    await vscode.workspace.fs.rename(oldUri, newUri, options);
    logger.debug(this.getChannel(), `Renamed: ${oldPath} to ${newPath}`);
  }

  /**
   * Check if path is a directory.
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
   * Check if path is a file.
   */
  public static async isFile(relativePath: string): Promise<boolean> {
    try {
      const stats = await this.stat(relativePath);
      return stats.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  /**
   * Remove files older than maxAgeMs from a directory.
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
            logger.debug(this.getChannel(), `Deleted old file: ${filePath}`);
          }
        } catch {
          // Ignore errors when checking individual files
        }
      }
    } catch {
      // Ignore errors when cleaning directory
    }
  }
}

export default RelativeFS;
