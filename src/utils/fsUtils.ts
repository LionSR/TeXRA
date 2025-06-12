/*
 * Unified filesystem helpers for TeXRA
 * ------------------------------------
 * This module merges the functionality that previously lived in
 *   • workspaceFileUtils.ts  (relative-to-workspace helpers)
 *   • absoluteFileUtils.ts  (absolute path helpers)
 * into a single, cohesive utility.
 *
 * Naming conventions
 * ------------------
 * • Functions that operate on workspace-relative paths keep their original
 *   names:  readFile(), writeFile(), deleteFile() …
 *
 * • Absolute variants are suffixed with `Absolute`: readFileAbsolute(),
 *   fileExistsAbsolute() …
 *
 * All former public APIs continue to exist either directly or as re-exports
 * (see workspaceFileUtils.ts & absoluteFileUtils.ts) so no calling code
 * needs to change immediately.
 */

// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// VS Code imports
import * as vscode from 'vscode';

// Local imports – log
import * as logger from '../logger/logUtils';

const CHANNEL = 'fsUtils';
logger.initialize(CHANNEL);

/* ---------------------------------------------------------------------------
 * Workspace helpers
 * -------------------------------------------------------------------------*/

export function getWorkspacePath(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return workspaceFolders[0].uri.fsPath;
}

export function getFullPathFromWorkspace(relativePath: string): string {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    throw new Error('No workspace path found');
  }
  return path.join(workspacePath, relativePath);
}

export function getRelativePath(absolutePath: string): string {
  const workspacePath = getWorkspacePath();
  return workspacePath ? path.relative(workspacePath, absolutePath) : absolutePath;
}

/* ---------------------------------------------------------------------------
 * Absolute helpers (do not depend on workspace folder)
 * -------------------------------------------------------------------------*/

