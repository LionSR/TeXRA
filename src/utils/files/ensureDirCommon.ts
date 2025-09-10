// Third-party imports
import * as vscode from 'vscode';

/**
 * Ensure a directory exists by checking and creating as needed.
 */
export async function ensureDirCommon(
  path: string,
  exists: (p: string) => Promise<boolean>,
  createDir: (p: string) => Promise<void>,
): Promise<void> {
  try {
    const existsResult = await exists(path);
    if (!existsResult) {
      await createDir(path);
    }
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileExists') {
      return;
    }
    throw err;
  }
}
