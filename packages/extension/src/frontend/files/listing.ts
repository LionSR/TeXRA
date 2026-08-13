// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  passesFileFilters,
  prepareFileFilters,
  type FileListConfig,
} from '@common/files/fileListingRules';
import { normalizeFilePath } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

/**
 * Get path relative to root, preserving symlink structure within workspace.
 * Delegates to WorkspaceFS.relativePath() for symlink-aware resolution,
 * then computes the path relative to the specified root.
 *
 * Always returns forward slashes for cross-platform consistency.
 */
function getRelativePathPreservingSymlinks(
  absolutePath: string,
  root: string,
): string {
  // WorkspaceFS.relativePath() handles symlinks via asRelativePath
  // and always returns forward slashes. Outside the workspace it returns
  // the (still absolute) path, so only the workspace-relative cases below
  // can resolve against `root`; everything else falls back to path.relative.
  const wsRelative = WorkspaceFS.relativePath(absolutePath);

  if (!path.isAbsolute(wsRelative)) {
    // If root is the workspace root, the workspace-relative path is the answer.
    const workspaceRoot = WorkspaceFS.getPath();
    if (
      workspaceRoot &&
      path.normalize(root) === path.normalize(workspaceRoot)
    ) {
      return wsRelative;
    }

    // root is a subdirectory — get its workspace-relative path too, and strip
    // that prefix from wsRelative when both are workspace-relative.
    const rootRelative = WorkspaceFS.relativePath(root);
    if (
      !path.isAbsolute(rootRelative) &&
      wsRelative.startsWith(rootRelative + '/')
    ) {
      return wsRelative.slice(rootRelative.length + 1);
    }
  }

  return normalizeFilePath(path.relative(root, absolutePath));
}

export async function getFilesRecursively(
  root: string,
  config: FileListConfig,
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
