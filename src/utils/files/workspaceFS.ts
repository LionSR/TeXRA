// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { AbsoluteFS } from './absoluteFS';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@common/errors/errorHandlingUtils';
import { RelativeFS } from './relativeFS';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'workspaceFS';
logger.initialize(CHANNEL);

export class WorkspaceFS extends RelativeFS {
  protected static override getBasePath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace path found');
    }
    return workspaceFolders[0].uri.fsPath;
  }

  protected static override getChannel(): string {
    return CHANNEL;
  }

  public static getPath(): string | undefined {
    try {
      return this.getBasePath();
    } catch {
      return undefined;
    }
  }

  public static relativePath(filePath: string): string {
    const workspacePath = this.getPath();
    return workspacePath ? path.relative(workspacePath, filePath) : filePath;
  }

  /**
   * Delete a file or directory. Tolerant of missing files (idempotent).
   * @param relativePath The path to delete
   * @param options Optional deletion options
   */
  public static async delete(
    relativePath: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    try {
      await super.delete(relativePath, options);
    } catch (err) {
      // Make delete idempotent - if file doesn't exist, that's fine
      if (
        err instanceof vscode.FileSystemError &&
        err.code === 'FileNotFound'
      ) {
        logger.debug(
          CHANNEL,
          `Skipping deletion of non-existent file: ${relativePath}`,
        );
        return;
      }
      // Re-throw other errors
      throw err;
    }
  }

  public static async appendFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const existing = (await this.exists(filePath))
        ? await this.read(filePath)
        : '';
      await this.write(filePath, existing + content);
      logger.debug(CHANNEL, `Successfully appended to file: ${filePath}`);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error appending to file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  public static async existsAndNonTrivial(filePath: string): Promise<boolean> {
    return (
      (await this.exists(filePath)) && (await this.read(filePath)).length > 15
    );
  }

  public static async readFileBytes(filePath: string): Promise<Buffer> {
    try {
      const fullPath = this.fullPath(filePath);
      return await AbsoluteFS.readBytes(fullPath);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error reading file bytes: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  public static readFileBytesSync(filePath: string): Buffer {
    try {
      const fullPath = this.fullPath(filePath);
      return AbsoluteFS.readBytesSync(fullPath);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error reading file bytes: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Filters an array of objects with path properties to only include those with existing files.
   * Uses parallel execution for better performance when checking many files.
   * @param items Array of items with a path property
   * @returns Promise that resolves to filtered array containing only items with existing files
   */
  public static async filterExistingFiles<T extends { path: string }>(
    items: T[],
  ): Promise<T[]> {
    if (!items || items.length === 0) {
      return [];
    }

    const fileCheckPromises = items.map(async (item) => {
      try {
        // Use the existing exists function which handles relative/absolute path conversion
        const exists = await this.exists(item.path);
        return { item, exists };
      } catch (error) {
        // If there's an error checking a specific file, assume it doesn't exist
        // but log the error for debugging
        console.warn(
          `Error checking file existence for ${item.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { item, exists: false };
      }
    });

    const results = await Promise.all(fileCheckPromises);
    return results
      .filter((result) => result.exists)
      .map((result) => result.item);
  }
}

export default WorkspaceFS;
