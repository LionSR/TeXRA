// Third-party imports
import * as vscode from 'vscode';

// Local imports - filesystem
import type { PathInput } from './baseFS';

/**
 * Ensure a directory exists by checking and creating as needed.
 */
export async function ensureDirCommon(
  path: PathInput,
  exists: (p: PathInput) => Promise<boolean>,
  createDir: (p: PathInput) => Promise<void>,
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
