// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  passesFileFilters,
  prepareFileFilters,
  type FileFilterConfig,
} from '@common/files/fileListingRules';
import { normalizeFilePath } from '@utils/core';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

/**
 * Get path relative to the workspace root, preserving symlink structure
 * within it: `workspaceRelativePath` resolves symlinks and always returns
 * forward slashes. Outside the workspace it returns the (still absolute)
 * path, which falls back to `path.relative`.
 */
function getRelativePathPreservingSymlinks(
  absolutePath: string,
  workspaceRoot: string,
): string {
  const wsRelative = workspaceRelativePath(workspaceRoot, absolutePath);
  return path.isAbsolute(wsRelative)
    ? normalizeFilePath(path.relative(workspaceRoot, absolutePath))
    : wsRelative;
}

/** Every file under the workspace root that passes `config`'s filters, as
 *  workspace-relative paths. */
export async function getFilesRecursively(
  root: string,
  config: FileFilterConfig,
): Promise<string[]> {
  const filters = prepareFileFilters(config);

  let excludePattern: vscode.RelativePattern | undefined;
  if (filters.sanitizedDirs.length > 0) {
    const globs = filters.sanitizedDirs.map((dir) => `**/${dir}/**`);
    excludePattern = new vscode.RelativePattern(
      root,
      globs.length === 1 ? globs[0] : `{${globs.join(',')}}`,
    );
  }

  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*'),
    excludePattern,
  );

  return files
    .map((uri) => getRelativePathPreservingSymlinks(uri.fsPath, root))
    .filter((relativePath) => passesFileFilters(relativePath, filters));
}