export async function fileExistsAbsolute(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function readFileAbsolute(filePath: string): Promise<string> {
  const uri = vscode.Uri.file(filePath);
  const content = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(content).toString('utf-8');
}

/* ---------------------------------------------------------------------------
 * Relative variants built on the absolute helpers
 * -------------------------------------------------------------------------*/

export async function readFile(relativePath: string): Promise<string> {
  const fullPath = getFullPathFromWorkspace(relativePath);
  return readFileAbsolute(fullPath);
}

export async function writeFile(relativePath: string, content: string): Promise<void> {
  const fullPath = getFullPathFromWorkspace(relativePath);
  const uri = vscode.Uri.file(fullPath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

export async function appendFile(relativePath: string, content: string): Promise<void> {
  try {
    const existing = (await fileExists(relativePath)) ? await readFile(relativePath) : '';
    await writeFile(relativePath, existing + content);
    logger.debug(CHANNEL, `Successfully appended to file: ${relativePath}`);
  } catch (err) {
    logger.error(CHANNEL, `Error appending to file ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

export async function deleteFile(relativePath: string): Promise<void> {
  try {
    const fullPath = getFullPathFromWorkspace(relativePath);
    await vscode.workspace.fs.delete(vscode.Uri.file(fullPath), { useTrash: false });
    logger.debug(CHANNEL, `Deleted: ${relativePath}`);
  } catch (err) {
    if (err instanceof vscode.FileSystemError) {
      logger.warn(CHANNEL, `Unable to delete ${relativePath}. It may be in use.`);
      vscode.window.showWarningMessage(`Unable to delete ${relativePath}. It may be in use.`);
    } else {
      logger.error(
        CHANNEL,
        `Error deleting ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(`Error deleting ${relativePath}: ${err}`);
    }
  }
}

export async function moveFile(source: string, destination: string): Promise<void> {
  logger.debug(CHANNEL, `Moving file from ${source} to ${destination}`);
  try {
    const fullSource = getFullPathFromWorkspace(source);
    const fullDest = getFullPathFromWorkspace(destination);

    if (!(await fileExistsAbsolute(fullSource))) {
      logger.warn(CHANNEL, `Source file doesn't exist: ${source}`);
      return;
    }

    await vscode.workspace.fs.rename(
      vscode.Uri.file(fullSource),
      vscode.Uri.file(fullDest),
    );
    logger.info(CHANNEL, `Successfully moved: ${source} to ${destination}`);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error moving file from ${source} to ${destination}: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error moving file: ${err}`);
  }
}

export async function copyFile(source: string, destination: string): Promise<void> {
  logger.debug(CHANNEL, `Copying file from ${source} to ${destination}`);
  try {
    const fullSource = getFullPathFromWorkspace(source);
    const fullDest = getFullPathFromWorkspace(destination);

    if (!(await fileExistsAbsolute(fullSource))) {
      logger.warn(CHANNEL, `Source file doesn't exist: ${source}`);
      return;
    }

    await vscode.workspace.fs.copy(
      vscode.Uri.file(fullSource),
      vscode.Uri.file(fullDest),
      { overwrite: true },
    );
    logger.info(
      CHANNEL,
      `Successfully copied: source=${source} to destination=${destination}`,
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error copying file from source=${source} to destination=${destination}: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error copying file: ${err}`);
  }
}

/* ---------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------*/

export async function fileExists(relativePath: string): Promise<boolean> {
  return fileExistsAbsolute(getFullPathFromWorkspace(relativePath));
}

export async function fileExistsAndNonTrivial(relativePath: string): Promise<boolean> {
  return (
    (await fileExists(relativePath)) && (await readFile(relativePath)).length > 15
  );
}

export function readFileBytesSync(relativePath: string): Buffer {
  const fullPath = getFullPathFromWorkspace(relativePath);
  return fs.readFileSync(fullPath);
}

/**
 * Filters an array of objects (with a `path` property) to only include those whose
 * underlying file exists. Uses parallel execution for speed.
 */
export async function filterExistingFiles<T extends { path: string }>(
  items: T[],
): Promise<T[]> {
  if (!items || items.length === 0) {
    return [];
  }

  const checks = items.map(async (item) => {
    try {
      const exists = await fileExists(item.path);
      return { item, exists };
    } catch (err) {
      logger.warn(
        CHANNEL,
        `Error checking file existence for ${item.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { item, exists: false };
    }
  });

  const results = await Promise.all(checks);
  return results.filter((r) => r.exists).map((r) => r.item);
}

export async function createDirectory(relativePath: string): Promise<void> {
  try {
    const fullPath = getFullPathFromWorkspace(relativePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath));
    logger.debug(CHANNEL, `Created directory: ${relativePath}`);
  } catch (err) {
    if (err instanceof vscode.FileSystemError) {
      logger.error(
        CHANNEL,
        `Unable to create directory ${relativePath}. Permission denied.`,
      );
      await vscode.window.showErrorMessage(
        `Unable to create directory ${relativePath}. Permission denied.`,
      );
      throw new Error(
        `Unable to create directory ${relativePath}. Permission denied.`,
      );
    }
    logger.error(
      CHANNEL,
      `Error creating directory ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function readDirectory(
  relativePath: string,
): Promise<[string, vscode.FileType][]> {
  const fullPath = getFullPathFromWorkspace(relativePath);
  return vscode.workspace.fs.readDirectory(vscode.Uri.file(fullPath));
}

/**
 * Search build/ directories for a matching output file.
 */
export async function findFileInBuild(
  inputDir: string,
  pattern: string,
  ext?: string,
): Promise<string | null> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) throw new Error('No workspace path found');

    const searchDirs = [path.join(workspacePath, inputDir)];
    if (!inputDir.includes('build')) {
      searchDirs.push(path.join(workspacePath, inputDir, 'build'));
    }

    for (const dir of searchDirs) {
      if (!(await fileExistsAbsolute(dir))) continue;

      const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      for (const [fileName, fileType] of files) {
        if (fileType !== vscode.FileType.File) continue;
        if (
          ext ? fileName === `${pattern}${ext}` : fileName.startsWith(pattern)
        ) {
          return path.relative(workspacePath, path.join(dir, fileName));
        }
      }
    }
    return null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in findFileInBuild: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
