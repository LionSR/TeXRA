import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspacePath } from './commonUtils';
import { log, initializeLogging } from './logUtils';

const CHANNEL_NAME = 'Coauthor File Operations';
initializeLogging(CHANNEL_NAME);

export async function deleteFile(filePath: string): Promise<void> {
  const category = 'File-Delete';
  try {
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.delete(uri, { useTrash: false });
    log(CHANNEL_NAME, category, `Deleted: ${filePath}`);
  } catch (error) {
    if (error instanceof vscode.FileSystemError) {
      log(
        CHANNEL_NAME,
        category,
        `Unable to delete ${filePath}. It may be in use.`,
        true,
      );
      vscode.window.showWarningMessage(
        `Unable to delete ${filePath}. It may be in use.`,
      );
    } else {
      log(CHANNEL_NAME, category, `Error deleting ${filePath}: ${error}`, true);
      vscode.window.showErrorMessage(`Error deleting ${filePath}: ${error}`);
    }
  }
}

export async function moveFile(
  source: string,
  destination: string,
): Promise<void> {
  const category = 'File-Move';
  log(CHANNEL_NAME, category, `Moving file from ${source} to ${destination}`);
  try {
    const sourceUri = vscode.Uri.file(source);
    const destUri = vscode.Uri.file(destination);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
    if (!sourceExists) {
      log(CHANNEL_NAME, category, `Source file doesn't exist: ${source}`, true);
      return;
    }

    await vscode.workspace.fs.rename(sourceUri, destUri);
    log(
      CHANNEL_NAME,
      category,
      `Successfully moved: ${source} to ${destination}`,
    );
  } catch (error) {
    log(
      CHANNEL_NAME,
      category,
      `Error moving file from ${source} to ${destination}: ${error}`,
      true,
    );
    vscode.window.showErrorMessage(`Error moving file: ${error}`);
  }
}

export async function copyFile(
  source: string,
  destination: string,
): Promise<void> {
  const category = 'File-Copy';
  log(CHANNEL_NAME, category, `Copying file from ${source} to ${destination}`);
  try {
    const sourceUri = vscode.Uri.file(source);
    const destUri = vscode.Uri.file(destination);

    // Check if source exists
    const sourceExists = await vscode.workspace.fs.stat(sourceUri).then(
      () => true,
      () => false,
    );
    if (!sourceExists) {
      log(CHANNEL_NAME, category, `Source file doesn't exist: ${source}`, true);
      return;
    }

    await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: true });
    log(
      CHANNEL_NAME,
      category,
      `Successfully copied: source=${source} to destination=${destination}`,
    );
  } catch (error) {
    log(
      CHANNEL_NAME,
      category,
      `Error copying file from source=${source} to destination=${destination}: ${error}`,
      true,
    );
    vscode.window.showErrorMessage(`Error copying file: ${error}`);
  }
}

export async function findFile(
  inputDir: string,
  pattern: string,
  ext?: string,
): Promise<string | null> {
  const category = 'File-Find';
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return null;

  const searchDirs = [
    path.join(workspacePath, inputDir, 'build'),
    path.join(workspacePath, inputDir),
  ];

  for (const searchDir of searchDirs) {
    try {
      const dirUri = vscode.Uri.file(searchDir);

      const exists = await vscode.workspace.fs.stat(dirUri).then(
        () => true,
        () => false,
      );
      if (!exists) {
        log(CHANNEL_NAME, category, `Directory doesn't exist: ${searchDir}`);
        continue;
      }

      const files = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [fileName, fileType] of files) {
        if (fileType === vscode.FileType.File) {
          if (ext) {
            if (fileName === `${pattern}${ext}`) {
              const foundPath = path.join(searchDir, fileName);
              log(CHANNEL_NAME, category, `Found file: ${foundPath}`);
              return foundPath;
            }
          } else if (fileName.startsWith(pattern)) {
            const foundPath = path.join(searchDir, fileName);
            log(CHANNEL_NAME, category, `Found file: ${foundPath}`);
            return foundPath;
          }
        }
      }
    } catch (error) {
      log(
        CHANNEL_NAME,
        category,
        `Error searching directory searchDir=${searchDir}: ${error}`,
        true,
      );
      continue;
    }
  }
  return null;
}
