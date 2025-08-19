// Standard library imports
// Standard library imports
import * as path from 'path';

// Third-party imports

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { AbsoluteFS } from './absoluteFS';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@common/errors/errorHandlingUtils';

// Local imports - log
import * as logger from '@logger/logUtils';

const CHANNEL = 'workspaceFS';
logger.initialize(CHANNEL);

export class WorkspaceFS {
  public static relativePath(filePath: string): string {
    const workspacePath = this.getPath();
    return workspacePath ? path.relative(workspacePath, filePath) : filePath;
  }

  public static getPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  public static fullPath(filePath: string): string {
    const workspacePath = this.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    return path.join(workspacePath, filePath);
  }

  public static async readFile(filePath: string): Promise<string> {
    const fullPath = this.fullPath(filePath);
    const uri = vscode.Uri.file(fullPath);
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8');
  }

  public static async writeFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    const fullPath = this.fullPath(filePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  }

  public static async write(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const fullPath = this.fullPath(filePath);
    const uri = vscode.Uri.file(fullPath);
    const buffer =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await vscode.workspace.fs.writeFile(uri, buffer);
  }

  public static async appendFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    try {
      const fullPath = this.fullPath(filePath);
      const uri = vscode.Uri.file(fullPath);

      // Read existing content
      let existingContent = '';
      try {
        const fileContent = await vscode.workspace.fs.readFile(uri);
        existingContent = Buffer.from(fileContent).toString('utf-8');
      } catch (err) {
        // File might not exist yet, which is fine
      }

      // Append new content
      const newContent = existingContent + content;
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(newContent, 'utf-8'),
      );
      logger.debug(CHANNEL, `Successfully appended to file: ${filePath}`);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error appending to file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  public static async delete(filePath: string): Promise<void> {
    try {
      const fullPath = this.fullPath(filePath);
      const uri = vscode.Uri.file(fullPath);
      await vscode.workspace.fs.delete(uri, { useTrash: false });
      logger.debug(CHANNEL, `Deleted: ${filePath}`);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        if (err.code === 'FileNotFound') {
          logger.debug(CHANNEL, `File not found when deleting: ${filePath}`);
        } else {
          logger.warn(
            CHANNEL,
            `Unable to delete ${filePath}. It may be in use.`,
          );
          vscode.window.showWarningMessage(
            `Unable to delete ${filePath}. It may be in use.`,
          );
        }
      } else {
        await showLoggedErrorMessage(
          CHANNEL,
          `Error deleting ${filePath}`,
          err,
        );
      }
    }
  }

  public static async move(source: string, destination: string): Promise<void> {
    logger.debug(CHANNEL, `Moving file from ${source} to ${destination}`);
    try {
      const fullSourcePath = this.fullPath(source);
      const fullDestPath = this.fullPath(destination);

      const sourceUri = vscode.Uri.file(fullSourcePath);
      const destUri = vscode.Uri.file(fullDestPath);

      // Check if source exists
      const sourceExists = await AbsoluteFS.exists(fullSourcePath);
      if (!sourceExists) {
        logger.warn(CHANNEL, `Source file doesn't exist: ${source}`);
        return;
      }

      await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: true });
      logger.info(CHANNEL, `Successfully moved: ${source} to ${destination}`);
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        `Error moving file from ${source} to ${destination}`,
        err,
      );
    }
  }

  public static async copy(source: string, destination: string): Promise<void> {
    logger.debug(CHANNEL, `Copying file from ${source} to ${destination}`);
    try {
      const fullSourcePath = this.fullPath(source);
      const fullDestPath = this.fullPath(destination);

      const sourceUri = vscode.Uri.file(fullSourcePath);
      const destUri = vscode.Uri.file(fullDestPath);

      // Check if source exists
      const sourceExists = await AbsoluteFS.exists(fullSourcePath);
      if (!sourceExists) {
        logger.warn(CHANNEL, `Source file doesn't exist: ${source}`);
        return;
      }

      await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: true });
      logger.info(
        CHANNEL,
        `Successfully copied: source=${source} to destination=${destination}`,
      );
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        `Error copying file from source=${source} to destination=${destination}`,
        err,
      );
    }
  }

  public static async createDir(relativePath: string): Promise<void> {
    try {
      const fullPath = this.fullPath(relativePath);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath));
      logger.debug(CHANNEL, `Created directory: ${relativePath}`);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        await showLoggedMessage(
          CHANNEL,
          `Unable to create directory ${relativePath}. Permission denied.`,
        );
        throw new Error(
          `Unable to create directory ${relativePath}. Permission denied.`,
        );
      } else {
        await showLoggedErrorMessage(
          CHANNEL,
          `Error creating directory ${relativePath}`,
          err,
        );
        throw err;
      }
    }
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
      throw err;
    }
  }

  public static async readDir(
    dirPath: string,
  ): Promise<[string, vscode.FileType][]> {
    try {
      const fullPath = this.fullPath(dirPath);
      const dirUri = vscode.Uri.file(fullPath);
      return await vscode.workspace.fs.readDirectory(dirUri);
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error reading directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  public static async exists(filePath: string): Promise<boolean> {
    const fullPath = this.fullPath(filePath);
    return await AbsoluteFS.exists(fullPath);
  }

  public static async existsAndNonTrivial(filePath: string): Promise<boolean> {
    return (
      (await this.exists(filePath)) &&
      (await this.readFile(filePath)).length > 15
    );
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
