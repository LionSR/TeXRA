// Third-party imports
import * as vscode from 'vscode';

export async function fileExistsAbsolute(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Filters an array of objects with path properties to only include those with existing files.
 * Uses parallel execution for better performance when checking many files.
 * @param items Array of items with a path property
 * @returns Promise that resolves to filtered array containing only items with existing files
 */
export async function filterExistingFiles<T extends { path: string }>(
  items: T[],
): Promise<T[]> {
  if (!items || items.length === 0) {
    return [];
  }

  const fileCheckPromises = items.map(async (item) => {
    try {
      const exists = await fileExistsAbsolute(item.path);
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
  return results.filter((result) => result.exists).map((result) => result.item);
}
