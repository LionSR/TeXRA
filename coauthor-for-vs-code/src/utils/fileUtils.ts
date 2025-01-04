// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from '../logger/logUtils';

const CHANNEL = 'Utils';
logger.initializeLogging(CHANNEL);

export function getRelativePath(filePath: string): string {
  const workspacePath = getWorkspacePath();
  return workspacePath ? path.relative(workspacePath, filePath) : filePath;
}

export function getWorkspacePath(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }
  return workspaceFolders[0].uri.fsPath;
}

export async function readFile(filePath: string): Promise<string> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    throw new Error('No workspace path found');
  }
  const fullPath = path.join(workspacePath, filePath);
  const uri = vscode.Uri.file(fullPath);
  const content = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(content).toString('utf-8');
}

export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    throw new Error('No workspace path found');
  }
  const fullPath = path.join(workspacePath, filePath);
  const uri = vscode.Uri.file(fullPath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

export async function appendFile(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, filePath);
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
    await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf-8'));
    logger.debug(CHANNEL, `Successfully appended to file: ${filePath}`);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error appending to file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, filePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.delete(uri, { useTrash: false });
    logger.debug(CHANNEL, `Deleted: ${filePath}`);
  } catch (err) {
    if (err instanceof vscode.FileSystemError) {
      logger.warn(CHANNEL, `Unable to delete ${filePath}. It may be in use.`);
      vscode.window.showWarningMessage(
        `Unable to delete ${filePath}. It may be in use.`,
      );
    } else {
      logger.error(
        CHANNEL,
        `Error deleting ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage(`Error deleting ${filePath}: ${err}`);
    }
  }
}

export async function moveFile(
  source: string,
  destination: string,
): Promise<void> {
  logger.debug(CHANNEL, `Moving file from ${source} to ${destination}`);
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullSourcePath = path.join(workspacePath, source);
    const fullDestPath = path.join(workspacePath, destination);

    const sourceUri = vscode.Uri.file(fullSourcePath);
    const destUri = vscode.Uri.file(fullDestPath);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
    if (!sourceExists) {
      logger.warn(CHANNEL, `Source file doesn't exist: ${source}`);
      return;
    }

    await vscode.workspace.fs.rename(sourceUri, destUri);
    logger.info(CHANNEL, `Successfully moved: ${source} to ${destination}`);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error moving file from ${source} to ${destination}: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error moving file: ${err}`);
  }
}

export async function copyFile(
  source: string,
  destination: string,
): Promise<void> {
  logger.debug(CHANNEL, `Copying file from ${source} to ${destination}`);
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullSourcePath = path.join(workspacePath, source);
    const fullDestPath = path.join(workspacePath, destination);

    const sourceUri = vscode.Uri.file(fullSourcePath);
    const destUri = vscode.Uri.file(fullDestPath);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
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
    logger.error(
      CHANNEL,
      `Error copying file from source=${source} to destination=${destination}: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error copying file: ${err}`);
  }
}

export async function findFileInBuild(
  inputDir: string,
  pattern: string,
  ext?: string,
): Promise<string | null> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Only search in inputDir and inputDir/build, not build/build
    const searchDirs = [path.join(workspacePath, inputDir)];
    if (!workspacePath.includes('build')) {
      searchDirs.push(path.join(workspacePath, inputDir, 'build'));
    }

    for (const searchDir of searchDirs) {
      try {
        const dirUri = vscode.Uri.file(searchDir);

        const exists = await vscode.workspace.fs.stat(dirUri).then(
          () => true,
          () => false,
        );
        if (!exists) {
          logger.debug(CHANNEL, `Directory doesn't exist: ${searchDir}`);
          continue;
        }

        const files = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [fileName, fileType] of files) {
          if (fileType === vscode.FileType.File) {
            if (ext) {
              if (fileName === `${pattern}${ext}`) {
                // Return relative path from workspace root
                const relativePath = path.relative(
                  workspacePath,
                  path.join(searchDir, fileName),
                );
                logger.debug(CHANNEL, `Found file: ${relativePath}`);
                return relativePath;
              }
            } else if (fileName.startsWith(pattern)) {
              // Return relative path from workspace root
              const relativePath = path.relative(
                workspacePath,
                path.join(searchDir, fileName),
              );
              logger.debug(CHANNEL, `Found file: ${relativePath}`);
              return relativePath;
            }
          }
        }
      } catch (err) {
        logger.warn(
          CHANNEL,
          `Error searching directory searchDir=${searchDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
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

export async function createDirectory(relativePath: string): Promise<void> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, relativePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath));
    logger.debug(CHANNEL, `Created directory: ${relativePath}`);
  } catch (err) {
    if (err instanceof vscode.FileSystemError) {
      logger.error(
        CHANNEL,
        `Unable to create directory ${relativePath}. Permission denied.`,
      );
      throw new Error(
        `Unable to create directory ${relativePath}. Permission denied.`,
      );
    } else {
      logger.error(
        CHANNEL,
        `Error creating directory ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}

export async function readDirectory(
  dirPath: string,
): Promise<[string, vscode.FileType][]> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, dirPath);
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

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, filePath);
    const uri = vscode.Uri.file(fullPath);
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function readFileBytesSync(filePath: string): Buffer {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }
    const fullPath = path.join(workspacePath, filePath);
    return fs.readFileSync(fullPath);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error reading file bytes: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
